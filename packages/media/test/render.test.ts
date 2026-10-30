import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JobStore, openDatabase, ProjectStore, TimelineStore, type Database, type TimelineOp } from "@reelforge/core";
import { createRenderJob, importMedia, RenderRunner, retryRenderJob, validateExportPath } from "../src/index.ts";

const ff = (args: string[]) => execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args]);
const dir = realpathSync(mkdtempSync(join(tmpdir(), "reelforge-render-")));
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
const src = (n: string) => join(dir, n);

// Solid-colour sources make frame-exact assertions possible.
ff(["-f", "lavfi", "-i", "color=c=red:s=640x360:r=25:d=3", "-f", "lavfi", "-i", "sine=frequency=300:sample_rate=48000:duration=3", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", src("red.mp4")]);
ff(["-f", "lavfi", "-i", "color=c=blue:s=360x640:r=30:d=3", "-c:v", "libx264", "-pix_fmt", "yuv420p", src("blue.mov")]);
ff(["-f", "lavfi", "-i", "color=c=0x00ff00:s=200x200", "-frames:v", "1", src("green.png")]);
ff(["-f", "lavfi", "-i", "sine=frequency=1000:sample_rate=48000:duration=3", src("tone.wav")]);

function rgbAt(file: string, frame: number): [number, number, number] {
  const out = execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", file, "-vf", `select=eq(n\\,${frame}),scale=1:1`, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]);
  return [out[0]!, out[1]!, out[2]!];
}

function pixel(file: string, frame: number, x: number, y: number): [number, number, number] {
  const out = execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", file, "-vf", `select=eq(n\\,${frame}),format=rgb24,crop=1:1:${x}:${y}`, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]);
  return [out[0]!, out[1]!, out[2]!];
}
const near = (a: number[], b: number[], tol = 28) => a.every((v, i) => Math.abs(v - b[i]!) <= tol);

function colour(file: string, frame: number): string {
  const [r, g, b] = rgbAt(file, frame);
  if (r > 180 && g < 80 && b < 80) return "red";
  if (b > 180 && r < 80 && g < 80) return "blue";
  if (g > 180 && r < 80 && b < 80) return "green";
  if (r < 30 && g < 30 && b < 30) return "black";
  return `rgb(${r},${g},${b})`;
}

function meanVolume(file: string, from: number, dur: number): number {
  // volumedetect reports on stderr
  const out = spawnSync("ffmpeg", ["-hide_banner", "-nostats", "-ss", String(from), "-t", String(dur), "-i", file, "-af", "volumedetect", "-vn", "-f", "null", "-"]).stderr.toString();
  const m = /mean_volume: (-?[\d.]+|-inf) dB/.exec(out);
  return !m || m[1] === "-inf" ? -Infinity : Number(m[1]);
}

function probeJson(file: string) {
  return JSON.parse(execFileSync("ffprobe", ["-v", "error", "-print_format", "json", "-show_streams", "-show_format", file]).toString());
}

async function project(t: { after: (fn: () => unknown) => void }, settings: { width: number; height: number; fps?: { num: number; den: number } }) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "reelforge-render-db-")));
  const db = openDatabase(join(home, "db.sqlite"));
  const runner = new RenderRunner(db, { cacheDir: join(home, "cache") });
  t.after(() => {
    runner.stop();
    db.close();
    rmSync(home, { recursive: true, force: true });
  });
  const p = new ProjectStore(db).create({ name: "R", settings }, "cli");
  const { imported } = await importMedia(db, p.id, [src("red.mp4"), src("blue.mov"), src("green.png"), src("tone.wav")], "cli");
  const [red, blue, green, tone] = imported.map((a) => a.id);
  const timeline = new TimelineStore(db);
  const tl = timeline.get(p.id);
  const track = (name: string) => tl.tracks.find((x) => x.name === name)!.id;
  const edit = (ops: TimelineOp[]) => timeline.apply(p.id, { baseRevision: timeline.get(p.id).project.revision, operations: ops }, "cli");
  return { db, home, runner, projectId: p.id, ids: { red: red!, blue: blue!, green: green!, tone: tone! }, track, edit };
}

async function render(db: Database, runner: RenderRunner, projectId: string, kind: "export" | "preview", out?: string) {
  const job = createRenderJob(db, projectId, kind, out);
  runner.enqueue(job.id);
  const done = await runner.wait(job.id);
  assert.equal(done.state, "completed", JSON.stringify(done.error));
  return done;
}

