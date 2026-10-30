import type { Database } from "./db.ts";
import { transaction } from "./db.ts";
import { ReelForgeError } from "./errors.ts";
import { toAsset } from "./assets.ts";
import { assertRevision, commitRevision } from "./revisions.ts";
import { applyOperations, clipEnd, diffStates, isEmptyDiff, type EditState, type TimelineDiff } from "./timeline-ops.ts";
import {
  ApplyOperationsInputSchema,
  HistoryInputSchema,
  ProjectIdSchema,
  type Actor,
  type ApplyOperationsInput,
  type Asset,
  type Clip,
  type HistoryInput,
  type Timeline,
  type Track,
} from "./schema.ts";
import { ProjectStore } from "./projects.ts";
import { parse } from "./validate.ts";

interface TrackRow {
  id: string;
  kind: Track["kind"];
  name: string;
  position: number;
  muted: number;
  locked: number;
  hidden: number;
}

interface ClipRow {
  id: string;
  track_id: string;
  asset_id: string;
  start: number;
  duration: number;
  source_in: number;
}

const toTrack = (r: TrackRow): Track => ({
  id: r.id,
  kind: r.kind,
  name: r.name,
  position: r.position,
  muted: r.muted === 1,
  locked: r.locked === 1,
  hidden: r.hidden === 1,
});

const toClip = (r: ClipRow): Clip => ({
  id: r.id,
  trackId: r.track_id,
  assetId: r.asset_id,
  start: r.start,
  duration: r.duration,
  sourceIn: r.source_in,
});

/**
 * Timeline reads and edits. An edit batch is loaded into memory, run through
 * the pure reducer, and only the resulting row diff is written — together with
 * the revision bump, in one transaction. The diff doubles as the undo record.
 */
export class TimelineStore {
  readonly #db: Database;
  readonly #projects: ProjectStore;
  readonly #now: () => string;

  constructor(db: Database, opts: { now?: () => string } = {}) {
    this.#db = db;
    this.#now = opts.now ?? (() => new Date().toISOString());
    this.#projects = new ProjectStore(db, { now: this.#now });
  }

