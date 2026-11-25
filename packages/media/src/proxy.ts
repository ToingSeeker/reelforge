import { existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { ReelForgeError, type Database } from "@reelforge/core";
import { ffmpegBin, ffmpegReason, ffprobeBin, limiter, run } from "./ffmpeg.ts";
import { sourceInputArgs } from "./probe.ts";
import { BT709_TAGS } from "./compile.ts";

const limit = limiter(2);
const inflight = new Map<string, Promise<string>>();
export const PROXY_MAX = 960;
/** Bump when proxy encoding changes so stale cached proxies are rebuilt (v2: BT.709 conversion + tags). */
const PROXY_VERSION = 2;

/**
 * Alpha video proxies are "packed": the colour picture on top, its alpha as grey below, in one
 * ordinary H.264 file of twice the height. Browsers don't agree on any video codec with alpha
 * (WKWebView: HEVC only; Chromium: VP9 only), so the live preview unpacks it in a shader.
 */
export const PACKED_ALPHA = "packed-alpha-v1";

/**
 * Low-resolution stand-in for a video source, used by the live preview. Short GOP for fast
 * seeking; rebuilt when the source changes or the cache is cleared. Pictures with an alpha
 * channel keep it: a PNG for stills, a packed proxy for video (see PACKED_ALPHA).
 */
export function ensureProxy(
  db: Database,
  cacheDir: string,
  assetId: string,
  sourcePath: string,
  kind: "video" | "image" | "audio" = "video",
  alpha = false,
): Promise<string> {
  let size: number;
  try {
    size = statSync(sourcePath).size;
  } catch {
    return Promise.reject(new ReelForgeError("NOT_FOUND", "source media is offline; relink it", { assetId }));
  }
  const row = db.prepare("SELECT path, source_size FROM proxies WHERE asset_id = ?").get(assetId) as
    | { path: string; source_size: number }
    | undefined;
  const ext = kind === "image" ? (alpha ? "png" : "jpg") : kind === "audio" ? "m4a" : "mp4";
  const out = join(cacheDir, "proxies", `${assetId}-${size}-v${PROXY_VERSION}${alpha ? "-a" : ""}.${ext}`);
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
      // Same BT.709 conversion + tags as the export, so the browser decodes the proxy to the colours the render produces.
      const fit = `scale=${PROXY_MAX}:${PROXY_MAX}:force_original_aspect_ratio=decrease:force_divisible_by=2`;
      const to709 = "scale=out_color_matrix=bt709:out_range=tv,setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv";
      await run(
        ffmpegBin(),
        kind === "audio"
          ? // Sound only, as AAC every browser decodes (AIFF, Opus-in-WebM… aren't decoded everywhere).
            [...common, "-map", "0:a:0", "-vn", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", "-f", "mp4", `file:${tmp}`]
          : kind === "image"
          ? // Stills: one ≤1280 px picture, enough for a 1080-wide frame at preview size; PNG keeps transparency.
            [
              ...common, "-frames:v", "1",
              "-vf", `scale=1280:1280:force_original_aspect_ratio=decrease:force_divisible_by=2${alpha ? ",format=rgba" : ""}`,
              ...(alpha ? ["-c:v", "png"] : ["-q:v", "3"]), "-update", "1", "-f", "image2", `file:${tmp}`,
            ]
          : alpha
          ? [
              ...common,
              // Colour on top, alpha below (full-range grey squeezed into TV range so the browser's
              // decode stretches it back to 0–255). Unpacked by the preview's AlphaUnpack shader.
              "-filter_complex",
              `[0:v]${fit},format=yuva444p,split[c][a];[c]${to709},format=yuv420p[top];` +
                `[a]alphaextract,scale=in_range=pc:out_range=tv,format=yuv420p,setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv[bottom];` +
                `[top][bottom]vstack[v]`,
              "-map", "[v]", "-map", "0:a?",
              "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-g", "15", "-pix_fmt", "yuv420p", ...BT709_TAGS,
              "-c:a", "aac", "-b:a", "128k",
              "-metadata:s:v:0", `comment=${PACKED_ALPHA}`,
              "-movflags", "+faststart", "-f", "mp4", `file:${tmp}`,
            ]
          : [
              ...common,
              "-vf", `${fit}:out_color_matrix=bt709:out_range=tv,setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv`,
              // Short GOP: the live preview seeks a lot.
              "-c:v", "libx264", "-preset", "veryfast", "-crf", "26", "-g", "15", "-pix_fmt", "yuv420p", ...BT709_TAGS,
              "-c:a", "aac", "-b:a", "128k",
              "-movflags", "+faststart", "-f", "mp4", `file:${tmp}`,
            ],
        { timeoutMs: 30 * 60_000 },
      );
      renameSync(tmp, out);
    } catch (e) {
      rmSync(tmp, { force: true });
      if (e instanceof ReelForgeError) throw e;
      throw new ReelForgeError("VALIDATION_ERROR", `could not create a preview proxy: ${ffmpegReason(e, sourcePath)}`, { assetId });
    }
    // Our own file, but probed like every source: forced demuxer, local files only.
    const dims =
      kind === "audio"
        ? [0, 0]
        : (await run(ffprobeBin(), ["-v", "error", ...sourceInputArgs(out), "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0"])).stdout
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
