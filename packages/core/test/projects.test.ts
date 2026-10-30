import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, ProjectStore, ReelForgeError } from "../src/index.ts";

function tempDb(t: { after: (fn: () => void) => void }) {
  const dir = mkdtempSync(join(tmpdir(), "reelforge-core-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, "reelforge.db");
}

function code(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    if (e instanceof ReelForgeError) return e.code;
    throw e;
  }
  return undefined;
}

test("create applies 1080x1920 @ 30fps defaults at revision 1 (FR-002, FR-003)", (t) => {
  const store = new ProjectStore(openDatabase(tempDb(t)));
  const p = store.create({ name: "  Cafe Brand Story  " }, "cli");
  assert.equal(p.name, "Cafe Brand Story");
  assert.equal(p.revision, 1);
  assert.equal(p.schemaVersion, 1);
  assert.deepEqual(p.settings, { width: 1080, height: 1920, fps: { num: 30, den: 1 } });
  assert.match(p.id, /^[0-9a-f-]{36}$/);
});

test("create validates name and settings", (t) => {
  const store = new ProjectStore(openDatabase(tempDb(t)));
  assert.equal(code(() => store.create({ name: "   " }, "cli")), "VALIDATION_ERROR");
  assert.equal(code(() => store.create({ name: "x", settings: { width: 1081 } }, "cli")), "VALIDATION_ERROR");
  assert.equal(code(() => store.create({ name: "x", settings: { fps: { num: 1000, den: 1 } } }, "cli")), "VALIDATION_ERROR");
  assert.equal(store.list().length, 0);
});

test("rename bumps revision and records an operation", (t) => {
  const store = new ProjectStore(openDatabase(tempDb(t)));
  const p = store.create({ name: "Draft" }, "cli");
  const r = store.rename(p.id, { name: "Final", baseRevision: 1 }, "desktop");
  assert.equal(r.revision, 2);
  assert.equal(r.name, "Final");
  const ops = store.history(p.id);
  assert.deepEqual(ops.map((o) => [o.revision, o.kind, o.actor]), [
    [1, "project.create", "cli"],
    [2, "project.rename", "desktop"],
  ]);
  assert.deepEqual(ops[1]?.payload, { from: "Draft", to: "Final" });
});

test("stale baseRevision is a conflict and changes nothing (FR-016, FR-018)", (t) => {
  const store = new ProjectStore(openDatabase(tempDb(t)));
  const p = store.create({ name: "A" }, "cli");
  store.rename(p.id, { name: "B", baseRevision: 1 }, "cli");
  assert.equal(code(() => store.rename(p.id, { name: "C", baseRevision: 1 }, "desktop")), "REVISION_CONFLICT");
  const after = store.get(p.id);
  assert.equal(after.name, "B");
  assert.equal(after.revision, 2);
  assert.equal(store.history(p.id).length, 2);
});

test("unknown and malformed ids", (t) => {
  const store = new ProjectStore(openDatabase(tempDb(t)));
  assert.equal(code(() => store.get("00000000-0000-4000-8000-000000000000")), "NOT_FOUND");
  assert.equal(code(() => store.get("../../etc/passwd")), "VALIDATION_ERROR");
});

test("state survives close/reopen and is shared between two handles", (t) => {
  const path = tempDb(t);
  const a = openDatabase(path);
  const b = openDatabase(path); // e.g. desktop sidecar + CLI on the same file
  const storeA = new ProjectStore(a);
  const storeB = new ProjectStore(b);
  const p = storeA.create({ name: "Shared" }, "cli");
  assert.equal(storeB.get(p.id).name, "Shared");
  storeB.rename(p.id, { name: "Shared v2", baseRevision: 1 }, "desktop");
  assert.equal(storeA.get(p.id).revision, 2);
  a.close();
  b.close();
  const reopened = new ProjectStore(openDatabase(path));
  assert.equal(reopened.get(p.id).name, "Shared v2");
});

test("migrations run once per database", (t) => {
  const path = tempDb(t);
  openDatabase(path).close();
  const db = openDatabase(path);
  const rows = db.prepare("SELECT version FROM schema_migrations").all();
  assert.deepEqual(rows.map((r) => r.version), [1]);
});
