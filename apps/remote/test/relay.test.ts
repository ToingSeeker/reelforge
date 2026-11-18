// The relay that is deployed (server.mjs), tested in this process. No tsconfig covers apps/remote,
// so this file is checked by running it, not by tsc.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { deriveKeys } from "../../../packages/remote/src/keys.ts";

const { createRelay } = (await import(new URL("../server.mjs", import.meta.url).href)) as {
  createRelay(opts: { authHash: string; trustProxy?: boolean; maxTracked?: number }): Server;
};

const listen = (server: Server) =>
  new Promise<string>((resolve) => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)));

test('relay: the lockout cannot be sidestepped by sending a made-up x-forwarded-for', async (t: { after: (fn: () => unknown) => void }) => {
  const { authHash } = deriveKeys('yet-another-long-secret-for-lockout-test');
  const relays = [createRelay({ authHash }), createRelay({ authHash, trustProxy: true })];
  t.after(() => relays.forEach((relay) => (relay.close(), relay.closeAllConnections())));
  const attempt = (url: string, i: number) => fetch(`${url}/api/command`, { method: 'POST', headers: { authorization: 'Bearer wrong', 'x-forwarded-for': `203.0.113.${i}` }, body: '{}' }).then((r) => r.status);

  const direct = await listen(relays[0]);
  const statuses = [];
  for (let i = 0; i < 12; i++) statuses.push(await attempt(direct, i));
  assert.deepEqual(statuses.slice(0, 10), Array(10).fill(401));
  assert.deepEqual(statuses.slice(10), [429, 429], 'counted by the connection, whatever the header says');

  // Behind a proxy that sets the header itself, each caller is counted separately.
  const proxied = await listen(relays[1]);
  for (let i = 0; i < 12; i++) assert.equal(await attempt(proxied, i), 401);

  // A full table never drops a live record; addresses that do not fit are counted as one.
  const small = createRelay({ authHash, trustProxy: true, maxTracked: 3 });
  relays.push(small);
  const full = await listen(small);
  for (let n = 0; n < 9; n++) assert.equal(await attempt(full, 1), 401);
  for (let i = 2; i <= 3; i++) assert.equal(await attempt(full, i), 401);
  for (let i = 10; i < 20; i++) assert.equal(await attempt(full, i), 401);
  assert.equal(await attempt(full, 99), 429, 'the eleventh unknown address is refused');
  const { token } = deriveKeys('yet-another-long-secret-for-lockout-test');
  const owner = await fetch(`${full}/api/command`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': '203.0.113.200', 'content-type': 'application/json' }, body: '{}' });
  assert.notEqual(owner.status, 429, 'the right token from a new address still gets in');
  assert.notEqual(owner.status, 401);
  assert.equal(await attempt(full, 1), 401, 'the first address was not forgotten: this is its tenth failure');
  assert.equal(await attempt(full, 1), 429);
});

test('relay: wrong tokens are refused and locked out; a restarted relay is resynchronised', async (t: { after: (fn: () => unknown) => void }) => {
  const { token, authHash } = deriveKeys('another-long-secret-for-the-relay-test');
  const relay = createRelay({ authHash });
  const url = await listen(relay);
  t.after(() => {
    relay.close();
    relay.closeAllConnections();
  });
  const good = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

  assert.equal((await fetch(`${url}/healthz`)).status, 200);
  assert.equal((await fetch(`${url}/`)).status, 200);
  assert.equal((await fetch(`${url}/../server.mjs`)).status, 404);
  assert.equal((await fetch(`${url}/api/stream`)).status, 401);
  assert.equal((await fetch(`${url}/api/command`, { method: 'POST', headers: good, body: JSON.stringify({ c: 'x' }) })).status, 503, 'no Mac connected');

  // The log: a snapshot drops what came before it.
  const post = (events: unknown[]) => fetch(`${url}/agent/events`, { method: 'POST', headers: good, body: JSON.stringify({ events }) }).then((r) => r.json());
  await post([{ c: 'a' }, { c: 'b' }]);
  assert.deepEqual(await post([{ c: 'snap', snapshot: true }, { c: 'c' }]), { seq: 4 });
  // Collects what the stream sends in its first moments, then hangs up.
  const read = async (since: number) => {
    const abort = new AbortController();
    const res = await fetch(`${url}/api/stream?since=${since}`, { headers: good, signal: abort.signal });
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
  assert.deepEqual(await read(0), { reset: true, entries: ['3:snap', '4:c'] });
  assert.deepEqual(await read(3), { reset: false, entries: ['4:c'] });
  assert.deepEqual(await read(1), { reset: true, entries: ['3:snap', '4:c'] }, 'a phone that fell behind starts over from the snapshot');
  assert.deepEqual(await read(99), { reset: true, entries: ['3:snap', '4:c'] }, 'a phone ahead of a restarted relay starts over');

  // Ten wrong attempts (one was made above, without a token) lock the caller out — even with the right token afterwards.
  for (let i = 0; i < 9; i++) assert.equal((await fetch(`${url}/api/stream`, { headers: { authorization: 'Bearer wrong' } })).status, 401);
  assert.equal((await fetch(`${url}/api/stream`, { headers: good })).status, 429);

  assert.throws(() => createRelay({ authHash: 'short' }), /REELFORGE_REMOTE_AUTH/);
});

test('relay: file pieces are taken once, a request waits for a piece still on its way, and the store refuses more than it may hold', async (t: { after: (fn: () => unknown) => void }) => {
  const secret = 'test-secret-that-is-long-enough-123456';
  const { token } = deriveKeys(secret);
  const relay = createRelay({ authHash: deriveKeys(secret).authHash });
  const url = await listen(relay);
  t.after(() => (relay.close(), relay.closeAllConnections()));
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const put = (side: string, body: unknown) => fetch(`${url}/${side}/chunk`, { method: 'POST', headers, body: JSON.stringify(body) });
  const take = (side: string, id: string, n: number) => fetch(`${url}/${side}/chunk?id=${id}&n=${n}`, { headers });

  assert.equal((await put('api', { id: 'piece-test-1', n: 0, c: 'abc' })).status, 200);
  // A piece sent up waits for the Mac: asking for it from the phone's side finds nothing (the request is just held).
  await assert.rejects(fetch(`${url}/api/chunk?id=piece-test-1&n=0`, { headers, signal: AbortSignal.timeout(300) }), /abort|timeout/i);
  const first = await take('agent', 'piece-test-1', 0);
  assert.deepEqual([first.status, (await first.json()).c], [200, 'abc']);

  // Asked for before it arrives: the request is held and answered when it comes.
  const waiting = take('agent', 'piece-test-1', 1);
  await new Promise((r) => setTimeout(r, 100));
  await put('api', { id: 'piece-test-1', n: 1, c: 'def' });
  const second = await waiting;
  assert.deepEqual([second.status, (await second.json()).c], [200, 'def']);

  assert.equal((await put('api', { id: '../x', n: 0, c: 'abc' })).status, 400);
  assert.equal((await put('api', { id: 'piece-test-1', n: -1, c: 'abc' })).status, 400);
  assert.equal((await fetch(`${url}/agent/chunk?id=piece-test-1&n=0`)).status, 401, 'only with the token');

  // 40 MB may wait in one direction; past that the sender is told to wait (and the other direction is not affected).
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
  for (const file of ["/", "/app.js", "/crypto.js", "/pairing.js", "/vendor/jsQR.min.js", "/vendor/jsQR.LICENSE.txt", "/style.css", "/app.webmanifest", "/mark.svg", "/icon-192.png"]) {
    const res = await fetch(`${url}${file}`);
    assert.equal(res.status, 200, file);
    assert.match(res.headers.get("content-security-policy") ?? "", /default-src 'self'.*script-src 'self'/, file);
  }
  assert.match((await fetch(`${url}/`)).headers.get("content-type") ?? "", /text\/html/);
  for (const bad of ["/../server.mjs", "/%2e%2e/server.mjs", "/package.json", "/test/relay.test.ts"]) assert.equal((await fetch(`${url}${bad}`)).status, 404, bad);
  assert.equal((await fetch(`${url}/`, { method: "POST" })).status, 405);
});

test("phone app: a pasted pairing link or bare key yields the secret, anything else nothing", async () => {
  const { secretFromText } = (await import(new URL("../public/pairing.js", import.meta.url).href)) as {
    secretFromText: (text: unknown) => string | null;
  };
  const secret = "Ab3_-xY9Ab3_-xY9Ab3_-xY9Ab3_-xY9Ab3_-xY9Ab3";
  assert.equal(secretFromText(`https://forge-remote.example/#k=${secret}`), secret);
  assert.equal(secretFromText(`  https://forge-remote.example/#k=${secret}\n`), secret, "whitespace from the clipboard");
  assert.equal(secretFromText(`https://forge-remote.example/#x=1&k=${secret}`), secret);
  assert.equal(secretFromText(secret), secret, "just the key");
  for (const bad of ["", null, undefined, "hello", "https://forge-remote.example/", `#k=short`, `https://x/#k=${secret} extra`, `${secret}!`])
    assert.equal(secretFromText(bad), null, String(bad));
});

test("phone app: the vendored jsQR reads the Mac's pairing QR (qrcode-generator, level M) back to the key", async () => {
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
  const { secretFromText } = (await import(new URL("../public/pairing.js", import.meta.url).href)) as { secretFromText: (t: unknown) => string | null };
  const secret = "Zq0_-Yp9Zq0_-Yp9Zq0_-Yp9Zq0_-Yp9Zq0_-Yp9Zq0";
  const link = `https://forge-remote-production.up.railway.app/#k=${secret}`;
  const qr = qrcode(0, "M"); // as PhoneRemoteSettings.tsx draws it
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
  assert.equal(secretFromText(code!.data), secret);
});
