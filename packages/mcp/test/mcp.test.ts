import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { openDatabase, ProposalStore, TimelineStore } from "@reelforge/core";
import { fixtures } from "../../media/test/fixtures.ts";

const BIN = new URL("../../cli/bin/reelforge.js", import.meta.url).pathname;

async function connect(t: { after: (fn: () => unknown) => void }, opts: { elicit?: (message: string) => { action: "accept" | "decline" | "cancel"; content?: Record<string, unknown> } } = {}) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "reelforge-mcp-")));
  const client = new Client({ name: "test-agent", version: "1.0.0" }, { capabilities: opts.elicit ? { elicitation: {} } : {} });
  if (opts.elicit) client.setRequestHandler(ElicitRequestSchema, async (req) => opts.elicit!(String(req.params.message)));
  const transport = new StdioClientTransport({ command: process.execPath, args: [BIN, "mcp"], env: { ...process.env, REELFORGE_HOME: home } as Record<string, string>, stderr: "inherit" });
  await client.connect(transport);
  t.after(async () => {
    await client.close();
    rmSync(home, { recursive: true, force: true });
  });
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
    const data = JSON.parse(r.content[0]!.text);
    return { data, isError: !!r.isError };
  };
  return { client, call, home };
}

async function until<T>(fn: () => Promise<T>, done: (v: T) => boolean, ms = 60_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (done(v) || Date.now() > end) return v;
    await new Promise((r) => setTimeout(r, 150));
  }
}

test("M5 exit: an MCP client creates and processes a project end to end", { timeout: 180_000 }, async (t) => {
  const { client, call, home } = await connect(t);
  const f = fixtures();

  const tools = (await client.listTools()).tools.map((x) => x.name).sort();
  for (const name of ["projects_list", "projects_create", "projects_get", "media_import", "media_analyze", "media_get_analysis", "timeline_get", "timeline_propose_edit", "timeline_get_proposal", "timeline_apply_proposal", "timeline_undo", "captions_generate", "audio_detect_beats", "preview_create", "render_start", "jobs_get", "jobs_cancel", "outputs_get", "workflows_run", "workflows_runs"]) {
    assert.ok(tools.includes(name), `missing tool ${name}`);
  }

  const project = (await call("projects_create", { name: "MCP reel", width: 270, height: 480 })).data.project;
  const imp = (await call("media_import", { projectId: project.id, paths: [f.portrait, f.mp3] })).data;
  assert.equal(imp.imported.length, 2);
  const [video, music] = imp.imported;

  const beats = (await call("audio_detect_beats", { projectId: project.id, assetId: music.id })).data.beats;
  assert.ok(typeof beats.bpm === "number");
  const started = (await call("media_analyze", { projectId: project.id, assetId: video.id, kinds: ["scenes"] })).data.jobs[0];
  const job = await until(() => call("jobs_get", { jobId: started.jobId }), (r) => r.data.state === "completed" || r.data.state === "failed");
  assert.equal(job.data.state, "completed");

  const ctx = (await call("timeline_get", { projectId: project.id })).data.context;
  assert.equal(ctx.schema, "reelforge.project-context/1");
  const v1 = ctx.timeline.tracks.find((x: any) => x.label === "V1").id;

  // The client plans the edit itself; placeholders let it refer to a clip it adds.
  const proposed = await call("timeline_propose_edit", {
    projectId: project.id,
    summary: "Open on the portrait shot with a fade",
    operations: [
      { type: "clip.add", clipId: "new-1", trackId: v1, assetId: video.id, start: 0, duration: 45, why: "opening shot" },
      { type: "clip.update", clipId: "new-1", props: { fadeIn: 10 }, why: "soft open" },
    ],
  });
  assert.equal(proposed.isError, false, JSON.stringify(proposed.data));
  const proposalId = proposed.data.proposalId;
  assert.equal(proposed.data.status, "pending");

  // No elicitation in this client: the tool must refuse and send the user to ReelForge.
  const blocked = (await call("timeline_apply_proposal", { proposalId })).data;
  assert.equal(blocked.status, "approval_required");
  assert.match(blocked.approve_in_reelforge, new RegExp(`ai apply ${proposalId} --yes`));
  assert.equal((await call("timeline_get", { projectId: project.id })).data.context.timeline.clips.length, 0, "nothing applied");

  // The person approves in ReelForge (same database).
  const db = openDatabase(join(home, "reelforge.db"));
  new ProposalStore(db).apply(proposalId, { by: "desktop", channel: "desktop:apply" });
  db.close();
  assert.equal((await call("timeline_get_proposal", { proposalId })).data.status, "applied");

  const out = join(home, "mcp-reel.mp4");
  const render = (await call("render_start", { projectId: project.id, outputPath: out })).data;
  const done = await until(() => call("jobs_get", { jobId: render.jobId }), (r) => ["completed", "failed", "cancelled"].includes(r.data.state));
  assert.equal(done.data.state, "completed", JSON.stringify(done.data));
  assert.ok(existsSync(out));
  const outputs = (await call("outputs_get", { projectId: project.id })).data.outputs;
  assert.equal(outputs[0].frames, 45);

  const bad = await call("timeline_propose_edit", { projectId: project.id, summary: "bad", operations: [{ type: "clip.move", clipId: "00000000-0000-4000-8000-000000000000", start: 0 }] });
  assert.equal(bad.isError, true);
  assert.equal(bad.data.error.code, "VALIDATION_ERROR");
});

