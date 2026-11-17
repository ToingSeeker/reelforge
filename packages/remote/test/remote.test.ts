import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, ProjectStore } from "@reelforge/core";
import { deriveKeys, normaliseUrl, RemoteManager, seal, unseal } from "@reelforge/remote";

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
    sealCommand: (cmd: Record<string, unknown>) => seal(key, cmd),
    post,
    send: (type: string, extra: Record<string, unknown> = {}) => post(seal(key, { id: crypto.randomUUID(), at: Date.now(), type, ...extra })),
    close: async () => {
      abort.abort();
      await done;
    },
  };
}

function setup(t: { after: (fn: () => unknown) => void }) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "reelforge-remote-")));
  const db = openDatabase(join(home, "reelforge.db"));
  const servers: Server[] = [];
  const managers: RemoteManager[] = [];
  const make = () => {
    const m = new RemoteManager({ db, dir: join(home, "remote"), version: "test", deviceName: "Test Mac", watchMs: 100 });
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
  return { home, db, make, relay };
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
