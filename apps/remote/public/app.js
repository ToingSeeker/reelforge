// ReelForge Remote, the phone app. Talks only to the relay that served it; everything it sends and
// receives is sealed with a key derived from the pairing secret, which arrives in the link's
// fragment (#k=…) and so never reaches the relay. Views are built with textContent, never innerHTML,
// so nothing from a project name can become markup.
import { deriveKeys, fromBase64, seal, unseal } from './crypto.js';
import { secretFromText } from './pairing.js';

const SECRET_KEY = 'reelforge.remote.secret';
const PREFS_KEY = 'reelforge.remote.notify';
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
  details: new Map(), // projectId → detail from the Mac
  posters: new Map(), // projectId → { key, url, revision }
  push: { ready: false, subscribed: false, busy: false },
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

/** Pair from a pasted link or key (see pairing.js for why pasting, not only the QR). */
function pairWith(text) {
  const secret = secretFromText(text);
  if (!secret) return toast('That isn’t a pairing link. On your Mac, use Copy link and paste it here.');
  // A link for another relay would store a key this relay can't use (and that this app would then
  // send there as a token): refuse it and say where it points.
  let link = null;
  try {
    if (/^https?:\/\//i.test(String(text).trim())) link = new URL(String(text).trim());
  } catch {}
  if (link && link.origin !== location.origin) return toast(`That link is for another relay (${link.host}). Open it there instead.`);
  localStorage.setItem(SECRET_KEY, secret);
  location.replace('/'); // start over with the new key
}

async function unpair() {
  await pushOff({ quiet: true }).catch(() => {});
  localStorage.removeItem(SECRET_KEY);
  location.replace('/');
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

/** Tab icons, drawn as SVG paths (no inline styles: the relay's CSP forbids them). */
function icon(d) {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', d);
  svg.append(path);
  return svg;
}
const ICONS = {
  home: 'M4 11.5 12 5l8 6.5V19a1 1 0 0 1-1 1h-4.5v-5h-5v5H5a1 1 0 0 1-1-1z',
  projects: 'M4 5h7v6H4zM13 5h7v6h-7zM4 13h7v6H4zM13 13h7v6h-7z',
  settings: 'M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7zM12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M5.6 18.4l1.8-1.8M16.6 7.4l1.8-1.8',
};

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

function length(frames, fps) {
  const s = Math.round(frames / (fps || 30));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function size(bytes) {
  if (!bytes) return null;
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${(bytes / 1e6).toFixed(1)} MB`;
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

const JOB_WORDS = { queued: 'Waiting', analyzing: 'Preparing', rendering: 'Rendering', muxing: 'Finishing', completed: 'Done', failed: 'Failed', cancelled: 'Cancelled' };

// ── routes: #/ (Home), #/projects, #/p/<id>, #/settings ────────────────────
function route() {
  const p = /^#\/p\/([0-9a-f-]{36})$/i.exec(location.hash);
  if (p) return { name: 'project', id: p[1].toLowerCase() };
  if (location.hash === '#/projects') return { name: 'projects' };
  if (location.hash === '#/settings') return { name: 'settings' };
  return { name: 'home' };
}

function go(hash) {
  if (location.hash !== hash) location.hash = hash;
}

// ── shared pieces ──────────────────────────────────────────────────────────
function statusPill() {
  if (state.problem === 'locked') return h('span', { class: 'pill err' }, h('span', { class: 'dot' }), 'Locked out');
  if (!state.connected) return h('span', { class: 'pill' }, h('span', { class: 'dot' }), 'Connecting…');
  return state.online ? h('span', { class: 'pill ok' }, h('span', { class: 'dot' }), 'Online') : h('span', { class: 'pill wait' }, h('span', { class: 'dot' }), 'Mac offline');
}

function header(title, sub, { back } = {}) {
  return h(
    'header',
    { class: 'top' },
    back ? h('button', { class: 'back', type: 'button', 'aria-label': 'Back', onclick: () => (history.length > 1 ? history.back() : go(back)), text: '‹' }) : h('img', { src: '/mark.svg', alt: '' }),
    h('div', { class: 'head' }, h('div', { class: 't', text: title }), sub),
    h('div', { class: 'grow' }),
    statusPill(),
  );
}

function tabs(current) {
  const pending = (state.snapshot?.projects ?? []).filter((p) => p.pendingProposals > 0).length;
  const tab = (name, hash, label, badge) =>
    h('a', { class: `tab${current === name ? ' on' : ''}`, href: hash, 'aria-current': current === name ? 'page' : null }, h('span', { class: 'ic' }, icon(ICONS[name]), badge ? h('span', { class: 'badge', text: String(badge) }) : null), label);
  return h('nav', { class: 'tabs', 'aria-label': 'Sections' }, tab('home', '#/', 'Home'), tab('projects', '#/projects', 'Projects', pending), tab('settings', '#/settings', 'Settings'));
}

function thumb(p) {
  const shape = p.width > p.height ? 'landscape' : p.width === p.height ? 'square' : '';
  const poster = state.posters.get(p.id);
  const el = h('div', { class: `thumb ${shape}`, 'aria-hidden': 'true' });
  if (poster?.url) el.append(h('img', { src: poster.url, alt: '' }));
  return el;
}

function bar(progress) {
  const pct = Math.round(progress * 100);
  const fill = h('span');
  fill.style.width = `${pct}%`; // CSSOM: allowed by the relay's CSP, unlike style=""
  return h('div', { class: 'bar mt', role: 'progressbar', 'aria-valuenow': pct, 'aria-valuemin': 0, 'aria-valuemax': 100 }, fill);
}

function projectRow(p) {
  const job = (state.snapshot?.jobs ?? []).find((j) => j.projectId === p.id);
  const badge = job
    ? h('span', { class: 'pill run' }, h('span', { class: 'dot' }), `${Math.round(job.progress * 100)}%`)
    : p.pendingProposals > 0
      ? h('span', { class: 'pill wait', text: 'Review' })
      : h('span', { class: 'pill', text: 'Idle' });
  return h(
    'a',
    { class: 'proj', href: `#/p/${p.id}` },
    thumb(p),
    h('div', { class: 'info' }, h('div', { class: 'n', text: p.name }), h('div', { class: 'm', text: `${aspect(p.width, p.height)} · ${p.fps} fps · edited ${ago(p.updatedAt)}` })),
    h('div', { class: 'grow' }),
    badge,
  );
}

// ── views ──────────────────────────────────────────────────────────────────
function viewUnpaired(reason) {
  const input = h('input', {
    class: 'pair-input',
    type: 'text',
    placeholder: 'Paste the pairing link',
    autocomplete: 'off',
    autocapitalize: 'off',
    autocorrect: 'off',
    spellcheck: 'false',
    'aria-label': 'Pairing link',
  });
  // Pasting a whole link is the whole job: pair at once, no extra tap.
  input.addEventListener('paste', (e) => {
    const text = e.clipboardData?.getData('text');
    if (secretFromText(text)) {
      e.preventDefault();
      pairWith(text);
    }
  });
  const pasteFromClipboard = async () => {
    try {
      pairWith(await navigator.clipboard.readText());
    } catch {
      input.focus();
      toast('Couldn’t read the clipboard. Long-press the box and choose Paste.');
    }
  };
  return h(
    'main',
    { class: 'pair' },
    h('img', { src: '/mark.svg', alt: '' }),
    h('div', {}, h('h1', { text: 'ReelForge Remote' }), h('p', { class: 'mt', text: 'Your Mac edits. Your phone directs.' })),
    h(
      'div',
      { class: 'card' },
      h('div', { class: 'label', text: reason === 'unpaired' ? 'Pairing no longer valid' : 'Pair with your Mac' }),
      reason === 'unpaired' ? h('p', { text: 'Your Mac doesn’t accept this pairing: it’s from an older pairing or the link was cut short. Pair again below.' }) : null,
      h('p', { class: 'mt', text: 'On your Mac, open ReelForge → Settings → Phone remote. Then scan its QR code here, or press Copy link there and paste it here.' }),
      h('button', { class: 'btn mint mt', type: 'button', onclick: openScanner, text: 'Scan QR code' }),
      h('button', { class: 'btn mt', type: 'button', onclick: pasteFromClipboard, text: 'Paste from Mac' }),
      h('p', { class: 'muted mt', text: 'Paste from Mac needs both on the same Apple ID with Handoff on. Otherwise send the link to yourself (AirDrop, Notes) and paste it below.' }),
      h('div', { class: 'pair-row mt' }, input, h('button', { class: 'btn sm', type: 'button', onclick: () => pairWith(input.value), text: 'Pair' })),
    ),
    reason === 'unpaired' ? h('button', { class: 'btn', type: 'button', onclick: unpair, text: 'Forget this pairing' }) : null,
  );
}

// ── QR scanner (pairing) ────────────────────────────────────────────────────
// The camera stays on this phone: frames are read here by jsQR (vendor/, loaded only when asked
// for) and never leave it. Only a QR holding a pairing link pairs; anything else is ignored.
let jsQRReady = null;
function loadJsQR() {
  jsQRReady ??= new Promise((resolve, reject) => {
    if (window.jsQR) return resolve(window.jsQR);
    const s = document.createElement('script');
    s.src = '/vendor/jsQR.min.js';
    s.onload = () => (window.jsQR ? resolve(window.jsQR) : reject(new Error('jsQR missing')));
    s.onerror = () => {
      jsQRReady = null;
      reject(new Error('Couldn’t load the QR reader'));
    };
    document.head.append(s);
  });
  return jsQRReady;
}

const scanner = { stream: null, raf: 0, el: null, warned: false };

function closeScanner() {
  cancelAnimationFrame(scanner.raf);
  scanner.stream?.getTracks().forEach((t) => t.stop());
  scanner.el?.remove();
  Object.assign(scanner, { stream: null, raf: 0, el: null, warned: false });
}

async function openScanner() {
  if (!navigator.mediaDevices?.getUserMedia) return toast('This browser can’t use the camera here. Use Paste from Mac instead.');
  closeScanner();
  const video = h('video', { class: 'scan-video', playsinline: true, muted: true, autoplay: true });
  const status = h('p', { class: 'scan-status', text: 'Starting the camera…' });
  scanner.el = h(
    'div',
    { class: 'scan', role: 'dialog', 'aria-label': 'Scan the pairing QR code' },
    h('div', { class: 'scan-view' }, video, h('div', { class: 'scan-frame' })),
    h('p', { class: 'scan-title', text: 'Point at the QR code in Settings → Phone remote on your Mac' }),
    status,
    h('button', { class: 'btn', type: 'button', onclick: closeScanner, text: 'Cancel' }),
  );
  document.body.append(scanner.el);
  try {
    const [jsQR, stream] = await Promise.all([
      loadJsQR(),
      navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false }),
    ]);
    if (!scanner.el) return stream.getTracks().forEach((t) => t.stop()); // cancelled while asking
    scanner.stream = stream;
    video.muted = true;
    video.srcObject = stream;
    await video.play();
    status.textContent = 'Looking for the code…';
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const tick = () => {
      if (!scanner.stream) return;
      if (video.readyState >= 2 && video.videoWidth) {
        // A smaller frame reads faster and the Mac's QR is large on screen.
        const scale = Math.min(1, 720 / Math.max(video.videoWidth, video.videoHeight));
        canvas.width = Math.round(video.videoWidth * scale);
        canvas.height = Math.round(video.videoHeight * scale);
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const code = jsQR(ctx.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height, { inversionAttempts: 'attemptBoth' });
        if (code?.data) {
          if (secretFromText(code.data)) {
            closeScanner();
            return pairWith(code.data);
          }
          if (!scanner.warned) {
            scanner.warned = true;
            status.textContent = 'That QR code isn’t a ReelForge pairing code.';
          }
        }
      }
      scanner.raf = requestAnimationFrame(tick);
    };
    tick();
  } catch (err) {
    const denied = err?.name === 'NotAllowedError' || err?.name === 'SecurityError';
    closeScanner();
    toast(denied ? 'Camera access was denied. Allow it for this app in Settings, or use Paste from Mac.' : `Couldn’t start the camera: ${err?.message ?? err}`);
  }
}

