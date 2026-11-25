import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, ProposalStore, TimelineStore, WorkflowRunStore } from "@reelforge/core";
import { globImportSteps, parseWorkflow, quoteUntrusted, resumeWorkflow, runWorkflow } from "../src/index.ts";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "reelforge-wf-")));
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
mkdirSync(join(dir, "footage"));
const ff = (args: string[]) => execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args]);
ff(["-f", "lavfi", "-i", "color=c=red:s=270x480:r=30:d=3", "-c:v", "libx264", "-pix_fmt", "yuv420p", join(dir, "footage", "a_red.mp4")]);
ff(["-f", "lavfi", "-i", "color=c=blue:s=270x480:r=30:d=3", "-c:v", "libx264", "-pix_fmt", "yuv420p", join(dir, "footage", "b_blue.mp4")]);
ff(["-f", "lavfi", "-i", "aevalsrc='0.8*sin(2*PI*1000*t)*lt(mod(t\\,0.5)\\,0.012)':s=44100:d=6", join(dir, "footage", "music.wav")]);

function db(t: { after: (fn: () => void) => void }) {
  const home = mkdtempSync(join(tmpdir(), "reelforge-wf-db-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return { db: openDatabase(join(home, "db.sqlite")), cacheDir: join(home, "cache"), home };
}

test("a recipe from folder to MP4: import (glob), beats, append, templated edit, render", async (t) => {
  const s = db(t);
  // The recipe's own output folder doesn't exist yet: the render step creates it.
  const outDir = `renders-${process.pid}-${Date.now()}`;
  const out = join(dir, outDir, "reel.mp4");
  t.after(() => rmSync(join(dir, outDir), { recursive: true, force: true }));
  const run = await runWorkflow(
    s.db,
    {
      version: 1,
      name: "Folder to reel",
      project: { name: "WF", width: 270, height: 480 },
      steps: [
        { import: { paths: ["footage/*.mp4", "footage/music.wav"] } },
        { analyze: { assets: ["music.wav"], kinds: ["beats"] } },
        { append: { asset: "a_red.mp4", track: "V1", duration: "1s" } },
        { append: { asset: "b_blue.mp4", track: "V1", duration: "1.5s", sourceIn: 15, props: { transitionIn: 10 } } },
        { append: { asset: "music.wav", track: "A1", duration: "2.5s" } },
        { edit: { operations: [{ type: "clip.update", clipId: "${clip:a_red.mp4}", props: { fadeIn: 10 } }, { type: "caption.add", trackId: "${track:C1}", start: "0.5s", duration: 30, text: "Hello" }] } },
        { render: { out: `${outDir}/reel.mp4` } },
      ],
    },
    { cacheDir: s.cacheDir, actor: "cli", baseDir: dir, source: "test.json", createOutputDirs: true },
  );
  assert.equal(run.status, "completed", JSON.stringify(run.steps));
  assert.deepEqual(run.steps.map((x) => x.status), Array(7).fill("completed"));
  assert.match(run.steps[0]!.detail!, /^3 imported/);
  const tl = new TimelineStore(s.db).get(run.projectId!);
  const v1 = tl.clips.filter((c) => c.trackId === tl.tracks.find((x) => x.name === "Video")!.id).sort((a, b) => a.start - b.start);
  assert.deepEqual(v1.map((c) => [c.start, c.duration, c.sourceIn]), [[0, 30, 0], [30, 45, 15]]);
  assert.deepEqual(v1[0]!.props, { fadeIn: 10 });
  assert.equal(tl.captions[0]!.start, 15);
  const frames = execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=nb_frames", "-of", "csv=p=0", out]).toString().trim();
  assert.equal(frames, "75");
  // every workflow edit is traceable to the run
  assert.equal(new WorkflowRunStore(s.db).get(run.id).projectId, run.projectId);
});

test("a failing step stops the run and skips the rest", async (t) => {
  const s = db(t);
  const run = await runWorkflow(
    s.db,
    { version: 1, name: "Broken", project: { name: "B" }, steps: [{ import: { paths: [join(dir, "footage", "a_red.mp4")] } }, { append: { asset: "nope.mp4", track: "V1" } }, { render: { out: join(s.home, "x.mp4") } }] },
    { cacheDir: s.cacheDir, actor: "cli", baseDir: dir },
  );
  assert.equal(run.status, "failed");
  assert.deepEqual(run.steps.map((x) => x.status), ["completed", "failed", "skipped"]);
  assert.match(run.error!, /step 2 \(append\): no imported media named "nope.mp4"/);
});

test("invalid workflow files are rejected before anything runs", async (t) => {
  const s = db(t);
  await assert.rejects(runWorkflow(s.db, { version: 2, name: "x", project: { name: "x" }, steps: [] }, { cacheDir: s.cacheDir, actor: "cli", baseDir: dir }), /invalid workflow/);
  await assert.rejects(runWorkflow(s.db, { version: 1, name: "x", project: { name: "x" }, steps: [{ shell: { cmd: "rm -rf /" } }] }, { cacheDir: s.cacheDir, actor: "cli", baseDir: dir }), /invalid workflow/);
  assert.equal(new WorkflowRunStore(s.db).list().length, 0);
});

test("an AI Director step waits for approval unless --approve-ai", async (t) => {
  const s = db(t);
  let clipId = "";
  const fake = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.url === "/api/tags") return res.end(JSON.stringify({ models: [{ name: "fake:1b" }] }));
      const msg = JSON.parse(body).messages[1].content as string;
      clipId = /"clips":\[\{"id":"([0-9a-f-]{36})"/.exec(msg)?.[1] ?? "";
      res.end(JSON.stringify({ model: "fake:1b", message: { content: JSON.stringify({ summary: "Fade", warnings: [], operations: [{ type: "clip.update", why: "soft", clipId, props: { fadeOut: 9 } }] }) } }));
    });
  });
  await new Promise<void>((r) => fake.listen(0, "127.0.0.1", () => r()));
  const prev = process.env.REELFORGE_OLLAMA_URL;
  process.env.REELFORGE_OLLAMA_URL = `http://127.0.0.1:${(fake.address() as { port: number }).port}`;
  t.after(() => {
    fake.close();
    if (prev === undefined) delete process.env.REELFORGE_OLLAMA_URL;
    else process.env.REELFORGE_OLLAMA_URL = prev;
  });
  const spec = (name: string) => ({
    version: 1 as const,
    name,
    project: { name },
    steps: [{ import: { paths: [join(dir, "footage", "a_red.mp4")] } }, { append: { asset: "a_red.mp4", track: "V1" } }, { director: { instruction: "fade out", provider: "ollama" as const } }],
  });
  const waiting = await runWorkflow(s.db, spec("Wait"), { cacheDir: s.cacheDir, actor: "cli", baseDir: dir });
  assert.equal(waiting.status, "waiting_approval");
  const proposalId = waiting.steps[2]!.result!.proposalId as string;
  assert.equal(new ProposalStore(s.db).get(proposalId).status, "pending");
  assert.equal(new ProposalStore(s.db).get(proposalId).requestedBy, "user");
  assert.deepEqual(new TimelineStore(s.db).get(waiting.projectId!).clips[0]!.props, {}, "nothing applied without approval");

  // Sent by an MCP client (its edits approved by the user): the director's instruction is the client's, not the user's.
  const fromClient = await runWorkflow(s.db, spec("Client"), { cacheDir: s.cacheDir, actor: "mcp", baseDir: dir, timelineEditsApproved: true });
  assert.equal(fromClient.status, "waiting_approval");
  assert.equal(new ProposalStore(s.db).get(fromClient.steps[2]!.result!.proposalId as string).requestedBy, "mcp");

  // Resume: refused while the proposal waits, then the remaining steps run once it is applied.
  const withTail = { ...spec("Resume"), steps: [...spec("Resume").steps, { edit: { operations: [{ type: "clip.update", clipId: "${clip:a_red.mp4}", props: { opacity: 0.5 } }] } }] };
  const stopped = await runWorkflow(s.db, withTail, { cacheDir: s.cacheDir, actor: "cli", baseDir: dir });
  assert.deepEqual(stopped.steps.map((x) => x.status), ["completed", "completed", "waiting_approval", "pending"]);
  assert.match(stopped.steps[2]!.detail!, /resume/);
  const pid = stopped.steps[2]!.result!.proposalId as string;
  await assert.rejects(resumeWorkflow(s.db, stopped.id, withTail, { cacheDir: s.cacheDir, actor: "cli", baseDir: dir }), /still waiting for your approval/);
  await assert.rejects(resumeWorkflow(s.db, stopped.id, spec("Resume"), { cacheDir: s.cacheDir, actor: "cli", baseDir: dir }), /not the one the run started with/);
  new ProposalStore(s.db).apply(pid, { by: "cli", channel: "cli:--yes" });
  const resumed = await resumeWorkflow(s.db, stopped.id, withTail, { cacheDir: s.cacheDir, actor: "cli", baseDir: dir });
  assert.equal(resumed.status, "completed", JSON.stringify(resumed.steps));
  assert.deepEqual(resumed.steps.map((x) => x.status), ["completed", "completed", "completed", "completed"]);
  assert.deepEqual(new TimelineStore(s.db).get(resumed.projectId!).clips[0]!.props, { fadeOut: 9, opacity: 0.5 });
  await assert.rejects(resumeWorkflow(s.db, stopped.id, withTail, { cacheDir: s.cacheDir, actor: "cli", baseDir: dir }), /is completed/);
  // A rejected proposal ends the run as failed; the steps after it are skipped, not left pending.
  const again = await runWorkflow(s.db, withTail, { cacheDir: s.cacheDir, actor: "cli", baseDir: dir });
  new ProposalStore(s.db).reject(again.steps[2]!.result!.proposalId as string, "cli");
  const refused = await resumeWorkflow(s.db, again.id, withTail, { cacheDir: s.cacheDir, actor: "cli", baseDir: dir });
  assert.equal(refused.status, "failed");
  assert.deepEqual(refused.steps.map((x) => x.status), ["completed", "completed", "failed", "skipped"]);

  const approved = await runWorkflow(s.db, spec("Go"), { cacheDir: s.cacheDir, actor: "cli", baseDir: dir, approveAi: true });
  assert.equal(approved.status, "completed");
  assert.deepEqual(new TimelineStore(s.db).get(approved.projectId!).clips[0]!.props, { fadeOut: 9 });
});

