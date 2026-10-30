// The structured view of a project that an AI planner (M4, MCP clients) reads
// before proposing edits. Times are given in project frames (what operations
// use) and seconds (what people and models reason in).

import type { Analysis, BeatsResult, ScenesResult, Timeline, TranscriptResult } from "./schema.ts";
import { trackLabels } from "./schema.ts";
import { microsToFrames } from "./timebase.ts";

const MAX_BEATS = 600;
const MAX_CUTS = 300;

export interface ProjectContext {
  schema: "reelforge.project-context/1";
  project: { id: string; name: string; revision: number; width: number; height: number; fps: { num: number; den: number }; durationFrames: number; durationSeconds: number };
  assets: {
    id: string;
    filename: string;
    kind: string;
    status: string;
    durationFrames: number | null;
    durationSeconds: number | null;
    width: number | null;
    height: number | null;
    hasAudio: boolean;
    analysis: {
      scenes?: { state: string; stale: boolean; cutsSeconds?: number[] };
      beats?: { state: string; stale: boolean; bpm?: number; confidence?: number; beatsSeconds?: number[] };
      transcript?: { state: string; stale: boolean; language?: string; text?: string; segments?: { startSeconds: number; endSeconds: number; text: string }[] };
    };
  }[];
  timeline: {
    tracks: { id: string; label: string; kind: string; name: string; muted: boolean; hidden: boolean; locked: boolean }[];
    clips: { id: string; track: string; assetId: string; filename: string; start: number; duration: number; sourceIn: number; startSeconds: number; durationSeconds: number; props: Record<string, unknown> }[];
    captions: { id: string; track: string; start: number; duration: number; startSeconds: number; text: string }[];
  };
  /** Operation types the engine accepts in a proposal / batch. */
  operations: string[];
}

const round = (x: number) => Math.round(x * 1000) / 1000;

export function buildProjectContext(t: Timeline, analyses: ReadonlyMap<string, Analysis[]>, operations: readonly string[]): ProjectContext {
  const { fps } = t.project.settings;
  const sec = (frames: number) => round((frames * fps.den) / fps.num);
  const usToSec = (us: number) => round(us / 1_000_000);
  const labels = trackLabels(t.tracks);
  const assetName = new Map(t.assets.map((a) => [a.id, a.filename]));

  return {
    schema: "reelforge.project-context/1",
    project: {
      id: t.project.id,
      name: t.project.name,
      revision: t.project.revision,
      width: t.project.settings.width,
      height: t.project.settings.height,
      fps,
      durationFrames: t.durationFrames,
      durationSeconds: sec(t.durationFrames),
    },
    assets: t.assets.map((a) => {
      const byKind = new Map((analyses.get(a.id) ?? []).map((x) => [x.kind, x]));
      const scenes = byKind.get("scenes") as Analysis<"scenes"> | undefined;
      const beats = byKind.get("beats") as Analysis<"beats"> | undefined;
      const transcript = byKind.get("transcript") as Analysis<"transcript"> | undefined;
      const sr: ScenesResult | null = scenes?.result ?? null;
      const br: BeatsResult | null = beats?.result ?? null;
      const tr: TranscriptResult | null = transcript?.result ?? null;
      return {
        id: a.id,
        filename: a.filename,
        kind: a.kind,
        status: a.status,
        durationFrames: a.durationFrames,
        durationSeconds: a.durationUs === null ? null : usToSec(a.durationUs),
        width: a.width,
        height: a.height,
        hasAudio: a.hasAudio,
        analysis: {
          ...(scenes ? { scenes: { state: scenes.state, stale: scenes.stale, ...(sr ? { cutsSeconds: sr.cuts.slice(0, MAX_CUTS).map((c) => usToSec(c.timeUs)) } : {}) } } : {}),
          ...(beats
            ? { beats: { state: beats.state, stale: beats.stale, ...(br ? { bpm: br.bpm, confidence: br.confidence, beatsSeconds: br.beatsUs.slice(0, MAX_BEATS).map(usToSec) } : {}) } }
            : {}),
          ...(transcript
            ? {
                transcript: {
                  state: transcript.state,
                  stale: transcript.stale,
                  ...(tr
                    ? { language: tr.language, text: tr.text, segments: tr.segments.map((s) => ({ startSeconds: usToSec(s.startUs), endSeconds: usToSec(s.endUs), text: s.text })) }
                    : {}),
                },
              }
            : {}),
        },
      };
    }),
    timeline: {
      tracks: t.tracks.map((tr) => ({ id: tr.id, label: labels.get(tr.id) ?? "", kind: tr.kind, name: tr.name, muted: tr.muted, hidden: tr.hidden, locked: tr.locked })),
      clips: t.clips.map((c) => ({
        id: c.id,
        track: labels.get(c.trackId) ?? c.trackId,
        assetId: c.assetId,
        filename: assetName.get(c.assetId) ?? "",
        start: c.start,
        duration: c.duration,
        sourceIn: c.sourceIn,
        startSeconds: sec(c.start),
        durationSeconds: sec(c.duration),
        props: { ...c.props },
      })),
      captions: t.captions.map((c) => ({ id: c.id, track: labels.get(c.trackId) ?? c.trackId, start: c.start, duration: c.duration, startSeconds: sec(c.start), text: c.text })),
    },
    operations: [...operations],
  };
}

/** Beat times of an asset mapped onto the timeline through a clip (for snapping and beat-cut suggestions). */
export function beatsOnTimeline(clip: { start: number; duration: number; sourceIn: number }, beats: BeatsResult, fps: { num: number; den: number }): number[] {
  return beats.beatsUs
    .map((us) => microsToFrames(us, fps, "nearest"))
    .filter((f) => f >= clip.sourceIn && f < clip.sourceIn + clip.duration)
    .map((f) => clip.start + f - clip.sourceIn);
}

