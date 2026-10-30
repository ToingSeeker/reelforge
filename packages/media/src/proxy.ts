import { existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "@reelforge/core";
import { ffmpegBin, ffmpegReason, ffprobeBin, limiter, run } from "./ffmpeg.ts";
import { sourceInputArgs } from "./probe.ts";

const limit = limiter(2);
const inflight = new Map<string, Promise<string>>();
export const PROXY_MAX = 960;

/**
 * Low-resolution stand-in for a video source, used by preview renders.
 * Short GOP for fast seeking; rebuilt when the source changes or the cache is cleared.
 */
export function ensureProxy(db: Database, cacheDir: string, assetId: string, sourcePath: string): Promise<string> {
  const size = statSync(sourcePath).size;
  const row = db.prepare("SELECT path, source_size FROM proxies WHERE asset_id = ?").get(assetId) as
    | { path: string; source_size: number }
    | undefined;
  if (row && row.source_size === size && existsSync(row.path)) return Promise.resolve(row.path);

  const key = `${assetId}:${size}`;
  const pending = inflight.get(key);
  if (pending) return pending;
  const job = limit(async () => {
    const dir = join(cacheDir, "proxies");
    mkdirSync(dir, { recursive: true });
    const out = join(dir, `${assetId}-${size}.mp4`);
    const tmp = `${out}.${process.pid}.tmp.mp4`;
    try {
      await run(
        ffmpegBin(),
        [
          "-hide_banner", "-nostdin", "-loglevel", "error", "-y",
          ...sourceInputArgs(sourcePath),
          "-vf", `scale=${PROXY_MAX}:${PROXY_MAX}:force_original_aspect_ratio=decrease:force_divisible_by=2`,
          "-c:v", "libx264", "-preset", "veryfast", "-crf", "26", "-g", "15", "-pix_fmt", "yuv420p",
          "-c:a", "aac", "-b:a", "128k",
          "-movflags", "+faststart", "-f", "mp4", tmp,
        ],
        { timeoutMs: 30 * 60_000 },
      );
      renameSync(tmp, out);
    } catch (e) {
      rmSync(tmp, { force: true });
      throw new Error(`could not create a proxy: ${ffmpegReason(e, sourcePath)}`);
    }
    const dims = (await run(ffprobeBin(), ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", out])).stdout
      .trim()
      .split(",")
      .map(Number);
    db.prepare(
      `INSERT INTO proxies (asset_id, path, width, height, source_size, created_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (asset_id) DO UPDATE SET path = excluded.path, width = excluded.width, height = excluded.height,
         source_size = excluded.source_size, created_at = excluded.created_at`,
    ).run(assetId, out, dims[0] ?? 0, dims[1] ?? 0, size, new Date().toISOString());
    if (row && row.path !== out) rmSync(row.path, { force: true });
    return out;
  }).finally(() => inflight.delete(key));
  inflight.set(key, job);
  return job;
}
