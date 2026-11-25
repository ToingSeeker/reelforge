// The Inspector's Motion preset is about animation only (the End values). Where a clip sits and how
// big it is (x, y, scale) is its static framing: moving or scaling a still clip isn't "Custom" motion,
// and choosing None stops the animation without undoing that framing.

import type { ClipProps, ClipPropsPatch } from "@reelforge/core/schema";
import { motionPatch, motionPresetOf, type MotionPreset } from "@reelforge/core/effects";

const still = (p: ClipProps) => p.scaleEnd === null && p.xEnd === null && p.yEnd === null;

/** "none" for a clip that doesn't animate, the matching preset, or null for a hand-made animation. */
export function clipMotionPreset(p: ClipProps): MotionPreset | null {
  return still(p) ? "none" : motionPresetOf(p);
}

/** The edit for picking a preset: None only clears the animation; the others set their whole move. */
export function motionPresetPatch(key: MotionPreset): ClipPropsPatch {
  return key === "none" ? { scaleEnd: null, xEnd: null, yEnd: null } : motionPatch(key);
}