function macLine() {
  const device = state.snapshot?.device;
  return device
    ? h('div', { class: 'sub' }, h('span', { class: 'name', text: device.name }), state.rtt !== null ? h('span', { text: ` · ${state.rtt} ms` }) : null)
    : h('div', { class: 'sub', text: state.online ? 'Waiting for your Mac…' : 'Your Mac isn’t connected' });
}

function viewHome() {
  const snap = state.snapshot;
  const projects = snap?.projects ?? [];
  const jobs = snap?.jobs ?? [];
  const recent = snap?.recent ?? [];
  const byId = new Map(projects.map((p) => [p.id, p]));
  const pending = projects.filter((p) => p.pendingProposals > 0);

  const jobCard = jobs.length
    ? h(
        'section',
        { class: 'card', 'aria-label': 'Now on your Mac' },
        h('div', { class: 'label', text: 'Now on your Mac' }),
        jobs.map((j, i) =>
          h(
            'a',
            { class: `job${i ? ' mt' : ''}`, href: `#/p/${j.projectId}` },
            h('div', { class: 'between' }, h('b', { text: `${j.kind === 'export' ? 'Exporting' : 'Preview of'} “${byId.get(j.projectId)?.name ?? 'a project'}”` }), h('span', { class: 'mono', text: `${Math.round(j.progress * 100)}%` })),
            bar(j.progress),
            h('div', { class: 'muted mt', text: JOB_WORDS[j.state] ?? j.state }),
          ),
        ),
      )
    : null;

  const needsYou = pending.length
    ? h(
        'section',
        { class: 'card attention' },
        h('div', { class: 'row' }, h('span', { class: 'pill wait' }, h('span', { class: 'dot' }), 'Needs you')),
        pending.map((p) => h('a', { class: 'line mt', href: `#/p/${p.id}` }, h('b', { text: 'AI Director' }), ` proposed changes in “${p.name}”.`)),
      )
    : null;

  const ready = recent.length
    ? h(
        'section',
        { class: 'card', 'aria-label': 'Recent exports' },
        h('div', { class: 'label', text: 'Recent exports' }),
        recent.slice(0, 5).map((j) => {
          const p = byId.get(j.projectId);
          const pill = j.state === 'completed' ? h('span', { class: 'pill ok', text: 'Done' }) : j.state === 'failed' ? h('span', { class: 'pill err', text: 'Failed' }) : h('span', { class: 'pill', text: 'Cancelled' });
          const meta = j.state === 'failed' ? j.error ?? 'Failed' : [ago(j.finishedAt), size(j.sizeBytes)].filter(Boolean).join(' · ');
          return h(
            'a',
            { class: 'proj', href: `#/p/${j.projectId}` },
            p ? thumb(p) : h('div', { class: 'thumb', 'aria-hidden': 'true' }),
            h('div', { class: 'info' }, h('div', { class: 'n', text: p?.name ?? 'A project' }), h('div', { class: 'm', text: meta })),
            h('div', { class: 'grow' }),
            pill,
          );
        }),
        h('p', { class: 'muted mt', text: 'Saved on your Mac in Exports.' }),
      )
    : null;

  const latest = projects.slice(0, 3);
  const list = h(
    'section',
    { class: 'card', 'aria-label': 'Recent projects' },
    h('div', { class: 'between' }, h('div', { class: 'label', text: 'Recent projects' }), projects.length > latest.length ? h('a', { class: 'link', href: '#/projects', text: `All ${projects.length}` }) : null),
    !snap ? h('p', { class: 'empty', text: state.online ? 'Loading…' : 'Shown once your Mac connects.' }) : projects.length === 0 ? h('p', { class: 'empty', text: 'No projects yet.' }) : latest.map(projectRow),
  );

  return [header('Home', macLine()), h('main', { class: 'body' }, jobCard, needsYou, ready, list), tabs('home')];
}

