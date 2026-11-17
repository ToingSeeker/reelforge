import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AssetStore, JobStore, openDatabase, ProjectStore, ProposalStore, TimelineStore } from "@reelforge/core";
import { deriveKeys, normaliseUrl, RemoteManager, seal, unseal, type RemoteManagerOptions } from "@reelforge/remote";
import { browser, checkVapid } from "./webpush-browser.ts";

// The relay that gets deployed, run in this process.
const { createRelay } = (await import(new URL("../../../apps/remote/server.mjs", import.meta.url).href)) as {
  createRelay(opts: { authHash: string }): Server;
};

async function listen(server: Server): Promise<string> {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function until<T>(what: string, fn: () => T | undefined | false, ms = 5000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** A phone: reads the relay's stream (raw and decrypted) and sends sealed commands. */
function phone(url: string, secret: string) {
  const { token, key } = deriveKeys(secret);
  const abort = new AbortController();
  const raw: string[] = [];
  const events: { t: string; [k: string]: unknown }[] = [];
  const agent: boolean[] = [];
  const done = (async () => {
    const res = await fetch(`${url}/api/stream?since=0`, { headers: { authorization: `Bearer ${token}` }, signal: abort.signal });
    assert.equal(res.status, 200);
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
          if (name === "agent" && data) agent.push((JSON.parse(data) as { online: boolean }).online);
          if (name === "entry" && data) events.push(unseal(key, (JSON.parse(data) as { c: string }).c) as (typeof events)[number]);
        }
      }
    } catch {
      // aborted
    }
  })();
  const post = (c: string) => fetch(`${url}/api/command`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ c }) });
  return {
    raw,
    events,
    agent,
    /** A file the Mac left on the relay, opened. */
    blob: async (id: string) => {
      const res = await fetch(`${url}/api/blob?id=${encodeURIComponent(id)}`, { headers: { authorization: `Bearer ${token}` } });
      assert.equal(res.status, 200);
      const { c } = (await res.json()) as { c: string };
      return { sealed: c, value: unseal(key, c) as Record<string, unknown> };
    },
    sealCommand: (cmd: Record<string, unknown>) => seal(key, cmd),
    post,
    send: (type: string, extra: Record<string, unknown> = {}) => post(seal(key, { id: crypto.randomUUID(), at: Date.now(), type, ...extra })),
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
  const make = () => {
    const m = new RemoteManager({ db, dir: join(home, "remote"), version: "test", deviceName: "Test Mac", watchMs: 100, ...extra });
    managers.push(m);
    return m;
  };
  const relay = async (authHash: string) => {
    const s = createRelay({ authHash });
    servers.push(s);
    return listen(s);
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

test("the phone sees the Mac's projects through the relay, which only ever holds ciphertext", async (t) => {
  const { home, db, make, relay } = setup(t);
  const projects = new ProjectStore(db);
  projects.create({ name: "Café Opening", settings: { width: 1080, height: 1920 } }, "desktop");

  const m = make();
  const before = m.status();
  assert.equal(before.state, "stopped");
  assert.equal(before.pairingLink, null, "no link until the relay address is known");
  assert.equal(make().status().relayAuth, before.relayAuth, "the secret persists across restarts");
  assert.equal(statSync(join(home, "remote", "settings.json")).mode & 0o777, 0o600);
  const secret = JSON.parse(readFileSync(join(home, "remote", "settings.json"), "utf8")).secret as string;
  assert.equal(before.relayAuth, deriveKeys(secret).authHash);

  const url = await relay(before.relayAuth);
  const on = await m.start({ url: `${url}/` });
  assert.equal(on.settings.url, url);
  assert.equal(on.pairingLink, `${url}/#k=${secret}`);
  await until("online", () => m.status().state === "online");

  const p = phone(url, secret);
  t.after(() => p.close());
  const snap = await until("a snapshot", () => p.events.find((e) => e.t === "snapshot"));
  assert.deepEqual(snap.device, { name: "Test Mac", version: "test", at: (snap.device as { at: number }).at });
  const list = snap.projects as { name: string; width: number; height: number; fps: number; pendingProposals: number }[];
  assert.deepEqual(
    list.map((x) => [x.name, x.width, x.height, x.pendingProposals]),
    [["Café Opening", 1080, 1920, 0]],
  );
  assert.deepEqual(snap.jobs, []);
  assert.ok(p.agent.includes(true), "the phone is told the Mac is online");
  assert.ok(!p.raw.join("\n").includes("Café"), "nothing readable passes through the relay");

  // A round trip, and a replayed or stale command does nothing.
  const ping = p.sealCommand({ id: "ping-1", at: Date.now(), type: "ping" });
  assert.equal((await p.post(ping)).status, 200);
  await until("a pong", () => p.events.some((e) => e.t === "pong"));
  assert.equal((await p.post(ping)).status, 200);
  await p.send("ping", { at: Date.now() - 10 * 60 * 1000 });
  await p.post(seal(deriveKeys("someone-else-entirely-0123456789abcdef").key, { id: "x", at: Date.now(), type: "ping" }));
  await p.send("sync");
  await until("the sync answer", () => p.events.filter((e) => e.t === "snapshot").length >= 2);
  assert.equal(p.events.filter((e) => e.t === "pong").length, 1, "replayed, stale and foreign commands are ignored");
  await p.send("project.delete", { projectId: "anything" });
  const refused = await until("the refusal", () => p.events.find((e) => e.t === "error"));
  assert.match(String(refused.message), /Unknown command/);

  // A change made on the Mac reaches the phone without it asking.
  projects.create({ name: "Product Demo", settings: { width: 1920, height: 1080 } }, "desktop");
  await until("the new project", () => p.events.some((e) => e.t === "snapshot" && (e.projects as unknown[]).length === 2));

  // Stop: the phone is told, and the choice is remembered.
  const off = await m.stop();
  assert.equal(off.state, "stopped");
  assert.equal(off.settings.autoStart, false);
  await until("offline", () => p.agent.at(-1) === false);
});

test("a new pairing locks out the old one; addresses are checked; auto-start follows the last choice", async (t) => {
  const { make, relay } = setup(t);
  const m = make();
  const first = m.status();
  const url = await relay(first.relayAuth);

  await assert.rejects(m.start(), /relay's address/);
  await assert.rejects(m.start({ url: "http://relay.example.com" }), /https origin/);
  await assert.rejects(m.start({ url: "https://relay.example.com/path" }), /https origin/);
  assert.equal(normaliseUrl("https://forge-remote-production.up.railway.app/"), "https://forge-remote-production.up.railway.app");
  assert.equal(normaliseUrl("http://localhost:8787"), "http://localhost:8787");

  await m.start({ url });
  await until("online", () => m.status().state === "online");
  assert.equal(make().status().settings.autoStart, true);

  // The relay still knows the old value, so it now refuses this Mac: a clear error, no retry loop.
  const rotated = await m.rotate();
  assert.notEqual(rotated.relayAuth, first.relayAuth);
  const failed = await until("the refusal", () => (m.status().state === "error" ? m.status() : undefined));
  assert.match(failed.error ?? "", /REELFORGE_REMOTE_AUTH/);

  // After a restart of the engine it comes back by itself, against a relay that has the new value.
  const url2 = await relay(rotated.relayAuth);
  await m.start({ url: url2 });
  await m.close();
  const again = make();
  await again.autoStart();
  await until("back online", () => again.status().state === "online");
});

test("stage 2: project detail, poster, live job progress and notifications straight from the Mac", async (t) => {
  // A push service on this machine: records what it is sent, answers with `answer`.
  const pushed: { path: string; headers: Record<string, string | string[] | undefined>; body: Buffer }[] = [];
  let answer = 201;
  const pushService = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      pushed.push({ path: req.url ?? "", headers: req.headers, body: Buffer.concat(chunks) });
      res.writeHead(answer).end();
    });
  });
  const pushUrl = await listen(pushService);

  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 0xff, 0xd9]);
  const { home, db, make, relay, servers } = setup(t, {
    notifyMs: 100,
    allowLocalPush: true,
    thumbnail: async (asset) => {
      const path = join(home, `${asset.id}.jpg`);
      writeFileSync(path, jpeg);
      return { path, contentType: "image/jpeg" };
    },
  });
  servers.push(pushService);

  const project = new ProjectStore(db).create({ name: "Café Opening", settings: { width: 1080, height: 1920 } }, "desktop");
  writeFileSync(join(home, "pour.mp4"), "fake");
  const st = statSync(join(home, "pour.mp4"));
  const asset = new AssetStore(db).add(project.id, { path: join(home, "pour.mp4"), sizeBytes: st.size, mtimeMs: st.mtimeMs }, {
    kind: "video", durationUs: 10_000_000, width: 1080, height: 1920, fps: { num: 30, den: 1 }, vfr: false, hasVideo: true, hasAudio: false, hasAlpha: false,
    videoCodec: "h264", audioCodec: null, sampleRate: null, channels: null, rotation: 0,
  }, "desktop").asset;
  const timeline = new TimelineStore(db);
  const tl = timeline.get(project.id);
  const v1 = tl.tracks.find((x) => x.kind === "video")!.id;
  const clip = timeline.apply(project.id, { baseRevision: tl.project.revision, operations: [{ type: "clip.add", trackId: v1, assetId: asset.id, start: 0, duration: 90 }] }, "desktop").clips[0]!;

  const m = make();
  const url = await relay(m.status().relayAuth);
  await m.start({ url });
  await until("online", () => m.status().state === "online");
  const secret = JSON.parse(readFileSync(join(home, "remote", "settings.json"), "utf8")).secret as string;
  const p = phone(url, secret);
  t.after(() => p.close());
  const snap = await until("a snapshot", () => p.events.find((e) => e.t === "snapshot"));
  assert.equal(Buffer.from(String(snap.pushKey), "base64url").length, 65, "the phone gets this Mac's VAPID key");
  assert.deepEqual(snap.recent, []);

  // Detail: a read-only summary of the timeline.
  await p.send("project.open", { projectId: project.id });
  const opened = await until("the project", () => p.events.find((e) => e.t === "project"));
  const detail = opened.project as { name: string; clips: number; durationFrames: number; assets: Record<string, number>; tracks: { kind: string; clips: { start: number; duration: number }[] }[] };
  assert.equal(detail.name, "Café Opening");
  assert.equal(detail.clips, 1);
  assert.equal(detail.durationFrames, 90);
  assert.deepEqual(detail.assets, { video: 1, audio: 0, image: 0, offline: 0 });
  assert.deepEqual(detail.tracks.find((x) => x.kind === "video")?.clips, [{ start: 0, duration: 90 }]);
  await p.send("project.open", { projectId: "../../etc/passwd" });
  await until("the refusal", () => p.events.some((e) => e.t === "error" && /isn't valid/.test(String(e.message))));

  // Poster: a sealed file on the relay, fetched once.
  await p.send("poster", { projectId: project.id });
  const poster = await until("the poster", () => p.events.find((e) => e.t === "poster"));
  assert.equal(typeof poster.key, "string");
  const file = await p.blob(String(poster.blob));
  assert.deepEqual(file.value, { type: "image/jpeg", data: jpeg.toString("base64") });
  assert.ok(!file.sealed.includes(jpeg.toString("base64")), "the relay holds the picture encrypted");

  // A running export moves as small `jobs` events, not whole snapshots.
  const jobs = new JobStore(db);
  const job = jobs.create(project.id, "export", { width: 1080, height: 1920, useProxies: false, crf: 20, preset: "fast", audioBitrateK: 192 }, join(home, "out.mp4"));
  await until("the queued job", () => p.events.some((e) => e.t === "jobs" && (e.jobs as { id: string }[]).some((j) => j.id === job.id)));
  jobs.claim(job.id);
  jobs.advance(job.id, "rendering", 0.5);
  await until("progress", () => p.events.some((e) => e.t === "jobs" && (e.jobs as { progress: number }[])[0]?.progress === 0.5));

  // Notifications: the phone subscribes; a test notification arrives encrypted and signed.
  const b = browser();
  const endpoint = `${pushUrl}/push/phone-1`;
  await p.send("push.subscribe", { endpoint, keys: b.keys, prefs: { exports: true, proposals: true, failures: true } });
  await until("subscribed", () => p.events.some((e) => e.t === "push" && e.subscribed === true));
  assert.equal(m.status().notifications, 1);
  await p.send("push.test", { endpoint });
  const first = await until("the test push", () => pushed[0]);
  assert.equal(first.path, "/push/phone-1");
  assert.equal(first.headers["content-encoding"], "aes128gcm");
  const claims = checkVapid(String(first.headers.authorization), String(snap.pushKey));
  assert.equal(claims.aud, pushUrl);
  assert.match(String((b.decrypt(first.body) as { body: string }).body), /working/);
  await p.send("push.subscribe", { endpoint: "https://192.168.1.1/x", keys: b.keys });
  await until("the refusal", () => p.events.some((e) => e.t === "error" && /push endpoints/.test(String(e.message))));

  // The export finishes: Home lists it and the phone is told, with the project's name only inside the encryption.
  jobs.complete(job.id, { path: join(home, "out.mp4"), sizeBytes: 38_200_000, frames: 90, width: 1080, height: 1920, videoCodec: "h264", audioCodec: null });
  const done = await until("the export push", () => pushed.find((x) => (b.decrypt(x.body) as { title: string }).title === "Export ready"));
  assert.deepEqual(b.decrypt(done.body), { title: "Export ready", body: "“Café Opening” · 38.2 MB", tag: `job-${job.id}`, url: `/#/p/${project.id}` });
  assert.ok(!done.body.includes(Buffer.from("Café")));
  await until("recent on Home", () => p.events.some((e) => e.t === "snapshot" && (e.recent as { id: string; sizeBytes: number }[]).some((j) => j.id === job.id && j.sizeBytes === 38_200_000)));

  // A proposal from the AI Director.
  new ProposalStore(db).create(project.id, { instruction: "punch in", selection: [], provider: "fake", model: "m", summary: "Zoom in on the pour", operations: [{ type: "clip.update", clipId: clip.id, props: { scale: 1.2 } }], explanations: ["closer"], warnings: [] });
  const proposal = await until("the proposal push", () => pushed.find((x) => (b.decrypt(x.body) as { title: string }).title === "AI Director has a proposal"));
  assert.match((b.decrypt(proposal.body) as { body: string }).body, /“Café Opening”: Zoom in on the pour/);

  // The push service says the subscription is gone: it is forgotten.
  answer = 410;
  const second = jobs.create(project.id, "export", { width: 1080, height: 1920, useProxies: false, crf: 20, preset: "fast", audioBitrateK: 192 }, join(home, "out2.mp4"));
  jobs.claim(second.id);
  jobs.fail(second.id, "RENDER_FAILED", "ffmpeg exited");
  await until("the failure push", () => pushed.some((x) => (b.decrypt(x.body) as { title: string }).title === "Export failed"));
  await until("forgotten", () => m.status().notifications === 0);

  // A new pairing drops every phone's notifications.
  await p.send("push.subscribe", { endpoint, keys: b.keys });
  await until("subscribed again", () => m.status().notifications === 1);
  await m.rotate();
  assert.equal(m.status().notifications, 0);
});
