// Source pictures for the phone's editor: one still at an exact source frame (the live framing preview
// composites it with the same placement maths as the export), and a filmstrip per asset (the timeline's
// thumbnail strip). Both are cached under <cache>/stills and never written next to the source.
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { ReelForgeError, type Asset } from "@reelforge/core";
import { ffmpegBin, ffmpegReason, limiter, run } from "./ffmpeg.ts";
import { sourceInputArgs } from "./probe.ts";

const limit = limiter(2);
const inflight = new Map<string, Promise<string>>();
const COMMON = ["-hide_banner", "-loglevel", "error", "-nostdin", "-y"];
const SINGLE_IMAGE = ["-update", "1", "-f", "image2"];
/** Long side of a still; enough for a phone preview of a 1080-wide frame. */
export const STILL_MAX = 720;
export const FILMSTRIP_HEIGHT = 90;
export const FILMSTRIP_MAX_TILES = 40;

export interface Filmstrip {
  path: string;
  /** Tiles side by side, left to right; tile i shows the source at i × stepUs. */
  count: number;
  stepUs: number;
}

function once(path: string, make: (tmp: string) => Promise<void>): Promise<string> {
  if (existsSync(path)) return Promise.resolve(path);
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

/** The source picture at `timeUs` (accurate seek), ≤ STILL_MAX px on the long side, as JPEG. */
export async function sourceStill(cacheDir: string, asset: Asset, timeUs: number): Promise<string> {
  usable(asset);
  const t = asset.kind === "image" ? 0 : Math.max(0, Math.min(Math.round(timeUs), Math.max(0, (asset.durationUs ?? 0) - 1000)));
  const dir = join(cacheDir, "stills");
  const out = join(dir, `${asset.id}-${asset.sizeBytes}-${t}.jpg`);
  try {
    return await once(out, async (tmp) => {
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

/** Evenly spaced pictures of the whole source in one JPEG strip (≤ 40 tiles, at least a second apart). */
export async function ensureFilmstrip(cacheDir: string, asset: Asset): Promise<Filmstrip> {
  usable(asset);
  const durUs = asset.kind === "image" ? 0 : (asset.durationUs ?? 0);
  const count = durUs > 0 ? Math.max(1, Math.min(FILMSTRIP_MAX_TILES, Math.floor(durUs / 1_000_000))) : 1;
  const stepUs = count > 1 ? Math.floor(durUs / count) : Math.max(1, durUs);
  const out = join(cacheDir, "stills", "strips", `${asset.id}-${asset.sizeBytes}-${count}.jpg`);
  const fps = count > 1 ? `fps=${(1_000_000 / stepUs).toFixed(6)}:start_time=0,` : "";
  try {
    const path = await once(out, (tmp) =>
      run(
        ffmpegBin(),
        [
          ...COMMON,
          ...sourceInputArgs(asset.sourcePath),
          "-frames:v", "1",
          "-vf", `${fps}scale=-2:${FILMSTRIP_HEIGHT},tile=${count}x1`,
          "-q:v", "6",
          ...SINGLE_IMAGE,
          `file:${tmp}`,
        ],
        { timeoutMs: 60_000 },
      ).then(() => undefined),
    );
    return { path, count, stepUs };
  } catch (e) {
    if (e instanceof ReelForgeError) throw e;
    throw new ReelForgeError("VALIDATION_ERROR", `could not make a filmstrip: ${ffmpegReason(e, asset.sourcePath)}`, { assetId: asset.id });
  }
}