function viewProjects() {
  const snap = state.snapshot;
  const projects = snap?.projects ?? [];
  return [
    header('Projects', h('div', { class: 'sub', text: snap ? plural(projects.length, 'project') : '' })),
    h(
      'main',
      { class: 'body' },
      h(
        'section',
        { class: 'card', 'aria-label': 'Projects' },
        !snap ? h('p', { class: 'empty', text: state.online ? 'Loading…' : 'Shown once your Mac connects.' }) : projects.length === 0 ? h('p', { class: 'empty', text: 'No projects yet. Create one on your Mac.' }) : projects.map(projectRow),
      ),
    ),
    tabs('projects'),
  ];
}

function lanes(d) {
  const total = Math.max(d.durationFrames, 1);
  const shown = d.tracks.filter((t) => t.clips.length > 0);
  if (!shown.length) return h('p', { class: 'empty', text: 'The timeline is empty.' });
  return h(
    'div',
    { class: 'lanes', 'aria-label': 'Timeline (read-only)' },
    shown.map((t) =>
      h(
        'div',
        { class: `lane ${t.kind}${t.hidden || t.muted ? ' off' : ''}`, title: t.name },
        t.clips.map((c) => {
          const s = h('span');
          s.style.left = `${(c.start / total) * 100}%`;
          s.style.width = `${Math.max((c.duration / total) * 100, 0.8)}%`;
          return s;
        }),
      ),
    ),
  );
}

