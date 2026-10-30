// Wire contracts shared by the core, the REST server, the CLI and the desktop
// UI. Browser-safe: no node: imports here.
import { z } from "zod";

export const PROJECT_SCHEMA_VERSION = 1;

export const DEFAULT_PROJECT_SETTINGS = {
  width: 1080,
  height: 1920,
  fps: { num: 30, den: 1 },
} as const;

export const ActorSchema = z.enum(["desktop", "cli", "api", "mcp"]);
export type Actor = z.infer<typeof ActorSchema>;

export const RationalSchema = z
  .object({
    num: z.number().int().positive().max(1_000_000),
    den: z.number().int().positive().max(1_000_000),
  })
  .refine((r) => r.num / r.den >= 1 && r.num / r.den <= 240, {
    message: "frame rate must be between 1 and 240 fps",
  });

const Dimension = z
  .number()
  .int()
  .min(16)
  .max(8192)
  .refine((n) => n % 2 === 0, { message: "must be even (H.264 4:2:0 requirement)" });

export const ProjectSettingsSchema = z.object({
  width: Dimension,
  height: Dimension,
  fps: RationalSchema,
});
export type ProjectSettings = z.infer<typeof ProjectSettingsSchema>;

export const ProjectNameSchema = z
  .string()
  .trim()
  .min(1, "name is required")
  .max(120, "name must be at most 120 characters")
  .refine((s) => !/[\u0000-\u001f\u007f]/.test(s), { message: "name must not contain control characters" });

export const ProjectIdSchema = z.uuid();

export const ProjectSchema = z.object({
  id: ProjectIdSchema,
  name: z.string(),
  schemaVersion: z.number().int(),
  revision: z.number().int().nonnegative(),
  settings: ProjectSettingsSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Project = z.infer<typeof ProjectSchema>;

export const CreateProjectInputSchema = z.object({
  name: ProjectNameSchema,
  settings: ProjectSettingsSchema.partial().optional(),
});
export type CreateProjectInput = z.input<typeof CreateProjectInputSchema>;

export const RenameProjectInputSchema = z.object({
  name: ProjectNameSchema,
  /** The revision the caller last saw; a mismatch is a conflict, never a silent overwrite. */
  baseRevision: z.number().int().nonnegative(),
});
export type RenameProjectInput = z.input<typeof RenameProjectInputSchema>;

export const EditOperationSchema = z.object({
  id: z.uuid(),
  projectId: ProjectIdSchema,
  revision: z.number().int().positive(),
  kind: z.string(),
  payload: z.record(z.string(), z.unknown()),
  actor: ActorSchema,
  createdAt: z.string(),
});
export type EditOperation = z.infer<typeof EditOperationSchema>;

export function aspectRatioLabel(s: Pick<ProjectSettings, "width" | "height">): string {
  const known: Record<string, string> = { "9:16": "9:16 (Reels)", "16:9": "16:9", "1:1": "1:1", "4:5": "4:5" };
  let a = s.width;
  let b = s.height;
  while (b !== 0) [a, b] = [b, a % b];
  const key = `${s.width / a}:${s.height / a}`;
  return known[key] ?? key;
}

// ---------------------------------------------------------------------------
// Media & timeline (M1)
// ---------------------------------------------------------------------------

/** Upper bound for any frame value: 24h at 240 fps. Keeps arithmetic far from 2^53. */
export const MAX_FRAME = 24 * 60 * 60 * 240;

const Frame = z.number().int().min(0).max(MAX_FRAME);
const FrameCount = z.number().int().min(1).max(MAX_FRAME);

export const AssetKindSchema = z.enum(["video", "audio", "image"]);
export type AssetKind = z.infer<typeof AssetKindSchema>;

export const TrackKindSchema = z.enum(["video", "overlay", "audio", "caption"]);
export type TrackKind = z.infer<typeof TrackKindSchema>;

export interface Asset {
  id: string;
  projectId: string;
  kind: AssetKind;
  filename: string;
  sourcePath: string;
  sizeBytes: number;
  /** Seconds-precision source duration in microseconds; null for still images. */
  durationUs: number | null;
  /** Usable length in project frames (floor); null = unbounded (still image). */
  durationFrames: number | null;
  width: number | null;
  height: number | null;
  fps: { num: number; den: number } | null;
  /** Variable frame rate source: mapped to the project timebase by time, flagged for the user. */
  vfr: boolean;
  hasVideo: boolean;
  hasAudio: boolean;
  videoCodec: string | null;
  audioCodec: string | null;
  sampleRate: number | null;
  channels: number | null;
  rotation: number;
  /** online = file present and unchanged; missing = gone; changed = size/mtime differ (relink or re-verify). */
  status: "online" | "missing" | "changed";
  createdAt: string;
}

export interface Track {
  id: string;
  kind: TrackKind;
  name: string;
  /** 0 is the top track (composited last). */
  position: number;
  muted: boolean;
  locked: boolean;
  hidden: boolean;
}

export interface Clip {
  id: string;
  trackId: string;
  assetId: string;
  /** Timeline position, project frames. */
  start: number;
  duration: number;
  /** Offset into the source, project frames. */
  sourceIn: number;
}

export interface Timeline {
  project: Project;
  tracks: Track[];
  clips: Clip[];
  assets: Asset[];
  /** Last frame covered by any clip. */
  durationFrames: number;
  history: { canUndo: boolean; canRedo: boolean };
}

export const TimelineOpSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("clip.add"),
    clipId: z.uuid().optional(),
    trackId: z.uuid(),
    assetId: z.uuid(),
    start: Frame,
    sourceIn: Frame.optional(),
    duration: FrameCount.optional(),
  }),
  z.object({
    type: z.literal("clip.move"),
    clipId: z.uuid(),
    start: Frame,
    trackId: z.uuid().optional(),
  }),
  z.object({
    type: z.literal("clip.trim"),
    clipId: z.uuid(),
    edge: z.enum(["start", "end"]),
    /** Absolute timeline frame the edge moves to. */
    frame: Frame,
  }),
  z.object({
    type: z.literal("clip.split"),
    clipId: z.uuid(),
    frame: Frame,
    newClipId: z.uuid().optional(),
  }),
  z.object({
    type: z.literal("clip.delete"),
    clipIds: z.array(z.uuid()).min(1).max(500),
    /** Close the gap: later clips on the same track shift left. */
    ripple: z.boolean().optional(),
  }),
  z.object({
    type: z.literal("track.update"),
    trackId: z.uuid(),
    name: ProjectNameSchema.optional(),
    muted: z.boolean().optional(),
    locked: z.boolean().optional(),
    hidden: z.boolean().optional(),
  }),
]);
export type TimelineOp = z.infer<typeof TimelineOpSchema>;

