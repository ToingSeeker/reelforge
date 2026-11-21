// ReelForge Remote: state, storage and the connection to the relay. No DOM here (app.js draws).
//
// What lives where on the phone:
//   localStorage 'rf.remote.v2'  pairings (one per Mac: device id + secret + broadcast key), the active Mac,
//                                last project, drafts, instructions not yet handed to the relay, cached
//                                snapshots and project details (so the app opens with something offline)
//   Cache Storage 'rf-media'     posters and the last preview video per project
//
// Nothing here is sent anywhere but the relay that served this page, and everything sent is sealed with a
// key the relay never has (crypto.js).
import { deriveDeviceKeys, importBroadcastKey, pairPhone, seal, sealBytes, unseal, unsealBytes } from './crypto.js';

const STORE_KEY = 'rf.remote.v2';
const MEDIA_CACHE = 'rf-media';
const QUEUE_TTL_MS = 24 * 3600 * 1000;
const PIECE_BYTES = 1024 * 1024;

// ── persisted state ─────────────────────────────────────────────────────────
function load() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY) ?? '{}');
    return {
      pairings: Array.isArray(raw.pairings) ? raw.pairings : [],
      active: typeof raw.active === 'string' ? raw.active : null,
      macs: raw.macs && typeof raw.macs === 'object' ? raw.macs : {},
      drafts: raw.drafts && typeof raw.drafts === 'object' ? raw.drafts : {},
      outbox: Array.isArray(raw.outbox) ? raw.outbox : [],
      prefs: { notify: { exports: true, proposals: true, failures: true }, model: {}, askedNotify: false, ...(raw.prefs ?? {}) },
      edits: raw.edits && typeof raw.edits === 'object' ? raw.edits : {},
    };
  } catch {
    return { pairings: [], active: null, macs: {}, drafts: {}, outbox: [], prefs: { notify: { exports: true, proposals: true, failures: true }, model: {}, askedNotify: false }, edits: {} };
  }
}

export const saved = load();
let saveTimer = 0;
function write() {
  saveTimer = 0;
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(saved));
  } catch {
    // full: drop cached details first, they come back from the Mac
    for (const m of Object.values(saved.macs)) m.details = {};
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(saved));
    } catch {}
  }
}
export function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(write, 150);
}
/** Writes now if a save is waiting: the page may be about to go (reload, app switch, closed tab). */
export function persistNow() {
  if (!saveTimer) return;
  clearTimeout(saveTimer);
  write();
}
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', persistNow);
  document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && persistNow());
}

/** Cached data for one Mac (snapshot, details, last project), created on first use. */
export function macCache(macId) {
  saved.macs[macId] ??= { snapshot: null, syncedAt: null, details: {}, lastProject: null, lastSeen: null };
  return saved.macs[macId];
}

export const activePairing = () => saved.pairings.find((p) => p.macId === saved.active) ?? saved.pairings[0] ?? null;

// ── live state (not persisted) ──────────────────────────────────────────────
export const live = {
  /** Our stream to the relay: 'connecting' | 'connected' | 'reconnecting' | 'disconnected'. */
  transport: 'connecting',
  /** The Mac's stream to the relay, as the relay tells us. */
  agentOnline: false,
  /** The relay restarted and the Mac hasn't republished its phones yet. */
  relayWaiting: false,
  /** This phone's pairing was withdrawn by the Mac (or never existed here). */
  revoked: false,
  locked: false,
  /** The Mac said it stopped on purpose (Stop Engine & Disconnect). Cleared when it comes back. */
  stoppedAt: null,
  rtt: null,
  since: 0,
  /** Queue items as the relay reports them, by id: { status, ... }. */
  relayQueue: new Map(),
  /** Answers to commands sent from this page: id → event. */
  replies: new Map(),
  aiOptions: new Map(),
  exportOptions: new Map(),
  posters: new Map(), // projectId → { key, url }
  previews: new Map(), // projectId → { jobId, revision, url, updatedAt, state: 'loading'|'ready'|'failed', progress }
  downloads: new Map(), // jobId → { state, progress, url, name, size, error }
  uploads: new Map(), // uploadId → { name, progress, state, projectId, error }
  queueEvents: new Map(), // queue id → last event from the Mac
  activity: [], // { at, projectId, text } technical updates, grouped in the conversation
};

const listeners = new Set();
let notifyQueued = false;
/** Something changed: redraw (batched to one frame). */
export function changed() {
  if (notifyQueued) return;
  notifyQueued = true;
  requestAnimationFrame(() => {
    notifyQueued = false;
    for (const fn of listeners) fn();
  });
}
export const onChange = (fn) => listeners.add(fn);

const toasts = new Set();
/** An in-app notice (toasts stack nowhere: the newest replaces the last). */
export function notice(text, kind = 'info') {
  for (const fn of toasts) fn(text, kind);
}
export const onNotice = (fn) => toasts.add(fn);

// ── keys for the active pairing ─────────────────────────────────────────────
let keys = null; // { token, key, broadcast, pairing }

