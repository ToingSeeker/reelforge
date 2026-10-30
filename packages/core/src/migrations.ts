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
  {
    version: 3,
    name: "render_jobs_artifacts_proxies",
    sql: `
      -- Jobs are not edits: they never bump the project revision. Each job keeps
      -- the plan it was created from, so a render is reproducible even if the
      -- timeline changes while it runs.
      CREATE TABLE render_jobs (
        id            TEXT PRIMARY KEY,
        project_id    TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
        kind          TEXT NOT NULL CHECK (kind IN ('export', 'preview')),
        state         TEXT NOT NULL CHECK (state IN ('queued', 'analyzing', 'rendering', 'muxing', 'completed', 'failed', 'cancelled')),
        progress      REAL NOT NULL DEFAULT 0,
        revision      INTEGER NOT NULL,
        plan          TEXT NOT NULL CHECK (json_valid(plan)),
        settings      TEXT NOT NULL CHECK (json_valid(settings)),
        output_path   TEXT,
        error_code    TEXT,
        error_message TEXT,
        runner_pid    INTEGER,
        retry_of      TEXT REFERENCES render_jobs (id) ON DELETE SET NULL,
        created_at    TEXT NOT NULL,
        started_at    TEXT,
        finished_at   TEXT
      ) STRICT;

      CREATE INDEX render_jobs_project ON render_jobs (project_id, created_at DESC);
      CREATE INDEX render_jobs_state ON render_jobs (state);

      CREATE TABLE artifacts (
        id          TEXT PRIMARY KEY,
        project_id  TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
        job_id      TEXT NOT NULL REFERENCES render_jobs (id) ON DELETE CASCADE,
        path        TEXT NOT NULL,
        size_bytes  INTEGER NOT NULL,
        frames      INTEGER NOT NULL,
        width       INTEGER NOT NULL,
        height      INTEGER NOT NULL,
        video_codec TEXT NOT NULL,
        audio_codec TEXT,
        created_at  TEXT NOT NULL
      ) STRICT;

      -- Derived, disposable: the file lives in the cache and is rebuilt if missing.
      CREATE TABLE proxies (
        asset_id    TEXT PRIMARY KEY REFERENCES assets (id) ON DELETE CASCADE,
        path        TEXT NOT NULL,
        width       INTEGER NOT NULL,
        height      INTEGER NOT NULL,
        source_size INTEGER NOT NULL,
        created_at  TEXT NOT NULL
      ) STRICT;
    `,
  },
  {
    version: 4,
    name: "clip_props",
    sql: `
      -- Sparse per-clip look/sound settings (transform, fades, transition, gain), validated by ClipPropsSchema.
      ALTER TABLE clips ADD COLUMN props TEXT NOT NULL DEFAULT '{}';
    `,
  },
  {
    version: 5,
    name: "analyses_and_captions",
    sql: `
      -- Per-asset media analysis. One row per (asset, kind); re-running replaces it.
      CREATE TABLE analyses (
        id          TEXT PRIMARY KEY,
        asset_id    TEXT NOT NULL REFERENCES assets (id) ON DELETE CASCADE,
        kind        TEXT NOT NULL CHECK (kind IN ('scenes', 'beats', 'transcript')),
        state       TEXT NOT NULL CHECK (state IN ('queued', 'running', 'completed', 'failed')),
        progress    REAL NOT NULL DEFAULT 0,
        engine      TEXT,
        params      TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(params)),
        result      TEXT CHECK (result IS NULL OR json_valid(result)),
        error       TEXT,
        source_size INTEGER NOT NULL,
        runner_pid  INTEGER,
        created_at  TEXT NOT NULL,
        finished_at TEXT,
        UNIQUE (asset_id, kind)
      ) STRICT;

      -- Captions live on caption tracks. Word timings are relative to the caption start; the
      -- look is the track's caption style, kept apart from the text (PRD §10).
      CREATE TABLE captions (
        id         TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
        track_id   TEXT NOT NULL REFERENCES tracks (id) ON DELETE CASCADE,
        start      INTEGER NOT NULL CHECK (start >= 0),
        duration   INTEGER NOT NULL CHECK (duration > 0),
        text       TEXT NOT NULL,
        words      TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(words))
      ) STRICT;

      CREATE INDEX captions_track ON captions (track_id, start);

      ALTER TABLE tracks ADD COLUMN props TEXT NOT NULL DEFAULT '{}';
    `,
  },
  {
    version: 6,
    name: "ai_proposals_and_consent",
    sql: `
      -- AI Director proposals (PRD §9). The model only ever produces operations; applying one needs
      -- an explicit approval recorded here (who, when, through what), never the model's say-so.
      CREATE TABLE ai_proposals (
        id               TEXT PRIMARY KEY,
        project_id       TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
        base_revision    INTEGER NOT NULL,
        instruction      TEXT NOT NULL,
        selection        TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(selection)),
        provider         TEXT NOT NULL,
        model            TEXT NOT NULL,
        status           TEXT NOT NULL CHECK (status IN ('pending', 'applied', 'rejected', 'stale')),
        summary          TEXT NOT NULL,
        operations       TEXT NOT NULL CHECK (json_valid(operations)),
        explanations     TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(explanations)),
        warnings         TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(warnings)),
        changes          TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(changes)),
        duration_before  INTEGER NOT NULL,
        duration_after   INTEGER NOT NULL,
        usage            TEXT,
        approved_by      TEXT,
        approval_channel TEXT,
        decided_at       TEXT,
        applied_revision INTEGER,
        created_at       TEXT NOT NULL
      ) STRICT;

      CREATE INDEX ai_proposals_project ON ai_proposals (project_id, created_at DESC);

      -- Per-project consent to send its context (names, timeline, transcripts; never media) to an
      -- external provider. NULL = not granted.
      ALTER TABLE projects ADD COLUMN ai_consent TEXT;
    `,
  },
  {
    version: 7,
    name: "workflow_runs",
    sql: `
      -- Automation history (PRD WorkflowRun): what ran, step by step, and why it stopped.
      CREATE TABLE workflow_runs (
        id          TEXT PRIMARY KEY,
        project_id  TEXT REFERENCES projects (id) ON DELETE SET NULL,
        name        TEXT NOT NULL,
        source      TEXT,
        spec        TEXT NOT NULL CHECK (json_valid(spec)),
        status      TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'waiting_approval')),
        steps       TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(steps)),
        error       TEXT,
        actor       TEXT NOT NULL,
        runner_pid  INTEGER,
        started_at  TEXT NOT NULL,
        finished_at TEXT
      ) STRICT;

      CREATE INDEX workflow_runs_started ON workflow_runs (started_at DESC);
    `,
  },
];

