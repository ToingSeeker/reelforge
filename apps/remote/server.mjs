// ReelForge phone remote: the relay (deployed as the Railway project `forge-remote`).
// A zero-dependency mailbox: no database, nothing on disk.
//
// It sits between Macs and the phones paired with them, and serves the web app the phones open. It never
// sees what passes through: events, commands, queued instructions and file pieces are all sealed on the
// device that wrote them, with keys this server is never given.
//
// Who may do what:
//   - A Mac proves itself with a token whose SHA-256 is in REELFORGE_REMOTE_AUTH (comma-separated: one
//     relay can serve several Macs). Each Mac gets its own channel: log, queue, devices, files.
//   - A phone proves itself with its own device token. The relay knows only the hashes the Mac published
//     (POST /agent/devices) and forgets a phone the moment the Mac withdraws it (revocation).
//   - Pairing is the one unauthenticated exchange: a phone holding a one-time code posts a hello to the
//     Mac's open pairing slot and waits for the Mac's answer. The code itself never reaches this server.
//
//   Mac    →  POST /agent/events            sealed events, appended to the channel's log
//   Mac    ←  GET  /agent/stream            commands, queued instructions and pairing requests (SSE)
//   Mac    →  POST /agent/devices           the phones allowed in (token hashes)
//   Mac    →  POST|DELETE /agent/pairing    open / close a pairing slot;  POST /agent/pairing/answer
//   Mac    ↔  GET /agent/queue, POST /agent/queue/claim, POST /agent/queue/done
//   phone  ←  GET  /api/stream              the log since ?since=N, then live (SSE)
//   phone  →  POST /api/command             one sealed command for the Mac (Mac must be online)
//   phone  ↔  GET|POST /api/queue, PUT|DELETE /api/queue/<id>   instructions kept here until the Mac takes them
//   both   ↔  /api/blob, /agent/blob, /api/chunk, /agent/chunk  files, in sealed pieces
//   phone  →  POST /pair/hello, GET /pair/answer                  pairing (no token yet)
//
// Nothing is stored on disk. After a restart the Mac republishes its phones and a fresh snapshot; queued
// instructions are also kept on the phone that wrote them, which puts back any the relay lost.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8', '.ttf': 'font/ttf' };
const MAX_LOG_ENTRIES = 3000;
const MAX_LOG_BYTES = 12 * 1024 * 1024;
const MAX_BODY = 4 * 1024 * 1024;
const FAILURES_ALLOWED = 10;
const LOCKOUT_MS = 15 * 60 * 1000;
const MAX_TRACKED = 10_000; // addresses remembered for the lockout
const BLOB_TTL_MS = 10 * 60 * 1000;
const MAX_BLOB_BYTES = 24 * 1024 * 1024; // all files held at once, per Mac
const BLOB_ID = /^[A-Za-z0-9_-]{8,64}$/;
const CHUNK_TTL_MS = 10 * 60 * 1000;
const MAX_CHUNK_BYTES = 40 * 1024 * 1024; // pieces held at once, per direction, per Mac
const CHUNK_WAIT_MS = 25_000; // how long a request for a piece not yet here is held open
const MAX_CHUNKS = 100_000; // pieces in one file
const OVERFLOW = '(everyone else)';
const QUEUE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_QUEUE = 200; // instructions waiting, per Mac
const MAX_QUEUE_ITEM = 64 * 1024;
const MAX_QUEUE_TTL_MS = 7 * 24 * 3600 * 1000;
const DONE_KEPT_MS = 24 * 3600 * 1000; // a finished id is remembered this long, so a retry is not run twice
const MAX_DEVICES = 20;
const PAIR_LOOKUP = /^[ABCDEFGHJKMNPQRSTVWXYZ23456789]{4}$/;
const PAIR_MAX_TTL_MS = 15 * 60 * 1000;
const PAIR_WAIT_MS = 25_000;

const sha256hex = (text) => crypto.createHash('sha256').update(text).digest('hex');

/**
 * @param {{ authHash: string, trustProxy?: boolean, maxTracked?: number }} opts  authHash: one hex SHA-256
 *   per Mac, comma-separated
 * @returns {http.Server}
 */
