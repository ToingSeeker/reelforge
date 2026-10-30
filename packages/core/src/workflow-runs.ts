import { randomUUID } from "node:crypto";
import type { Database } from "./db.ts";
import { ReelForgeError } from "./errors.ts";
import { ProjectIdSchema, type Actor, type WorkflowRun, type WorkflowStatus, type WorkflowStepResult } from "./schema.ts";
import { parse } from "./validate.ts";

interface RunRow {
  id: string;
  project_id: string | null;
  name: string;
  source: string | null;
  spec: string;
  status: WorkflowStatus;
  steps: string;
  error: string | null;
  actor: string;
  started_at: string;
  finished_at: string | null;
}

const toRun = (r: RunRow): WorkflowRun => ({
  id: r.id,
  projectId: r.project_id,
  name: r.name,
  source: r.source,
  status: r.status,
  steps: JSON.parse(r.steps) as WorkflowStepResult[],
  error: r.error,
  actor: r.actor,
  startedAt: r.started_at,
  finishedAt: r.finished_at,
});

/** Workflow run records, updated as each step progresses (visible to every client). */
export class WorkflowRunStore {
  readonly #db: Database;
  readonly #now: () => string;

  constructor(db: Database, opts: { now?: () => string } = {}) {
    this.#db = db;
    this.#now = opts.now ?? (() => new Date().toISOString());
  }

  start(name: string, spec: unknown, steps: WorkflowStepResult[], actor: Actor, source: string | null): WorkflowRun {
    const id = randomUUID();
    this.#db
      .prepare(`INSERT INTO workflow_runs (id, name, source, spec, status, steps, actor, runner_pid, started_at) VALUES (?, ?, ?, ?, 'running', ?, ?, ?, ?)`)
      .run(id, name, source, JSON.stringify(spec), JSON.stringify(steps), actor, process.pid, this.#now());
    return this.get(id);
  }

  get(id: string): WorkflowRun {
    const rid = parse(ProjectIdSchema, id);
    const row = this.#db.prepare("SELECT * FROM workflow_runs WHERE id = ?").get(rid) as unknown as RunRow | undefined;
    if (!row) throw new ReelForgeError("NOT_FOUND", `workflow run ${rid} not found`);
    return toRun(row);
  }

  list(opts: { projectId?: string; limit?: number } = {}): WorkflowRun[] {
    const rows = (
      opts.projectId
        ? this.#db.prepare("SELECT * FROM workflow_runs WHERE project_id = ? ORDER BY started_at DESC, rowid DESC LIMIT ?").all(parse(ProjectIdSchema, opts.projectId), opts.limit ?? 50)
        : this.#db.prepare("SELECT * FROM workflow_runs ORDER BY started_at DESC, rowid DESC LIMIT ?").all(opts.limit ?? 50)
    ) as unknown as RunRow[];
    return rows.map(toRun);
  }

  setProject(id: string, projectId: string): void {
    this.#db.prepare("UPDATE workflow_runs SET project_id = ? WHERE id = ?").run(projectId, id);
  }

  updateStep(id: string, step: WorkflowStepResult): void {
    const run = this.get(id);
    const steps = run.steps.map((s) => (s.index === step.index ? step : s));
    this.#db.prepare("UPDATE workflow_runs SET steps = ? WHERE id = ?").run(JSON.stringify(steps), id);
  }

  finish(id: string, status: Exclude<WorkflowStatus, "running">, error: string | null = null): WorkflowRun {
    this.#db.prepare("UPDATE workflow_runs SET status = ?, error = ?, finished_at = ? WHERE id = ?").run(status, error, this.#now(), id);
    return this.get(id);
  }
}
