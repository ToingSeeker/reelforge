import { test } from "node:test";
import assert from "node:assert/strict";
import { applyOperations, ReelForgeError, type Clip, type EditState, type Track } from "../src/index.ts";
import type { AssetInfo } from "../src/timeline-ops.ts";

const T = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const V1 = T(1), A1 = T(2), CC = T(3), VID = T(10), AUD = T(11), IMG = T(12), SILENT = T(13);

function state(clips: Clip[] = [], trackPatch: Partial<Record<string, Partial<Track>>> = {}): EditState {
  const base: Track[] = [
    { id: V1, kind: "video", name: "Video", position: 0, muted: false, locked: false, hidden: false },
    { id: A1, kind: "audio", name: "Music", position: 1, muted: false, locked: false, hidden: false },
    { id: CC, kind: "caption", name: "Captions", position: 2, muted: false, locked: false, hidden: false },
  ];
  const tracks = base.map((t) => ({ ...t, ...trackPatch[t.id] }));
  const assets: AssetInfo[] = [
    { id: VID, kind: "video", durationFrames: 300, hasVideo: true, hasAudio: true },
    { id: AUD, kind: "audio", durationFrames: 900, hasVideo: false, hasAudio: true },
    { id: IMG, kind: "image", durationFrames: null, hasVideo: true, hasAudio: false },
    { id: SILENT, kind: "video", durationFrames: 300, hasVideo: true, hasAudio: false },
  ];
  return {
    fps: { num: 30, den: 1 },
    tracks: new Map(tracks.map((t) => [t.id, t])),
    clips: new Map(clips.map((c) => [c.id, c])),
    captions: new Map(),
    assets: new Map(assets.map((a) => [a.id, a])),
  };
}

const clip = (n: number, start: number, duration: number, extra: Partial<Clip> = {}): Clip => ({
  id: T(100 + n), trackId: V1, assetId: VID, start, duration, sourceIn: 0, props: {}, ...extra,
});

let seq = 0;
const ids = () => T(900 + ++seq);

function rejects(s: EditState, ops: Parameters<typeof applyOperations>[1], match: RegExp) {
  assert.throws(() => applyOperations(s, ops, ids), (e: unknown) => e instanceof ReelForgeError && e.code === "VALIDATION_ERROR" && match.test(e.message));
}

test("clip.add defaults to the remaining source / 3s for stills", () => {
  const s = applyOperations(state(), [
    { type: "clip.add", clipId: T(101), trackId: V1, assetId: VID, start: 0, sourceIn: 60 },
    { type: "clip.add", clipId: T(102), trackId: V1, assetId: IMG, start: 240 },
  ]);
  assert.equal(s.clips.get(T(101))?.duration, 240);
  assert.equal(s.clips.get(T(102))?.duration, 90);
});

test("track compatibility", () => {
  rejects(state(), [{ type: "clip.add", trackId: A1, assetId: IMG, start: 0 }], /cannot go on the audio track/);
  rejects(state(), [{ type: "clip.add", trackId: CC, assetId: VID, start: 0 }], /caption track/);
  rejects(state(), [{ type: "clip.add", trackId: A1, assetId: SILENT, start: 0 }], /cannot go on the audio/);
  // a video with sound may sit on an audio track (its audio is used)
  applyOperations(state(), [{ type: "clip.add", trackId: A1, assetId: VID, start: 0 }], ids);
});

test("no overlaps, no running past the source", () => {
  const s = state([clip(1, 0, 100)]);
  rejects(s, [{ type: "clip.add", trackId: V1, assetId: VID, start: 99, duration: 10 }], /overlap/);
  applyOperations(s, [{ type: "clip.add", trackId: V1, assetId: VID, start: 100, duration: 10 }], ids); // touching is fine
  rejects(s, [{ type: "clip.add", trackId: V1, assetId: VID, start: 200, sourceIn: 250, duration: 60 }], /past the end of the source/);
});

