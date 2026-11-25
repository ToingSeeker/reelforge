import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CLIP_PROPS, type ClipProps } from "@reelforge/core/schema";
import { motionPatch } from "@reelforge/core/effects";
import { clipMotionPreset, motionPresetPatch } from "../src/motion-preset.ts";

const props = (patch: Partial<ClipProps>): ClipProps => ({ ...DEFAULT_CLIP_PROPS, ...patch });

test("a clip that was only moved or scaled has no motion, not Custom", () => {
  assert.equal(clipMotionPreset(DEFAULT_CLIP_PROPS), "none");
  assert.equal(clipMotionPreset(props({ x: 0.2, y: -0.1, scale: 0.6 })), "none");
  assert.equal(clipMotionPreset(props(motionPatch("kenBurns") as Partial<ClipProps>)), "kenBurns");
  assert.equal(clipMotionPreset(props({ scale: 0.6, scaleEnd: 0.9 })), null, "a hand-made zoom is Custom");
});

test("None stops the animation and keeps the clip's position and size", () => {
  const patch = motionPresetPatch("none");
  assert.deepEqual(patch, { scaleEnd: null, xEnd: null, yEnd: null });
  const after = props({ x: 0.2, y: -0.1, scale: 0.6, scaleEnd: 0.9, ...patch });
  assert.equal(after.x, 0.2);
  assert.equal(after.scale, 0.6);
  assert.equal(clipMotionPreset(after), "none");
  assert.deepEqual(motionPresetPatch("panLeft"), motionPatch("panLeft"), "a real move sets its start too");
});
