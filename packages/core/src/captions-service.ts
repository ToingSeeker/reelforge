import type { Database } from "./db.ts";
import { ReelForgeError } from "./errors.ts";
import { AnalysisStore } from "./analyses.ts";
import { generateCaptions, type CaptionGenOptions, type CaptionPlan } from "./captions.ts";
import { TimelineStore } from "./timeline.ts";
import type { TranscriptResult } from "./schema.ts";

/**
 * Work out captions for a project from stored transcripts. If any source clip's
 * asset has no fresh transcript, it is reported in `missing` (the caller
 * transcribes and asks again) instead of silently captioning half the speech.
 */
export function planCaptions(db: Database, projectId: string, opts: CaptionGenOptions & { trackId?: string } = {}): CaptionPlan {
  const tl = new TimelineStore(db).get(projectId);
  const track = opts.trackId ? tl.tracks.find((t) => t.id === opts.trackId) : tl.tracks.find((t) => t.kind === "caption");
  if (!track || track.kind !== "caption") throw new ReelForgeError("VALIDATION_ERROR", "no caption track to write to", { trackId: opts.trackId });
  const sources = new Set(opts.sourceTrackIds ?? tl.tracks.filter((t) => t.kind === "audio" && !t.muted).map((t) => t.id));
  for (const id of sources) {
    const t = tl.tracks.find((x) => x.id === id);
    if (!t || t.kind !== "audio") throw new ReelForgeError("VALIDATION_ERROR", "caption sources must be audio tracks", { trackId: id });
  }
  const assetIds = [...new Set(tl.clips.filter((c) => sources.has(c.trackId)).map((c) => c.assetId))];
  if (!assetIds.length) throw new ReelForgeError("VALIDATION_ERROR", "no clips on the source audio tracks to caption");

  const store = new AnalysisStore(db);
  const transcripts = new Map<string, TranscriptResult>();
  const missing: CaptionPlan["missing"] = [];
  for (const id of assetIds) {
    const a = store.latest(projectId, id, "transcript");
    if (a?.state === "completed" && a.result && !a.stale) transcripts.set(id, a.result);
    else missing.push({ assetId: id, filename: tl.assets.find((x) => x.id === id)?.filename ?? id, state: a?.state ?? null });
  }
  return { trackId: track.id, missing, captions: missing.length ? [] : generateCaptions(tl, transcripts, { ...opts, sourceTrackIds: [...sources] }) };
}