async function keysFor(pairing) {
  if (keys?.pairing === pairing) return keys;
  const { token, key } = await deriveDeviceKeys(pairing.deviceSecret);
  keys = { token, key, broadcast: await importBroadcastKey(pairing.broadcastKey), pairing };
  return keys;
}

const auth = () => ({ authorization: `Bearer ${keys.token}`, 'content-type': 'application/json' });

// ── derived status (what the header says) ───────────────────────────────────
/**
 * Transport, engine availability and editor kept apart, as the UI shows them:
 *   engine: 'ready' | 'busy' | 'stopped' | 'unavailable' | 'unknown'
 * A lost connection is never reported as the Mac sleeping or off: we don't know why it's gone.
 */
export function status() {
  const p = activePairing();
  const cache = p ? macCache(p.macId) : null;
  const snap = cache?.snapshot;
  let engine = 'unknown';
  if (live.transport === 'connected') {
    if (live.agentOnline) engine = snap?.engine?.state === 'busy' ? 'busy' : 'ready';
    else engine = live.stoppedAt ? 'stopped' : 'unavailable';
  }
  return {
    transport: live.transport,
    engine,
    editor: live.agentOnline ? (snap?.engine?.editor ?? 'unknown') : 'unknown',
    background: snap?.engine?.background ?? null,
    lastSeen: cache?.lastSeen ?? null,
    macName: p?.macName ?? 'Mac',
    remoteReady: snap?.engine?.remoteReady ?? null,
    live: live.transport === 'connected' && live.agentOnline,
  };
}

// ── pairing ─────────────────────────────────────────────────────────────────
/** Step 1–2: send the hello for this code; resolves with the Mac's answer, opened (not yet stored). */
export async function startPairing(code) {
  const deviceName = guessDeviceName();
  const ph = await pairPhone(code, deviceName);
  const res = await fetch('/pair/hello', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ lookup: ph.lookup, msg: ph.hello }) });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `The relay answered ${res.status}.`);
  const end = Date.now() + 60_000;
  while (Date.now() < end) {
    const a = await fetch(`/pair/answer?lookup=${ph.lookup}`, { cache: 'no-store' });
    if (a.status === 204) continue;
    if (!a.ok) throw new Error((await a.json().catch(() => ({}))).error ?? 'The pairing ended. Make a new code on your Mac.');
    return { payload: await ph.open(await a.json()), deviceName };
  }
  throw new Error('Your Mac didn’t answer. Check it’s online and the code is still showing, then try again.');
}

/** Step 3: the user confirmed. Store the pairing, make it active and say hello (the Mac marks it confirmed). */
export async function confirmPairing({ payload, deviceName }) {
  const pairing = {
    macId: payload.macId,
    macName: payload.macName,
    deviceId: payload.deviceId,
    deviceSecret: payload.deviceSecret,
    broadcastKey: payload.broadcastKey,
    deviceName,
    pairedAt: Date.now(),
  };
  saved.pairings = [...saved.pairings.filter((p) => p.macId !== pairing.macId), pairing];
  saved.active = pairing.macId;
  persist();
  await connect();
  const end = Date.now() + 20_000;
  while (Date.now() < end && !live.agentOnline) await sleep(250);
  return command('device.hello', { name: deviceName });
}

export async function forgetPairing(macId) {
  const p = saved.pairings.find((x) => x.macId === macId);
  if (!p) return;
  if (p === activePairing() && live.agentOnline) await command('device.forget').catch(() => false);
  saved.pairings = saved.pairings.filter((x) => x.macId !== macId);
  delete saved.macs[macId];
  saved.outbox = saved.outbox.filter((x) => x.macId !== macId);
  if (saved.active === macId) saved.active = saved.pairings[0]?.macId ?? null;
  persist();
  await connect();
}

export async function switchMac(macId) {
  if (saved.active === macId) return;
  saved.active = macId;
  persist();
  await connect();
}

function guessDeviceName() {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Android/.test(ua)) return 'Android phone';
  return 'Phone';
}

// ── the stream ──────────────────────────────────────────────────────────────
let generation = 0;
let abort = null;
let everConnected = false;
let lostAt = 0;
let lastRestoredNotice = 0;

/** (Re)start the stream for the active pairing. Retries with backoff until it works. */
export async function connect() {
  const g = ++generation;
  abort?.abort();
  live.relayQueue.clear();
  live.replies.clear();
  live.since = 0;
  live.revoked = false;
  live.agentOnline = false;
  const p = activePairing();
  if (!p) {
    live.transport = 'disconnected';
    return changed();
  }
  await keysFor(p);
  live.transport = 'connecting';
  changed();
  void run(g);
}

