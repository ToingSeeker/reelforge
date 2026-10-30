import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, ProposalStore, TimelineStore, WorkflowRunStore } from "@reelforge/core";
import { runWorkflow } from "../src/index.ts";

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
  const out = join(s.home, "out", "reel.mp4");
  mkdirSync(join(s.home, "out"));
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
        { render: { out } },
      ],
    },
    { cacheDir: s.cacheDir, actor: "cli", baseDir: dir, source: "test.json" },
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
  assert.deepEqual(new TimelineStore(s.db).get(waiting.projectId!).clips[0]!.props, {}, "nothing applied without approval");

  const approved = await runWorkflow(s.db, spec("Go"), { cacheDir: s.cacheDir, actor: "cli", baseDir: dir, approveAi: true });
  assert.equal(approved.status, "completed");
  assert.deepEqual(new TimelineStore(s.db).get(approved.projectId!).clips[0]!.props, { fadeOut: 9 });
});
