// Pure timeline edit semantics, shared by the engine and (for previews) the UI.
// No I/O: takes a state, returns a new state or throws a ReelForgeError, so a
// rejected batch can never leave a half-applied timeline (FR-015, FR-018).

import { ReelForgeError } from "./errors.ts";
import type { Asset, Caption, CaptionWord, Clip, ClipPropsPatch, TimelineOp, Track, TrackKind } from "./schema.ts";
import { DEFAULT_CLIP_PROPS, MAX_FRAME, sparseClipProps } from "./schema.ts";
import { secondsToFrames, type Rational } from "./timebase.ts";

export type AssetInfo = Pick<Asset, "id" | "kind" | "durationFrames" | "hasVideo" | "hasAudio">;

export interface EditState {
  fps: Rational;
  tracks: ReadonlyMap<string, Track>;
  clips: ReadonlyMap<string, Clip>;
  captions: ReadonlyMap<string, Caption>;
  assets: ReadonlyMap<string, AssetInfo>;
}

export const DEFAULT_STILL_SECONDS = 3;

function fail(message: string, details: Record<string, unknown> = {}): never {
  throw new ReelForgeError("VALIDATION_ERROR", message, details);
}

function notFound(message: string, details: Record<string, unknown>): never {
  throw new ReelForgeError("NOT_FOUND", message, details);
}

const article = (word: string) => (/^[aeiou]/i.test(word) ? "an" : "a");

/** Props that only change the picture: meaningless on a clip that only plays sound. */
const PICTURE_PROPS = [
  "fit", "scale", "scaleEnd", "x", "y", "xEnd", "yEnd", "rotation", "opacity", "cropLeft", "cropTop", "cropRight", "cropBottom",
  "blur", "sharpen", "vignette", "grayscale", "sepia", "grain", "aiEffects",
] as const;

export function canPlace(asset: AssetInfo, track: TrackKind): boolean {
  switch (track) {
    case "video":
    case "overlay":
      return asset.kind === "image" || (asset.kind === "video" && asset.hasVideo);
    case "audio":
      return asset.kind === "audio" || (asset.kind === "video" && asset.hasAudio);
    case "caption":
      return false;
  }
}

export const clipEnd = (c: Clip) => c.start + c.duration;

/**
 * Fades and transitions shrink with the clip instead of blocking a trim. When both fades no
 * longer fit, they share the clip in proportion, so neither one silently disappears.
 */
function fitProps(p: ClipPropsPatch, duration: number): ClipPropsPatch {
  const out = { ...p };
  const fadeIn = out.fadeIn ?? 0;
  const fadeOut = out.fadeOut ?? 0;
  if (fadeIn + fadeOut > duration) {
    if (fadeIn > 0 && fadeOut > 0) {
      out.fadeIn = Math.floor((fadeIn * duration) / (fadeIn + fadeOut));
      out.fadeOut = duration - out.fadeIn;
    } else if (fadeIn > 0) out.fadeIn = duration;
    else out.fadeOut = duration;
  }
  if (out.transitionIn !== undefined) out.transitionIn = Math.min(out.transitionIn, duration);
  if (out.scaleEnd === null) delete out.scaleEnd;
  return sparseClipProps(out);
}

/** Spread words evenly when only the text is known (manual edits), so highlighting keeps working. */
export function evenWords(text: string, duration: number): CaptionWord[] {
  const parts = text.split(/\s+/).filter(Boolean);
  return parts.map((w, i) => ({
    text: w,
    start: Math.floor((i * duration) / parts.length),
    end: Math.floor(((i + 1) * duration) / parts.length),
  }));
}

class Draft {
  readonly tracks: Map<string, Track>;
  readonly clips: Map<string, Clip>;
  readonly captions: Map<string, Caption>;
  readonly state: EditState;

  constructor(state: EditState) {
    this.state = state;
    this.tracks = new Map(state.tracks);
    this.clips = new Map(state.clips);
    this.captions = new Map(state.captions);
  }

  caption(id: string): Caption {
    return this.captions.get(id) ?? notFound(`caption ${id} not found`, { captionId: id });
  }

