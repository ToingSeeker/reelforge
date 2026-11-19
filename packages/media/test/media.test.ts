import { test } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { AssetStore, openDatabase, ProjectStore, ReelForgeError, TimelineStore } from "@reelforge/core";
import { ensureFilmstrip, ensureThumbnail, importMedia, probeFile, relinkMedia, resolveSource, sourceInputArgs, sourceStill, STILL_SUPERSEDED } from "../src/index.ts";
import { fixtures } from "./fixtures.ts";

const f = fixtures();
const probe = (p: string) => probeFile(resolveSource(p));

async function code(p: Promise<unknown> | (() => unknown)) {
  try {
    await (typeof p === "function" ? p() : p);
  } catch (e) {
    if (e instanceof ReelForgeError) return e.code;
    throw e;
  }
  return "OK";
}

test("probe: portrait mp4, 25fps mov, silent video, audio-only mp4", async () => {
  const a = await probe(f.portrait);
  assert.deepEqual([a.kind, a.width, a.height, a.fps, a.hasVideo, a.hasAudio, a.videoCodec, a.audioCodec, a.channels],
    ["video", 216, 384, { num: 30, den: 1 }, true, true, "h264", "aac", 2]);
  assert.ok(Math.abs(a.durationUs! - 2_000_000) < 60_000);

  const b = await probe(f.landscape);
  assert.deepEqual([b.kind, b.width, b.height, b.fps], ["video", 320, 180, { num: 25, den: 1 }]);

  const c = await probe(f.silent);
  assert.deepEqual([c.hasVideo, c.hasAudio, c.audioCodec], [true, false, null]);

  const d = await probe(f.audioOnlyMp4);
  assert.deepEqual([d.kind, d.hasVideo, d.width], ["audio", false, null]);
});

test("probe: display rotation swaps the effective dimensions", async (t) => {
  if (!f.rotated) return t.skip("this FFmpeg build cannot write a display-rotation fixture");
  const r = await probe(f.rotated);
  assert.equal(r.rotation === 90 || r.rotation === 270, true);
  assert.deepEqual([r.width, r.height], [180, 320]);
});

test("probe: stills and audio", async () => {
  const png = await probe(f.png);
  assert.deepEqual([png.kind, png.durationUs, png.width, png.hasAudio], ["image", null, 300, false]);
  assert.equal((await probe(f.jpg)).kind, "image");
  const wav = await probe(f.wav);
  assert.deepEqual([wav.kind, wav.channels, wav.sampleRate, wav.hasVideo], ["audio", 1, 48000, false]);
  assert.equal((await probe(f.mp3)).audioCodec, "mp3");
});

test("refused before FFmpeg: relative, missing, directory, unsupported extension", async () => {
  assert.equal(await code(() => resolveSource("relative/clip.mp4")), "VALIDATION_ERROR");
  assert.equal(await code(() => resolveSource(join(f.dir, "nope.mp4"))), "NOT_FOUND");
  assert.equal(await code(() => resolveSource(f.dir)), "VALIDATION_ERROR");
  assert.equal(await code(() => resolveSource(f.avi)), "VALIDATION_ERROR");
  assert.equal(await code(() => resolveSource("/tmp/x\0.mp4")), "VALIDATION_ERROR");
});

test("corrupt files give an actionable error, not a crash", async () => {
  await assert.rejects(probe(f.corrupt), (e: unknown) => e instanceof ReelForgeError && e.code === "VALIDATION_ERROR" && /could not read media/.test(e.message));
});

test("hostile file names are data, never shell", async () => {
  const r = await probe(f.hostileName);
  assert.equal(r.kind, "video");
  assert.equal(existsSync(join(f.dir, "PWNED")) || existsSync("PWNED") || existsSync("PWNED2"), false);
});

test("symlinks resolve to the real file", () => {
  assert.equal(resolveSource(f.symlink).path, f.portrait);
});

