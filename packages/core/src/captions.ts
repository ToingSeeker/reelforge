// Turning transcripts into captions, and captions into SRT. Pure functions:
// the engine feeds them stored transcripts and applies the result as one
// undoable `captions.replace` operation.

import type { Caption, Timeline, TranscriptResult } from "./schema.ts";
import { microsToFrames, type Rational } from "./timebase.ts";

export interface CaptionGenOptions {
  /** Tracks whose clips' sound is captioned (default: every unmuted track with sound: audio, and video/overlay). */
  sourceTrackIds?: string[];
  /** Words per caption (reels read best with 2–4). */
  maxWords?: number;
  maxChars?: number;
  /** A pause at least this long starts a new caption. */
  breakOnPauseMs?: number;
}

export interface GeneratedCaption {
  start: number;
  duration: number;
  text: string;
  words: { text: string; start: number; end: number }[];
}

interface TimedWord {
  text: string;
  start: number; // timeline frames
  end: number;
}

/**
 * Lay transcript words onto the timeline: each word is placed where the clip
 * that contains it plays it (source time → timeline time), words cut away by a
 * trim are dropped, then words are grouped into short captions, breaking at
 * sentence punctuation, long pauses and the word/character limits.
 */
/**
 * With voice detection on, whisper.cpp places a segment correctly but its words ~0.25 s early
 * (measured against the waveform). A word can't start before its segment: this is how far to
 * slide a segment's words back (0 when they already start inside it).
 */
export function wordLeadUs(seg: TranscriptResult["segments"][number]): number {
  return Math.max(0, seg.startUs - (seg.words[0]?.startUs ?? seg.startUs));
}

/** Tracks whose clips are heard: unmuted audio tracks and unmuted video/overlay tracks (videos play their own sound). */
export function soundTracks(timeline: Pick<Timeline, "tracks">) {
  return timeline.tracks.filter((t) => t.kind !== "caption" && !t.muted);
}

export function generateCaptions(
  timeline: Timeline,
  transcripts: ReadonlyMap<string, TranscriptResult>,
  opts: CaptionGenOptions = {},
): GeneratedCaption[] {
  const fps: Rational = timeline.project.settings.fps;
  const maxWords = opts.maxWords ?? 3;
  const maxChars = opts.maxChars ?? 18;
  const pause = microsToFrames((opts.breakOnPauseMs ?? 450) * 1000, fps, "nearest");
  const sources = new Set(opts.sourceTrackIds ?? soundTracks(timeline).map((t) => t.id));

  const words: TimedWord[] = [];
  for (const clip of timeline.clips) {
    if (!sources.has(clip.trackId)) continue;
    const tr = transcripts.get(clip.assetId);
    if (!tr) continue;
    for (const seg of tr.segments) {
      const lead = wordLeadUs(seg);
      for (const w of seg.words) {
        const s = microsToFrames(w.startUs + lead, fps, "nearest");
        const e = Math.max(s + 1, microsToFrames(w.endUs + lead, fps, "nearest"));
        // Keep words whose middle survives the trim.
        const mid = (s + e) / 2;
        if (mid < clip.sourceIn || mid >= clip.sourceIn + clip.duration) continue;
        const start = clip.start + Math.max(0, s - clip.sourceIn);
        const end = clip.start + Math.min(clip.duration, e - clip.sourceIn);
        words.push({ text: w.text.trim(), start, end: Math.max(start + 1, end) });
      }
    }
  }
  words.sort((a, b) => a.start - b.start);

  const groups: TimedWord[][] = [];
  let cur: TimedWord[] = [];
  for (const w of words.filter((w) => w.text)) {
    const prev = cur[cur.length - 1];
    const chars = cur.reduce((n, x) => n + x.text.length + 1, 0) + w.text.length;
    const breakHere = prev && (cur.length >= maxWords || chars > maxChars || w.start - prev.end >= pause || /[.!?…]$/.test(prev.text));
    if (breakHere) {
      groups.push(cur);
      cur = [];
    }
    cur.push(w);
  }
  if (cur.length) groups.push(cur);

  const out: GeneratedCaption[] = [];
  groups.forEach((g, i) => {
    const start = g[0]!.start;
    let end = g[g.length - 1]!.end;
    // Hold a caption until the next one if the gap is short, so text doesn't flicker off and on.
    const next = groups[i + 1]?.[0]?.start;
    if (next !== undefined && next - end < pause) end = next;
    if (next !== undefined) end = Math.min(end, next);
    const duration = Math.max(1, end - start);
    out.push({
      start,
      duration,
      text: g.map((w) => w.text).join(" "),
      words: g.map((w) => ({ text: w.text, start: w.start - start, end: Math.min(duration, w.end - start) })),
    });
  });
  return out;
}

function srtTime(frames: number, fps: Rational): string {
  const ms = Math.round((frames * fps.den * 1000) / fps.num);
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(Math.floor(ms / 3_600_000))}:${p(Math.floor(ms / 60_000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`;
}

/** SubRip export of one caption track (PRD §10, optional). */
export function captionsToSrt(captions: readonly Caption[], fps: Rational): string {
  return [...captions]
    .sort((a, b) => a.start - b.start)
    .map((c, i) => `${i + 1}\n${srtTime(c.start, fps)} --> ${srtTime(c.start + c.duration, fps)}\n${c.text}\n`)
    .join("\n");
}

export interface CaptionPlan {
  trackId: string;
  /** Source assets that still need a (fresh) transcript. */
  missing: { assetId: string; filename: string; state: string | null }[];
  captions: GeneratedCaption[];
}
