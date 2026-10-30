// The canonical render graph (PRD FR-017). Preview and export are both
// compiled from this plan, so what you preview is what you export: they differ
// only in output size and whether proxies stand in for the originals.

import { ReelForgeError } from "./errors.ts";
import type { Timeline } from "./schema.ts";
import type { Rational } from "./timebase.ts";

export interface PlanSource {
  assetId: string;
  path: string;
  kind: "video" | "audio" | "image";
}

export interface PlanVideoSegment {
  assetId: string;
  trackId: string;
  /** Project frames. */
  start: number;
  duration: number;
  sourceIn: number;
}

export interface PlanAudioSegment {
  assetId: string;
  trackId: string;
  start: number;
  duration: number;
  sourceIn: number;
}

export interface RenderPlan {
  projectId: string;
  revision: number;
  width: number;
  height: number;
  fps: Rational;
  totalFrames: number;
  /** Picture layers, bottom first (later layers composite over earlier ones). */
  layers: PlanVideoSegment[][];
  audio: PlanAudioSegment[];
  sources: Record<string, PlanSource>;
}

/**
 * Picture comes only from visible video/overlay tracks and sound only from
 * unmuted audio tracks, so camera audio never sneaks into a mix: to use a
 * video's sound, place it on an audio track.
 */
export function buildRenderPlan(t: Timeline): RenderPlan {
  if (t.durationFrames <= 0) throw new ReelForgeError("VALIDATION_ERROR", "the timeline is empty: add clips before rendering");

  const assets = new Map(t.assets.map((a) => [a.id, a]));
  const used = new Set<string>();
  const byTrack = (trackId: string) =>
    t.clips
      .filter((c) => c.trackId === trackId)
      .sort((a, b) => a.start - b.start)
      .map((c) => {
        used.add(c.assetId);
        return { assetId: c.assetId, trackId, start: c.start, duration: c.duration, sourceIn: c.sourceIn };
      });

  const tracks = [...t.tracks].sort((a, b) => b.position - a.position); // bottom → top
  const layers = tracks
    .filter((tr) => (tr.kind === "video" || tr.kind === "overlay") && !tr.hidden)
    .map((tr) => byTrack(tr.id))
    .filter((segs) => segs.length > 0);
  const audio = tracks.filter((tr) => tr.kind === "audio" && !tr.muted).flatMap((tr) => byTrack(tr.id));

  const offline = [...used].map((id) => assets.get(id)).filter((a) => !a || a.status === "missing");
  if (offline.length) {
    throw new ReelForgeError("VALIDATION_ERROR", `media offline: ${offline.map((a) => a?.filename ?? "unknown asset").join(", ")}; relink before rendering`, {
      offline: offline.map((a) => a?.id),
    });
  }

  const sources: Record<string, PlanSource> = {};
  for (const id of used) {
    const a = assets.get(id)!;
    sources[id] = { assetId: id, path: a.sourcePath, kind: a.kind };
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
    sources,
  };
}
