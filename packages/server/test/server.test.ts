import { test } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

test("DELETE removes a project; a second delete is 404, and CORS lets the desktop send it", async (t) => {
  const srv = await boot(t);
  const { project } = (await (await call(srv, "POST", "/v1/projects", { body: { name: "Old" } })).json()) as any;
  const { project: keep } = (await (await call(srv, "POST", "/v1/projects", { body: { name: "Keep" } })).json()) as any;
  const pre = await call(srv, "OPTIONS", `/v1/projects/${project.id}`, { auth: false, headers: { origin: "http://localhost:5173", "access-control-request-method": "DELETE" } });
  assert.match(pre.headers.get("access-control-allow-methods") ?? "", /DELETE/);
  const del = await call(srv, "DELETE", `/v1/projects/${project.id}`);
  assert.equal(del.status, 200);
  assert.equal(((await del.json()) as any).deleted.name, "Old");
  const list = (await (await call(srv, "GET", "/v1/projects")).json()) as any;
  assert.deepEqual(list.projects.map((p: any) => p.id), [keep.id]);
  assert.equal((await call(srv, "DELETE", `/v1/projects/${project.id}`)).status, 404);
  assert.equal((await call(srv, "GET", `/v1/projects/${project.id}/timeline`)).status, 404);
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

test("media streaming: ?token= only on media GETs; proxies for video/image, originals for audio, with Range", async (t) => {
  const srv = await boot(t);
  const f = fixtures();
  const { project } = (await (await call(srv, "POST", "/v1/projects", { body: { name: "Media" } })).json()) as any;
  const r = (await (await call(srv, "POST", `/v1/projects/${project.id}/assets`, { body: { paths: [f.portrait, f.png, f.mp3] } })).json()) as any;
  const [video, image, audio] = r.imported;
  const q = `?token=${TOKEN}`;

  assert.equal((await call(srv, "GET", `/v1/projects${q}`, { auth: false })).status, 401, "query token is not a general credential");
  assert.equal((await call(srv, "GET", `/v1/projects/${project.id}/assets/${video.id}/media?token=wrong`, { auth: false })).status, 401);

  const v = await call(srv, "GET", `/v1/projects/${project.id}/assets/${video.id}/media${q}`, { auth: false, headers: { range: "bytes=0-1023" } });
  assert.equal(v.status, 206);
  assert.equal(v.headers.get("content-type"), "video/mp4");
  assert.equal((await v.arrayBuffer()).byteLength, 1024);

  const img = await call(srv, "GET", `/v1/projects/${project.id}/assets/${image.id}/media${q}`, { auth: false });
  assert.equal(img.headers.get("content-type"), "image/jpeg");
  const a = await call(srv, "GET", `/v1/projects/${project.id}/assets/${audio.id}/media${q}`, { auth: false });
  assert.equal(a.headers.get("content-type"), "audio/mpeg");
  assert.equal((await a.arrayBuffer()).byteLength, (await import("node:fs")).statSync(f.mp3).size, "audio is the original file");

  const thumb = await call(srv, "GET", `/v1/projects/${project.id}/assets/${video.id}/thumbnail${q}`, { auth: false });
  assert.equal(thumb.status, 200);
});

test("M3 over REST: analyze → poll, context, captions generate asks for transcripts, SRT, fonts", async (t) => {
  const srv = await boot(t);
  const f = fixtures();
  const { project } = (await (await call(srv, "POST", "/v1/projects", { body: { name: "M3" } })).json()) as any;
  const imp = (await (await call(srv, "POST", `/v1/projects/${project.id}/assets`, { body: { paths: [f.portrait, f.wav] } })).json()) as any;
  const [video, wav] = imp.imported;

  const bad = await call(srv, "POST", `/v1/projects/${project.id}/assets/${wav.id}/analyze`, { body: { kinds: ["scenes"] } });
  assert.equal(bad.status, 400, "scene detection needs a video");
  const started = await call(srv, "POST", `/v1/projects/${project.id}/assets/${video.id}/analyze`, { body: { kinds: ["scenes", "beats"] } });
  assert.equal(started.status, 202);
  let list: any[] = [];
  for (let i = 0; i < 100; i++) {
    list = ((await (await call(srv, "GET", `/v1/projects/${project.id}/assets/${video.id}/analysis`)).json()) as any).analyses;
    if (list.length === 2 && list.every((a) => a.state === "completed" || a.state === "failed")) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.deepEqual(list.map((a) => [a.kind, a.state]).sort(), [["beats", "completed"], ["scenes", "completed"]]);

  let tl = ((await (await call(srv, "GET", `/v1/projects/${project.id}/timeline`)).json()) as any).timeline;
  const voice = tl.tracks.find((x: any) => x.name === "Voice");
  const cc = tl.tracks.find((x: any) => x.kind === "caption");
  await call(srv, "POST", `/v1/projects/${project.id}/operations`, {
    body: {
      baseRevision: tl.project.revision,
      operations: [
        { type: "clip.add", trackId: voice.id, assetId: wav.id, start: 0 },
        { type: "caption.add", trackId: cc.id, start: 0, duration: 30, text: "Hello there" },
      ],
    },
  });

  const ctx = ((await (await call(srv, "GET", `/v1/projects/${project.id}/context`)).json()) as any).context;
  assert.equal(ctx.assets.find((a: any) => a.id === video.id).analysis.scenes.state, "completed");
  assert.deepEqual(ctx.timeline.captions.map((c: any) => c.text), ["Hello there"]);

  // No transcript yet: the engine queues one and says so instead of captioning nothing.
  const gen = await call(srv, "POST", `/v1/projects/${project.id}/captions/generate`, { body: { language: "en" } });
  assert.equal(gen.status, 202);
  const g = (await gen.json()) as any;
  assert.equal(g.status, "transcribing");
  assert.equal(g.missing[0].assetId, wav.id);

  const srt = await call(srv, "GET", `/v1/projects/${project.id}/captions.srt`);
  assert.equal(await srt.text(), "1\n00:00:00,000 --> 00:00:01,000\nHello there\n");
  assert.match(srt.headers.get("content-disposition") ?? "", /filename="M3\.srt"/);

  const font = await call(srv, "GET", `/v1/fonts/Anton-Regular.ttf?token=${TOKEN}`, { auth: false });
  assert.equal(font.status, 200);
  // A traversal attempt doesn't even match the font route, so the query token isn't accepted there.
  assert.ok([401, 404].includes((await call(srv, "GET", `/v1/fonts/..%2F..%2Fetc%2Fpasswd.ttf?token=${TOKEN}`, { auth: false })).status));
  assert.equal((await call(srv, "GET", `/v1/fonts/Other.ttf?token=${TOKEN}`, { auth: false })).status, 404);
});

test("M4 over REST: providers, consent gate, proposal → apply → undo (via a fake local Ollama)", async (t) => {
  const { createServer } = await import("node:http");
  let lastChat: any = null;
  let reply: object = {};
  const fake = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.url === "/api/tags") return res.end(JSON.stringify({ models: [{ name: "fake:1b" }] }));
      lastChat = JSON.parse(body);
      res.end(JSON.stringify({ model: lastChat.model, message: { content: JSON.stringify(reply) }, prompt_eval_count: 10, eval_count: 5 }));
    });
  });
  await new Promise<void>((r) => fake.listen(0, "127.0.0.1", () => r()));
  const prev = process.env.REELFORGE_OLLAMA_URL;
  process.env.REELFORGE_OLLAMA_URL = `http://127.0.0.1:${(fake.address() as any).port}`;
  t.after(() => {
    fake.close();
    if (prev === undefined) delete process.env.REELFORGE_OLLAMA_URL;
    else process.env.REELFORGE_OLLAMA_URL = prev;
  });

  const srv = await boot(t);
  const f = fixtures();
  const providers = ((await (await call(srv, "GET", "/v1/ai/providers")).json()) as any).providers;
  assert.deepEqual(providers.find((p: any) => p.id === "ollama").models, ["fake:1b"]);
  assert.equal(JSON.stringify(providers).includes("sk-"), false);

  const { project } = (await (await call(srv, "POST", "/v1/projects", { body: { name: "AI" } })).json()) as any;
  const imp = (await (await call(srv, "POST", `/v1/projects/${project.id}/assets`, { body: { paths: [f.portrait] } })).json()) as any;
  let tl = ((await (await call(srv, "GET", `/v1/projects/${project.id}/timeline`)).json()) as any).timeline;
  const v1 = tl.tracks.find((x: any) => x.kind === "video");
  tl = ((await (await call(srv, "POST", `/v1/projects/${project.id}/operations`, {
    body: { baseRevision: tl.project.revision, operations: [{ type: "clip.add", trackId: v1.id, assetId: imp.imported[0].id, start: 0 }] },
  })).json()) as any).timeline;
  const clip = tl.clips[0];

  // Claude is external: without consent the request is refused before anything is sent.
  const blocked = await call(srv, "POST", `/v1/projects/${project.id}/proposals`, { body: { instruction: "zoom in", provider: "anthropic" } });
  assert.equal(blocked.status, 403);
  assert.equal(((await blocked.json()) as any).error.code, "CONSENT_REQUIRED");

  reply = { summary: "Zoom in", warnings: [], operations: [{ type: "clip.update", why: "punch in", clipId: clip.id, props: { scale: 1.25 } }] };
  const made = await call(srv, "POST", `/v1/projects/${project.id}/proposals`, { body: { instruction: "zoom in", provider: "ollama" } });
  assert.equal(made.status, 201);
  const proposal = ((await made.json()) as any).proposal;
  assert.equal(proposal.model, "fake:1b");
  assert.equal(lastChat.format.type, "object", "the output schema is sent as Ollama's format");
  assert.match(lastChat.messages[1].content, /<instruction>\nzoom in/);

  const applied = await call(srv, "POST", `/v1/proposals/${proposal.id}/apply`, { headers: { "x-reelforge-actor": "desktop" } });
  assert.equal(applied.status, 200);
  const a = (await applied.json()) as any;
  assert.deepEqual(a.timeline.clips[0].props, { scale: 1.25 });
  assert.equal(a.proposal.approval.channel, "desktop:apply");
  const undone = ((await (await call(srv, "POST", `/v1/projects/${project.id}/undo`, { body: { baseRevision: a.timeline.project.revision } })).json()) as any).timeline;
  assert.deepEqual(undone.clips[0].props, {});
  assert.equal((await call(srv, "POST", `/v1/proposals/${proposal.id}/apply`)).status, 400, "can't apply twice");

  const list = ((await (await call(srv, "GET", `/v1/projects/${project.id}/proposals`)).json()) as any).proposals;
  assert.equal(list[0].status, "applied");
  const consent = await call(srv, "POST", `/v1/projects/${project.id}/ai-consent`, { body: { granted: true }, headers: { "x-reelforge-actor": "desktop" } });
  assert.equal(((await consent.json()) as any).consent.grantedBy, "desktop");
});

