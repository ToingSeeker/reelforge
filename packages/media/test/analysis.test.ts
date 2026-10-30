import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AnalysisStore, openDatabase, ProjectStore } from "@reelforge/core";
import { AnalysisRunner, detectBeats, detectScenes, importMedia, interpretWhisper, whisperModelPath } from "../src/index.ts";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "reelforge-analysis-")));
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
const ff = (args: string[]) => execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args]);
const p = (n: string) => join(dir, n);

// red | blue | green, one second each
ff(["-f", "lavfi", "-i", "color=c=red:s=320x180:r=30:d=1", "-f", "lavfi", "-i", "color=c=blue:s=320x180:r=30:d=1", "-f", "lavfi", "-i", "color=c=green:s=320x180:r=30:d=1",
  "-filter_complex", "[0][1][2]concat=n=3:v=1:a=0", "-c:v", "libx264", "-pix_fmt", "yuv420p", p("scenes.mp4")]);
// metronomes: a 10 ms 1 kHz click every beat, 12 s
const click = (bpm: number, name: string) =>
  ff(["-f", "lavfi", "-i", `aevalsrc='0.8*sin(2*PI*1000*t)*lt(mod(t\\,${60 / bpm})\\,0.012)':s=44100:d=12`, p(name)]);
click(120, "m120.wav");
click(90, "m90.wav");
ff(["-f", "lavfi", "-i", "anoisesrc=d=8:c=white:a=0.3:seed=42", p("noise.wav")]);

test("scene changes land on the cuts", async () => {
  const r = await detectScenes(p("scenes.mp4"));
  const secs = r.cuts.map((c) => c.timeUs / 1e6);
  assert.equal(secs.length, 2, JSON.stringify(secs));
  assert.ok(Math.abs(secs[0]! - 1) < 0.05 && Math.abs(secs[1]! - 2) < 0.05, JSON.stringify(secs));
});

test("beats: 120 and 90 BPM metronomes", async () => {
  for (const [bpm, file] of [[120, "m120.wav"], [90, "m90.wav"]] as const) {
    const r = await detectBeats(p(file));
    assert.ok(Math.abs(r.bpm - bpm) <= 1.5, `${file}: ${r.bpm}`);
    assert.ok(r.confidence > 0.3, `${file} confidence ${r.confidence}`);
    const period = 60 / bpm;
    const off = r.beatsUs.map((us) => {
      const t = us / 1e6;
      const k = Math.round(t / period);
      return Math.abs(t - k * period);
    });
    const worst = Math.max(...off);
    assert.ok(worst < 0.035, `${file}: beats within 35 ms of the clicks (worst ${worst.toFixed(3)} s)`);
    assert.ok(r.beatsUs.length >= 12 * (bpm / 60) - 3, `${file}: ${r.beatsUs.length} beats`);
  }
});

test("noise has no confident beat", async () => {
  const r = await detectBeats(p("noise.wav"));
  assert.ok(r.confidence < 0.3, `confidence ${r.confidence}`);
});

test("whisper JSON → words (subword tokens merged, special tokens dropped)", () => {
  const r = interpretWhisper({
    result: { language: "id" },
    transcription: [
      {
        text: " Setiap cangkir punya cerita.",
        offsets: { from: 0, to: 2000 },
        tokens: [
          { text: "[_BEG_]", offsets: { from: 0, to: 0 }, p: 1 },
          { text: " Set", offsets: { from: 10, to: 200 }, p: 0.9 },
          { text: "iap", offsets: { from: 200, to: 400 }, p: 0.8 },
          { text: " cangkir", offsets: { from: 450, to: 900 }, p: 0.95 },
          { text: " punya", offsets: { from: 950, to: 1300 }, p: 0.99 },
          { text: " cerita", offsets: { from: 1350, to: 1800 }, p: 0.97 },
          { text: ".", offsets: { from: 1800, to: 1850 }, p: 0.99 },
          { text: "[_TT_92]", offsets: { from: 2000, to: 2000 }, p: 1 },
        ],
      },
    ],
  });
  assert.equal(r.language, "id");
  assert.deepEqual(r.segments[0]!.words.map((w) => [w.text, w.startUs, w.endUs, w.p]), [
    ["Setiap", 10_000, 400_000, 0.8],
    ["cangkir", 450_000, 900_000, 0.95],
    ["punya", 950_000, 1_300_000, 0.99],
    ["cerita.", 1_350_000, 1_850_000, 0.97],
  ]);
});

