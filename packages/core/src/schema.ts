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
  /** Caption tracks only: sparse style over the "bold" preset. */
  captionStyle?: CaptionStylePatch;
  /** 0 is the top track (composited last). */
  position: number;
  muted: boolean;
  locked: boolean;
  hidden: boolean;
}

/**
 * Per-clip look and sound. Stored sparse (only what differs from the
 * defaults); `resolveClipProps` fills in the rest. Every value is a plain
 * number so FFmpeg and the live preview can apply identical maths.
 */
export const ClipPropsSchema = z
  .object({
    /** cover = fill the frame (cropping), contain = fit inside it (letterbox). */
    fit: z.enum(["cover", "contain"]),
    /** Size multiplier around the frame centre. */
    scale: z.number().min(0.05).max(10),
    /** If set, scale animates linearly from `scale` to this over the clip (zoom / Ken Burns). */
    scaleEnd: z.number().min(0.05).max(10).nullable(),
    /** Centre offset as a fraction of the frame width / height. */
    x: z.number().min(-2).max(2),
    y: z.number().min(-2).max(2),
    /** Degrees, clockwise. */
    rotation: z.number().min(-360).max(360),
    opacity: z.number().min(0).max(1),
    /** Fraction of the source cut from each edge before fitting. */
    cropLeft: z.number().min(0).max(0.45),
    cropTop: z.number().min(0).max(0.45),
    cropRight: z.number().min(0).max(0.45),
    cropBottom: z.number().min(0).max(0.45),
    /** Frames. Picture fades through transparency (to whatever is below), audio fades to silence. */
    fadeIn: z.number().int().min(0).max(MAX_FRAME),
    fadeOut: z.number().int().min(0).max(MAX_FRAME),
    /** Frames of dissolve (picture) / crossfade (audio) from the clip that ends where this one starts. */
    transitionIn: z.number().int().min(0).max(MAX_FRAME),
    /** Audio gain in dB (audio tracks). */
    gainDb: z.number().min(-60).max(12),
  })
  .strict();
export type ClipProps = z.infer<typeof ClipPropsSchema>;
export const ClipPropsPatchSchema = ClipPropsSchema.partial();
export type ClipPropsPatch = z.infer<typeof ClipPropsPatchSchema>;

export const DEFAULT_CLIP_PROPS: ClipProps = {
  fit: "cover",
  scale: 1,
  scaleEnd: null,
  x: 0,
  y: 0,
  rotation: 0,
  opacity: 1,
  cropLeft: 0,
  cropTop: 0,
  cropRight: 0,
  cropBottom: 0,
  fadeIn: 0,
  fadeOut: 0,
  transitionIn: 0,
  gainDb: 0,
};

export function resolveClipProps(p: ClipPropsPatch | undefined): ClipProps {
  return { ...DEFAULT_CLIP_PROPS, ...p };
}

/** Keep only values that differ from the defaults (what gets stored). */
export function sparseClipProps(p: ClipPropsPatch): ClipPropsPatch {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(p)) {
    if (v !== undefined && v !== DEFAULT_CLIP_PROPS[k as keyof ClipProps]) out[k] = v;
  }
  return out as ClipPropsPatch;
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
  /** Sparse look/sound settings; see resolveClipProps. */
  props: ClipPropsPatch;
}

export interface Timeline {
  project: Project;
  tracks: Track[];
  clips: Clip[];
  captions: Caption[];
  assets: Asset[];
  /** Last frame covered by any clip. */
  durationFrames: number;
  history: { canUndo: boolean; canRedo: boolean };
}

const BaseTimelineOps = [
  z.object({
    type: z.literal("clip.add"),
    clipId: z.uuid().optional(),
    trackId: z.uuid(),
    assetId: z.uuid(),
    start: Frame,
    sourceIn: Frame.optional(),
    duration: FrameCount.optional(),
    props: ClipPropsPatchSchema.optional(),
  }),
  z.object({
    type: z.literal("clip.update"),
    clipId: z.uuid(),
    /** Fields to change; others keep their value. */
    props: ClipPropsPatchSchema,
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
    captionStyle: z.lazy(() => CaptionStylePatchSchema).optional(),
  }),
] as const;



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

// ---------------------------------------------------------------------------
// Render jobs (M2)
// ---------------------------------------------------------------------------

export const JOB_STATES = ["queued", "analyzing", "rendering", "muxing", "completed", "failed", "cancelled"] as const;
export type JobState = (typeof JOB_STATES)[number];
export const ACTIVE_JOB_STATES: readonly JobState[] = ["queued", "analyzing", "rendering", "muxing"];
export type JobKind = "export" | "preview";

