import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, linkSync, mkdirSync, readdirSync, realpathSync, rmSync, statSync, unlinkSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join } from "node:path";
import { AssetStore, JobStore, ReelForgeError, type Database, type JobKind, type RenderJob } from "@reelforge/core";
import { compileRender, exportSettings, previewSettings } from "./compile.ts";
import { ffmpegBin, ffprobeBin, run } from "./ffmpeg.ts";
import { ensureProxy } from "./proxy.ts";

/**
 * Where an export may be written: an absolute .mp4 path in an existing
 * directory, not already present (exports never overwrite), and never one of
 * the project's source files.
 */
export function validateExportPath(db: Database, projectId: string, path: string): string {
  if (typeof path !== "string" || !isAbsolute(path) || path.includes("\0")) {
    throw new ReelForgeError("VALIDATION_ERROR", "export path must be an absolute file path");
  }
  if (extname(path).toLowerCase() !== ".mp4") throw new ReelForgeError("VALIDATION_ERROR", "export path must end in .mp4");
  let dir: string;
  try {
    dir = realpathSync(dirname(path));
  } catch {
    throw new ReelForgeError("VALIDATION_ERROR", "export folder does not exist", { path });
  }
  if (!statSync(dir).isDirectory()) throw new ReelForgeError("VALIDATION_ERROR", "export folder is not a directory", { path });
  const target = join(dir, basename(path));
  if (existsSync(target)) throw new ReelForgeError("VALIDATION_ERROR", "a file already exists at that path; exports never overwrite", { path: target });
  if (new AssetStore(db).list(projectId).some((a) => a.sourcePath === target)) {
    throw new ReelForgeError("VALIDATION_ERROR", "refusing to write over the project's source media", { path: target });
  }
  return target;
}

export function createRenderJob(db: Database, projectId: string, kind: JobKind, outputPath?: string): RenderJob {
  const jobs = new JobStore(db);
  if (kind === "export") return jobs.create(projectId, kind, exportSettings, validateExportPath(db, projectId, outputPath ?? ""));
  return jobs.create(projectId, kind, previewSettings, null);
}

/** Retry a failed/cancelled job from the current timeline; exports re-check their output path. */
export function retryRenderJob(db: Database, jobId: string): RenderJob {
  const jobs = new JobStore(db);
  const job = jobs.get(jobId);
  if (job.kind === "export" && (job.state === "failed" || job.state === "cancelled")) validateExportPath(db, job.projectId, job.outputPath ?? "");
  return jobs.retry(jobId);
}

interface Running {
  child: ChildProcess | null;
  cancelled: boolean;
}

/**
 * Runs queued render jobs one at a time (PRD: render concurrency limit keeps
 * the desktop responsive). Output goes to a temporary file in the target
 * folder and is hard-linked into place only after FFmpeg succeeded and the
 * result was verified, so a failed render never leaves a "final" file.
 */
export class RenderRunner {
  readonly #db: Database;
  readonly #jobs: JobStore;
  readonly #cacheDir: string;
  readonly #queue: string[] = [];
  readonly #waiters = new Map<string, ((j: RenderJob) => void)[]>();
  #running: Map<string, Running> = new Map();
  #active = 0;
  readonly #concurrency: number;
  #stopped = false;

  constructor(db: Database, opts: { cacheDir: string; concurrency?: number }) {
    this.#db = db;
    this.#jobs = new JobStore(db);
    this.#cacheDir = opts.cacheDir;
    this.#concurrency = opts.concurrency ?? 1;
  }

