import type { Database } from "./db.ts";
import { ReelForgeError } from "./errors.ts";
import { AnalysisStore } from "./analyses.ts";
import { generateCaptions, soundTracks, type CaptionGenOptions, type CaptionPlan } from "./captions.ts";
import { TimelineStore } from "./timeline.ts";
import { CAPTION_PRESETS, type TimelineOp, type TranscriptResult } from "./schema.ts";

/**
 * Work out captions for a project from stored transcripts. If any source clip's
 * asset has no fresh transcript, it is reported in `missing` (the caller
 * transcribes and asks again) instead of silently captioning half the speech.
 */
export function planCaptions(db: Database, projectId: string, opts: CaptionGenOptions & { trackId?: string } = {}): CaptionPlan {
  const tl = new TimelineStore(db).get(projectId);
  const track = opts.trackId ? tl.tracks.find((t) => t.id === opts.trackId) : tl.tracks.find((t) => t.kind === "caption");
  if (!track || track.kind !== "caption") throw new ReelForgeError("VALIDATION_ERROR", "no caption track to write to", { trackId: opts.trackId });
  const sources = new Set(opts.sourceTrackIds ?? soundTracks(tl).map((t) => t.id));
  for (const id of sources) {
    const t = tl.tracks.find((x) => x.id === id);
    if (!t || t.kind === "caption") throw new ReelForgeError("VALIDATION_ERROR", "caption sources must be audio or video tracks", { trackId: id });
  }
  const hasSound = new Set(tl.assets.filter((a) => a.hasAudio).map((a) => a.id));
  const assetIds = [...new Set(tl.clips.filter((c) => sources.has(c.trackId) && hasSound.has(c.assetId)).map((c) => c.assetId))];
  if (!assetIds.length) throw new ReelForgeError("VALIDATION_ERROR", "nothing on the timeline has sound to caption: add a clip with speech first");

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

export type SpeechCaptionPlan =
  | { status: "needs_transcripts"; missing: CaptionPlan["missing"] }
  | { status: "ready"; operations: TimelineOp[]; summary: string; explanations: string[]; warnings: string[] };

/**
 * Captions for "caption the speech" requests, planned by the engine (word timings from the
 * transcript), not by a model: everything heard on the timeline (audio tracks and videos' own sound).
 */
export function planSpeechCaptions(db: Database, projectId: string, opts: CaptionGenOptions & { style?: keyof typeof CAPTION_PRESETS } = {}): SpeechCaptionPlan {
  const plan = planCaptions(db, projectId, opts);
  if (plan.missing.length) return { status: "needs_transcripts", missing: plan.missing };
  const tl = new TimelineStore(db).get(projectId);
  const warnings: string[] = [];
  if (!plan.captions.length) warnings.push("The transcript has no words in the parts of the clips on the timeline, so there are no captions to add.");
  if (tl.captions.some((c) => c.trackId === plan.trackId)) warnings.push("This replaces the captions already on the caption track.");
  const operations: TimelineOp[] = [{ type: "captions.replace", trackId: plan.trackId, captions: plan.captions }];
  if (opts.style) operations.push({ type: "track.update", trackId: plan.trackId, captionStyle: CAPTION_PRESETS[opts.style] });
  return {
    status: "ready",
    operations,
    summary: `${plan.captions.length} caption${plan.captions.length === 1 ? "" : "s"} from the speech${opts.style ? `, ${opts.style} style` : ""}`,
    explanations: operations.map((o) => (o.type === "captions.replace" ? "captions timed to each spoken word" : `the ${opts.style} caption style`)),
    warnings,
  };
}
