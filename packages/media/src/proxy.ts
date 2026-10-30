import { existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "@reelforge/core";
import { ffmpegBin, ffmpegReason, ffprobeBin, limiter, run } from "./ffmpeg.ts";
import { sourceInputArgs } from "./probe.ts";
import { BT709_TAGS } from "./compile.ts";

const limit = limiter(2);
const inflight = new Map<string, Promise<string>>();
export const PROXY_MAX = 960;
/** Bump when proxy encoding changes so stale cached proxies are rebuilt (v2: BT.709 conversion + tags). */
const PROXY_VERSION = 2;

/**
 * Low-resolution stand-in for a video source, used by preview renders.
 * Short GOP for fast seeking; rebuilt when the source changes or the cache is cleared.
 */
export function ensureProxy(db: Database, cacheDir: string, assetId: string, sourcePath: string, kind: "video" | "image" = "video"): Promise<string> {
  const size = statSync(sourcePath).size;
  const row = db.prepare("SELECT path, source_size FROM proxies WHERE asset_id = ?").get(assetId) as
    | { path: string; source_size: number }
    | undefined;
  const ext = kind === "image" ? "jpg" : "mp4";
  const out = join(cacheDir, "proxies", `${assetId}-${size}-v${PROXY_VERSION}.${ext}`);
  if (row && row.path === out && row.source_size === size && existsSync(out)) return Promise.resolve(out);

  const key = `${assetId}:${size}`;
  const pending = inflight.get(key);
  if (pending) return pending;
  const job = limit(async () => {
    const dir = join(cacheDir, "proxies");
    mkdirSync(dir, { recursive: true });
    const tmp = `${out}.${process.pid}.tmp.${ext}`;
    try {
      const common = ["-hide_banner", "-nostdin", "-loglevel", "error", "-y", ...sourceInputArgs(sourcePath)];
      await run(
        ffmpegBin(),
        kind === "image"
          ? // Stills: one ≤1280 px JPEG, enough for a 1080-wide frame at preview size.
            [...common, "-frames:v", "1", "-vf", "scale=1280:1280:force_original_aspect_ratio=decrease:force_divisible_by=2", "-q:v", "3", "-f", "image2", tmp]
          : [
              ...common,
              // Same BT.709 conversion + tags as the export, so the browser decodes the proxy to the colours the render produces.
              "-vf", `scale=${PROXY_MAX}:${PROXY_MAX}:force_original_aspect_ratio=decrease:force_divisible_by=2:out_color_matrix=bt709:out_range=tv,setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv`,
              // Short GOP: the live preview seeks a lot.
              "-c:v", "libx264", "-preset", "veryfast", "-crf", "26", "-g", "15", "-pix_fmt", "yuv420p", ...BT709_TAGS,
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
