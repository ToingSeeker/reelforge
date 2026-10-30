// Pure timeline edit semantics, shared by the engine and (for previews) the UI.
// No I/O: takes a state, returns a new state or throws a ReelForgeError, so a
// rejected batch can never leave a half-applied timeline (FR-015, FR-018).

import { ReelForgeError } from "./errors.ts";
import type { Asset, Clip, TimelineOp, Track, TrackKind } from "./schema.ts";
import { MAX_FRAME } from "./schema.ts";
import { secondsToFrames, type Rational } from "./timebase.ts";

export type AssetInfo = Pick<Asset, "id" | "kind" | "durationFrames" | "hasVideo" | "hasAudio">;

export interface EditState {
  fps: Rational;
  tracks: ReadonlyMap<string, Track>;
  clips: ReadonlyMap<string, Clip>;
  assets: ReadonlyMap<string, AssetInfo>;
}

export const DEFAULT_STILL_SECONDS = 3;

function fail(message: string, details: Record<string, unknown> = {}): never {
  throw new ReelForgeError("VALIDATION_ERROR", message, details);
}

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

class Draft {
  readonly tracks: Map<string, Track>;
  readonly clips: Map<string, Clip>;
  readonly state: EditState;

  constructor(state: EditState) {
    this.state = state;
    this.tracks = new Map(state.tracks);
    this.clips = new Map(state.clips);
  }

  track(id: string): Track {
    return this.tracks.get(id) ?? fail(`track ${id} not found`, { trackId: id });
  }

  clip(id: string): Clip {
    return this.clips.get(id) ?? fail(`clip ${id} not found`, { clipId: id });
  }

  asset(id: string): AssetInfo {
    return this.state.assets.get(id) ?? fail(`asset ${id} not found in this project`, { assetId: id });
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
      fail(`a ${asset.kind} asset cannot go on the ${track.kind} track "${track.name}"`, { clipId: c.id, trackId: track.id });
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

  put(c: Clip): void {
    this.clips.set(c.id, c);
    this.check(c);
  }
}

function apply(d: Draft, op: TimelineOp, newId: () => string): void {
  switch (op.type) {
    case "clip.add": {
      d.unlocked(op.trackId);
      const asset = d.asset(op.assetId);
      const sourceIn = op.sourceIn ?? 0;
      const duration =
        op.duration ??
        (asset.durationFrames === null
          ? secondsToFrames(DEFAULT_STILL_SECONDS, d.state.fps)
          : asset.durationFrames - sourceIn);
      const id = op.clipId ?? newId();
      if (d.clips.has(id)) fail(`clip ${id} already exists`, { clipId: id });
      d.put({ id, trackId: op.trackId, assetId: op.assetId, start: op.start, duration, sourceIn });
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
        d.put({ ...c, start: op.frame, sourceIn: c.sourceIn + delta, duration: c.duration - delta });
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
      d.put({ ...c, duration: left });
      d.put({ ...c, id, start: op.frame, sourceIn: c.sourceIn + left, duration: c.duration - left });
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
      const { type: _type, trackId: _id, ...patch } = op;
      d.tracks.set(t.id, { ...t, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) });
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
  return { ...state, tracks: d.tracks, clips: d.clips };
}

export interface RowChange<T> {
  id: string;
  before: T | null;
  after: T | null;
}

export interface TimelineDiff {
  tracks: RowChange<Track>[];
  clips: RowChange<Clip>[];
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
  return { tracks: diffMap(a.tracks, b.tracks), clips: diffMap(a.clips, b.clips) };
}

export const isEmptyDiff = (d: TimelineDiff) => d.tracks.length === 0 && d.clips.length === 0;
