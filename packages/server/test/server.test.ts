import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import { openDatabase } from "@reelforge/core";
import { startApiServer, type RunningServer } from "../src/index.ts";
import { fixtures } from "../../media/test/fixtures.ts";

const TOKEN = "t".repeat(48);

async function boot(t: { after: (fn: () => unknown) => void }): Promise<RunningServer> {
  const dir = mkdtempSync(join(tmpdir(), "reelforge-server-"));
  const db = openDatabase(join(dir, "reelforge.db"));
  const srv = await startApiServer({ db, token: TOKEN, allowedOrigins: ["http://localhost:5173"], cacheDir: join(dir, "cache") });
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

test("M1 over REST: import, edit, conflict, undo/redo, thumbnail", async (t) => {
  const srv = await boot(t);
  const f = fixtures();
  const { project } = (await (await call(srv, "POST", "/v1/projects", { body: { name: "Reel" } })).json()) as any;

  const imp = await call(srv, "POST", `/v1/projects/${project.id}/assets`, { body: { paths: [f.portrait, f.mp3, f.corrupt] } });
  assert.equal(imp.status, 201);
  const result = (await imp.json()) as any;
  assert.equal(result.imported.length, 2);
  assert.equal(result.failed[0].error.code, "VALIDATION_ERROR");
  assert.equal(result.failed[0].error.message.includes(f.dir), false, "FFmpeg errors don't echo local paths");

  let tl = ((await (await call(srv, "GET", `/v1/projects/${project.id}/timeline`)).json()) as any).timeline;
  const video = tl.tracks.find((x: any) => x.kind === "video");
  const ops = (baseRevision: number, operations: unknown[]) => call(srv, "POST", `/v1/projects/${project.id}/operations`, { body: { baseRevision, operations } });

  const added = await ops(tl.project.revision, [{ type: "clip.add", trackId: video.id, assetId: result.imported[0].id, start: 0 }]);
  assert.equal(added.status, 200);
  tl = ((await added.json()) as any).timeline;
  assert.equal(tl.clips.length, 1);

  const stale = await ops(tl.project.revision - 1, [{ type: "clip.move", clipId: tl.clips[0].id, start: 30 }]);
  assert.equal(stale.status, 409);
  const invalid = await ops(tl.project.revision, [{ type: "clip.move", clipId: tl.clips[0].id, start: -1 }]);
  assert.equal(invalid.status, 400);

  const undone = await call(srv, "POST", `/v1/projects/${project.id}/undo`, { body: { baseRevision: tl.project.revision } });
  const u = ((await undone.json()) as any).timeline;
  assert.equal(u.clips.length, 0);
  assert.equal(u.history.canRedo, true);
  const redone = ((await (await call(srv, "POST", `/v1/projects/${project.id}/redo`, { body: { baseRevision: u.project.revision } })).json()) as any).timeline;
  assert.equal(redone.clips.length, 1);

  const thumb = await call(srv, "GET", `/v1/projects/${project.id}/assets/${result.imported[0].id}/thumbnail`);
  assert.equal(thumb.status, 200);
  assert.equal(thumb.headers.get("content-type"), "image/jpeg");
  assert.ok((await thumb.arrayBuffer()).byteLength > 500);
  const wave = await call(srv, "GET", `/v1/projects/${project.id}/assets/${result.imported[1].id}/thumbnail`);
  assert.equal(wave.headers.get("content-type"), "image/png");

  const badBody = await call(srv, "POST", `/v1/projects/${project.id}/assets`, { body: { paths: "nope" } });
  assert.equal(badBody.status, 400);
  const foreignAsset = await call(srv, "GET", `/v1/projects/${project.id}/assets/00000000-0000-4000-8000-000000000000/thumbnail`);
  assert.equal(foreignAsset.status, 404);
});

test("M2 over REST: preview job (deduped per revision), Range output, export validation, cancel/retry rules", async (t) => {
  const srv = await boot(t);
  const f = fixtures();
  const { project } = (await (await call(srv, "POST", "/v1/projects", { body: { name: "Jobs", settings: { width: 320, height: 568 } } })).json()) as any;
  const imp = (await (await call(srv, "POST", `/v1/projects/${project.id}/assets`, { body: { paths: [f.portrait] } })).json()) as any;
  let tl = ((await (await call(srv, "GET", `/v1/projects/${project.id}/timeline`)).json()) as any).timeline;
  const video = tl.tracks.find((x: any) => x.kind === "video");
  await call(srv, "POST", `/v1/projects/${project.id}/operations`, {
    body: { baseRevision: tl.project.revision, operations: [{ type: "clip.add", trackId: video.id, assetId: imp.imported[0].id, start: 0, duration: 30 }] },
  });

  const first = await call(srv, "POST", `/v1/projects/${project.id}/preview-jobs`);
  assert.equal(first.status, 202);
  const job = ((await first.json()) as any).job;
  const again = ((await (await call(srv, "POST", `/v1/projects/${project.id}/preview-jobs`)).json()) as any).job;
  assert.equal(again.id, job.id, "same revision → same preview job");

  let state = job.state;
  for (let i = 0; i < 200 && !["completed", "failed"].includes(state); i++) {
    await new Promise((r) => setTimeout(r, 50));
    state = ((await (await call(srv, "GET", `/v1/jobs/${job.id}`)).json()) as any).job.state;
  }
  assert.equal(state, "completed");

  const full = await call(srv, "GET", `/v1/jobs/${job.id}/output`);
  assert.equal(full.headers.get("content-type"), "video/mp4");
  const size = (await full.arrayBuffer()).byteLength;
  const part = await call(srv, "GET", `/v1/jobs/${job.id}/output`, { headers: { range: "bytes=0-99" } });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get("content-range"), `bytes 0-99/${size}`);
  assert.equal((await part.arrayBuffer()).byteLength, 100);

  const badPath = await call(srv, "POST", `/v1/projects/${project.id}/render-jobs`, { body: { outputPath: "relative.mp4" } });
  assert.equal(badPath.status, 400);
  const overwriteSource = await call(srv, "POST", `/v1/projects/${project.id}/render-jobs`, { body: { outputPath: f.portrait } });
  assert.equal(overwriteSource.status, 400);
  assert.equal((await call(srv, "POST", `/v1/jobs/${job.id}/cancel`)).status, 400, "completed jobs can't be cancelled");
  assert.equal((await call(srv, "POST", `/v1/jobs/${job.id}/retry`)).status, 400, "completed jobs can't be retried");
  const list = ((await (await call(srv, "GET", `/v1/projects/${project.id}/jobs?kind=preview`)).json()) as any).jobs;
  assert.equal(list.length, 1);
});
