import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import {
  applyOperations,
  audioGain,
  AssetStore,
  buildRenderPlan,
  openDatabase,
  pictureAlpha,
  placement,
  ProjectStore,
  resolveClipProps,
  TimelineStore,
  type PlanSegment,
} from "../src/index.ts";
import { fakeMedia, tempDir } from "./helpers.ts";

function seg(over: Partial<Omit<PlanSegment, "props">> & { props?: Partial<PlanSegment["props"]> } = {}): PlanSegment {
  const { props, ...rest } = over;
  return {
    clipId: "c", assetId: "a", trackId: "t", start: 100, duration: 50, sourceIn: 0,
    renderStart: 100, renderEnd: 150, renderSourceIn: 0, inH: 0, outH: 0,
    props: resolveClipProps(props), ...rest,
  };
}

test("pictureAlpha: opacity × fades, FFmpeg-style (i - s) / n ramps", () => {
  const s = seg({ props: { opacity: 0.5, fadeIn: 10, fadeOut: 10 } });
  assert.equal(pictureAlpha(s, 99), 0);
  assert.equal(pictureAlpha(s, 100), 0);
  assert.equal(pictureAlpha(s, 105), 0.25);
  assert.equal(pictureAlpha(s, 120), 0.5);
  assert.equal(pictureAlpha(s, 140), 0.5);
  assert.equal(pictureAlpha(s, 145), 0.25);
  assert.ok(Math.abs(pictureAlpha(s, 149) - 0.05) < 1e-12);
  assert.equal(pictureAlpha(s, 150), 0);
});

test("audioGain: dB gain and crossfade on both sides", () => {
  const s = seg({ props: { gainDb: -6.020599913 }, inH: 5, outH: 5, renderStart: 95, renderEnd: 155 });
  assert.ok(Math.abs(audioGain(s, 120) - 0.5) < 1e-6);
  assert.ok(Math.abs(audioGain(s, 95) - 0) < 1e-9);
  assert.ok(Math.abs(audioGain(s, 100) - 0.25) < 1e-6); // halfway into the crossfade
  assert.ok(Math.abs(audioGain(s, 150) - 0.25) < 1e-6);
});

test("placement: cover crops to the frame, contain letterboxes, zoom and offset", () => {
  const W = 1080, H = 1920;
  const cover = placement(seg(), 100, 1920, 1080, W, H);
  assert.deepEqual([Math.round(cover.dw), Math.round(cover.dh)], [1080, 1920]);
  assert.ok(Math.abs(cover.sw - 607.5) < 1e-6 && Math.abs(cover.sh - 1080) < 1e-6, "landscape source cropped to a 9:16 slice");
  const contain = placement(seg({ props: { fit: "contain" } }), 100, 1920, 1080, W, H);
  assert.deepEqual([contain.dw, Math.round(contain.dh), contain.sw], [1080, 608, 1920]);
  const zoom = placement(seg({ props: { scale: 1, scaleEnd: 2 } }), 149, 1080, 1920, W, H);
  assert.equal(zoom.dw, 2160);
  const moved = placement(seg({ props: { x: 0.25, rotation: 90 } }), 100, 1080, 1920, W, H);
  assert.equal(moved.cx, W / 2 + 270);
  assert.equal(moved.rotation, Math.PI / 2);
});

function project(t: Parameters<typeof tempDir>[0], videoFrames = 300) {
  const dir = tempDir(t);
  const db = openDatabase(join(dir, "db.sqlite"));
  const p = new ProjectStore(db).create({ name: "P" }, "cli");
  const assets = new AssetStore(db);
  const v = fakeMedia(dir, "v.mp4", { durationUs: (videoFrames / 30) * 1_000_000 });
  const a = assets.add(p.id, v.file, v.probe, "cli").asset;
  const timeline = new TimelineStore(db);
  const video = timeline.get(p.id).tracks.find((x) => x.kind === "video")!.id;
  const apply = (ops: Parameters<TimelineStore["apply"]>[1]["operations"]) =>
    timeline.apply(p.id, { baseRevision: timeline.get(p.id).project.revision, operations: ops }, "cli");
  return { db, p, a, timeline, video, apply };
}

test("dissolve handles: outgoing clip plays past its out point, incoming starts early; clamped to the media", (t) => {
  const s = project(t, 300);
  const A = "00000000-0000-4000-8000-00000000000a", B = "00000000-0000-4000-8000-00000000000b";
  s.apply([
    { type: "clip.add", clipId: A, trackId: s.video, assetId: s.a.id, start: 0, sourceIn: 0, duration: 60 },
    { type: "clip.add", clipId: B, trackId: s.video, assetId: s.a.id, start: 60, sourceIn: 100, duration: 60, props: { transitionIn: 20 } },
  ]);
  let plan = buildRenderPlan(s.timeline.get(s.p.id));
  let [a, b] = plan.layers[0]!;
  assert.deepEqual([a!.renderEnd, a!.outH], [70, 10]);
  assert.deepEqual([b!.renderStart, b!.renderSourceIn, b!.inH], [50, 90, 10]);
  assert.equal(pictureAlpha(b!, 50), 0);
  assert.equal(pictureAlpha(b!, 60), 0.5, "half way through the dissolve at the cut");

});

