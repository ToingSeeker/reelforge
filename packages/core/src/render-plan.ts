// The canonical render graph (PRD FR-017). The FFmpeg export, the rendered
// preview and the live canvas preview all consume this resolved plan and the
// pure functions below, so fades, dissolves and transforms mean exactly the
// same thing everywhere.

import { ReelForgeError } from "./errors.ts";
import { resolveCaptionStyle, resolveClipProps, type Caption, type CaptionStyle, type ClipProps, type Timeline } from "./schema.ts";
import type { Rational } from "./timebase.ts";

export interface PlanSource {
  assetId: string;
  path: string;
  kind: "video" | "audio" | "image";
  width: number | null;
  height: number | null;
}

export interface PlanSegment {
  clipId: string;
  assetId: string;
  trackId: string;
  /** The clip as edited (project frames). */
  start: number;
  duration: number;
  sourceIn: number;
  props: ClipProps;
  /** Frames actually drawn / played: the clip plus dissolve handles on either side. */
  renderStart: number;
  renderEnd: number;
  renderSourceIn: number;
  /** Half-width of the dissolve into this clip (window [start-inH, start+inH)); 0 = cut. */
  inH: number;
  /** Half-width of the dissolve out of this clip into the next one; 0 = cut. */
  outH: number;
}

/** Back-compat names used by the compiler and tests. */
export type PlanVideoSegment = PlanSegment;
export type PlanAudioSegment = PlanSegment;

