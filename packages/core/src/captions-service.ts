import { randomUUID } from "node:crypto";
import type { Database } from "./db.ts";
import { ReelForgeError } from "./errors.ts";
import { AnalysisStore } from "./analyses.ts";
import { generateCaptions, type CaptionGenOptions, type CaptionPlan } from "./captions.ts";
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

export type SpeechCaptionPlan =
  | { status: "needs_transcripts"; missing: CaptionPlan["missing"] }
  | { status: "ready"; operations: TimelineOp[]; summary: string; explanations: string[]; warnings: string[] };

/**
 * Captions for "caption the speech" requests, planned by the engine (word timings from the
 * transcript), not by a model. Speech comes from the unmuted audio tracks; if those hold nothing,
 * from the video clips that have sound, whose audio is then also placed on an audio track:
 * camera audio isn't part of the mix otherwise, and captions for speech nobody hears make no sense.
 */
export function planSpeechCaptions(db: Database, projectId: string, opts: CaptionGenOptions & { style?: keyof typeof CAPTION_PRESETS } = {}): SpeechCaptionPlan {
  const timeline = new TimelineStore(db);
  const tl = timeline.get(projectId);
  const captionTrack = tl.tracks.find((t) => t.kind === "caption");
  if (!captionTrack) throw new ReelForgeError("VALIDATION_ERROR", "this project has no caption track");
  const assetById = new Map(tl.assets.map((a) => [a.id, a]));
  const hasSound = (assetId: string) => !!assetById.get(assetId)?.hasAudio;

  const audioTracks = tl.tracks.filter((t) => t.kind === "audio" && !t.muted);
  const audioClips = tl.clips.filter((c) => audioTracks.some((t) => t.id === c.trackId) && hasSound(c.assetId));
  const ops: TimelineOp[] = [];
  const notes: string[] = [];
  let sourceTrackIds = audioTracks.map((t) => t.id);

  if (!audioClips.length) {
    const visible = new Set(tl.tracks.filter((t) => (t.kind === "video" || t.kind === "overlay") && !t.hidden).map((t) => t.id));
    const voiced = tl.clips.filter((c) => visible.has(c.trackId) && hasSound(c.assetId)).sort((a, b) => a.start - b.start);
    if (!voiced.length) throw new ReelForgeError("VALIDATION_ERROR", "nothing on the timeline has sound to caption: add a clip with speech first");
    const voice = audioTracks.find((t) => !t.locked && /voice/i.test(t.name)) ?? audioTracks.find((t) => !t.locked);
    if (!voice) throw new ReelForgeError("VALIDATION_ERROR", "the speech is in a video clip, but there is no unmuted, unlocked audio track to put its sound on");
    for (const c of voiced) {
      ops.push({ type: "clip.add", clipId: randomUUID(), trackId: voice.id, assetId: c.assetId, start: c.start, sourceIn: c.sourceIn, duration: c.duration });
    }
    sourceTrackIds = [voice.id];
    notes.push(`The speech is in ${voiced.length === 1 ? "a video clip" : `${voiced.length} video clips`}, whose sound isn't in the mix by itself: this also puts it on ${voice.name}, so it is heard and the captions match.`);
  }

  const speechAssets = [...new Set((ops.length ? ops.flatMap((o) => (o.type === "clip.add" ? [o.assetId] : [])) : audioClips.map((c) => c.assetId)))];
  const store = new AnalysisStore(db);
  const transcripts = new Map<string, TranscriptResult>();
  const missing: CaptionPlan["missing"] = [];
  for (const id of speechAssets) {
    const a = store.latest(projectId, id, "transcript");
    if (a?.state === "completed" && a.result && !a.stale) transcripts.set(id, a.result);
    else missing.push({ assetId: id, filename: assetById.get(id)?.filename ?? id, state: a?.state ?? null });
  }
  if (missing.length) return { status: "needs_transcripts", missing };

  const after = ops.length ? timeline.preview(projectId, ops).after : tl;
  const captions = generateCaptions(after, transcripts, { ...opts, sourceTrackIds });
  const warnings: string[] = [];
  if (!captions.length) warnings.push("The transcript has no words in the parts of the clips on the timeline, so there are no captions to add.");
  if (tl.captions.some((c) => c.trackId === captionTrack.id)) warnings.push("This replaces the captions already on the caption track.");
  ops.push({ type: "captions.replace", trackId: captionTrack.id, captions });
  if (opts.style) ops.push({ type: "track.update", trackId: captionTrack.id, captionStyle: CAPTION_PRESETS[opts.style] });
  const explanations = ops.map((o) =>
    o.type === "clip.add" ? "the video's own sound, so the speech is heard" : o.type === "captions.replace" ? "captions timed to each spoken word" : `the ${opts.style} caption style`,
  );
  return {
    status: "ready",
    operations: ops,
    summary: `${captions.length} caption${captions.length === 1 ? "" : "s"} from the speech${opts.style ? `, ${opts.style} style` : ""}`,
    explanations,
    warnings: [...notes, ...warnings],
  };
}