const whisperReady = spawnSync("whisper-cli", ["--help"]).status === 0 && existsSync(whisperModelPath());
const hasSay = spawnSync("which", ["say"]).status === 0;

test("transcription end to end through the analysis runner (local whisper.cpp)", { skip: !whisperReady || !hasSay ? "needs whisper-cli, the large-v3-turbo model and macOS `say`" : false, timeout: 300_000 }, async (t) => {
  execFileSync("say", ["-o", p("speech.aiff"), "Every cup tells a story. Crafted with passion."]);
  ff(["-i", p("speech.aiff"), p("speech.wav")]);
  const home = mkdtempSync(join(tmpdir(), "reelforge-asr-"));
  const db = openDatabase(join(home, "db.sqlite"));
  t.after(() => {
    db.close();
    rmSync(home, { recursive: true, force: true });
  });
  const project = new ProjectStore(db).create({ name: "ASR" }, "cli");
  const { imported } = await importMedia(db, project.id, [p("speech.wav")], "cli");
  const store = new AnalysisStore(db);
  const runner = new AnalysisRunner(db, { cacheDir: join(home, "cache") });
  const [a] = store.enqueue(project.id, imported[0]!.id, ["transcript"], { language: "auto" });
  runner.enqueue(a!.id);
  const done = await runner.wait(a!.id);
  assert.equal(done.state, "completed", done.error ?? "");
  const tr = (done as { result: { language: string; text: string; segments: { words: { text: string; startUs: number }[] }[] } }).result;
  assert.equal(tr.language, "en");
  assert.match(tr.text.toLowerCase(), /every cup tells a story/);
  const words = tr.segments.flatMap((s) => s.words);
  const story = words.find((w) => /story/i.test(w.text));
  assert.ok(story && story.startUs > 300_000 && story.startUs < 2_000_000, `"story" at ${story?.startUs}`);
});

test("music is not transcribed as speech (VAD)", { skip: !whisperReady ? "needs whisper-cli and the large-v3-turbo model" : false, timeout: 300_000 }, async (t) => {
  const { transcribe, vadModelPath } = await import("../src/index.ts");
  if (!existsSync(vadModelPath())) return t.skip("needs the Silero VAD model (without it whisper hallucinates on music)");
  ff(["-f", "lavfi", "-i", "aevalsrc='0.6*sin(2*PI*110*t)*exp(-6*mod(t\\,0.5))+0.2*sin(2*PI*440*t)':s=48000:d=12", p("music.wav")]);
  const r = await transcribe(p("music.wav"), join(dir, "work-music"));
  assert.deepEqual(r.segments, [], `heard: ${r.text}`);
});

test("enqueue validates kinds against the media", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "reelforge-an-"));
  const db = openDatabase(join(home, "db.sqlite"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const project = new ProjectStore(db).create({ name: "V" }, "cli");
  const { imported } = await importMedia(db, project.id, [p("scenes.mp4"), p("m120.wav")], "cli");
  const store = new AnalysisStore(db);
  assert.throws(() => store.enqueue(project.id, imported[0]!.id, ["beats"]), /no audio/);
  assert.throws(() => store.enqueue(project.id, imported[1]!.id, ["scenes"]), /needs a video/);
  const [b] = store.enqueue(project.id, imported[1]!.id, ["beats"]);
  const runner = new AnalysisRunner(db, { cacheDir: join(home, "cache") });
  runner.enqueue(b!.id);
  const done = await runner.wait(b!.id);
  assert.equal(done.state, "completed");
  assert.equal(done.stale, false);
});
