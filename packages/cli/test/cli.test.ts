import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../src/main.ts";

function harness(t: { after: (fn: () => void) => void }) {
  const home = mkdtempSync(join(tmpdir(), "reelforge-cli-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return async (...argv: string[]) => {
    let out = "";
    let err = "";
    const code = await main(argv, {
      out: (s) => (out += s),
      err: (s) => (err += s),
      isTTY: false,
      env: { REELFORGE_HOME: home },
    });
    return { code, json: out ? JSON.parse(out) : undefined, error: err ? JSON.parse(err).error : undefined };
  };
}

test("create → list → rename → history, all JSON", async (t) => {
  const run = harness(t);
  const c = await run("project", "create", "--name", "Cafe Brand Story", "--fps", "29.97");
  assert.equal(c.code, 0);
  assert.deepEqual(c.json.project.settings.fps, { num: 30000, den: 1001 });
  const id = c.json.project.id;

  const l = await run("project", "list");
  assert.equal(l.json.projects.length, 1);

  const r = await run("project", "rename", id, "--name", "Cafe v2", "--base-revision", "1");
  assert.equal(r.code, 0);
  assert.equal(r.json.project.revision, 2);

  const h = await run("project", "history", id);
  assert.deepEqual(h.json.operations.map((o: any) => o.kind), ["project.create", "project.rename"]);
});

test("errors are JSON on stderr with distinct exit codes", async (t) => {
  const run = harness(t);
  const missing = await run("project", "create");
  assert.equal(missing.code, 2);
  assert.equal(missing.error.code, "VALIDATION_ERROR");

  const notFound = await run("project", "get", "00000000-0000-4000-8000-000000000000");
  assert.equal(notFound.code, 3);

  const id = (await run("project", "create", "--name", "A")).json.project.id;
  await run("project", "rename", id, "--name", "B", "--base-revision", "1");
  const conflict = await run("project", "rename", id, "--name", "C", "--base-revision", "1");
  assert.equal(conflict.code, 4);
  assert.equal(conflict.error.details.currentRevision, 2);

  const badFlag = await run("project", "list", "--bogus");
  assert.equal(badFlag.code, 2);
  const badFps = await run("project", "create", "--name", "x", "--fps", "abc");
  assert.equal(badFps.code, 2);
});

test("serve prints a ready line and exits on SIGTERM and on stdin EOF", async (t) => {
  const { spawn } = await import("node:child_process");
  const { once } = await import("node:events");
  const home = mkdtempSync(join(tmpdir(), "reelforge-serve-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const bin = new URL("../bin/reelforge.js", import.meta.url).pathname;

  async function boot() {
    // stdin stays an open pipe, exactly like the desktop shell's sidecar.
    const child = spawn(process.execPath, [bin, "serve"], { env: { ...process.env, REELFORGE_HOME: home }, stdio: ["pipe", "pipe", "inherit"] });
    const [chunk] = (await once(child.stdout!, "data")) as [Buffer];
    const ready = JSON.parse(chunk.toString().split("\n")[0]!);
    assert.equal(ready.event, "ready");
    assert.match(ready.url, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.ok(ready.token.length >= 32);
    return child;
  }

  const exitWithin = (child: ReturnType<typeof spawn>, ms: number) =>
    Promise.race([once(child, "exit").then(() => "exited"), new Promise((r) => setTimeout(() => r("hung"), ms))]);

  const a = await boot();
  a.kill("SIGTERM");
  assert.equal(await exitWithin(a, 3000), "exited");

  const b = await boot();
  b.stdin!.end(); // parent went away
  assert.equal(await exitWithin(b, 3000), "exited");
});

test("M1 workflow from the CLI alone: import → add → split → trim → ripple delete → undo", async (t) => {
  const run = harness(t);
  const { fixtures } = await import("../../media/test/fixtures.ts");
  const f = fixtures();
  const id = (await run("project", "create", "--name", "CLI reel")).json.project.id;

  const imp = await run("media", "import", id, f.portrait, f.landscape, f.wav, f.corrupt);
  assert.equal(imp.code, 0);
  assert.equal(imp.json.imported.length, 3);
  assert.equal(imp.json.failed.length, 1);
  const [portrait, landscape, wav] = imp.json.imported;

  const a = await run("clip", "add", id, "--track", "V1", "--asset", portrait.id, "--start", "0");
  assert.equal(a.code, 0, JSON.stringify(a.error));
  const b = await run("clip", "add", id, "--track", "v1", "--asset", landscape.id, "--start", "2s", "--duration", "00:01.00");
  assert.equal(b.code, 0, JSON.stringify(b.error));
  await run("clip", "add", id, "--track", "A1", "--asset", wav.id, "--start", "0");

  let tl = (await run("timeline", "get", id)).json.timeline;
  const first = tl.clips.find((c: any) => c.assetId === portrait.id);
  assert.equal(tl.durationFrames, 90);

  const split = await run("clip", "split", id, first.id, "--at", "30");
  assert.equal(split.code, 0);
  const trim = await run("clip", "trim", id, first.id, "--edge", "start", "--at", "10");
  assert.equal(trim.json.timeline.clips.find((c: any) => c.id === first.id).sourceIn, 10);

  const del = await run("clip", "delete", id, first.id, "--ripple");
  tl = del.json.timeline;
  const v1 = tl.tracks.find((x: any) => x.kind === "video").id;
  assert.deepEqual(tl.clips.filter((c: any) => c.trackId === v1).map((c: any) => c.start), [10, 40]);

  const undo = await run("timeline", "undo", id);
  assert.equal(undo.json.timeline.clips.filter((c: any) => c.trackId === v1).length, 3);

  const overlap = await run("clip", "move", id, first.id, "--start", "35");
  assert.equal(overlap.code, 2);
  assert.match(overlap.error.message, /overlap/);
  const badTrack = await run("clip", "add", id, "--track", "V9", "--asset", portrait.id, "--start", "0");
  assert.match(badTrack.error.message, /have V1, V2|unknown track/);
  const stale = await run("clip", "move", id, first.id, "--start", "200", "--base-revision", "1");
  assert.equal(stale.code, 4);
  const badTime = await run("clip", "split", id, first.id, "--at", "soon");
  assert.equal(badTime.code, 2);

  const ops = JSON.stringify([{ type: "track.update", trackId: v1, locked: true }]);
  assert.equal((await run("timeline", "apply", id, "--ops", ops)).code, 0);
  const locked = await run("clip", "move", id, first.id, "--start", "300");
  assert.match(locked.error.message, /locked/);
});

test("render and preview from the CLI, JSON job result, path rules", async (t) => {
  const run = harness(t);
  const { fixtures } = await import("../../media/test/fixtures.ts");
  const f = fixtures();
  const id = (await run("project", "create", "--name", "Render", "--width", "320", "--height", "568")).json.project.id;
  const asset = (await run("media", "import", id, f.portrait)).json.imported[0];
  await run("clip", "add", id, "--track", "V1", "--asset", asset.id, "--start", "0", "--duration", "1s");

  const { mkdtempSync, existsSync, realpathSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const outDir = realpathSync(mkdtempSync(join(tmpdir(), "reelforge-cli-out-")));
  t.after(() => rmSync(outDir, { recursive: true, force: true }));
  const out = join(outDir, "reel.mp4");

  const r = await run("render", id, "--out", out);
  assert.equal(r.code, 0, JSON.stringify(r.error ?? r.json));
  assert.equal(r.json.job.state, "completed");
  assert.equal(existsSync(out), true);

  const again = await run("render", id, "--out", out);
  assert.equal(again.code, 2, "never overwrites an existing file");
  assert.equal((await run("render", id)).code, 2, "--out is required");

  const p = await run("preview", id);
  assert.equal(p.json.job.kind, "preview");
  assert.equal(p.json.job.settings.useProxies, true);

  const jobs = await run("jobs", "list", id);
  assert.equal(jobs.json.jobs.length, 2);
  assert.equal((await run("jobs", "cancel", r.json.job.id)).code, 2);
});