  putCaption(c: Caption): void {
    const track = this.track(c.trackId);
    if (track.kind !== "caption") fail(`captions go on a caption track, not "${track.name}"`, { captionId: c.id });
    if (c.start + c.duration > MAX_FRAME) fail("caption would extend past the maximum timeline length", { captionId: c.id });
    // Word timings stay inside the caption and in order; out-of-range ones are clamped, not rejected.
    const words = c.words
      .map((w) => ({ text: w.text, start: Math.min(Math.max(0, w.start), c.duration), end: Math.min(Math.max(0, w.end), c.duration) }))
      .map((w) => ({ ...w, end: Math.max(w.start, w.end) }))
      .sort((a, b) => a.start - b.start);
    const fixed = { ...c, words };
    for (const other of this.captions.values()) {
      if (other.id !== c.id && other.trackId === c.trackId && other.start < c.start + c.duration && c.start < other.start + other.duration) {
        fail(`caption would overlap another caption on "${track.name}"`, { captionId: c.id, overlaps: other.id });
      }
    }
    this.captions.set(c.id, fixed);
  }

  track(id: string): Track {
    return this.tracks.get(id) ?? notFound(`track ${id} not found`, { trackId: id });
  }

  clip(id: string): Clip {
    return this.clips.get(id) ?? notFound(`clip ${id} not found`, { clipId: id });
  }

  asset(id: string): AssetInfo {
    return this.state.assets.get(id) ?? notFound(`asset ${id} not found in this project`, { assetId: id });
  }

  unlocked(trackId: string): Track {
    const t = this.track(trackId);
    if (t.locked) fail(`track "${t.name}" is locked`, { trackId });
    return t;
  }

  /** Every invariant a stored clip must satisfy. */
  check(c: Clip): void {
    const track = this.track(c.trackId);
    const asset = this.asset(c.assetId);
    if (!canPlace(asset, track.kind)) {
      fail(`${article(asset.kind)} ${asset.kind} asset cannot go on the ${track.kind} track "${track.name}"`, { clipId: c.id, trackId: track.id });
    }
    if (!Number.isInteger(c.start) || c.start < 0) fail("clip would start before 00:00", { clipId: c.id });
    if (!Number.isInteger(c.duration) || c.duration < 1) fail("clip must be at least one frame long", { clipId: c.id });
    if (c.sourceIn < 0) fail("trim would extend before the start of the source media", { clipId: c.id });
    if (clipEnd(c) > MAX_FRAME) fail("clip would extend past the maximum timeline length", { clipId: c.id });
    if (asset.durationFrames !== null && c.sourceIn + c.duration > asset.durationFrames) {
      fail("clip would extend past the end of the source media", {
        clipId: c.id,
        sourceIn: c.sourceIn,
        duration: c.duration,
        sourceFrames: asset.durationFrames,
      });
    }
    for (const other of this.clips.values()) {
      if (other.id !== c.id && other.trackId === c.trackId && other.start < clipEnd(c) && c.start < clipEnd(other)) {
        fail(`clip would overlap another clip on "${track.name}"`, { clipId: c.id, overlaps: other.id });
      }
    }
  }

  /** Refuse props the clip can't show or play (a blur on a sound-only clip, AI effects on a still). */
  checkPatch(c: Clip, patch: ClipPropsPatch): void {
    const track = this.track(c.trackId);
    const asset = this.asset(c.assetId);
    const set = (k: keyof ClipPropsPatch) => {
      const v = patch[k];
      if (v === undefined || JSON.stringify(v) === JSON.stringify(DEFAULT_CLIP_PROPS[k])) return false;
      return true;
    };
    if (track.kind !== "video" && track.kind !== "overlay") {
      const picture = PICTURE_PROPS.filter(set);
      if (picture.length) {
        fail(`${picture.join(", ")} only ${picture.length === 1 ? "applies" : "apply"} to picture clips (video or overlay tracks); "${track.name}" only plays sound`, {
          clipId: c.id,
          props: picture,
        });
      }
    } else if (set("aiEffects") && asset.kind !== "video") {
      fail(`AI effects work on video clips only, not on ${article(asset.kind)} ${asset.kind}`, { clipId: c.id });
    }
  }

