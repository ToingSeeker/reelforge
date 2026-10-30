import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

// Append-only. Each migration runs exactly once, recorded in schema_migrations.
// Never edit a migration that has shipped; add a new one.

export interface Migration {
  version: number;
  name: string;
  sql: string;
  /** Data step that needs application code (e.g. generating UUIDs). Runs after sql, same transaction. */
  up?: (db: DatabaseSync) => void;
}

/** Tracks every new project starts with, top (composited last) to bottom. */
export const DEFAULT_TRACKS = [
  { kind: "overlay", name: "Overlays" },
  { kind: "video", name: "Video" },
  { kind: "audio", name: "Music" },
  { kind: "audio", name: "Voice" },
  { kind: "caption", name: "Captions" },
] as const;

export function insertDefaultTracks(db: DatabaseSync, projectId: string): void {
  const stmt = db.prepare("INSERT INTO tracks (id, project_id, kind, name, position) VALUES (?, ?, ?, ?, ?)");
  DEFAULT_TRACKS.forEach((t, i) => stmt.run(randomUUID(), projectId, t.kind, t.name, i));
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
  {
    version: 2,
    name: "assets_tracks_clips_and_undo",
    sql: `
      CREATE TABLE assets (
        id          TEXT PRIMARY KEY,
        project_id  TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
        kind        TEXT NOT NULL CHECK (kind IN ('video', 'audio', 'image')),
        source_path TEXT NOT NULL,
        filename    TEXT NOT NULL,
        size_bytes  INTEGER NOT NULL,
        mtime_ms    INTEGER NOT NULL,
        duration_us INTEGER,
        width       INTEGER,
        height      INTEGER,
        fps_num     INTEGER,
        fps_den     INTEGER,
        vfr         INTEGER NOT NULL DEFAULT 0,
        has_video   INTEGER NOT NULL,
        has_audio   INTEGER NOT NULL,
        video_codec TEXT,
        audio_codec TEXT,
        sample_rate INTEGER,
        channels    INTEGER,
        rotation    INTEGER NOT NULL DEFAULT 0,
        created_at  TEXT NOT NULL,
        UNIQUE (project_id, source_path)
      ) STRICT;

      CREATE TABLE tracks (
        id         TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
        kind       TEXT NOT NULL CHECK (kind IN ('video', 'overlay', 'audio', 'caption')),
        name       TEXT NOT NULL,
        position   INTEGER NOT NULL,
        muted      INTEGER NOT NULL DEFAULT 0,
        locked     INTEGER NOT NULL DEFAULT 0,
        hidden     INTEGER NOT NULL DEFAULT 0
      ) STRICT;

      CREATE INDEX tracks_project ON tracks (project_id, position);

      -- Times are integer frames in the project timebase.
      CREATE TABLE clips (
        id         TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
        track_id   TEXT NOT NULL REFERENCES tracks (id) ON DELETE CASCADE,
        asset_id   TEXT NOT NULL REFERENCES assets (id) ON DELETE RESTRICT,
        start      INTEGER NOT NULL CHECK (start >= 0),
        duration   INTEGER NOT NULL CHECK (duration > 0),
        source_in  INTEGER NOT NULL CHECK (source_in >= 0)
      ) STRICT;

      CREATE INDEX clips_project ON clips (project_id);
      CREATE INDEX clips_track ON clips (track_id, start);

      -- Undo/redo: each undoable operation stores the rows it changed (before/after).
      ALTER TABLE edit_operations ADD COLUMN undoable INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE edit_operations ADD COLUMN state TEXT NOT NULL DEFAULT 'applied';
      ALTER TABLE edit_operations ADD COLUMN diff TEXT;
      ALTER TABLE edit_operations ADD COLUMN undone_at INTEGER;
    `,
    up: (db) => {
      const projects = db.prepare("SELECT id FROM projects").all() as { id: string }[];
      for (const p of projects) insertDefaultTracks(db, p.id);
    },
  },
];

