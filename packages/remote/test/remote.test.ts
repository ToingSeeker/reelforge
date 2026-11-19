import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AssetStore, JobStore, openDatabase, ProjectStore, ProposalStore, TimelineStore, type RenderJob } from "@reelforge/core";
import {
  EditSessions,
  LEASE_MS,
  deriveDeviceKeys,
  normalisePairingCode,
  normaliseUrl,
  pairPhone,
  PIECE_BYTES,
  RemoteManager,
  seal,
  sealBytes,
  unseal,
  unsealBytes,
  type PairPayload,
  type RemoteManagerOptions,
} from "@reelforge/remote";
import { browser, checkVapid } from "./webpush-browser.ts";

// The relay that gets deployed, run in this process.
const { createRelay } = (await import(new URL("../../../apps/remote/server.mjs", import.meta.url).href)) as {
  createRelay(opts: { authHash: string }): Server;
};

async function listen(server: Server, port = 0): Promise<string> {
  await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function until<T>(what: string, fn: () => T | Promise<T>, ms = 6000): Promise<Exclude<NonNullable<T>, false>> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v as Exclude<NonNullable<T>, false>;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

type Ev = { t: string; [k: string]: unknown };

/** Pairs a phone with the code the Mac shows, the way the phone app does (hello, answer, then device.hello). */
async function pair(url: string, code: string, name = "Test iPhone"): Promise<PairPayload> {
  const c = normalisePairingCode(code)!;
  const ph = pairPhone(c.slice(4), name);
  const hello = await fetch(`${url}/pair/hello`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ lookup: c.slice(0, 4), msg: ph.hello }) });
  assert.equal(hello.status, 200, await hello.clone().text());
  for (;;) {
    const res = await fetch(`${url}/pair/answer?lookup=${c.slice(0, 4)}`);
    if (res.status === 204) continue;
    assert.equal(res.status, 200);
    return ph.open((await res.json()) as never);
  }
}

/** A paired phone: reads the stream (raw and opened), sends sealed commands, queues instructions. */
function phone(url: string, creds: PairPayload) {
  const { token, key } = deriveDeviceKeys(creds.deviceSecret);
  let broadcast = Buffer.from(creds.broadcastKey, "base64");
  const auth = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const abort = new AbortController();
  const raw: string[] = [];
  const events: Ev[] = [];
  const queue: Record<string, unknown>[] = [];
  const agent: boolean[] = [];
  let status = 0;
  const done = (async () => {
    const res = await fetch(`${url}/api/stream?since=0`, { headers: auth, signal: abort.signal }).catch(() => null);
    status = res?.status ?? -1;
    if (!res?.ok) return;
    let buffer = "";
    try {
      for await (const chunk of res.body as AsyncIterable<Uint8Array>) {
        buffer += new TextDecoder().decode(chunk);
        let end: number;
        while ((end = buffer.indexOf("\n\n")) >= 0) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          raw.push(block);
          const name = /^event: (.+)$/m.exec(block)?.[1];
          const data = /^data: (.*)$/m.exec(block)?.[1];
          if (!data) continue;
          const d = JSON.parse(data);
          if (name === "agent") agent.push(d.online);
          if (name === "queue") queue.push(d);
          if (name === "entry") {
            const ev = (d.to ? unseal(key, d.c, `evt:${creds.deviceId}`) : unseal(broadcast, d.c, "evt")) as Ev;
            if (ev.t === "rekey") broadcast = Buffer.from(String(ev.broadcastKey), "base64");
            events.push(ev);
          }
        }
      }
    } catch {
      // aborted
    }
  })();
  const send = (type: string, extra: Record<string, unknown> = {}) => {
    const id = crypto.randomUUID();
    const c = seal(key, { id, at: Date.now(), type, ...extra }, `cmd:${creds.deviceId}`);
    return fetch(`${url}/api/command`, { method: "POST", headers: auth, body: JSON.stringify({ c }) }).then((r) => ({ id, status: r.status, c }));
  };
  const enqueue = (id: string, projectId: string, body: Record<string, unknown>, ttl = 3600_000) => {
    const createdAt = Date.now();
    const c = seal(key, { id, projectId, type: "ai.ask", ...body }, `queue:${id}`);
    return fetch(`${url}/api/queue`, { method: "POST", headers: auth, body: JSON.stringify({ id, projectId, createdAt, expiresAt: createdAt + ttl, c }) });
  };
  return {
    url,
    /** One piece of a file the Mac is sending, opened. */
    piece: async (transferId: string, n: number) => {
      for (;;) {
        const r = await fetch(`${url}/api/chunk?id=${transferId}&n=${n}`, { headers: auth });
        if (r.status === 204) continue;
        assert.equal(r.status, 200);
        return unsealBytes(key, ((await r.json()) as { c: string }).c, `down:${transferId}:${n}`);
      }
    },
    putPiece: (uploadId: string, n: number, bytes: Buffer) =>
      fetch(`${url}/api/chunk`, { method: "POST", headers: auth, body: JSON.stringify({ id: uploadId, n, c: sealBytes(key, bytes, `up:${uploadId}:${n}`) }) }),
    raw,
    events,
    queue,
    agent,
    status: () => status,
    key,
    auth,
    send,
    enqueue,
    reply: <T = Ev>(id: string, t?: string) => events.find((e) => e.id === id && (!t || e.t === t)) as T | undefined,
    blob: async (id: string) => {
      const res = await fetch(`${url}/api/blob?id=${encodeURIComponent(id)}`, { headers: auth });
      assert.equal(res.status, 200);
      const { c } = (await res.json()) as { c: string };
      return { sealed: c, value: unseal(key, c, `blob:${id}`) as Record<string, unknown> };
    },
    close: async () => {
      abort.abort();
      await done;
    },
  };
}