test("dissolve shrinks to the available handle", (t) => {
  const s = project(t, 300);
  // B starts at source frame 4: only 4 frames exist before its in point → an 8-frame dissolve, not 20.
  s.apply([
    { type: "clip.add", trackId: s.video, assetId: s.a.id, start: 0, sourceIn: 0, duration: 60 },
    { type: "clip.add", trackId: s.video, assetId: s.a.id, start: 60, sourceIn: 4, duration: 60, props: { transitionIn: 20 } },
  ]);
  const [a, b] = buildRenderPlan(s.timeline.get(s.p.id)).layers[0]!;
  assert.deepEqual([a!.outH, b!.inH, b!.renderSourceIn], [4, 4, 0]);
});

test("a gap between clips means no dissolve", (t) => {
  const s = project(t);
  s.apply([
    { type: "clip.add", trackId: s.video, assetId: s.a.id, start: 0, duration: 30 },
    { type: "clip.add", trackId: s.video, assetId: s.a.id, start: 40, sourceIn: 50, duration: 30, props: { transitionIn: 10 } },
  ]);
  const [a, b] = buildRenderPlan(s.timeline.get(s.p.id)).layers[0]!;
  assert.deepEqual([a!.outH, b!.inH, b!.renderStart], [0, 0, 40]);
});

test("clip.update is undoable; split hands fade-in to the left half and fade-out to the right; trims shrink fades", (t) => {
  const s = project(t);
  const id = "00000000-0000-4000-8000-0000000000c1";
  s.apply([{ type: "clip.add", clipId: id, trackId: s.video, assetId: s.a.id, start: 0, duration: 90 }]);
  let tl = s.apply([{ type: "clip.update", clipId: id, props: { fadeIn: 15, fadeOut: 20, opacity: 0.8, transitionIn: 6 } }]);
  assert.deepEqual(tl.clips[0]!.props, { fadeIn: 15, fadeOut: 20, opacity: 0.8, transitionIn: 6 });
  tl = s.timeline.undo(s.p.id, { baseRevision: tl.project.revision }, "cli");
  assert.deepEqual(tl.clips[0]!.props, {});
  tl = s.timeline.redo(s.p.id, { baseRevision: tl.project.revision }, "cli");
  tl = s.apply([{ type: "clip.split", clipId: id, frame: 45, newClipId: "00000000-0000-4000-8000-0000000000c2" }]);
  const left = tl.clips.find((c) => c.id === id)!;
  const right = tl.clips.find((c) => c.id !== id)!;
  assert.deepEqual(left.props, { fadeIn: 15, opacity: 0.8, transitionIn: 6 });
  assert.deepEqual(right.props, { fadeOut: 20, opacity: 0.8 });
  tl = s.apply([{ type: "clip.trim", clipId: right.id, edge: "end", frame: 55 }]);
  assert.equal(tl.clips.find((c) => c.id === right.id)!.props.fadeOut, 10, "fade shrinks with the clip");
});

test("clip.update rejects out-of-range and unknown fields", (t) => {
  const s = project(t);
  const id = "00000000-0000-4000-8000-0000000000d1";
  s.apply([{ type: "clip.add", clipId: id, trackId: s.video, assetId: s.a.id, start: 0, duration: 30 }]);
  assert.throws(() => s.apply([{ type: "clip.update", clipId: id, props: { opacity: 2 } }]), /invalid input/);
  assert.throws(() => s.apply([{ type: "clip.update", clipId: id, props: { shader: "x" } as never }]), /invalid input/);
  void applyOperations;
});

test("a video plays its own sound; muting its track silences it, hiding only hides the picture", (t) => {
  const s = project(t, 300);
  const dir = tempDir(t);
  const mute = fakeMedia(dir, "silent.mp4", { hasAudio: false, durationUs: 10_000_000 });
  const silent = new AssetStore(s.db).add(s.p.id, mute.file, mute.probe, "cli").asset;
  s.apply([
    { type: "clip.add", trackId: s.video, assetId: s.a.id, start: 0, duration: 60 },
    { type: "clip.add", trackId: s.video, assetId: silent.id, start: 60, duration: 60 },
  ]);
  const audioOf = () => buildRenderPlan(s.timeline.get(s.p.id)).audio.map((x) => x.assetId);
  assert.deepEqual(audioOf(), [s.a.id], "the clip with sound is heard; the silent one adds nothing");
  s.apply([{ type: "track.update", trackId: s.video, hidden: true }]);
  assert.deepEqual(audioOf(), [s.a.id], "hidden picture, sound still on");
  s.apply([{ type: "track.update", trackId: s.video, muted: true }]);
  assert.deepEqual(audioOf(), []);
});

