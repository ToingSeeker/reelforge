import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { AnalysisStore, AssetStore, JobStore, MIGRATIONS, migrate, openDatabase, ProjectStore, ReelForgeError, TimelineStore } from "../src/index.ts";
import { fakeMedia, tempDir } from "./helpers.ts";

function setup(t: Parameters<typeof tempDir>[0]) {
  const dir = tempDir(t);
  const dbPath = join(dir, "reelforge.db");
  const db = openDatabase(dbPath);
  const projects = new ProjectStore(db);
  const assets = new AssetStore(db);
  const timeline = new TimelineStore(db);
  const project = projects.create({ name: "Cafe" }, "cli");
  const media = fakeMedia(dir, "C001_Espresso.mp4");
  const { asset } = assets.add(project.id, media.file, media.probe, "cli");
  const video = timeline.get(project.id).tracks.find((x) => x.kind === "video")!;
  return { dir, dbPath, db, projects, assets, timeline, project, asset, video };
}

function code(fn: () => unknown) {
  try {
    fn();
  } catch (e) {
    if (e instanceof ReelForgeError) return e.code;
    throw e;
  }
}

test("new projects get the five default tracks", (t) => {
  const { timeline, project } = setup(t);
  assert.deepEqual(timeline.get(project.id).tracks.map((x) => `${x.kind}:${x.name}`), [
    "overlay:Overlays", "video:Video", "audio:Music", "audio:Voice", "caption:Captions",
  ]);
});

test("import bumps the revision; duplicates return the same asset", (t) => {
  const { assets, project, asset, dir, projects } = setup(t);
  assert.equal(asset.durationFrames, 300);
  assert.equal(projects.get(project.id).revision, 2);
  const again = fakeMedia(dir, "C001_Espresso.mp4");
  const r = assets.add(project.id, again.file, again.probe, "cli");
  assert.equal(r.created, false);
  assert.equal(r.asset.id, asset.id);
});

test("edits persist across close/reopen (M1 exit criterion)", (t) => {
  const s = setup(t);
  let tl = s.timeline.apply(s.project.id, {
    baseRevision: 2,
    operations: [{ type: "clip.add", trackId: s.video.id, assetId: s.asset.id, start: 0, duration: 120 }],
  }, "desktop");
  const clipId = tl.clips[0]!.id;
  tl = s.timeline.apply(s.project.id, { baseRevision: tl.project.revision, operations: [{ type: "clip.split", clipId, frame: 45 }] }, "desktop");
  tl = s.timeline.apply(s.project.id, { baseRevision: tl.project.revision, operations: [{ type: "clip.trim", clipId, edge: "start", frame: 15 }] }, "cli");
  const snapshot = JSON.stringify(tl.clips);
  s.db.close();

  const reopened = new TimelineStore(openDatabase(s.dbPath)).get(s.project.id);
  assert.equal(JSON.stringify(reopened.clips), snapshot);
  assert.equal(reopened.project.revision, 5);
  assert.equal(reopened.durationFrames, 120);
  assert.equal(reopened.history.canUndo, true);
});

test("undo/redo walk history linearly and each step is a new revision", (t) => {
  const s = setup(t);
  const add = s.timeline.apply(s.project.id, { baseRevision: 2, operations: [{ type: "clip.add", trackId: s.video.id, assetId: s.asset.id, start: 0, duration: 90 }] }, "cli");
  const id = add.clips[0]!.id;
  const moved = s.timeline.apply(s.project.id, { baseRevision: 3, operations: [{ type: "clip.move", clipId: id, start: 60 }] }, "cli");
  assert.equal(moved.clips[0]!.start, 60);

  const u1 = s.timeline.undo(s.project.id, { baseRevision: 4 }, "cli");
  assert.equal(u1.clips[0]!.start, 0);
  assert.equal(u1.project.revision, 5);
  const u2 = s.timeline.undo(s.project.id, { baseRevision: 5 }, "cli");
  assert.equal(u2.clips.length, 0);
  assert.equal(u2.history.canUndo, false, "asset import and project creation are not undoable");
  assert.equal(code(() => s.timeline.undo(s.project.id, { baseRevision: 6 }, "cli")), "VALIDATION_ERROR");

  const r1 = s.timeline.redo(s.project.id, { baseRevision: 6 }, "cli");
  assert.deepEqual(r1.clips.map((c) => c.start), [0]);
  const r2 = s.timeline.redo(s.project.id, { baseRevision: 7 }, "cli");
  assert.deepEqual(r2.clips.map((c) => c.start), [60]);
  assert.equal(r2.history.canRedo, false);
});

test("a new edit after undo discards the redo stack", (t) => {
  const s = setup(t);
  s.timeline.apply(s.project.id, { baseRevision: 2, operations: [{ type: "clip.add", trackId: s.video.id, assetId: s.asset.id, start: 0, duration: 30 }] }, "cli");
  s.timeline.undo(s.project.id, { baseRevision: 3 }, "cli");
  const fork = s.timeline.apply(s.project.id, { baseRevision: 4, operations: [{ type: "clip.add", trackId: s.video.id, assetId: s.asset.id, start: 100, duration: 30 }] }, "cli");
  assert.equal(fork.history.canRedo, false);
  assert.equal(code(() => s.timeline.redo(s.project.id, { baseRevision: 5 }, "cli")), "VALIDATION_ERROR");
});

