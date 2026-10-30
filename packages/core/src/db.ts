import { DatabaseSync } from "node:sqlite";
import { MIGRATIONS, type Migration } from "./migrations.ts";
import { resolveDbPath } from "./paths.ts";

export type Database = DatabaseSync;

/**
 * Open (and migrate) the workspace database. The desktop sidecar and the CLI
 * open the same file concurrently, so WAL + a busy timeout are required.
 */
export function openDatabase(path: string = resolveDbPath()): Database {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
  `);
  migrate(db);
  return db;
}

export function migrate(db: Database, migrations: readonly Migration[] = MIGRATIONS): number[] {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at TEXT NOT NULL
    ) STRICT;
  `);
  const applied: number[] = [];
  for (const m of migrations) {
    transaction(db, () => {
      // Re-check inside the write lock: another process may have just migrated.
      const done = db.prepare("SELECT 1 FROM schema_migrations WHERE version = ?").get(m.version);
      if (done) return;
      db.exec(m.sql);
      db.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)").run(
        m.version,
        m.name,
        new Date().toISOString(),
      );
      applied.push(m.version);
    });
  }
  return applied;
}

/** Run fn inside BEGIN IMMEDIATE so the revision check and the write share one lock. */
export function transaction<T>(db: Database, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