test("trim start shifts sourceIn; trim end changes duration", () => {
  const s0 = state([clip(1, 30, 100, { sourceIn: 10 })]);
  const a = applyOperations(s0, [{ type: "clip.trim", clipId: T(101), edge: "start", frame: 50 }]).clips.get(T(101))!;
  assert.deepEqual([a.start, a.duration, a.sourceIn], [50, 80, 30]);
  const b = applyOperations(s0, [{ type: "clip.trim", clipId: T(101), edge: "start", frame: 20 }]).clips.get(T(101))!;
  assert.deepEqual([b.start, b.duration, b.sourceIn], [20, 110, 0]);
  rejects(s0, [{ type: "clip.trim", clipId: T(101), edge: "start", frame: 19 }], /before the start of the source/);
  const c = applyOperations(s0, [{ type: "clip.trim", clipId: T(101), edge: "end", frame: 60 }]).clips.get(T(101))!;
  assert.equal(c.duration, 30);
  rejects(s0, [{ type: "clip.trim", clipId: T(101), edge: "end", frame: 30 }], /after the clip start/);
  rejects(s0, [{ type: "clip.trim", clipId: T(101), edge: "end", frame: 400 }], /past the end of the source/);
});

test("split keeps every source frame exactly once", () => {
  const s = applyOperations(state([clip(1, 30, 100, { sourceIn: 10 })]), [{ type: "clip.split", clipId: T(101), frame: 70, newClipId: T(201) }]);
  assert.deepEqual(s.clips.get(T(101)), clip(1, 30, 40, { sourceIn: 10 }));
  assert.deepEqual(s.clips.get(T(201)), { ...clip(1, 70, 60, { sourceIn: 50 }), id: T(201) });
  rejects(state([clip(1, 30, 100)]), [{ type: "clip.split", clipId: T(101), frame: 30 }], /inside the clip/);
  rejects(state([clip(1, 30, 100)]), [{ type: "clip.split", clipId: T(101), frame: 130 }], /inside the clip/);
});

test("ripple delete closes gaps on that track only", () => {
  const s0 = state([clip(1, 0, 30), clip(2, 30, 30), clip(3, 60, 30), clip(4, 100, 20), clip(5, 0, 50, { trackId: A1, assetId: AUD })]);
  const s = applyOperations(s0, [{ type: "clip.delete", clipIds: [T(102), T(103)], ripple: true }]);
  assert.deepEqual([...s.clips.values()].filter((c) => c.trackId === V1).map((c) => [c.start, c.duration]), [[0, 30], [40, 20]]);
  assert.equal(s.clips.get(T(105))?.start, 0);
  const plain = applyOperations(s0, [{ type: "clip.delete", clipIds: [T(102)] }]);
  assert.equal(plain.clips.get(T(103))?.start, 60);
});

test("locked tracks reject edits until unlocked", () => {
  const s = state([clip(1, 0, 30)], { [V1]: { locked: true } });
  rejects(s, [{ type: "clip.move", clipId: T(101), start: 10 }], /locked/);
  rejects(s, [{ type: "clip.add", trackId: V1, assetId: VID, start: 100 }], /locked/);
  const unlocked = applyOperations(s, [
    { type: "track.update", trackId: V1, locked: false },
    { type: "clip.move", clipId: T(101), start: 10 },
  ]);
  assert.equal(unlocked.clips.get(T(101))?.start, 10);
});

test("a failing operation rejects the whole batch and names its index", () => {
  const s0 = state([clip(1, 0, 30)]);
  assert.throws(
    () => applyOperations(s0, [{ type: "clip.move", clipId: T(101), start: 60 }, { type: "clip.split", clipId: T(101), frame: 5 }]),
    (e: unknown) => e instanceof ReelForgeError && e.details?.opIndex === 1 && /operation 2/.test(e.message),
  );
  assert.equal(s0.clips.get(T(101))?.start, 0, "input state is never mutated");
});

test("moving between tracks re-checks compatibility", () => {
  rejects(state([clip(1, 0, 30, { assetId: SILENT })]), [{ type: "clip.move", clipId: T(101), start: 0, trackId: A1 }], /cannot go on/);
});

test("trackLabels: V counts up from the bottom, A down from the top", async () => {
  const { trackLabels } = await import("../src/schema.ts");
  const mk = (id: string, kind: Track["kind"], position: number): Track => ({ id, kind, name: id, position, muted: false, locked: false, hidden: false });
  const labels = trackLabels([mk("ov", "overlay", 0), mk("v", "video", 1), mk("m", "audio", 2), mk("vo", "audio", 3), mk("cc", "caption", 4)]);
  assert.deepEqual(Object.fromEntries(labels), { ov: "V2", v: "V1", m: "A1", vo: "A2", cc: "C1" });
});