function viewProject(id) {
  const summary = (state.snapshot?.projects ?? []).find((p) => p.id === id);
  const d = state.details.get(id);
  const live = (state.snapshot?.jobs ?? []).filter((j) => j.projectId === id);
  const title = d?.name ?? summary?.name ?? 'Project';
  const sub = h('div', { class: 'sub', text: d ? `rev ${d.revision} · ${d.width}×${d.height} · ${d.fps} fps` : summary ? `${summary.width}×${summary.height} · ${summary.fps} fps` : '' });
  if (!d) {
    const missing = state.snapshot && !summary;
    return [header(title, sub, { back: '#/projects' }), h('main', { class: 'body' }, h('p', { class: 'empty', text: missing ? 'This project isn’t on your Mac any more.' : state.online ? 'Loading…' : 'Shown once your Mac connects.' })), tabs('projects')];
  }

  const poster = state.posters.get(id);
  const shape = d.width > d.height ? 'landscape' : d.width === d.height ? 'square' : 'portrait';
  const posterEl = h(
    'div',
    { class: `poster ${shape}` },
    poster?.url ? h('img', { src: poster.url, alt: `Poster frame of ${d.name}` }) : null,
    h('span', { class: 'pill fmt', text: aspect(d.width, d.height) }),
    h('span', { class: 'mono tc', text: length(d.durationFrames, d.fps) }),
  );

  const tracksWithClips = d.tracks.filter((t) => t.clips.length > 0).length;
  const timeline = h(
    'section',
    { class: 'card', 'aria-label': 'Timeline' },
    lanes(d),
    h(
      'div',
      { class: 'between mt muted' },
      h('span', { text: [plural(d.clips, 'clip'), plural(tracksWithClips, 'track'), d.captions ? 'captions on' : null].filter(Boolean).join(' · ') }),
      h('span', { text: 'read-only' }),
    ),
  );

  const media = [d.assets.video && plural(d.assets.video, 'video'), d.assets.image && plural(d.assets.image, 'image'), d.assets.audio && `${d.assets.audio} audio`].filter(Boolean).join(' · ');
  const facts = h(
    'section',
    { class: 'card' },
    h('div', { class: 'kv' }, h('span', { text: 'Length' }), h('b', { text: length(d.durationFrames, d.fps) })),
    h('div', { class: 'kv' }, h('span', { text: 'Media' }), h('b', { text: media || 'None yet' })),
    d.assets.offline ? h('div', { class: 'kv' }, h('span', { text: 'Offline' }), h('b', { class: 'warn', text: `${plural(d.assets.offline, 'file')} to relink on your Mac` })) : null,
    h('div', { class: 'kv' }, h('span', { text: 'Edited' }), h('b', { text: ago(d.updatedAt) })),
  );

  const pending = d.proposals.filter((x) => x.status === 'pending');
  const proposals = pending.length
    ? h(
        'section',
        { class: 'card attention', 'aria-label': 'AI Director' },
        h('div', { class: 'label', text: 'AI Director' }),
        pending.map((x, i) =>
          h(
            'div',
            { class: i ? 'mt' : '' },
            h('div', { class: 'bubble', text: x.instruction }),
            h('p', { class: 'mt', text: x.summary }),
            h('div', { class: 'muted mt', text: `${plural(x.changes, 'change')} · ${x.model} · ${ago(x.createdAt)}` }),
          ),
        ),
        h('p', { class: 'muted mt', text: 'Review and apply it on your Mac. (Apply from the phone comes next.)' }),
      )
    : null;

  const jobs = d.jobs.length
    ? h(
        'section',
        { class: 'card', 'aria-label': 'Renders' },
        h('div', { class: 'label', text: 'Renders' }),
        d.jobs.map((j, i) => {
          const now = live.find((x) => x.id === j.id);
          const active = now || ['queued', 'analyzing', 'rendering', 'muxing'].includes(j.state);
          const st = now?.state ?? j.state;
          const pill = active ? h('span', { class: 'pill run' }, h('span', { class: 'dot' }), `${Math.round((now?.progress ?? j.progress) * 100)}%`) : st === 'completed' ? h('span', { class: 'pill ok', text: 'Done' }) : st === 'failed' ? h('span', { class: 'pill err', text: 'Failed' }) : h('span', { class: 'pill', text: JOB_WORDS[st] ?? st });
          const meta = active ? JOB_WORDS[st] ?? st : st === 'failed' ? j.error ?? 'Failed' : [ago(j.finishedAt ?? j.createdAt), size(j.sizeBytes)].filter(Boolean).join(' · ');
          return h(
            'div',
            { class: `jobrow${i ? ' sep' : ''}` },
            h('div', { class: 'between' }, h('b', { text: j.kind === 'export' ? 'Export' : 'Preview' }), pill),
            active ? bar(now?.progress ?? j.progress) : null,
            h('div', { class: 'muted mt', text: meta }),
          );
        }),
      )
    : null;

  return [header(title, sub, { back: '#/projects' }), h('main', { class: 'body' }, posterEl, timeline, proposals, jobs, facts), tabs('projects')];
}

