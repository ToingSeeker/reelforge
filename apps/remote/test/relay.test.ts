// The relay that is deployed (server.mjs), tested in this process. No tsconfig covers apps/remote,
// so this file is checked by running it, not by tsc.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { deriveDeviceKeys, deriveKeys } from "../../../packages/remote/src/keys.ts";

const { createRelay } = (await import(new URL("../server.mjs", import.meta.url).href)) as {
  createRelay(opts: { authHash: string; trustProxy?: boolean; maxTracked?: number }): Server;
};

const listen = (server: Server) =>
  new Promise<string>((resolve) => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)));

/** A relay with one Mac and one phone the Mac published. */
async function withPhone(t: { after: (fn: () => unknown) => void }, opts: { trustProxy?: boolean; maxTracked?: number } = {}) {
  const mac = deriveKeys(`mac-secret-${Math.random()}-long-enough`);
  const dev = deriveDeviceKeys(`device-secret-${Math.random()}-long-enough`);
  const relay = createRelay({ authHash: mac.authHash, ...opts });
  const url = await listen(relay);
  t.after(() => (relay.close(), relay.closeAllConnections()));
  const agent = { authorization: `Bearer ${mac.token}`, 'content-type': 'application/json' };
  const phone = { authorization: `Bearer ${dev.token}`, 'content-type': 'application/json' };
  const publish = () => fetch(`${url}/agent/devices`, { method: 'POST', headers: agent, body: JSON.stringify({ devices: [{ id: 'phone-0001', tokenHash: dev.tokenHash }] }) });
  return { relay, url, agent, phone, publish, mac, dev };
}

test('relay: a right token always gets in; wrong ones are locked out per address, which a forged header cannot dodge', async (t: { after: (fn: () => unknown) => void }) => {
  const attempt = (url: string, i: number, token = 'f'.repeat(64)) => fetch(`${url}/api/command`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': `203.0.113.${i}` }, body: '{}' }).then((r) => r.status);
  const direct = await withPhone(t);
  assert.equal((await direct.publish()).status, 200);
  const statuses = [];
  for (let i = 0; i < 12; i++) statuses.push(await attempt(direct.url, i));
  assert.deepEqual(statuses.slice(0, 10), Array(10).fill(401));
  assert.deepEqual(statuses.slice(10), [429, 429], 'counted by the connection, whatever the header says');
  // The owner shares that address (same Wi-Fi, carrier NAT): still gets in.
  assert.equal((await fetch(`${direct.url}/api/queue`, { headers: direct.phone })).status, 200, 'a locked-out address does not lock out the right token');
  assert.equal((await fetch(`${direct.url}/agent/queue`, { headers: direct.agent })).status, 200, 'nor the Mac');

  // Behind a proxy that sets the header itself, each caller is counted separately.
  const proxied = await withPhone(t, { trustProxy: true });
  await proxied.publish();
  for (let i = 0; i < 12; i++) assert.equal(await attempt(proxied.url, i), 401);

  // A full table never drops a live record; addresses that do not fit are counted as one.
  const small = await withPhone(t, { trustProxy: true, maxTracked: 3 });
  await small.publish();
  for (let n = 0; n < 9; n++) assert.equal(await attempt(small.url, 1), 401);
  for (let i = 2; i <= 3; i++) assert.equal(await attempt(small.url, i), 401);
  for (let i = 10; i < 20; i++) assert.equal(await attempt(small.url, i), 401);
  assert.equal(await attempt(small.url, 99), 429, 'the eleventh unknown address is refused');
  assert.equal(await attempt(small.url, 1), 401, 'the first address was not forgotten: this is its tenth failure');
  assert.equal(await attempt(small.url, 1), 429);
  assert.throws(() => createRelay({ authHash: 'short' }), /REELFORGE_REMOTE_AUTH/);
});

test('relay: roles are separate; phones get in only once the Mac publishes them, and are cut off when withdrawn', async (t: { after: (fn: () => unknown) => void }) => {
  const { url, agent, phone, publish } = await withPhone(t);
  assert.equal((await fetch(`${url}/healthz`)).status, 200);
  // Before the Mac has said who its phones are (relay just restarted), a phone is told to wait, not refused.
  const early = await fetch(`${url}/api/queue`, { headers: phone });
  assert.equal(early.status, 503);
  assert.equal((await early.json()).waiting, true);
  await publish();
  assert.equal((await fetch(`${url}/api/queue`, { headers: phone })).status, 200);
  assert.equal((await fetch(`${url}/agent/queue`, { headers: phone })).status, 401, 'a phone is not the Mac');
  assert.equal((await fetch(`${url}/api/queue`, { headers: agent })).status, 401, 'the Mac is not a phone');
  assert.equal((await fetch(`${url}/api/command`, { method: 'POST', headers: phone, body: JSON.stringify({ c: 'x' }) })).status, 503, 'no Mac connected');

  // The log: a snapshot drops what came before it (except messages for one phone); a phone sees only its own.
  const post = (events: unknown[]) => fetch(`${url}/agent/events`, { method: 'POST', headers: agent, body: JSON.stringify({ events }) }).then((r) => r.json());
  await post([{ c: 'a' }, { c: 'mine', to: 'phone-0001' }, { c: 'other', to: 'phone-9999' }]);
  assert.deepEqual(await post([{ c: 'snap', snapshot: true }, { c: 'c' }]), { seq: 5 });
  const read = async (since: number) => {
    const abort = new AbortController();
    const res = await fetch(`${url}/api/stream?since=${since}`, { headers: phone, signal: abort.signal });
    let text = '';
    const reader = res.body!.getReader();
    const pump = (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          text += new TextDecoder().decode(value);
        }
      } catch {}
    })();
    await new Promise((r) => setTimeout(r, 150));
    abort.abort();
    await pump;
    return { reset: text.includes('event: reset'), entries: [...text.matchAll(/"seq":(\d+),"c":"([^"]+)"/g)].map((m) => `${m[1]}:${m[2]}`) };
  };
  assert.deepEqual(await read(0), { reset: true, entries: ['2:mine', '4:snap', '5:c'] });
  assert.deepEqual(await read(4), { reset: false, entries: ['5:c'] });
  assert.deepEqual(await read(99), { reset: true, entries: ['2:mine', '4:snap', '5:c'] }, 'a phone ahead of a restarted relay starts over');

  // Withdrawn: refused from now on.
  await fetch(`${url}/agent/devices`, { method: 'POST', headers: agent, body: JSON.stringify({ devices: [] }) });
  assert.equal((await fetch(`${url}/api/queue`, { headers: phone })).status, 401);
});