test("a missing clip, caption, track or asset is NOT_FOUND, not invalid input", () => {
  const notFound = (ops: Parameters<typeof applyOperations>[1], what: RegExp) =>
    assert.throws(() => applyOperations(state(), ops, ids), (e: unknown) => e instanceof ReelForgeError && e.code === "NOT_FOUND" && what.test(e.message));
  notFound([{ type: "clip.update", clipId: T(555), props: { opacity: 0.5 } }], /clip .* not found/);
  notFound([{ type: "caption.delete", captionIds: [T(556)] }], /caption .* not found/);
  notFound([{ type: "clip.add", trackId: T(557), assetId: VID, start: 0 }], /track .* not found/);
  notFound([{ type: "clip.add", trackId: V1, assetId: T(558), start: 0 }], /asset .* not found/);
});

test("the start of a still can be trimmed earlier: it has no source start", () => {
  const s = state([clip(1, 60, 90, { assetId: IMG })]);
  const out = applyOperations(s, [{ type: "clip.trim", clipId: T(101), edge: "start", frame: 30 }], ids);
  assert.deepEqual(out.clips.get(T(101)), { ...s.clips.get(T(101))!, start: 30, duration: 120, sourceIn: 0 });
  // A video still can't reach before its first frame.
  rejects(state([clip(1, 60, 90)]), [{ type: "clip.trim", clipId: T(101), edge: "start", frame: 30 }], /before the start of the source/);
});

test("fades longer than the clip share it instead of dropping the other fade", () => {
  const s = state([clip(1, 0, 60)]);
  const both = applyOperations(s, [{ type: "clip.update", clipId: T(101), props: { fadeIn: 90, fadeOut: 30 } }], ids);
  assert.deepEqual(both.clips.get(T(101))!.props, { fadeIn: 45, fadeOut: 15 }, "3:1, filling the clip");
  const longIn = applyOperations(state([clip(1, 0, 60, { props: { fadeOut: 20 } })]), [{ type: "clip.update", clipId: T(101), props: { fadeIn: 100 } }], ids);
  const p = longIn.clips.get(T(101))!.props;
  assert.ok(p.fadeOut! > 0, "the fade out survives a too-long fade in");
  assert.equal(p.fadeIn! + p.fadeOut!, 60);
  // Fades that fit are untouched; a lone fade is clamped to the clip.
  assert.deepEqual(applyOperations(s, [{ type: "clip.update", clipId: T(101), props: { fadeIn: 20, fadeOut: 40 } }], ids).clips.get(T(101))!.props, { fadeIn: 20, fadeOut: 40 });
  assert.deepEqual(applyOperations(s, [{ type: "clip.update", clipId: T(101), props: { fadeIn: 200 } }], ids).clips.get(T(101))!.props, { fadeIn: 60 });
  // Trimming shrinks both in proportion too.
  const trimmed = applyOperations(both, [{ type: "clip.trim", clipId: T(101), edge: "end", frame: 30 }], ids);
  assert.deepEqual(trimmed.clips.get(T(101))!.props, { fadeIn: 22, fadeOut: 8 });
});

test("props a clip can't show are refused: picture on sound-only clips, AI effects off video", () => {
  const s = state([clip(1, 0, 60, { trackId: A1, assetId: AUD }), clip(2, 0, 60, { assetId: IMG }), clip(3, 100, 60)]);
  rejects(s, [{ type: "clip.update", clipId: T(101), props: { opacity: 0.5 } }], /opacity only applies to picture clips/);
  rejects(s, [{ type: "clip.update", clipId: T(101), props: { blur: 0.3, grayscale: 1 } }], /blur, grayscale only apply/);
  rejects(s, [{ type: "clip.add", trackId: A1, assetId: AUD, start: 100, props: { scale: 2 } }], /scale only applies/);
  rejects(s, [{ type: "clip.update", clipId: T(102), props: { aiEffects: [{ fx: "zoom-punch" } as never] } }], /AI effects work on video clips only, not on an image/);
  // What does apply still goes through, and so do resets to the default.
  applyOperations(s, [{ type: "clip.update", clipId: T(101), props: { gainDb: -6, fadeIn: 10, opacity: 1, aiEffects: [] } }], ids);
  applyOperations(s, [{ type: "clip.update", clipId: T(102), props: { opacity: 0.5, blur: 0.2 } }], ids);
});

test("messages: 'an audio asset', and an in point past the end says so", () => {
  rejects(state(), [{ type: "clip.add", trackId: V1, assetId: AUD, start: 0 }], /^operation 1 \(clip\.add\): an audio asset cannot go on/);
  rejects(state(), [{ type: "clip.add", trackId: V1, assetId: VID, start: 0, sourceIn: 300 }], /in point 300 is past the end of the source media \(300 frames\)/);
});