test("frame-exact cuts, overlay timing, audio placement, hidden/muted tracks", async (t) => {
  const s = await project(t, { width: 160, height: 288 });
  s.edit([
    { type: "clip.add", trackId: s.track("Video"), assetId: s.ids.red, start: 0, duration: 30 },
    { type: "clip.add", trackId: s.track("Video"), assetId: s.ids.blue, start: 30, duration: 30, sourceIn: 15 },
    { type: "clip.add", trackId: s.track("Overlays"), assetId: s.ids.green, start: 45, duration: 15 },
    { type: "clip.add", trackId: s.track("Music"), assetId: s.ids.tone, start: 15, duration: 30 },
  ]);
  const out = join(s.home, "cut.mp4");
  const job = await render(s.db, s.runner, s.projectId, "export", out);
  assert.equal(job.outputPath, out);
  assert.deepEqual([0, 29, 30, 44, 45, 59].map((f) => colour(out, f)), ["red", "red", "blue", "blue", "green", "green"]);
  const v = probeJson(out).streams.find((x: any) => x.codec_type === "video");
  assert.equal(Number(v.nb_frames), 60);
  // The red video plays its own sound (0–1 s), like in any editor; the music clip adds a tone at 0.5–1.5 s;
  // the blue video has no audio, so after 1.5 s it is silent.
  assert.ok(meanVolume(out, 0, 0.45) > -30, "the red video's own sound is heard");
  assert.ok(meanVolume(out, 0.55, 0.9) > -30, "sound while the music clip plays");
  assert.ok(meanVolume(out, 1.55, 0.4) < -60, "silent after the music clip (blue has no audio)");

  // Hide the overlay, mute the music and the video track's sound: they must vanish from the next render.
  s.edit([
    { type: "track.update", trackId: s.track("Overlays"), hidden: true },
    { type: "track.update", trackId: s.track("Music"), muted: true },
    { type: "track.update", trackId: s.track("Video"), muted: true },
  ]);
  const out2 = join(s.home, "hidden.mp4");
  await render(s.db, s.runner, s.projectId, "export", out2);
  assert.equal(colour(out2, 50), "blue");
  assert.equal(colour(out2, 10), "red", "muting a video track keeps its picture");
  assert.ok(meanVolume(out2, 0, 0.45) < -60, "muted video track: no sound");
  assert.ok(meanVolume(out2, 0.55, 0.9) < -60);
});

test("cuts on odd frames stay exact, at 30 and at 29.97 fps", async (t) => {
  for (const fps of [{ num: 30, den: 1 }, { num: 30000, den: 1001 }]) {
    const s = await project(t, { width: 160, height: 288, fps });
    s.edit([
      { type: "clip.add", trackId: s.track("Video"), assetId: s.ids.red, start: 0, duration: 31 },
      { type: "clip.add", trackId: s.track("Video"), assetId: s.ids.blue, start: 31, duration: 33 },
      { type: "clip.add", trackId: s.track("Overlays"), assetId: s.ids.green, start: 47, duration: 7 },
    ]);
    const out = join(s.home, `odd-${fps.den}.mp4`);
    await render(s.db, s.runner, s.projectId, "export", out);
    assert.deepEqual(
      [0, 30, 31, 46, 47, 53, 54, 63].map((f) => colour(out, f)),
      ["red", "red", "blue", "blue", "green", "green", "blue", "blue"],
      `at ${fps.num}/${fps.den}`,
    );
  }
});

test("preview is the same graph as export, just smaller", async (t) => {
  const s = await project(t, { width: 1080, height: 1920 });
  s.edit([
    { type: "clip.add", trackId: s.track("Video"), assetId: s.ids.red, start: 0, duration: 20 },
    { type: "clip.add", trackId: s.track("Video"), assetId: s.ids.blue, start: 20, duration: 20 },
  ]);
  const prev = await render(s.db, s.runner, s.projectId, "preview");
  assert.deepEqual([prev.settings.width, prev.settings.height, prev.settings.useProxies], [540, 960, true]);
  assert.deepEqual([19, 20].map((f) => colour(prev.outputPath!, f)), ["red", "blue"]);
  assert.equal(s.db.prepare("SELECT count(*) AS n FROM proxies").get()!.n, 2, "video sources were proxied");
  assert.equal(new JobStore(s.db).artifacts(s.projectId).length, 0, "previews are not artifacts");
});

