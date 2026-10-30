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
  type Actor,
  type CreateProjectInput,
  type EditOperation,
  type Project,
  type RenameProjectInput,
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

  history(id: string): EditOperation[] {
    const pid = this.get(id).id;
    const rows = this.#db
      .prepare("SELECT * FROM edit_operations WHERE project_id = ? ORDER BY revision")
      .all(pid) as unknown as OperationRow[];
    return rows.map(toOperation);
  }
}
