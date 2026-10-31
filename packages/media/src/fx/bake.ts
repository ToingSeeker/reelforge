// Bakes AI effects (core/fx-bake.ts specs) with the bundled effects engine
// (packages/fx-engine/fx.py, Python + OpenCV + MediaPipe). For each spec we cut
// the stretch of source it covers into a clean intermediate at the project's
// frame rate, so the engine never opens the user's file itself and only
// processes those seconds, then run the engine on it and keep the result in
// the cache under the spec's key.

import { spawn, type ChildProcess } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { ReelForgeError, type FxBakeSpec } from "@reelforge/core";
import { ffmpegBin, ffmpegReason, run } from "../ffmpeg.ts";
import { sourceInputArgs } from "../probe.ts";

/** The engine folder: REELFORGE_FX_DIR (the desktop app points it at its bundle), else the monorepo copy. */
export function fxEngineDir(): string {
  if (process.env.REELFORGE_FX_DIR) return process.env.REELFORGE_FX_DIR;
  return join(dirname(fileURLToPath(import.meta.url)), "../../../fx-engine");
}

/** The engine's Python: REELFORGE_FX_PYTHON, the bundled runtime, or a dev venv made by scripts/setup-fx.sh. */
export function fxPython(dir = fxEngineDir()): string | null {
  if (process.env.REELFORGE_FX_PYTHON) return process.env.REELFORGE_FX_PYTHON;
  for (const p of [join(dir, "python/bin/python3"), join(dir, ".venv/bin/python")]) if (existsSync(p)) return p;
  return null;
}

export function fxAvailable(): { ok: true } | { ok: false; reason: string } {
  const dir = fxEngineDir();
  if (!existsSync(join(dir, "scripts/fx.py"))) return { ok: false, reason: `AI effects engine not found at ${dir}` };
  if (!fxPython(dir)) return { ok: false, reason: "AI effects need their Python runtime: run scripts/setup-fx.sh (development) or reinstall ReelForge" };
  return { ok: true };
}

export function bakePath(cacheDir: string, key: string): string {
  if (!/^[0-9a-f]{16}$/.test(key)) throw new ReelForgeError("VALIDATION_ERROR", "invalid effect key");
  return join(cacheDir, "fx", `${key}.mp4`);
}

const secs = (frames: number, fps: { num: number; den: number }) => ((frames * fps.den) / fps.num).toFixed(6);

export interface BakeOptions {
  cacheDir: string;
  signal?: AbortSignal;
  onProgress?: (p: number) => void;
}

