// ReelForge Remote, the phone app. Talks only to the relay that served it; everything it sends and
// receives is sealed with a key derived from the pairing secret, which arrives in the link's
// fragment (#k=…) and so never reaches the relay. Views are built with textContent, never innerHTML,
// so nothing from a project name can become markup.
import { deriveKeys, seal, unseal } from './crypto.js';

const SECRET_KEY = 'reelforge.remote.secret';
const app = document.getElementById('app');
const toastEl = document.getElementById('toast');

const state = {
  token: null,
  key: null,
  since: 0,
  connected: false, // our stream to the relay is open
  online: false, // the Mac's stream to the relay is open
  snapshot: null,
  rtt: null,
  problem: null, // 'unpaired' | 'locked' | null
};

// ── pairing ────────────────────────────────────────────────────────────────
function takeSecretFromLink() {
  const m = /(?:^#|&)k=([A-Za-z0-9_-]{32,})/.exec(location.hash);
  if (m) {
    localStorage.setItem(SECRET_KEY, m[1]);
    history.replaceState(null, '', location.pathname); // out of the address bar and history
  }
  return localStorage.getItem(SECRET_KEY);
}

function unpair() {
  localStorage.removeItem(SECRET_KEY);
  location.reload();
}

// ── small DOM helpers ──────────────────────────────────────────────────────
function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}

let toastTimer;
function toast(text) {
  toastEl.textContent = text;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toastEl.hidden = true), 3500);
}

function ago(iso) {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (!Number.isFinite(s)) return '—';
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 172800) return 'yesterday';
  return new Date(iso).toLocaleDateString();
}

function aspect(w, h) {
  const g = (a, b) => (b ? g(b, a % b) : a);
  const d = g(w, h) || 1;
  const a = `${w / d}:${h / d}`;
  return ['9:16', '16:9', '1:1', '4:5', '4:3', '3:4'].includes(a) ? a : `${w}×${h}`;
}

const JOB_WORDS = { queued: 'Waiting', analyzing: 'Preparing', rendering: 'Rendering', muxing: 'Finishing' };

// ── views ──────────────────────────────────────────────────────────────────
function statusPill() {
  if (state.problem === 'locked') return h('span', { class: 'pill err' }, h('span', { class: 'dot' }), 'Locked out');
  if (!state.connected) return h('span', { class: 'pill' }, h('span', { class: 'dot' }), 'Connecting…');
  return state.online ? h('span', { class: 'pill ok' }, h('span', { class: 'dot' }), 'Online') : h('span', { class: 'pill wait' }, h('span', { class: 'dot' }), 'Mac offline');
}

function viewUnpaired(reason) {
  return h(
    'main',
    { class: 'pair' },
    h('img', { src: '/mark.svg', alt: '' }),
    h('div', {}, h('h1', { text: 'ReelForge Remote' }), h('p', { class: 'mt', text: 'Your Mac edits. Your phone directs.' })),
    h(
      'div',
      { class: 'card' },
      h('div', { class: 'label', text: reason === 'unpaired' ? 'Pairing no longer valid' : 'Not paired yet' }),
      h('p', {
        text:
          reason === 'unpaired'
            ? 'This phone was unpaired on your Mac (a new pairing was made). Scan the new QR code to pair again.'
            : 'On your Mac, open ReelForge → Settings → Phone remote and scan the QR code with this phone’s camera.',
      }),
    ),
    reason === 'unpaired' ? h('button', { class: 'btn', type: 'button', onclick: unpair, text: 'Forget this pairing' }) : null,
  );
}