test('relay: the queue keeps an instruction until the Mac claims it once; the phone may edit or cancel it before', async (t: { after: (fn: () => unknown) => void }) => {
  const { url, agent, phone, publish } = await withPhone(t);
  await publish();
  const id = crypto.randomUUID();
  const projectId = crypto.randomUUID();
  const now = Date.now();
  const body = { id, projectId, createdAt: now, expiresAt: now + 60_000, c: 'sealed-1' };
  const q = (method: string, path: string, b?: unknown, h = phone) => fetch(`${url}${path}`, { method, headers: h, body: b === undefined ? undefined : JSON.stringify(b) });
  assert.equal((await q('POST', '/api/queue', body)).status, 201);
  assert.equal((await q('POST', '/api/queue', body)).status, 200, 'a retry with the same id is the same instruction');
  assert.equal((await q('POST', '/api/queue', { ...body, id: crypto.randomUUID(), expiresAt: now + 30 * 24 * 3600_000 })).status, 400, 'expiry is bounded');
  assert.equal((await q('PUT', `/api/queue/${id}`, { c: 'sealed-2' })).status, 200);
  const waiting = (await (await q('GET', '/agent/queue', undefined, agent)).json()).items;
  assert.deepEqual(waiting.map((i: { c: string; deviceId: string }) => [i.c, i.deviceId]), [['sealed-2', 'phone-0001']]);
  const claims = await Promise.all([q('POST', '/agent/queue/claim', { id }, agent), q('POST', '/agent/queue/claim', { id }, agent)]);
  assert.deepEqual(claims.map((r) => r.status).sort(), [200, 409], 'claimed exactly once');
  assert.equal((await q('DELETE', `/api/queue/${id}`)).status, 409, 'taken: no longer for the phone to cancel');
  assert.equal((await q('POST', '/agent/queue/done', { id }, agent)).status, 200);
  assert.equal((await q('POST', '/api/queue', body)).status, 200, 'posting a finished id again does not queue it again');
  assert.equal((await (await q('GET', '/agent/queue', undefined, agent)).json()).items.length, 0);
  const other = crypto.randomUUID();
  await q('POST', '/api/queue', { ...body, id: other });
  assert.equal((await q('DELETE', `/api/queue/${other}`)).status, 200);
  assert.equal((await (await q('GET', '/agent/queue', undefined, agent)).json()).items.length, 0);
});

