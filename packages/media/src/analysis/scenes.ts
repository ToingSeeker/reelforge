import type { ScenesResult } from "@reelforge/core";
import { ffmpegBin, ffmpegReason, run } from "../ffmpeg.ts";
import { sourceInputArgs } from "../probe.ts";

export const SCENES_ENGINE = "ffmpeg-scdet";

/**
 * Scene changes via FFmpeg's scdet (on the proxy: same cuts, much faster).
 * `threshold` is scdet's percentage of change between frames.
 */
export async function detectScenes(path: string, threshold = 10): Promise<ScenesResult> {
  let stdout: string;
  try {
    ({ stdout } = await run(
      ffmpegBin(),
      ["-hide_banner", "-nostdin", "-loglevel", "error", ...sourceInputArgs(path), "-an", "-vf", `scdet=threshold=${threshold}:sc_pass=1,metadata=print:file=-`, "-f", "null", "-"],
      { timeoutMs: 60 * 60_000, maxBytes: 64 * 1024 * 1024 },
    ));
  } catch (e) {
    throw new Error(`scene detection failed: ${ffmpegReason(e, path)}`);
  }
  const cuts: ScenesResult["cuts"] = [];
  let time: number | null = null;
  for (const line of stdout.split("\n")) {
    const pts = /pts_time:([\d.]+)/.exec(line);
    if (pts) time = Number(pts[1]);
    const score = /lavfi\.scd\.score=([\d.]+)/.exec(line);
    if (score && time !== null) {
      cuts.push({ timeUs: Math.round(time * 1_000_000), score: Number(score[1]) });
      time = null;
    }
  }
  return { cuts };
}