export interface RenderPlan {
  projectId: string;
  revision: number;
  width: number;
  height: number;
  fps: Rational;
  totalFrames: number;
  /** Picture layers, bottom first; within a layer, segments in time order (later ones composite over earlier). */
  layers: PlanSegment[][];
  audio: PlanSegment[];
  /** Visible caption tracks, bottom first; drawn over all picture layers. */
  captions: { trackId: string; style: CaptionStyle; captions: Caption[] }[];
  sources: Record<string, PlanSource>;
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

/**
 * Picture opacity of a segment at an absolute timeline frame. Ramps follow
 * FFmpeg's frame-based fade (value (i - s) / n), so the live preview and the
 * export agree frame by frame.
 */
export function pictureAlpha(seg: PlanSegment, frame: number): number {
  if (frame < seg.renderStart || frame >= seg.renderEnd) return 0;
  const p = seg.props;
  let a = p.opacity;
  if (seg.inH > 0) a *= clamp01((frame - (seg.start - seg.inH)) / (2 * seg.inH));
  if (p.fadeIn > 0) a *= clamp01((frame - seg.start) / p.fadeIn);
  if (p.fadeOut > 0) a *= clamp01(1 - (frame - (seg.start + seg.duration - p.fadeOut)) / p.fadeOut);
  return a;
}

/** Linear audio gain of a segment at a time in frames (fractional allowed). Crossfades ramp both sides. */
export function audioGain(seg: PlanSegment, frame: number): number {
  if (frame < seg.renderStart || frame >= seg.renderEnd) return 0;
  const p = seg.props;
  const end = seg.start + seg.duration;
  let g = Math.pow(10, p.gainDb / 20);
  if (seg.inH > 0) g *= clamp01((frame - (seg.start - seg.inH)) / (2 * seg.inH));
  if (seg.outH > 0) g *= clamp01(1 - (frame - (end - seg.outH)) / (2 * seg.outH));
  if (p.fadeIn > 0) g *= clamp01((frame - seg.start) / p.fadeIn);
  if (p.fadeOut > 0) g *= clamp01(1 - (frame - (end - p.fadeOut)) / p.fadeOut);
  return g;
}

/** Zoom factor at a frame: linear from scale to scaleEnd across the clip. */
export function scaleAt(seg: PlanSegment, frame: number): number {
  const p = seg.props;
  if (p.scaleEnd === null || p.scaleEnd === p.scale) return p.scale;
  const t = seg.duration <= 1 ? 0 : clamp01((frame - seg.start) / (seg.duration - 1));
  return p.scale + (p.scaleEnd - p.scale) * t;
}

export interface Placement {
  /** Region of the source image to draw (source pixels). */
  sx: number;
  sy: number;
  sw: number;
  sh: number;
  /** Size on the output frame before rotation, and the centre point. */
  dw: number;
  dh: number;
  cx: number;
  cy: number;
  /** Radians, clockwise. */
  rotation: number;
}

/**
 * Where a source of size srcW×srcH lands on a W×H frame: crop, fit
 * (cover crops to the frame, contain letterboxes), zoom, rotate, offset.
 */
export function placement(seg: PlanSegment, frame: number, srcW: number, srcH: number, W: number, H: number): Placement {
  const p = seg.props;
  let sx = srcW * p.cropLeft;
  let sy = srcH * p.cropTop;
  let sw = srcW * (1 - p.cropLeft - p.cropRight);
  let sh = srcH * (1 - p.cropTop - p.cropBottom);
  let dw: number;
  let dh: number;
  if (p.fit === "cover") {
    const k = Math.max(W / sw, H / sh);
    const vw = W / k;
    const vh = H / k;
    sx += (sw - vw) / 2;
    sy += (sh - vh) / 2;
    sw = vw;
    sh = vh;
    dw = W;
    dh = H;
  } else {
    const k = Math.min(W / sw, H / sh);
    dw = sw * k;
    dh = sh * k;
  }
  const s = scaleAt(seg, frame);
  return { sx, sy, sw, sh, dw: dw * s, dh: dh * s, cx: W / 2 + p.x * W, cy: H / 2 + p.y * H, rotation: (p.rotation * Math.PI) / 180 };
}

/** Active picture segments at a frame, bottom layer first. Used by the live preview. */
export function activeLayers(plan: RenderPlan, frame: number): PlanSegment[] {
  const out: PlanSegment[] = [];
  for (const layer of plan.layers) for (const seg of layer) if (frame >= seg.renderStart && frame < seg.renderEnd) out.push(seg);
  return out;
}

/**
 * Picture comes from visible video/overlay tracks. Sound comes from unmuted
 * audio tracks and, like in other editors, from the video clips themselves:
 * a video on V1/V2 plays its own sound unless its track is muted (hiding a
 * track hides the picture only; the speaker toggle silences it).
 */
export function buildRenderPlan(t: Timeline): RenderPlan {
  if (t.durationFrames <= 0) throw new ReelForgeError("VALIDATION_ERROR", "the timeline is empty: add clips before rendering");

  const assets = new Map(t.assets.map((a) => [a.id, a]));
  const used = new Set<string>();

  const segmentsFor = (trackId: string): PlanSegment[] => {
    const clips = t.clips.filter((c) => c.trackId === trackId).sort((a, b) => a.start - b.start);
    const segs: PlanSegment[] = clips.map((c) => {
      used.add(c.assetId);
      return {
        clipId: c.id,
        assetId: c.assetId,
        trackId,
        start: c.start,
        duration: c.duration,
        sourceIn: c.sourceIn,
        props: resolveClipProps(c.props),
        renderStart: c.start,
        renderEnd: c.start + c.duration,
        renderSourceIn: c.sourceIn,
        inH: 0,
        outH: 0,
      };
    });
    // Dissolves need source frames beyond each cut ("handles"): the outgoing clip plays on past its
    // out point and the incoming one starts before its in point. Shrink to what the media allows.
    for (let i = 1; i < segs.length; i++) {
      const a = segs[i - 1]!;
      const b = segs[i]!;
      if (b.props.transitionIn < 2 || a.start + a.duration !== b.start) continue;
      const aFrames = assets.get(a.assetId)?.durationFrames ?? null;
      const bFrames = assets.get(b.assetId)?.durationFrames ?? null;
      const handleA = aFrames === null ? Infinity : aFrames - (a.sourceIn + a.duration);
      const handleB = bFrames === null ? Infinity : b.sourceIn;
      const h = Math.max(0, Math.min(Math.floor(b.props.transitionIn / 2), handleA, handleB, a.duration, b.duration));
      if (h === 0) continue;
      a.outH = h;
      a.renderEnd += h;
      b.inH = h;
      b.renderStart -= h;
      b.renderSourceIn -= h;
    }
    return segs;
  };

  const tracks = [...t.tracks].sort((a, b) => b.position - a.position); // bottom → top
  const layers = tracks
    .filter((tr) => (tr.kind === "video" || tr.kind === "overlay") && !tr.hidden)
    .map((tr) => segmentsFor(tr.id))
    .filter((segs) => segs.length > 0);
  const audio = tracks
    .filter((tr) => tr.kind !== "caption" && !tr.muted)
    .flatMap((tr) => segmentsFor(tr.id).filter((seg) => tr.kind === "audio" || !!assets.get(seg.assetId)?.hasAudio));

  const offline = [...used].map((id) => assets.get(id)).filter((a) => !a || a.status === "missing");
  if (offline.length) {
    throw new ReelForgeError("VALIDATION_ERROR", `media offline: ${offline.map((a) => a?.filename ?? "unknown asset").join(", ")}; relink before rendering`, {
      offline: offline.map((a) => a?.id),
    });
  }

  const sources: Record<string, PlanSource> = {};
  for (const id of used) {
    const a = assets.get(id)!;
    sources[id] = { assetId: id, path: a.sourcePath, kind: a.kind, width: a.width, height: a.height };
  }

  return {
    projectId: t.project.id,
    revision: t.project.revision,
    width: t.project.settings.width,
    height: t.project.settings.height,
    fps: t.project.settings.fps,
    totalFrames: t.durationFrames,
    layers,
    audio,
    captions: tracks
      .filter((tr) => tr.kind === "caption" && !tr.hidden)
      .map((tr) => ({
        trackId: tr.id,
        style: resolveCaptionStyle(tr.captionStyle),
        captions: t.captions.filter((c) => c.trackId === tr.id).sort((a, b) => a.start - b.start),
      }))
      .filter((c) => c.captions.length > 0),
    sources,
  };
}