function setup(t: { after: (fn: () => unknown) => void }, extra: Partial<RemoteManagerOptions> = {}) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "reelforge-remote-")));
  const db = openDatabase(join(home, "reelforge.db"));
  const servers: Server[] = [];
  const managers: RemoteManager[] = [];
  const make = (more: Partial<RemoteManagerOptions> = {}) => {
    const m = new RemoteManager({ db, dir: join(home, "remote"), version: "test", deviceName: "Test Mac", watchMs: 100, noPower: true, exportDir: join(home, "exports"), ...extra, ...more });
    managers.push(m);
    return m;
  };
  const relay = async (authHash: string, port = 0) => {
    const s = createRelay({ authHash });
    servers.push(s);
    return listen(s, port);
  };
  t.after(async () => {
    for (const m of managers) await m.close();
    for (const s of servers) {
      s.close();
      s.closeAllConnections();
    }
    db.close();
    rmSync(home, { recursive: true, force: true });
  });
  return { home, db, make, relay, servers };
}

/** A Mac connected to a fresh relay with one phone paired. */
async function paired(t: Parameters<typeof setup>[0], extra: Partial<RemoteManagerOptions> = {}) {
  const env = setup(t, extra);
  const m = env.make();
  const url = await env.relay(m.status().relayAuth);
  await m.start({ url });
  await until("online", () => m.status().state === "online");
  const { pairing } = await m.startPairing();
  const creds = await pair(url, pairing!.code);
  const p = phone(url, creds);
  t.after(() => p.close());
  const hello = await p.send("device.hello", { name: "Test iPhone" });
  await until("paired", () => p.reply(hello.id, "device"));
  return { ...env, m, url, creds, p };
}

function addClip(db: ReturnType<typeof openDatabase>, home: string, projectId: string) {
  writeFileSync(join(home, "pour.mp4"), "fake");
  const st = statSync(join(home, "pour.mp4"));
  const asset = new AssetStore(db).add(projectId, { path: join(home, "pour.mp4"), sizeBytes: st.size, mtimeMs: st.mtimeMs }, {
    kind: "video", durationUs: 10_000_000, width: 1080, height: 1920, fps: { num: 30, den: 1 }, vfr: false, hasVideo: true, hasAudio: false, hasAlpha: false,
    videoCodec: "h264", audioCodec: null, sampleRate: null, channels: null, rotation: 0,
  }, "desktop").asset;
  const timeline = new TimelineStore(db);
  const tl = timeline.get(projectId);
  const v1 = tl.tracks.find((x) => x.kind === "video")!.id;
  return { asset, clip: timeline.apply(projectId, { baseRevision: tl.project.revision, operations: [{ type: "clip.add", trackId: v1, assetId: asset.id, start: 0, duration: 90 }] }, "desktop").clips[0]! };
}

