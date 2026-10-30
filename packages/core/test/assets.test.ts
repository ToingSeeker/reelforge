import { test } from "node:test";
import assert from "node:assert/strict";
import { renameSync, unlinkSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { AssetStore, openDatabase, ProjectStore, ReelForgeError } from "../src/index.ts";
import { fakeMedia, tempDir } from "./helpers.ts";

test("status tracks missing/changed files; relink requires matching media (FR-007)", (t) => {
  const dir = tempDir(t);
  const db = openDatabase(join(dir, "db.sqlite"));
  const project = new ProjectStore(db).create({ name: "P", settings: { fps: { num: 30000, den: 1001 } } }, "cli");
  const assets = new AssetStore(db);
  const m = fakeMedia(dir, "clip.mov");
  const { asset } = assets.add(project.id, m.file, m.probe, "cli");
  assert.equal(asset.status, "online");
  assert.equal(asset.durationFrames, 299, "10s at 29.97 floors to 299 frames");

  appendFileSync(m.file.path, "more bytes");
  assert.equal(assets.get(project.id, asset.id).status, "changed");

  const moved = join(dir, "moved.mov");
  renameSync(m.file.path, moved);
  assert.equal(assets.get(project.id, asset.id).status, "missing");

  const wrong = fakeMedia(dir, "other.mov", { durationUs: 4_000_000 });
  const wrongSize = fakeMedia(dir, "other2.mov", { width: 1920, height: 1080 });
  assert.throws(() => assets.relink(project.id, asset.id, wrongSize.file, wrongSize.probe, "cli"), /frame size/);
  assert.throws(() => assets.relink(project.id, asset.id, wrong.file, wrong.probe, "cli"), (e: unknown) =>
    e instanceof ReelForgeError && e.code === "VALIDATION_ERROR" && /duration/.test(e.message));

  unlinkSync(moved);
  const replacement = fakeMedia(dir, "restored.mov");
  const relinked = assets.relink(project.id, asset.id, replacement.file, replacement.probe, "cli");
  assert.equal(relinked.status, "online");
  assert.equal(relinked.filename, "restored.mov");

  writeFileSync(join(dir, "x"), "");
  assert.throws(() => assets.get(project.id, "00000000-0000-4000-8000-000000000000"), (e: unknown) => e instanceof ReelForgeError && e.code === "NOT_FOUND");
});