async function run(g) {
  let wait = 1000;
  while (g === generation) {
    abort = new AbortController();
    try {
      const res = await fetch(`/api/stream?since=${live.since}`, { headers: auth(), cache: 'no-store', signal: abort.signal });
      if (res.status === 401) {
        live.revoked = true;
        live.transport = 'disconnected';
        return changed();
      }
      if (res.status === 429) {
        live.locked = true;
        live.transport = 'reconnecting';
        changed();
        await sleep(60_000);
        continue;
      }
      if (res.status === 503) {
        // The relay restarted and the Mac hasn't told it who its phones are yet.
        live.relayWaiting = true;
        live.transport = 'connected';
        live.agentOnline = false;
        changed();
        await sleep(Math.min(wait, 10_000));
        wait = Math.min(wait * 2, 15_000);
        continue;
      }
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      live.relayWaiting = false;
      live.locked = false;
      live.transport = 'connected';
      if (everConnected && lostAt && Date.now() - lostAt > 4000 && Date.now() - lastRestoredNotice > 60_000) {
        lastRestoredNotice = Date.now();
        notice('Connection restored.');
      }
      everConnected = true;
      lostAt = 0;
      wait = 1000;
      changed();
      void flushOutbox();
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let end;
        while ((end = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const name = /^event: (.+)$/m.exec(block)?.[1];
          const data = /^data: (.*)$/m.exec(block)?.[1];
          if (name && data && g === generation) await onEvent(name, JSON.parse(data));
        }
      }
    } catch {
      // dropped: retry below
    }
    if (g !== generation) return;
    if (!lostAt) lostAt = Date.now();
    live.transport = everConnected ? 'reconnecting' : 'connecting';
    live.agentOnline = false;
    changed();
    await sleep(wait + Math.random() * 400);
    wait = Math.min(wait * 2, 15_000);
  }
}

async function onEvent(name, data) {
  const p = activePairing();
  const cache = macCache(p.macId);
  if (name === 'agent') {
    const was = live.agentOnline;
    live.agentOnline = Boolean(data.online);
    if (data.lastSeen) cache.lastSeen = data.lastSeen;
    if (live.agentOnline) {
      live.stoppedAt = null;
      cache.lastSeen = Date.now();
      if (!was) {
        void ping();
        void flushOutbox();
      }
    }
    persist();
  } else if (name === 'reset') {
    live.since = 0;
  } else if (name === 'queue-list') {
    live.relayQueue.clear();
    for (const item of data.items ?? []) live.relayQueue.set(item.id, item);
    reconcileOutbox();
  } else if (name === 'queue') {
    if (['done', 'cancelled', 'expired'].includes(data.status)) live.relayQueue.delete(data.id);
    else live.relayQueue.set(data.id, { ...(live.relayQueue.get(data.id) ?? {}), ...data });
    reconcileOutbox();
  } else if (name === 'entry') {
    live.since = data.seq;
    let ev;
    try {
      ev = data.to ? await unseal(keys.key, data.c, `evt:${p.deviceId}`) : await unseal(keys.broadcast, data.c, 'evt');
    } catch {
      return; // not for us (another phone's, or sealed with a key we no longer have)
    }
    handleEvent(ev, cache);
  }
  changed();
}

function handleEvent(ev, cache) {
  const p = activePairing();
  if (ev.t === 'snapshot') {
    const before = cache.snapshot;
    noteJobs(before?.jobs, ev.jobs);
    cache.snapshot = ev;
    cache.syncedAt = Date.now();
    cache.lastSeen = Date.now();
    announceChanges(before, ev);
    persist();
    afterSnapshot();
  } else if (ev.t === 'live' && cache.snapshot) {
    noteJobs(cache.snapshot.jobs, ev.jobs);
    cache.snapshot = { ...cache.snapshot, jobs: ev.jobs };
    cache.syncedAt = Date.now();
  } else if (ev.t === 'engine' && ev.state === 'stopped') {
    live.stoppedAt = ev.at;
  } else if (ev.t === 'rekey') {
    p.broadcastKey = ev.broadcastKey;
    keys = null;
    persist();
    void keysFor(p);
  } else if (ev.t === 'project') {
    const pv = ev.project.preview;
    const was = cache.details[ev.project.id]?.preview;
    if (pv?.state === 'completed' && was && was.jobId !== pv.jobId) addActivity(ev.project.id, `Preview of revision ${pv.revision} is ready`);
    cache.details[ev.project.id] = { ...ev.project, at: Date.now() };
    persist();
    void maybeLoadPreview(ev.project);
  } else if (ev.t === 'poster') {
    void gotPoster(ev);
  } else if (ev.t === 'ai.options') {
    live.aiOptions.set(ev.projectId, { providers: ev.providers, last: ev.last });
  } else if (ev.t === 'export.options') {
    live.exportOptions.set(ev.projectId, ev);
  } else if (ev.t === 'queue') {
    onQueueEvent(ev);
  } else if (ev.t === 'file') {
    onFileEvent(ev);
  } else if (ev.t === 'upload') {
    onUploadEvent(ev);
  } else if (ev.t === 'pong' && pingAt) {
    live.rtt = Math.round(performance.now() - pingAt);
    pingAt = 0;
  }
  if (ev.t === 'error' && ev.id) {
    for (const t of transfers.values()) if (t.cmdId === ev.id) t.fail(new Error(ev.message ?? 'Your Mac couldn’t send the file.'));
  }
  if (ev.id && mine.has(ev.id)) {
    live.replies.set(ev.id, ev);
    const w = waiters.get(ev.id);
    if (w && ev.t !== 'file' && !(ev.t === 'upload' && ev.state === 'receiving')) {
      waiters.delete(ev.id);
      w(ev);
    }
  }
}