function viewHome() {
  const snap = state.snapshot;
  const device = snap?.device;
  const sub = device
    ? h('div', { class: 'sub' }, h('span', { class: 'name', text: device.name }), state.rtt !== null ? h('span', { text: `\u00a0· ${state.rtt} ms` }) : null)
    : h('div', { class: 'sub', text: state.online ? 'Waiting for your Mac…' : 'Your Mac isn’t connected' });
  const projects = snap?.projects ?? [];
  const jobs = snap?.jobs ?? [];
  const byId = new Map(projects.map((p) => [p.id, p]));
  const pending = projects.filter((p) => p.pendingProposals > 0);

  const jobCard = jobs.length
    ? h(
        'section',
        { class: 'card', 'aria-label': 'Now on your Mac' },
        h('div', { class: 'label', text: 'Now on your Mac' }),
        jobs.map((j, i) => {
          const pct = Math.round(j.progress * 100);
          const bar = h('span');
          bar.style.width = `${pct}%`; // CSSOM: allowed by the relay's CSP, unlike style=""
          return h(
            'div',
            { class: i ? 'mt' : '' },
            h('div', { class: 'between' }, h('b', { text: `${j.kind === 'export' ? 'Exporting' : 'Preview of'} “${byId.get(j.projectId)?.name ?? 'a project'}”` }), h('span', { class: 'mono', text: `${pct}%` })),
            h('div', { class: 'bar mt', role: 'progressbar', 'aria-valuenow': pct, 'aria-valuemin': 0, 'aria-valuemax': 100 }, bar),
            h('div', { class: 'muted mt', text: JOB_WORDS[j.state] ?? j.state }),
          );
        }),
      )
    : null;

  const needsYou = pending.length
    ? h(
        'section',
        { class: 'card attention' },
        h('div', { class: 'row' }, h('span', { class: 'pill wait' }, h('span', { class: 'dot' }), 'Needs you')),
        pending.map((p) => h('p', { class: 'mt' }, h('b', { text: 'AI Director' }), ` proposed changes in “${p.name}”. Review them on your Mac.`)),
      )
    : null;

  const list = h(
    'section',
    { class: 'card', 'aria-label': 'Projects' },
    h('div', { class: 'label', text: 'Projects' }),
    !snap
      ? h('p', { class: 'empty', text: state.online ? 'Loading…' : 'Shown once your Mac connects.' })
      : projects.length === 0
        ? h('p', { class: 'empty', text: 'No projects yet.' })
        : projects.map((p) => {
            const job = jobs.find((j) => j.projectId === p.id);
            const shape = p.width > p.height ? 'landscape' : p.width === p.height ? 'square' : '';
            const badge = job
              ? h('span', { class: 'pill run' }, h('span', { class: 'dot' }), `${Math.round(job.progress * 100)}%`)
              : p.pendingProposals > 0
                ? h('span', { class: 'pill wait', text: 'Review' })
                : h('span', { class: 'pill', text: 'Idle' });
            return h(
              'div',
              { class: 'proj' },
              h('div', { class: `thumb ${shape}`, 'aria-hidden': 'true' }),
              h('div', {}, h('div', { class: 'n', text: p.name }), h('div', { class: 'm', text: `${aspect(p.width, p.height)} · ${p.fps} fps · edited ${ago(p.updatedAt)}` })),
              h('div', { class: 'grow' }),
              badge,
            );
          }),
  );

  return h(
    'div',
    {},
    h('header', { class: 'top' }, h('img', { src: '/mark.svg', alt: '' }), h('div', { class: 'head' }, h('div', { class: 't', text: 'Home' }), sub), h('div', { class: 'grow' }), statusPill()),
    h('main', { class: 'body' }, jobCard, needsYou, list, h('button', { class: 'btn sm', type: 'button', onclick: () => confirm('Forget this pairing on this phone?') && unpair(), text: 'Unpair this phone' })),
  );
}

function render() {
  const view = state.problem === 'unpaired' || !state.token ? viewUnpaired(state.problem) : viewHome();
  app.replaceChildren(view);
}

// ── relay ──────────────────────────────────────────────────────────────────
async function command(type, fields = {}) {
  const c = await seal(state.key, { id: crypto.randomUUID(), at: Date.now(), type, ...fields });
  const res = await fetch('/api/command', { method: 'POST', headers: { authorization: `Bearer ${state.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ c }) });
  return res.ok;
}

let pingAt = 0;
async function ping() {
  if (!state.online) return;
  pingAt = performance.now();
  await command('ping').catch(() => {});
}

async function onEvent(name, data) {
  if (name === 'agent') {
    const was = state.online;
    state.online = Boolean(data.online);
    if (state.online && !was) setTimeout(ping, 300);
  } else if (name === 'reset') {
    state.snapshot = null;
  } else if (name === 'entry') {
    state.since = data.seq;
    let ev;
    try {
      ev = await unseal(state.key, data.c);
    } catch {
      return; // not sealed with our key
    }
    if (ev.t === 'snapshot') state.snapshot = ev;
    else if (ev.t === 'pong' && pingAt) {
      state.rtt = Math.round(performance.now() - pingAt);
      pingAt = 0;
    } else if (ev.t === 'error') toast(ev.message);
  }
  render();
}

async function stream() {
  let wait = 1000;
  for (;;) {
    try {
      const res = await fetch(`/api/stream?since=${state.since}`, { headers: { authorization: `Bearer ${state.token}` }, cache: 'no-store' });
      if (res.status === 401) {
        state.problem = 'unpaired';
        return render();
      }
      if (res.status === 429) {
        state.problem = 'locked';
        render();
        await new Promise((r) => setTimeout(r, 60_000));
        continue;
      }
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      state.connected = true;
      state.problem = null;
      wait = 1000;
      render();
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
          if (name && data) await onEvent(name, JSON.parse(data));
        }
      }
    } catch {
      // dropped: retry below
    }
    state.connected = false;
    render();
    await new Promise((r) => setTimeout(r, wait));
    wait = Math.min(wait * 2, 15_000);
  }
}

// Coming back to the app (iOS suspends it): refresh the round trip.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') ping();
});
setInterval(render, 30_000); // keeps "edited 2 min ago" honest

(async () => {
  const secret = takeSecretFromLink();
  if (secret) {
    const keys = await deriveKeys(secret);
    state.token = keys.token;
    state.key = keys.key;
  }
  render();
  if (state.token) stream();
})();