  #load(projectId: string, checkFiles: boolean) {
    const project = this.#projects.get(projectId);
    const tracks = (
      this.#db.prepare("SELECT * FROM tracks WHERE project_id = ? ORDER BY position").all(project.id) as unknown as TrackRow[]
    ).map(toTrack);
    const clips = (
      this.#db.prepare("SELECT * FROM clips WHERE project_id = ? ORDER BY start, id").all(project.id) as unknown as ClipRow[]
    ).map(toClip);
    const assets = (
      this.#db.prepare("SELECT * FROM assets WHERE project_id = ? ORDER BY created_at, filename").all(project.id) as never[]
    ).map((r) => toAsset(r, project.settings.fps, checkFiles));
    const state: EditState = {
      fps: project.settings.fps,
      tracks: new Map(tracks.map((t) => [t.id, t])),
      clips: new Map(clips.map((c) => [c.id, c])),
      assets: new Map(assets.map((a) => [a.id, a])),
    };
    return { project, tracks, clips, assets, state };
  }

  get(projectId: string): Timeline {
    const pid = parse(ProjectIdSchema, projectId);
    const { project, tracks, clips, assets } = this.#load(pid, true);
    return this.#view(project.id, project, tracks, clips, assets);
  }

  #view(projectId: string, project: Timeline["project"], tracks: Track[], clips: Clip[], assets: Asset[]): Timeline {
    const flag = (sql: string) => this.#db.prepare(sql).get(projectId) !== undefined;
    return {
      project,
      tracks,
      clips,
      assets,
      durationFrames: clips.reduce((m, c) => Math.max(m, clipEnd(c)), 0),
      history: {
        canUndo: flag("SELECT 1 FROM edit_operations WHERE project_id = ? AND undoable = 1 AND state = 'applied' LIMIT 1"),
        canRedo: flag("SELECT 1 FROM edit_operations WHERE project_id = ? AND state = 'undone' LIMIT 1"),
      },
    };
  }

  apply(projectId: string, input: ApplyOperationsInput, actor: Actor): Timeline {
    const pid = parse(ProjectIdSchema, projectId);
    const { baseRevision, operations } = parse(ApplyOperationsInputSchema, input);
    transaction(this.#db, () => {
      const { state } = this.#load(pid, false);
      assertRevision(this.#db, pid, baseRevision);
      const next = applyOperations(state, operations);
      const diff = diffStates(state, next);
      if (isEmptyDiff(diff)) return; // nothing changed: no revision, no undo step
      this.#write(pid, diff, "after");
      commitRevision(this.#db, {
        projectId: pid,
        baseRevision,
        kind: "timeline.edit",
        payload: { operations },
        actor,
        now: this.#now(),
        undoable: true,
        diff,
      });
    });
    return this.get(pid);
  }

  undo(projectId: string, input: HistoryInput, actor: Actor): Timeline {
    return this.#travel(projectId, input, actor, "undo");
  }

  redo(projectId: string, input: HistoryInput, actor: Actor): Timeline {
    return this.#travel(projectId, input, actor, "redo");
  }

  #travel(projectId: string, input: HistoryInput, actor: Actor, dir: "undo" | "redo"): Timeline {
    const pid = parse(ProjectIdSchema, projectId);
    const { baseRevision } = parse(HistoryInputSchema, input);
    transaction(this.#db, () => {
      assertRevision(this.#db, pid, baseRevision);
      const target = this.#db
        .prepare(
          dir === "undo"
            ? "SELECT id, revision, diff FROM edit_operations WHERE project_id = ? AND undoable = 1 AND state = 'applied' ORDER BY revision DESC LIMIT 1"
            : "SELECT id, revision, diff FROM edit_operations WHERE project_id = ? AND state = 'undone' ORDER BY undone_at DESC LIMIT 1",
        )
        .get(pid) as { id: string; revision: number; diff: string } | undefined;
      if (!target) throw new ReelForgeError("VALIDATION_ERROR", `nothing to ${dir}`, { projectId: pid });

      this.#write(pid, JSON.parse(target.diff) as TimelineDiff, dir === "undo" ? "before" : "after");
      const { revision } = commitRevision(this.#db, {
        projectId: pid,
        baseRevision,
        kind: `history.${dir}`,
        payload: { operationId: target.id, revision: target.revision },
        actor,
        now: this.#now(),
      });
      this.#db
        .prepare("UPDATE edit_operations SET state = ?, undone_at = ? WHERE id = ?")
        .run(dir === "undo" ? "undone" : "applied", dir === "undo" ? revision : null, target.id);
    });
    return this.get(pid);
  }

  /** Write one side of a diff. Tracks first and clip deletes before upserts keep FKs satisfied. */
  #write(projectId: string, diff: TimelineDiff, side: "before" | "after") {
    const upsertTrack = this.#db.prepare(
      `INSERT INTO tracks (id, project_id, kind, name, position, muted, locked, hidden) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET kind = excluded.kind, name = excluded.name, position = excluded.position,
         muted = excluded.muted, locked = excluded.locked, hidden = excluded.hidden`,
    );
    const upsertClip = this.#db.prepare(
      `INSERT INTO clips (id, project_id, track_id, asset_id, start, duration, source_in) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET track_id = excluded.track_id, asset_id = excluded.asset_id,
         start = excluded.start, duration = excluded.duration, source_in = excluded.source_in`,
    );
    for (const ch of diff.tracks) {
      const t = ch[side];
      if (t) upsertTrack.run(t.id, projectId, t.kind, t.name, t.position, +t.muted, +t.locked, +t.hidden);
    }
    for (const ch of diff.clips) {
      if (!ch[side]) this.#db.prepare("DELETE FROM clips WHERE id = ? AND project_id = ?").run(ch.id, projectId);
    }
    for (const ch of diff.clips) {
      const c = ch[side];
      if (c) upsertClip.run(c.id, projectId, c.trackId, c.assetId, c.start, c.duration, c.sourceIn);
    }
    for (const ch of diff.tracks) {
      if (!ch[side]) this.#db.prepare("DELETE FROM tracks WHERE id = ? AND project_id = ?").run(ch.id, projectId);
    }
  }
}