test("M2 exit: a 30-second project renders to MP4 H.264/AAC 1080x1920 @ 30 fps", async (t) => {
  const s = await project(t, { width: 1080, height: 1920 });
  const ops: TimelineOp[] = [];
  for (let i = 0; i < 10; i++) {
    ops.push({ type: "clip.add", trackId: s.track("Video"), assetId: i % 2 ? s.ids.blue : s.ids.red, start: i * 90, duration: 90 });
  }
  ops.push({ type: "clip.add", trackId: s.track("Music"), assetId: s.ids.tone, start: 0, duration: 90 });
  s.edit(ops);
  const out = join(s.home, "reel.mp4");
  await render(s.db, s.runner, s.projectId, "export", out);
  const info = probeJson(out);
  const v = info.streams.find((x: any) => x.codec_type === "video");
  const a = info.streams.find((x: any) => x.codec_type === "audio");
  assert.equal(info.format.format_name.includes("mp4"), true);
  assert.deepEqual([v.codec_name, v.width, v.height, v.r_frame_rate, v.pix_fmt, Number(v.nb_frames)], ["h264", 1080, 1920, "30/1", "yuv420p", 900]);
  assert.deepEqual([a.codec_name, Number(a.sample_rate), a.channels], ["aac", 48000, 2]);
  assert.deepEqual([v.color_space, v.color_primaries, v.color_transfer, v.color_range], ["bt709", "bt709", "bt709", "tv"], "tagged as what we encode");
  assert.ok(Math.abs(Number(info.format.duration) - 30) < 0.05, `duration ${info.format.duration}`);
  const head = execFileSync("sh", ["-c", `head -c 4096 "${out}" | strings | grep -c moov || true`]).toString().trim();
  assert.notEqual(head, "0", "moov atom up front (+faststart)");
  const artifacts = new JobStore(s.db).artifacts(s.projectId);
  assert.equal(artifacts[0]?.frames, 900);
});

test("cancel mid-render leaves no file; offline media fails cleanly; retry works", async (t) => {
  const s = await project(t, { width: 1080, height: 1920 });
  const ops: TimelineOp[] = [];
  for (let i = 0; i < 20; i++) ops.push({ type: "clip.add", trackId: s.track("Video"), assetId: i % 2 ? s.ids.blue : s.ids.red, start: i * 60, duration: 60 });
  s.edit(ops);
  const out = join(s.home, "cancel.mp4");
  const job = createRenderJob(s.db, s.projectId, "export", out);
  s.runner.enqueue(job.id);
  const jobs = new JobStore(s.db);
  for (let i = 0; i < 200 && jobs.get(job.id).state !== "rendering"; i++) await new Promise((r) => setTimeout(r, 25));
  // Cancel through the store, as another process (CLI / MCP) would.
  jobs.cancel(job.id);
  const done = await s.runner.wait(job.id);
  assert.equal(done.state, "cancelled");
  assert.equal(existsSync(out), false);
  assert.deepEqual(readdirSync(s.home).filter((f) => f.includes("partial")), [], "no partial file left behind");

  const retried = retryRenderJob(s.db, job.id);
  assert.equal(retried.retryOf, job.id);
  s.runner.cancel(retried.id);
  assert.equal((await s.runner.wait(retried.id)).state, "cancelled");
});

test("export path rules and interrupted-job recovery", async (t) => {
  const s = await project(t, { width: 160, height: 288 });
  s.edit([{ type: "clip.add", trackId: s.track("Video"), assetId: s.ids.red, start: 0, duration: 10 }]);
  const bad = (p: string) => assert.throws(() => validateExportPath(s.db, s.projectId, p), /export|exist|overwrite|source/i);
  bad("relative.mp4");
  bad(join(s.home, "x.mov"));
  bad(join(s.home, "no-such-dir", "x.mp4"));
  writeFileSync(join(s.home, "taken.mp4"), "x");
  bad(join(s.home, "taken.mp4"));
  bad(src("red.mp4"));
  // A dangling symlink is refused up front, not after the whole render.
  symlinkSync(join(s.home, "nowhere.mp4"), join(s.home, "dangling.mp4"));
  bad(join(s.home, "dangling.mp4"));

  const jobs = new JobStore(s.db);
  const job = createRenderJob(s.db, s.projectId, "preview");
  s.db.prepare("UPDATE render_jobs SET state = 'rendering', runner_pid = 999999 WHERE id = ?").run(job.id);
  const recovered = jobs.recoverInterrupted();
  assert.equal(recovered[0]?.error?.code, "INTERRUPTED");
});

test("offline source fails the job with MEDIA_OFFLINE", async (t) => {
  const s = await project(t, { width: 160, height: 288 });
  const copy = join(s.home, "temp-red.mp4");
  execFileSync("cp", [src("red.mp4"), copy]);
  const { imported } = await importMedia(s.db, s.projectId, [copy], "cli");
  s.edit([{ type: "clip.add", trackId: s.track("Video"), assetId: imported[0]!.id, start: 0, duration: 10 }]);
  const job = createRenderJob(s.db, s.projectId, "export", join(s.home, "offline.mp4"));
  rmSync(copy); // disappears after the job was queued
  s.runner.enqueue(job.id);
  const done = await s.runner.wait(job.id);
  assert.equal(done.state, "failed");
  assert.equal(done.error?.code, "MEDIA_OFFLINE");
});

