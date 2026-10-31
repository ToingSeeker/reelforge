import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ClipPropsPatchSchema,
  colorMatrix,
  hasPictureEffects,
  MOTION_PRESETS,
  motionPatch,
  motionPresetOf,
  placement,
  positionAt,
  resolveClipProps,
  type PlanSegment,
} from "../src/index.ts";

function seg(props: Parameters<typeof resolveClipProps>[0]): PlanSegment {
  return {
    clipId: "c", assetId: "a", trackId: "t", start: 100, duration: 51, sourceIn: 0,
    renderStart: 100, renderEnd: 151, renderSourceIn: 0, inH: 0, outH: 0, props: resolveClipProps(props),
  };
}

test("pan: position runs linearly from x/y to xEnd/yEnd across the clip, like the zoom", () => {
  const s = seg({ x: -0.2, xEnd: 0.2, y: 0.1 });
  assert.deepEqual(positionAt(s, 100), { x: -0.2, y: 0.1 });
  assert.ok(Math.abs(positionAt(s, 125).x) < 1e-12);
  assert.deepEqual(positionAt(s, 150), { x: 0.2, y: 0.1 });
  assert.equal(placement(s, 150, 1080, 1920, 1080, 1920).cx, 540 + 0.2 * 1080);
  // fitted size (where effects apply) is before zoom
  const z = placement(seg({ scale: 2 }), 100, 1080, 1920, 1080, 1920);
  assert.deepEqual([z.fw, z.fh, z.dw, z.dh], [1080, 1920, 2160, 3840]);
});

test("motion presets round-trip and keep pans covered; a hand-made move matches none", () => {
  for (const m of MOTION_PRESETS) {
    assert.equal(motionPresetOf(resolveClipProps(motionPatch(m.key))), m.key);
    assert.ok(ClipPropsPatchSchema.safeParse(motionPatch(m.key)).success);
    // A pan never shows the picture's edge: the overhang (scale − 1) / 2 covers the offset.
    const { scale, scaleEnd, x, xEnd, y, yEnd } = m.motion;
    const overhang = (Math.min(scale, scaleEnd ?? scale) - 1) / 2;
    assert.ok(Math.max(Math.abs(x), Math.abs(xEnd ?? x), Math.abs(y), Math.abs(yEnd ?? y)) <= overhang + 1e-9, m.key);
  }
  assert.equal(motionPresetOf(resolveClipProps({ scale: 1.3 })), null);
});

test("effects: off by default, colour matrix composes black & white then sepia", () => {
  assert.equal(hasPictureEffects(resolveClipProps({})), false);
  assert.equal(colorMatrix(resolveClipProps({})), null);
  const gray = colorMatrix(resolveClipProps({ grayscale: 1 }))!;
  assert.deepEqual(gray.slice(0, 3), [0.2126, 0.7152, 0.0722]);
  const half = colorMatrix(resolveClipProps({ grayscale: 0.5 }))!;
  assert.equal(half[0], 0.6063); // 1 − 0.5 × (1 − 0.2126)
});
