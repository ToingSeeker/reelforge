// Moving clips on the timeline by drag: the selection moves as one group, by the same time delta
// and the same number of tracks, and is committed as one batch of clip.move ops (one undo step).

import type { Clip, TimelineOp, Track } from "@reelforge/core/schema";
import { canPlace, type AssetInfo } from "@reelforge/core/timeline-ops";

export interface GroupMove {
  group: readonly Clip[];
  offset: number;
}

/** A pointer that went more than 3 px sideways, or carried the clip to another track, made a move (not a click). */
export function dragMoved(already: boolean, dx: number, offset: number): boolean {
  return already || Math.abs(dx) > 3 || offset !== 0;
}

/** The track a clip lands on when its group is shifted `offset` tracks; null when that track can't take it. */
export function shiftedTrack(tracks: readonly Track[], assets: ReadonlyMap<string, AssetInfo>, clip: Clip, offset: number): Track | null {
  const i = tracks.findIndex((t) => t.id === clip.trackId);
  const t = i < 0 ? undefined : tracks[i + offset];
  const asset = assets.get(clip.assetId);
  if (!t || !asset || (offset !== 0 && t.locked) || !canPlace(asset, t.kind)) return null;
  return t;
}

/** Where a clip is drawn during a drag (its own track unless a move drag carries it elsewhere). */
export function dragTrackId(move: GroupMove | null, tracks: readonly Track[], assets: ReadonlyMap<string, AssetInfo>, clip: Clip): string {
  if (!move || move.offset === 0 || !move.group.some((g) => g.id === clip.id)) return clip.trackId;
  return shiftedTrack(tracks, assets, clip, move.offset)?.id ?? clip.trackId;
}

/**
 * One clip.move per moved clip, ordered so no clip lands on a spot another group member still occupies:
 * the engine checks overlaps op by op, so the clips furthest along the move go first.
 */
export function groupMoveOps(tracks: readonly Track[], assets: ReadonlyMap<string, AssetInfo>, group: readonly Clip[], delta: number, offset: number): TimelineOp[] {
  // All or nothing: if one clip can't take the track shift, the group keeps its tracks.
  if (offset && !group.every((c) => shiftedTrack(tracks, assets, c, offset))) offset = 0;
  const index = new Map(tracks.map((t, i) => [t.id, i]));
  const ordered = [...group].sort(
    (a, b) => Math.sign(offset) * (index.get(b.trackId)! - index.get(a.trackId)!) || Math.sign(delta) * (b.start - a.start),
  );
  const ops: TimelineOp[] = [];
  for (const c of ordered) {
    const trackId = shiftedTrack(tracks, assets, c, offset)?.id ?? c.trackId;
    if (delta === 0 && trackId === c.trackId) continue;
    ops.push({ type: "clip.move", clipId: c.id, start: c.start + delta, ...(trackId !== c.trackId ? { trackId } : {}) });
  }
  return ops;
}