test("missing FFmpeg is UNAVAILABLE with install advice", async () => {
  const prev = process.env.REELFORGE_FFPROBE;
  process.env.REELFORGE_FFPROBE = "/nonexistent/ffprobe";
  try {
    await assert.rejects(probe(f.portrait), (e: unknown) => e instanceof ReelForgeError && e.code === "UNAVAILABLE" && /brew install ffmpeg/.test(e.message));
  } finally {
    if (prev === undefined) delete process.env.REELFORGE_FFPROBE;
    else process.env.REELFORGE_FFPROBE = prev;
  }
});

test("importMedia: batch with failures, then edit with the imported assets", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "reelforge-import-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const db = openDatabase(join(home, "db.sqlite"));
  const project = new ProjectStore(db).create({ name: "Cafe" }, "cli");

  const r = await importMedia(db, project.id, [f.portrait, f.wav, f.png, f.corrupt, f.avi, f.symlink], "cli");
  assert.deepEqual(r.imported.map((a) => a.kind), ["video", "audio", "image"]);
  assert.deepEqual(r.existing.map((a) => a.filename), ["portrait.mp4"], "symlink to an imported file is the same asset");
  assert.deepEqual(r.failed.map((x) => x.error.code), ["VALIDATION_ERROR", "VALIDATION_ERROR"]);
  assert.equal(r.imported[0]!.durationFrames! >= 59 && r.imported[0]!.durationFrames! <= 60, true);

  const timeline = new TimelineStore(db);
  const tl = timeline.get(project.id);
  const video = tl.tracks.find((x) => x.kind === "video")!;
  const music = tl.tracks.find((x) => x.name === "Music")!;
  const next = timeline.apply(project.id, {
    baseRevision: tl.project.revision,
    operations: [
      { type: "clip.add", trackId: video.id, assetId: r.imported[0]!.id, start: 0 },
      { type: "clip.add", trackId: video.id, assetId: r.imported[2]!.id, start: 60 },
      { type: "clip.add", trackId: music.id, assetId: r.imported[1]!.id, start: 0 },
    ],
  }, "cli");
  assert.equal(next.clips.length, 3);
  assert.equal(next.durationFrames, 150);
});

test("thumbnails are cached JPEG/PNG under the cache dir, never beside the source", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "reelforge-thumb-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const db = openDatabase(join(home, "db.sqlite"));
  const project = new ProjectStore(db).create({ name: "T" }, "cli");
  const { imported } = await importMedia(db, project.id, [f.landscape, f.mp3, f.jpg], "cli");
  const cache = join(home, "cache");
  const [video, audio, image] = await Promise.all(imported.map((a) => ensureThumbnail(cache, a)));
  assert.deepEqual([...readFileSync(video!.path).subarray(0, 3)], [0xff, 0xd8, 0xff]);
  assert.deepEqual([...readFileSync(audio!.path).subarray(1, 4)].map((b) => String.fromCharCode(b)).join(""), "PNG");
  assert.equal(image!.contentType, "image/jpeg");
  assert.ok(video!.path.startsWith(cache));
  const again = await ensureThumbnail(cache, imported[0]!);
  assert.equal(again.path, video!.path);
});

test("relink a moved file", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "reelforge-relink-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const db = openDatabase(join(home, "db.sqlite"));
  const project = new ProjectStore(db).create({ name: "R" }, "cli");
  const src = join(home, "clip.mp4");
  copyFileSync(f.portrait, src);
  const { imported } = await importMedia(db, project.id, [src], "cli");
  const moved = join(home, "moved.mp4");
  renameSync(src, moved);
  const store = new AssetStore(db);
  assert.equal(store.get(project.id, imported[0]!.id).status, "missing");
  // same 2s duration, different footage: refused
  await assert.rejects(relinkMedia(db, project.id, imported[0]!.id, f.landscape, "cli"), (e: unknown) =>
    e instanceof ReelForgeError && /frame size/.test(e.message) && /frame rate/.test(e.message));
  const back = await relinkMedia(db, project.id, imported[0]!.id, moved, "cli");
  assert.equal(back.status, "online");
});

