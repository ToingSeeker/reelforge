import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ReelForgeError, type Asset } from "@reelforge/core";
import { ffmpegBin, ffmpegReason, limiter, run } from "./ffmpeg.ts";
import { sourceInputArgs } from "./probe.ts";

export interface Thumbnail {
  path: string;
  contentType: "image/jpeg" | "image/png";
}

const limit = limiter(2);
const inflight = new Map<string, Promise<Thumbnail>>();

/** Cache key includes size+mtime so a relinked or changed file gets a fresh image. */
export function thumbnailFile(cacheDir: string, asset: Asset): Thumbnail {
  const audio = asset.kind === "audio";
  const name = `${asset.id}-${asset.sizeBytes}${audio ? "-wave.png" : ".jpg"}`;
  return { path: join(cacheDir, "thumbs", name), contentType: audio ? "image/png" : "image/jpeg" };
}

/** One image to exactly this path: no %d sequence expansion, no protocol prefixes read from the path. */
const SINGLE_IMAGE = ["-update", "1", "-f", "image2"];

function args(asset: Asset, out: string): string[] {
  const input = sourceInputArgs(asset.sourcePath);
  const common = ["-hide_banner", "-loglevel", "error", "-nostdin", "-y"];
  if (asset.kind === "audio") {
    // Waveform strip in the music-track colour; also used as the clip background in the timeline.
    return [...common, ...input, "-filter_complex", "aformat=channel_layouts=mono,showwavespic=s=960x120:colors=0x2bd47d", "-frames:v", "1", ...SINGLE_IMAGE, `file:${out}`];
  }
  // Poster frame 10% in (capped at 3s) so black lead-ins don't become the thumbnail.
  const seek = asset.kind === "video" && asset.durationUs ? Math.min(asset.durationUs * 0.1, 3_000_000) / 1_000_000 : 0;
  return [
    ...common,
    ...(seek > 0 ? ["-ss", seek.toFixed(3)] : []),
    ...input,
    "-frames:v",
    "1",
    "-vf",
    "scale=480:480:force_original_aspect_ratio=decrease",
    "-q:v",
    "5",
    ...SINGLE_IMAGE,
    `file:${out}`,
  ];
}

/** Return the cached thumbnail, generating it on first request. Never writes next to the source. */
export function ensureThumbnail(cacheDir: string, asset: Asset): Promise<Thumbnail> {
  const thumb = thumbnailFile(cacheDir, asset);
  if (existsSync(thumb.path)) return Promise.resolve(thumb);
  if (asset.status === "missing") {
    return Promise.reject(new ReelForgeError("NOT_FOUND", "source media is offline; relink it to restore the thumbnail", { assetId: asset.id }));
  }
  const pending = inflight.get(thumb.path);
  if (pending) return pending;

  const job = limit(async () => {
    mkdirSync(join(cacheDir, "thumbs"), { recursive: true });
    const tmp = `${thumb.path}.${process.pid}.tmp${thumb.contentType === "image/png" ? ".png" : ".jpg"}`;
    try {
      await run(ffmpegBin(), args(asset, tmp), { timeoutMs: 30_000 });
      renameSync(tmp, thumb.path); // atomic: readers never see a half-written file
      return thumb;
    } catch (e) {
      rmSync(tmp, { force: true });
      if (e instanceof ReelForgeError) throw e;
      throw new ReelForgeError("VALIDATION_ERROR", `could not create a thumbnail: ${ffmpegReason(e, asset.sourcePath)}`, { assetId: asset.id });
    }
  }).finally(() => inflight.delete(thumb.path));
  inflight.set(thumb.path, job);
  return job;
}
