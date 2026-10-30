import { randomUUID } from "node:crypto";
import type { Database } from "./db.ts";
import { ReelForgeError } from "./errors.ts";
import type { Actor } from "./schema.ts";

export interface CommitInput {
  projectId: string;
  /** Omit only for additive operations that cannot conflict (e.g. importing media). */
  baseRevision?: number;
  kind: string;
  payload: object;
  actor: Actor;
  now: string;
  undoable?: boolean;
  diff?: object;
}

/** Throws NOT_FOUND / REVISION_CONFLICT; returns the current revision. Call inside a transaction. */
export function assertRevision(db: Database, projectId: string, baseRevision: number | undefined): number {
  const row = db.prepare("SELECT revision FROM projects WHERE id = ?").get(projectId) as { revision: number } | undefined;
  if (!row) throw new ReelForgeError("NOT_FOUND", `project ${projectId} not found`, { projectId });
  if (baseRevision !== undefined && row.revision !== baseRevision) {
    throw new ReelForgeError(
      "REVISION_CONFLICT",
      `project changed since revision ${baseRevision} (now ${row.revision}); reload and retry`,
      { projectId, baseRevision, currentRevision: row.revision },
    );
  }
  return row.revision;
}

/**
 * Bump the project revision and append the audit/undo record. Must run inside
 * the same transaction as the state change it describes.
 */
export function commitRevision(db: Database, c: CommitInput): { revision: number; operationId: string } {
  const revision = assertRevision(db, c.projectId, c.baseRevision) + 1;
  const operationId = randomUUID();
  db.prepare("UPDATE projects SET revision = ?, updated_at = ? WHERE id = ?").run(revision, c.now, c.projectId);
  if (c.undoable) {
    // A new edit forks history: whatever was undone can no longer be redone.
    db.prepare("UPDATE edit_operations SET state = 'discarded' WHERE project_id = ? AND state = 'undone'").run(c.projectId);
  }
  db.prepare(
    `INSERT INTO edit_operations (id, project_id, revision, kind, payload, actor, created_at, undoable, state, diff)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'applied', ?)`,
  ).run(
    operationId,
    c.projectId,
    revision,
    c.kind,
    JSON.stringify(c.payload),
    c.actor,
    c.now,
    c.undoable ? 1 : 0,
    c.diff ? JSON.stringify(c.diff) : null,
  );
  return { revision, operationId };
}