test("a dropped folder imports the media files inside it, only when the desktop asks for folders", async (t) => {
  const srv = await boot(t);
  const f = fixtures();
  const dir = mkdtempSync(join(tmpdir(), "reelforge-drop-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  copyFileSync(f.portrait, join(dir, "b.mp4"));
  copyFileSync(f.mp3, join(dir, "a.mp3"));
  writeFileSync(join(dir, "notes.txt"), "x");
  writeFileSync(join(dir, ".hidden.mp4"), "x");
  mkdirSync(join(dir, "sub"));
  copyFileSync(f.portrait, join(dir, "sub", "deeper.mp4"));
  const { project } = (await (await call(srv, "POST", "/v1/projects", { body: { name: "Drop" } })).json()) as any;

  const plain = (await (await call(srv, "POST", `/v1/projects/${project.id}/assets`, { body: { paths: [dir] } })).json()) as any;
  assert.equal(plain.imported.length, 0, "without folders: true a folder is just a failed path");

  const res = await call(srv, "POST", `/v1/projects/${project.id}/assets`, { body: { paths: [dir], folders: true } });
  assert.equal(res.status, 201);
  const r = (await res.json()) as any;
  assert.deepEqual(r.imported.map((a: any) => a.filename).sort(), ["a.mp3", "b.mp4"]);
  assert.equal(r.skipped, 3, "notes.txt, the hidden file and the subfolder");

  const empty = mkdtempSync(join(tmpdir(), "reelforge-drop-empty-"));
  t.after(() => rmSync(empty, { recursive: true, force: true }));
  writeFileSync(join(empty, "doc.pdf"), "x");
  const none = await call(srv, "POST", `/v1/projects/${project.id}/assets`, { body: { paths: [empty], folders: true } });
  assert.equal(none.status, 400);
  assert.match(((await none.json()) as any).error.message, /no media files there \(1 other item skipped\)/);
});

test("captions/propose: transcribes first (202), refuses a timeline with no sound", async (t) => {
  const srv = await boot(t);
  const f = fixtures();
  const { project } = (await (await call(srv, "POST", "/v1/projects", { body: { name: "Talk" } })).json()) as any;
  const empty = await call(srv, "POST", `/v1/projects/${project.id}/captions/propose`, { body: { instruction: "Buat caption" } });
  assert.equal(empty.status, 400);

  const imp = (await (await call(srv, "POST", `/v1/projects/${project.id}/assets`, { body: { paths: [f.landscape] } })).json()) as any;
  const asset = imp.imported[0];
  assert.equal(asset.hasAudio, true, "fixture has sound");
  const tl = (await (await call(srv, "GET", `/v1/projects/${project.id}/timeline`)).json()) as any;
  const overlay = tl.timeline.tracks.find((x: any) => x.kind === "overlay").id;
  await call(srv, "POST", `/v1/projects/${project.id}/operations`, { body: { baseRevision: tl.timeline.project.revision, operations: [{ type: "clip.add", trackId: overlay, assetId: asset.id, start: 0 }] } });
  const res = await call(srv, "POST", `/v1/projects/${project.id}/captions/propose`, { body: { instruction: "Buat caption", style: "bold" } });
  assert.equal(res.status, 202);
  const r = (await res.json()) as any;
  assert.equal(r.status, "transcribing");
  assert.equal(r.missing[0].assetId, asset.id);
  assert.equal(r.analyses.length, 1);
});


test("connector routes: unavailable without one, and pass through to it", async (t) => {
  const srv = await boot(t);
  const none = await call(srv, "GET", "/v1/connector");
  assert.equal(none.status, 503);

  const dir = mkdtempSync(join(tmpdir(), "reelforge-server-conn-"));
  const db = openDatabase(join(dir, "reelforge.db"));
  const calls: unknown[] = [];
  const fake = {
    status: () => ({ state: "stopped" }),
    start: async (input: unknown) => (calls.push(input), { state: "running" }),
    stop: async () => ({ state: "stopped" }),
    rotateKey: () => ({ rotated: true }),
    revokeAll: () => ({ revoked: true }),
  };
  const withConn = await startApiServer({ db, token: TOKEN, cacheDir: join(dir, "cache"), connector: fake });
  t.after(async () => {
    await withConn.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  assert.deepEqual(await (await call(withConn, "GET", "/v1/connector")).json(), { connector: { state: "stopped" } });
  assert.equal((await call(withConn, "POST", "/v1/connector/start", { body: { tunnel: "ftp" } })).status, 400);
  const started = await call(withConn, "POST", "/v1/connector/start", { body: { tunnel: "none", publicUrl: "https://x.test", domain: null } });
  assert.equal(started.status, 200);
  assert.deepEqual(calls, [{ tunnel: "none", domain: null, publicUrl: "https://x.test" }]);
  assert.equal((await call(withConn, "POST", "/v1/connector/rotate-key")).status, 200);
  assert.equal((await call(withConn, "POST", "/v1/connector/start", { auth: false })).status, 401);
});

test("phone remote routes: unavailable without one, and pass through to it", async (t) => {
  const srv = await boot(t);
  assert.equal((await call(srv, "GET", "/v1/remote")).status, 503);

  const dir = mkdtempSync(join(tmpdir(), "reelforge-server-remote-"));
  const db = openDatabase(join(dir, "reelforge.db"));
  const calls: unknown[] = [];
  const fake = {
    status: () => ({ state: "stopped" }),
    start: async (input: unknown) => (calls.push(input), { state: "connecting" }),
    stop: async () => ({ state: "stopped" }),
    rotate: async () => ({ rotated: true }),
    startPairing: async () => (calls.push("pair"), { pairing: { state: "open" } }),
    cancelPairing: async () => (calls.push("unpair"), { pairing: { state: "cancelled" } }),
    revokeDevice: async (id: string) => (calls.push(`revoke:${id}`), { devices: [] }),
    setRemoteReady: async (enabled: boolean) => (calls.push(`ready:${enabled}`), { ready: enabled }),
  };
  const engineCalls: unknown[] = [];
  const withRemote = await startApiServer({
    db,
    token: TOKEN,
    cacheDir: join(dir, "cache"),
    remote: fake,
    engine: {
      info: () => ({ background: true }),
      editor: (state) => engineCalls.push(`editor:${state}`),
      credential: (provider, key) => engineCalls.push(`key:${provider}:${key === null ? "null" : "set"}`),
      stop: () => engineCalls.push("stop"),
    },
  });
  t.after(async () => {
    await withRemote.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  assert.deepEqual(await (await call(withRemote, "GET", "/v1/remote")).json(), { remote: { state: "stopped" } });
  assert.equal((await call(withRemote, "POST", "/v1/remote/start", { body: { url: 42 } })).status, 400);
  assert.deepEqual(await (await call(withRemote, "POST", "/v1/remote/start", { body: { url: "https://relay.test" } })).json(), { remote: { state: "connecting" } });
  assert.equal((await call(withRemote, "POST", "/v1/remote/start", { body: {} })).status, 200);
  assert.deepEqual(await (await call(withRemote, "POST", "/v1/remote/rotate")).json(), { remote: { rotated: true } });
  assert.equal((await call(withRemote, "POST", "/v1/remote/stop", { auth: false })).status, 401);
  await call(withRemote, "POST", "/v1/remote/pairing");
  await call(withRemote, "POST", "/v1/remote/pairing/cancel");
  await call(withRemote, "POST", "/v1/remote/devices/dev123/revoke");
  assert.equal((await call(withRemote, "POST", "/v1/remote/ready", { body: { enabled: "yes" } })).status, 400);
  await call(withRemote, "POST", "/v1/remote/ready", { body: { enabled: true } });
  assert.deepEqual(calls, [{ url: "https://relay.test" }, {}, "pair", "unpair", "revoke:dev123", "ready:true"]);

  // The engine: the editor's heartbeat, a Keychain key handed over, and Stop Engine & Disconnect.
  assert.deepEqual(await (await call(withRemote, "GET", "/v1/engine")).json(), { engine: { background: true } });
  assert.equal((await call(withRemote, "POST", "/v1/engine/editor", { body: { state: "maybe" } })).status, 400);
  await call(withRemote, "POST", "/v1/engine/editor", { body: { state: "open" } });
  await call(withRemote, "POST", "/v1/engine/credentials", { body: { provider: "anthropic", apiKey: "sk-test" } });
  await call(withRemote, "POST", "/v1/engine/credentials", { body: { provider: "anthropic", apiKey: null } });
  assert.equal((await call(withRemote, "POST", "/v1/engine/stop", { auth: false })).status, 401);
  assert.equal((await call(withRemote, "POST", "/v1/engine/stop")).status, 202);
  await new Promise((r) => setTimeout(r, 120));
  assert.deepEqual(engineCalls, ["editor:open", "key:anthropic:set", "key:anthropic:null", "stop"]);
});
