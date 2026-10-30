// Append-only. Each migration runs exactly once, recorded in schema_migrations.
// Never edit a migration that has shipped; add a new one.

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: "projects_and_operations",
    sql: `
      CREATE TABLE projects (
        id             TEXT PRIMARY KEY,
        name           TEXT NOT NULL,
        schema_version INTEGER NOT NULL,
        revision       INTEGER NOT NULL CHECK (revision >= 0),
        width          INTEGER NOT NULL,
        height         INTEGER NOT NULL,
        fps_num        INTEGER NOT NULL CHECK (fps_num > 0),
        fps_den        INTEGER NOT NULL CHECK (fps_den > 0),
        created_at     TEXT NOT NULL,
        updated_at     TEXT NOT NULL
      ) STRICT;

      CREATE INDEX projects_updated_at ON projects (updated_at DESC);

      -- Audit trail and the future undo/redo source: one row per committed revision.
      CREATE TABLE edit_operations (
        id         TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
        revision   INTEGER NOT NULL CHECK (revision > 0),
        kind       TEXT NOT NULL,
        payload    TEXT NOT NULL CHECK (json_valid(payload)),
        actor      TEXT NOT NULL CHECK (actor IN ('desktop', 'cli', 'api', 'mcp')),
        created_at TEXT NOT NULL,
        UNIQUE (project_id, revision)
      ) STRICT;
    `,
  },
];
