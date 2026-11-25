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

test("project delete needs --yes, then removes the project", async (t) => {
  const run = harness(t);
  const id = (await run("project", "create", "--name", "Gone")).json.project.id;
  const unconfirmed = await run("project", "delete", id);
  assert.equal(unconfirmed.code, 2);
  assert.match(unconfirmed.error.message, /--yes/);
  assert.equal((await run("project", "list")).json.projects.length, 1, "nothing deleted without --yes");
  const d = await run("project", "delete", id, "--yes");
  assert.equal(d.code, 0);
  assert.equal(d.json.deleted.name, "Gone");
  assert.equal((await run("project", "list")).json.projects.length, 0);
  assert.equal((await run("project", "delete", id, "--yes")).code, 3);
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
  // A dissolve from the first frame of the source has no handle to dissolve from: the render says it's a cut.
  await run("clip", "add", id, "--track", "V1", "--asset", asset.id, "--start", "1s", "--duration", "10", "--props", '{"transitionIn":6}');

  const { mkdtempSync, existsSync, realpathSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const outDir = realpathSync(mkdtempSync(join(tmpdir(), "reelforge-cli-out-")));
  t.after(() => rmSync(outDir, { recursive: true, force: true }));
  const out = join(outDir, "reel.mp4");

  const r = await run("render", id, "--out", out);
  assert.equal(r.code, 0, JSON.stringify(r.error ?? r.json));
  assert.equal(r.json.job.state, "completed");
  assert.equal(existsSync(out), true);
  assert.match(r.json.warnings.join(" "), /transition into portrait\.mp4 won't play/);

  const again = await run("render", id, "--out", out);
  assert.equal(again.code, 2, "never overwrites an existing file");
  assert.equal((await run("render", id)).code, 2, "--out is required");

  const p = await run("preview", id);
  assert.equal(p.json.job.kind, "preview");
  assert.equal(p.json.job.settings.useProxies, true);
  const same = await run("preview", id);
  assert.equal(same.json.job.id, p.json.job.id, "same revision: the finished preview is reused, like the API");

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

test("serve --token-stdin: the token arrives on stdin and no child process ever sees it", async (t) => {
  const { spawn } = await import("node:child_process");
  const { once } = await import("node:events");
  const { writeFileSync, chmodSync, readFileSync, existsSync } = await import("node:fs");
  const home = mkdtempSync(join(tmpdir(), "reelforge-token-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  // ffprobe stub: records the environment it was started with.
  const stub = join(home, "ffprobe-stub");
  writeFileSync(stub, `#!/bin/sh\nenv > "${home}/child-env-$$"\nexit 1\n`);
  chmodSync(stub, 0o755);
  writeFileSync(join(home, "clip.mp4"), "x");

  for (const mode of ["stdin", "env"] as const) {
    const token = `${mode}-token-${"x".repeat(40)}`;
    const env: NodeJS.ProcessEnv = { ...process.env, REELFORGE_HOME: join(home, mode), REELFORGE_FFPROBE: stub };
    if (mode === "env") env.REELFORGE_API_TOKEN = token;
    const args = [new URL("../bin/reelforge.js", import.meta.url).pathname, "serve", ...(mode === "stdin" ? ["--token-stdin"] : [])];
    const child = spawn(process.execPath, args, { env, stdio: ["pipe", "pipe", "inherit"] });
    t.after(() => child.kill());
    if (mode === "stdin") child.stdin!.write(JSON.stringify({ type: "token", token }) + "\n");
    const [chunk] = (await once(child.stdout!, "data")) as [Buffer];
    const ready = JSON.parse(chunk.toString().split("\n")[0]!);
    assert.equal(ready.token, undefined, "a provided token is never echoed");
    const auth = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    const project = ((await (await fetch(`${ready.url}/v1/projects`, { method: "POST", headers: auth, body: JSON.stringify({ name: "T" }) })).json()) as { project?: { id: string } }).project;
    assert.ok(project?.id, `${mode}: the token authenticates`);
    // The phone says how the engine runs: the editor's child (--token-stdin) or one started by hand.
    const engine = ((await (await fetch(`${ready.url}/v1/engine`, { headers: auth })).json()) as { engine: { mode: string; background: boolean } }).engine;
    assert.deepEqual([engine.mode, engine.background], [mode === "stdin" ? "editor" : "standalone", false]);
    await fetch(`${ready.url}/v1/projects/${project.id}/assets`, { method: "POST", headers: auth, body: JSON.stringify({ paths: [join(home, "clip.mp4")] }) });
    const dumps = (await import("node:fs")).readdirSync(home).filter((f) => f.startsWith("child-env-"));
    assert.ok(dumps.length > 0, `${mode}: ffprobe ran`);
    for (const f of dumps) {
      const childEnv = readFileSync(join(home, f), "utf8");
      assert.ok(!childEnv.includes("REELFORGE_API_TOKEN") && !childEnv.includes(token), `${mode}: child inherited the token`);
      rmSync(join(home, f));
    }
    child.kill();
    assert.ok(existsSync(join(home, mode)));
  }
});

test("serve --token-stdin exits if stdin closes before the token", async () => {
  const { spawnSync } = await import("node:child_process");
  const home = mkdtempSync(join(tmpdir(), "reelforge-token-eof-"));
  const r = spawnSync(process.execPath, [new URL("../bin/reelforge.js", import.meta.url).pathname, "serve", "--token-stdin"], { env: { ...process.env, REELFORGE_HOME: home }, input: "", timeout: 10_000 });
  rmSync(home, { recursive: true, force: true });
  assert.equal(r.status, 1);
  assert.equal(r.stdout.toString(), "", "never became ready");
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

test("media import: folders (subfolders too), and a non-zero exit when nothing imports", async (t) => {
  const run = harness(t);
  const { fixtures } = await import("../../media/test/fixtures.ts");
  const { copyFileSync, mkdirSync, writeFileSync } = await import("node:fs");
  const f = fixtures();
  const id = (await run("project", "create", "--name", "Import")).json.project.id;
  const dir = mkdtempSync(join(tmpdir(), "reelforge-cli-folder-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "day 1", "cam a"), { recursive: true });
  copyFileSync(f.portrait, join(dir, "day 1", "cam a", "take.mp4"));
  copyFileSync(f.wav, join(dir, "vo.wav"));
  writeFileSync(join(dir, "notes.txt"), "x");

  const folder = await run("media", "import", id, dir);
  assert.equal(folder.code, 0, JSON.stringify(folder.error));
  assert.deepEqual(folder.json.imported.map((a: any) => a.filename).sort(), ["take.mp4", "vo.wav"]);
  assert.equal(folder.json.skipped, 1);

  const allBad = await run("media", "import", id, f.corrupt, f.avi);
  assert.equal(allBad.code, 2, "nothing imported is a failure");
  assert.equal(allBad.json.failed.length, 2, "the reasons are still printed");
  assert.equal((await run("media", "import", id, join(dir, "nope.mp4"))).code, 3);
  assert.equal((await run("media", "import", id, f.portrait, f.corrupt)).code, 0, "some imported (or already there) is success");

  const empty = mkdtempSync(join(tmpdir(), "reelforge-cli-empty-"));
  t.after(() => rmSync(empty, { recursive: true, force: true }));
  const none = await run("media", "import", id, empty);
  assert.equal(none.code, 2);
  assert.match(none.error.message, /no media files there/);
});

test("flag validation: --ops-file, --max-words, --language, --recipient; help lists every exit code", async (t) => {
  const run = harness(t);
  const id = (await run("project", "create", "--name", "Flags")).json.project.id;
  const ops = await run("timeline", "apply", id, "--ops-file", "/nonexistent/ops.json");
  assert.equal(ops.code, 3);
  assert.equal(ops.error.code, "NOT_FOUND");
  assert.match(ops.error.message, /ops file not found/);
  assert.equal((await run("timeline", "apply", id, "--ops-file", tmpdir())).code, 2);

  const words = await run("captions", "generate", id, "--max-words", "0");
  assert.equal(words.code, 2);
  assert.match(words.error.message, /--max-words must be between 1 and 12/);
  const lang = await run("captions", "generate", id, "--language", "english");
  assert.equal(lang.code, 2);
  assert.match(lang.error.message, /invalid language "english"/);

  const { fixtures } = await import("../../media/test/fixtures.ts");
  const asset = (await run("media", "import", id, fixtures().wav)).json.imported[0];
  const analyze = await run("media", "analyze", id, asset.id, "--kinds", "beats", "--language", "xx-yy");
  assert.equal(analyze.code, 2, "a bad language is invalid input, not an internal error");
  // Default kinds are the ones that apply: a silent video only gets scene detection.
  const silent = (await run("media", "import", id, fixtures().silent)).json.imported[0];
  const scenes = await run("media", "analyze", id, silent.id);
  assert.equal(scenes.code, 0, JSON.stringify(scenes.error));
  assert.deepEqual(scenes.json.analyses.map((a: any) => [a.kind, a.state]), [["scenes", "completed"]]);

  const consent = await run("ai", "consent", id, "--grant", "--recipient", "openai");
  assert.deepEqual(consent.json.consent.recipients, ["openai"]);
  assert.deepEqual((await run("ai", "consent", id, "--grant", "--recipient", "claude-code")).json.consent.recipients, ["openai", "anthropic"], "a provider id stands for its recipient");
  assert.equal((await run("ai", "consent", id, "--grant", "--recipient", "skynet")).code, 2);
  assert.deepEqual((await run("ai", "consent", id, "--revoke", "--recipient", "openai")).json.consent.recipients, ["anthropic"]);
  assert.deepEqual((await run("ai", "consent", id, "--grant")).json.consent.recipients, ["anthropic", "*"], "no --recipient: everyone, as before");

  let help = "";
  await main(["--help"], { out: (s) => (help += s), err: () => {}, isTTY: false, env: {} });
  for (const c of ["5 unauthorized", "7 AI consent required", "8 busy"]) assert.ok(help.includes(c), c);
  assert.match(help, /--provider anthropic\|claude-code\|codex\|ollama/);
});

test("ai providers lists every provider ai propose accepts", async (t) => {
  const run = harness(t);
  const prev = process.env.REELFORGE_OLLAMA_URL;
  process.env.REELFORGE_OLLAMA_URL = "http://127.0.0.1:9"; // nothing there: Ollama unavailable, quickly
  t.after(() => (prev === undefined ? delete process.env.REELFORGE_OLLAMA_URL : (process.env.REELFORGE_OLLAMA_URL = prev)));
  const r = await run("ai", "providers");
  assert.equal(r.code, 0, JSON.stringify(r.error));
  assert.deepEqual(r.json.providers.map((p: any) => p.id), ["anthropic", "claude-code", "codex", "ollama"]);
  assert.deepEqual(r.json.providers.map((p: any) => p.recipient), ["anthropic", "anthropic", "openai", "ollama"]);
});

test("piped into head, the CLI exits quietly instead of an EPIPE stack", async (t) => {
  const { spawnSync } = await import("node:child_process");
  const home = mkdtempSync(join(tmpdir(), "reelforge-epipe-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  // More JSON than a pipe buffers, so the writer is still writing when head goes away.
  for (let i = 0; i < 400; i++) await main(["project", "create", "--name", `Project number ${i}`], { out: () => {}, err: () => {}, isTTY: false, env: { REELFORGE_HOME: home } });
  const bin = new URL("../bin/reelforge.js", import.meta.url).pathname;
  const r = spawnSync("/bin/bash", ["-c", `set -o pipefail; "${process.execPath}" "${bin}" --home "${home}" project list | head -c 1 >/dev/null; echo "exit=$?"`], { encoding: "utf8" });
  assert.equal(r.stdout.trim(), "exit=0");
  assert.doesNotMatch(r.stderr, /EPIPE|Error/);
});