  /** Fail jobs orphaned by a dead process, then pick up anything still queued. */
  start(): void {
    this.#jobs.recoverInterrupted();
    for (const id of this.#jobs.queued()) this.enqueue(id);
  }

  enqueue(jobId: string): void {
    if (!this.#queue.includes(jobId) && !this.#running.has(jobId)) this.#queue.push(jobId);
    this.#pump();
  }

  /** Resolves when the job reaches a terminal state in this runner. */
  wait(jobId: string): Promise<RenderJob> {
    const job = this.#jobs.get(jobId);
    if (["completed", "failed", "cancelled"].includes(job.state) && !this.#running.has(jobId)) return Promise.resolve(job);
    return new Promise((resolve) => this.#waiters.set(jobId, [...(this.#waiters.get(jobId) ?? []), resolve]));
  }

  cancel(jobId: string): RenderJob {
    const job = this.#jobs.cancel(jobId);
    const r = this.#running.get(jobId);
    if (r) {
      r.cancelled = true;
      r.child?.kill("SIGKILL");
    }
    return job;
  }

  stop(): void {
    this.#stopped = true;
    for (const r of this.#running.values()) {
      r.cancelled = true;
      r.child?.kill("SIGKILL");
    }
  }

  #pump() {
    while (!this.#stopped && this.#active < this.#concurrency && this.#queue.length) {
      const id = this.#queue.shift()!;
      this.#active++;
      void this.#process(id).finally(() => {
        this.#active--;
        this.#running.delete(id);
        const job = this.#jobs.get(id);
        for (const w of this.#waiters.get(id) ?? []) w(job);
        this.#waiters.delete(id);
        this.#pump();
      });
    }
  }

  async #process(jobId: string): Promise<void> {
    if (!this.#jobs.claim(jobId)) return; // cancelled or taken by another process
    const job = this.#jobs.get(jobId);
    const plan = this.#jobs.plan(jobId);
    const state: Running = { child: null, cancelled: false };
    this.#running.set(jobId, state);
    let tmp: string | null = null;

    try {
      // analyzing: every source still where the plan says, proxies ready for previews
      const offline = Object.values(plan.sources).filter((s) => !existsSync(s.path));
      if (offline.length) {
        return void this.#jobs.fail(jobId, "MEDIA_OFFLINE", `media offline: ${offline.map((s) => basename(s.path)).join(", ")}; relink and retry`);
      }
      const inputs: Record<string, string> = {};
      const sources = Object.values(plan.sources);
      let done = 0;
      for (const s of sources) {
        inputs[s.assetId] = job.settings.useProxies && s.kind === "video" ? await ensureProxy(this.#db, this.#cacheDir, s.assetId, s.path) : s.path;
        if (state.cancelled || !this.#jobs.advance(jobId, "analyzing", (++done / sources.length) * 0.05)) return;
      }

      const final = job.kind === "export" ? job.outputPath! : join(this.#cacheDir, "previews", job.projectId, `${jobId}.mp4`);
      mkdirSync(dirname(final), { recursive: true });
      tmp = join(dirname(final), `.${basename(final, ".mp4")}.partial-${jobId}.mp4`);

      // rendering
      if (!this.#jobs.advance(jobId, "rendering", 0.05)) return;
      const totalUs = (plan.totalFrames * plan.fps.den * 1_000_000) / plan.fps.num;
      await this.#ffmpeg(compileRender({ plan, settings: job.settings, inputs, output: tmp }), state, (outUs, end) => {
        if (end) return this.#jobs.advance(jobId, "muxing", 0.99);
        return this.#jobs.advance(jobId, "rendering", 0.05 + 0.93 * Math.min(1, outUs / totalUs));
      });
      if (state.cancelled || this.#jobs.isCancelled(jobId)) return;

      // muxing done by FFmpeg (+faststart); verify, then publish atomically
      this.#jobs.advance(jobId, "muxing", 0.995);
      const probe = await verifyOutput(tmp);
      if (probe.frames !== plan.totalFrames || probe.width !== job.settings.width || probe.height !== job.settings.height) {
        throw new ReelForgeError("INTERNAL", `render verification failed: got ${probe.frames} frames at ${probe.width}×${probe.height}, expected ${plan.totalFrames} at ${job.settings.width}×${job.settings.height}`);
      }
      try {
        linkSync(tmp, final); // fails instead of overwriting if something appeared at the target meanwhile
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "EEXIST") throw new ReelForgeError("VALIDATION_ERROR", "a file appeared at the export path during rendering; not overwriting it");
        throw e;
      }
      unlinkSync(tmp);
      tmp = null;
      this.#jobs.complete(jobId, { path: final, sizeBytes: statSync(final).size, ...probe });
      if (job.kind === "preview") prunePreviews(join(this.#cacheDir, "previews", job.projectId), final);
    } catch (e) {
      if (!this.#jobs.isCancelled(jobId)) {
        const code = e instanceof ReelForgeError ? e.code : "RENDER_FAILED";
        this.#jobs.fail(jobId, code, e instanceof Error ? e.message : String(e));
      }
    } finally {
      if (tmp) rmSync(tmp, { force: true });
    }
  }

  #ffmpeg(args: string[], state: Running, onProgress: (outUs: number, end: boolean) => boolean): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(ffmpegBin(), args, { stdio: ["ignore", "pipe", "pipe"] });
      state.child = child;
      let stderr = "";
      let buf = "";
      let outUs = 0;
      child.stdout!.on("data", (chunk: Buffer) => {
        buf += chunk.toString("utf8");
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (line.startsWith("out_time_us=")) outUs = Number(line.slice(12)) || outUs;
          // One progress block ends with "progress=continue|end"; report once per block.
          if (line.startsWith("progress=")) {
            const keepGoing = onProgress(outUs, line === "progress=end");
            if (!keepGoing) {
              state.cancelled = true;
              child.kill("SIGKILL");
            }
          }
        }
      });
      child.stderr!.on("data", (c: Buffer) => {
        if (stderr.length < 64_000) stderr += c.toString("utf8");
      });
      child.on("error", (e: NodeJS.ErrnoException) =>
        reject(e.code === "ENOENT" ? new ReelForgeError("UNAVAILABLE", "ffmpeg not found. Install FFmpeg (macOS: `brew install ffmpeg`).") : e),
      );
      child.on("close", (code) => {
        if (state.cancelled) return resolve();
        if (code === 0) return resolve();
        const reason = stderr.split("\n").map((l) => l.trim()).filter(Boolean).slice(-3).join(" | ") || `exit ${code}`;
        reject(new ReelForgeError("INTERNAL", `ffmpeg failed: ${reason}`));
      });
    });
  }
}

export async function verifyOutput(path: string) {
  const { stdout } = await run(ffprobeBin(), [
    "-v", "error", "-print_format", "json", "-show_streams", "-show_format", "-protocol_whitelist", "file", "-f", "mov", `file:${path}`,
  ]);
  const data = JSON.parse(stdout) as { streams: { codec_type: string; codec_name: string; width?: number; height?: number; nb_frames?: string }[] };
  const v = data.streams.find((s) => s.codec_type === "video");
  const a = data.streams.find((s) => s.codec_type === "audio");
  if (!v) throw new ReelForgeError("INTERNAL", "render produced no video stream");
  return { frames: Number(v.nb_frames ?? 0), width: v.width ?? 0, height: v.height ?? 0, videoCodec: v.codec_name, audioCodec: a?.codec_name ?? null };
}

/** Keep the newest two previews per project; they are disposable cache. */
function prunePreviews(dir: string, keep: string) {
  try {
    const files = readdirSync(dir)
      .filter((f) => f.endsWith(".mp4") && !f.startsWith("."))
      .map((f) => join(dir, f))
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
    for (const f of files.slice(2)) if (f !== keep) rmSync(f, { force: true });
  } catch {
    /* cache housekeeping is best-effort */
  }
}
