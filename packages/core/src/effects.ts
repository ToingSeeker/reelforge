// Picture effects and motion presets (PRD §12). Effects are plain 0–1 numbers on
// the clip; these functions turn them into the exact parameters both the FFmpeg
// export (media/compile.ts) and the live preview shader (desktop/effects-gl.ts)
// use, so the two agree. Effects apply to the clip's picture after it is fitted
// to the frame and before zoom, rotation and opacity, so a zoom enlarges the
// blur and grain with the picture.

import type { ClipProps, ClipPropsPatch } from "./schema.ts";

export type PictureEffect = "blur" | "sharpen" | "vignette" | "grayscale" | "sepia" | "grain";

export const PICTURE_EFFECTS: { key: PictureEffect; label: string; hint: string; preset: number }[] = [
  { key: "blur", label: "Blur", hint: "Soft focus", preset: 0.3 },
  { key: "sharpen", label: "Sharpen", hint: "Crisper edges", preset: 0.4 },
  { key: "vignette", label: "Vignette", hint: "Darker corners", preset: 0.5 },
  { key: "grayscale", label: "Black & white", hint: "No colour", preset: 1 },
  { key: "sepia", label: "Sepia", hint: "Warm old photo", preset: 0.8 },
  { key: "grain", label: "Film grain", hint: "Moving noise", preset: 0.35 },
];

export function hasPictureEffects(p: ClipProps): boolean {
  return PICTURE_EFFECTS.some((e) => p[e.key] > 0);
}

/** Gaussian blur standard deviation in pixels of the fitted picture: up to 2.5 % of the frame width. */
export function blurSigma(p: ClipProps, frameWidth: number): number {
  return p.blur * 0.025 * frameWidth;
}

/**
 * Sharpen kernel strength `a` of the 3×3 kernel [0 -a 0; -a 1+4a -a; 0 -a 0], with edge pixels
 * repeated. Rounded to hundredths because FFmpeg's convolution takes integer weights / 100.
 */
export function sharpenAmount(p: ClipProps): number {
  return Math.round(p.sharpen * 150) / 100;
}

/**
 * Natural vignette (FFmpeg `vignette`): each pixel is multiplied by cos(angle × d)⁴, where d is its
 * distance from the centre over the half-diagonal. Up to π/2.5, where the corners go nearly black.
 */
export function vignetteAngle(p: ClipProps): number {
  return Math.round(p.vignette * (Math.PI / 2.5) * 1e4) / 1e4;
}

/**
 * Film grain: the same uniform noise added to R, G and B (luma only), new each frame.
 * `strength` is FFmpeg's `noise` c0s on limited-range luma; `amplitude` is the matching
 * half-range in 0–1 RGB (the limited→full range stretch is 255/219).
 */
export function grainNoise(p: ClipProps): { strength: number; amplitude: number } {
  const strength = Math.round(p.grain * 40);
  return { strength, amplitude: (strength / 2) * (255 / 219) / 255 };
}

const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1];
// BT.709 luma weights, and the classic sepia tone matrix.
const GRAY = [0.2126, 0.7152, 0.0722, 0.2126, 0.7152, 0.0722, 0.2126, 0.7152, 0.0722];
const SEPIA = [0.393, 0.769, 0.189, 0.349, 0.686, 0.168, 0.272, 0.534, 0.131];

const lerp = (a: number[], b: number[], t: number) => a.map((x, i) => x + (b[i]! - x) * t);
function mul(a: number[], b: number[]): number[] {
  const out: number[] = [];
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) out.push(a[r * 3]! * b[c]! + a[r * 3 + 1]! * b[3 + c]! + a[r * 3 + 2]! * b[6 + c]!);
  return out;
}

/** Row-major 3×3 RGB matrix for black & white then sepia, or null when neither is on. */
export function colorMatrix(p: ClipProps): number[] | null {
  if (!p.grayscale && !p.sepia) return null;
  const m = mul(lerp(IDENTITY, SEPIA, p.sepia), lerp(IDENTITY, GRAY, p.grayscale));
  return m.map((x) => Math.round(x * 1e4) / 1e4);
}

export type MotionPreset = "none" | "zoomIn" | "zoomOut" | "pushIn" | "panLeft" | "panRight" | "kenBurns";

type Motion = Pick<ClipProps, "scale" | "scaleEnd" | "x" | "xEnd" | "y" | "yEnd">;

/**
 * One-click camera moves. Each runs across the whole clip; pans zoom in a little so the
 * picture's edge never shows. They only set scale and position, which stay editable after.
 */
export const MOTION_PRESETS: { key: MotionPreset; label: string; hint: string; motion: Motion }[] = [
  { key: "none", label: "None", hint: "Still frame", motion: { scale: 1, scaleEnd: null, x: 0, xEnd: null, y: 0, yEnd: null } },
  { key: "zoomIn", label: "Zoom in", hint: "100 → 125 %", motion: { scale: 1, scaleEnd: 1.25, x: 0, xEnd: null, y: 0, yEnd: null } },
  { key: "zoomOut", label: "Zoom out", hint: "125 → 100 %", motion: { scale: 1.25, scaleEnd: 1, x: 0, xEnd: null, y: 0, yEnd: null } },
  { key: "pushIn", label: "Slow push", hint: "100 → 108 %", motion: { scale: 1, scaleEnd: 1.08, x: 0, xEnd: null, y: 0, yEnd: null } },
  { key: "panLeft", label: "Pan left", hint: "Drift to the left", motion: { scale: 1.2, scaleEnd: null, x: 0.08, xEnd: -0.08, y: 0, yEnd: null } },
  { key: "panRight", label: "Pan right", hint: "Drift to the right", motion: { scale: 1.2, scaleEnd: null, x: -0.08, xEnd: 0.08, y: 0, yEnd: null } },
  { key: "kenBurns", label: "Ken Burns", hint: "Zoom and drift", motion: { scale: 1.1, scaleEnd: 1.25, x: 0.04, xEnd: -0.04, y: 0.02, yEnd: -0.02 } },
];

export function motionPatch(key: MotionPreset): ClipPropsPatch {
  return { ...MOTION_PRESETS.find((m) => m.key === key)!.motion };
}

/** The preset a clip's motion matches exactly, or null for a hand-made one. */
export function motionPresetOf(p: ClipProps): MotionPreset | null {
  const m = MOTION_PRESETS.find((m) => (Object.keys(m.motion) as (keyof Motion)[]).every((k) => p[k] === m.motion[k]));
  return m?.key ?? null;
}