test("stale revisions and invalid batches leave the database untouched (FR-016, FR-018)", (t) => {
  const s = setup(t);
  const before = JSON.stringify(s.timeline.get(s.project.id));
  assert.equal(
    code(() => s.timeline.apply(s.project.id, { baseRevision: 1, operations: [{ type: "clip.add", trackId: s.video.id, assetId: s.asset.id, start: 0 }] }, "cli")),
    "REVISION_CONFLICT",
  );
  assert.equal(
    code(() => s.timeline.apply(s.project.id, {
      baseRevision: 2,
      operations: [
        { type: "clip.add", trackId: s.video.id, assetId: s.asset.id, start: 0, duration: 30 },
        { type: "clip.add", trackId: s.video.id, assetId: s.asset.id, start: 10, duration: 30 },
      ],
    }, "cli")),
    "VALIDATION_ERROR",
  );
  assert.equal(code(() => s.timeline.undo(s.project.id, { baseRevision: 0 }, "cli")), "REVISION_CONFLICT");
  assert.equal(JSON.stringify(s.timeline.get(s.project.id)), before);
});

test("assets from another project cannot be referenced", (t) => {
  const s = setup(t);
  const other = s.projects.create({ name: "Other" }, "cli");
  const otherVideo = s.timeline.get(other.id).tracks.find((x) => x.kind === "video")!;
  assert.equal(
    code(() => s.timeline.apply(other.id, { baseRevision: 1, operations: [{ type: "clip.add", trackId: otherVideo.id, assetId: s.asset.id, start: 0 }] }, "cli")),
    "VALIDATION_ERROR",
  );
  assert.equal(
    code(() => s.timeline.apply(other.id, { baseRevision: 1, operations: [{ type: "clip.add", trackId: s.video.id, assetId: s.asset.id, start: 0 }] }, "cli")),
    "VALIDATION_ERROR",
  );
});

test("no-op batches do not create revisions", (t) => {
  const s = setup(t);
  const tl = s.timeline.apply(s.project.id, { baseRevision: 2, operations: [{ type: "track.update", trackId: s.video.id, muted: false }] }, "cli");
  assert.equal(tl.project.revision, 2);
});

test("migration 2 gives pre-existing (M0) projects their default tracks", (t) => {
  const dir = tempDir(t);
  const db = new DatabaseSync(join(dir, "old.db"));
  migrate(db, MIGRATIONS.slice(0, 1));
  db.prepare("INSERT INTO projects VALUES ('00000000-0000-4000-8000-000000000001','Old',1,1,1080,1920,30,1,'t','t')").run();
  migrate(db);
  const n = db.prepare("SELECT count(*) AS n FROM tracks WHERE project_id = '00000000-0000-4000-8000-000000000001'").get() as { n: number };
  assert.equal(n.n, 5);
});

test("delete removes the project and every row recorded about it; other projects stay", (t) => {
  const s = setup(t);
  const cc = s.timeline.get(s.project.id).tracks.find((x) => x.kind === "caption")!;
  let tl = s.timeline.apply(s.project.id, { baseRevision: 2, operations: [{ type: "clip.add", trackId: s.video.id, assetId: s.asset.id, start: 0, duration: 90 }] }, "cli");
  tl = s.timeline.apply(s.project.id, { baseRevision: tl.project.revision, operations: [{ type: "captions.replace", trackId: cc.id, captions: [{ start: 0, duration: 30, text: "Hello" }] }] }, "cli");
  const jobs = new JobStore(s.db);
  const job = jobs.create(s.project.id, "export", { width: 1080, height: 1920, useProxies: false, crf: 18, preset: "medium", audioBitrateK: 192 }, null);
  jobs.cancel(job.id);
  const other = s.projects.create({ name: "Other" }, "cli");

  const gone = s.projects.delete(s.project.id);
  assert.equal(gone.name, "Cafe");
  assert.deepEqual(s.projects.list().map((p) => p.id), [other.id]);
  assert.equal(code(() => s.projects.get(s.project.id)), "NOT_FOUND");
  for (const table of ["edit_operations", "assets", "tracks", "clips", "captions", "render_jobs"]) {
    const n = (s.db.prepare(`SELECT count(*) AS n FROM ${table} WHERE project_id = ?`).get(s.project.id) as { n: number }).n;
    assert.equal(n, 0, `${table} rows left behind`);
  }
  assert.equal(s.timeline.get(other.id).tracks.length, 5, "the other project is untouched");
  assert.equal(code(() => s.projects.delete(s.project.id)), "NOT_FOUND");
});

test("delete is refused while a render or an analysis is still working on the project", (t) => {
  const s = setup(t);
  s.timeline.apply(s.project.id, { baseRevision: 2, operations: [{ type: "clip.add", trackId: s.video.id, assetId: s.asset.id, start: 0, duration: 90 }] }, "cli");
  const jobs = new JobStore(s.db);
  const job = jobs.create(s.project.id, "preview", { width: 540, height: 960, useProxies: true, crf: 28, preset: "veryfast", audioBitrateK: 96 }, null);
  assert.equal(code(() => s.projects.delete(s.project.id)), "BUSY");
  jobs.cancel(job.id);
  const analyses = new AnalysisStore(s.db);
  analyses.enqueue(s.project.id, s.asset.id, ["transcript"]);
  assert.equal(code(() => s.projects.delete(s.project.id)), "BUSY");
  assert.equal(s.projects.get(s.project.id).name, "Cafe", "nothing was deleted");
  s.db.prepare("UPDATE analyses SET state = 'failed'").run();
  s.projects.delete(s.project.id);
  assert.equal(s.projects.list().length, 0);
});