test("pairing: a one-time code, credentials only inside ECDH, per-phone tokens the relay learns from the Mac", async (t) => {
  const { home, db, make, relay } = setup(t);
  new ProjectStore(db).create({ name: "Café Opening", settings: { width: 1080, height: 1920 } }, "desktop");
  const m = make();
  const before = m.status();
  assert.equal(before.state, "stopped");
  assert.equal(before.devices.length, 0);
  assert.equal(make().status().relayAuth, before.relayAuth, "the Mac's secret persists across restarts");
  assert.equal(statSync(join(home, "remote", "settings.json")).mode & 0o777, 0o600);
  await assert.rejects(m.startPairing(), /Connect to the relay first/);

  const url = await relay(before.relayAuth);
  await m.start({ url: `${url}/` });
  await until("online", () => m.status().state === "online");
  const st = await m.startPairing();
  const code = st.pairing!.code;
  assert.match(code, /^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.equal(st.pairing!.link, `${url}/#pair=${code}`, "the QR holds only the one-time code");
  assert.equal(st.pairing!.state, "open");

  // A wrong code (right slot, wrong secret part) burns the slot; the real code then no longer works.
  const wrong = `${code.slice(0, 5)}${code.slice(5).split("").reverse().join("")}`;
  if (normalisePairingCode(wrong) !== normalisePairingCode(code)) {
    const lookup = normalisePairingCode(code)!.slice(0, 4);
    const bad = pairPhone(normalisePairingCode(wrong)!.slice(4), "Mallory");
    assert.equal((await fetch(`${url}/pair/hello`, { method: "POST", body: JSON.stringify({ lookup, msg: bad.hello }) })).status, 200);
    await until("the failed pairing", () => m.status().pairing?.state === "failed");
    assert.equal(m.status().devices.length, 0, "a wrong code makes no device");
    assert.equal((await fetch(`${url}/pair/hello`, { method: "POST", body: JSON.stringify({ lookup, msg: bad.hello }) })).status, 404, "one hello per code");
  }

  const fresh = (await m.startPairing()).pairing!.code;
  const creds = await pair(url, fresh);
  assert.equal(creds.macName, "Test Mac");
  assert.equal(m.status().pairing?.state, "answered");
  assert.equal(m.status().devices[0]?.confirmed, false);
  // The code is used up.
  const lookup = normalisePairingCode(fresh)!.slice(0, 4);
  assert.equal((await fetch(`${url}/pair/answer?lookup=${lookup}`)).status, 404);

  const p = phone(url, creds);
  t.after(() => p.close());
  const hello = await p.send("device.hello");
  const answer = await until("paired", () => p.reply(hello.id, "device"));
  assert.equal(answer.state, "paired");
  assert.equal(m.status().pairing?.state, "paired");
  const dev = m.status().devices[0]!;
  assert.deepEqual([dev.name, dev.confirmed], ["Test iPhone", true]);

  const snap = await until("a snapshot", () => p.events.find((e) => e.t === "snapshot"));
  assert.deepEqual((snap.projects as { name: string }[]).map((x) => x.name), ["Café Opening"]);
  assert.deepEqual((snap.mac as { name: string }).name, "Test Mac");
  assert.equal((snap.engine as { editor: string }).editor, "unknown");
  assert.ok(p.raw.every((b) => !b.includes("Café")), "the relay never sees a project name");

  // The Mac's own token is not a phone token, and a phone token can't act as the Mac.
  assert.equal((await fetch(`${url}/agent/events`, { method: "POST", headers: p.auth, body: '{"events":[]}' })).status, 401);

  // Commands from the phone are bound to it: a replay is ignored, also by a Mac that restarted.
  const ping = await p.send("ping");
  await until("pong", () => p.reply(ping.id, "pong"));
  await m.close();
  const again = make();
  await again.start();
  await until("online again", () => again.status().state === "online");
  await fetch(`${url}/api/command`, { method: "POST", headers: p.auth, body: JSON.stringify({ c: ping.c }) });
  const second = await p.send("ping");
  await until("the next pong", () => p.reply(second.id, "pong"));
  assert.equal(p.events.filter((e) => e.id === ping.id).length, 1, "the replayed command was not run again");

  // Revoking cuts the phone off at once, and the relay forgets its token.
  await again.revokeDevice(dev.id);
  await until("cut off", () => p.status() === 200 && p.raw.length > 0 && again.status().devices.length === 0);
  await until("refused", async () => (await fetch(`${url}/api/queue`, { headers: p.auth })).status === 401);
  assert.equal((await fetch(`${url}/api/queue`, { headers: p.auth })).status, 401);
});

test("queue: instructions wait on the relay while the Mac is away, run once, can be edited or cancelled first", async (t) => {
  const asked: string[] = [];
  let release: (() => void) | undefined;
  const { db, m, url, p, creds, make, home } = await paired(t, {
    ai: {
      providers: async () => [{ id: "ollama", label: "Local", external: false, models: ["q"], defaultModel: "q", ready: true, recipient: "ollama" }],
      propose: async (projectId, input) => {
        asked.push(input.instruction);
        await new Promise<void>((r) => (release = r));
        const tl = new TimelineStore(db).get(projectId);
        return new ProposalStore(db).create(projectId, { instruction: input.instruction, selection: [], provider: "ollama", model: "q", summary: `Did: ${input.instruction}`, operations: [{ type: "track.update", trackId: tl.tracks[0]!.id, muted: true }], explanations: ["x"], warnings: [] });
      },
    },
  });
  const project = new ProjectStore(db).create({ name: "Weekend recap", settings: { width: 1080, height: 1920 } }, "desktop");
  addClip(db, home, project.id);
  const rev = new ProjectStore(db).get(project.id).revision;

  // The Mac goes away (the engine quits). The phone queues two instructions and edits/cancels them.
  await m.close();
  await until("offline", () => p.agent.at(-1) === false);
  const a = crypto.randomUUID();
  const b = crypto.randomUUID();
  const res = await p.enqueue(a, project.id, { instruction: "tighten the intro", provider: "ollama", model: "q", baseRevision: rev });
  assert.equal(res.status, 201);
  assert.equal((await p.enqueue(a, project.id, { instruction: "tighten the intro", provider: "ollama", model: "q", baseRevision: rev })).status, 200, "the same id again is the same instruction");
  await p.enqueue(b, project.id, { instruction: "add music", provider: "ollama", model: "q", baseRevision: rev });
  const list = (await (await fetch(`${url}/api/queue`, { headers: p.auth })).json()) as { items: { id: string; status: string }[] };
  assert.deepEqual(list.items.map((i) => [i.id, i.status]).sort(), [[a, "queued"], [b, "queued"]].sort());
  // Edit a: new sealed text under the same id.
  const edited = seal(p.key, { id: a, projectId: project.id, type: "ai.ask", instruction: "tighten the intro to 3s", provider: "ollama", model: "q", baseRevision: rev }, `queue:${a}`);
  assert.equal((await fetch(`${url}/api/queue/${a}`, { method: "PUT", headers: p.auth, body: JSON.stringify({ c: edited }) })).status, 200);
  assert.equal((await fetch(`${url}/api/queue/${b}`, { method: "DELETE", headers: p.auth })).status, 200);

  // The Mac comes back: it takes what's waiting, once.
  const back = make();
  await back.start();
  await until("running", () => asked.length === 1);
  assert.deepEqual(asked, ["tighten the intro to 3s"], "the edit counts; the cancelled one never runs");
  await until("accepted", () => p.events.some((e) => e.t === "queue" && e.id === a && e.state === "running"));
  assert.equal((await fetch(`${url}/api/queue/${a}`, { method: "DELETE", headers: p.auth })).status, 409, "taken: no longer cancellable from the queue");
  release!();
  const done = await until("done", () => p.events.find((e) => e.t === "queue" && e.id === a && e.state === "done"));
  assert.ok(typeof done.proposalId === "string");
  // Posting the same id again after it ran: still not a second run.
  assert.equal((await p.enqueue(a, project.id, { instruction: "tighten the intro", provider: "ollama", model: "q", baseRevision: rev })).status, 200);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(asked.length, 1);

  // An instruction written against an older timeline is held for the user to look at again.
  new ProposalStore(db).apply(String(done.proposalId), { by: "desktop", channel: "test" });
  const c = crypto.randomUUID();
  await p.enqueue(c, project.id, { instruction: "make it pop", provider: "ollama", model: "q", baseRevision: rev });
  const held = await until("needs review", () => p.events.find((e) => e.t === "queue" && e.id === c));
  assert.equal(held.state, "needs_review");
  assert.equal(held.currentRevision, new ProjectStore(db).get(project.id).revision);
  assert.equal(asked.length, 1);

  // Expired before the Mac saw it: dropped.
  const e = crypto.randomUUID();
  const createdAt = Date.now();
  const sealed = seal(p.key, { id: e, projectId: project.id, type: "ai.ask", instruction: "late", provider: "ollama", model: "q" }, `queue:${e}`);
  assert.equal((await fetch(`${url}/api/queue`, { method: "POST", headers: p.auth, body: JSON.stringify({ id: e, projectId: project.id, createdAt, expiresAt: createdAt - 1, c: sealed }) })).status, 400);
  assert.ok(creds.deviceId);
});

test("exports: approve a version at a named revision, render, download in sealed pieces; uploads import", async (t) => {
  const jobs: RenderJob[] = [];
  const imported: string[] = [];
  const { db, home, p, m } = await paired(t, {
    render: {
      exportJob: (projectId, outputPath, opts) => {
        const job = new JobStore(db).create(projectId, "export", (plan) => ({ width: Math.round(plan.width * opts.scale), height: Math.round(plan.height * opts.scale), useProxies: false, crf: opts.quality === "small" ? 24 : 18, preset: "medium", audioBitrateK: 192 }), outputPath);
        jobs.push(job);
        return job;
      },
      previewJob: (projectId) => new JobStore(db).create(projectId, "preview", { width: 540, height: 960, useProxies: true, crf: 28, preset: "veryfast", audioBitrateK: 96 }, null),
      cancel: (jobId) => new JobStore(db).cancel(jobId),
      retry: (jobId) => new JobStore(db).retry(jobId),
    },
    media: {
      importFile: async (_projectId, path) => {
        imported.push(readFileSync(path, "utf8"));
        return { assetId: "a1", filename: "clip.mov" };
      },
    },
  });
  const project = new ProjectStore(db).create({ name: "Spider trade", settings: { width: 1080, height: 1920 } }, "desktop");
  const { clip } = addClip(db, home, project.id);
  const proposal = new ProposalStore(db).create(project.id, { instruction: "punch in", selection: [], provider: "fake", model: "m", summary: "Zoom in", operations: [{ type: "clip.update", clipId: clip.id, props: { scale: 1.2 } }], explanations: ["closer"], warnings: [] });

  const opts = await p.send("export.options", { projectId: project.id });
  const o = await until("options", () => p.reply<Ev & { resolutions: { id: string; width: number; height: number }[]; fps: number; format: string }>(opts.id, "export.options"));
  assert.deepEqual(o.resolutions.map((r) => [r.id, r.width, r.height]), [["full", 1080, 1920], ["half", 540, 960]]);
  assert.equal(o.fps, 30);
  assert.equal(o.format, "MP4");

  // Approval names the revision it approves: a stale one is refused, nothing is applied.
  const stale = await p.send("export.start", { projectId: project.id, proposalId: proposal.id, revision: proposal.baseRevision - 1 });
  const refused = await until("refused", () => p.reply(stale.id, "error"));
  assert.equal(refused.code, "REVISION_CONFLICT");
  assert.equal(new ProposalStore(db).get(proposal.id).status, "pending");

  const go = await p.send("export.start", { projectId: project.id, proposalId: proposal.id, revision: proposal.baseRevision, resolution: "half", quality: "standard" });
  const started = await until("export queued", () => p.reply(go.id, "export"));
  assert.equal(new ProposalStore(db).get(proposal.id).status, "applied");
  assert.equal((started.applied as { revision: number }).revision, started.revision);
  const job = jobs[0]!;
  assert.equal(job.settings.width, 540);
  assert.match(job.outputPath!, /Spider trade r\d+ half\.mp4$/);

  // Finished: the phone sees it on the Mac, with version and file details, and downloads it.
  const bytes = Buffer.alloc(PIECE_BYTES + 1234, 7);
  writeFileSync(job.outputPath!, bytes);
  const store = new JobStore(db);
  store.claim(job.id);
  store.complete(job.id, { path: job.outputPath!, sizeBytes: bytes.length, frames: 90, width: 540, height: 960, videoCodec: "h264", audioCodec: null });
  const listed = await until("listed", () => p.events.find((e) => e.t === "snapshot" && (e.exports as { id: string; onMac: boolean }[]).some((x) => x.id === job.id && x.onMac)));
  const ex = (listed.exports as { id: string; version: number; fileName: string; sizeBytes: number; folder: string }[]).find((x) => x.id === job.id)!;
  assert.equal(ex.version, 1);
  assert.equal(ex.sizeBytes, bytes.length);
  assert.match(ex.fileName, /\.mp4$/);

  const transferId = "t_".padEnd(24, "x");
  const get = await p.send("file.get", { jobId: job.id, transferId });
  const meta = await until("file meta", () => p.reply<Ev & { pieces: number; size: number }>(get.id, "file"));
  assert.equal(meta.pieces, 2);
  const parts: Buffer[] = [];
  for (let n = 0; n < meta.pieces; n++) parts.push(await p.piece(transferId, n));
  assert.deepEqual(Buffer.concat(parts), bytes, "the file arrives whole, opened with this phone's key");
  await until("sent", () => p.events.some((e) => e.id === get.id && e.t === "file" && e.state === "sent"));

  // A file attached on the phone goes up in sealed pieces and is imported into the project.
  const uploadId = "u_".padEnd(24, "y");
  const content = Buffer.from("a phone clip");
  const up = await p.send("upload.start", { projectId: project.id, uploadId, name: "../../clip.mov", size: content.length });
  await p.putPiece(uploadId, 0, content);
  const got = await until("imported", () => p.events.find((e) => e.id === up.id && e.t === "upload" && (e.state === "imported" || e.state === "failed")));
  assert.equal(got.state, "imported", String(got.message));
  assert.deepEqual(imported, ["a phone clip"]);

  // Cancel and retry go to the engine's runner.
  const second = await p.send("export.start", { projectId: project.id, revision: new ProjectStore(db).get(project.id).revision });
  await until("second export", () => p.reply(second.id, "export"));
  const cancel = await p.send("job.cancel", { jobId: jobs[1]!.id });
  assert.equal((await until("cancelled", () => p.reply(cancel.id, "job"))).state, "cancelled");
  void m;
  assert.ok(existsSync(job.outputPath!));
});

test("manual edit: a lease per project, idempotent edits on the shared reducer, conflicts never overwrite, undo stays in the session", async (t) => {
  const { db, home, p, m, creds, url } = await paired(t, { ai: { providers: async () => [], propose: () => Promise.reject(new Error("unused")) } });
  const project = new ProjectStore(db).create({ name: "Spider trade", settings: { width: 1080, height: 1920 } }, "desktop");
  const { clip } = addClip(db, home, project.id);
  const ask = async (type: string, extra: Record<string, unknown>) => {
    const s = await p.send(type, { projectId: project.id, ...extra });
    return until(type, () => p.events.find((e) => e.id === s.id && (e.t === "edit" || e.t === "error"))) as Promise<Ev & { model: { revision: number; clips: { id: string; start: number; duration: number; sourceIn: number; props: { scale: number } }[]; history: { canUndo: boolean; canRedo: boolean } }; revision: number; duplicate: boolean; code?: string; details?: Record<string, unknown>; lease: { mine: boolean } | null }>;
  };
  const sessionId = crypto.randomUUID();

  // Read-only look first, then the lease.
  const opened = await ask("edit.open", {});
  assert.equal(opened.t, "edit");
  assert.equal(opened.lease, null);
  assert.equal(opened.model.clips.length, 1);
  const begun = await ask("edit.begin", { sessionId });
  assert.equal(begun.lease?.mine, true);
  const base = begun.model.revision;

  // A trim through the same operation the desktop uses; one command id, one revision.
  const commandId = crypto.randomUUID();
  const trim = await ask("edit.apply", { sessionId, commandId, baseRevision: base, label: "Trim clip", operations: [{ type: "clip.trim", clipId: clip.id, edge: "end", frame: 60 }] });
  assert.equal(trim.t, "edit", String(trim.message));
  assert.equal(trim.revision, base + 1);
  assert.equal(new TimelineStore(db).get(project.id).clips[0]!.duration, 60);
  // The answer got lost and the phone sends it again: same result, not applied twice.
  const again = await ask("edit.apply", { sessionId, commandId, baseRevision: base, label: "Trim clip", operations: [{ type: "clip.trim", clipId: clip.id, edge: "end", frame: 60 }] });
  assert.equal(again.duplicate, true);
  assert.equal(new ProjectStore(db).get(project.id).revision, base + 1);

  // The reducer's rules hold on the phone too: past the source's end is refused, nothing changes.
  const bad = await ask("edit.apply", { sessionId, commandId: crypto.randomUUID(), baseRevision: base + 1, label: "Trim clip", operations: [{ type: "clip.trim", clipId: clip.id, edge: "end", frame: 9999 }] });
  assert.equal(bad.code, "VALIDATION_ERROR");
  assert.equal(new ProjectStore(db).get(project.id).revision, base + 1);

  // While a phone edits, the agent and outside undo wait.
  assert.throws(() => m.ask(project.id, { instruction: "zoom", provider: "x", model: "y" }), /editing this project by hand/);
  assert.throws(() => m.history("undo", project.id, base + 1), /editing this project by hand/);

  // Desktop edits in between: the phone's next edit names the old revision and is refused, not merged.
  new TimelineStore(db).apply(project.id, { baseRevision: base + 1, operations: [{ type: "clip.update", clipId: clip.id, props: { scale: 1.5 } }] }, "desktop");
  const conflict = await ask("edit.apply", { sessionId, commandId: crypto.randomUUID(), baseRevision: base + 1, label: "Framing", operations: [{ type: "clip.update", clipId: clip.id, props: { scale: 2 } }] });
  assert.equal(conflict.code, "REVISION_CONFLICT");
  assert.equal(conflict.details?.currentRevision, base + 2);
  assert.equal(new TimelineStore(db).get(project.id).clips[0]!.props.scale, 1.5, "the desktop's change stands");

  // Undo is scoped to the session: the newest step is the desktop's, so the phone can't undo it.
  const now = await ask("edit.open", {});
  assert.equal(now.model.history.canUndo, false);
  const split = await ask("edit.apply", { sessionId, commandId: crypto.randomUUID(), baseRevision: base + 2, label: "Split", operations: [{ type: "clip.split", clipId: clip.id, frame: 30 }] });
  assert.equal(split.model.clips.length, 2);
  assert.equal(split.model.history.canUndo, true);
  const undo = await ask("edit.undo", { sessionId, commandId: crypto.randomUUID(), baseRevision: split.revision });
  assert.equal(undo.model.clips.length, 1);
  assert.equal(undo.model.history.canRedo, true);
  assert.equal(undo.model.history.canUndo, false, "the desktop's step under it isn't the phone's to undo");

  // A second phone can't take the lease while the first holds it.
  const { pairing } = await m.startPairing();
  const creds2 = await pair(url, pairing!.code, "Second phone");
  const p2 = phone(url, creds2);
  t.after(() => p2.close());
  const hello2 = await p2.send("device.hello", { name: "Second phone" });
  await until("paired 2", () => p2.reply(hello2.id, "device"));
  const s2 = await p2.send("edit.begin", { projectId: project.id, sessionId: crypto.randomUUID() });
  const locked = await until("locked", () => p2.events.find((e) => e.id === s2.id && e.t === "error"));
  assert.equal(locked.code, "EDIT_LOCKED");
  assert.equal((locked.details as { deviceName: string }).deviceName, "Test iPhone");

  // Done: the lease is released and the session is summarised for Review.
  const end = await ask("edit.end", { sessionId });
  assert.equal(end.lease, null);
  const summary = (end as unknown as { summary: { fromRevision: number; toRevision: number; steps: string[]; undone: number } }).summary;
  assert.deepEqual(summary.steps, ["Trim clip"]);
  assert.equal(summary.undone, 1);
  assert.equal(summary.toRevision, new ProjectStore(db).get(project.id).revision);
  const after = await ask("edit.apply", { sessionId, commandId: crypto.randomUUID(), baseRevision: summary.toRevision, label: "Split", operations: [{ type: "clip.split", clipId: clip.id, frame: 30 }] });
  assert.equal(after.code, "LEASE_LOST");
  void creds;
});

test("manual edit: a lease lapses on its own when the phone goes quiet", () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "reelforge-lease-")));
  const db = openDatabase(join(home, "reelforge.db"));
  try {
    let now = 1_000_000;
    const edits = new EditSessions(db, { now: () => now });
    const project = new ProjectStore(db).create({ name: "P", settings: { width: 1080, height: 1920 } }, "desktop");
    const sid = crypto.randomUUID();
    edits.begin({ projectId: project.id, sessionId: sid, deviceId: "d1", deviceName: "Phone 1", agentBusy: false });
    assert.throws(() => edits.begin({ projectId: project.id, sessionId: crypto.randomUUID(), deviceId: "d2", deviceName: "Phone 2", agentBusy: false }), /Phone 1 is editing/);
    assert.throws(() => edits.begin({ projectId: project.id, sessionId: crypto.randomUUID(), deviceId: "d2", deviceName: "Phone 2", agentBusy: true }), /editing/);
    now += LEASE_MS - 1000;
    edits.heartbeat("d1", project.id, sid);
    now += LEASE_MS - 1000;
    assert.ok(edits.lease(project.id), "the heartbeat kept it");
    now += 2000;
    assert.equal(edits.lease(project.id), null, "no heartbeat: it lapsed");
    assert.throws(() => edits.heartbeat("d1", project.id, sid), /ended/);
    const other = edits.begin({ projectId: project.id, sessionId: crypto.randomUUID(), deviceId: "d2", deviceName: "Phone 2", agentBusy: false });
    assert.equal(other.lease.deviceName, "Phone 2");
    assert.throws(() => edits.begin({ projectId: project.id, sessionId: crypto.randomUUID(), deviceId: "d3", deviceName: "Phone 3", agentBusy: true }), (e: Error & { code?: string }) => e.code === "EDIT_LOCKED");
  } finally {
    db.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("manual edit: undo stays with the phone that made the steps, retries survive a lost lease, a lapse is announced", (t) => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "reelforge-edit-")));
  const db = openDatabase(join(home, "reelforge.db"));
  t.after(() => {
    db.close();
    rmSync(home, { recursive: true, force: true });
  });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let now = 1_000_000;
  const lapsed: string[] = [];
  const edits = new EditSessions(db, { now: () => now, onExpire: (pid) => lapsed.push(pid) });
  t.after(() => edits.close());
  const project = new ProjectStore(db).create({ name: "P", settings: { width: 1080, height: 1920 } }, "desktop");
  const { clip } = addClip(db, home, project.id);
  const sid = crypto.randomUUID();
  edits.begin({ projectId: project.id, sessionId: sid, deviceId: "d1", deviceName: "Phone 1", agentBusy: false });
  const rev = () => new ProjectStore(db).get(project.id).revision;
  const trimId = crypto.randomUUID();
  const trim = { projectId: project.id, sessionId: sid, commandId: trimId, label: "Trim clip", operations: [{ type: "clip.trim", clipId: clip.id, edge: "end", frame: 60 }] };
  const first = edits.apply("d1", { ...trim, baseRevision: rev() });
  assert.equal(first.duplicate, false);

  // The lease lapses (phone away): it's dropped AND announced, without anyone asking for it.
  now += LEASE_MS + 100;
  t.mock.timers.tick(LEASE_MS + 100);
  assert.deepEqual(lapsed, [project.id]);
  assert.equal(edits.lease(project.id), null);

  // The trim's answer was lost; the retry after the lapse still gets the same answer, not LEASE_LOST.
  assert.deepEqual(edits.apply("d1", { ...trim, baseRevision: first.revision - 1 }), { revision: first.revision, duplicate: true });
  // The same id can't be replayed as another command, or by another phone.
  assert.throws(() => edits.travel("d1", "undo", { projectId: project.id, sessionId: sid, commandId: trimId, baseRevision: rev() }), /already used/);
  assert.throws(() => edits.apply("d2", { ...trim, baseRevision: rev() }), /already used/);

  // Another phone takes over, reusing the first phone's session id: refused, so it can't reach those undo steps.
  assert.throws(() => edits.begin({ projectId: project.id, sessionId: sid, deviceId: "d2", deviceName: "Phone 2", agentBusy: false }), /belongs to another phone/);
  const sid2 = crypto.randomUUID();
  edits.begin({ projectId: project.id, sessionId: sid2, deviceId: "d2", deviceName: "Phone 2", agentBusy: false });
  assert.equal(edits.history(project.id, { sessionId: sid2, deviceId: "d2" }).canUndo, false, "the trim is phone 1's");
  assert.equal(edits.history(project.id, { sessionId: sid, deviceId: "d2" }).canUndo, false, "knowing the id isn't enough");
  assert.equal(edits.history(project.id, { sessionId: sid, deviceId: "d1" }).canUndo, true);
  assert.throws(() => edits.travel("d2", "undo", { projectId: project.id, sessionId: sid2, commandId: crypto.randomUUID(), baseRevision: rev() }), /Nothing of this editing session/);
  // The first phone resumes its own session later (its id is still its own).
  edits.end("d2", project.id, sid2);
  assert.equal(edits.begin({ projectId: project.id, sessionId: sid, deviceId: "d1", deviceName: "Phone 1", agentBusy: false }).lease.deviceId, "d1");
});