test("transform: contain letterboxes, scale + position move the layer, rotation turns it", async (t) => {
  const s = await project(t, { width: 160, height: 288 });
  const clip = "00000000-0000-4000-8000-0000000000e1";
  s.edit([
    { type: "clip.add", trackId: s.track("Video"), assetId: s.ids.blue, start: 0, duration: 4 },
    { type: "clip.add", clipId: clip, trackId: s.track("Overlays"), assetId: s.ids.red, start: 1, duration: 1, props: { fit: "contain" } },
    // frame 2: half size, pushed right by a quarter of the width
    { type: "clip.add", trackId: s.track("Overlays"), assetId: s.ids.red, start: 2, duration: 1, props: { scale: 0.5, x: 0.25 } },
    // frame 3: landscape red, contained, rotated 90° → a tall bar
    { type: "clip.add", trackId: s.track("Overlays"), assetId: s.ids.red, start: 3, duration: 1, props: { fit: "contain", rotation: 90 } },
  ]);
  const out = join(s.home, "transform.mp4");
  await render(s.db, s.runner, s.projectId, "export", out);
  // contain: 640x360 into 160x288 → 160x90 band in the middle, blue above and below
  assert.ok(near(pixel(out, 1, 80, 144), [255, 0, 0]), "centre is red");
  assert.ok(near(pixel(out, 1, 80, 20), [0, 0, 255]), "letterbox shows the layer below");
  // scale 0.5 → 80x144 layer centred at x = 80 + 40 = 120
  assert.ok(near(pixel(out, 2, 120, 144), [255, 0, 0]));
  assert.ok(near(pixel(out, 2, 40, 144), [0, 0, 255]), "left half uncovered");
  assert.ok(near(pixel(out, 2, 120, 30), [0, 0, 255]), "top uncovered");
  // rotated 90°: the 160x90 band becomes 90x160, so the top of the band area is red, the sides blue
  assert.ok(near(pixel(out, 3, 80, 80), [255, 0, 0]), "rotated layer reaches up");
  assert.ok(near(pixel(out, 3, 10, 144), [0, 0, 255]), "and is narrow");
});

test("opacity, fade-in and dissolve blend exactly as pictureAlpha says", async (t) => {
  const s = await project(t, { width: 160, height: 288 });
  s.edit([
    // V1: red 0–30, blue 30–60 with a 10-frame dissolve (handles: red has 3s, blue starts at source 15)
    { type: "clip.add", trackId: s.track("Video"), assetId: s.ids.red, start: 0, duration: 30 },
    { type: "clip.add", trackId: s.track("Video"), assetId: s.ids.blue, start: 30, duration: 30, sourceIn: 15, props: { transitionIn: 10 } },
    // V2: green at 50% from 60–70 over black, then green with a 10-frame fade-in 70–90 over black
    { type: "clip.add", trackId: s.track("Overlays"), assetId: s.ids.green, start: 60, duration: 10, props: { opacity: 0.5 } },
    { type: "clip.add", trackId: s.track("Overlays"), assetId: s.ids.green, start: 70, duration: 20, props: { fadeIn: 10 } },
  ]);
  const out = join(s.home, "blend.mp4");
  await render(s.db, s.runner, s.projectId, "export", out);
  assert.ok(near(rgbAt(out, 24), [255, 0, 0]), "before the dissolve window");
  assert.ok(near(rgbAt(out, 30), [128, 0, 128], 30), `mid-dissolve is half red, half blue: ${rgbAt(out, 30)}`);
  assert.ok(near(rgbAt(out, 36), [0, 0, 255]), "after the dissolve window");
  assert.ok(near(rgbAt(out, 64), [0, 128, 0], 30), `50% green over black: ${rgbAt(out, 64)}`);
  assert.ok(near(rgbAt(out, 75), [0, 128, 0], 30), `half way through the fade-in: ${rgbAt(out, 75)}`);
  assert.ok(near(rgbAt(out, 85), [0, 255, 0]));
});