export const ApplyOperationsInputSchema = z.object({
  baseRevision: z.number().int().nonnegative(),
  operations: z.array(TimelineOpSchema).min(1).max(500),
});
export type ApplyOperationsInput = z.input<typeof ApplyOperationsInputSchema>;

export const HistoryInputSchema = z.object({
  baseRevision: z.number().int().nonnegative(),
});
export type HistoryInput = z.input<typeof HistoryInputSchema>;

/** What the media engine learned about a file. Produced by @reelforge/media, stored by the core. */
export interface AssetProbe {
  kind: AssetKind;
  durationUs: number | null;
  width: number | null;
  height: number | null;
  fps: { num: number; den: number } | null;
  vfr: boolean;
  hasVideo: boolean;
  hasAudio: boolean;
  videoCodec: string | null;
  audioCodec: string | null;
  sampleRate: number | null;
  channels: number | null;
  rotation: number;
}

export interface AssetFile {
  /** Canonical absolute path (symlinks resolved). */
  path: string;
  sizeBytes: number;
  mtimeMs: number;
}

/**
 * Editor-style labels: picture tracks count up from the bottom (V1 is the base
 * video layer), audio tracks count down from the top, captions are C1…
 */
export function trackLabels(tracks: readonly Track[]): Map<string, string> {
  const labels = new Map<string, string>();
  const byPos = [...tracks].sort((a, b) => a.position - b.position);
  byPos.filter((t) => t.kind === "video" || t.kind === "overlay").reverse().forEach((t, i) => labels.set(t.id, `V${i + 1}`));
  byPos.filter((t) => t.kind === "audio").forEach((t, i) => labels.set(t.id, `A${i + 1}`));
  byPos.filter((t) => t.kind === "caption").forEach((t, i) => labels.set(t.id, `C${i + 1}`));
  return labels;
}