test("timelineEditsApproved: false blocks every timeline-changing step in the runner itself", async (t) => {
  const s = db(t);
  const run = await runWorkflow(
    s.db,
    { version: 1, name: "Unapproved", project: { name: "U" }, steps: [{ import: { paths: [join(dir, "footage", "a_red.mp4")] } }, { append: { asset: "a_red.mp4", track: "V1" } }] },
    { cacheDir: s.cacheDir, actor: "mcp", baseDir: dir, timelineEditsApproved: false },
  );
  assert.equal(run.status, "failed");
  assert.deepEqual(run.steps.map((x) => x.status), ["completed", "failed"]);
  assert.match(run.error!, /needs the user's approval/);
  assert.equal(new TimelineStore(s.db).get(run.projectId!).clips.length, 0);
});

test("a glob imports only media files and never names the other entries it saw", async (t) => {
  const s = db(t);
  const mixed = join(dir, "mixed");
  mkdirSync(join(mixed, "private-folder"), { recursive: true });
  execFileSync("cp", [join(dir, "footage", "a_red.mp4"), join(mixed, "clip.mp4")]);
  writeFileSync(join(mixed, "id_rsa_secret.txt"), "not media");
  mkdirSync(join(mixed, "folder.mp4")); // a directory with a media extension is still not a file
  const spec = { version: 1, name: "Glob", project: { name: "G" }, steps: [{ import: { paths: ["mixed/*"] } }] };

  const run = await runWorkflow(s.db, spec, { cacheDir: s.cacheDir, actor: "cli", baseDir: dir });
  assert.equal(run.status, "completed", JSON.stringify(run.steps));
  assert.match(run.steps[0]!.detail!, /^1 imported, 3 non-media entries skipped$/);
  const record = JSON.stringify(new WorkflowRunStore(s.db).get(run.id));
  for (const name of ["id_rsa_secret", "private-folder", "folder.mp4"]) assert.ok(!record.includes(name), `run record names ${name}`);

  // Unapproved (an MCP client without the user's yes): the glob is refused before anything is listed.
  const refused = await runWorkflow(s.db, spec, { cacheDir: s.cacheDir, actor: "mcp", baseDir: dir, globsApproved: false });
  assert.equal(refused.status, "failed");
  assert.match(refused.error!, /glob pattern mixed\/\* needs the user's approval/);
});

test("a render step creates a missing folder only when asked, and only inside baseDir", async (t) => {
  const s = db(t);
  const base = realpathSync(mkdtempSync(join(tmpdir(), "reelforge-wf-base-")));
  const outside = realpathSync(mkdtempSync(join(tmpdir(), "reelforge-wf-outside-")));
  t.after(() => [base, outside].forEach((d) => rmSync(d, { recursive: true, force: true })));
  symlinkSync(outside, join(base, "link"));
  const render = (out: string, createOutputDirs?: boolean) =>
    runWorkflow(s.db, { version: 1, name: "R", project: { name: "R" }, steps: [{ render: { out } }] }, { cacheDir: s.cacheDir, actor: "mcp", baseDir: base, ...(createOutputDirs ? { createOutputDirs } : {}) });

  // MCP leaves createOutputDirs off: even a folder inside baseDir is not created.
  await render("made-by-client/x.mp4");
  assert.ok(!existsSync(join(base, "made-by-client")));
  // With it on, nothing outside baseDir: not via ".." or through a symlink that points out.
  await render("../escaped/x.mp4", true);
  assert.ok(!existsSync(join(base, "..", "escaped")));
  await render("link/through-symlink/x.mp4", true);
  assert.ok(!existsSync(join(outside, "through-symlink")));
  // The export path is checked before any folder is made.
  await render("not-a-video/x.txt", true);
  assert.ok(!existsSync(join(base, "not-a-video")));
  await render("inside/x.mp4", true);
  assert.ok(existsSync(join(base, "inside")));
});

test("glob detection sees a pattern carried by baseDir, as the runner does", () => {
  const spec = parseWorkflow({ version: 1, name: "B", project: { name: "B" }, steps: [{ import: { paths: ["clip.mp4", "/abs/literal.mp4"] } }] });
  assert.deepEqual(globImportSteps(spec, "/safe/dir"), []);
  assert.deepEqual(globImportSteps(spec, "/Users/*"), [{ index: 0, patterns: ["/Users/*/clip.mp4"] }]);
});

test("a glob stops past the import limit, and failures are listed by name only up to ten", async (t) => {
  const s = db(t);
  const many = join(dir, "many");
  mkdirSync(many);
  for (let i = 0; i < 205; i++) writeFileSync(join(many, `f${i}.mp4`), "");
  const tooMany = await runWorkflow(s.db, { version: 1, name: "Many", project: { name: "M" }, steps: [{ import: { paths: ["many/*.mp4"] } }] }, { cacheDir: s.cacheDir, actor: "cli", baseDir: dir });
  assert.equal(tooMany.status, "failed");
  assert.match(tooMany.error!, /matches more than 200 media files/);
  assert.ok(!tooMany.error!.includes("f1.mp4"));

  const broken = Array.from({ length: 15 }, (_, i) => join(many, `f${i}.mp4`)); // empty files: not readable media
  const failed = await runWorkflow(s.db, { version: 1, name: "Broken", project: { name: "B" }, steps: [{ import: { paths: broken } }] }, { cacheDir: s.cacheDir, actor: "cli", baseDir: dir });
  assert.equal(failed.status, "failed");
  assert.match(failed.error!, /\(and 5 more\)$/);
  assert.equal((failed.error!.match(/f\d+\.mp4:/g) ?? []).length, 10);
});


test("quoteUntrusted leaves no live Markdown or HTML in an approval prompt", () => {
  const hostile = "clip <!-- hide --> ![x](http://198.51.100.1/w.png) **safe** `code` [link](http://x) my_clip.mp4 \\";
  const q = quoteUntrusted(hostile, 200);
  assert.doesNotMatch(q, /[<>]/, "no tag or comment can open");
  // every Markdown metacharacter is preceded by a backslash
  for (const m of q.matchAll(/[`*_[\]~&]/g)) assert.equal(q[m.index! - 1], "\\", `unescaped ${m[0]} at ${m.index} in ${q}`);
  assert.match(q, /my\\_clip\.mp4/);
  // the cut happens before escaping, so a long text never ends in a dangling backslash
  const cut = quoteUntrusted("a".repeat(10) + "*".repeat(20), 12);
  assert.equal(cut, "“aaaaaaaaaa\\*…”");
  assert.equal(quoteUntrusted("line\nbreak\u202eflip"), "“line break flip”");
});

test("validate checks deeply and says what is wrong", () => {
  const base = { version: 1, name: "x", project: { name: "a" } };
  const issues = (spec: object) => {
    try {
      parseWorkflow(spec);
    } catch (e) {
      return (e as { details: { issues: { path: string; message: string }[] } }).details.issues.map((i) => `${i.path}: ${i.message}`).join(" | ");
    }
    return "valid";
  };
  assert.match(issues({ ...base, steps: [{ explode: {} }] }), /steps\.0: unknown step "explode" \(use import, analyze/);
  assert.match(issues({ ...base, steps: [{ import: { paths: ["a.mp4"] }, preview: {} }] }), /steps\.0: a step is an object with exactly one key/);
  assert.match(issues({ ...base, steps: [{ render: { out: 3 } }] }), /steps\.0\.render\.out/);
  assert.match(issues({ ...base, project: { name: "a", fps: "abc" }, steps: [{ preview: {} }] }), /project\.fps: unsupported frame rate "abc"/);
  assert.match(issues({ ...base, project: { name: "a", width: 7 }, steps: [{ preview: {} }] }), /project\.width/);
  assert.match(issues({ ...base, steps: [{ edit: { operations: [{ type: "clip.nope" }] } }] }), /steps\.0\.edit\.operations\.0\.type: unknown operation type "clip\.nope"/);
  assert.match(issues({ ...base, steps: [{ edit: { operations: [{ type: "clip.move", clipId: "x", start: 0, track: "V2" }] } }] }), /operations\.0\.track: clip\.move has no field "track"/);
  assert.match(issues({ ...base, steps: [{ append: { asset: "a", track: "V1", props: { fadein: 3 } } }] }), /append\.props\.fadein: unknown clip property/);
  assert.equal(issues({ ...base, steps: [{ edit: { operations: [{ type: "clip.update", why: "ok", clipId: "${clip:a.mp4}", props: { fadeIn: "0.5s" } }] } }] }), "valid");
});

test("a run whose project can't be opened fails without leaving steps pending", async (t) => {
  const s = db(t);
  const run = await runWorkflow(s.db, { version: 1, name: "x", project: { id: "00000000-0000-4000-8000-000000000000" }, steps: [{ preview: {} }, { render: { out: "x.mp4" } }] }, { cacheDir: s.cacheDir, actor: "cli", baseDir: dir });
  assert.equal(run.status, "failed");
  assert.match(run.error!, /^project: .*not found/);
  assert.deepEqual(run.steps.map((x) => x.status), ["skipped", "skipped"]);
});

test("time strings work for fades and dissolves too", async (t) => {
  const s = db(t);
  const run = await runWorkflow(
    s.db,
    {
      version: 1,
      name: "Fades",
      project: { name: "F" },
      steps: [
        { import: { paths: [join(dir, "footage", "a_red.mp4")] } },
        { append: { asset: "a_red.mp4", track: "V1", props: { fadeIn: "0.5s" } } },
        { edit: { operations: [{ type: "clip.update", clipId: "${clip:a_red.mp4}", props: { fadeOut: "1s", transitionIn: "00:00:00:06" } }] } },
      ],
    },
    { cacheDir: s.cacheDir, actor: "cli", baseDir: dir },
  );
  assert.equal(run.status, "completed", JSON.stringify(run.steps));
  assert.deepEqual(new TimelineStore(s.db).get(run.projectId!).clips[0]!.props, { fadeIn: 15, fadeOut: 30, transitionIn: 6 });
});
