import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../src/main.ts";

function harness(t: { after: (fn: () => void) => void }) {
  const home = mkdtempSync(join(tmpdir(), "reelforge-cli-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return async (...argv: string[]) => {
    let out = "";
    let err = "";
    const code = await main(argv, {
      out: (s) => (out += s),
      err: (s) => (err += s),
      isTTY: false,
      env: { REELFORGE_HOME: home },
    });
    return { code, json: out ? JSON.parse(out) : undefined, error: err ? JSON.parse(err).error : undefined };
  };
}

test("create → list → rename → history, all JSON", async (t) => {
  const run = harness(t);
  const c = await run("project", "create", "--name", "Cafe Brand Story", "--fps", "29.97");
  assert.equal(c.code, 0);
  assert.deepEqual(c.json.project.settings.fps, { num: 30000, den: 1001 });
  const id = c.json.project.id;

  const l = await run("project", "list");
  assert.equal(l.json.projects.length, 1);

  const r = await run("project", "rename", id, "--name", "Cafe v2", "--base-revision", "1");
  assert.equal(r.code, 0);
  assert.equal(r.json.project.revision, 2);

  const h = await run("project", "history", id);
  assert.deepEqual(h.json.operations.map((o: any) => o.kind), ["project.create", "project.rename"]);
});

test("errors are JSON on stderr with distinct exit codes", async (t) => {
  const run = harness(t);
  const missing = await run("project", "create");
  assert.equal(missing.code, 2);
  assert.equal(missing.error.code, "VALIDATION_ERROR");

  const notFound = await run("project", "get", "00000000-0000-4000-8000-000000000000");
  assert.equal(notFound.code, 3);

  const id = (await run("project", "create", "--name", "A")).json.project.id;
  await run("project", "rename", id, "--name", "B", "--base-revision", "1");
  const conflict = await run("project", "rename", id, "--name", "C", "--base-revision", "1");
  assert.equal(conflict.code, 4);
  assert.equal(conflict.error.details.currentRevision, 2);

  const badFlag = await run("project", "list", "--bogus");
  assert.equal(badFlag.code, 2);
  const badFps = await run("project", "create", "--name", "x", "--fps", "abc");
  assert.equal(badFps.code, 2);
});

test("serve prints a ready line and exits on SIGTERM and on stdin EOF", async (t) => {
  const { spawn } = await import("node:child_process");
  const { once } = await import("node:events");
  const home = mkdtempSync(join(tmpdir(), "reelforge-serve-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const bin = new URL("../bin/reelforge.js", import.meta.url).pathname;

  async function boot() {
    // stdin stays an open pipe, exactly like the desktop shell's sidecar.
    const child = spawn(process.execPath, [bin, "serve"], { env: { ...process.env, REELFORGE_HOME: home }, stdio: ["pipe", "pipe", "inherit"] });
    const [chunk] = (await once(child.stdout!, "data")) as [Buffer];
    const ready = JSON.parse(chunk.toString().split("\n")[0]!);
    assert.equal(ready.event, "ready");
    assert.match(ready.url, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.ok(ready.token.length >= 32);
    return child;
  }

  const exitWithin = (child: ReturnType<typeof spawn>, ms: number) =>
    Promise.race([once(child, "exit").then(() => "exited"), new Promise((r) => setTimeout(() => r("hung"), ms))]);

  const a = await boot();
  a.kill("SIGTERM");
  assert.equal(await exitWithin(a, 3000), "exited");

  const b = await boot();
  b.stdin!.end(); // parent went away
  assert.equal(await exitWithin(b, 3000), "exited");
});