/** Technical updates (renders starting) go to a collapsed Activity group, not into the conversation. */
function addActivity(projectId, text) {
  live.activity.push({ at: Date.now(), projectId, text });
  if (live.activity.length > 50) live.activity.shift();
}

function noteJobs(before, after) {
  const had = new Set((before ?? []).map((j) => j.id));
  for (const j of after ?? []) if (!had.has(j.id)) addActivity(j.projectId, j.kind === 'preview' ? `Preview render started (revision ${j.revision})` : `Export started (revision ${j.revision})`);
}

/** In-app notices for things that changed between two snapshots (exports finished or failed). */
function announceChanges(before, after) {
  if (!before) return;
  const prev = new Map((before.exports ?? []).map((e) => [e.id, e.state]));
  for (const e of after.exports ?? []) {
    const was = prev.get(e.id);
    if (!was || was === e.state) continue;
    if (e.state === 'completed') notice(`Export completed: ${e.projectName}`);
    else if (e.state === 'failed') notice(`Export failed: ${e.projectName}`, 'error');
  }
}

// ── commands ────────────────────────────────────────────────────────────────
const mine = new Set();
const waiters = new Map();
let pingAt = 0;

/** Sends a command the Mac must be online for. Resolves with its answer (or null if not delivered). */
export async function command(type, fields = {}, { wait = true, timeout = 30_000 } = {}) {
  const p = activePairing();
  if (!p || !keys) return null;
  const id = crypto.randomUUID();
  mine.add(id);
  const c = await seal(keys.key, { id, at: Date.now(), type, ...fields }, `cmd:${p.deviceId}`);
  const answer = wait ? new Promise((resolve) => {
    waiters.set(id, resolve);
    setTimeout(() => waiters.delete(id) && resolve({ t: 'error', message: 'Your Mac didn’t answer in time.', timeout: true }), timeout);
  }) : null;
  const res = await fetch('/api/command', { method: 'POST', headers: auth(), body: JSON.stringify({ c }) }).catch(() => null);
  if (!res?.ok) {
    waiters.delete(id);
    return null;
  }
  return answer ?? { t: 'sent', id };
}

export async function ping() {
  if (!live.agentOnline) return;
  pingAt = performance.now();
  await command('ping', {}, { wait: false }).catch(() => {});
}

function afterSnapshot() {
  const snap = macCache(activePairing().macId).snapshot;
  for (const pr of (snap?.projects ?? []).slice(0, 30)) wantPoster(pr);
}

// ── projects: details, posters, previews ────────────────────────────────────
const asked = new Map(); // projectId → stamp
export function openProject(projectId, force = false) {
  if (!live.agentOnline) return;
  const snap = macCache(activePairing().macId).snapshot;
  const pr = snap?.projects?.find((x) => x.id === projectId);
  const running = (snap?.jobs ?? []).filter((j) => j.projectId === projectId).map((j) => `${j.id}:${j.state}`).join(',');
  const asking = (snap?.asks ?? []).some((a) => a.projectId === projectId);
  const stamp = `${pr?.revision}:${pr?.pendingProposals}:${running}:${asking}`;
  if (!force && asked.get(projectId) === stamp) return;
  asked.set(projectId, stamp);
  void command('project.open', { projectId }, { wait: false });
  if (!live.aiOptions.has(projectId)) void command('ai.options', { projectId }, { wait: false });
}

const posterQueue = [];
let posterBusy = false;
function wantPoster(pr) {
  const have = live.posters.get(pr.id);
  if ((have && have.revision === pr.revision) || posterQueue.includes(pr.id)) return;
  posterQueue.push(pr.id);
  void nextPoster();
}

async function nextPoster() {
  if (posterBusy || !live.agentOnline) return;
  const projectId = posterQueue.shift();
  if (!projectId) return;
  posterBusy = true;
  const pr = macCache(activePairing().macId).snapshot?.projects?.find((x) => x.id === projectId);
  try {
    const ev = await command('poster', { projectId }, { timeout: 20_000 });
    if (ev?.t === 'poster') await gotPoster(ev, pr?.revision);
  } finally {
    posterBusy = false;
    void nextPoster();
  }
}

async function gotPoster(ev, revision) {
  const old = live.posters.get(ev.projectId);
  if (!ev.blob) return live.posters.set(ev.projectId, { key: null, url: null, revision });
  if (old?.key === ev.key && old.url) return live.posters.set(ev.projectId, { ...old, revision });
  try {
    const res = await fetch(`/api/blob?id=${encodeURIComponent(ev.blob)}`, { headers: auth(), cache: 'no-store' });
    if (!res.ok) return;
    const file = await unseal(keys.key, (await res.json()).c, `blob:${ev.blob}`);
    const bytes = Uint8Array.from(atob(file.data), (c) => c.charCodeAt(0));
    const blob = new Blob([bytes], { type: file.type });
    await cachePut(`poster/${activePairing().macId}/${ev.projectId}`, blob, { key: ev.key });
    if (old?.url) URL.revokeObjectURL(old.url);
    live.posters.set(ev.projectId, { key: ev.key, url: URL.createObjectURL(blob), revision });
    changed();
  } catch {
    // expired or the relay restarted: asked again next time
  }
}

