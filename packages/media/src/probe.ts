import { realpathSync, statSync } from "node:fs";
import { extname, isAbsolute } from "node:path";
import { ReelForgeError, type AssetFile, type AssetKind, type AssetProbe } from "@reelforge/core";
import { ffmpegReason, ffprobeBin, run } from "./ffmpeg.ts";

/** MVP test matrix (PRD FR-008). Anything else is refused before FFmpeg sees it. */
export const SUPPORTED_EXTENSIONS: Record<string, AssetKind> = {
  ".mp4": "video",
  ".mov": "video",
  ".jpg": "image",
  ".jpeg": "image",
  ".png": "image",
  ".wav": "audio",
  ".mp3": "audio",
  ".m4a": "audio",
  ".aiff": "audio",
  ".aif": "audio",
  ".mkv": "video",
  ".webm": "video",
};

/**
 * The demuxer each extension is opened with. FFmpeg otherwise sniffs the
 * content, so a "clip.mp4" that is really an ffconcat list or HLS playlist
 * would be followed to other local files or URLs. Image pipes (not image2)
 * also avoid %d sequence patterns in file names.
 */
const DEMUXERS: Record<string, string> = {
  ".mp4": "mov",
  ".mov": "mov",
  ".jpg": "jpeg_pipe",
  ".jpeg": "jpeg_pipe",
  ".png": "png_pipe",
  ".wav": "wav",
  ".mp3": "mp3",
  ".m4a": "mov",
  ".aiff": "aiff",
  ".aif": "aiff",
  // Matroska and WebM share one demuxer; neither format can point at other files.
  ".mkv": "matroska",
  ".webm": "matroska",
};

/** The picture codec a still must carry: a video or anything else renamed to .png is refused at import. */
const IMAGE_CODECS: Record<string, string> = {
  ".png": "png",
  ".jpg": "mjpeg",
  ".jpeg": "mjpeg",
};

/** Input arguments for any FFmpeg tool reading a source: forced demuxer, local files only. */
export function sourceInputArgs(path: string, inputOptions: string[] = []): string[] {
  const demuxer = DEMUXERS[extname(path).toLowerCase()];
  if (!demuxer) throw new ReelForgeError("VALIDATION_ERROR", "unsupported file type");
  // "file:" stops FFmpeg from reading protocol prefixes (concat:, http:…) out of a file name.
  // mov: never follow external data references (alias/URL tracks) to other files; FFmpeg's default today, stated here.
  const demuxerOptions = demuxer === "mov" ? ["-enable_drefs", "0"] : [];
  return ["-protocol_whitelist", "file", "-f", demuxer, ...demuxerOptions, ...inputOptions, "-i", `file:${path}`];
}

/**
 * Resolve a user-supplied path to the canonical file it names. Symlinks are
 * followed (so the stored path is the real file) and only regular files with
 * a supported extension are accepted.
 */
export function resolveSource(input: string): AssetFile {
  if (typeof input !== "string" || input.length === 0 || input.length > 4096 || input.includes("\0")) {
    throw new ReelForgeError("VALIDATION_ERROR", "invalid file path");
  }
  if (!isAbsolute(input)) throw new ReelForgeError("VALIDATION_ERROR", "file path must be absolute", { path: input });
  let real: string;
  try {
    real = realpathSync(input);
  } catch {
    throw new ReelForgeError("NOT_FOUND", "file not found", { path: input });
  }
  const st = statSync(real);
  if (!st.isFile()) throw new ReelForgeError("VALIDATION_ERROR", "not a regular file", { path: input });
  const ext = extname(real).toLowerCase();
  if (!(ext in SUPPORTED_EXTENSIONS)) {
    throw new ReelForgeError("VALIDATION_ERROR", `unsupported file type "${ext || "(none)"}" (supported: ${Object.keys(SUPPORTED_EXTENSIONS).join(", ")})`, {
      path: input,
    });
  }
  return { path: real, sizeBytes: st.size, mtimeMs: st.mtimeMs };
}

interface FfStream {
  codec_type?: string;
  codec_name?: string;
  pix_fmt?: string;
  width?: number;
  height?: number;
  avg_frame_rate?: string;
  r_frame_rate?: string;
  sample_rate?: string;
  channels?: number;
  duration?: string;
  nb_frames?: string;
  disposition?: { attached_pic?: number };
  tags?: { rotate?: string };
  side_data_list?: { rotation?: number }[];
}

interface FfProbe {
  streams?: FfStream[];
  format?: { duration?: string; format_name?: string };
}

function parseRate(s: string | undefined): { num: number; den: number } | null {
  const m = /^(\d+)\/(\d+)$/.exec(s ?? "");
  if (!m) return null;
  const num = Number(m[1]);
  const den = Number(m[2]);
  if (!num || !den || num / den > 1000) return null;
  return { num, den };
}

