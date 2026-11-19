// Source pictures for the phone's editor: one still at an exact source frame (the live framing preview
// composites it with the same placement maths as the export), and a filmstrip per asset (the timeline's
// thumbnail strip). Both are cached under <cache>/stills and never written next to the source.
//
// Stills and strips queue separately: a strip of a long source must never hold up the still under the
// phone's finger. A still the phone no longer wants (it scrubbed on) is skipped before FFmpeg starts.
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { ReelForgeError, type Asset } from "@reelforge/core";
import { ffmpegBin, ffmpegReason, limiter, run } from "./ffmpeg.ts";
import { sourceInputArgs } from "./probe.ts";

const stillLimit = limiter(2);
const stripLimit = limiter(1);
const inflight = new Map<string, Promise<string>>();
const COMMON = ["-hide_banner", "-loglevel", "error", "-nostdin", "-y"];
const SINGLE_IMAGE = ["-update", "1", "-f", "image2"];
/** Long side of a still; enough for a phone preview of a 1080-wide frame. */
export const STILL_MAX = 720;
export const FILMSTRIP_HEIGHT = 90;
export const FILMSTRIP_MAX_TILES = 40;
/** Thrown for a still nobody waits for any more; the phone ignores it. */
export const STILL_SUPERSEDED = "superseded by a newer frame";

export interface Filmstrip {
  path: string;
  /** Tiles side by side, left to right; tile i shows the source at i × stepUs. */
  count: number;
  stepUs: number;
}

function once(path: string, limit: ReturnType<typeof limiter>, make: (tmp: string) => Promise<void>): Promise<string> {
  if (existsSync(path)) {
    // Touched on use, so pruning drops the stills nobody looked at, not the busy ones.
    try {
      const now = new Date();
      utimesSync(path, now, now);
    } catch {
      // a cache
    }
    return Promise.resolve(path);
  }
  const pending = inflight.get(path);
  if (pending) return pending;
  const job = limit(async () => {
    mkdirSync(join(path, ".."), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp.jpg`;
    try {
      await make(tmp);
      renameSync(tmp, path);
      return path;
    } finally {
      rmSync(tmp, { force: true });
    }
  }).finally(() => inflight.delete(path));
  inflight.set(path, job);
  return job;
}

function usable(asset: Asset): void {
  if (asset.status === "missing") throw new ReelForgeError("NOT_FOUND", "source media is offline; relink it on the Mac", { assetId: asset.id });
  if (asset.kind === "audio") throw new ReelForgeError("VALIDATION_ERROR", "audio has no picture", { assetId: asset.id });
}

/** Keeps the stills folder from growing without bound: past 400 files, the newest 200 stay. */
function prune(dir: string): void {
  try {
    const files = readdirSync(dir).filter((f) => f.endsWith(".jpg"));
    if (files.length <= 400) return;
    files
      .map((f) => ({ f, t: statSync(join(dir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t)
      .slice(200)
      .forEach(({ f }) => rmSync(join(dir, f), { force: true }));
  } catch {
    // a cache: losing the race with another prune is fine
  }
}

/**
 * The source picture at `timeUs` (accurate seek), ≤ STILL_MAX px on the long side, as JPEG. `wanted` is
 * asked once its turn comes; false (the phone moved on) skips FFmpeg and throws STILL_SUPERSEDED.
 */
export async function sourceStill(cacheDir: string, asset: Asset, timeUs: number, wanted: () => boolean = () => true): Promise<string> {
  usable(asset);
  const t = asset.kind === "image" ? 0 : Math.max(0, Math.min(Math.round(timeUs), Math.max(0, (asset.durationUs ?? 0) - 1000)));
  const dir = join(cacheDir, "stills");
  const out = join(dir, `${asset.id}-${asset.sizeBytes}-${t}.jpg`);
  try {
    return await once(out, stillLimit, async (tmp) => {
      if (!wanted()) throw new ReelForgeError("VALIDATION_ERROR", STILL_SUPERSEDED, { assetId: asset.id, superseded: true });
      prune(dir);
      await run(
        ffmpegBin(),
        [
          ...COMMON,
          ...(t > 0 ? ["-ss", (t / 1_000_000).toFixed(6)] : []),
          ...sourceInputArgs(asset.sourcePath),
          "-frames:v", "1",
          "-vf", `scale=${STILL_MAX}:${STILL_MAX}:force_original_aspect_ratio=decrease:force_divisible_by=2,scale=out_color_matrix=bt709`,
          "-q:v", "4",
          ...SINGLE_IMAGE,
          `file:${tmp}`,
        ],
        { timeoutMs: 20_000 },
      );
    });
  } catch (e) {
    if (e instanceof ReelForgeError) throw e;
    throw new ReelForgeError("VALIDATION_ERROR", `could not read that frame: ${ffmpegReason(e, asset.sourcePath)}`, { assetId: asset.id });
  }
}

/**
 * Evenly spaced pictures of the whole source in one JPEG strip (≤ 40 tiles, at least a second apart).
 * Each tile is its own seek, so a 30-minute 4K source costs 40 short decodes, not a decode of all of it.
 */
export async function ensureFilmstrip(cacheDir: string, asset: Asset): Promise<Filmstrip> {
  usable(asset);
  const durUs = asset.kind === "image" ? 0 : (asset.durationUs ?? 0);
  const count = durUs > 0 ? Math.max(1, Math.min(FILMSTRIP_MAX_TILES, Math.floor(durUs / 1_000_000))) : 1;
  const stepUs = count > 1 ? Math.floor(durUs / count) : Math.max(1, durUs);
  const out = join(cacheDir, "stills", "strips", `${asset.id}-${asset.sizeBytes}-${count}.jpg`);
  const tile = `scale=-2:${FILMSTRIP_HEIGHT}:out_color_matrix=bt709`;
  try {
    const path = await once(out, stripLimit, async (tmp) => {
      const dir = `${tmp}.tiles`;
      mkdirSync(dir, { recursive: true });
      try {
        const tiles: string[] = [];
        for (let i = 0; i < count; i++) {
          const t = i * stepUs;
          const file = join(dir, `${i}.jpg`);
          try {
            await run(
              ffmpegBin(),
              [...COMMON, ...(t > 0 ? ["-ss", (t / 1_000_000).toFixed(6)] : []), ...sourceInputArgs(asset.sourcePath), "-frames:v", "1", "-vf", tile, "-q:v", "6", ...SINGLE_IMAGE, `file:${file}`],
              { timeoutMs: 20_000 },
            );
          } catch (e) {
            if (i === 0) throw e;
          }
          // A seek that found no picture (past the last keyframe) repeats the tile before it.
          tiles.push(existsSync(file) ? file : tiles[i - 1]!);
        }
        if (count === 1) return renameSync(tiles[0]!, tmp);
        await run(
          ffmpegBin(),
          [
            ...COMMON,
            ...tiles.flatMap((f) => ["-f", "image2", "-i", `file:${f}`]),
            "-filter_complex", `${tiles.map((_, i) => `[${i}:v]`).join("")}hstack=inputs=${count}`,
            "-frames:v", "1", "-q:v", "6",
            ...SINGLE_IMAGE,
            `file:${tmp}`,
          ],
          { timeoutMs: 30_000 },
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
    return { path, count, stepUs };
  } catch (e) {
    if (e instanceof ReelForgeError) throw e;
    throw new ReelForgeError("VALIDATION_ERROR", `could not make a filmstrip: ${ffmpegReason(e, asset.sourcePath)}`, { assetId: asset.id });
  }
}
