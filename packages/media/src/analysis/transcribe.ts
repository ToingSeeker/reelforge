import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ReelForgeError, resolveModelsDir, type TranscriptResult, type TranscriptWord } from "@reelforge/core";
import { ffmpegBin, ffmpegReason, run } from "../ffmpeg.ts";
import { sourceInputArgs } from "../probe.ts";

export const WHISPER_MODEL = "ggml-large-v3-turbo.bin";
/** Silero voice-activity model: without it whisper "hears" phrases like "Thank you." in music. */
export const VAD_MODEL = "ggml-silero-v6.2.0.bin";
export const TRANSCRIPT_ENGINE = "whisper.cpp large-v3-turbo";

export const whisperBin = () => process.env.REELFORGE_WHISPER ?? "whisper-cli";
export function whisperModelPath(): string {
  return process.env.REELFORGE_WHISPER_MODEL ?? join(resolveModelsDir(), WHISPER_MODEL);
}
export function vadModelPath(): string {
  return process.env.REELFORGE_VAD_MODEL ?? join(resolveModelsDir(), VAD_MODEL);
}

interface WhisperToken {
  text: string;
  offsets: { from: number; to: number };
  p: number;
}

interface WhisperJson {
  result?: { language?: string };
  transcription?: { text: string; offsets: { from: number; to: number }; tokens?: WhisperToken[] }[];
}

/** Merge whisper tokens into words: a token starting with a space begins a new word. Exported for tests. */
export function interpretWhisper(data: WhisperJson): TranscriptResult {
  const segments: TranscriptResult["segments"] = [];
  for (const seg of data.transcription ?? []) {
    const words: TranscriptWord[] = [];
    let ps: number[] = [];
    for (const tok of seg.tokens ?? []) {
      if (/^\s*\[_/.test(tok.text) || tok.text.trim() === "") continue; // [_BEG_], [_TT_123]…
      const startsWord = /^\s/.test(tok.text) || words.length === 0;
      if (startsWord) {
        if (words.length && ps.length) words[words.length - 1]!.p = Math.min(...ps);
        words.push({ text: tok.text.trim(), startUs: tok.offsets.from * 1000, endUs: tok.offsets.to * 1000, p: tok.p });
        ps = [tok.p];
      } else {
        const w = words[words.length - 1]!;
        w.text += tok.text;
        w.endUs = tok.offsets.to * 1000;
        ps.push(tok.p);
      }
    }
    if (words.length && ps.length) words[words.length - 1]!.p = Math.min(...ps);
    const text = seg.text.trim();
    if (!text) continue;
    segments.push({ startUs: seg.offsets.from * 1000, endUs: seg.offsets.to * 1000, text, words });
  }
  return { language: data.result?.language ?? "unknown", text: segments.map((s) => s.text).join(" "), segments };
}

/** Longest speech transcribed per file: 16 kHz mono PCM is ~115 MB per hour, so this bounds the temp WAV too. */
export const MAX_TRANSCRIPT_SECONDS = 6 * 60 * 60;

/**
 * The 16 kHz mono WAV whisper.cpp reads. Capped by duration and by size (a crafted file can claim any
 * length), so it can't fill the disk.
 */
export async function extractSpeechAudio(path: string, wav: string, maxSeconds = MAX_TRANSCRIPT_SECONDS): Promise<void> {
  const maxBytes = Math.ceil(maxSeconds * 16000 * 2) + 1024 * 1024;
  try {
    await run(
      ffmpegBin(),
      ["-hide_banner", "-nostdin", "-loglevel", "error", "-y", ...sourceInputArgs(path), "-vn", "-t", String(maxSeconds), "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", "-fs", String(maxBytes), "-f", "wav", wav],
      { timeoutMs: 30 * 60_000 },
    );
  } catch (e) {
    throw new Error(`could not extract audio: ${ffmpegReason(e, path)}`);
  }
}

/**
 * Local speech-to-text with whisper.cpp (Metal on Apple Silicon). Audio never
 * leaves the machine. `language` is an ISO code or "auto".
 */
export async function transcribe(
  path: string,
  workDir: string,
  opts: { language?: string; onProgress?: (p: number) => void; signal?: AbortSignal } = {},
): Promise<TranscriptResult> {
  const model = whisperModelPath();
  if (!existsSync(model)) {
    throw new ReelForgeError("UNAVAILABLE", `speech model not found at ${model}. Download ${WHISPER_MODEL} into the models folder (see docs) or set REELFORGE_WHISPER_MODEL.`);
  }
  const language = opts.language ?? "auto";
  if (!/^(auto|[a-z]{2,3})$/.test(language)) throw new ReelForgeError("VALIDATION_ERROR", `invalid language "${language}" (use an ISO code like id, en, or auto)`);

  mkdirSync(workDir, { recursive: true });
  const wav = join(workDir, "audio.wav");
  const base = join(workDir, "transcript");
  try {
    await extractSpeechAudio(path, wav);
    await new Promise<void>((resolve, reject) => {
      if (opts.signal?.aborted) return reject(new Error("cancelled"));
      const vad = vadModelPath();
      const args = ["-m", model, "-f", wav, "-l", language, "-ojf", "-of", base, "-t", "8", "-pp", "-np", ...(existsSync(vad) ? ["--vad", "-vm", vad] : [])];
      const child = spawn(whisperBin(), args, { stdio: ["ignore", "ignore", "pipe"] });
      const abort = () => child.kill("SIGKILL");
      opts.signal?.addEventListener("abort", abort, { once: true });
      let tail = "";
      const timer = setTimeout(() => child.kill("SIGKILL"), 3 * 60 * 60_000);
      child.stderr.on("data", (c: Buffer) => {
        const s = c.toString();
        tail = (tail + s).slice(-4000);
        for (const m of s.matchAll(/progress\s*=\s*(\d+)%/g)) opts.onProgress?.(Number(m[1]) / 100);
      });
      child.on("error", (e: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        reject(e.code === "ENOENT" ? new ReelForgeError("UNAVAILABLE", "whisper-cli not found. Install whisper.cpp (macOS: `brew install whisper-cpp`) or set REELFORGE_WHISPER.") : e);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        opts.signal?.removeEventListener("abort", abort);
        if (opts.signal?.aborted) return reject(new Error("cancelled"));
        if (code === 0) resolve();
        else reject(new Error(`transcription failed (exit ${code}): ${tail.split("\n").filter(Boolean).slice(-2).join(" | ")}`));
      });
    });
    return interpretWhisper(JSON.parse(readFileSync(`${base}.json`, "utf8")) as WhisperJson);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}