function rotationOf(v: FfStream): number {
  const raw = v.side_data_list?.find((d) => typeof d.rotation === "number")?.rotation ?? Number(v.tags?.rotate ?? 0);
  const r = ((Math.round(raw / 90) * 90) % 360 + 360) % 360;
  return r;
}

const micros = (s: string | undefined) => {
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 1_000_000) : null;
};

/** Pixel formats that carry an alpha channel (yuva444p12le, rgba, ya8, gbrap10le, …). */
export function hasAlphaPixFmt(pixFmt: string | undefined): boolean {
  return !!pixFmt && /^(yuva|gbrap|rgba|bgra|argb|abgr|ya\d|rgba64|bgra64)/.test(pixFmt);
}

/** Interpret ffprobe JSON. Exported for unit tests. */
export function interpretProbe(data: FfProbe, expected: AssetKind): AssetProbe {
  const streams = data.streams ?? [];
  const v = streams.find((s) => s.codec_type === "video" && !s.disposition?.attached_pic);
  const a = streams.find((s) => s.codec_type === "audio");

  let kind: AssetKind = expected;
  if (expected === "video" && !v) {
    if (!a) throw new ReelForgeError("VALIDATION_ERROR", "file has no video or audio stream");
    kind = "audio";
  }
  if (kind === "image" && !v) throw new ReelForgeError("VALIDATION_ERROR", "file is not a readable image");
  // A decoder that couldn't read the header reports a 0×0 picture (a video renamed to .png, a truncated file).
  if (kind !== "audio" && v && !(v.width && v.height)) {
    throw new ReelForgeError("VALIDATION_ERROR", kind === "image" ? "file is not a readable image (no picture size: is it really an image?)" : "video has no readable picture size");
  }
  if (kind === "audio" && !a) throw new ReelForgeError("VALIDATION_ERROR", "file has no audio stream");

  const rotation = v ? rotationOf(v) : 0;
  const quarter = rotation === 90 || rotation === 270;
  const avg = parseRate(v?.avg_frame_rate);
  const real = parseRate(v?.r_frame_rate);
  const fps = kind === "video" ? (avg ?? real) : null;
  const vfr = kind === "video" && !!avg && !!real && Math.abs(avg.num / avg.den - real.num / real.den) / (real.num / real.den) > 0.001;
  const durationUs = kind === "image" ? null : (micros(data.format?.duration) ?? micros(v?.duration) ?? micros(a?.duration));
  if (kind !== "image" && durationUs === null) throw new ReelForgeError("VALIDATION_ERROR", "could not determine media duration");

  return {
    kind,
    durationUs,
    width: v?.width ? (quarter ? v.height ?? null : v.width) : null,
    height: v?.height ? (quarter ? v.width : v.height) ?? null : null,
    fps,
    vfr,
    hasVideo: kind !== "audio" && !!v,
    hasAudio: kind !== "image" && !!a,
    hasAlpha: kind !== "audio" && hasAlphaPixFmt(v?.pix_fmt),
    videoCodec: kind !== "audio" ? v?.codec_name ?? null : null,
    audioCodec: a?.codec_name ?? null,
    sampleRate: a?.sample_rate ? Number(a.sample_rate) : null,
    channels: a?.channels ?? null,
    rotation,
  };
}

export async function probeFile(file: AssetFile): Promise<AssetProbe> {
  const ext = extname(file.path).toLowerCase();
  const expected = SUPPORTED_EXTENSIONS[ext];
  if (!expected) throw new ReelForgeError("VALIDATION_ERROR", "unsupported file type");
  // ffprobe takes the input positionally; drop the "-i" from the shared input args.
  const input = sourceInputArgs(file.path).filter((a) => a !== "-i");
  let out: string;
  try {
    ({ stdout: out } = await run(ffprobeBin(), ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", ...input], {
      timeoutMs: 30_000,
    }));
  } catch (e) {
    if (e instanceof ReelForgeError) throw e;
    throw new ReelForgeError("VALIDATION_ERROR", `could not read media: ${ffmpegReason(e, file.path)}`);
  }
  const data = JSON.parse(out) as FfProbe;
  // Belt and braces: the forced demuxer must be the one that actually opened the file.
  const formats = (data.format?.format_name ?? "").split(",");
  if (!formats.includes(DEMUXERS[ext]!)) {
    throw new ReelForgeError("VALIDATION_ERROR", `file content does not match its ${ext} extension`);
  }
  const v = data.streams?.find((st) => st.codec_type === "video");
  if (expected === "image" && v?.codec_name !== IMAGE_CODECS[ext]) {
    throw new ReelForgeError("VALIDATION_ERROR", `file content does not match its ${ext} extension`);
  }
  return interpretProbe(data, expected);
}
