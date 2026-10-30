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

test("clip set / --props: look and sound from the CLI, validated", async (t) => {
  const run = harness(t);
  const { fixtures } = await import("../../media/test/fixtures.ts");
  const f = fixtures();
  const id = (await run("project", "create", "--name", "Props")).json.project.id;
  const asset = (await run("media", "import", id, f.portrait)).json.imported[0];
  const added = await run("clip", "add", id, "--track", "V1", "--asset", asset.id, "--start", "0", "--props", '{"fit":"contain"}');
  assert.equal(added.code, 0, JSON.stringify(added.error));
  const clip = added.json.timeline.clips[0];
  assert.deepEqual(clip.props, { fit: "contain" });
  const set = await run("clip", "set", id, clip.id, "--props", '{"opacity":0.5,"fadeIn":10}');
  assert.deepEqual(set.json.timeline.clips[0].props, { fit: "contain", opacity: 0.5, fadeIn: 10 });
  assert.equal((await run("clip", "set", id, clip.id, "--props", '{"opacity":3}')).code, 2);
  assert.equal((await run("clip", "set", id, clip.id, "--props", "nope")).code, 2);
});

test("M3 from the CLI: beats, auto-transcribed captions, SRT, project context", { timeout: 300_000 }, async (t) => {
  const { spawnSync, execFileSync } = await import("node:child_process");
  const { existsSync, mkdtempSync, realpathSync, readFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { whisperModelPath } = await import("../../media/src/index.ts");
  if (spawnSync("whisper-cli", ["--help"]).status !== 0 || !existsSync(whisperModelPath()) || spawnSync("which", ["say"]).status !== 0) {
    return t.skip("needs whisper-cli, the large-v3-turbo model and macOS `say`");
  }
  const run = harness(t);
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "reelforge-m3-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  execFileSync("say", ["-o", join(dir, "vo.aiff"), "Every cup tells a story. Crafted with passion."]);
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", join(dir, "vo.aiff"), join(dir, "vo.wav")]);
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "aevalsrc='0.8*sin(2*PI*1000*t)*lt(mod(t\\,0.5)\\,0.012)':s=44100:d=8", join(dir, "beat.wav")]);

  const id = (await run("project", "create", "--name", "M3")).json.project.id;
  const [vo, beat] = (await run("media", "import", id, join(dir, "vo.wav"), join(dir, "beat.wav"))).json.imported;
  await run("clip", "add", id, "--track", "A2", "--asset", vo.id, "--start", "0");
  await run("clip", "add", id, "--track", "A1", "--asset", beat.id, "--start", "0");

  const beats = await run("media", "analyze", id, beat.id, "--kinds", "beats");
  assert.equal(beats.code, 0, JSON.stringify(beats.error));
  assert.ok(Math.abs(beats.json.analyses[0].result.bpm - 120) < 2);

  // captions from the voice track only (the metronome on A1 is music, not speech)
  const caps = await run("captions", "generate", id, "--source", "A2", "--max-words", "3");
  assert.equal(caps.code, 0, JSON.stringify(caps.error));
  assert.ok(caps.json.count >= 2);
  assert.match(caps.json.captions.map((c: any) => c.text).join(" ").toLowerCase(), /every cup tells a story/);
  assert.ok(caps.json.captions.every((c: any) => c.words.length > 0), "word timings for highlighting");

  const srtPath = join(dir, "out.srt");
  const srt = await run("captions", "srt", id, "--out", srtPath);
  assert.equal(srt.code, 0);
  assert.match(readFileSync(srtPath, "utf8"), /^1\n00:00:0\d,\d{3} --> /);
  assert.equal((await run("captions", "srt", id, "--out", srtPath)).code, 2, "never overwrites");

  const ctx = (await run("project", "context", id)).json.context;
  assert.equal(ctx.schema, "reelforge.project-context/1");
  const voCtx = ctx.assets.find((a: any) => a.id === vo.id);
  assert.equal(voCtx.analysis.transcript.language, "en");
  assert.ok(voCtx.analysis.transcript.segments.length >= 1);
  assert.ok(ctx.assets.find((a: any) => a.id === beat.id).analysis.beats.beatsSeconds.length > 10);
  assert.ok(ctx.timeline.captions.length >= 2);
  assert.ok(ctx.operations.includes("captions.replace"));
});

