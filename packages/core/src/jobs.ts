import { randomUUID } from "node:crypto";
import type { Database } from "./db.ts";
import { transaction } from "./db.ts";
import { ReelForgeError } from "./errors.ts";
import { buildRenderPlan, type RenderPlan } from "./render-plan.ts";
import { ProjectIdSchema, type Artifact, type JobKind, type JobState, type RenderJob, type RenderSettings } from "./schema.ts";
import { TimelineStore } from "./timeline.ts";
import { parse } from "./validate.ts";

interface JobRow {
  id: string;
  project_id: string;
  kind: JobKind;
  state: JobState;
  progress: number;
  revision: number;
  plan: string;
  settings: string;
  output_path: string | null;
  error_code: string | null;
  error_message: string | null;
  runner_pid: number | null;
  retry_of: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

interface ArtifactRow {
  id: string;
  project_id: string;
  job_id: string;
  path: string;
  size_bytes: number;
  frames: number;
  width: number;
  height: number;
  video_codec: string;
  audio_codec: string | null;
  created_at: string;
}

const toJob = (r: JobRow): RenderJob => ({
  id: r.id,
  projectId: r.project_id,
  kind: r.kind,
  state: r.state,
  progress: r.progress,
  revision: r.revision,
  settings: JSON.parse(r.settings) as RenderSettings,
  outputPath: r.output_path,
  error: r.error_code ? { code: r.error_code, message: r.error_message ?? "" } : null,
  retryOf: r.retry_of,
  createdAt: r.created_at,
  startedAt: r.started_at,
  finishedAt: r.finished_at,
});

const ACTIVE = "('queued', 'analyzing', 'rendering', 'muxing')";

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Render job records. The state lives in the database so any process (desktop
 * engine, CLI, MCP) can watch or cancel a job another process is running.
 */
export class JobStore {
  readonly #db: Database;
  readonly #now: () => string;

  constructor(db: Database, opts: { now?: () => string } = {}) {
    this.#db = db;
    this.#now = opts.now ?? (() => new Date().toISOString());
  }

  /** Snapshot the current timeline into a plan and queue a job for it. */
  create(
    projectId: string,
    kind: JobKind,
    settings: RenderSettings | ((plan: RenderPlan) => RenderSettings),
    outputPath: string | null,
    retryOf: string | null = null,
  ): RenderJob {
    const pid = parse(ProjectIdSchema, projectId);
    const timeline = new TimelineStore(this.#db).get(pid);
    const plan = buildRenderPlan(timeline);
    if (kind === "export") {
      // A file that changed since import may no longer be the media the clips were cut from (shorter,
      // re-encoded): the preview still plays it, but an export would bake in whatever it now is.
      const changed = timeline.assets.filter((a) => a.status === "changed" && a.id in plan.sources);
      if (changed.length) {
        throw new ReelForgeError(
          "VALIDATION_ERROR",
          `media changed on disk since import: ${changed.map((a) => a.filename).join(", ")}; relink it (to the same or the updated file) before exporting, or re-import it if it is different media now`,
          { changed: changed.map((a) => a.id) },
        );
      }
    }
    // Settings may depend on the plan (output size); the job is only visible once complete.
    const resolved = typeof settings === "function" ? settings(plan) : settings;
    const id = randomUUID();
    this.#db
      .prepare(
        `INSERT INTO render_jobs (id, project_id, kind, state, revision, plan, settings, output_path, retry_of, created_at)
         VALUES (?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, pid, kind, plan.revision, JSON.stringify(plan), JSON.stringify(resolved), outputPath, retryOf, this.#now());
    return this.get(id);
  }

  get(jobId: string): RenderJob {
    const id = parse(ProjectIdSchema, jobId);
    const row = this.#db.prepare("SELECT * FROM render_jobs WHERE id = ?").get(id) as unknown as JobRow | undefined;
    if (!row) throw new ReelForgeError("NOT_FOUND", `job ${id} not found`, { jobId: id });
    return toJob(row);
  }

  plan(jobId: string): RenderPlan {
    const row = this.#db.prepare("SELECT plan FROM render_jobs WHERE id = ?").get(jobId) as { plan: string } | undefined;
    if (!row) throw new ReelForgeError("NOT_FOUND", `job ${jobId} not found`, { jobId });
    return JSON.parse(row.plan) as RenderPlan;
  }

  list(projectId: string, opts: { kind?: JobKind; limit?: number } = {}): RenderJob[] {
    const pid = parse(ProjectIdSchema, projectId);
    const params: (string | number)[] = [pid, ...(opts.kind ? [opts.kind] : []), opts.limit ?? 50];
    const rows = this.#db
      .prepare(`SELECT * FROM render_jobs WHERE project_id = ? ${opts.kind ? "AND kind = ?" : ""} ORDER BY created_at DESC, rowid DESC LIMIT ?`)
      .all(...params) as unknown as JobRow[];
    return rows.map(toJob);
  }

  /** Atomically take a queued job for this process. False if someone else got it or it was cancelled. */
  claim(jobId: string, pid: number = process.pid): boolean {
    const r = this.#db
      .prepare("UPDATE render_jobs SET state = 'analyzing', runner_pid = ?, started_at = ? WHERE id = ? AND state = 'queued'")
      .run(pid, this.#now(), jobId);
    return Number(r.changes) === 1;
  }

  /** Move a running job forward. Returns false when the job was cancelled meanwhile: the caller must stop. */
  advance(jobId: string, state: "analyzing" | "rendering" | "muxing", progress: number): boolean {
    const r = this.#db
      .prepare(`UPDATE render_jobs SET state = ?, progress = ? WHERE id = ? AND state IN ('analyzing', 'rendering', 'muxing')`)
      .run(state, Math.max(0, Math.min(1, progress)), jobId);
    return Number(r.changes) === 1;
  }

  isCancelled(jobId: string): boolean {
    const row = this.#db.prepare("SELECT state FROM render_jobs WHERE id = ?").get(jobId) as { state: JobState } | undefined;
    return !row || row.state === "cancelled";
  }

  complete(jobId: string, artifact: Omit<Artifact, "id" | "projectId" | "jobId" | "createdAt"> | null): RenderJob {
    transaction(this.#db, () => {
      const job = this.get(jobId);
      const now = this.#now();
      this.#db
        .prepare(`UPDATE render_jobs SET state = 'completed', progress = 1, finished_at = ?, output_path = COALESCE(?, output_path) WHERE id = ? AND state IN ('analyzing', 'rendering', 'muxing')`)
        .run(now, artifact?.path ?? null, jobId);
      if (artifact && job.kind === "export") {
        this.#db
          .prepare(
            `INSERT INTO artifacts (id, project_id, job_id, path, size_bytes, frames, width, height, video_codec, audio_codec, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(randomUUID(), job.projectId, jobId, artifact.path, artifact.sizeBytes, artifact.frames, artifact.width, artifact.height, artifact.videoCodec, artifact.audioCodec, now);
      }
    });
    return this.get(jobId);
  }

