import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { openDatabase, ProposalStore } from "@reelforge/core";
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