test("serve takes API keys over stdin into memory, and never reports them", async (t) => {
  const { spawn } = await import("node:child_process");
  const { once } = await import("node:events");
  const home = mkdtempSync(join(tmpdir(), "reelforge-cred-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const env: NodeJS.ProcessEnv = { ...process.env, REELFORGE_HOME: home };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  delete env.ANTHROPIC_PROFILE;
  const child = spawn(process.execPath, [new URL("../bin/reelforge.js", import.meta.url).pathname, "serve"], { env, stdio: ["pipe", "pipe", "inherit"] });
  t.after(() => child.kill());
  const [chunk] = (await once(child.stdout!, "data")) as [Buffer];
  const ready = JSON.parse(chunk.toString().split("\n")[0]!);
  const get = async () => (await (await fetch(`${ready.url}/v1/ai/providers`, { headers: { authorization: `Bearer ${ready.token}` } })).text());
  assert.match(await get(), /"credential":"none"/);
  child.stdin!.write(JSON.stringify({ type: "credential", provider: "anthropic", apiKey: "sk-ant-test-123456" }) + "\n");
  await new Promise((r) => setTimeout(r, 150));
  const after = await get();
  assert.match(after, /"credential":"keychain"/);
  assert.equal(after.includes("sk-ant-test"), false, "the key itself never leaves the engine");
});

test("ai from the CLI: propose (local), apply needs --yes, consent flags", async (t) => {
  const { createServer } = await import("node:http");
  let clipId = "";
  const fake = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.url === "/api/tags") return res.end(JSON.stringify({ models: [{ name: "fake:1b" }] }));
      const content = JSON.stringify({ summary: "Fade in", warnings: [], operations: [{ type: "clip.update", why: "softer start", clipId, props: { fadeIn: 10 } }] });
      res.end(JSON.stringify({ model: "fake:1b", message: { content } }));
    });
  });
  await new Promise<void>((r) => fake.listen(0, "127.0.0.1", () => r()));
  const prev = process.env.REELFORGE_OLLAMA_URL;
  process.env.REELFORGE_OLLAMA_URL = `http://127.0.0.1:${(fake.address() as any).port}`;
  t.after(() => {
    fake.close();
    if (prev === undefined) delete process.env.REELFORGE_OLLAMA_URL;
    else process.env.REELFORGE_OLLAMA_URL = prev;
  });

  const run = harness(t);
  const { fixtures } = await import("../../media/test/fixtures.ts");
  const id = (await run("project", "create", "--name", "AI CLI")).json.project.id;
  const asset = (await run("media", "import", id, fixtures().portrait)).json.imported[0];
  clipId = (await run("clip", "add", id, "--track", "V1", "--asset", asset.id, "--start", "0")).json.timeline.clips[0].id;

  const p = await run("ai", "propose", id, "fade", "in", "the", "clip", "--provider", "ollama");
  assert.equal(p.code, 0, JSON.stringify(p.error));
  assert.equal(p.json.proposal.status, "pending");
  assert.match(p.json.next, /--yes/);
  const noYes = await run("ai", "apply", p.json.proposal.id);
  assert.equal(noYes.code, 2);
  assert.match(noYes.error.message, /approval/);
  const yes = await run("ai", "apply", p.json.proposal.id, "--yes");
  assert.equal(yes.code, 0);
  assert.deepEqual(yes.json.timeline.clips[0].props, { fadeIn: 10 });
  assert.equal(yes.json.proposal.approval.channel, "cli:--yes");

  const blocked = await run("ai", "propose", id, "anything", "--provider", "anthropic");
  assert.equal(blocked.code, 7, "CONSENT_REQUIRED");
  assert.equal((await run("ai", "consent", id)).code, 2, "needs --grant or --revoke");
  assert.ok((await run("ai", "consent", id, "--grant")).json.consent.grantedAt);
});