  fail(jobId: string, code: string, message: string): RenderJob {
    this.#db
      .prepare(`UPDATE render_jobs SET state = 'failed', error_code = ?, error_message = ?, finished_at = ? WHERE id = ? AND state IN ${ACTIVE}`)
      .run(code, message.slice(0, 2000), this.#now(), jobId);
    return this.get(jobId);
  }

  cancel(jobId: string): RenderJob {
    const job = this.get(jobId);
    if (!["queued", "analyzing", "rendering", "muxing"].includes(job.state)) {
      throw new ReelForgeError("VALIDATION_ERROR", `job is already ${job.state}`, { jobId, state: job.state });
    }
    this.#db
      .prepare(`UPDATE render_jobs SET state = 'cancelled', finished_at = ? WHERE id = ? AND state IN ${ACTIVE}`)
      .run(this.#now(), job.id);
    return this.get(job.id);
  }

  /** A failed or cancelled job runs again from the *current* timeline, as a new job. */
  retry(jobId: string): RenderJob {
    const job = this.get(jobId);
    if (job.state !== "failed" && job.state !== "cancelled") {
      throw new ReelForgeError("VALIDATION_ERROR", `only failed or cancelled jobs can be retried (this one is ${job.state})`, { jobId });
    }
    return transaction(this.#db, () => {
      // Each job is retried once: a second retry would queue another render to the same file.
      const again = this.#db.prepare("SELECT id, state FROM render_jobs WHERE retry_of = ? ORDER BY created_at DESC, rowid DESC LIMIT 1").get(job.id) as
        | { id: string; state: JobState }
        | undefined;
      if (again) {
        throw new ReelForgeError("VALIDATION_ERROR", `this job was already retried as job ${again.id} (${again.state}); retry that one instead`, {
          jobId,
          retryJobId: again.id,
        });
      }
      if (job.kind === "export" && job.outputPath) {
        const busy = this.#db.prepare(`SELECT id FROM render_jobs WHERE kind = 'export' AND output_path = ? AND state IN ${ACTIVE} LIMIT 1`).get(job.outputPath) as
          | { id: string }
          | undefined;
        if (busy) throw new ReelForgeError("BUSY", `another export to ${job.outputPath} is already queued or running (job ${busy.id})`, { jobId, busyJobId: busy.id });
      }
      return this.create(job.projectId, job.kind, job.settings, job.kind === "export" ? job.outputPath : null, job.id);
    });
  }

  /** Jobs whose runner process died mid-render are failed, not left spinning forever. */
  recoverInterrupted(): RenderJob[] {
    const rows = this.#db
      .prepare("SELECT * FROM render_jobs WHERE state IN ('analyzing', 'rendering', 'muxing')")
      .all() as unknown as JobRow[];
    const dead = rows.filter((r) => !r.runner_pid || !pidAlive(r.runner_pid));
    for (const r of dead) this.fail(r.id, "INTERRUPTED", "the render process stopped before finishing; retry the job");
    return dead.map((r) => this.get(r.id));
  }

  queued(): string[] {
    return (this.#db.prepare("SELECT id FROM render_jobs WHERE state = 'queued' ORDER BY created_at, rowid").all() as { id: string }[]).map((r) => r.id);
  }

  artifacts(projectId: string): Artifact[] {
    const pid = parse(ProjectIdSchema, projectId);
    const rows = this.#db.prepare("SELECT * FROM artifacts WHERE project_id = ? ORDER BY created_at DESC").all(pid) as unknown as ArtifactRow[];
    return rows.map((r) => ({
      id: r.id,
      projectId: r.project_id,
      jobId: r.job_id,
      path: r.path,
      sizeBytes: r.size_bytes,
      frames: r.frames,
      width: r.width,
      height: r.height,
      videoCodec: r.video_codec,
      audioCodec: r.audio_codec,
      createdAt: r.created_at,
    }));
  }
}