/** A sealed blob the Mac put on the relay for this phone (stills, filmstrips), opened. */
export async function fetchBlob(id) {
  const res = await fetch(`/api/blob?id=${encodeURIComponent(id)}`, { headers: auth(), cache: 'no-store' });
  if (!res.ok) throw new Error(`The relay answered ${res.status}.`);
  const file = await unseal(keys.key, (await res.json()).c, `blob:${id}`);
  return new Blob([Uint8Array.from(atob(file.data), (c) => c.charCodeAt(0))], { type: file.type });
}

/** Posters and previews saved earlier, so the app shows them before (or without) the Mac. */
export async function restoreMedia() {
  const p = activePairing();
  if (!p) return;
  const snap = macCache(p.macId).snapshot;
  for (const pr of snap?.projects ?? []) {
    if (live.posters.get(pr.id)?.url) continue;
    const hit = await cacheGet(`poster/${p.macId}/${pr.id}`);
    if (hit) live.posters.set(pr.id, { key: hit.meta.key, url: URL.createObjectURL(hit.blob), revision: null });
  }
  changed();
}

export async function restorePreview(projectId) {
  const p = activePairing();
  if (!p || live.previews.get(projectId)?.url) return;
  const hit = await cacheGet(`preview/${p.macId}/${projectId}`);
  if (hit) {
    live.previews.set(projectId, { ...hit.meta, url: URL.createObjectURL(hit.blob), state: 'ready', saved: true });
    changed();
  }
}

/** Fetches the project's latest finished preview if it's new and small enough to fetch without asking. */
async function maybeLoadPreview(detail, { force = false } = {}) {
  const pv = detail.preview;
  if (!pv || pv.state !== 'completed') return;
  const have = live.previews.get(detail.id);
  if (have && have.jobId === pv.jobId && (have.state === 'ready' || have.state === 'loading')) return;
  if (!force && (pv.sizeBytes ?? 0) > 25 * 1024 * 1024) {
    live.previews.set(detail.id, { ...(have ?? {}), offer: pv });
    return changed();
  }
  await loadPreview(detail.id, pv);
}

export async function loadPreview(projectId, pv) {
  const prev = live.previews.get(projectId);
  live.previews.set(projectId, { ...(prev ?? {}), state: 'loading', progress: 0, pending: pv });
  changed();
  try {
    const blob = await download(pv.jobId, (progress) => {
      live.previews.set(projectId, { ...live.previews.get(projectId), progress });
      changed();
    });
    const meta = { jobId: pv.jobId, revision: pv.revision, updatedAt: pv.finishedAt ?? new Date().toISOString(), width: pv.width, height: pv.height };
    await cachePut(`preview/${activePairing().macId}/${projectId}`, blob, meta);
    // The old URL is not revoked here: the Session player may still be playing it, and it lets go of it
    // itself when the user loads the new one.
    live.previews.set(projectId, { ...meta, url: URL.createObjectURL(blob), state: 'ready', saved: false });
  } catch (e) {
    live.previews.set(projectId, { ...(prev ?? {}), state: prev?.url ? 'ready' : 'failed', error: e.message });
  }
  changed();
}

// ── files from the Mac ──────────────────────────────────────────────────────
const transfers = new Map(); // transferId → { onMeta, resolve }

function onFileEvent(ev) {
  const t = transfers.get(ev.transferId);
  if (!t) return;
  if (ev.state === 'sending') t.onMeta(ev);
  else if (ev.state === 'failed' || ev.state === 'cancelled') t.fail(new Error(ev.message ?? 'The transfer stopped.'));
}

/** A finished render's file, from the Mac through the relay in sealed pieces. */
export async function download(jobId, onProgress = () => {}) {
  if (!live.agentOnline) throw new Error('Your Mac isn’t connected.');
  const transferId = `t_${crypto.randomUUID().replace(/-/g, '')}`;
  const meta = await new Promise((resolve, reject) => {
    transfers.set(transferId, { onMeta: resolve, fail: reject, cmdId: null });
    command('file.get', { jobId, transferId }, { wait: false }).then((r) => {
      if (!r) return reject(new Error('Your Mac isn’t connected.'));
      const t = transfers.get(transferId);
      if (t) t.cmdId = r.id; // an error answer to this command ends the transfer (handleEvent)
    });
    setTimeout(() => reject(new Error('Your Mac didn’t start sending the file.')), 30_000);
  });
  const parts = [];
  let failed = null;
  transfers.get(transferId).fail = (e) => (failed = e);
  try {
    for (let n = 0; n < meta.pieces; n++) {
      for (;;) {
        if (failed) throw failed;
        const res = await fetch(`/api/chunk?id=${transferId}&n=${n}`, { headers: auth(), cache: 'no-store' });
        if (res.status === 204) continue;
        if (!res.ok) throw new Error(`The relay answered ${res.status}.`);
        parts.push(await unsealBytes(keys.key, (await res.json()).c, `down:${transferId}:${n}`));
        break;
      }
      onProgress((n + 1) / meta.pieces);
    }
  } catch (e) {
    void command('file.cancel', { transferId }, { wait: false });
    throw e;
  } finally {
    transfers.delete(transferId);
  }
  return new Blob(parts, { type: meta.type ?? 'video/mp4' });
}

