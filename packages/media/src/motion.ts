// Motion graphics: renders a template (core/motion-catalog.ts) with Remotion into a ProRes 4444
// file with alpha. Remotion runs in its own Node process (packages/motion/src/render.ts) because
// it brings a bundler, a headless Chrome and a native compositor that the engine shouldn't load.

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ReelForgeError, type MotionRenderSpec } from "@reelforge/core";

/**
 * Where the renderer lives: REELFORGE_MOTION_DIR (the desktop app points it at its bundle, which
 * holds render.mjs, a prebuilt Remotion bundle and Chrome), else the monorepo package.
 */
export function motionDir(): string {
  if (process.env.REELFORGE_MOTION_DIR) return process.env.REELFORGE_MOTION_DIR;
  return join(dirname(fileURLToPath(import.meta.url)), "../../motion");
}

interface MotionLayout {
  script: string;
  bundleDir?: string;
  browserExecutable?: string;
}

/** The packaged layout (render.mjs + bundle/ + chrome/) or the dev one (TypeScript sources, bundled on first use). */
function layout(dir = motionDir()): MotionLayout | null {
  const packaged = join(dir, "render.mjs");
  if (existsSync(packaged)) {
    const chrome = join(dir, "chrome/chrome-headless-shell");
    return { script: packaged, bundleDir: join(dir, "bundle"), ...(existsSync(chrome) ? { browserExecutable: chrome } : {}) };
  }
  const dev = join(dir, "src/render.ts");
  return existsSync(dev) && existsSync(join(dir, "node_modules/@remotion/renderer")) ? { script: dev } : null;
}

export function motionAvailable(): { ok: true } | { ok: false; reason: string } {
  return layout() ? { ok: true } : { ok: false, reason: `motion graphics renderer not found at ${motionDir()} (development: pnpm install)` };
}

export function motionOutputPath(generatedDir: string, key: string): string {
  if (!/^[0-9a-f]{16}$/.test(key)) throw new ReelForgeError("VALIDATION_ERROR", "invalid motion key");
  return join(generatedDir, "motion", `${key}.mov`);
}

export interface MotionRenderOptions {
  generatedDir: string;
  cacheDir: string;
  signal?: AbortSignal;
  onProgress?: (p: number) => void;
}

/** Render one graphic (no-op when its file exists). Returns the file. */
export async function renderMotion(spec: MotionRenderSpec, opts: MotionRenderOptions): Promise<string> {
  const output = motionOutputPath(opts.generatedDir, spec.key);
  if (existsSync(output)) return output;
  const l = layout();
  if (!l) throw new ReelForgeError("UNAVAILABLE", (motionAvailable() as { reason: string }).reason);
  const request = { spec, output, cacheDir: opts.cacheDir, ...(l.bundleDir ? { bundleDir: l.bundleDir } : {}), ...(l.browserExecutable ? { browserExecutable: l.browserExecutable } : {}) };

  await new Promise<void>((resolve, reject) => {
    // The same Node that runs the engine (the bundled one in the app).
    const child: ChildProcess = spawn(process.execPath, [l.script], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, NODE_OPTIONS: "" } });
    let error: string | null = null;
    let stderr = "";
    let buf = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 15 * 60_000);
    const abort = () => child.kill("SIGKILL");
    opts.signal?.addEventListener("abort", abort, { once: true });
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (d: string) => {
      buf += d;
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const lineText = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        try {
          const msg = JSON.parse(lineText) as { progress?: number; error?: string };
          if (typeof msg.progress === "number") opts.onProgress?.(msg.progress);
          if (typeof msg.error === "string") error = msg.error;
        } catch {
          // a dependency's stray console output
        }
      }
    });
    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", (d: string) => (stderr = (stderr + d).slice(-4000)));
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", abort);
      if (opts.signal?.aborted) return reject(new Error("cancelled"));
      if (code === 0 && existsSync(output)) return resolve();
      reject(new Error(`motion graphic render failed: ${error ?? (stderr.trim().split("\n").pop() || `exit ${code}`)}`));
    });
    child.stdin!.end(`${JSON.stringify(request)}\n`);
  });
  return output;
}

export type MotionState =
  | { state: "queued"; progress: 0 }
  | { state: "running"; progress: number }
  | { state: "done"; path: string }
  | { state: "failed"; error: string };

/** One render at a time (each one drives a headless Chrome); equal specs share a render. */
export class MotionRenderer {
  readonly #opts: Omit<MotionRenderOptions, "signal" | "onProgress">;
  readonly #states = new Map<string, MotionState>();
  readonly #pending = new Map<string, Promise<string>>();
  #chain: Promise<unknown> = Promise.resolve();
  #ctl = new AbortController();

  constructor(opts: { generatedDir: string; cacheDir: string }) {
    this.#opts = opts;
  }

  state(key: string): MotionState | null {
    const s = this.#states.get(key);
    if (s) return s;
    const p = motionOutputPath(this.#opts.generatedDir, key);
    return existsSync(p) ? { state: "done", path: p } : null;
  }

  ensure(spec: MotionRenderSpec): Promise<string> {
    const done = this.state(spec.key);
    if (done?.state === "done") return Promise.resolve(done.path);
    const inflight = this.#pending.get(spec.key);
    if (inflight) return inflight;
    if (this.#ctl.signal.aborted) return Promise.reject(new Error("stopped"));
    this.#states.set(spec.key, { state: "queued", progress: 0 });
    const job = this.#chain.then(async () => {
      this.#states.set(spec.key, { state: "running", progress: 0 });
      try {
        const path = await renderMotion(spec, {
          ...this.#opts,
          signal: this.#ctl.signal,
          onProgress: (progress) => this.#states.set(spec.key, { state: "running", progress }),
        });
        this.#states.set(spec.key, { state: "done", path });
        return path;
      } catch (e) {
        this.#states.set(spec.key, { state: "failed", error: e instanceof Error ? e.message : String(e) });
        throw e;
      } finally {
        this.#pending.delete(spec.key);
      }
    });
    this.#chain = job.catch(() => {});
    job.catch(() => {}); // callers that only queue don't await
    this.#pending.set(spec.key, job);
    return job;
  }

  /** Kill the running render and refuse new ones (server shutdown). */
  stop(): void {
    this.#ctl.abort();
  }
}