export interface RenderSettings {
  width: number;
  height: number;
  /** Use low-resolution proxies instead of the originals (previews). */
  useProxies: boolean;
  crf: number;
  preset: "ultrafast" | "veryfast" | "fast" | "medium" | "slow";
  audioBitrateK: number;
}

export interface RenderJob {
  id: string;
  projectId: string;
  kind: JobKind;
  state: JobState;
  /** 0..1 */
  progress: number;
  revision: number;
  settings: RenderSettings;
  outputPath: string | null;
  error: { code: string; message: string } | null;
  retryOf: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface Artifact {
  id: string;
  projectId: string;
  jobId: string;
  path: string;
  sizeBytes: number;
  frames: number;
  width: number;
  height: number;
  videoCodec: string;
  audioCodec: string | null;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Media intelligence & captions (M3)
// ---------------------------------------------------------------------------

export const ANALYSIS_KINDS = ["scenes", "beats", "transcript"] as const;
export type AnalysisKind = (typeof ANALYSIS_KINDS)[number];
export type AnalysisState = "queued" | "running" | "completed" | "failed";

export interface ScenesResult {
  /** Scene changes in source time. */
  cuts: { timeUs: number; score: number }[];
}

export interface BeatsResult {
  bpm: number;
  /** 0..1: how periodic the onsets are; low values mean "no clear beat". */
  confidence: number;
  beatsUs: number[];
}

export interface TranscriptWord {
  text: string;
  startUs: number;
  endUs: number;
  /** Model confidence 0..1. */
  p: number;
}

export interface TranscriptResult {
  language: string;
  text: string;
  segments: { startUs: number; endUs: number; text: string; words: TranscriptWord[] }[];
}

export interface AnalysisResults {
  scenes: ScenesResult;
  beats: BeatsResult;
  transcript: TranscriptResult;
}

export interface Analysis<K extends AnalysisKind = AnalysisKind> {
  id: string;
  assetId: string;
  kind: K;
  state: AnalysisState;
  progress: number;
  engine: string | null;
  params: Record<string, unknown>;
  result: AnalysisResults[K] | null;
  error: string | null;
  /** The source file changed since this ran; re-analyse before trusting it. */
  stale: boolean;
  createdAt: string;
  finishedAt: string | null;
}

const HexColor = z.string().regex(/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/, "colour must be #rrggbb or #rrggbbaa");

/** Bundled OFL fonts (assets/fonts); exports are identical on every machine. */
export const CAPTION_FONTS = {
  Anton: "Anton-Regular.ttf",
  "Poppins Bold": "Poppins-Bold.ttf",
  "Poppins SemiBold": "Poppins-SemiBold.ttf",
} as const;
export type CaptionFont = keyof typeof CAPTION_FONTS;

export const CaptionStyleSchema = z
  .object({
    font: z.enum(Object.keys(CAPTION_FONTS) as [CaptionFont, ...CaptionFont[]]),
    /** Font size as a fraction of the frame height. */
    size: z.number().min(0.015).max(0.2),
    color: HexColor,
    /** Colour of the word being spoken; null = no word highlight. */
    highlight: HexColor.nullable(),
    strokeColor: HexColor,
    /** Outline width as a fraction of the font size (0 = none). */
    stroke: z.number().min(0).max(0.3),
    shadow: z.boolean(),
    /** Background box behind each line (null = none). */
    box: HexColor.nullable(),
    /** Vertical centre of the caption block, 0 = top, 1 = bottom (keep inside the safe area). */
    y: z.number().min(0.05).max(0.95),
    /** Max line width as a fraction of the frame width. */
    maxWidth: z.number().min(0.3).max(1),
    uppercase: z.boolean(),
  })
  .strict();
export type CaptionStyle = z.infer<typeof CaptionStyleSchema>;
export const CaptionStylePatchSchema = CaptionStyleSchema.partial();
export type CaptionStylePatch = z.infer<typeof CaptionStylePatchSchema>;

/** The three presets (PRD §10: at least three). */
export const CAPTION_PRESETS: Record<"bold" | "clean" | "boxed", CaptionStyle> = {
  bold: {
    font: "Anton", size: 0.058, color: "#ffffff", highlight: "#00d5ed", strokeColor: "#000000", stroke: 0.12,
    shadow: true, box: null, y: 0.7, maxWidth: 0.82, uppercase: true,
  },
  clean: {
    font: "Poppins SemiBold", size: 0.038, color: "#ffffff", highlight: "#ffd84a", strokeColor: "#000000", stroke: 0.06,
    shadow: true, box: null, y: 0.74, maxWidth: 0.8, uppercase: false,
  },
  boxed: {
    font: "Poppins Bold", size: 0.036, color: "#ffffff", highlight: "#00d5ed", strokeColor: "#000000", stroke: 0,
    shadow: false, box: "#000000b3", y: 0.74, maxWidth: 0.78, uppercase: false,
  },
};

export function resolveCaptionStyle(p: CaptionStylePatch | undefined): CaptionStyle {
  return { ...CAPTION_PRESETS.bold, ...p };
}

export interface CaptionWord {
  text: string;
  /** Frames relative to the caption start. */
  start: number;
  end: number;
}

export interface Caption {
  id: string;
  trackId: string;
  start: number;
  duration: number;
  text: string;
  /** Word timings for highlighting; empty when unknown. */
  words: CaptionWord[];
}

const CaptionText = z.string().trim().min(1, "caption text is required").max(300);
const CaptionWordSchema = z.object({ text: z.string().min(1).max(100), start: z.number().int().min(0), end: z.number().int().min(0) });
const CaptionInput = z.object({
  captionId: z.uuid().optional(),
  start: Frame,
  duration: FrameCount,
  text: CaptionText,
  words: z.array(CaptionWordSchema).max(200).optional(),
});

export const CaptionOpSchemas = [
  z.object({ type: z.literal("caption.add"), trackId: z.uuid(), ...CaptionInput.shape }),
  z.object({
    type: z.literal("caption.update"),
    captionId: z.uuid(),
    text: CaptionText.optional(),
    start: Frame.optional(),
    duration: FrameCount.optional(),
    words: z.array(CaptionWordSchema).max(200).optional(),
  }),
  z.object({ type: z.literal("caption.delete"), captionIds: z.array(z.uuid()).min(1).max(5000) }),
  /** Replace every caption on a track (caption generation is one undo step). */
  z.object({ type: z.literal("captions.replace"), trackId: z.uuid(), captions: z.array(CaptionInput).max(5000) }),
] as const;

export const TimelineOpSchema = z.discriminatedUnion("type", [...BaseTimelineOps, ...CaptionOpSchemas]);
export type TimelineOp = z.infer<typeof TimelineOpSchema>;

export const ApplyOperationsInputSchema = z.object({
  baseRevision: z.number().int().nonnegative(),
  operations: z.array(TimelineOpSchema).min(1).max(500),
});
export type ApplyOperationsInput = z.input<typeof ApplyOperationsInputSchema>;

// ---------------------------------------------------------------------------
// AI Director (M4)
// ---------------------------------------------------------------------------

export type ProposalStatus = "pending" | "applied" | "rejected" | "stale";

/** One human-readable line of what a proposal changes (the diff viewer, FR-022). */
export interface ProposalChange {
  kind: "added" | "removed" | "changed";
  target: "clip" | "caption" | "track";
  id: string;
  label: string;
  /** Before / after summaries, e.g. "V1 · 3.00s–6.00s" → "V1 · 4.50s–7.50s". */
  before: string | null;
  after: string | null;
}

export interface AIProposal {
  id: string;
  projectId: string;
  baseRevision: number;
  instruction: string;
  /** Who asked for it: the user, or an MCP client (whose instruction and summary are its own words). */
  requestedBy: "user" | "mcp";
  selection: string[];
  provider: string;
  model: string;
  status: ProposalStatus;
  summary: string;
  operations: TimelineOp[];
  /** Why, per operation (same order). */
  explanations: string[];
  warnings: string[];
  changes: ProposalChange[];
  durationBefore: number;
  durationAfter: number;
  usage: Record<string, unknown> | null;
  approval: { by: string; channel: string; at: string } | null;
  appliedRevision: number | null;
  createdAt: string;
}

export interface AIConsent {
  grantedAt: string;
  grantedBy: string;
}

// ---------------------------------------------------------------------------
// Automation (M5)
// ---------------------------------------------------------------------------

export type WorkflowStatus = "running" | "completed" | "failed" | "waiting_approval";

export interface WorkflowStepResult {
  index: number;
  kind: string;
  status: "pending" | "running" | "completed" | "failed" | "skipped" | "waiting_approval";
  /** Short human-readable outcome ("3 imported", "rendered /path.mp4"). */
  detail: string | null;
  /** Machine-readable result (asset ids, proposal id, job id…). */
  result: Record<string, unknown> | null;
}

export interface WorkflowRun {
  id: string;
  projectId: string | null;
  name: string;
  source: string | null;
  status: WorkflowStatus;
  steps: WorkflowStepResult[];
  error: string | null;
  actor: string;
  startedAt: string;
  finishedAt: string | null;
}