test('relay: pairing slots take one hello and give one answer; the code never reaches the relay', async (t: { after: (fn: () => unknown) => void }) => {
  const { url, agent } = await withPhone(t);
  const hello = (lookup: string) => fetch(`${url}/pair/hello`, { method: 'POST', body: JSON.stringify({ lookup, msg: { pub: 'x', name: 'n', proof: 'p' } }) });
  assert.equal((await hello('ABCD')).status, 404, 'no slot open');
  assert.equal((await fetch(`${url}/agent/pairing`, { method: 'POST', headers: agent, body: JSON.stringify({ lookup: 'ABCD', expiresAt: Date.now() + 60_000 }) })).status, 200);
  assert.equal((await hello('ABCD')).status, 503, 'the Mac must be connected to hear it');
  const abort = new AbortController();
  const stream = await fetch(`${url}/agent/stream`, { headers: agent, signal: abort.signal });
  t.after(() => abort.abort());
  assert.equal(stream.status, 200);
  assert.equal((await hello('ABCD')).status, 200);
  assert.equal((await hello('ABCD')).status, 404, 'one hello per code');
  const waiting = fetch(`${url}/pair/answer?lookup=ABCD`);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal((await fetch(`${url}/agent/pairing/answer`, { method: 'POST', headers: agent, body: JSON.stringify({ lookup: 'ABCD', msg: { box: 'b' } }) })).status, 200);
  const answered = await waiting;
  assert.deepEqual([answered.status, await answered.json()], [200, { box: 'b' }]);
  assert.equal((await fetch(`${url}/pair/answer?lookup=ABCD`)).status, 404, 'answered once');
});

test('relay: file pieces are taken once, a request waits for a piece still on its way, and the store refuses more than it may hold', async (t: { after: (fn: () => unknown) => void }) => {
  const { url, agent, phone, publish } = await withPhone(t);
  await publish();
  const put = (side: string, body: unknown) => fetch(`${url}/${side}/chunk`, { method: 'POST', headers: side === 'api' ? phone : agent, body: JSON.stringify(body) });
  const take = (side: string, id: string, n: number) => fetch(`${url}/${side}/chunk?id=${id}&n=${n}`, { headers: side === 'api' ? phone : agent });

  assert.equal((await put('api', { id: 'piece-test-1', n: 0, c: 'abc' })).status, 200);
  // A piece sent up waits for the Mac: asking for it from the phone's side finds nothing (the request is just held).
  await assert.rejects(fetch(`${url}/api/chunk?id=piece-test-1&n=0`, { headers: phone, signal: AbortSignal.timeout(300) }), /abort|timeout/i);
  const first = await take('agent', 'piece-test-1', 0);
  assert.deepEqual([first.status, (await first.json()).c], [200, 'abc']);

  const waiting = take('agent', 'piece-test-1', 1);
  await new Promise((r) => setTimeout(r, 100));
  await put('api', { id: 'piece-test-1', n: 1, c: 'def' });
  const second = await waiting;
  assert.deepEqual([second.status, (await second.json()).c], [200, 'def']);

  assert.equal((await put('api', { id: '../x', n: 0, c: 'abc' })).status, 400);
  assert.equal((await put('api', { id: 'piece-test-1', n: -1, c: 'abc' })).status, 400);
  assert.equal((await fetch(`${url}/agent/chunk?id=piece-test-1&n=0`)).status, 401, 'only with the token');

  const big = 'a'.repeat(3_500_000);
  let n = 0;
  while ((await put('agent', { id: 'piece-test-2', n, c: big })).status === 200) n += 1;
  assert.equal(n, 11);
  assert.equal((await put('agent', { id: 'piece-test-2', n, c: big })).status, 507);
  assert.equal((await put('api', { id: 'piece-test-3', n: 0, c: big })).status, 200);
  assert.equal((await take('api', 'piece-test-2', 0)).status, 200);
  assert.equal((await put('agent', { id: 'piece-test-2', n, c: big })).status, 200, 'room again once the phone has taken a piece');
});