  put(c: Clip): void {
    const fixed = { ...c, props: fitProps(c.props, c.duration) };
    this.clips.set(c.id, fixed);
    this.check(fixed);
  }
}

function apply(d: Draft, op: TimelineOp, newId: () => string): void {
  switch (op.type) {
    case "clip.add": {
      d.unlocked(op.trackId);
      const asset = d.asset(op.assetId);
      const sourceIn = op.sourceIn ?? 0;
      if (asset.durationFrames !== null && sourceIn >= asset.durationFrames) {
        fail(`in point ${sourceIn} is past the end of the source media (${asset.durationFrames} frames)`, { sourceIn, sourceFrames: asset.durationFrames });
      }
      const duration =
        op.duration ??
        (asset.durationFrames === null
          ? secondsToFrames(DEFAULT_STILL_SECONDS, d.state.fps)
          : asset.durationFrames - sourceIn);
      const id = op.clipId ?? newId();
      if (d.clips.has(id)) fail(`clip ${id} already exists`, { clipId: id });
      const clip = { id, trackId: op.trackId, assetId: op.assetId, start: op.start, duration, sourceIn, props: op.props ?? {} };
      d.checkPatch(clip, clip.props);
      d.put(clip);
      return;
    }
    case "clip.update": {
      const c = d.clip(op.clipId);
      d.unlocked(c.trackId);
      d.checkPatch(c, op.props);
      d.put({ ...c, props: { ...c.props, ...op.props } });
      return;
    }
    case "clip.move": {
      const c = d.clip(op.clipId);
      d.unlocked(c.trackId);
      const trackId = op.trackId ?? c.trackId;
      d.unlocked(trackId);
      d.put({ ...c, start: op.start, trackId });
      return;
    }
    case "clip.trim": {
      const c = d.clip(op.clipId);
      d.unlocked(c.trackId);
      if (op.edge === "start") {
        if (op.frame >= clipEnd(c)) fail("trim start must stay before the clip end", { clipId: c.id });
        const delta = op.frame - c.start;
        // A still has no source time: its start can move anywhere, there is nothing "before" it.
        const still = d.asset(c.assetId).kind === "image";
        d.put({ ...c, start: op.frame, sourceIn: still ? Math.max(0, c.sourceIn + delta) : c.sourceIn + delta, duration: c.duration - delta });
      } else {
        if (op.frame <= c.start) fail("trim end must stay after the clip start", { clipId: c.id });
        d.put({ ...c, duration: op.frame - c.start });
      }
      return;
    }
    case "clip.split": {
      const c = d.clip(op.clipId);
      d.unlocked(c.trackId);
      if (op.frame <= c.start || op.frame >= clipEnd(c)) {
        fail("split point must be inside the clip", { clipId: c.id, frame: op.frame, start: c.start, end: clipEnd(c) });
      }
      const left = op.frame - c.start;
      const id = op.newClipId ?? newId();
      if (d.clips.has(id)) fail(`clip ${id} already exists`, { clipId: id });
      // The left half keeps the entry (fade in, incoming transition), the right half the exit (fade out).
      const { fadeOut, ...leftProps } = c.props;
      const { fadeIn: _fi, transitionIn: _ti, ...rightProps } = c.props;
      d.put({ ...c, duration: left, props: leftProps });
      d.put({ ...c, id, start: op.frame, sourceIn: c.sourceIn + left, duration: c.duration - left, props: { ...rightProps, ...(fadeOut ? { fadeOut } : {}) } });
      return;
    }
    case "clip.delete": {
      const targets = [...new Set(op.clipIds)].map((id) => d.clip(id));
      for (const c of targets) d.unlocked(c.trackId);
      for (const c of targets) d.clips.delete(c.id);
      if (op.ripple) {
        // Latest gap first, so each shift only moves clips that are still to its right.
        for (const gone of targets.sort((a, b) => b.start - a.start)) {
          for (const c of [...d.clips.values()]) {
            if (c.trackId === gone.trackId && c.start >= clipEnd(gone)) d.clips.set(c.id, { ...c, start: c.start - gone.duration });
          }
        }
        for (const c of d.clips.values()) if (targets.some((t) => t.trackId === c.trackId)) d.check(c);
      }
      return;
    }
    case "track.update": {
      const t = d.track(op.trackId);
      const { type: _type, trackId: _id, captionStyle, ...patch } = op;
      const next: Track = { ...t, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) };
      if (captionStyle) {
        if (t.kind !== "caption") fail("captionStyle only applies to caption tracks", { trackId: t.id });
        next.captionStyle = { ...t.captionStyle, ...captionStyle };
      }
      d.tracks.set(t.id, next);
      return;
    }
    case "caption.add": {
      d.unlocked(op.trackId);
      const id = op.captionId ?? newId();
      if (d.captions.has(id)) fail(`caption ${id} already exists`, { captionId: id });
      d.putCaption({ id, trackId: op.trackId, start: op.start, duration: op.duration, text: op.text, words: op.words ?? evenWords(op.text, op.duration) });
      return;
    }
    case "caption.update": {
      const c = d.caption(op.captionId);
      d.unlocked(c.trackId);
      const text = op.text ?? c.text;
      const duration = op.duration ?? c.duration;
      // New text without new timings: the old word timings no longer line up, so spread evenly.
      const words = op.words ?? (op.text !== undefined && op.text !== c.text ? evenWords(text, duration) : c.words);
      d.putCaption({ ...c, text, start: op.start ?? c.start, duration, words });
      return;
    }
    case "caption.delete": {
      const targets = [...new Set(op.captionIds)].map((id) => d.caption(id));
      for (const c of targets) d.unlocked(c.trackId);
      for (const c of targets) d.captions.delete(c.id);
      return;
    }
    case "captions.replace": {
      d.unlocked(op.trackId);
      if (d.track(op.trackId).kind !== "caption") fail("captions go on a caption track", { trackId: op.trackId });
      for (const c of [...d.captions.values()]) if (c.trackId === op.trackId) d.captions.delete(c.id);
      for (const c of op.captions) {
        d.putCaption({ id: c.captionId ?? newId(), trackId: op.trackId, start: c.start, duration: c.duration, text: c.text, words: c.words ?? evenWords(c.text, c.duration) });
      }
      return;
    }
  }
}