/** Render one bake into the cache (no-op when it is already there). Returns the baked file. */
export async function bakeFx(spec: FxBakeSpec, opts: BakeOptions): Promise<string> {
  const out = bakePath(opts.cacheDir, spec.key);
  if (existsSync(out)) return out;
  const avail = fxAvailable();
  if (!avail.ok) throw new ReelForgeError("UNAVAILABLE", avail.reason);
  const dir = fxEngineDir();
  const python = fxPython(dir)!;
  const work = join(opts.cacheDir, "fx", `work-${spec.key}-${randomBytes(4).toString("hex")}`);
  mkdirSync(work, { recursive: true });
  try {
    // 1. The stretch, at the project rate, the bake's size, no audio. The engine reads only this.
    const rate = spec.fps.num / spec.fps.den;
    const scale = `scale=${spec.width}:${spec.height}:flags=bicubic`;
    const clip = join(work, "clip.mp4");
    try {
      await run(
        ffmpegBin(),
        [
          "-hide_banner", "-nostdin", "-loglevel", "error", "-y",
          ...sourceInputArgs(spec.sourcePath, ["-ss", secs(spec.sourceFrom, spec.fps)]),
          "-t", secs(spec.sourceTo - spec.sourceFrom, spec.fps),
          "-an", "-vf", `fps=${spec.fps.num}/${spec.fps.den},${scale},setsar=1,format=yuv420p`,
          "-c:v", "libx264", "-preset", "veryfast", "-crf", "12", "-movflags", "+faststart", clip,
        ],
        { timeoutMs: 30 * 60_000 },
      );
    } catch (e) {
      throw new Error(`could not prepare the clip for effects: ${ffmpegReason(e, spec.sourcePath)}`);
    }

    // 2. The engine's plan. Pictures come from project media, linked into a folder per effect.
    const plan = spec.effects.map((e, i) => {
      const step: Record<string, string | number> = { ...(e.opts ?? {}), fx: e.fx, start: e.start, end: e.end };
      if (e.text !== undefined) step.text = e.text;
      if (e.color !== undefined) step.color = e.color;
      if (e.images?.length) {
        const folder = join(work, `images-${i}`);
        mkdirSync(folder);
        e.images.forEach((p, k) => {
          const link = join(folder, `${String(k).padStart(3, "0")}${extname(p).toLowerCase()}`);
          try {
            symlinkSync(p, link);
          } catch {
            copyFileSync(p, link);
          }
        });
        step.images = folder;
      }
      return step;
    });
    const planFile = join(work, "plan.json");
    writeFileSync(planFile, JSON.stringify({ effects: plan }));

    // 3. Run it. Its own ffmpeg calls find ours first on PATH.
    const partial = join(work, "baked.mp4");
    const short = spec.shortSide;
    await runEngine(python, [join(dir, "scripts/fx.py"), "--plan", planFile, clip, partial, "--width", String(short)], {
      cwd: work,
      env: { ...process.env, PATH: `${dirname(ffmpegBin()) === "." ? "" : `${dirname(ffmpegBin())}:`}${process.env.PATH ?? ""}`, PYTHONDONTWRITEBYTECODE: "1", PYTHONNOUSERSITE: "1" },
      signal: opts.signal,
      duration: (spec.sourceTo - spec.sourceFrom) / rate,
      onProgress: opts.onProgress,
    });
    mkdirSync(dirname(out), { recursive: true });
    renameSync(partial, out);
    return out;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/**
 * The engine prints "Pass 1: tracking…", "Pass 2: adding the effects…" and "  12.0s / 30.0s"
 * every 5 s of pass 2. Tracking is roughly the first third of the time.
 */
function runEngine(
  python: string,
  args: string[],
  o: { cwd: string; env: NodeJS.ProcessEnv; signal?: AbortSignal; duration: number; onProgress?: (p: number) => void },
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (o.signal?.aborted) return reject(new Error("cancelled"));
    let child: ChildProcess;
    try {
      child = spawn(python, ["-I", ...args], { cwd: o.cwd, env: o.env, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      return reject(e);
    }
    const abort = () => child.kill("SIGKILL");
    o.signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, 60 * 60_000);
    let tail = "";
    const onOut = (c: Buffer) => {
      const s = c.toString("utf8");
      tail = (tail + s).slice(-4000);
      if (/Pass 1/.test(s)) o.onProgress?.(0.02);
      if (/Pass 2/.test(s)) o.onProgress?.(0.35);
      for (const m of s.matchAll(/([\d.]+)s \/ ([\d.]+)s/g)) o.onProgress?.(0.35 + 0.63 * Math.min(1, Number(m[1]) / Math.max(0.1, Number(m[2]))));
    };
    child.stdout!.on("data", onOut);
    child.stderr!.on("data", onOut);
    child.on("error", (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(e.code === "ENOENT" ? new ReelForgeError("UNAVAILABLE", `the AI effects Python runtime is missing (${python})`) : e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      o.signal?.removeEventListener("abort", abort);
      if (o.signal?.aborted) return reject(new Error("cancelled"));
      if (code === 0) return resolve();
      const last = tail.split("\n").map((l) => l.trim()).filter(Boolean).slice(-2).join(" | ");
      reject(new ReelForgeError("INTERNAL", `the effects engine failed (exit ${code}): ${last}`));
    });
  });
}

export type BakeState = { state: "queued" | "running"; progress: number } | { state: "done"; path: string } | { state: "failed"; error: string };

/**
 * One bake at a time (each is CPU-heavy), deduplicated by key, shared by the
 * server (live preview) and the render runner (exports). Failures are kept so
 * the UI can say why; asking again retries.
 */
export class FxBaker {
  readonly #cacheDir: string;
  readonly #states = new Map<string, BakeState>();
  readonly #pending = new Map<string, Promise<string>>();
  readonly #specs = new Map<string, FxBakeSpec>();
  #queue: string[] = [];
  #current: { key: string; ctl: AbortController } | null = null;
  #stopped = false;
  readonly #resolvers = new Map<string, { resolve: (p: string) => void; reject: (e: unknown) => void }>();

  constructor(cacheDir: string) {
    this.#cacheDir = cacheDir;
  }

  state(key: string): BakeState | null {
    const s = this.#states.get(key);
    if (s) return s;
    const p = bakePath(this.#cacheDir, key);
    return existsSync(p) ? { state: "done", path: p } : null;
  }

  /** Queue a bake (or return the one in flight). Resolves with the baked file. */
  ensure(spec: FxBakeSpec): Promise<string> {
    const done = this.state(spec.key);
    if (done?.state === "done") return Promise.resolve(done.path);
    const inflight = this.#pending.get(spec.key);
    if (inflight) return inflight;
    if (this.#stopped) return Promise.reject(new Error("stopped"));
    const p = new Promise<string>((resolve, reject) => this.#resolvers.set(spec.key, { resolve, reject }));
    p.catch(() => {}); // callers that only queue don't await
    this.#pending.set(spec.key, p);
    this.#specs.set(spec.key, spec);
    this.#states.set(spec.key, { state: "queued", progress: 0 });
    this.#queue.push(spec.key);
    void this.#pump();
    return p;
  }

  async #pump() {
    if (this.#current || this.#stopped) return;
    const key = this.#queue.shift();
    if (!key) return;
    const spec = this.#specs.get(key)!;
    const ctl = new AbortController();
    this.#current = { key, ctl };
    this.#states.set(key, { state: "running", progress: 0 });
    const r = this.#resolvers.get(key)!;
    try {
      const path = await bakeFx(spec, {
        cacheDir: this.#cacheDir,
        signal: ctl.signal,
        onProgress: (progress) => this.#states.set(key, { state: "running", progress }),
      });
      this.#states.set(key, { state: "done", path });
      r.resolve(path);
    } catch (e) {
      this.#states.set(key, { state: "failed", error: e instanceof Error ? e.message : String(e) });
      r.reject(e);
    } finally {
      this.#pending.delete(key);
      this.#resolvers.delete(key);
      this.#specs.delete(key);
      this.#current = null;
      void this.#pump();
    }
  }

  /** Kill the running bake and drop the queue (server shutdown). */
  stop(): void {
    this.#stopped = true;
    this.#current?.ctl.abort();
    for (const key of this.#queue) this.#resolvers.get(key)?.reject(new Error("stopped"));
    this.#queue = [];
  }
}