test("audio gain and fades", async (t) => {
  const s = await project(t, { width: 160, height: 288 });
  s.edit([
    { type: "clip.add", trackId: s.track("Video"), assetId: s.ids.blue, start: 0, duration: 90 },
    { type: "clip.add", trackId: s.track("Music"), assetId: s.ids.tone, start: 0, duration: 30 },
    { type: "clip.add", trackId: s.track("Voice"), assetId: s.ids.tone, start: 30, duration: 30, props: { gainDb: -12 } },
    { type: "clip.add", trackId: s.track("Music"), assetId: s.ids.tone, start: 60, duration: 30, props: { fadeIn: 30 } },
  ]);
  const out = join(s.home, "gain.mp4");
  await render(s.db, s.runner, s.projectId, "export", out);
  const ref = meanVolume(out, 0.1, 0.8);
  const quiet = meanVolume(out, 1.1, 0.8);
  assert.ok(Math.abs(ref - quiet - 12) < 1.5, `-12 dB gain: ${ref} vs ${quiet}`);
  assert.ok(meanVolume(out, 2.0, 0.15) < ref - 10, "start of the fade-in is much quieter");
  assert.ok(Math.abs(meanVolume(out, 2.85, 0.1) - ref) < 3, "end of the fade-in is at full level");
});

test("burned-in captions: word highlight moves on the right frame, track style applies", async (t) => {
  const s = await project(t, { width: 540, height: 960 });
  const cc = new TimelineStore(s.db).get(s.projectId).tracks.find((x) => x.kind === "caption")!.id;
  s.edit([
    { type: "clip.add", trackId: s.track("Video"), assetId: s.ids.blue, start: 0, duration: 60 },
    // two five-letter words, so the split between them sits on the frame centre
    { type: "caption.add", trackId: cc, start: 10, duration: 40, text: "Every story", words: [{ text: "Every", start: 0, end: 15 }, { text: "story", start: 15, end: 40 }] },
    { type: "track.update", trackId: cc, captionStyle: { y: 0.5, highlight: "#00ff00", color: "#ffffff", shadow: false } },
  ]);
  const out = join(s.home, "captions.mp4");
  await render(s.db, s.runner, s.projectId, "export", out);
  // Count highlight-green and white pixels in the left / right half of the caption row.
  const row = (frame: number) => {
    const buf = execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", out, "-vf", `select=eq(n\\,${frame}),format=rgb24,crop=540:120:0:420`, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]);
    const count = { lg: 0, rg: 0, lw: 0, rw: 0 };
    for (let i = 0; i < buf.length; i += 3) {
      const x = (i / 3) % 540;
      const [r, g, b] = [buf[i]!, buf[i + 1]!, buf[i + 2]!];
      const green = g > 200 && r < 90 && b < 90;
      const white = r > 220 && g > 220 && b > 220;
      if (green) x < 270 ? count.lg++ : count.rg++;
      if (white) x < 270 ? count.lw++ : count.rw++;
    }
    return count;
  };
  const none = row(5);
  assert.equal(none.lg + none.rg + none.lw + none.rw, 0, "nothing before the caption starts");
  const first = row(12);
  assert.ok(first.lg > 200 && first.rw > 200 && first.rg < 20, `"EVERY" lit, "STORY" white: ${JSON.stringify(first)}`);
  const second = row(30);
  assert.ok(second.rg > 200 && second.lw > 200 && second.lg < 20, `"STORY" lit, "EVERY" white: ${JSON.stringify(second)}`);
  // exactly at the word boundary (caption start 10 + word start 15 = frame 25)
  assert.ok(row(24).lg > 200 && row(25).rg > 200 && row(25).lg < 20, "highlight switches on frame 25, not before or after");
  const gone = row(55);
  assert.equal(gone.lg + gone.rg + gone.lw + gone.rw, 0, "gone after the caption ends");
  assert.equal(readdirSync(join(s.home, "cache", "work")).length, 0, "caption frames cleaned up");
});

test("the partial render file has an unguessable name and is created exclusively", async (t) => {
  const s = await project(t, { width: 160, height: 288 });
  s.edit([{ type: "clip.add", trackId: s.track("Video"), assetId: s.ids.red, start: 0, duration: 10 }]);
  const out = join(s.home, "named.mp4");
  const job = createRenderJob(s.db, s.projectId, "export", out);
  // The old name was predictable from the job id: something planted there must not be followed or truncated.
  const victim = join(s.home, "victim.txt");
  writeFileSync(victim, "keep me");
  symlinkSync(victim, join(s.home, `.named.partial-${job.id}.mp4`));
  s.runner.enqueue(job.id);
  const done = await s.runner.wait(job.id);
  assert.equal(done.state, "completed", JSON.stringify(done.error));
  assert.equal(readFileSync(victim, "utf8"), "keep me");
  assert.ok(existsSync(out));
});