test("elicitation: the user approves or declines inside the MCP client", { timeout: 120_000 }, async (t) => {
  let answer: "accept" | "decline" = "decline";
  const asked: string[] = [];
  const { call } = await connect(t, {
    elicit: (message) => {
      asked.push(message);
      return answer === "accept" ? { action: "accept", content: { approve: true } } : { action: "decline" };
    },
  });
  const f = fixtures();
  const project = (await call("projects_create", { name: "Elicit" })).data.project;
  const asset = (await call("media_import", { projectId: project.id, paths: [f.portrait] })).data.imported[0];
  const v1 = (await call("timeline_get", { projectId: project.id })).data.context.timeline.tracks.find((x: any) => x.label === "V1").id;
  const p = (await call("timeline_propose_edit", { projectId: project.id, summary: "Add the shot", operations: [{ type: "clip.add", trackId: v1, assetId: asset.id, start: 0 }] })).data;

  const declined = (await call("timeline_apply_proposal", { proposalId: p.proposalId })).data;
  assert.equal(declined.status, "not_approved");
  assert.match(asked[0]!, /Add the shot/);
  assert.equal((await call("timeline_get_proposal", { proposalId: p.proposalId })).data.status, "pending");

  answer = "accept";
  const applied = (await call("timeline_apply_proposal", { proposalId: p.proposalId })).data;
  assert.equal(applied.status, "applied");
  assert.equal((await call("timeline_get", { projectId: project.id })).data.context.timeline.clips.length, 1);
  const undone = (await call("timeline_undo", { projectId: project.id })).data;
  assert.equal(undone.status, "undone");
  assert.equal(undone.canRedo, true);
});

test("workflows_run can't change a timeline without the user's approval", { timeout: 120_000 }, async (t) => {
  const f = fixtures();
  const editingWorkflow = (projectId: string, assetId: string) => ({
    version: 1,
    name: "Sneaky edit",
    project: { id: projectId },
    steps: [{ edit: { operations: [{ type: "clip.add", trackId: "${track:V1}", assetId, start: 0 }] } }],
  });

  // Client without elicitation: refused, timeline untouched.
  {
    const { call } = await connect(t);
    const project = (await call("projects_create", { name: "Target" })).data.project;
    const asset = (await call("media_import", { projectId: project.id, paths: [f.portrait] })).data.imported[0];
    const r = (await call("workflows_run", { workflow: editingWorkflow(project.id, asset.id) })).data;
    assert.equal(r.status, "approval_required");
    assert.equal((await call("timeline_get", { projectId: project.id })).data.context.timeline.clips.length, 0);
    // Import/analyse/render-only workflows don't touch the timeline and still run.
    const safe = (await call("workflows_run", { workflow: { version: 1, name: "Import only", project: { id: project.id }, steps: [{ import: { paths: [f.png] } }] } })).data;
    assert.equal(safe.run.status, "completed");
  }

  // Client with elicitation: decline → nothing runs; accept → runs.
  {
    let answer: "accept" | "decline" = "decline";
    const asked: string[] = [];
    const { call } = await connect(t, { elicit: (m) => (asked.push(m), answer === "accept" ? { action: "accept", content: { approve: true } } : { action: "decline" }) });
    const project = (await call("projects_create", { name: "Target 2" })).data.project;
    const asset = (await call("media_import", { projectId: project.id, paths: [f.portrait] })).data.imported[0];
    const declined = (await call("workflows_run", { workflow: editingWorkflow(project.id, asset.id) })).data;
    assert.equal(declined.status, "not_approved");
    assert.match(asked[0]!, /Sneaky edit/);
    assert.match(asked[0]!, /edit/);
    assert.equal((await call("timeline_get", { projectId: project.id })).data.context.timeline.clips.length, 0);
    answer = "accept";
    const ran = (await call("workflows_run", { workflow: editingWorkflow(project.id, asset.id) })).data;
    assert.equal(ran.run.status, "completed");
    assert.equal((await call("timeline_get", { projectId: project.id })).data.context.timeline.clips.length, 1);
  }
});