export async function downloadExport(exp) {
  const cur = live.downloads.get(exp.id);
  if (cur?.state === 'loading') return;
  live.downloads.set(exp.id, { state: 'loading', progress: 0, name: exp.fileName, size: exp.sizeBytes });
  changed();
  try {
    const blob = await download(exp.id, (progress) => {
      live.downloads.set(exp.id, { ...live.downloads.get(exp.id), progress });
      changed();
    });
    live.downloads.set(exp.id, { state: 'ready', url: URL.createObjectURL(blob), blob, name: exp.fileName, size: blob.size });
    notice('Download finished. Save or share it below.');
  } catch (e) {
    live.downloads.set(exp.id, { state: 'failed', error: e.message, name: exp.fileName });
  }
  changed();
}

// ── uploads to the Mac ──────────────────────────────────────────────────────
function onUploadEvent(ev) {
  const u = live.uploads.get(ev.uploadId);
  if (!u) return;
  if (ev.state === 'imported') {
    live.uploads.set(ev.uploadId, { ...u, state: 'imported', progress: 1, filename: ev.filename });
    notice(`${ev.filename} was added to the project on your Mac.`);
  } else if (ev.state === 'failed' || ev.state === 'cancelled') live.uploads.set(ev.uploadId, { ...u, state: ev.state, error: ev.message });
  changed();
}

/** Sends a file to the Mac, which imports it into the project's media. Needs the Mac online. */
export async function upload(projectId, file) {
  if (!live.agentOnline) throw new Error('Attachments need your Mac online.');
  const uploadId = `u_${crypto.randomUUID().replace(/-/g, '')}`;
  // The file stays with the entry (in memory only) so a failed import can be tried again into the same project.
  live.uploads.set(uploadId, { name: file.name, progress: 0, state: 'sending', projectId, file });
  changed();
  const sent = await command('upload.start', { projectId, uploadId, name: file.name, size: file.size }, { wait: false });
  if (!sent) {
    live.uploads.set(uploadId, { name: file.name, state: 'failed', error: 'Your Mac isn’t connected.', projectId, file });
    return changed();
  }
  const pieces = Math.max(1, Math.ceil(file.size / PIECE_BYTES));
  try {
    for (let n = 0; n < pieces; n++) {
      const bytes = new Uint8Array(await file.slice(n * PIECE_BYTES, (n + 1) * PIECE_BYTES).arrayBuffer());
      const c = await sealBytes(keys.key, bytes, `up:${uploadId}:${n}`);
      for (let tries = 0; ; tries++) {
        const u = live.uploads.get(uploadId);
        if (u?.state === 'cancelled' || u?.state === 'failed') return;
        const res = await fetch('/api/chunk', { method: 'POST', headers: auth(), body: JSON.stringify({ id: uploadId, n, c }) }).catch(() => null);
        if (res?.ok) break;
        if (tries > 200) throw new Error('The relay stopped taking the file.');
        await sleep(res?.status === 507 ? 700 : 2000);
      }
      live.uploads.set(uploadId, { ...live.uploads.get(uploadId), progress: (n + 1) / pieces, state: n + 1 === pieces ? 'importing' : 'sending' });
      changed();
    }
  } catch (e) {
    live.uploads.set(uploadId, { ...live.uploads.get(uploadId), state: 'failed', error: e.message });
    void command('upload.cancel', { uploadId }, { wait: false });
    changed();
  }
}

/** Sends a failed or cancelled file again, into the project it was meant for. */
export async function retryUpload(uploadId) {
  const u = live.uploads.get(uploadId);
  if (!u?.file || !['failed', 'cancelled'].includes(u.state)) return;
  live.uploads.delete(uploadId);
  try {
    await upload(u.projectId, u.file);
  } catch (e) {
    live.uploads.set(uploadId, { ...u, error: e.message });
    changed();
  }
}

export function cancelUpload(uploadId) {
  const u = live.uploads.get(uploadId);
  if (!u) return;
  live.uploads.set(uploadId, { ...u, state: 'cancelled' });
  void command('upload.cancel', { uploadId }, { wait: false });
  changed();
}

// ── renaming and deleting projects ──────────────────────────────────────────
/** Renames a project on the Mac (its ProjectStore.rename). Answers { t: 'project.renamed', project } | error | null. */
export async function renameProject(projectId, name) {
  const r = await command('project.rename', { projectId, name }, { timeout: 20_000 });
  if (r?.t === 'project.renamed') {
    const cache = macCache(activePairing().macId);
    if (cache.snapshot) cache.snapshot = { ...cache.snapshot, projects: (cache.snapshot.projects ?? []).map((p) => (p.id === projectId ? { ...p, ...r.project } : p)) };
    persist();
    changed();
  }
  return r;
}

/**
 * Deletes a project on the Mac, for good. Answers { t: 'project.deleted', project } | error | null. What this
 * phone kept for it (cached details, the poster) goes too; what's left in the queue for it fails on the Mac.
 */