export function createRelay({ authHash, trustProxy = false, maxTracked = MAX_TRACKED }) {
  const hashes = String(authHash ?? '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  if (hashes.length === 0 || !hashes.every((h) => /^[0-9a-f]{64}$/.test(h))) {
    throw new Error('REELFORGE_REMOTE_AUTH must be the 64-character value shown in ReelForge → Settings → Remote Access (several, comma-separated, for several Macs).');
  }

  /** One per Mac. */
  const channels = new Map(hashes.map((h) => [h, newChannel(h)]));
  /** Device token hash → { channel, deviceId }, rebuilt whenever a Mac publishes its phones. */
  const deviceIndex = new Map();
  const failures = new Map(); // ip → { count, until }

  function newChannel(hash) {
    return {
      hash,
      log: [], // { seq, c, snapshot, to } — sealed events from the Mac, oldest first
      logBytes: 0,
      seq: 0,
      agent: null, // the Mac's open stream
      lastSeen: null, // when the Mac's stream was last open (ms)
      phones: new Set(), // { res, deviceId }
      devices: null, // Map deviceId → tokenHash; null until the Mac has published since this relay started
      blobs: new Map(),
      pieces: { up: { held: new Map(), bytes: 0, waiting: new Map() }, down: { held: new Map(), bytes: 0, waiting: new Map() } },
      queue: new Map(), // id → { id, deviceId, projectId, createdAt, expiresAt, c, status, updatedAt }
      done: new Map(), // id → when it finished (ms)
      pairing: new Map(), // lookup → { expiresAt, hello, answer, waiting }
    };
  }

  // ── files ──────────────────────────────────────────────────────────────
  function keepBlob(ch, id, c) {
    ch.blobs.delete(id);
    ch.blobs.set(id, { c, at: Date.now() });
    let total = 0;
    for (const blob of ch.blobs.values()) total += blob.c.length;
    for (const [key, blob] of ch.blobs) {
      if (total <= MAX_BLOB_BYTES && Date.now() - blob.at < BLOB_TTL_MS) continue;
      total -= blob.c.length;
      ch.blobs.delete(key);
    }
  }

  function dropOld(box) {
    for (const [key, piece] of box.held) {
      if (Date.now() - piece.at < CHUNK_TTL_MS) continue;
      box.bytes -= piece.c.length;
      box.held.delete(key);
    }
  }

  /** False when too much is waiting already: the sender tries again once some of it has been taken. */
  function putPiece(box, key, c) {
    dropOld(box);
    const old = box.held.get(key);
    if (box.bytes - (old?.c.length ?? 0) + c.length > MAX_CHUNK_BYTES) return false;
    if (old) box.bytes -= old.c.length;
    box.held.set(key, { c, at: Date.now() });
    box.bytes += c.length;
    box.waiting.get(key)?.();
    return true;
  }

  function takePiece(box, key) {
    const piece = box.held.get(key);
    if (!piece) return null;
    box.held.delete(key);
    box.bytes -= piece.c.length;
    return piece.c;
  }

  /** Answers with the piece once it is here, or 204 after a while so the caller asks again. */
  function waitForPiece(box, key, req, res) {
    const c = takePiece(box, key);
    if (c) return json(res, 200, { c });
    if (box.waiting.has(key)) return json(res, 409, { error: 'already waiting for that piece' });
    const finish = (status) => {
      clearTimeout(timer);
      box.waiting.delete(key);
      if (status === 200) json(res, 200, { c: takePiece(box, key) });
      else if (!res.writableEnded) res.writeHead(204, { 'cache-control': 'no-store' }).end();
    };
    const timer = setTimeout(() => finish(204), CHUNK_WAIT_MS);
    box.waiting.set(key, () => finish(200));
    req.on('close', () => {
      if (box.waiting.get(key) && !res.writableEnded) {
        clearTimeout(timer);
        box.waiting.delete(key);
      }
    });
  }

  const pieceKey = (id, n) => (typeof id === 'string' && BLOB_ID.test(id) && Number.isInteger(n) && n >= 0 && n < MAX_CHUNKS ? `${id}:${n}` : null);

  // ── who is calling ─────────────────────────────────────────────────────
  // x-forwarded-for is whatever the caller sent unless a proxy in front rewrites it, so it is believed
  // only when told such a proxy exists (`trustProxy`). Railway's edge does: observed on a Railway service
  // (2026-09-14), a client-sent x-forwarded-for is dropped and the header becomes "<caller>, <internal hop>",
  // where the hop changes on every request. So the FIRST entry is the caller and cannot be forged, and the
  // last one must never be the key (each request would get a fresh lockout bucket). REELFORGE_TRUST_PROXY=1
  // is only safe behind a proxy that also replaces the header rather than appending to it.
  const ipOf = (req) => (trustProxy && String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim()) || req.socket.remoteAddress || '?';

  function failureKey(req) {
    let ip = ipOf(req);
    if (failures.size >= maxTracked && !failures.has(ip)) {
      const now = Date.now();
      for (const [key, value] of failures) if (value.until <= now) failures.delete(key);
      // Still full: a live record is never dropped to make room, or a flood of addresses could
      // erase a lockout. Addresses that do not fit are counted together instead.
      if (failures.size >= maxTracked) ip = OVERFLOW;
    }
    return ip;
  }

  const locked = (ip) => {
    const record = failures.get(ip);
    return Boolean(record && record.until > Date.now() && record.count >= FAILURES_ALLOWED);
  };

  function fail(ip) {
    const record = failures.get(ip);
    const next = record && record.until > Date.now() ? record : { count: 0, until: 0 };
    next.count += 1;
    next.until = Date.now() + LOCKOUT_MS;
    failures.set(ip, next);
  }

  /**
   * { role: 'agent', ch } | { role: 'device', ch, deviceId } | { role: 'locked' } | { role: 'waiting' } | { role: 'none' }.
   * A right token always gets in: tokens are 256-bit, so the lockout exists to slow down floods, and it
   * must never let a stranger who shares the owner's address (same Wi-Fi, carrier NAT) lock the owner out.
   */
  function whoIs(req) {
    const token = /^Bearer ([0-9a-f]{64})$/.exec(req.headers.authorization ?? '')?.[1] ?? '';
    const hash = token ? sha256hex(token) : '';
    if (hash && channels.has(hash)) return { role: 'agent', ch: channels.get(hash) };
    const device = hash ? deviceIndex.get(hash) : undefined;
    if (device) return { role: 'device', ch: device.channel, deviceId: device.deviceId };
    const ip = failureKey(req);
    if (locked(ip)) return { role: 'locked' };
    // A phone's token is unknown here until its Mac publishes its phones (after this relay restarted):
    // that phone is told to wait, not that it was unpaired. Not counted as a failure.
    if (hash && [...channels.values()].some((c) => c.devices === null)) return { role: 'waiting' };
    fail(ip);
    return { role: 'none' };
  }

  function rebuildDeviceIndex() {
    deviceIndex.clear();
    for (const ch of channels.values()) for (const [deviceId, tokenHash] of ch.devices ?? []) deviceIndex.set(tokenHash, { channel: ch, deviceId });
  }

  // ── HTTP helpers ───────────────────────────────────────────────────────
  const json = (res, status, body) => {
    if (res.writableEnded) return;
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_BODY) {
          reject(new Error('too large'));
          req.destroy();
        } else chunks.push(chunk);
      });
      req.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch {
          reject(new Error('not JSON'));
        }
      });
      req.on('error', reject);
    });
  }

  function openStream(res) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    // A stream error (a peer that vanished mid-write) must never take the whole relay down.
    res.on('error', () => {});
    res.write(':ok\n\n');
    // A comment line now and then keeps proxies from closing a quiet connection.
    const beat = setInterval(() => write(res, ':\n\n'), 20_000);
    res.on('close', () => clearInterval(beat));
  }
  // Writing to a stream that was ended or cut off is a no-op, not an 'error' event.
  const write = (res, text) => {
    if (res.writableEnded || res.destroyed) return;
    res.write(text);
  };
  // Cuts a stream off at once. end() would wait for a peer that stopped reading to
  // drain everything queued to it, and the stream would stay live meanwhile.
  const cutOff = (res) => {
    if (!res.destroyed) res.destroy();
  };
  const send = (res, event, data) => write(res, `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const toPhones = (ch, event, data) => {
    for (const phone of ch.phones) send(phone.res, event, data);
  };
  const agentStatus = (ch) => ({ online: ch.agent !== null, lastSeen: ch.agent ? Date.now() : ch.lastSeen });

  function append(ch, entry) {
    // A snapshot holds the whole state, so everything before it can go (except messages meant for one phone).
    if (entry.snapshot) {
      ch.log = ch.log.filter((e) => e.to);
      ch.logBytes = ch.log.reduce((n, e) => n + e.c.length, 0);
    }
    const item = { seq: ++ch.seq, c: entry.c, snapshot: Boolean(entry.snapshot), ...(typeof entry.to === 'string' ? { to: entry.to } : {}) };
    ch.log.push(item);
    ch.logBytes += item.c.length;
    while (ch.log.length > MAX_LOG_ENTRIES || ch.logBytes > MAX_LOG_BYTES) ch.logBytes -= ch.log.shift().c.length;
    for (const phone of ch.phones) if (!item.to || item.to === phone.deviceId) send(phone.res, 'entry', item);
  }

  // ── queue ──────────────────────────────────────────────────────────────
  const publicItem = ({ c, ...meta }) => meta;

  function sweepQueue(ch) {
    const now = Date.now();
    for (const [id, item] of ch.queue) {
      if (item.status === 'queued' && item.expiresAt <= now) {
        ch.queue.delete(id);
        toPhones(ch, 'queue', { id, status: 'expired' });
      }
    }
    for (const [id, at] of ch.done) if (now - at > DONE_KEPT_MS) ch.done.delete(id);
  }

  function queueChanged(ch, item) {
    toPhones(ch, 'queue', publicItem(item));
    if (ch.agent && item.status === 'queued') send(ch.agent, 'queue', item);
  }

  // ── static files ───────────────────────────────────────────────────────
  function serveFile(req, res, pathname) {
    const name = pathname === '/' ? '/index.html' : pathname;
    const file = path.join(PUBLIC, path.normalize(name));
    if (!file.startsWith(PUBLIC + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      return res.end('Not found');
    }
    res.writeHead(200, {
      'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream',
      'cache-control': 'no-cache',
      'content-security-policy': "default-src 'self'; connect-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; frame-src blob:; style-src 'self'; script-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'",
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'strict-transport-security': 'max-age=31536000',
      'permissions-policy': 'camera=(self), microphone=(), geolocation=()',
    });
    fs.createReadStream(file).pipe(res);
  }

  function findSlot(lookup) {
    for (const ch of channels.values()) {
      const slot = ch.pairing.get(lookup);
      if (slot && slot.expiresAt > Date.now()) return { ch, slot };
    }
    return null;
  }

  // ── routes ─────────────────────────────────────────────────────────────
  async function pair(req, res, pathname, searchParams) {
    const ip = failureKey(req);
    if (locked(ip)) return json(res, 429, { error: 'Too many wrong attempts. Try again in 15 minutes.' });
    if (req.method === 'POST' && pathname === '/pair/hello') {
      const body = await readBody(req);
      const found = typeof body.lookup === 'string' && PAIR_LOOKUP.test(body.lookup) ? findSlot(body.lookup) : null;
      // A slot takes one hello: a second phone (or a guess) can't race the first.
      if (!found || found.slot.hello) {
        fail(ip);
        return json(res, 404, { error: 'That pairing code isn’t open. Make a new one on your Mac.' });
      }
      if (!found.ch.agent) return json(res, 503, { error: 'Your Mac isn’t connected to the relay. Check it’s online, then try again.' });
      if (typeof body.msg !== 'object' || body.msg === null || JSON.stringify(body.msg).length > 4096) return json(res, 400, { error: 'bad pairing request' });
      found.slot.hello = body.msg;
      send(found.ch.agent, 'pair', { lookup: body.lookup, hello: body.msg });
      return json(res, 200, { ok: true });
    }
    if (req.method === 'GET' && pathname === '/pair/answer') {
      const lookup = searchParams.get('lookup') ?? '';
      const found = PAIR_LOOKUP.test(lookup) ? findSlot(lookup) : null;
      if (!found || !found.slot.hello) return json(res, 404, { error: 'That pairing has ended. Make a new code on your Mac.' });
      const { ch, slot } = found;
      const answer = () => {
        const a = slot.answer;
        ch.pairing.delete(lookup); // one answer, once
        json(res, 200, a);
      };
      if (slot.answer) return answer();
      const timer = setTimeout(() => {
        slot.waiting = null;
        if (!res.writableEnded) res.writeHead(204, { 'cache-control': 'no-store' }).end();
      }, PAIR_WAIT_MS);
      slot.waiting = () => (clearTimeout(timer), answer());
      req.on('close', () => clearTimeout(timer));
      return;
    }
    return json(res, 404, { error: 'not found' });
  }

  async function agentRoute(req, res, ch, pathname, searchParams) {
    if (req.method === 'GET' && pathname === '/agent/stream') {
      if (ch.agent) cutOff(ch.agent); // a newer connection from the Mac replaces the old one
      openStream(res);
      ch.agent = res;
      ch.lastSeen = Date.now();
      toPhones(ch, 'agent', agentStatus(ch));
      sweepQueue(ch);
      for (const item of ch.queue.values()) if (item.status === 'queued') send(res, 'queue', item);
      res.on('close', () => {
        if (ch.agent !== res) return;
        ch.agent = null;
        ch.lastSeen = Date.now();
        toPhones(ch, 'agent', agentStatus(ch));
      });
      return;
    }
    if (req.method === 'POST' && pathname === '/agent/events') {
      const body = await readBody(req);
      if (!Array.isArray(body.events) || body.events.some((e) => typeof e?.c !== 'string')) return json(res, 400, { error: 'bad events' });
      ch.lastSeen = Date.now();
      for (const entry of body.events) append(ch, entry);
      return json(res, 200, { seq: ch.seq });
    }
    if (req.method === 'POST' && pathname === '/agent/devices') {
      const body = await readBody(req);
      const list = body.devices;
      if (!Array.isArray(list) || list.length > MAX_DEVICES || list.some((d) => typeof d?.id !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(d.id) || !/^[0-9a-f]{64}$/.test(d.tokenHash ?? ''))) {
        return json(res, 400, { error: 'bad devices' });
      }
      ch.devices = new Map(list.map((d) => [d.id, d.tokenHash]));
      rebuildDeviceIndex();
      // A revoked phone is cut off now, not at its next request.
      for (const phone of [...ch.phones]) {
        if (ch.devices.has(phone.deviceId)) continue;
        ch.phones.delete(phone);
        cutOff(phone.res);
      }
      return json(res, 200, { ok: true, devices: ch.devices.size });
    }
    if (pathname === '/agent/pairing') {
      if (req.method === 'POST') {
        const body = await readBody(req);
        const ttl = Number(body.expiresAt) - Date.now();
        if (typeof body.lookup !== 'string' || !PAIR_LOOKUP.test(body.lookup) || !(ttl > 0 && ttl <= PAIR_MAX_TTL_MS)) return json(res, 400, { error: 'bad pairing slot' });
        if (findSlot(body.lookup) && !ch.pairing.has(body.lookup)) return json(res, 409, { error: 'that code is in use; make another' });
        for (const [lookup, slot] of ch.pairing) if (slot.expiresAt <= Date.now()) ch.pairing.delete(lookup);
        if (ch.pairing.size >= 3) return json(res, 429, { error: 'too many open pairing codes' });
        ch.pairing.set(body.lookup, { expiresAt: Number(body.expiresAt), hello: null, answer: null, waiting: null });
        return json(res, 200, { ok: true });
      }
      if (req.method === 'DELETE') {
        ch.pairing.delete(searchParams.get('lookup') ?? '');
        return json(res, 200, { ok: true });
      }
    }
    if (req.method === 'POST' && pathname === '/agent/pairing/answer') {
      const body = await readBody(req);
      const slot = ch.pairing.get(body.lookup ?? '');
      if (!slot || !slot.hello || slot.answer || typeof body.msg !== 'object' || body.msg === null) return json(res, 409, { error: 'no pairing request to answer' });
      slot.answer = body.msg;
      slot.waiting?.();
      return json(res, 200, { ok: true });
    }
    if (req.method === 'GET' && pathname === '/agent/queue') {
      sweepQueue(ch);
      return json(res, 200, { items: [...ch.queue.values()].filter((i) => i.status === 'queued') });
    }
    if (req.method === 'POST' && (pathname === '/agent/queue/claim' || pathname === '/agent/queue/done')) {
      const body = await readBody(req);
      const item = ch.queue.get(body.id ?? '');
      if (pathname === '/agent/queue/claim') {
        sweepQueue(ch);
        if (!item || item.status !== 'queued') return json(res, 409, { error: 'not waiting', status: item?.status ?? (ch.done.has(body.id) ? 'done' : 'gone') });
        item.status = 'accepted';
        item.updatedAt = Date.now();
        queueChanged(ch, item);
        return json(res, 200, { ok: true, item });
      }
      if (item) {
        ch.queue.delete(item.id);
        ch.done.set(item.id, Date.now());
        toPhones(ch, 'queue', { id: item.id, status: 'done' });
      }
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && pathname === '/agent/blob') {
      const body = await readBody(req);
      if (typeof body.id !== 'string' || !BLOB_ID.test(body.id) || typeof body.c !== 'string') return json(res, 400, { error: 'bad blob' });
      keepBlob(ch, body.id, body.c);
      return json(res, 200, { ok: true });
    }
    if (pathname === '/agent/chunk') return chunkRoute(req, res, ch, 'agent', searchParams);
    return json(res, 404, { error: 'not found' });
  }

  async function chunkRoute(req, res, ch, side, searchParams) {
    // 'up' carries phone → Mac, 'down' Mac → phone.
    if (req.method === 'POST') {
      const body = await readBody(req);
      const key = pieceKey(body.id, body.n);
      if (!key || typeof body.c !== 'string') return json(res, 400, { error: 'bad piece' });
      if (!putPiece(side === 'phone' ? ch.pieces.up : ch.pieces.down, key, body.c)) return json(res, 507, { error: 'busy', busy: true });
      return json(res, 200, { ok: true });
    }
    if (req.method === 'GET') {
      const key = pieceKey(searchParams.get('id'), Number(searchParams.get('n')));
      if (!key) return json(res, 400, { error: 'bad piece' });
      return waitForPiece(side === 'agent' ? ch.pieces.up : ch.pieces.down, key, req, res);
    }
    return json(res, 405, { error: 'method not allowed' });
  }

  async function deviceRoute(req, res, ch, deviceId, pathname, searchParams) {
    if (req.method === 'GET' && pathname === '/api/stream') {
      const since = Number(searchParams.get('since')) || 0;
      openStream(res);
      send(res, 'agent', agentStatus(ch));
      // The caller starts over when it has nothing yet, when its position is older than
      // what is kept, or when it is ahead of us (this server restarted and lost the log).
      const stale = ch.log.length > 0 && since < ch.log[0].seq - 1;
      const reset = since === 0 || stale || since > ch.seq;
      if (reset) send(res, 'reset', { seq: ch.seq });
      for (const entry of reset ? ch.log : ch.log.filter((e) => e.seq > since)) if (!entry.to || entry.to === deviceId) send(res, 'entry', entry);
      sweepQueue(ch);
      send(res, 'queue-list', { items: [...ch.queue.values()].filter((i) => i.deviceId === deviceId).map(publicItem) });
      const phone = { res, deviceId };
      ch.phones.add(phone);
      res.on('close', () => ch.phones.delete(phone));
      return;
    }
    if (req.method === 'POST' && pathname === '/api/command') {
      const body = await readBody(req);
      if (typeof body.c !== 'string') return json(res, 400, { error: 'missing c' });
      if (!ch.agent) return json(res, 503, { error: 'The Mac is not connected.', offline: true });
      send(ch.agent, 'command', { c: body.c, deviceId });
      return json(res, 200, { ok: true });
    }
    if (pathname === '/api/queue' && req.method === 'GET') {
      sweepQueue(ch);
      return json(res, 200, { items: [...ch.queue.values()].filter((i) => i.deviceId === deviceId).map(publicItem), done: [...ch.done.keys()] });
    }
    if (pathname === '/api/queue' && req.method === 'POST') {
      const body = await readBody(req);
      if (typeof body.id !== 'string' || !QUEUE_ID.test(body.id)) return json(res, 400, { error: 'bad id' });
      const existing = ch.queue.get(body.id);
      // The same id again (a retry after a dropped answer) is the same instruction: never a second one.
      if (existing) return json(res, existing.deviceId === deviceId ? 200 : 409, existing.deviceId === deviceId ? { item: publicItem(existing) } : { error: 'id in use' });
      if (ch.done.has(body.id)) return json(res, 200, { item: { id: body.id, status: 'done' } });
      const now = Date.now();
      const expiresAt = Number(body.expiresAt);
      if (typeof body.c !== 'string' || body.c.length > MAX_QUEUE_ITEM) return json(res, 400, { error: 'bad instruction' });
      if (typeof body.projectId !== 'string' || !QUEUE_ID.test(body.projectId)) return json(res, 400, { error: 'bad project' });
      if (!(expiresAt > now && expiresAt - now <= MAX_QUEUE_TTL_MS)) return json(res, 400, { error: 'bad expiry' });
      sweepQueue(ch);
      if (ch.queue.size >= MAX_QUEUE) return json(res, 507, { error: 'Too many instructions are waiting. Cancel some first.' });
      const item = { id: body.id, deviceId, projectId: body.projectId, createdAt: Number(body.createdAt) || now, expiresAt, c: body.c, status: 'queued', updatedAt: now };
      ch.queue.set(item.id, item);
      queueChanged(ch, item);
      return json(res, 201, { item: publicItem(item) });
    }
    const one = /^\/api\/queue\/([0-9a-f-]{36})$/i.exec(pathname);
    if (one) {
      sweepQueue(ch);
      const item = ch.queue.get(one[1]);
      if (!item || item.deviceId !== deviceId) return json(res, 404, { error: 'That instruction is no longer waiting.', status: ch.done.has(one[1]) ? 'done' : 'gone' });
      // Only while the Mac hasn't taken it: after that, it is the Mac's to finish or cancel.
      if (item.status !== 'queued') return json(res, 409, { error: 'Your Mac has already taken this instruction.', status: item.status });
      if (req.method === 'DELETE') {
        ch.queue.delete(item.id);
        toPhones(ch, 'queue', { id: item.id, status: 'cancelled' });
        return json(res, 200, { ok: true });
      }
      if (req.method === 'PUT') {
        const body = await readBody(req);
        if (typeof body.c !== 'string' || body.c.length > MAX_QUEUE_ITEM) return json(res, 400, { error: 'bad instruction' });
        item.c = body.c;
        item.updatedAt = Date.now();
        queueChanged(ch, item);
        return json(res, 200, { item: publicItem(item) });
      }
    }
    if (req.method === 'GET' && pathname === '/api/blob') {
      const blob = ch.blobs.get(searchParams.get('id') ?? '');
      if (!blob || Date.now() - blob.at >= BLOB_TTL_MS) return json(res, 404, { error: 'That file is no longer here. Ask for it again.' });
      return json(res, 200, { c: blob.c });
    }
    if (pathname === '/api/chunk') return chunkRoute(req, res, ch, 'phone', searchParams);
    return json(res, 404, { error: 'not found' });
  }

  async function handle(req, res) {
    let url;
    try {
      url = new URL(req.url, 'http://relay');
    } catch {
      // Node's HTTP parser accepts some targets ('//a:b/') that the URL parser refuses.
      return json(res, 400, { error: 'bad request' });
    }
    const { pathname, searchParams } = url;
    try {
      if (pathname === '/healthz') return json(res, 200, { ok: true });
      if (pathname.startsWith('/pair/')) return await pair(req, res, pathname, searchParams);
      if (!pathname.startsWith('/api/') && !pathname.startsWith('/agent/')) {
        if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'method not allowed' });
        return serveFile(req, res, pathname);
      }
      const who = whoIs(req);
      if (who.role === 'locked') return json(res, 429, { error: 'Too many wrong attempts. Try again in 15 minutes.' });
      if (who.role === 'waiting') return json(res, 503, { error: 'The relay restarted and your Mac hasn’t reconnected yet.', waiting: true });
      if (pathname.startsWith('/agent/')) {
        if (who.role !== 'agent') return json(res, 401, { error: 'unauthorised' });
        return await agentRoute(req, res, who.ch, pathname, searchParams);
      }
      if (who.role !== 'device') return json(res, 401, { error: 'unauthorised' });
      return await deviceRoute(req, res, who.ch, who.deviceId, pathname, searchParams);
    } catch (err) {
      return json(res, 400, { error: err.message });
    }
  }

  return http.createServer((req, res) => {
    // Nothing one request does may end the process every Mac and phone shares.
    handle(req, res).catch(() => {
      try {
        if (!res.headersSent) json(res, 500, { error: 'server error' });
        else cutOff(res);
      } catch {
        /* the socket is already gone */
      }
    });
  });
}

// Started directly (on Railway): read the settings from the environment.
if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  const port = Number(process.env.PORT) || 8787;
  try {
    createRelay({ authHash: process.env.REELFORGE_REMOTE_AUTH, trustProxy: Boolean(process.env.RAILWAY_ENVIRONMENT) || process.env.REELFORGE_TRUST_PROXY === '1' }).listen(port, '0.0.0.0', () => console.log(`ReelForge remote relay listening on ${port}`));
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