test("relay: the phone app is served with a strict CSP, and nothing outside public/ is", async (t: { after: (fn: () => unknown) => void }) => {
  const relay = createRelay({ authHash: deriveKeys("a-long-secret-for-the-static-files-test").authHash });
  const url = await listen(relay);
  t.after(() => (relay.close(), relay.closeAllConnections()));
  for (const file of ["/", "/app.js", "/core.js", "/ui.js", "/crypto.js", "/pairing.js", "/vendor/jsQR.min.js", "/vendor/jsQR.LICENSE.txt", "/style.css", "/app.webmanifest", "/mark.svg", "/icon-192.png"]) {
    const res = await fetch(`${url}${file}`);
    assert.equal(res.status, 200, file);
    assert.match(res.headers.get("content-security-policy") ?? "", /default-src 'self'.*script-src 'self'/, file);
  }
  assert.match((await fetch(`${url}/`)).headers.get("content-type") ?? "", /text\/html/);
  for (const bad of ["/../server.mjs", "/%2e%2e/server.mjs", "/package.json", "/test/relay.test.ts"]) assert.equal((await fetch(`${url}${bad}`)).status, 404, bad);
  assert.equal((await fetch(`${url}/`, { method: "POST" })).status, 405);
});

test("phone app: a scanned or pasted pairing link, or the code typed by hand, yields the code; anything else nothing", async () => {
  const { codeFromText } = (await import(new URL("../public/pairing.js", import.meta.url).href)) as { codeFromText: (text: unknown) => string | null };
  const code = "ABCD-EFGH-JKMN-PQRS";
  assert.equal(codeFromText(`https://forge-remote.example/#pair=${code}`), "ABCDEFGHJKMNPQRS");
  assert.equal(codeFromText(`  https://forge-remote.example/#pair=${code}\n`), "ABCDEFGHJKMNPQRS", "whitespace from the clipboard");
  assert.equal(codeFromText("abcd efgh jkmn pqrs"), "ABCDEFGHJKMNPQRS", "typed, any case, spaces");
  assert.equal(codeFromText("ABCDEFGHJKMNPQRS"), "ABCDEFGHJKMNPQRS");
  for (const bad of ["", null, undefined, "hello", "https://forge-remote.example/", "ABCD-EFGH-JKMN-PQR", "ABCD-EFGH-JKMN-PQR0", "#k=Ab3_-xY9Ab3_-xY9Ab3_-xY9Ab3_-xY9Ab3_-xY9Ab3"])
    assert.equal(codeFromText(bad), null, String(bad));
});

test("phone app: the vendored jsQR reads the Mac's pairing QR (qrcode-generator, level M) back to the code", async () => {
  const { readFileSync } = await import("node:fs");
  const { runInNewContext } = await import("node:vm");
  const { createRequire } = await import("node:module");
  // The phone loads it with a <script> tag, so it attaches to `self`; do the same here.
  const sandbox: { self: { jsQR?: (d: Uint8ClampedArray, w: number, h: number, o?: object) => { data: string } | null } } = { self: {} };
  runInNewContext(readFileSync(new URL("../public/vendor/jsQR.min.js", import.meta.url), "utf8"), sandbox);
  const jsQR = sandbox.self.jsQR!;
  assert.equal(typeof jsQR, "function");

  const qrcode = createRequire(new URL("../../desktop/package.json", import.meta.url))("qrcode-generator") as (t: number, l: string) => {
    addData(s: string): void; make(): void; getModuleCount(): number; isDark(r: number, c: number): boolean;
  };
  const { codeFromText } = (await import(new URL("../public/pairing.js", import.meta.url).href)) as { codeFromText: (t: unknown) => string | null };
  const link = "https://forge-remote-production.up.railway.app/#pair=K7QM-9XF2-PGWZ-4HTR";
  const qr = qrcode(0, "M"); // as the desktop's Remote Access settings draw it
  qr.addData(link);
  qr.make();
  // Render it like a camera would see the screen: 6 px per module, a 4-module quiet zone.
  const n = qr.getModuleCount(), px = 6, size = (n + 8) * px;
  const rgba = new Uint8ClampedArray(size * size * 4).fill(255);
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
    if (!qr.isDark(r, c)) continue;
    for (let y = 0; y < px; y++) for (let x = 0; x < px; x++) {
      const i = (((r + 4) * px + y) * size + (c + 4) * px + x) * 4;
      rgba[i] = rgba[i + 1] = rgba[i + 2] = 0;
    }
  }
  const code = jsQR(rgba, size, size, { inversionAttempts: "attemptBoth" });
  assert.equal(code?.data, link);
  assert.equal(codeFromText(code!.data), "K7QM9XF2PGWZ4HTR");
});