export async function deleteProject(projectId) {
  const r = await command('project.delete', { projectId }, { timeout: 20_000 });
  if (r?.t === 'project.deleted' || (r?.t === 'error' && r.code === 'NOT_FOUND')) forgetProject(projectId);
  return r;
}

function forgetProject(projectId) {
  const cache = macCache(activePairing().macId);
  if (cache.snapshot) {
    const s = cache.snapshot;
    cache.snapshot = { ...s, projects: (s.projects ?? []).filter((p) => p.id !== projectId), exports: (s.exports ?? []).filter((x) => x.projectId !== projectId), jobs: (s.jobs ?? []).filter((j) => j.projectId !== projectId) };
  }
  delete cache.details[projectId];
  if (cache.lastProject === projectId) cache.lastProject = null;
  persist();
  changed();
}

// ── new projects ────────────────────────────────────────────────────────────
/**
 * Creates a project on the Mac (the same ProjectStore.create its New project uses). `requestId` is the form's
 * own, kept until the Mac confirms: asking again with it after a timeout gets the project already made, never
 * a second one. Answers { t: 'project.created', project, existing } | { t: 'error', ... } | null (not sent).
 */
export async function createProject({ requestId, name, format }) {
  const r = await command('project.create', { requestId, name, format }, { timeout: 20_000 });
  if (r?.t === 'project.created') {
    const cache = macCache(activePairing().macId);
    if (cache.snapshot) {
      const list = cache.snapshot.projects ?? [];
      if (!list.some((x) => x.id === r.project.id)) cache.snapshot = { ...cache.snapshot, projects: [r.project, ...list] };
    }
    persist();
    changed();
  }
  return r;
}

// ── instructions: the outbox and the relay's queue ──────────────────────────
// An instruction is written on the phone (outbox, "Saved on this phone"), handed to the relay ("Queued":
// it waits there even if the phone goes away), taken by the Mac ("Accepted", then "Running"), and ends as a
// proposal ("Review ready"), "Needs review", "Expired", "Cancelled" or "Failed". Its id never changes, so a
// retry after a dropped answer is the same instruction, never a second one.

/** Writes a new instruction for a project. */
export function addInstruction(projectId, text, { about = null } = {}) {
  const p = activePairing();
  const detail = macCache(p.macId).details[projectId];
  const snapProject = macCache(p.macId).snapshot?.projects?.find((x) => x.id === projectId);
  const choice = saved.prefs.model[`${p.macId}:${projectId}`] ?? saved.prefs.model[p.macId] ?? null;
  const now = Date.now();
  const item = {
    id: crypto.randomUUID(),
    macId: p.macId,
    deviceId: p.deviceId,
    projectId,
    createdAt: now,
    expiresAt: now + QUEUE_TTL_MS,
    baseRevision: snapProject?.revision ?? detail?.revision ?? null,
    instruction: text,
    provider: choice?.provider ?? null,
    model: choice?.model ?? null,
    about,
    state: 'local',
    error: null,
  };
  saved.outbox.push(item);
  persist();
  changed();
  void flushOutbox();
  return item;
}

function sealedBody(item) {
  return seal(
    keys.key,
    // The times are sealed too: the Mac trusts only these, never the relay's copy beside them.
    { id: item.id, projectId: item.projectId, type: 'ai.ask', createdAt: item.createdAt, expiresAt: item.expiresAt, instruction: item.instruction, provider: item.provider, model: item.model, baseRevision: item.baseRevision, about: item.about },
    `queue:${item.id}`,
  );
}

let flushing = false;
/** Hands local instructions to the relay; retried on every reconnect. */
export async function flushOutbox() {
  if (flushing || live.transport !== 'connected' || live.relayWaiting || !keys) return;
  flushing = true;
  try {
    for (const item of saved.outbox) {
      if (item.macId !== activePairing()?.macId || item.state !== 'local') continue;
      if (item.expiresAt <= Date.now()) {
        item.state = 'expired';
        continue;
      }
      const res = await fetch('/api/queue', {
        method: 'POST',
        headers: auth(),
        body: JSON.stringify({ id: item.id, projectId: item.projectId, createdAt: item.createdAt, expiresAt: item.expiresAt, c: await sealedBody(item) }),
      }).catch(() => null);
      if (!res) break; // offline again: stays saved on this phone
      const body = await res.json().catch(() => ({}));
      if (res.ok) {
        item.state = body.item?.status === 'done' ? 'accepted' : body.item?.status ?? 'queued';
        notice(live.agentOnline ? 'Sent to your Mac.' : 'Queued. It runs when your Mac connects.');
      } else if (res.status >= 500) break;
      else {
        item.state = 'failed';
        item.error = body.error ?? `The relay answered ${res.status}.`;
      }
      persist();
      changed();
    }
  } finally {
    flushing = false;
  }
}

