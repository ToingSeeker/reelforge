import { spawn } from "node:child_process";
import { ReelForgeError } from "@reelforge/core";

export const ffprobeBin = () => process.env.REELFORGE_FFPROBE ?? "ffprobe";
export const ffmpegBin = () => process.env.REELFORGE_FFMPEG ?? "ffmpeg";

export interface RunResult {
  stdout: string;
  stderr: string;
}

/**
 * Run an FFmpeg tool with an argument vector, never through a shell, so file
 * names can't inject commands. Output is capped and the process is killed on timeout.
 */
export function run(bin: string, args: string[], opts: { timeoutMs?: number; maxBytes?: number } = {}): Promise<RunResult> {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const maxBytes = opts.maxBytes ?? 16 * 1024 * 1024;
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let size = 0;
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    const take = (chunk: Buffer, into: "out" | "err") => {
      size += chunk.length;
      if (size > maxBytes) return child.kill("SIGKILL");
      if (into === "out") stdout += chunk.toString("utf8");
      else stderr += chunk.toString("utf8");
    };
    child.stdout.on("data", (c: Buffer) => take(c, "out"));
    child.stderr.on("data", (c: Buffer) => take(c, "err"));
    child.on("error", (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(
        e.code === "ENOENT"
          ? new ReelForgeError("UNAVAILABLE", `${bin} not found. Install FFmpeg (macOS: \`brew install ffmpeg\`) or set REELFORGE_FFMPEG / REELFORGE_FFPROBE.`)
          : e,
      );
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) return resolve({ stdout, stderr });
      const reason = signal ? `killed (${signal}${size > maxBytes ? ", output too large" : ", timed out"})` : `exit ${code}`;
      const err = Object.assign(new Error(`${bin} failed: ${reason}`), { stderr });
      reject(err);
    });
  });
}

/** First meaningful line of FFmpeg's stderr, without the input path echoed back or FFmpeg's memory addresses ("[png @ 0x7f…]"). */
export function ffmpegReason(e: unknown, path?: string): string {
  const stderr = (e as { stderr?: string }).stderr ?? "";
  const line = (stderr.split("\n").map((l) => l.trim()).find(Boolean) ?? (e instanceof Error ? e.message : String(e))).replace(/ @ 0x[0-9a-fA-F]+\]/g, "]");
  return path ? line.replaceAll(`file:${path}`, "<file>").replaceAll(path, "<file>") : line;
}

/** A tiny FIFO limiter so a burst of thumbnail requests can't spawn dozens of FFmpegs. */
export function limiter(concurrency: number) {
  let active = 0;
  const queue: (() => void)[] = [];
  const next = () => {
    if (active >= concurrency) return;
    const job = queue.shift();
    if (job) job();
  };
  return <T>(fn: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      queue.push(() => {
        active++;
        fn().then(resolve, reject).finally(() => {
          active--;
          next();
        });
      });
      next();
    });
}