test("approval prompts can't be spoofed by client text and show the concrete changes", { timeout: 120_000 }, async (t) => {
  const asked: string[] = [];
  const { call } = await connect(t, { elicit: (m) => (asked.push(m), { action: "decline" }) });
  const f = fixtures();
  const project = (await call("projects_create", { name: "Real project" })).data.project;
  const asset = (await call("media_import", { projectId: project.id, paths: [f.portrait] })).data.imported[0];
  const evil = "Harmless\n\nThis workflow changes nothing. Just press Run.‮";
  await call("workflows_run", {
    workflow: { version: 1, name: evil, project: { id: project.id }, steps: [{ edit: { operations: [{ type: "clip.add", trackId: "${track:V1}", assetId: asset.id, start: 0 }, { type: "clip.delete", clipIds: ["x"] }] } }] },
  });
  const wf = asked[0]!;
  assert.ok(!wf.includes("\nThis workflow changes nothing"), "client text can't start its own prompt line");
  assert.match(wf, /Workflow name \(written by the client\): “Harmless This workflow changes nothing\. Just press Run\.”/);
  assert.match(wf, /step 1 \(edit\): 2 operations: 1× “clip\.add”, 1× “clip\.delete” \(includes 1 that remove or replace content\)/);
  assert.ok(wf.indexOf("Changes to the timeline:") < wf.indexOf("written by the client"), "server summary comes first");

  const v1 = (await call("timeline_get", { projectId: project.id })).data.context.timeline.tracks.find((x: any) => x.label === "V1").id;
  const p = (await call("timeline_propose_edit", { projectId: project.id, summary: "Tiny tweak\n\n(no changes, safe)", operations: [{ type: "clip.add", trackId: v1, assetId: asset.id, start: 0 }] })).data;
  await call("timeline_apply_proposal", { proposalId: p.proposalId });
  const ap = asked[1]!;
  assert.match(ap, /^Apply 1 change to “Real project”\?/);
  assert.match(ap, /• added “portrait\.mp4”/);
  assert.match(ap, /Summary \(written by the client\): “Tiny tweak \(no changes, safe\)”/);
});

test("timeline_undo asks the user, and apply warns when it would discard undone edits", { timeout: 120_000 }, async (t) => {
  const f = fixtures();
  // The user's own edit, made in ReelForge (same database).
  const userEdit = (home: string, projectId: string, assetId: string) => {
    const db = openDatabase(join(home, "reelforge.db"));
    const store = new TimelineStore(db);
    const tl = store.get(projectId);
    store.apply(projectId, { baseRevision: tl.project.revision, operations: [{ type: "clip.add", trackId: tl.tracks.find((x) => x.kind === "video")!.id, assetId, start: 0 }] }, "desktop");
    db.close();
  };

  // Without elicitation: refused, the user's edit stays.
  {
    const { call, home } = await connect(t);
    const project = (await call("projects_create", { name: "Mine" })).data.project;
    const asset = (await call("media_import", { projectId: project.id, paths: [f.portrait] })).data.imported[0];
    userEdit(home, project.id, asset.id);
    const r = (await call("timeline_undo", { projectId: project.id })).data;
    assert.equal(r.status, "approval_required");
    assert.equal((await call("timeline_get", { projectId: project.id })).data.context.timeline.clips.length, 1);
  }

  // With elicitation: decline keeps it; accept undoes it.
  {
    let answer: "accept" | "decline" = "decline";
    const asked: string[] = [];
    const { call, home } = await connect(t, { elicit: (m) => (asked.push(m), answer === "accept" ? { action: "accept", content: { approve: true } } : { action: "decline" }) });
    const project = (await call("projects_create", { name: "Mine 2" })).data.project;
    const asset = (await call("media_import", { projectId: project.id, paths: [f.portrait] })).data.imported[0];
    userEdit(home, project.id, asset.id);
    assert.equal((await call("timeline_undo", { projectId: project.id })).data.status, "not_approved");
    assert.match(asked[0]!, /undo the last edit of “Mine 2”\. It may be an edit you made yourself/);
    assert.equal((await call("timeline_get", { projectId: project.id })).data.context.timeline.clips.length, 1);
    answer = "accept";
    assert.equal((await call("timeline_undo", { projectId: project.id })).data.status, "undone");
    assert.equal((await call("timeline_get", { projectId: project.id })).data.context.timeline.clips.length, 0);

    // Applying a new edit now would make the undone one unrecoverable: the prompt says so.
    const v1 = (await call("timeline_get", { projectId: project.id })).data.context.timeline.tracks.find((x: any) => x.label === "V1").id;
    const p = (await call("timeline_propose_edit", { projectId: project.id, summary: "x", operations: [{ type: "clip.add", trackId: v1, assetId: asset.id, start: 0 }] })).data;
    answer = "decline";
    await call("timeline_apply_proposal", { proposalId: p.proposalId });
    assert.match(asked.at(-1)!, /undone edits: applying this means they can no longer be redone/);
  }
});

