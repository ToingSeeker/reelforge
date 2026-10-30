import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import {
  AssetStore,
  captionStates,
  captionsToSrt,
  generateCaptions,
  layoutCaption,
  openDatabase,
  ProjectStore,
  resolveCaptionStyle,
  TimelineStore,
  type GlyphFont,
  type TranscriptResult,
} from "../src/index.ts";
import { fakeMedia, tempDir } from "./helpers.ts";

function setup(t: Parameters<typeof tempDir>[0]) {
  const dir = tempDir(t);
  const db = openDatabase(join(dir, "db.sqlite"));
  const p = new ProjectStore(db).create({ name: "Cap" }, "cli");
  const m = fakeMedia(dir, "voice.wav", { kind: "audio", hasVideo: false, width: null, height: null, fps: null, durationUs: 20_000_000 });
  const asset = new AssetStore(db).add(p.id, m.file, m.probe, "cli").asset;
  const timeline = new TimelineStore(db);
  const tl0 = timeline.get(p.id);
  const voice = tl0.tracks.find((x) => x.name === "Voice")!.id;
  const cc = tl0.tracks.find((x) => x.kind === "caption")!.id;
  const video = tl0.tracks.find((x) => x.kind === "video")!.id;
  const apply = (ops: Parameters<TimelineStore["apply"]>[1]["operations"]) =>
    timeline.apply(p.id, { baseRevision: timeline.get(p.id).project.revision, operations: ops }, "cli");
  return { db, p, asset, timeline, voice, cc, video, apply };
}

const w = (text: string, s: number, e: number) => ({ text, startUs: s * 1000, endUs: e * 1000, p: 0.9 });
const transcript: TranscriptResult = {
  language: "en",
  text: "Every cup tells a story. From bean to a brighter day.",
  segments: [
    { startUs: 0, endUs: 2_000_000, text: "Every cup tells a story.", words: [w("Every", 0, 300), w("cup", 300, 600), w("tells", 600, 900), w("a", 900, 1000), w("story.", 1000, 1500)] },
    { startUs: 3_000_000, endUs: 5_000_000, text: "From bean to a brighter day.", words: [w("From", 3000, 3300), w("bean", 3300, 3600), w("to", 3600, 3700), w("a", 3700, 3800), w("brighter", 3800, 4300), w("day.", 4300, 4800)] },
  ],
};

test("generateCaptions maps words through the clip (trim + position) and groups them", (t) => {
  const s = setup(t);
  // clip starts at 2 s on the timeline and its source starts at 0.6 s → "Every cup" is trimmed away
  const tl = s.apply([{ type: "clip.add", trackId: s.voice, assetId: s.asset.id, start: 60, sourceIn: 18, duration: 200 }]);
  const caps = generateCaptions(tl, new Map([[s.asset.id, transcript]]), { maxWords: 3 });
  assert.deepEqual(caps.map((c) => c.text), ["tells a story.", "From bean to", "a brighter day."]);
  const first = caps[0]!;
  assert.equal(first.start, 60 + (18 - 18)); // "tells" starts at source 0.6 s = clip start
  assert.deepEqual(first.words.map((x) => x.text), ["tells", "a", "story."]);
  assert.ok(first.words.every((x) => x.start >= 0 && x.end <= first.duration));
  // the 1.5 s pause after "story." starts a new caption instead of holding the old one
  assert.ok(first.start + first.duration <= caps[1]!.start);
});

test("captions are undoable timeline edits; text edits re-spread word timings; overlaps and wrong tracks are refused", (t) => {
  const s = setup(t);
  let tl = s.apply([{ type: "captions.replace", trackId: s.cc, captions: [{ start: 0, duration: 30, text: "Every cup" }, { start: 30, duration: 30, text: "tells a story" }] }]);
  assert.equal(tl.captions.length, 2);
  assert.deepEqual(tl.captions[0]!.words, [{ text: "Every", start: 0, end: 15 }, { text: "cup", start: 15, end: 30 }]);
  const id = tl.captions[1]!.id;
  tl = s.apply([{ type: "caption.update", captionId: id, text: "tells a better story" }]);
  assert.equal(tl.captions[1]!.words.length, 4);
  assert.throws(() => s.apply([{ type: "caption.add", trackId: s.cc, start: 20, duration: 20, text: "overlap" }]), /overlap/);
  assert.throws(() => s.apply([{ type: "caption.add", trackId: s.video, start: 100, duration: 20, text: "wrong" }]), /caption track/);
  tl = s.timeline.undo(s.p.id, { baseRevision: tl.project.revision }, "cli");
  assert.equal(tl.captions[1]!.text, "tells a story");
  tl = s.timeline.undo(s.p.id, { baseRevision: tl.project.revision }, "cli");
  assert.equal(tl.captions.length, 0);
  assert.equal(tl.durationFrames, 0);
});

test("caption style lives on the track, apart from the text", (t) => {
  const s = setup(t);
  const tl = s.apply([{ type: "track.update", trackId: s.cc, captionStyle: { font: "Poppins Bold", highlight: null } }]);
  assert.deepEqual(tl.tracks.find((x) => x.id === s.cc)!.captionStyle, { font: "Poppins Bold", highlight: null });
  assert.throws(() => s.apply([{ type: "track.update", trackId: s.video, captionStyle: { uppercase: true } }]), /caption tracks/);
  assert.throws(() => s.apply([{ type: "track.update", trackId: s.cc, captionStyle: { color: "red" } as never }]), /invalid input/);
});

test("SRT export", () => {
  const srt = captionsToSrt(
    [
      { id: "b", trackId: "t", start: 45, duration: 30, text: "tells a story", words: [] },
      { id: "a", trackId: "t", start: 0, duration: 45, text: "Every cup", words: [] },
    ],
    { num: 30, den: 1 },
  );
  assert.equal(srt, "1\n00:00:00,000 --> 00:00:01,500\nEvery cup\n\n2\n00:00:01,500 --> 00:00:02,500\ntells a story\n");
});

test("layout wraps inside maxWidth and centres lines; states split at word starts", () => {
  // monospace fake font: every character is 0.5 em
  const font: GlyphFont = { unitsPerEm: 1000, ascender: 800, descender: -200, getAdvanceWidth: (s, size) => s.length * 0.5 * size };
  const style = resolveCaptionStyle({ size: 0.05, maxWidth: 0.5, uppercase: false });
  const L = layoutCaption({ text: "aaaa bbbb cccc", words: [] }, style, 1000, 2000, font);
  // size 100 px → each 4-char word 200 px, space 50 px; max 500 px → "aaaa bbbb" (450) + "cccc"
  assert.deepEqual(L.words.map((x) => Math.round(x.x)), [275, 525, 400]);
  assert.equal(L.lines.length, 2);
  const states = captionStates({ start: 100, duration: 30, words: [{ text: "a", start: 0, end: 10 }, { text: "b", start: 10, end: 30 }] }, true);
  assert.deepEqual(states, [{ from: 100, to: 110, active: 0 }, { from: 110, to: 130, active: 1 }]);
  assert.deepEqual(captionStates({ start: 0, duration: 30, words: [] }, true), [{ from: 0, to: 30, active: -1 }]);
});