test("a playlist disguised as .mp4 is refused, not demuxed (no SSRF / local file reads)", async (t) => {
  const { writeFileSync } = await import("node:fs");
  const evil = join(f.dir, "disguised-playlist.mp4");
  writeFileSync(evil, `#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:2.0,\nfile:${f.portrait}\n#EXTINF:2.0,\nhttp://127.0.0.1:9/x.ts\n#EXT-X-ENDLIST\n`);
  await assert.rejects(probe(evil), (e: unknown) => e instanceof ReelForgeError && e.code === "VALIDATION_ERROR");
  // ffconcat is auto-detected even by FFmpeg 8 and follows relative references to sibling files.
  const concat = join(f.dir, "innocent.mp4");
  writeFileSync(concat, "ffconcat version 1.0\nfile portrait.mp4\nduration 2\n");
  await assert.rejects(probe(concat), (e: unknown) => e instanceof ReelForgeError && e.code === "VALIDATION_ERROR");

  // Even if a bad asset row existed, thumbnail generation must not follow the playlist.
  const home = mkdtempSync(join(tmpdir(), "reelforge-ssrf-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const db = openDatabase(join(home, "db.sqlite"));
  const project = new ProjectStore(db).create({ name: "S" }, "cli");
  const real = await probe(f.portrait);
  const { asset } = new AssetStore(db).add(project.id, resolveSource(concat), real, "cli");
  await assert.rejects(ensureThumbnail(join(home, "cache"), asset), (e: unknown) => e instanceof ReelForgeError);
});

test("thumbnails go to exactly their path, even when the cache folder name looks like a pattern", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "reelforge-thumb-%d-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const db = openDatabase(join(home, "db.sqlite"));
  const project = new ProjectStore(db).create({ name: "T" }, "cli");
  const { imported } = await importMedia(db, project.id, [f.landscape, f.mp3], "cli");
  const cache = join(home, "cache-%03d");
  for (const a of imported) {
    const thumb = await ensureThumbnail(cache, a);
    assert.ok(existsSync(thumb.path), `missing ${thumb.path}`);
  }
});

test("mov sources never follow external data references", () => {
  const args = sourceInputArgs("/x/clip.mov");
  assert.deepEqual(args.slice(args.indexOf("-f"), args.indexOf("-i")), ["-f", "mov", "-enable_drefs", "0"]);
  assert.ok(!sourceInputArgs("/x/a.wav").includes("-enable_drefs"));
});


test("phone editor pictures: a still the phone moved on from is skipped; the filmstrip is one seek per tile", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "reelforge-frames-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const db = openDatabase(join(home, "db.sqlite"));
  const project = new ProjectStore(db).create({ name: "F" }, "cli");
  const { imported } = await importMedia(db, project.id, [f.landscape], "cli");
  const asset = imported[0]!;
  const cache = join(home, "cache");

  await assert.rejects(sourceStill(cache, asset, 500_000, () => false), (e: Error) => e.message === STILL_SUPERSEDED);
  const still = await sourceStill(cache, asset, 500_000);
  assert.deepEqual([...readFileSync(still).subarray(0, 3)], [0xff, 0xd8, 0xff]);

  // 2 s of 320×180: two tiles a second apart, each 160×90, side by side.
  const strip = await ensureFilmstrip(cache, asset);
  assert.equal(strip.count, 2);
  assert.ok(Math.abs(strip.stepUs - 1_000_000) < 60_000);
  const p = await probe(strip.path);
  assert.deepEqual([p.width, p.height], [320, 90]);
  assert.deepEqual(readdirSync(join(cache, "stills", "strips")), [basename(strip.path)], "the per-tile files are cleaned up");
});