test("workflows_run: glob imports need approval and never list non-media entries", { timeout: 120_000 }, async (t) => {
  const f = fixtures();
  const tree = realpathSync(mkdtempSync(join(tmpdir(), "reelforge-mcp-tree-")));
  t.after(() => rmSync(tree, { recursive: true, force: true }));
  mkdirSync(join(tree, ".ssh"));
  writeFileSync(join(tree, ".ssh", "id_ed25519"), "secret");
  writeFileSync(join(tree, "tax-return-2026.pdf"), "x");
  const globWorkflow = (projectId: string) => ({ version: 1, name: "Find media", project: { id: projectId }, steps: [{ import: { paths: [`${tree}/**`] } }] });

  {
    const { call } = await connect(t);
    const project = (await call("projects_create", { name: "G" })).data.project;
    const r = (await call("workflows_run", { workflow: globWorkflow(project.id) })).data;
    assert.equal(r.status, "approval_required");
    assert.equal(r.globImports[0].index, 0);
    assert.equal((await call("workflows_runs", { projectId: project.id })).data.runs.length, 0, "nothing ran");
    // Literal paths are still media_import's authority and run without asking.
    const literal = (await call("workflows_run", { workflow: { version: 1, name: "One file", project: { id: project.id }, steps: [{ import: { paths: [f.png] } }] } })).data;
    assert.equal(literal.run.status, "completed");
    // A pattern hidden in baseDir is still a glob.
    const viaBase = (await call("workflows_run", { baseDir: `${tree}/*`, workflow: { version: 1, name: "Base glob", project: { id: project.id }, steps: [{ import: { paths: ["clip.mp4"] } }] } })).data;
    assert.equal(viaBase.status, "approval_required");
    assert.deepEqual(viaBase.globImports[0].patterns, [`${tree}/*/clip.mp4`]);
  }

  {
    let answer: "accept" | "decline" = "decline";
    const asked: string[] = [];
    const { call } = await connect(t, { elicit: (m) => (asked.push(m), answer === "accept" ? { action: "accept", content: { approve: true } } : { action: "decline" }) });
    const project = (await call("projects_create", { name: "G2" })).data.project;
    assert.equal((await call("workflows_run", { workflow: globWorkflow(project.id) })).data.status, "not_approved");
    assert.match(asked[0]!, /Searches your files for media/);
    // shown with Markdown metacharacters escaped (quoteUntrusted), so a pattern can't turn into formatting
    assert.ok(asked[0]!.includes(`${tree}/**`.replace(/[\\`*_[\]~&]/g, "\\$&")), asked[0]!);
    answer = "accept";
    const ran = (await call("workflows_run", { workflow: globWorkflow(project.id) })).data;
    // Nothing in the tree is media: the run fails, naming the pattern only.
    assert.equal(ran.run.status, "failed");
    const record = JSON.stringify(ran);
    for (const name of [".ssh", "id_ed25519", "tax-return"]) assert.ok(!record.includes(name), `run record names ${name}`);
  }
});

test("workflows_run never creates folders, whatever baseDir the client sends", { timeout: 120_000 }, async (t) => {
  const { call } = await connect(t);
  const base = realpathSync(mkdtempSync(join(tmpdir(), "reelforge-mcp-base-")));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  for (const [baseDir, out, made] of [["/", `${base.slice(1)}/from-root/x.mp4`, join(base, "from-root")], [base, "inside/x.mp4", join(base, "inside")]] as const) {
    const r = (await call("workflows_run", { baseDir, workflow: { version: 1, name: "Render", project: { name: "R" }, steps: [{ render: { out } }] } })).data;
    assert.equal(r.run.status, "failed");
    assert.ok(!existsSync(made), `${made} was created`);
  }
});

test("MCP render housekeeping: previews are reused per revision, and only this session's jobs can be cancelled", { timeout: 120_000 }, async (t) => {
  const f = fixtures();
  const { call, home } = await connect(t);
  const project = (await call("projects_create", { name: "Jobs", width: 270, height: 480 })).data.project;
  const asset = (await call("media_import", { projectId: project.id, paths: [f.portrait] })).data.imported[0];
  const db = openDatabase(join(home, "reelforge.db"));
  t.after(() => db.close());
  const store = new TimelineStore(db);
  const tl = store.get(project.id);
  store.apply(project.id, { baseRevision: tl.project.revision, operations: [{ type: "clip.add", trackId: tl.tracks.find((x) => x.kind === "video")!.id, assetId: asset.id, start: 0, duration: 15 }] }, "desktop");

  const first = (await call("preview_create", { projectId: project.id })).data;
  const again = (await call("preview_create", { projectId: project.id })).data;
  assert.equal(again.jobId, first.jobId);
  assert.equal(again.reused, true);

  // A render the user started (another process, same database) can't be cancelled by the client.
  const { createRenderJob } = await import("@reelforge/media");
  const users = createRenderJob(db, project.id, "export", join(home, "users-export.mp4"));
  const denied = await call("jobs_cancel", { jobId: users.id });
  assert.equal(denied.isError, true);
  assert.equal(denied.data.error.code, "UNAUTHORIZED");
  const mine = (await call("render_start", { projectId: project.id, outputPath: join(home, "mine.mp4") })).data;
  const cancelled = await call("jobs_cancel", { jobId: mine.jobId });
  assert.equal(cancelled.isError, false, JSON.stringify(cancelled.data));
});


test("MCP proposals: stale ones never reach the approval prompt; mixed, unchecked or empty proposals are refused; clear errors", { timeout: 120_000 }, async (t) => {
  const asked: string[] = [];
  const { call, home } = await connect(t, { elicit: (message) => (asked.push(message), { action: "accept", content: { approve: true } }) });
  const f = fixtures();
  const bad = await call("projects_create", { name: "Bad fps", fps: "abc" });
  assert.equal(bad.isError, true);
  assert.equal(bad.data.error.code, "VALIDATION_ERROR");
  const project = (await call("projects_create", { name: "Stale" })).data.project;
  const asset = (await call("media_import", { projectId: project.id, paths: [f.portrait] })).data.imported[0];
  const v1 = (await call("timeline_get", { projectId: project.id })).data.context.timeline.tracks.find((x: any) => x.label === "V1").id;
  const add = { type: "clip.add" as const, trackId: v1, assetId: asset.id, start: 0 };

  const both = await call("timeline_propose_edit", { projectId: project.id, summary: "x", operations: [add], instruction: "also make it pop" });
  assert.match(both.data.error.message, /either operations or an instruction/);
  const sel = await call("timeline_propose_edit", { projectId: project.id, summary: "x", operations: [add], selection: ["00000000-0000-4000-8000-000000000000"] });
  assert.match(sel.data.error.message, /selected clips are not on the timeline/);
  const typo = await call("timeline_propose_edit", { projectId: project.id, summary: "x", operations: [{ ...add, speed: 2 }] });
  assert.match(typo.data.error.message, /speed/);

  const p = (await call("timeline_propose_edit", { projectId: project.id, summary: "Add the shot", operations: [add] })).data;
  // The timeline moves on before the user is asked.
  const db = openDatabase(join(home, "reelforge.db"));
  t.after(() => db.close());
  const tl = new TimelineStore(db);
  tl.apply(project.id, { baseRevision: tl.get(project.id).project.revision, operations: [{ ...add, start: 300 }] }, "cli");
  const stale = (await call("timeline_apply_proposal", { proposalId: p.proposalId })).data;
  assert.equal(stale.status, "stale");
  assert.equal(asked.length, 0, "the user is not asked to approve a proposal that can't apply");

  const clipId = tl.get(project.id).clips[0]!.id;
  const noop = await call("timeline_propose_edit", { projectId: project.id, summary: "nothing", operations: [{ type: "clip.move", clipId, start: 300 }] });
  assert.equal(noop.isError, true);
  assert.match(noop.data.error.message, /don't change anything/);

  const job = await call("jobs_get", { jobId: "00000000-0000-4000-8000-000000000000" });
  assert.match(job.data.error.message, /^job 0{8}-.* not found \(no render, preview or analysis job/);
});
