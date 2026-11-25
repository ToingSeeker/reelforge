import { test } from "node:test";
import assert from "node:assert/strict";
import { applyOperations, type Clip, type EditState, type Track } from "@reelforge/core";
import type { AssetInfo } from "@reelforge/core/timeline-ops";
import { dragMoved, dragTrackId, groupMoveOps } from "../src/clip-drag.ts";

const T = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const V1 = T(1), V2 = T(2), A1 = T(3), VID = T(10), AUD = T(11), SILENT = T(12);

const tracks = (locked: string[] = []): Track[] =>
  [
    { id: V1, kind: "video" as const, name: "Video", position: 0 },
    { id: V2, kind: "overlay" as const, name: "Overlay", position: 1 },
    { id: A1, kind: "audio" as const, name: "Voice", position: 2 },
  ].map((t) => ({ ...t, muted: false, hidden: false, locked: locked.includes(t.id) }));
const assets = new Map<string, AssetInfo>([
  [VID, { id: VID, kind: "video", durationFrames: 300, hasVideo: true, hasAudio: true }],
  [SILENT, { id: SILENT, kind: "video", durationFrames: 300, hasVideo: true, hasAudio: false }],
  [AUD, { id: AUD, kind: "audio", durationFrames: 900, hasVideo: false, hasAudio: true }],
]);
const clip = (n: number, trackId: string, start: number, assetId = VID): Clip => ({ id: T(100 + n), trackId, assetId, start, duration: 100, sourceIn: 0, props: {} });
const state = (clips: Clip[], ts = tracks()): EditState => ({
  fps: { num: 30, den: 1 },
  tracks: new Map(ts.map((t) => [t.id, t])),
  clips: new Map(clips.map((c) => [c.id, c])),
  captions: new Map(),
  assets,
});
const starts = (s: EditState) => [...s.clips.values()].map((c) => [c.id, c.trackId, c.start]);

test("a straight up/down drag to another track counts as a move", () => {
  assert.equal(dragMoved(false, 0, 0), false, "a click");
  assert.equal(dragMoved(false, 2, 0), false, "jitter");
  assert.equal(dragMoved(false, 0, 1), true, "vertical only, one track down");
  assert.equal(dragMoved(false, 5, 0), true);
});

test("adjacent selected clips move together in one batch, in either direction", () => {
  const a = clip(1, V1, 0), b = clip(2, V1, 100), c = clip(3, A1, 0, AUD);
  const s = state([a, b, c]);
  assert.deepEqual(groupMoveOps(tracks(), assets, [a, b, c], 0, 0), [], "dropped where it was");
  const ops = groupMoveOps(tracks(), assets, [a, b, c], 30, 0);
  assert.equal(ops.length, 3);
  assert.deepEqual(starts(applyOperations(s, ops)), [[a.id, V1, 30], [b.id, V1, 130], [c.id, A1, 30]]);
  // Left: b(100) and a(200) → the leftmost goes first.
  const a2 = clip(1, V1, 100), b2 = clip(2, V1, 200);
  const out = applyOperations(state([a2, b2]), groupMoveOps(tracks(), assets, [b2, a2], -50, 0));
  assert.deepEqual(starts(out), [[a2.id, V1, 50], [b2.id, V1, 150]]);
});

test("a group changes tracks only by the same offset, and only where every clip fits", () => {
  const a = clip(1, V1, 0), b = clip(2, V2, 0, SILENT);
  assert.deepEqual(groupMoveOps(tracks(), assets, [a], 0, 1), [{ type: "clip.move", clipId: a.id, start: 0, trackId: V2 }]);
  // Down one: b (a silent video) can't go on the audio track, so the group keeps its tracks.
  assert.deepEqual(groupMoveOps(tracks(), assets, [a, b], 20, 1), [
    { type: "clip.move", clipId: a.id, start: 20 },
    { type: "clip.move", clipId: b.id, start: 20 },
  ]);
  assert.deepEqual(groupMoveOps(tracks(), assets, [a, b], 0, -1), [], "V1 has nothing above it");
  // b moves up onto V1 while a stays: the overlap is the engine's to reject (atomically).
  assert.throws(() => applyOperations(state([a, b]), groupMoveOps(tracks(), assets, [b], 0, -1)), /overlap/);
  // A locked destination is not a place to go.
  assert.deepEqual(groupMoveOps(tracks([V2]), assets, [a], 0, 1), []);
  assert.equal(dragTrackId({ group: [a], offset: 1 }, tracks(), assets, a), V2);
  assert.equal(dragTrackId({ group: [a], offset: 1 }, tracks([V2]), assets, a), V1);
  assert.equal(dragTrackId({ group: [a], offset: 1 }, tracks(), assets, b), V2, "b is not dragged");
});

test("a vertical group shift moves the clip ahead of the move first", () => {
  // a on V1 goes to V2, where b sits; b moves on (V2 is an overlay, both videos fit any picture track).
  const ts: Track[] = [...tracks(), { id: T(4), kind: "overlay", name: "Overlay 2", position: 3, muted: false, hidden: false, locked: false }];
  const order: Track[] = [ts[0], ts[1], ts[3], ts[2]];
  const a = clip(1, V1, 0), b = clip(2, V2, 0);
  const out = applyOperations(state([a, b], order), groupMoveOps(order, assets, [a, b], 10, 1));
  assert.deepEqual(starts(out), [[a.id, V2, 10], [b.id, T(4), 10]]);
});