/** Apply a batch atomically. Errors carry the index of the operation that failed. */
export function applyOperations(
  state: EditState,
  ops: readonly TimelineOp[],
  newId: () => string = () => globalThis.crypto.randomUUID(),
): EditState {
  const d = new Draft(state);
  ops.forEach((op, i) => {
    try {
      apply(d, op, newId);
    } catch (e) {
      if (e instanceof ReelForgeError) {
        throw new ReelForgeError(e.code, `operation ${i + 1} (${op.type}): ${e.message}`, { ...e.details, opIndex: i });
      }
      throw e;
    }
  });
  return { ...state, tracks: d.tracks, clips: d.clips, captions: d.captions };
}

export interface RowChange<T> {
  id: string;
  before: T | null;
  after: T | null;
}

export interface TimelineDiff {
  tracks: RowChange<Track>[];
  clips: RowChange<Clip>[];
  /** Absent in diffs recorded before captions existed. */
  captions?: RowChange<Caption>[];
}

function diffMap<T extends { id: string }>(a: ReadonlyMap<string, T>, b: ReadonlyMap<string, T>): RowChange<T>[] {
  const out: RowChange<T>[] = [];
  for (const [id, before] of a) {
    const after = b.get(id) ?? null;
    if (!after || JSON.stringify(before) !== JSON.stringify(after)) out.push({ id, before, after });
  }
  for (const [id, after] of b) if (!a.has(id)) out.push({ id, before: null, after });
  return out;
}

export function diffStates(a: EditState, b: EditState): TimelineDiff {
  return { tracks: diffMap(a.tracks, b.tracks), clips: diffMap(a.clips, b.clips), captions: diffMap(a.captions, b.captions) };
}

export const isEmptyDiff = (d: TimelineDiff) => d.tracks.length === 0 && d.clips.length === 0 && !d.captions?.length;
