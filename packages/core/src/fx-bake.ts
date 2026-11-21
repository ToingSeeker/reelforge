// AI effects (fx-catalog.ts) are baked: the engine renders the stretch of a clip
// they cover into a new video once, and both the export and the live preview
// play that file over those frames instead of the original. This module decides,
// purely from the timeline, which stretches need baking and under what cache
// key, so the engine, the compiler and the preview all agree on it.

import { clampFxOpts } from "./fx-catalog.ts";
import type { AiFx, Asset } from "./schema.ts";
import type { Rational } from "./timebase.ts";

/** Bump when the engine or how we call it changes what a bake looks like: every cached bake is redone. */
export const FX_ENGINE_VERSION = "claude-video-effects@c97d01b+rf1";

/** Effects closer than this (seconds) share one bake, so the engine tracks the face once. */
const MERGE_GAP_S = 1;
/** Extra source on each side so face tracking has settled when an effect starts (the engine uses 0.5 s). */
const LEAD_S = 0.5;

/** What one bake renders: a stretch of one source, with the effects that touch it. */
export interface FxBakeSpec {
  key: string;
  assetId: string;
  sourcePath: string;
  /** Source stretch in project frames: [from, to). */
  sourceFrom: number;
  sourceTo: number;
  fps: Rational;
  /** Short side of the baked video in pixels. */
  shortSide: number;
  /** Baked picture size: the source's displayed aspect at that short side (fxBakeSize). */
  width: number;
  height: number;
  /** Effects with times in seconds from the start of the stretch (may start before 0: already running). `images` are source paths of project media. */
  effects: { fx: string; start: number; end: number; text?: string; color?: string; images?: string[]; opts?: Record<string, string | number> }[];
}

/** Where a bake plays: timeline frames [from, to) of a segment, read from the baked file at `bakeOffset` frames in. */
export interface FxPiece {
  key: string;
  from: number;
  to: number;
  /** Frames into the baked file at timeline frame `from`. */
  bakeOffset: number;
}

/** Even pixel size with the given short side and the source's displayed aspect. */
export function fxBakeSize(srcW: number | null, srcH: number | null, short: number): { width: number; height: number } {
  const even = (x: number) => Math.max(2, Math.round(x / 2) * 2);
  const w = srcW ?? 9;
  const h = srcH ?? 16;
  return w <= h ? { width: even(short), height: even((short * h) / w) } : { width: even((short * w) / h), height: even(short) };
}

/** Small stable hash (two FNV-1a 32-bit lanes): enough to name cache files, not for security. */
export function stableHash(s: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ 0x5bd1e995;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ c, 0x5bd1e995) >>> 0;
    b = (b ^ (b >>> 13)) >>> 0;
  }
  return a.toString(16).padStart(8, "0") + b.toString(16).padStart(8, "0");
}

/**
 * The bakes a clip needs and where they play. `start`/`sourceIn` place the clip; `renderStart`/
 * `renderEnd` include its dissolve handles. Effects outside what plays are dropped.
 */
export function planClipFx(
  clip: { start: number; sourceIn: number; renderStart: number; renderEnd: number; effects: readonly AiFx[] },
  asset: Pick<Asset, "id" | "sourcePath" | "sizeBytes" | "durationFrames" | "width" | "height">,
  fps: Rational,
  shortSide: number,
  /** Source path of a project image/video asset, for effects that show pictures; unknown ids are skipped. */
  mediaPath: (assetId: string) => string | undefined = () => undefined,
): { specs: FxBakeSpec[]; pieces: FxPiece[] } {
  const rate = fps.num / fps.den;
  const toTimeline = (src: number) => clip.start + (src - clip.sourceIn);
  const windows = clip.effects
    .map((e) => ({ e, from: Math.max(clip.renderStart, toTimeline(e.start)), to: Math.min(clip.renderEnd, toTimeline(e.end)) }))
    .filter((w) => w.to > w.from)
    .sort((x, y) => x.from - y.from);
  const groups: { from: number; to: number; effects: AiFx[] }[] = [];
  for (const w of windows) {
    const g = groups[groups.length - 1];
    if (g && w.from - g.to < MERGE_GAP_S * rate) {
      g.to = Math.max(g.to, w.to);
      g.effects.push(w.e);
    } else groups.push({ from: w.from, to: w.to, effects: [w.e] });
  }
  const lead = Math.round(LEAD_S * rate);
  const specs: FxBakeSpec[] = [];
  const pieces: FxPiece[] = [];
  for (const g of groups) {
    const srcFrom = Math.max(0, g.from - clip.start + clip.sourceIn - lead);
    const srcEnd = g.to - clip.start + clip.sourceIn;
    const srcTo = asset.durationFrames === null ? srcEnd + lead : Math.min(asset.durationFrames, srcEnd + lead);
    const secs = (f: number) => Math.round(((f - srcFrom) / rate) * 1000) / 1000;
    // Keep the clip's own order: the engine applies effects in plan order.
    const effects = clip.effects
      .filter((e) => g.effects.includes(e))
      .map((e) => ({
        fx: e.fx,
        start: secs(e.start),
        end: secs(e.end),
        ...(e.text !== undefined ? { text: e.text } : {}),
        ...(e.color !== undefined ? { color: e.color } : {}),
        ...(e.images?.length ? { images: e.images.map(mediaPath).filter((x): x is string => !!x) } : {}),
        ...(e.opts && Object.keys(e.opts).length ? { opts: clampFxOpts(e.fx, e.opts) } : {}),
      }));
    const body = { assetId: asset.id, sourcePath: asset.sourcePath, sourceFrom: srcFrom, sourceTo: srcTo, fps, shortSide, ...fxBakeSize(asset.width, asset.height, shortSide), effects };
    const key = stableHash(JSON.stringify({ v: FX_ENGINE_VERSION, size: asset.sizeBytes, ...body }));
    specs.push({ key, ...body });
    pieces.push({ key, from: g.from, to: g.to, bakeOffset: g.from - toTimeline(srcFrom) });
  }
  return { specs, pieces };
}