/** The relay's list after a (re)connect: anything we think is queued but it doesn't have, we post again. */
function reconcileOutbox() {
  let dirty = false;
  for (const item of saved.outbox) {
    if (item.macId !== activePairing()?.macId) continue;
    const r = live.relayQueue.get(item.id);
    if (r) {
      const st = r.status === 'queued' ? 'queued' : r.status === 'accepted' ? 'accepted' : item.state;
      if (st !== item.state && ['local', 'queued'].includes(item.state)) (item.state = st), (dirty = true);
    } else if (item.state === 'queued' && live.transport === 'connected') {
      // Lost by a relay restart (it keeps nothing on disk): hand it over again, same id.
      item.state = 'local';
      dirty = true;
    }
  }
  if (dirty) {
    persist();
    void flushOutbox();
  }
}

function onQueueEvent(ev) {
  live.queueEvents.set(ev.id, ev);
  const item = saved.outbox.find((x) => x.id === ev.id);
  if (!item) return;
  const before = item.state;
  item.state = ev.state === 'done' ? 'done' : ev.state;
  if (ev.proposalId) item.proposalId = ev.proposalId;
  if (ev.message) item.error = ev.message;
  if (ev.currentRevision) item.currentRevision = ev.currentRevision;
  item.reason = ev.reason ?? null;
  if (before !== item.state) {
    if (item.state === 'accepted') notice('Your Mac took the instruction.');
    else if (item.state === 'done') notice('Review ready.');
    else if (item.state === 'failed') notice(item.error ? `The agent couldn’t do that: ${item.error}` : 'The agent couldn’t do that.', 'error');
    else if (item.state === 'needs_review') notice('The timeline changed since you wrote that. Check it before it runs.');
  }
  // Finished ones leave the outbox once the version shows in the project (the detail is asked for again).
  if (['done', 'failed', 'cancelled', 'expired'].includes(item.state)) item.finishedAt = Date.now();
  saved.outbox = saved.outbox.filter((x) => !x.finishedAt || Date.now() - x.finishedAt < 7 * 24 * 3600 * 1000);
  persist();
  if (item.state === 'done' || item.state === 'running') openProject(item.projectId, true);
}

/** Edit an instruction that hasn't been taken yet. */
export async function editInstruction(id, text) {
  const item = saved.outbox.find((x) => x.id === id);
  if (!item || !['local', 'queued'].includes(item.state)) return false;
  item.instruction = text;
  if (item.state === 'queued') {
    const res = await fetch(`/api/queue/${id}`, { method: 'PUT', headers: auth(), body: JSON.stringify({ c: await sealedBody(item) }) }).catch(() => null);
    if (res?.status === 409) {
      item.state = 'accepted';
      notice('Your Mac already took it, so it wasn’t changed.');
    } else if (!res?.ok) {
      notice('Couldn’t reach the relay. Try again.', 'error');
      return false;
    }
  }
  persist();
  changed();
  return true;
}

/** Cancel an instruction that hasn't been taken yet. */
export async function cancelInstruction(id) {
  const item = saved.outbox.find((x) => x.id === id);
  if (!item) return false;
  if (item.state === 'queued') {
    const res = await fetch(`/api/queue/${id}`, { method: 'DELETE', headers: auth() }).catch(() => null);
    if (res?.status === 409) {
      notice('Your Mac already took it. Cancel it from the activity card instead.');
      return false;
    }
    if (!res?.ok && res?.status !== 404) {
      notice('Couldn’t reach the relay. Try again.', 'error');
      return false;
    }
  }
  if (!['local', 'queued', 'needs_review', 'failed', 'expired'].includes(item.state)) return false;
  item.state = 'cancelled';
  item.finishedAt = Date.now();
  persist();
  changed();
  return true;
}

/** "Run on the current timeline": the same words as a new instruction against today's revision. */
export function rerunInstruction(id) {
  const item = saved.outbox.find((x) => x.id === id);
  if (!item) return null;
  item.state = 'cancelled';
  item.finishedAt = Date.now();
  return addInstruction(item.projectId, item.instruction, { about: item.about });
}

export const instructionsFor = (projectId) => saved.outbox.filter((x) => x.macId === activePairing()?.macId && x.projectId === projectId);

// ── drafts ──────────────────────────────────────────────────────────────────
export const draftKey = (projectId) => `${activePairing()?.macId}:${projectId}`;
export function setDraft(projectId, text) {
  if (text) saved.drafts[draftKey(projectId)] = text;
  else delete saved.drafts[draftKey(projectId)];
  persist();
}

// ── media cache ─────────────────────────────────────────────────────────────
async function cachePut(key, blob, meta) {
  if (!('caches' in self)) return;
  try {
    const cache = await caches.open(MEDIA_CACHE);
    await cache.put(`/_media/${key}`, new Response(blob, { headers: { 'content-type': blob.type, 'x-meta': encodeURIComponent(JSON.stringify(meta ?? {})) } }));
  } catch {
    // storage full or unavailable (private mode): fine, it's a cache
  }
}

async function cacheGet(key) {
  if (!('caches' in self)) return null;
  try {
    const res = await (await caches.open(MEDIA_CACHE)).match(`/_media/${key}`);
    if (!res) return null;
    return { blob: await res.blob(), meta: JSON.parse(decodeURIComponent(res.headers.get('x-meta') ?? '%7B%7D')) };
  } catch {
    return null;
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
