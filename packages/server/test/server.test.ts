import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import { openDatabase } from "@reelforge/core";
import { startApiServer, type RunningServer } from "../src/index.ts";

const TOKEN = "t".repeat(48);

async function boot(t: { after: (fn: () => unknown) => void }): Promise<RunningServer> {
  const dir = mkdtempSync(join(tmpdir(), "reelforge-server-"));
  const db = openDatabase(join(dir, "reelforge.db"));
  const srv = await startApiServer({ db, token: TOKEN, allowedOrigins: ["http://localhost:5173"] });
  t.after(async () => {
    await srv.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return srv;
}

function call(srv: RunningServer, method: string, path: string, opts: { body?: unknown; headers?: Record<string, string>; auth?: boolean } = {}) {
  return fetch(srv.url + path, {
    method,
    headers: {
      ...(opts.auth === false ? {} : { authorization: `Bearer ${TOKEN}` }),
      ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
      ...opts.headers,
    },
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
}

test("health is public, everything else needs the token", async (t) => {
  const srv = await boot(t);
  assert.equal((await call(srv, "GET", "/v1/health", { auth: false })).status, 200);
  const res = await call(srv, "GET", "/v1/projects", { auth: false });
  assert.equal(res.status, 401);
  assert.equal(((await res.json()) as any).error.code, "UNAUTHORIZED");
  assert.equal((await call(srv, "GET", "/v1/projects", { headers: { authorization: `Bearer ${"x".repeat(48)}` } })).status, 401);
});

test("project CRUD over REST with revision conflicts", async (t) => {
  const srv = await boot(t);
  const created = await call(srv, "POST", "/v1/projects", { body: { name: "Cafe" }, headers: { "x-reelforge-actor": "desktop" } });
  assert.equal(created.status, 201);
  const { project } = (await created.json()) as any;
  assert.equal(project.revision, 1);

  const list = (await (await call(srv, "GET", "/v1/projects")).json()) as any;
  assert.equal(list.projects.length, 1);

  const renamed = await call(srv, "PATCH", `/v1/projects/${project.id}`, { body: { name: "Cafe v2", baseRevision: 1 } });
  assert.equal(renamed.status, 200);
  const stale = await call(srv, "PATCH", `/v1/projects/${project.id}`, { body: { name: "Cafe v3", baseRevision: 1 } });
  assert.equal(stale.status, 409);
  assert.equal(((await stale.json()) as any).error.code, "REVISION_CONFLICT");

  const history = (await (await call(srv, "GET", `/v1/projects/${project.id}/history`)).json()) as any;
  assert.deepEqual(history.operations.map((o: any) => o.actor), ["desktop", "api"]);
});

test("validation and not-found map to 400/404", async (t) => {
  const srv = await boot(t);
  assert.equal((await call(srv, "POST", "/v1/projects", { body: { name: "" } })).status, 400);
  assert.equal((await call(srv, "GET", "/v1/projects/not-a-uuid")).status, 400);
  assert.equal((await call(srv, "GET", "/v1/projects/00000000-0000-4000-8000-000000000000")).status, 404);
  assert.equal((await call(srv, "GET", "/v1/nope")).status, 404);
});

test("foreign origins and rebinding hosts are refused", async (t) => {
  const srv = await boot(t);
  const evil = await call(srv, "GET", "/v1/projects", { headers: { origin: "https://evil.example" } });
  assert.equal(evil.status, 403);
  const ok = await call(srv, "GET", "/v1/projects", { headers: { origin: "http://localhost:5173" } });
  assert.equal(ok.headers.get("access-control-allow-origin"), "http://localhost:5173");

  // fetch() won't let us forge Host, so use a raw request.
  const status = await new Promise<number>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: srv.port, path: "/v1/health", headers: { host: "attacker.example" } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
    req.end();
  });
  assert.equal(status, 403);
});
