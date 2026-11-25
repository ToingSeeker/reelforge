import { randomUUID } from "node:crypto";
import { transaction, type Database } from "./db.ts";
import { ReelForgeError } from "./errors.ts";
import { insertDefaultTracks } from "./migrations.ts";
import { commitRevision } from "./revisions.ts";
import { parse } from "./validate.ts";
import {
  ActorSchema,
  CreateProjectInputSchema,
  DEFAULT_PROJECT_SETTINGS,
  PROJECT_SCHEMA_VERSION,
  ProjectIdSchema,
  ProjectSettingsSchema,
  RenameProjectInputSchema,
  ResizeProjectInputSchema,
  type Actor,
  type CreateProjectInput,
  type EditOperation,
  type Project,
  type RenameProjectInput,
  type ResizeProjectInput,
} from "./schema.ts";

interface ProjectRow {
  id: string;
  name: string;
  schema_version: number;
  revision: number;
  width: number;
  height: number;
  fps_num: number;
  fps_den: number;
  created_at: string;
  updated_at: string;
}

interface OperationRow {
  id: string;
  project_id: string;
  revision: number;
  kind: string;
  payload: string;
  actor: string;
  created_at: string;
}

function toProject(r: ProjectRow): Project {
  return {
    id: r.id,
    name: r.name,
    schemaVersion: r.schema_version,
    revision: r.revision,
    settings: { width: r.width, height: r.height, fps: { num: r.fps_num, den: r.fps_den } },
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function toOperation(r: OperationRow): EditOperation {
  return {
    id: r.id,
    projectId: r.project_id,
    revision: r.revision,
    kind: r.kind,
    payload: JSON.parse(r.payload) as Record<string, unknown>,
    actor: ActorSchema.parse(r.actor),
    createdAt: r.created_at,
  };
}


/**
 * The single place project state changes. Every mutation bumps the revision
 * and appends an edit_operations row inside one transaction (FR-004, FR-015);
 * a stale baseRevision is rejected, never merged over (FR-016).
 */
export class ProjectStore {
  readonly #db: Database;
  readonly #now: () => string;

  constructor(db: Database, opts: { now?: () => string } = {}) {
    this.#db = db;
    this.#now = opts.now ?? (() => new Date().toISOString());
  }

  list(): Project[] {
    const rows = this.#db
      .prepare("SELECT * FROM projects ORDER BY updated_at DESC, id")
      .all() as unknown as ProjectRow[];
    return rows.map(toProject);
  }

  get(id: string): Project {
    const pid = parse(ProjectIdSchema, id);
    const row = this.#db.prepare("SELECT * FROM projects WHERE id = ?").get(pid) as unknown as
      | ProjectRow
      | undefined;
    if (!row) throw new ReelForgeError("NOT_FOUND", `project ${pid} not found`, { projectId: pid });
    return toProject(row);
  }

  create(input: CreateProjectInput, actor: Actor): Project {
    const { name, settings } = parse(CreateProjectInputSchema, input);
    const full = parse(ProjectSettingsSchema, { ...DEFAULT_PROJECT_SETTINGS, ...settings });
    const id = randomUUID();
    const now = this.#now();
    return transaction(this.#db, () => {
      this.#db
        .prepare(
          `INSERT INTO projects
             (id, name, schema_version, revision, width, height, fps_num, fps_den, created_at, updated_at)
           VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, name, PROJECT_SCHEMA_VERSION, full.width, full.height, full.fps.num, full.fps.den, now, now);
      insertDefaultTracks(this.#db, id);
      this.#db
        .prepare(
          `INSERT INTO edit_operations (id, project_id, revision, kind, payload, actor, created_at)
           VALUES (?, ?, 1, 'project.create', ?, ?, ?)`,
        )
        .run(randomUUID(), id, JSON.stringify({ name, settings: full }), actor, now);
      return this.get(id);
    });
  }

  rename(id: string, input: RenameProjectInput, actor: Actor): Project {
    const pid = parse(ProjectIdSchema, id);
    const { name, baseRevision } = parse(RenameProjectInputSchema, input);
    return transaction(this.#db, () => {
      const current = this.get(pid);
      if (current.name === name) return current; // nothing changes: no new revision, no history entry
      commitRevision(this.#db, {
        projectId: pid,
        baseRevision,
        kind: "project.rename",
        payload: { from: current.name, to: name },
        actor,
        now: this.#now(),
      });
      this.#db.prepare("UPDATE projects SET name = ? WHERE id = ?").run(name, pid);
      return this.get(pid);
    });
  }

  resize(id: string, input: ResizeProjectInput, actor: Actor): Project {
    const pid = parse(ProjectIdSchema, id);
    const { width, height, baseRevision } = parse(ResizeProjectInputSchema, input);
    return transaction(this.#db, () => {
      const current = this.get(pid);
      if (current.settings.width === width && current.settings.height === height) return current;
      commitRevision(this.#db, {
        projectId: pid,
        baseRevision,
        kind: "project.resize",
        payload: { from: { width: current.settings.width, height: current.settings.height }, to: { width, height } },
        actor,
        now: this.#now(),
      });
      this.#db.prepare("UPDATE projects SET width = ?, height = ? WHERE id = ?").run(width, height, pid);
      return this.get(pid);
    });
  }

  /**
   * Remove a project and everything recorded about it (timeline, assets, captions, proposals, jobs,
   * history). Only rows: the media files, exports and generated files stay on disk. Refused with BUSY while
   * a render or an analysis of its media is queued or running, so no runner writes into a project that's gone.
   */
  delete(id: string): Project {
    const pid = parse(ProjectIdSchema, id);
    return transaction(this.#db, () => {
      const project = this.get(pid);
      const render = this.#db
        .prepare("SELECT 1 FROM render_jobs WHERE project_id = ? AND state IN ('queued', 'analyzing', 'rendering', 'muxing') LIMIT 1")
        .get(pid);
      if (render) throw new ReelForgeError("BUSY", "A render of this project is still running. Cancel it or wait for it to finish, then delete.", { projectId: pid });
      const analysis = this.#db
        .prepare(
          `SELECT 1 FROM analyses a JOIN assets s ON s.id = a.asset_id
            WHERE s.project_id = ? AND a.state IN ('queued', 'running') LIMIT 1`,
        )
        .get(pid);
      if (analysis) throw new ReelForgeError("BUSY", "This project's media is still being analysed (transcription, scenes or beats). Delete it once that's done.", { projectId: pid });
      // Every table hangs off projects with ON DELETE CASCADE (workflow_runs keep their record: SET NULL).
      this.#db.prepare("DELETE FROM projects WHERE id = ?").run(pid);
      return project;
    });
  }

  history(id: string): EditOperation[] {
    const pid = this.get(id).id;
    const rows = this.#db
      .prepare("SELECT * FROM edit_operations WHERE project_id = ? ORDER BY revision")
      .all(pid) as unknown as OperationRow[];
    return rows.map(toOperation);
  }
}