function pushSupport() {
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent);
  const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
    return ios && !standalone ? 'install' : 'unsupported';
  }
  if (Notification.permission === 'denied') return 'denied';
  return 'ok';
}

function prefs() {
  try {
    return { exports: true, proposals: true, failures: true, ...JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') };
  } catch {
    return { exports: true, proposals: true, failures: true };
  }
}

function viewSettings() {
  const device = state.snapshot?.device;
  const support = pushSupport();
  const p = prefs();
  const toggle = (name, label) =>
    h(
      'label',
      { class: 'check' },
      h('input', {
        type: 'checkbox',
        checked: p[name],
        disabled: state.push.busy,
        onchange: (e) => {
          localStorage.setItem(PREFS_KEY, JSON.stringify({ ...prefs(), [name]: e.target.checked }));
          if (state.push.subscribed) pushOn();
        },
      }),
      h('span', { text: label }),
    );

  let notify;
  if (support === 'install') notify = h('p', { class: 'muted', text: 'On iPhone, notifications need the app on your Home Screen: tap Share → Add to Home Screen, then open ReelForge from there.' });
  else if (support === 'unsupported') notify = h('p', { class: 'muted', text: 'This browser can’t show notifications.' });
  else if (support === 'denied') notify = h('p', { class: 'muted', text: 'Notifications are blocked for this site. Allow them in your browser’s settings, then come back.' });
  else
    notify = h(
      'div',
      {},
      h('p', { class: 'muted', text: 'Sent by your Mac, encrypted for this phone. Your Mac has to be on and running ReelForge.' }),
      h('div', { class: 'checks mt' }, toggle('exports', 'An export is ready'), toggle('failures', 'An export failed'), toggle('proposals', 'The AI Director has a proposal')),
      state.push.subscribed
        ? h('div', { class: 'grid2 mt' }, h('button', { class: 'btn sm', type: 'button', disabled: state.push.busy, onclick: () => pushTest(), text: 'Send a test' }), h('button', { class: 'btn sm', type: 'button', disabled: state.push.busy, onclick: () => pushOff(), text: 'Turn off' }))
        : h('button', { class: 'btn mint mt', type: 'button', disabled: state.push.busy || !state.push.ready, onclick: () => pushOn(), text: 'Turn on notifications' }),
    );

  return [
    header('Settings', h('div', { class: 'sub', text: 'This phone' })),
    h(
      'main',
      { class: 'body' },
      h(
        'section',
        { class: 'card' },
        h('div', { class: 'label', text: 'Your Mac' }),
        h('div', { class: 'kv' }, h('span', { text: 'Name' }), h('b', { text: device?.name ?? '—' })),
        h('div', { class: 'kv' }, h('span', { text: 'ReelForge' }), h('b', { text: device?.version ?? '—' })),
        h('div', { class: 'kv' }, h('span', { text: 'Round trip' }), h('b', { text: state.rtt !== null ? `${state.rtt} ms` : '—' })),
      ),
      h('section', { class: 'card' }, h('div', { class: 'label', text: 'Notifications' }), notify),
      h(
        'section',
        { class: 'card' },
        h('div', { class: 'label', text: 'Pairing' }),
        h('p', { class: 'muted', text: 'Unpairing forgets the key on this phone. To lock out every phone, make a new pairing on your Mac.' }),
        h('button', { class: 'btn mt', type: 'button', onclick: () => confirm('Forget this pairing on this phone?') && unpair(), text: 'Unpair this phone' }),
      ),
    ),
    tabs('settings'),
  ];
}

function render() {
  if (state.problem === 'unpaired' || !state.token) return app.replaceChildren(viewUnpaired(state.problem));
  const r = route();
  const view = r.name === 'project' ? viewProject(r.id) : r.name === 'projects' ? viewProjects() : r.name === 'settings' ? viewSettings() : viewHome();
  app.replaceChildren(...view);
}

// ── relay ──────────────────────────────────────────────────────────────────
async function command(type, fields = {}) {
  const c = await seal(state.key, { id: crypto.randomUUID(), at: Date.now(), type, ...fields });
  const res = await fetch('/api/command', { method: 'POST', headers: { authorization: `Bearer ${state.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ c }) });
  return res.ok;
}

async function blob(id) {
  const res = await fetch(`/api/blob?id=${encodeURIComponent(id)}`, { headers: { authorization: `Bearer ${state.token}` }, cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return unseal(state.key, (await res.json()).c);
}

let pingAt = 0;
async function ping() {
  if (!state.online) return;
  pingAt = performance.now();
  await command('ping').catch(() => {});
}

// Posters are asked for one at a time, and again only when the project changed since.
const posterQueue = [];
let posterBusy = null; // { projectId, done }
function wantPoster(p) {
  const have = state.posters.get(p.id);
  if ((have && have.revision === p.revision) || posterQueue.includes(p.id) || posterBusy?.projectId === p.id) return;
  posterQueue.push(p.id);
  nextPoster();
}
async function nextPoster() {
  if (posterBusy || !state.online) return;
  const projectId = posterQueue.shift();
  if (!projectId) return;
  const revision = (state.snapshot?.projects ?? []).find((p) => p.id === projectId)?.revision;
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 20_000);
    posterBusy = { projectId, revision, done: () => (clearTimeout(timer), resolve()) };
    command('poster', { projectId }).then((ok) => ok || posterBusy?.done());
  });
  posterBusy = null;
  nextPoster();
}
async function gotPoster(ev) {
  const busy = posterBusy?.projectId === ev.projectId ? posterBusy : null;
  try {
    const old = state.posters.get(ev.projectId);
    const revision = busy?.revision ?? old?.revision ?? null;
    if (!ev.blob) state.posters.set(ev.projectId, { key: null, url: null, revision });
    else if (old?.key === ev.key && old.url) state.posters.set(ev.projectId, { ...old, revision });
    else {
      const file = await blob(ev.blob);
      const url = URL.createObjectURL(new Blob([fromBase64(file.data)], { type: file.type }));
      if (old?.url) URL.revokeObjectURL(old.url);
      state.posters.set(ev.projectId, { key: ev.key, url, revision });
    }
  } catch {
    // the file expired or the relay restarted: asked again next time
  } finally {
    busy?.done();
  }
}

// The open project's detail is asked for on arrival and whenever the Mac says it changed.
let openAsked = { id: null, revision: null, at: 0 };
function refreshOpenProject(force = false) {
  const r = route();
  if (r.name !== 'project' || !state.online) return;
  const summary = (state.snapshot?.projects ?? []).find((p) => p.id === r.id);
  if (summary) wantPoster(summary);
  // Asked again when the timeline changes, a render starts, or one ends.
  const running = (state.snapshot?.jobs ?? []).filter((j) => j.projectId === r.id).map((j) => j.id);
  const ended = (state.snapshot?.recent ?? []).filter((j) => j.projectId === r.id).length;
  const stamp = `${summary?.revision ?? null}:${running.join(',')}:${ended}`;
  if (!force && openAsked.id === r.id && openAsked.revision === stamp && Date.now() - openAsked.at < 60_000) return;
  openAsked = { id: r.id, revision: stamp, at: Date.now() };
  command('project.open', { projectId: r.id }).catch(() => {});
}

function afterSnapshot() {
  const projects = state.snapshot?.projects ?? [];
  for (const p of projects.slice(0, 30)) wantPoster(p);
  refreshOpenProject();
}

async function onEvent(name, data) {
  if (name === 'agent') {
    const was = state.online;
    state.online = Boolean(data.online);
    if (state.online && !was) {
      setTimeout(ping, 300);
      nextPoster();
    }
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
    if (ev.t === 'snapshot') {
      state.snapshot = ev;
      afterSnapshot();
    } else if (ev.t === 'jobs' && state.snapshot) {
      state.snapshot = { ...state.snapshot, jobs: ev.jobs };
      refreshOpenProject();
    } else if (ev.t === 'project') state.details.set(ev.project.id, ev.project);
    else if (ev.t === 'poster') await gotPoster(ev);
    else if (ev.t === 'push') {
      if (ev.tested) toast('Test sent. It should arrive in a moment.');
    } else if (ev.t === 'pong' && pingAt) {
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

// ── notifications ──────────────────────────────────────────────────────────
async function registration() {
  if (!('serviceWorker' in navigator)) return null;
  await navigator.serviceWorker.register('/sw.js');
  return navigator.serviceWorker.ready;
}

function urlBase64(text) {
  return fromBase64(text.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(text.length / 4) * 4, '='));
}

async function pushOn() {
  const key = state.snapshot?.pushKey;
  if (!key || !state.online) return toast('Your Mac isn’t connected. Try again once it’s online.');
  state.push.busy = true;
  render();
  try {
    if ((await Notification.requestPermission()) !== 'granted') throw new Error('Notifications weren’t allowed.');
    const reg = await registration();
    const want = urlBase64(key);
    let sub = await reg.pushManager.getSubscription();
    // Subscribed for another Mac's key (re-paired with a different Mac): start over.
    const have = sub?.options?.applicationServerKey ? new Uint8Array(sub.options.applicationServerKey) : null;
    if (sub && have && (have.length !== want.length || have.some((b, i) => b !== want[i]))) {
      await sub.unsubscribe();
      sub = null;
    }
    sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: want });
    const json = sub.toJSON();
    if (!(await command('push.subscribe', { endpoint: json.endpoint, keys: json.keys, prefs: prefs() }))) throw new Error('Your Mac isn’t connected.');
    state.push.subscribed = true;
  } catch (e) {
    toast(e instanceof Error ? e.message : String(e));
  } finally {
    state.push.busy = false;
    render();
  }
}

async function pushOff({ quiet = false } = {}) {
  const reg = 'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration() : null;
  const sub = await reg?.pushManager.getSubscription();
  if (!sub) return;
  state.push.busy = true;
  if (!quiet) render();
  try {
    await command('push.unsubscribe', { endpoint: sub.endpoint }).catch(() => false);
    await sub.unsubscribe();
    state.push.subscribed = false;
  } finally {
    state.push.busy = false;
    if (!quiet) render();
  }
}

async function pushTest() {
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  if (!sub) return;
  if (!(await command('push.test', { endpoint: sub.endpoint }))) toast('Your Mac isn’t connected.');
}

async function pushInit() {
  try {
    if (pushSupport() !== 'ok') return;
    const reg = await registration();
    state.push.subscribed = Boolean(await reg?.pushManager.getSubscription());
  } catch {
    // no service worker (private browsing, say): the Settings card explains
  } finally {
    state.push.ready = true;
    render();
  }
}

// A tapped notification, when the app is already open.
navigator.serviceWorker?.addEventListener('message', (e) => {
  if (typeof e.data?.open === 'string' && e.data.open.startsWith('/')) location.hash = new URL(e.data.open, location.origin).hash || '#/';
});

window.addEventListener('hashchange', () => {
  render();
  refreshOpenProject(true);
  window.scrollTo(0, 0);
});

// Coming back to the app (iOS suspends it): refresh the round trip and what's on screen.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return closeScanner(); // never leave the camera on in the background
  ping();
  refreshOpenProject(true);
});
setInterval(() => state.token && state.problem !== 'unpaired' && render(), 30_000); // keeps "edited 2 min ago" honest (never while a link is being pasted)

(async () => {
  const secret = takeSecretFromLink();
  if (secret) {
    const keys = await deriveKeys(secret);
    state.token = keys.token;
    state.key = keys.key;
  }
  render();
  if (state.token) {
    stream();
    pushInit();
  }
})();
