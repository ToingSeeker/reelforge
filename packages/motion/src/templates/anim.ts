import { Easing, interpolate, spring } from "remotion";

/** 0→1 entrance over `frames`, eased out, starting at `delay`. */
export const enter = (frame: number, delay: number, frames: number) =>
  interpolate(frame - delay, [0, frames], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.bezier(0.16, 1, 0.3, 1) });

/** 1→0 exit over the last `frames` of a graphic `total` frames long. */
export const leave = (frame: number, total: number, frames: number) =>
  interpolate(frame, [total - frames, total - 1], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.bezier(0.7, 0, 0.84, 0) });

/** A springy 0→1 pop. */
export const pop = (frame: number, fps: number, delay = 0) => spring({ frame: frame - delay, fps, config: { damping: 12, mass: 0.6, stiffness: 180 } });

/** Timings scale with the frame rate so a graphic feels the same at 24, 30 or 60 fps. */
export const sec = (fps: number, s: number) => Math.max(1, Math.round(fps * s));
