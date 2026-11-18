// ReelForge Remote, the phone app: direct the agent editing on your Mac from anywhere.
// Talks only to the relay that served it (core.js); everything it sends and receives is sealed with keys
// the relay never has. Screens: Projects, Session, Exports (dock), Review, and pairing.
import * as core from './core.js';
import { codeFromText, formatCode } from './pairing.js';
import { ago, aspect, button, clock, closeSheet, duration, h, icon, iconButton, logo, pill, plural, progress, sheet, sheetIsOpen, size } from './ui.js';

const { saved, live } = core;
const app = document.getElementById('app');
const toastEl = document.getElementById('toast');

// ── routes ──────────────────────────────────────────────────────────────────
// #/projects · #/session[/<id>] · #/review/<project>/<version> · #/exports · #/pair[=CODE]
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
function route() {
  const hash = location.hash;
  let m;
  if (/^#\/?pair/.test(hash) || /[#&]pair=/.test(hash)) return { name: 'pair', code: codeFromText(hash) };
  if ((m = new RegExp(`^#/session/(${UUID})$`, 'i').exec(hash))) return { name: 'session', id: m[1] };
  if (hash === '#/session') return { name: 'session', id: null };
  if ((m = new RegExp(`^#/review/(${UUID})/(${UUID})$`, 'i').exec(hash))) return { name: 'review', id: m[1], version: m[2] };
  if (hash === '#/exports') return { name: 'exports' };
  return { name: 'projects' };
}
const go = (hash) => {
  if (location.hash !== hash) location.hash = hash;
  else render();
};

// ── helpers over the cached snapshot ────────────────────────────────────────
const pairing = () => core.activePairing();
const cache = () => (pairing() ? core.macCache(pairing().macId) : null);
const snap = () => cache()?.snapshot ?? null;
const projects = () => snap()?.projects ?? [];
const projectById = (id) => projects().find((p) => p.id === id) ?? null;
const detailOf = (id) => cache()?.details?.[id] ?? null;
const jobsOf = (id) => (snap()?.jobs ?? []).filter((j) => j.projectId === id);
const askOf = (id) => (snap()?.asks ?? []).find((a) => a.projectId === id) ?? null;
const isLive = () => core.status().live;

function lastProjectId() {
  const c = cache();
  const id = c?.lastProject;
  if (id && projectById(id)) return id;
  return null;
}
function rememberProject(id) {
  const c = cache();
  if (c && c.lastProject !== id) {
    c.lastProject = id;
    core.persist();
  }
}

/** One line about a project: what the agent or a render is doing, or what's waiting for the user. */
function projectState(p) {
  const ask = askOf(p.id);
  const job = jobsOf(p.id)[0];
  const queued = core.instructionsFor(p.id).filter((x) => ['local', 'queued'].includes(x.state)).length;
  if (ask) return { text: 'Agent editing', tone: 'mint', icon: 'director', busy: true };
  if (job) return { text: job.kind === 'export' ? `Exporting ${Math.round(job.progress * 100)}%` : 'Rendering preview', tone: 'orange', icon: 'film', busy: true };
  if (p.pendingProposals) return { text: 'Review ready', tone: 'mint', icon: 'checkCircle' };
  if (queued) return { text: `${plural(queued, 'instruction')} queued`, tone: 'neutral', icon: 'queue' };
  return { text: 'Ready', tone: 'ok', icon: null };
}

// ── header, connection strip, dock ──────────────────────────────────────────
function header({ back = null, menu = null } = {}) {
  const st = core.status();
  const agentBusy = projects().some((p) => askOf(p.id)) ? 'edit' : (snap()?.jobs ?? []).length ? 'render' : 'idle';
  return h(
    'header',
    { class: 'top' },
    back ? iconButton('back', 'Back', () => (history.length > 1 ? history.back() : go(back))) : h('span', { class: 'top-spacer' }),
    h('div', { class: 'brand' }, logo(st.live ? agentBusy : 'idle'), h('div', { class: 'wordmark' }, h('b', { text: 'ReelForge' }), h('span', { text: 'Remote' }))),
    menu ? iconButton('more', 'More actions', menu) : h('span', { class: 'top-spacer' }),
  );
}

function statusWords() {
  const st = core.status();
  if (live.revoked) return { word: 'Not paired', tone: 'error', detail: null };
  if (st.transport === 'connecting') return { word: 'Connecting', tone: 'neutral', detail: null };
  if (st.transport === 'reconnecting' || st.transport === 'disconnected') return { word: 'Reconnecting', tone: 'warn', detail: st.lastSeen ? `Last seen ${ago(st.lastSeen)}` : null };
  if (st.engine === 'stopped') return { word: 'Stopped', tone: 'neutral', detail: 'Engine stopped on the Mac' };
  if (st.engine === 'unavailable') return { word: 'Unavailable', tone: 'warn', detail: st.lastSeen ? `Last seen ${ago(st.lastSeen)}` : null };
  if (st.engine === 'busy') return { word: 'Editing', tone: 'orange', detail: st.editor === 'closed' ? 'Editor closed · engine on' : null };
  return { word: 'Ready', tone: 'ok', detail: st.editor === 'closed' ? 'Editor closed · engine on' : null };
}

function connectionStrip() {
  const p = pairing();
  const w = statusWords();
  return h(
    'button',
    { class: `strip ${w.tone}`, type: 'button', onclick: openDeviceSheet, 'aria-label': `${p?.macName ?? 'Mac'}: ${w.word}${w.detail ? `, ${w.detail}` : ''}. Device and pairing` },
    h('span', { class: `dot ${w.tone}`, 'aria-hidden': 'true' }),
    h(
      'span',
      { class: 'strip-text' },
      h('span', { class: 'strip-main' }, h('span', { class: 'strip-name', text: p?.macName ?? 'Mac' }), h('span', { class: 'sep', text: '·' }), h('span', { class: 'strip-word', text: w.word })),
      w.detail ? h('span', { class: 'strip-detail', text: w.detail }) : null,
    ),
    icon('chevronRight', { size: 16 }),
  );
}

function dock(current) {
  const tab = (name, label, hash, iconName, badge) =>
    h(
      'a',
      { class: `tab${current === name ? ' on' : ''}`, href: hash, 'aria-current': current === name ? 'page' : null },
      h('span', { class: 'tab-ic' }, icon(iconName, { size: 22 }), badge ? h('span', { class: 'badge', text: String(badge), 'aria-label': `${badge} new` }) : null),
      h('span', { class: 'tab-label', text: label }),
    );
  const reviews = projects().reduce((n, p) => n + (p.pendingProposals || 0), 0);
  const running = (snap()?.jobs ?? []).filter((j) => j.kind === 'export').length;
  const sessionId = lastProjectId();
  return h(
    'nav',
    { class: 'dock', 'aria-label': 'Sections' },
    tab('projects', 'Projects', '#/projects', 'projects'),
    tab('session', 'Session', sessionId ? `#/session/${sessionId}` : '#/session', 'session', reviews || null),
    tab('exports', 'Exports', '#/exports', 'exports', running || null),
  );
}

/** Shown in place of live status when the Mac can't be reached: what we know, and what to check. */
function unavailableCard({ compact = false } = {}) {
  const st = core.status();
  const w = statusWords();
  if (st.live || st.transport === 'connecting') return null;
  const stopped = st.engine === 'stopped';
  return h(
    'section',
    { class: 'card notice warn' },
    h('div', { class: 'row gap' }, icon(stopped ? 'power' : 'wifiOff'), h('div', { class: 'grow' }, h('b', { text: `${pairing()?.macName ?? 'Your Mac'} is ${stopped ? 'stopped' : w.word.toLowerCase()}` }), h('p', { class: 'muted', text: w.detail ?? 'Waiting for it to connect.' }))),
    compact
      ? null
      : h(
          'ul',
          { class: 'help' },
          stopped
            ? h('li', { text: 'ReelForge Engine was stopped on the Mac (Stop Engine & Disconnect). Start it again from ReelForge there.' })
            : [
                h('li', { text: 'Is the Mac on and connected to the internet? A Mac that sleeps can’t be reached.' }),
                h('li', { text: 'Is ReelForge Engine running? On the Mac: Settings → Remote Access. Start Engine at Login keeps it there after a restart.' }),
                h('li', { text: 'On a laptop, Remote Ready keeps it awake while it’s on power. A closed lid still sleeps it.' }),
              ],
        ),
    h('p', { class: 'muted small', text: 'You can still look at what was synced and queue instructions; they run when the Mac is back.' }),
    h('div', { class: 'row gap mt' }, button('Retry connection', { iconName: 'refresh', small: true, onclick: () => core.connect() })),
  );
}

// ── Projects ────────────────────────────────────────────────────────────────
let projectQuery = '';
function projectsScreen() {
  const s = snap();
  const list = projects();
  const st = core.status();
  const body = [];
  body.push(h('h1', { class: 'title', text: 'Your projects' }));
  if (s && !st.live && cache()?.syncedAt) body.push(h('p', { class: 'synced', text: `Last synced ${ago(cache().syncedAt)} · saved on this phone` }));
  if (!st.live) body.push(unavailableCard({ compact: true }));
  if (!s) {
    if (st.transport === 'connecting' || (st.transport === 'connected' && !live.relayWaiting && live.agentOnline)) return [...body, skeleton()];
    return [...body, h('section', { class: 'card empty' }, h('p', { text: 'Nothing synced from your Mac yet. It will appear here once the Mac connects.' }), button('Retry', { iconName: 'refresh', small: true, onclick: () => core.connect() }))];
  }
  if (!list.length) return [...body, h('section', { class: 'card empty' }, icon('projects', { size: 28 }), h('p', { text: 'No projects yet. Create one in ReelForge on your Mac.' }))];

  if (list.length > 6) {
    const input = h('input', { class: 'search', type: 'search', placeholder: 'Search projects', value: projectQuery, 'aria-label': 'Search projects', oninput: (e) => ((projectQuery = e.target.value), render()) });
    body.push(h('label', { class: 'search-wrap' }, icon('search', { size: 18 }), input));
  }
  const q = projectQuery.trim().toLowerCase();
  const filtered = q ? list.filter((p) => p.name.toLowerCase().includes(q)) : list;
  const activeId = lastProjectId() ?? [...list].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]?.id;
  const active = !q ? filtered.find((p) => p.id === activeId) : null;
  if (active) body.push(heroCard(active));
  const rest = filtered.filter((p) => p !== active);
  if (rest.length) body.push(h('div', { class: 'list' }, rest.map(projectRow)));
  if (!filtered.length) body.push(h('p', { class: 'muted', text: 'No project matches.' }));

  const exps = (s.exports ?? []).filter((e) => e.state === 'completed').slice(0, 2);
  if (exps.length) {
    body.push(h('div', { class: 'section-head' }, h('h2', { text: 'Recent exports' }), h('a', { class: 'link', href: '#/exports' }, 'See all', icon('chevronRight', { size: 16 }))));
    body.push(h('div', { class: 'list' }, exps.map((e) => exportRow(e, { compact: true }))));
  }
  return body;
}

function poster(projectId, cls = '') {
  const url = live.posters.get(projectId)?.url;
  return h('div', { class: `poster ${cls}` }, url ? h('img', { src: url, alt: '' }) : icon('film', { size: 26 }));
}

function heroCard(p) {
  const s = projectState(p);
  const meta = [
    h('span', { class: 'meta' }, icon('phone', { size: 16 }), `${aspect(p.width, p.height)}`),
    p.durationFrames ? h('span', { class: 'meta tabular' }, icon('clock', { size: 16 }), duration(p.durationFrames, p.fps)) : null,
    h('span', { class: 'meta' }, icon('history', { size: 16 }), `Updated ${ago(p.updatedAt)}`),
  ];
  return h(
    'section',
    { class: 'card hero' },
    h('div', { class: 'hero-art' }, poster(p.id, 'wide'), s.tone !== 'ok' ? h('span', { class: `badge-float ${s.tone}` }, s.icon ? icon(s.icon, { size: 15 }) : null, s.text) : null),
    h('h3', { class: 'hero-name', text: p.name }),
    h('div', { class: 'meta-row' }, meta),
    button('Open session', { kind: 'primary', iconName: 'play', full: true, onclick: () => openSession(p.id) }),
  );
}

function projectRow(p) {
  const s = projectState(p);
  return h(
    'button',
    { class: 'row-card', type: 'button', onclick: () => openSession(p.id), 'aria-label': `${p.name}, ${s.text}. Open session` },
    poster(p.id, 'thumb'),
    h('span', { class: 'row-text' }, h('b', { text: p.name }), h('span', { class: `state ${s.tone}` }, s.icon ? icon(s.icon, { size: 14 }) : h('span', { class: `dot ${s.tone}` }), s.text)),
    icon('chevronRight', { size: 18 }),
  );
}

function skeleton() {
  return h('div', { class: 'skeleton', 'aria-busy': 'true', 'aria-label': 'Loading projects' }, h('div', { class: 'sk hero-sk' }), h('div', { class: 'sk row-sk' }), h('div', { class: 'sk row-sk' }));
}

function openSession(id) {
  rememberProject(id);
  go(`#/session/${id}`);
}

// ── Session ─────────────────────────────────────────────────────────────────
function sessionScreen(r) {
  const id = r.id ?? lastProjectId();
  if (!id || !projectById(id)) {
    return [
      h('h1', { class: 'title', text: 'Session' }),
      h('section', { class: 'card empty' }, icon('session', { size: 28 }), h('p', { text: 'Pick a project to direct. Its preview, the agent’s work and your conversation live here.' }), button('Choose project', { kind: 'primary', onclick: chooseProjectSheet })),
    ];
  }
  if (r.id !== id) history.replaceState(null, '', `#/session/${id}`);
  rememberProject(id);
  core.openProject(id);
  void core.restorePreview(id);
  const p = projectById(id);
  const d = detailOf(id);
  return [
    h('div', { class: 'title-row' }, h('button', { class: 'title-switch', type: 'button', onclick: chooseProjectSheet, 'aria-label': `${p.name}. Switch project` }, h('h1', { class: 'title', text: p.name }), icon('chevronDown', { size: 18 }))),
    unavailableCard({ compact: false }),
    previewCard(p, d),
    activityCard(p, d),
    conversation(p, d),
  ];
}

function chooseProjectSheet() {
  const list = projects();
  sheet(
    'Choose project',
    list.length
      ? h('div', { class: 'list' }, list.map((p) => h('button', { class: 'row-card', type: 'button', onclick: () => (closeSheet(), openSession(p.id)) }, poster(p.id, 'thumb'), h('span', { class: 'row-text' }, h('b', { text: p.name }), h('span', { class: 'muted', text: `${aspect(p.width, p.height)} · updated ${ago(p.updatedAt)}` })), icon('chevronRight', { size: 18 }))))
      : h('p', { class: 'muted', text: 'No projects synced yet.' }),
  );
}

// The player is kept between redraws so playback isn't interrupted every time the state changes.
const players = new Map(); // projectId → { root, video, url, ... }
let previewCollapsed = false;

function player(projectId, pv) {
  let pl = players.get(projectId);
  if (!pl) {
    const video = h('video', { playsinline: true, preload: 'metadata', class: 'video' });
    const playBtn = iconButton('play', 'Play', () => (video.paused ? video.play() : video.pause()), { cls: 'ctl' });
    const time = h('span', { class: 'time tabular', text: '00:00 / 00:00' });
    const seek = h('input', { class: 'seek', type: 'range', min: 0, max: 1000, value: 0, step: 1, 'aria-label': 'Seek' });
    const muteBtn = iconButton('volume', 'Mute', () => (video.muted = !video.muted), { cls: 'ctl' });
    const fullBtn = iconButton('maximize', 'Full screen', () => (video.requestFullscreen ? video.requestFullscreen() : video.webkitEnterFullscreen?.()), { cls: 'ctl' });
    const sync = () => {
      const dur = Number.isFinite(video.duration) ? video.duration : 0;
      time.textContent = `${clock(video.currentTime)} / ${clock(dur)}`;
      if (!seeking) seek.value = String(dur ? Math.round((video.currentTime / dur) * 1000) : 0);
      seek.style.setProperty('--p', `${dur ? (video.currentTime / dur) * 100 : 0}%`);
      playBtn.replaceChildren(icon(video.paused ? 'play' : 'pause'));
      playBtn.setAttribute('aria-label', video.paused ? 'Play' : 'Pause');
      muteBtn.replaceChildren(icon(video.muted ? 'mute' : 'volume'));
      muteBtn.setAttribute('aria-label', video.muted ? 'Unmute' : 'Mute');
    };
    let seeking = false;
    seek.addEventListener('pointerdown', () => (seeking = true));
    seek.addEventListener('input', () => {
      if (Number.isFinite(video.duration)) video.currentTime = (Number(seek.value) / 1000) * video.duration;
    });
    seek.addEventListener('change', () => (seeking = false));
    for (const ev of ['timeupdate', 'play', 'pause', 'loadedmetadata', 'volumechange', 'ended']) video.addEventListener(ev, sync);
    video.addEventListener('click', () => (video.paused ? video.play() : video.pause()));
    const root = h('div', { class: 'player' }, h('div', { class: 'frame' }, video), h('div', { class: 'controls' }, playBtn, time, seek, muteBtn, fullBtn));
    pl = { root, video, url: null, sync };
    players.set(projectId, pl);
  }
  if (pv?.url && pl.url !== pv.url) {
    // A newer preview arrived: swap it in, keeping the position, never starting playback by itself.
    const at = pl.video.currentTime;
    pl.video.src = pv.url;
    pl.url = pv.url;
    pl.video.addEventListener('loadedmetadata', () => (pl.video.currentTime = Math.min(at, pl.video.duration || 0)), { once: true });
  }
  const w = pv?.width ?? 9;
  const hh = pv?.height ?? 16;
  pl.root.querySelector('.frame').style.setProperty('--arw', String(w));
  pl.root.querySelector('.frame').style.setProperty('--arh', String(hh));
  return pl.root;
}

function previewCard(p, d) {
  const pv = live.previews.get(p.id);
  const remote = d?.preview ?? null; // what the Mac has
  const st = core.status();
  const rendering = jobsOf(p.id).find((j) => j.kind === 'preview');
  let label;
  let tone = 'neutral';
  if (pv?.url) {
    const current = pv.revision === p.revision;
    if (!st.live) label = `Last preview · Updated ${ago(pv.updatedAt)}`;
    else if (current) (label = `Preview · revision ${pv.revision}`), (tone = 'ok');
    else label = `Older preview · revision ${pv.revision} (timeline changed since)`;
  } else if (pv?.state === 'loading') label = 'Loading preview…';
  else label = st.live ? 'No preview of this timeline yet' : 'No preview saved on this phone';

  const actions = [];
  if (st.live && !rendering && (!remote || !remote.current) && (!pv?.url || pv.revision !== p.revision)) {
    actions.push(button('Render preview', { small: true, iconName: 'film', onclick: () => startPreview(p.id) }));
  }
  if (st.live && remote?.state === 'completed' && remote.current && pv?.jobId !== remote.jobId && pv?.state !== 'loading') {
    actions.push(button(`Load latest preview${remote.sizeBytes ? ` (${size(remote.sizeBytes)})` : ''}`, { small: true, iconName: 'exports', onclick: () => core.loadPreview(p.id, remote) }));
  }
  const body = [];
  if (!previewCollapsed) {
    if (pv?.url) body.push(player(p.id, pv));
    else body.push(h('div', { class: 'player placeholder' }, h('div', { class: 'frame', vars: { '--arw': p.width, '--arh': p.height } }, live.posters.get(p.id)?.url ? h('img', { src: live.posters.get(p.id).url, alt: '' }) : icon('film', { size: 30 }))));
    if (pv?.state === 'loading') body.push(progress(pv.progress, 'Loading preview'));
    if (rendering) body.push(h('div', { class: 'row gap small' }, h('span', { text: `Rendering preview ${rendering.state === 'queued' ? '(waiting)' : `${Math.round(rendering.progress * 100)}%`}` })), progress(rendering.state === 'queued' ? null : rendering.progress, 'Rendering preview'));
  }
  return h(
    'section',
    { class: 'card preview' },
    h(
      'div',
      { class: 'card-head' },
      h('span', { class: `small ${tone === 'ok' ? 'ok-text' : 'muted'}`, text: label }),
      iconButton(previewCollapsed ? 'chevronDown' : 'chevronUp', previewCollapsed ? 'Show preview' : 'Hide preview', () => ((previewCollapsed = !previewCollapsed), render())),
    ),
    body,
    actions.length ? h('div', { class: 'row gap wrap mt' }, actions) : null,
  );
}

async function startPreview(projectId) {
  const r = await core.command('preview.start', { projectId });
  if (!r) return toast('Your Mac isn’t connected.');
  if (r.t === 'error') return toast(r.message);
  core.openProject(projectId, true);
}

/** What the agent (or a render) is doing on this project right now, from real events only. */
function activityCard(p, d) {
  const ask = askOf(p.id) ?? d?.asking ?? null;
  const st = core.status();
  const pending = core.instructionsFor(p.id).find((x) => ['accepted', 'running'].includes(x.state));
  const job = jobsOf(p.id).find((j) => j.kind === 'export');
  if (!ask && !pending && !job) return null;
  if (ask || pending) {
    const since = ask?.startedAt ? ago(ask.startedAt) : null;
    const steps = [
      { label: 'Queued', state: 'done' },
      { label: 'Accepted', state: 'done' },
      { label: 'Planning', state: 'active' },
      { label: 'Review', state: 'pending' },
    ];
    return h(
      'section',
      { class: 'card activity', 'aria-live': 'polite' },
      h(
        'div',
        { class: 'card-head' },
        h('div', { class: 'row gap' }, icon('director'), h('div', {}, h('b', { text: 'Agent is planning changes' }), h('p', { class: 'muted small', text: `${clipText(ask?.instruction ?? pending?.instruction ?? '', 70)}${since ? ` · started ${since}` : ''}` }))),
      ),
      h('ol', { class: 'steps' }, steps.map((s) => h('li', { class: s.state }, h('span', { class: 'step-dot', 'aria-hidden': 'true' }, s.state === 'done' ? icon('check', { size: 12 }) : null), h('span', { text: s.label }), h('span', { class: 'sr', text: s.state === 'done' ? ' complete' : s.state === 'active' ? ' in progress' : ' pending' })))),
      progress(null, 'Planning'),
      st.live
        ? h('div', { class: 'row between mt' }, h('p', { class: 'muted small', text: 'Cancel stops the request. Nothing on your timeline changes.' }), button('Cancel', { small: true, kind: 'ghost', iconName: 'x', onclick: () => cancelAsk(p.id) }))
        : h('p', { class: 'muted small mt', text: 'Status from before the connection dropped. It’s confirmed once your Mac is back.' }),
    );
  }
  return h(
    'section',
    { class: 'card activity' },
    h('div', { class: 'card-head' }, h('div', { class: 'row gap' }, icon('exports'), h('div', {}, h('b', { text: 'Exporting' }), h('p', { class: 'muted small tabular', text: job.state === 'queued' ? 'Waiting for the renderer' : `${capital(job.state)} · ${Math.round(job.progress * 100)}%` })))),
    progress(job.state === 'queued' ? null : job.progress, 'Export progress'),
    h('div', { class: 'row between mt' }, h('a', { class: 'link', href: '#/exports' }, 'Open Exports', icon('chevronRight', { size: 16 }))),
  );
}

async function cancelAsk(projectId) {
  const r = await core.command('ai.cancel', { projectId });
  if (!r) toast('Your Mac isn’t connected.');
}

/** User messages and the agent's answers (versions), plus instructions not answered yet. */
function conversation(p, d) {
  const items = [];
  const versions = [...(d?.versions ?? [])].reverse(); // oldest first
  for (const v of versions) {
    items.push({ at: Date.parse(v.createdAt) - 1, node: userBubble(stripAbout(v.instruction), v.createdAt, v.requestedBy === 'mcp' ? 'From an AI app' : null) });
    items.push({ at: Date.parse(v.createdAt), node: versionCard(p, v) });
  }
  const shown = new Set(versions.map((v) => v.id));
  for (const it of core.instructionsFor(p.id)) {
    if (it.state === 'done' && (!it.proposalId || shown.has(it.proposalId))) continue;
    if (it.state === 'cancelled' && Date.now() - (it.finishedAt ?? 0) > 60_000) continue;
    items.push({ at: it.createdAt, node: instructionCard(p, it) });
  }
  const techs = live.activity.filter((a) => a.projectId === p.id);
  if (techs.length) items.push({ at: techs.at(-1).at, node: h('details', { class: 'tech' }, h('summary', { text: `Activity · ${plural(techs.length, 'update')}` }), h('ul', {}, techs.map((a) => h('li', { text: `${ago(a.at)} · ${a.text}` })))) });
  items.sort((a, b) => a.at - b.at);
  return h(
    'section',
    { class: 'conversation', 'aria-label': 'Conversation' },
    items.length ? items.map((i) => i.node) : h('p', { class: 'muted center', text: d ? 'Tell the agent what to change. It proposes; you review before anything is applied.' : isLive() ? 'Loading the conversation…' : 'The conversation appears once your Mac has synced this project.' }),
  );
}

const stripAbout = (text) => String(text ?? '').replace(/\n\n\(About the earlier proposal[\s\S]*\)$/, '');

function userBubble(text, when, note) {
  return h('div', { class: 'msg user' }, h('p', { text }), h('span', { class: 'msg-meta', text: [note, when ? ago(when) : null].filter(Boolean).join(' · ') }));
}

const VERSION_STATUS = {
  pending: ['Waiting for review', 'mint', 'checkCircle'],
  applied: ['Applied', 'ok', 'check'],
  rejected: ['Dismissed', 'neutral', 'x'],
  stale: ['Out of date', 'warn', 'alert'],
};

function versionCard(p, v) {
  const [text, tone, ic] = v.stale ? VERSION_STATUS.stale : (VERSION_STATUS[v.status] ?? [capital(v.status), 'neutral', null]);
  return h(
    'div',
    { class: 'msg agent' },
    h('div', { class: 'agent-head' }, icon('director', { size: 16 }), h('b', { text: `Version ${v.version}` }), pill(text, tone, ic)),
    h('p', { text: v.summary || 'No changes proposed.' }),
    v.changes ? h('p', { class: 'muted small', text: `${plural(v.changes, 'change')}${v.warnings.length ? ` · ${plural(v.warnings.length, 'warning')}` : ''}` }) : null,
    h('div', { class: 'row gap mt' }, button(v.status === 'pending' && !v.stale ? 'Review' : 'Details', { small: true, kind: v.status === 'pending' && !v.stale ? 'mint' : 'secondary', iconName: 'chevronRight', onclick: () => go(`#/review/${p.id}/${v.id}`) })),
  );
}

const INSTRUCTION_STATE = {
  local: ['Saved on this phone', 'neutral', 'phone', 'It goes to the relay as soon as there’s a connection.'],
  queued: ['Queued', 'neutral', 'queue', 'Waiting on the relay. It runs when your Mac takes it.'],
  accepted: ['Accepted', 'mint', 'check', 'Your Mac took it.'],
  running: ['Running', 'orange', 'director', 'The agent is working on it.'],
  needs_review: ['Needs review', 'warn', 'alert', null],
  done: ['Review ready', 'mint', 'checkCircle', null],
  failed: ['Failed', 'error', 'alert', null],
  expired: ['Expired', 'neutral', 'clock', 'It waited too long and was not run.'],
  cancelled: ['Cancelled', 'neutral', 'x', null],
};

function instructionCard(p, it) {
  const [text, tone, ic, hint] = INSTRUCTION_STATE[it.state] ?? [capital(it.state), 'neutral', null, null];
  const editable = ['local', 'queued'].includes(it.state);
  const actions = [];
  if (editable) {
    actions.push(button('Edit', { small: true, iconName: 'pencil', onclick: () => editInstructionSheet(it) }));
    actions.push(button('Cancel', { small: true, kind: 'ghost', iconName: 'x', onclick: () => core.cancelInstruction(it.id) }));
  }
  if (it.state === 'needs_review') {
    actions.push(button('Run on current timeline', { small: true, kind: 'mint', onclick: () => core.rerunInstruction(it.id) }));
    actions.push(button('Cancel', { small: true, kind: 'ghost', iconName: 'x', onclick: () => core.cancelInstruction(it.id) }));
  }
  if (it.state === 'failed' || it.state === 'expired') actions.push(button('Try again', { small: true, iconName: 'refresh', onclick: () => core.rerunInstruction(it.id) }));
  if (it.state === 'done' && it.proposalId) actions.push(button('Review', { small: true, kind: 'mint', onclick: () => go(`#/review/${p.id}/${it.proposalId}`) }));
  const why =
    it.state === 'needs_review'
      ? `The timeline changed on your Mac since you wrote this (revision ${it.baseRevision} → ${it.currentRevision}). Run it on the timeline as it is now, or cancel it.`
      : it.state === 'failed'
        ? it.error ?? 'The agent couldn’t do that.'
        : hint;
  return h(
    'div',
    { class: 'msg-group' },
    userBubble(it.instruction, it.createdAt, it.about ? 'About a version' : null),
    h('div', { class: `msg status ${tone}` }, h('div', { class: 'agent-head' }, pill(text, tone, ic)), why ? h('p', { class: 'small', text: why }) : null, actions.length ? h('div', { class: 'row gap wrap mt' }, actions) : null),
  );
}

function editInstructionSheet(it) {
  const area = h('textarea', { class: 'field', rows: 4, 'aria-label': 'Instruction', value: it.instruction });
  sheet(
    'Edit instruction',
    h(
      'div',
      { class: 'stack' },
      area,
      h('p', { class: 'muted small', text: 'You can change it until your Mac takes it.' }),
      button('Save', {
        kind: 'mint',
        full: true,
        onclick: async () => {
          const text = area.value.trim();
          if (!text) return;
          if (await core.editInstruction(it.id, text)) closeSheet();
        },
      }),
    ),
  );
}

// ── composer ────────────────────────────────────────────────────────────────
const composers = new Map(); // projectId → element (kept so typing isn't interrupted by redraws)
let pendingAbout = null; // { projectId, versionId, version }

function composer(projectId) {
  let c = composers.get(projectId);
  const st = core.status();
  if (!c) {
    const area = h('textarea', { class: 'composer-input', rows: 1, placeholder: 'Tell the agent what to change…', 'aria-label': 'Instruction for the agent', enterkeyhint: 'send', autocapitalize: 'sentences' });
    area.value = saved.drafts[core.draftKey(projectId)] ?? '';
    const file = h('input', { type: 'file', accept: 'video/*,image/*,audio/*', class: 'visually-hidden', tabindex: '-1', 'aria-hidden': 'true' });
    const attach = iconButton('attach', 'Attach a clip or photo', () => {
      if (!isLive()) return toast('Attachments go straight to your Mac, so it needs to be online.');
      file.click();
    }, { cls: 'attach' });
    const sendBtn = h('button', { class: 'send', type: 'button', 'aria-label': 'Send' }, icon('send', { size: 20 }));
    const about = h('div', { class: 'about', hidden: true });
    const hint = h('p', { class: 'composer-hint', hidden: true });
    const uploads = h('div', { class: 'uploads' });
    const grow = () => {
      area.style.height = 'auto';
      const want = area.scrollHeight;
      area.style.height = area.value && want > 44 ? `${Math.min(want, 132)}px` : '';
    };
    area.addEventListener('input', () => {
      core.setDraft(projectId, area.value);
      grow();
    });
    area.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && matchMedia('(hover: hover)').matches) {
        e.preventDefault();
        submit();
      }
    });
    file.addEventListener('change', () => {
      const f = file.files?.[0];
      file.value = '';
      if (f) void core.upload(projectId, f);
    });
    const submit = () => {
      const text = area.value.trim();
      if (!text) return area.focus();
      const ab = pendingAbout?.projectId === projectId ? pendingAbout.versionId : null;
      core.addInstruction(projectId, text, { about: ab });
      pendingAbout = null;
      area.value = '';
      core.setDraft(projectId, '');
      grow();
      maybeAskForNotifications('instruction');
      render();
    };
    sendBtn.addEventListener('click', submit);
    const root = h('div', { class: 'composer', role: 'form', 'aria-label': 'Message the agent' }, about, uploads, hint, h('div', { class: 'composer-row' }, attach, area, sendBtn), file);
    c = { root, area, sendBtn, hint, about, uploads, grow };
    composers.set(projectId, c);
    requestAnimationFrame(grow);
  }
  // Label and hint follow where the instruction will go.
  const offline = !st.live;
  const relayDown = st.transport !== 'connected';
  c.sendBtn.setAttribute('aria-label', offline ? 'Queue instruction' : 'Send');
  c.area.placeholder = offline ? 'Instruction to queue…' : 'Tell the agent what to change…';
  c.sendBtn.classList.toggle('queue', offline);
  c.sendBtn.replaceChildren(offline ? h('span', { class: 'send-label', text: 'Queue' }) : icon('send', { size: 20 }));
  c.hint.hidden = !offline;
  c.hint.textContent = relayDown ? 'Queue instruction · no connection: saved on this phone, sent when you’re back online.' : 'Queue instruction · your Mac is away: it waits in the queue and runs when the Mac connects.';
  const ab = pendingAbout?.projectId === projectId ? pendingAbout : null;
  c.about.hidden = !ab;
  c.about.replaceChildren(...(ab ? [icon('history', { size: 14 }), h('span', { text: `About version ${ab.version}` }), iconButton('x', 'Don’t refer to this version', () => ((pendingAbout = null), render()))] : []));
  const ups = [...live.uploads.entries()].filter(([, u]) => u.projectId === projectId && !(u.state === 'imported' && Date.now() - (u.doneAt ??= Date.now()) > 8000));
  c.uploads.replaceChildren(
    ...ups.map(([uid, u]) =>
      h(
        'div',
        { class: `upload ${u.state}` },
        icon(u.state === 'imported' ? 'checkCircle' : u.state === 'failed' ? 'alert' : 'attach', { size: 16 }),
        h('span', { class: 'grow ellipsis', text: u.state === 'failed' ? `${u.name}: ${u.error ?? 'failed'}` : u.state === 'imported' ? `${u.filename ?? u.name} added to the project` : u.state === 'importing' ? `${u.name} · importing on your Mac` : `${u.name} · ${Math.round((u.progress ?? 0) * 100)}%` }),
        u.state === 'sending' ? iconButton('x', 'Cancel upload', () => core.cancelUpload(uid)) : null,
      ),
    ),
  );
  return c.root;
}

// ── Review ──────────────────────────────────────────────────────────────────
const reviewOpened = new Map(); // `${project}:${version}` → newest version number when opened
const exportChoice = { resolution: 'full', quality: 'standard' };

function reviewScreen(r) {
  const p = projectById(r.id);
  if (!p) return [h('h1', { class: 'title', text: 'Review & export' }), h('section', { class: 'card empty' }, h('p', { text: 'That project isn’t synced on this phone.' }), button('Projects', { onclick: () => go('#/projects') }))];
  rememberProject(p.id);
  core.openProject(p.id);
  const d = detailOf(p.id);
  const v = d?.versions?.find((x) => x.id === r.version);
  if (!v) return [h('h1', { class: 'title', text: 'Review & export' }), d ? h('section', { class: 'card empty' }, h('p', { text: 'This version isn’t in the recent history any more.' })) : skeleton()];
  const key = `${p.id}:${v.id}`;
  const newest = d.versions[0];
  if (!reviewOpened.has(key)) reviewOpened.set(key, newest.version);
  const newer = newest.version > reviewOpened.get(key) && newest.id !== v.id ? newest : null;
  if (!live.exportOptions.has(p.id) && isLive()) void core.command('export.options', { projectId: p.id }, { wait: false });
  const opts = live.exportOptions.get(p.id);
  const pending = v.status === 'pending' && !v.stale;
  const appliedCurrent = v.status === 'applied' && v.appliedRevision === p.revision;
  const exportRevision = pending ? v.baseRevision : v.appliedRevision;
  let cannot = null;
  if (v.stale) cannot = 'The timeline changed since this version was made, so it can’t be applied. Ask the agent again.';
  else if (v.status === 'rejected') cannot = 'This version was dismissed.';
  else if (v.status === 'applied' && !appliedCurrent) cannot = `The timeline changed after this version was applied (now revision ${p.revision}). Export the latest version instead.`;
  else if (!isLive()) cannot = 'Approving and exporting run on your Mac, so it needs to be online.';

  const res = opts?.resolutions?.find((x) => x.id === exportChoice.resolution) ?? opts?.resolutions?.[0];
  const pv = live.previews.get(p.id);
  const requestInput = h('input', {
    class: 'field request',
    type: 'text',
    placeholder: 'Request a change…',
    'aria-label': 'Request a change to this version',
    enterkeyhint: 'go',
    onkeydown: (e) => e.key === 'Enter' && requestChange(p, v, e.target.value),
  });
  return [
    h('h1', { class: 'title', text: 'Review & export' }),
    newer ? h('section', { class: 'card notice mint' }, h('p', { text: `Version ${newer.version} arrived while you were reviewing. You are still looking at version ${v.version}.` }), button(`Open version ${newer.version}`, { small: true, kind: 'mint', onclick: () => go(`#/review/${p.id}/${newer.id}`) })) : null,
    h(
      'section',
      { class: 'card review' },
      h(
        'div',
        { class: 'review-top' },
        h('button', { class: 'review-art', type: 'button', 'aria-label': 'Open the preview in Session', onclick: () => openSession(p.id) }, poster(p.id, 'tall'), h('span', { class: 'play-badge' }, icon('play', { size: 18 }))),
        h(
          'div',
          { class: 'review-text' },
          h('h2', { text: `${p.name} · Version ${v.version}` }),
          pill(...(v.stale ? VERSION_STATUS.stale : (VERSION_STATUS[v.status] ?? [v.status, 'neutral', null]))),
          h('p', { class: 'muted small mt', text: 'Agent summary' }),
          h('p', { text: v.summary || 'No changes proposed.' }),
        ),
      ),
      // The change list as the desktop shows it: what changed, then before → after, from the proposal itself.
      v.list.length
        ? h(
            'ul',
            { class: 'changes' },
            v.list.map((c) =>
              h(
                'li',
                {},
                icon(c.kind === 'removed' ? 'x' : c.kind === 'added' ? 'plus' : 'check', { size: 16 }),
                h(
                  'span',
                  { class: 'grow' },
                  h('span', { class: 'block', text: `${capital(c.kind)} ${c.target}: ${c.label}` }),
                  c.before ? h('span', { class: 'block muted small diff', text: `− ${c.before}` }) : null,
                  c.after ? h('span', { class: 'block small diff', text: `+ ${c.after}` }) : null,
                ),
              ),
            ),
          )
        : null,
      v.changes > v.list.length ? h('p', { class: 'muted small', text: `and ${v.changes - v.list.length} more on your Mac` }) : null,
      v.warnings.length ? h('ul', { class: 'warnings' }, v.warnings.map((w) => h('li', {}, icon('alert', { size: 16 }), h('span', { text: w })))) : null,
      h('p', { class: 'muted small', text: pv?.url ? `The preview in Session shows revision ${pv.revision}${pending ? ', before this version is applied' : ''}.` : pending ? 'There is no preview of this version yet: it is rendered once it is applied.' : '' }),
      h('label', { class: 'request-wrap' }, icon('director', { size: 18 }), requestInput),
    ),
    h('h2', { class: 'section-title', text: 'Export settings' }),
    h(
      'section',
      { class: 'card settings' },
      settingRow('file', 'Format', opts ? `${opts.format}` : 'MP4', null),
      settingRow('crop', 'Resolution', res ? `${res.width} × ${res.height}` : `${p.width} × ${p.height}`, opts ? () => pickSheet('Resolution', opts.resolutions.map((x) => ({ id: x.id, label: `${x.width} × ${x.height}`, note: x.id === 'full' ? 'Project size' : 'Half size, smaller file' })), exportChoice.resolution, (id) => (exportChoice.resolution = id)) : null),
      settingRow('layers', 'Frame rate', `${opts?.fps ?? p.fps} fps`, null),
      settingRow('film', 'Quality', exportChoice.quality === 'small' ? 'Smaller file' : 'Standard', opts ? () => pickSheet('Quality', opts.qualities.map((x) => ({ id: x.id, label: x.label })), exportChoice.quality, (id) => (exportChoice.quality = id)) : null),
      h('p', { class: 'muted small', text: `Saved on ${pairing()?.macName ?? 'your Mac'} in ${opts?.folder ?? 'Movies › ReelForge'}. Frame rate follows the project.` }),
    ),
    cannot ? h('p', { class: 'notice-line', text: cannot }) : null,
    button(pending ? 'Approve & export' : 'Export this version', {
      kind: 'primary',
      iconName: 'exports',
      full: true,
      disabled: Boolean(cannot) || exportBusy,
      onclick: () => approveAndExport(p, v, pending ? v.id : v.status === 'applied' ? v.id : null, exportRevision),
    }),
    pending && isLive() ? button('Dismiss this version', { kind: 'ghost', full: true, onclick: () => dismissVersion(v) }) : null,
    h('div', { class: 'row between mt' }, button('Version history', { small: true, iconName: 'history', onclick: () => versionHistorySheet(p, d) })),
    projectExports(p.id),
  ];
}

function settingRow(iconName, label, value, onclick) {
  const inner = [icon(iconName, { size: 20 }), h('span', { class: 'grow', text: label }), h('span', { class: 'value tabular', text: value }), onclick ? icon('chevronRight', { size: 16 }) : null];
  return onclick ? h('button', { class: 'setting', type: 'button', onclick, 'aria-label': `${label}: ${value}. Change` }, inner) : h('div', { class: 'setting static', 'aria-label': `${label}: ${value}` }, inner);
}

function pickSheet(title, options, current, set) {
  sheet(
    title,
    h(
      'div',
      { class: 'list', role: 'radiogroup', 'aria-label': title },
      options.map((o) =>
        h('button', { class: `option${o.id === current ? ' on' : ''}`, type: 'button', role: 'radio', 'aria-checked': o.id === current ? 'true' : 'false', onclick: () => (set(o.id), closeSheet(), render()) }, h('span', { class: 'grow' }, h('b', { text: o.label }), o.note ? h('span', { class: 'muted small block', text: o.note }) : null), o.id === current ? icon('check', { size: 18 }) : null),
      ),
    ),
  );
}

function versionHistorySheet(p, d) {
  sheet(
    'Version history',
    h(
      'div',
      { class: 'list' },
      (d?.versions ?? []).map((v) => {
        const [text, tone, ic] = v.stale ? VERSION_STATUS.stale : (VERSION_STATUS[v.status] ?? [v.status, 'neutral', null]);
        return h('button', { class: 'row-card', type: 'button', onclick: () => (closeSheet(), go(`#/review/${p.id}/${v.id}`)) }, h('span', { class: 'row-text' }, h('b', { text: `Version ${v.version}` }), h('span', { class: 'muted small ellipsis', text: v.summary }), h('span', { class: 'muted small', text: ago(v.createdAt) })), pill(text, tone, ic));
      }),
    ),
  );
}

function requestChange(p, v, text) {
  const t = String(text ?? '').trim();
  pendingAbout = { projectId: p.id, versionId: v.id, version: v.version };
  if (t) {
    const draft = saved.drafts[core.draftKey(p.id)];
    const next = draft ? `${draft}\n${t}` : t;
    core.setDraft(p.id, next);
    const c = composers.get(p.id);
    if (c) c.area.value = next;
  }
  openSession(p.id);
  requestAnimationFrame(() => composers.get(p.id)?.area.focus());
}

let exportBusy = false;
async function approveAndExport(p, v, proposalId, revision) {
  exportBusy = true;
  render();
  try {
    const r = await core.command('export.start', { projectId: p.id, proposalId, revision, resolution: exportChoice.resolution, quality: exportChoice.quality });
    if (!r) return toast('Your Mac isn’t connected.');
    if (r.t === 'error') return toast(r.code === 'REVISION_CONFLICT' ? r.message : `Couldn’t start the export: ${r.message}`);
    toast(r.applied ? 'Approved. The export is queued on your Mac.' : 'Export queued on your Mac.');
    core.openProject(p.id, true);
    maybeAskForNotifications('export');
    go('#/exports');
  } finally {
    exportBusy = false;
    render();
  }
}

async function dismissVersion(v) {
  const r = await core.command('proposal.reject', { proposalId: v.id });
  if (!r) return toast('Your Mac isn’t connected.');
  if (r.t === 'error') return toast(r.message);
  toast('Version dismissed.');
  core.openProject(r.projectId ?? route().id, true);
}

function projectExports(projectId) {
  const exps = (snap()?.exports ?? []).filter((e) => e.projectId === projectId).slice(0, 2);
  if (!exps.length) return null;
  return h('div', { class: 'list mt' }, exps.map((e) => exportRow(e, { compact: true })));
}

// ── Exports ─────────────────────────────────────────────────────────────────
function exportsScreen() {
  const all = snap()?.exports ?? [];
  const jobs = new Map((snap()?.jobs ?? []).map((j) => [j.id, j]));
  const groups = [
    ['Queued', all.filter((e) => e.state === 'queued')],
    ['Rendering', all.filter((e) => ['analyzing', 'rendering', 'muxing'].includes(e.state))],
    ['Completed', all.filter((e) => e.state === 'completed')],
    ['Failed', all.filter((e) => e.state === 'failed' || e.state === 'cancelled')],
  ];
  const body = [h('h1', { class: 'title', text: 'Exports' })];
  if (!isLive() && snap()) body.push(h('p', { class: 'synced', text: `Last synced ${ago(cache().syncedAt)} · renders in progress are unconfirmed until your Mac is back` }));
  if (!all.length) body.push(h('section', { class: 'card empty' }, icon('exports', { size: 28 }), h('p', { text: snap() ? 'No exports yet. Approve a version in Review to export it.' : 'Nothing synced from your Mac yet.' })));
  for (const [title, list] of groups) {
    if (!list.length) continue;
    body.push(h('h2', { class: 'section-title', text: `${title} · ${list.length}` }));
    body.push(h('div', { class: 'list' }, list.map((e) => exportRow(e, { job: jobs.get(e.id) }))));
  }
  return body;
}

function exportRow(e, { compact = false, job = null } = {}) {
  const st = core.status();
  const dl = live.downloads.get(e.id);
  const res = e.width && e.height ? `${e.width} × ${e.height}` : null;
  const facts = [e.version ? `Version ${e.version}` : `Revision ${e.revision}`, e.format, res, size(e.sizeBytes)].filter(Boolean).join(' · ');
  const running = ['queued', 'analyzing', 'rendering', 'muxing'].includes(e.state);
  const parts = [];
  let state = null;
  if (running) {
    const pr = job?.progress ?? null;
    if (!st.live) state = pill(`Unconfirmed${pr !== null ? ` · last seen at ${Math.round(pr * 100)}%` : ''}`, 'warn', 'alert');
    else state = pill(e.state === 'queued' ? 'Queued' : `${capital(e.state)} ${pr !== null ? `${Math.round(pr * 100)}%` : ''}`, 'orange');
    if (!compact) {
      parts.push(progress(e.state === 'queued' || !st.live ? null : pr, 'Export progress'));
      if (st.live) parts.push(h('div', { class: 'row between mt' }, h('p', { class: 'muted small', text: 'Closing this app doesn’t stop the render.' }), button('Cancel', { small: true, kind: 'ghost', iconName: 'x', onclick: () => cancelExport(e) })));
    }
  } else if (e.state === 'completed') {
    // "Ready to download" only while the Mac is there to send it; otherwise the file is just on the Mac.
    if (dl?.state === 'ready') state = pill('Downloaded to this phone', 'ok', 'checkCircle');
    else if (!e.onMac) state = pill('No longer on the Mac', 'neutral', 'info');
    else if (st.live) state = pill('Ready to download', 'mint', 'exports');
    else state = pill('Available on Mac', 'neutral', 'monitor');
  } else state = pill(e.state === 'cancelled' ? 'Cancelled' : 'Failed', e.state === 'cancelled' ? 'neutral' : 'error', 'alert');

  let action = null;
  if (e.state === 'completed' && e.onMac) {
    if (dl?.state === 'loading') action = h('span', { class: 'tabular small', text: `${Math.round((dl.progress ?? 0) * 100)}%` });
    else if (dl?.state === 'ready') action = null;
    else if (st.live) action = iconButton('exports', `Download ${e.fileName ?? 'export'}`, () => core.downloadExport(e), { cls: 'boxed' });
  }
  if (!compact) {
    if (e.state === 'completed') parts.push(h('p', { class: 'muted small', text: `${e.fileName ?? ''}${e.folder ? ` · ${e.folder} on ${pairing()?.macName ?? 'your Mac'}` : ''}` }));
    if (dl?.state === 'loading') parts.push(progress(dl.progress, 'Download progress'));
    if (dl?.state === 'failed') parts.push(h('p', { class: 'error-text small', text: `Download stopped: ${dl.error}` }));
    if (dl?.state === 'ready') parts.push(h('div', { class: 'row gap wrap mt' }, h('a', { class: 'btn secondary sm', href: dl.url, download: dl.name ?? 'export.mp4' }, icon('exports', { size: 16 }), h('span', { text: 'Save' })), canShare(dl) ? button('Share', { small: true, iconName: 'share', onclick: () => shareFile(dl) }) : null));
    if ((e.state === 'failed' || e.state === 'cancelled') && e.error) parts.push(h('p', { class: 'error-text small', text: e.error }));
    if ((e.state === 'failed' || e.state === 'cancelled') && st.live) parts.push(h('div', { class: 'row gap mt' }, button('Retry', { small: true, iconName: 'refresh', onclick: () => retryExport(e) })));
  }
  return h(
    'div',
    { class: `export-card${compact ? ' compact' : ''}` },
    h('div', { class: 'export-main' }, poster(e.projectId, 'thumb'), h('div', { class: 'row-text' }, h('b', { text: `${e.projectName}${e.version ? ` · v${e.version}` : ''}` }), h('span', { class: 'muted small tabular', text: facts }), compact ? null : state), compact ? (action ?? (e.state === 'completed' ? null : state)) : action),
    parts,
  );
}

const canShare = (dl) => dl?.blob && navigator.canShare?.({ files: [new File([dl.blob], dl.name ?? 'export.mp4', { type: 'video/mp4' })] });
async function shareFile(dl) {
  try {
    await navigator.share({ files: [new File([dl.blob], dl.name ?? 'export.mp4', { type: 'video/mp4' })] });
  } catch {
    // dismissed
  }
}

async function cancelExport(e) {
  if (!confirm('Cancel this export? Nothing is written; your timeline is unchanged.')) return;
  const r = await core.command('job.cancel', { jobId: e.id });
  if (!r) return toast('Your Mac isn’t connected.');
  if (r.t === 'error') toast(r.message);
}

async function retryExport(e) {
  const r = await core.command('job.retry', { jobId: e.id });
  if (!r) return toast('Your Mac isn’t connected.');
  if (r.t === 'error') toast(r.message);
}

// ── device sheet ────────────────────────────────────────────────────────────
function openDeviceSheet() {
  const body = h('div', { class: 'stack' });
  const fill = () => {
    const st = core.status();
    const w = statusWords();
    const p = pairing();
    const snapEngine = snap()?.engine;
    const rr = st.remoteReady;
    const rows = [
      ['Connection', st.transport === 'connected' ? 'Connected to the relay' : capital(st.transport)],
      ['Engine', { ready: 'Ready', busy: 'Busy', stopped: 'Stopped', unavailable: 'Unavailable', unknown: 'Unknown' }[st.engine]],
      ['Runs', st.live && snapEngine ? (snapEngine.background ? 'In the background (no window needed)' : 'Inside the editor app') : 'Unknown'],
      ['Desktop editor', { open: 'Open', closed: 'Closed', unknown: 'Unknown' }[st.editor]],
      ['Last seen', st.live ? 'Now' : st.lastSeen ? ago(st.lastSeen) : 'Unknown'],
      ['Remote Ready', !st.live || !rr ? 'Unknown' : !rr.enabled ? 'Off' : rr.power === 'battery' ? 'On · on battery, so macOS may still sleep' : rr.active ? 'On · keeping the Mac awake on power' : 'On'],
      ...(st.live && live.rtt !== null ? [['Round trip', `${live.rtt} ms`]] : []),
    ];
    body.replaceChildren(
      h('div', { class: 'list' }, saved.pairings.map((x) =>
        h(
          'button',
          { class: `row-card device${x.macId === p?.macId ? ' on' : ''}`, type: 'button', 'aria-current': x.macId === p?.macId ? 'true' : null, onclick: () => (x.macId === p?.macId ? null : core.switchMac(x.macId).then(fill)) },
          icon('monitor'),
          h('span', { class: 'row-text' }, h('b', { text: x.macName }), h('span', { class: 'muted small', text: x.macId === p?.macId ? `${w.word}${w.detail ? ` · ${w.detail}` : ''}` : 'Tap to switch' })),
          x.macId === p?.macId ? icon('check', { size: 18 }) : null,
        ),
      )),
      h('dl', { class: 'facts' }, rows.map(([k, v]) => [h('dt', { text: k }), h('dd', { text: v })])),
      notificationsCard(),
      button('Pair another Mac', { iconName: 'plus', full: true, onclick: () => (closeSheet(), go('#/pair')) }),
      h('p', { class: 'muted small', text: 'Other phones are managed on the Mac: ReelForge → Settings → Remote Access → Paired devices.' }),
      p ? button(`Remove this phone from ${p.macName}`, { kind: 'danger', full: true, iconName: 'trash', onclick: () => removeThisPhone(p) }) : null,
    );
  };
  fill();
  const { close } = sheet(pairing()?.macName ?? 'Your Mac', body);
  sheetUpdate = fill;
  return close;
}
let sheetUpdate = null;

async function removeThisPhone(p) {
  if (!confirm(`Remove this phone from ${p.macName}? You’ll need a new pairing code to connect again.`)) return;
  await core.forgetPairing(p.macId);
  closeSheet();
  go(saved.pairings.length ? '#/projects' : '#/pair');
}

// ── notifications ───────────────────────────────────────────────────────────
function pushSupport() {
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent);
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return ios && !standalone ? 'install' : 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  return 'ok';
}

const push = { subscribed: false, busy: false };

function notificationsCard() {
  const sup = pushSupport();
  const head = h('div', { class: 'row gap' }, icon('bell'), h('b', { class: 'grow', text: 'Notifications' }));
  if (sup === 'install') return h('section', { class: 'card' }, head, h('p', { class: 'muted small', text: 'On iPhone, notifications need the app on your Home Screen: Share → Add to Home Screen, then open ReelForge from there.' }));
  if (sup === 'unsupported') return h('section', { class: 'card' }, head, h('p', { class: 'muted small', text: 'This browser can’t show notifications. You’ll still see updates while the app is open.' }));
  if (sup === 'denied') return h('section', { class: 'card' }, head, h('p', { class: 'muted small', text: 'Notifications are blocked for this site. Allow them in the browser’s settings.' }));
  const toggle = h('input', { type: 'checkbox', role: 'switch', checked: push.subscribed || null, disabled: push.busy || !isLive() || null, 'aria-label': 'Notifications from your Mac', onchange: (e) => (e.target.checked ? pushOn() : pushOff()) });
  return h(
    'section',
    { class: 'card' },
    h('label', { class: 'row gap' }, icon('bell'), h('span', { class: 'grow' }, h('b', { text: 'Notifications' }), h('span', { class: 'muted small block', text: 'Review ready, export completed, failures. Sent by your Mac, readable only on this phone.' })), toggle),
    !isLive() ? h('p', { class: 'muted small', text: 'Turning them on or off needs your Mac online.' }) : null,
    push.subscribed && isLive() ? button('Send a test', { small: true, onclick: pushTest }) : null,
  );
}

async function registration() {
  if (!('serviceWorker' in navigator)) return null;
  await navigator.serviceWorker.register('/sw.js');
  return navigator.serviceWorker.ready;
}

function urlBase64(text) {
  return Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(text.length / 4) * 4, '=')), (c) => c.charCodeAt(0));
}

async function pushOn() {
  const key = snap()?.pushKey;
  if (!key || !isLive()) return toast('Your Mac isn’t connected. Try again once it’s online.');
  push.busy = true;
  sheetUpdate?.();
  try {
    if ((await Notification.requestPermission()) !== 'granted') throw new Error('Notifications weren’t allowed.');
    const reg = await registration();
    const want = urlBase64(key);
    let sub = await reg.pushManager.getSubscription();
    const have = sub?.options?.applicationServerKey ? new Uint8Array(sub.options.applicationServerKey) : null;
    if (sub && have && (have.length !== want.length || have.some((b, i) => b !== want[i]))) {
      await sub.unsubscribe();
      sub = null;
    }
    sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: want });
    const json = sub.toJSON();
    const r = await core.command('push.subscribe', { endpoint: json.endpoint, keys: json.keys, prefs: saved.prefs.notify });
    if (!r || r.t === 'error') throw new Error(r?.message ?? 'Your Mac isn’t connected.');
    push.subscribed = true;
    toast('Notifications are on.');
  } catch (e) {
    toast(e instanceof Error ? e.message : String(e));
  } finally {
    push.busy = false;
    sheetUpdate?.();
  }
}

async function pushOff() {
  const reg = 'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration() : null;
  const sub = await reg?.pushManager.getSubscription();
  push.busy = true;
  sheetUpdate?.();
  try {
    if (sub) {
      await core.command('push.unsubscribe', { endpoint: sub.endpoint }).catch(() => null);
      await sub.unsubscribe();
    }
    push.subscribed = false;
  } finally {
    push.busy = false;
    sheetUpdate?.();
  }
}

async function pushTest() {
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  if (!sub) return;
  const r = await core.command('push.test', { endpoint: sub.endpoint });
  toast(r && r.t !== 'error' ? 'Test sent. It should arrive in a moment.' : (r?.message ?? 'Your Mac isn’t connected.'));
}

async function pushInit() {
  try {
    if (pushSupport() !== 'ok') return;
    const reg = await navigator.serviceWorker.getRegistration();
    push.subscribed = Boolean(await reg?.pushManager.getSubscription());
  } catch {}
}

/** Asked at a moment it's useful (after starting an export or sending an instruction), once. */
function maybeAskForNotifications(why) {
  if (saved.prefs.askedNotify || push.subscribed || pushSupport() !== 'ok' || !isLive()) return;
  saved.prefs.askedNotify = true;
  core.persist();
  sheet(
    'Get notified?',
    h(
      'div',
      { class: 'stack' },
      h('p', { text: why === 'export' ? 'Your Mac can tell you when this export is ready, even with this app closed.' : 'Your Mac can tell you when the agent’s proposal is ready to review, even with this app closed.' }),
      button('Turn on notifications', { kind: 'mint', full: true, iconName: 'bell', onclick: () => (closeSheet(), pushOn()) }),
      button('Not now', { kind: 'ghost', full: true, onclick: closeSheet }),
    ),
  );
}

// ── pairing (onboarding) ────────────────────────────────────────────────────
const pairState = { step: 'code', code: '', busy: false, error: null, answer: null };

function pairScreen(r) {
  if (r.code && !pairState.code && pairState.step === 'code') pairState.code = formatCode(r.code);
  const steps = ['Turn on Remote Access', 'Scan or enter the code', 'Confirm', 'Connected'];
  const at = { code: 1, confirm: 2, done: 4 }[pairState.step] ?? 1;
  const stepper = h('ol', { class: 'onboard-steps', 'aria-label': 'Pairing steps' }, steps.map((s, i) => h('li', { class: i < at ? 'done' : i === at ? 'active' : '', 'aria-current': i === at ? 'step' : null }, h('span', { class: 'n', text: String(i + 1) }), h('span', { text: s }))));
  const titleText = pairState.step === 'done' ? 'You’re connected' : saved.pairings.length ? 'Pair another Mac' : 'Direct your Mac from here';
  const intro = [h('h1', { class: 'title', text: titleText }), h('p', { class: 'muted', text: 'Your Mac edits. This phone sends instructions, reviews versions and starts exports. Pairing takes a minute.' }), stepper];
  if (live.revoked && pairState.step === 'code') intro.push(h('section', { class: 'card notice warn' }, h('p', { text: `${pairing()?.macName ?? 'Your Mac'} no longer accepts this phone. Pair again with a new code.` })));

  if (pairState.step === 'confirm') {
    const a = pairState.answer;
    return [
      ...intro,
      h(
        'section',
        { class: 'card' },
        h('div', { class: 'row gap' }, icon('monitor', { size: 28 }), h('div', {}, h('b', { text: `Pair with ${a.payload.macName}?` }), h('p', { class: 'muted small', text: `This phone will show up on the Mac as “${a.deviceName}”. You can remove it there at any time.` }))),
        h('div', { class: 'row gap mt' }, button('Pair', { kind: 'mint', iconName: 'check', disabled: pairState.busy, onclick: confirmPair }), button('Cancel', { kind: 'ghost', onclick: () => Object.assign(pairState, { step: 'code', answer: null, code: '' }) && render() })),
        pairState.error ? h('p', { class: 'error-text small mt', text: pairState.error }) : null,
      ),
    ];
  }
  if (pairState.step === 'done') {
    const p = pairing();
    return [
      ...intro,
      h(
        'section',
        { class: 'card' },
        h('div', { class: 'row gap ok-text' }, icon('checkCircle', { size: 28 }), h('div', {}, h('b', { class: 'text', text: `Connected to ${p?.macName}` }), h('p', { class: 'muted small', text: core.status().live ? 'Your Mac is online.' : 'Paired. Waiting for your Mac to come online.' }))),
        h('ul', { class: 'help' }, h('li', { text: 'ReelForge Engine runs in the background on your Mac, so this works with the editor window closed.' }), h('li', { text: 'On the Mac, turn on Start Engine at Login (Settings → Remote Access) so it’s there after a restart. macOS may ask you to allow it under System Settings → General → Login Items.' }), h('li', { text: 'A Mac that sleeps can’t be reached. Remote Ready keeps it awake while it’s on power.' })),
        button('Open projects', { kind: 'primary', full: true, onclick: () => ((pairState.step = 'code'), go('#/projects')) }),
      ),
    ];
  }
  const input = h('input', {
    class: 'field code',
    type: 'text',
    inputmode: 'text',
    autocomplete: 'one-time-code',
    autocapitalize: 'characters',
    spellcheck: 'false',
    placeholder: 'XXXX-XXXX-XXXX-XXXX',
    'aria-label': 'Pairing code',
    value: pairState.code,
    oninput: (e) => (pairState.code = e.target.value),
    onkeydown: (e) => e.key === 'Enter' && submitCode(),
  });
  return [
    ...intro,
    h('section', { class: 'card' }, h('h2', { text: '1 · On your Mac' }), h('p', { class: 'muted', text: 'Open ReelForge → Settings → Remote Access. Turn on Remote Access, then press Pair a phone. A QR code and a pairing code appear for 10 minutes.' })),
    h(
      'section',
      { class: 'card' },
      h('h2', { text: '2 · Here' }),
      button('Scan QR code', { kind: 'mint', iconName: 'qr', full: true, onclick: openScanner }),
      h('p', { class: 'muted small center', text: 'or type the code' }),
      input,
      h('div', { class: 'row gap' }, button('Paste', { small: true, onclick: pasteCode }), h('span', { class: 'grow' }), button(pairState.busy ? 'Pairing…' : 'Continue', { kind: 'primary', small: true, disabled: pairState.busy, onclick: () => submitCode() })),
      pairState.error ? h('p', { class: 'error-text small', text: pairState.error }) : null,
      h('p', { class: 'muted small', text: 'The code works once and expires. It isn’t a password: after pairing, this phone gets its own key, which your Mac can withdraw.' }),
    ),
    saved.pairings.length ? button('Back to projects', { kind: 'ghost', full: true, onclick: () => go('#/projects') }) : null,
  ];
}

async function submitCode(text = pairState.code) {
  const code = codeFromText(text);
  if (!code) {
    pairState.error = 'That isn’t a pairing code. It looks like ABCD-EFGH-JKMN-PQRS.';
    return render();
  }
  pairState.busy = true;
  pairState.error = null;
  pairState.code = formatCode(code);
  render();
  try {
    pairState.answer = await core.startPairing(code);
    pairState.step = 'confirm';
  } catch (e) {
    pairState.error = e.message;
  } finally {
    pairState.busy = false;
    render();
  }
}

async function confirmPair() {
  pairState.busy = true;
  render();
  try {
    await core.confirmPairing(pairState.answer);
    pairState.step = 'done';
    pairState.answer = null;
    pairState.code = '';
    history.replaceState(null, '', '#/pair');
  } catch (e) {
    pairState.error = e.message;
  } finally {
    pairState.busy = false;
    render();
  }
}

async function pasteCode() {
  try {
    const text = await navigator.clipboard.readText();
    if (codeFromText(text)) return submitCode(text);
    pairState.error = 'The clipboard doesn’t hold a pairing code.';
  } catch {
    pairState.error = 'This browser didn’t allow reading the clipboard. Type the code instead.';
  }
  render();
}

// The camera stays on this phone: frames are read here by jsQR (vendor/, loaded only when asked for).
let jsQRReady = null;
function loadJsQR() {
  jsQRReady ??= new Promise((resolve, reject) => {
    if (window.jsQR) return resolve(window.jsQR);
    const s = document.createElement('script');
    s.src = '/vendor/jsQR.min.js';
    s.onload = () => (window.jsQR ? resolve(window.jsQR) : reject(new Error('jsQR missing')));
    s.onerror = () => ((jsQRReady = null), reject(new Error('Couldn’t load the QR reader')));
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
  if (!navigator.mediaDevices?.getUserMedia) return toast('This browser can’t use the camera here. Type the code instead.');
  closeScanner();
  const video = h('video', { class: 'scan-video', playsinline: true, muted: true, autoplay: true });
  const statusLine = h('p', { class: 'scan-status', text: 'Starting the camera…' });
  scanner.el = h('div', { class: 'scan', role: 'dialog', 'aria-label': 'Scan the pairing QR code' }, h('div', { class: 'scan-view' }, video, h('div', { class: 'scan-frame' })), h('p', { class: 'scan-title', text: 'Point at the QR code in Settings → Remote Access on your Mac' }), statusLine, button('Cancel', { onclick: closeScanner }));
  document.body.append(scanner.el);
  try {
    const [jsQR, stream] = await Promise.all([loadJsQR(), navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false })]);
    if (!scanner.el) return stream.getTracks().forEach((t) => t.stop());
    scanner.stream = stream;
    video.muted = true;
    video.srcObject = stream;
    await video.play();
    statusLine.textContent = 'Looking for the code…';
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const tick = () => {
      if (!scanner.stream) return;
      if (video.readyState >= 2 && video.videoWidth) {
        const scale = Math.min(1, 720 / Math.max(video.videoWidth, video.videoHeight));
        canvas.width = Math.round(video.videoWidth * scale);
        canvas.height = Math.round(video.videoHeight * scale);
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const code = jsQR(ctx.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height, { inversionAttempts: 'attemptBoth' });
        if (code?.data) {
          if (codeFromText(code.data)) {
            closeScanner();
            return submitCode(code.data);
          }
          if (!scanner.warned) {
            scanner.warned = true;
            statusLine.textContent = 'That QR code isn’t a ReelForge pairing code.';
          }
        }
      }
      scanner.raf = requestAnimationFrame(tick);
    };
    tick();
  } catch (err) {
    statusLine.textContent = err?.name === 'NotAllowedError' ? 'Camera access was denied. Allow it in Settings, or type the code.' : `Couldn’t start the camera (${err?.message ?? err}).`;
  }
}

// ── menus per page ──────────────────────────────────────────────────────────
function pageMenu(r) {
  const items = [];
  const st = core.status();
  if (r.name === 'session' && r.id) {
    const p = projectById(r.id);
    const d = detailOf(r.id);
    items.push(['director', `Model: ${modelLabel(r.id)}`, () => modelSheet(r.id)]);
    if (st.live && d) {
      if (d.canUndo) items.push(['history', 'Undo last change on the Mac', () => history_(r.id, 'undo', p.revision)]);
      if (d.canRedo) items.push(['refresh', 'Redo', () => history_(r.id, 'redo', p.revision)]);
      items.push(['film', 'Render a new preview', () => startPreview(r.id)]);
    }
    items.push(['projects', 'Switch project', chooseProjectSheet]);
  }
  if (r.name === 'review') items.push(['history', 'Version history', () => versionHistorySheet(projectById(r.id), detailOf(r.id))]);
  items.push(['refresh', 'Refresh from the Mac', () => (st.live ? core.command('sync', {}, { wait: false }) : core.connect())]);
  items.push(['monitor', 'Device & pairing', openDeviceSheet]);
  sheet('Actions', h('div', { class: 'list' }, items.map(([ic, label, fn]) => h('button', { class: 'option', type: 'button', onclick: () => (closeSheet(), fn()) }, icon(ic), h('span', { class: 'grow', text: label })))));
}

async function history_(projectId, action, baseRevision) {
  const r = await core.command(action, { projectId, baseRevision });
  if (!r) return toast('Your Mac isn’t connected.');
  if (r.t === 'error') return toast(r.code === 'REVISION_CONFLICT' ? 'The timeline just changed on your Mac. Try again.' : r.message);
  toast(action === 'undo' ? 'Undone on your Mac.' : 'Redone on your Mac.');
  core.openProject(projectId, true);
}

function modelLabel(projectId) {
  const p = pairing();
  const choice = saved.prefs.model[`${p?.macId}:${projectId}`] ?? saved.prefs.model[p?.macId];
  if (choice) return choice.model;
  const o = live.aiOptions.get(projectId);
  return o?.last?.model ?? 'Mac’s default';
}

function modelSheet(projectId) {
  const o = live.aiOptions.get(projectId);
  const p = pairing();
  const key = `${p.macId}:${projectId}`;
  const current = saved.prefs.model[key] ?? saved.prefs.model[p.macId] ?? null;
  const set = (choice) => {
    if (choice) saved.prefs.model[key] = saved.prefs.model[p.macId] = choice;
    else delete saved.prefs.model[key];
    core.persist();
    closeSheet();
    render();
  };
  const rows = [h('button', { class: `option${!current ? ' on' : ''}`, type: 'button', onclick: () => set(null) }, h('span', { class: 'grow' }, h('b', { text: 'Mac’s default' }), h('span', { class: 'muted small block', text: 'The model this project used last on the Mac.' })), !current ? icon('check', { size: 18 }) : null)];
  // Usable here and now first: local models, then providers already allowed for this project.
  const rank = (x) => (!x.ready ? 3 : !x.external ? 0 : x.consented ? 1 : 2);
  for (const prov of [...(o?.providers ?? [])].sort((a, b) => rank(a) - rank(b))) {
    for (const model of prov.models) {
      const on = current?.provider === prov.id && current?.model === model;
      const note = !prov.ready ? 'Not set up on the Mac' : prov.external && !prov.consented ? 'Needs your OK on the Mac for this project' : prov.external ? 'Sends project context to the provider' : 'Runs on your Mac';
      rows.push(h('button', { class: `option${on ? ' on' : ''}`, type: 'button', disabled: !prov.ready || null, onclick: () => set({ provider: prov.id, model }) }, h('span', { class: 'grow' }, h('b', { text: model }), h('span', { class: 'muted small block', text: `${prov.label} · ${note}` })), on ? icon('check', { size: 18 }) : null));
    }
  }
  if (!o) rows.push(h('p', { class: 'muted small', text: isLive() ? 'Loading the Mac’s models…' : 'The list of models comes from your Mac. Until then, the Mac’s default is used.' }));
  sheet('Model', h('div', { class: 'list' }, rows));
}

// ── toast ───────────────────────────────────────────────────────────────────
let toastTimer;
function toast(text, kind = 'info') {
  toastEl.textContent = text;
  toastEl.className = `toast ${kind}`;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toastEl.hidden = true), 3800);
}
core.onNotice(toast);

// ── rendering ───────────────────────────────────────────────────────────────
let lastRoute = '';
function render() {
  const r = route();
  if (!saved.pairings.length || r.name === 'pair') {
    document.body.dataset.screen = 'pair';
    document.body.classList.remove('split');
    app.replaceChildren(header({ back: saved.pairings.length ? '#/projects' : null }), h('main', { class: 'page' }, pairScreen(r)));
    return;
  }
  document.body.dataset.screen = r.name;
  const back = r.name === 'review' ? `#/session/${r.id}` : null;
  let content;
  if (r.name === 'session') content = sessionScreen(r);
  else if (r.name === 'review') content = reviewScreen(r);
  else if (r.name === 'exports') content = exportsScreen();
  else content = projectsScreen();
  const routeKey = location.hash;
  const page = h('main', { class: 'page', id: 'main' }, content);
  const sessionId = r.name === 'session' ? (r.id ?? lastProjectId()) : null;
  // `split`: a session with a project. On wide screens the preview and the conversation sit side by side.
  document.body.classList.toggle('split', Boolean(sessionId && projectById(sessionId)));
  app.replaceChildren(
    ...[
      header({ back, menu: () => pageMenu({ ...r, id: r.id ?? sessionId }) }),
      connectionStrip(),
      page,
      sessionId && projectById(sessionId) ? composer(sessionId) : null,
      dock(r.name === 'review' ? 'session' : r.name),
    ].filter(Boolean),
  );
  if (routeKey !== lastRoute) {
    lastRoute = routeKey;
    window.scrollTo(0, 0);
  }
  sheetUpdate && sheetIsOpen() ? sheetUpdate() : null;
}

core.onChange(() => {
  // Don't redraw under a finger typing in a field that isn't kept between redraws.
  const a = document.activeElement;
  if (a && (a.matches('input.search, input.field, textarea.field') || a.closest('.sheet'))) {
    if (sheetIsOpen()) sheetUpdate?.();
    return;
  }
  render();
});

window.addEventListener('hashchange', () => {
  closeSheet();
  render();
});

// The keyboard: hide the dock while typing and keep the composer above the keyboard (iOS doesn't shrink
// the layout viewport, so fixed elements would sit behind it).
const vv = window.visualViewport;
function keyboardOffset() {
  const kb = vv ? Math.max(0, window.innerHeight - vv.height - vv.offsetTop) : 0;
  document.documentElement.style.setProperty('--kb', `${Math.round(kb)}px`);
  document.body.classList.toggle('kb-open', kb > 80);
}
vv?.addEventListener('resize', keyboardOffset);
vv?.addEventListener('scroll', keyboardOffset);
document.addEventListener('focusin', (e) => e.target.matches?.('textarea, input:not([type=checkbox]):not([type=range])') && document.body.classList.add('typing'));
document.addEventListener('focusout', () => setTimeout(() => !document.activeElement?.matches?.('textarea, input:not([type=checkbox]):not([type=range])') && document.body.classList.remove('typing'), 50));

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return closeScanner();
  void core.ping();
  const r = route();
  if (r.name === 'session' && r.id) core.openProject(r.id, true);
});

navigator.serviceWorker?.addEventListener('message', (e) => {
  if (typeof e.data?.open === 'string' && e.data.open.startsWith('/')) location.hash = new URL(e.data.open, location.origin).hash || '#/projects';
});

setInterval(() => !document.hidden && !document.activeElement?.matches?.('input, textarea') && render(), 30_000); // keeps "2 min ago" honest

function capital(s) {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}
function clipText(s, n) {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

(async () => {
  render();
  if (saved.pairings.length) {
    await core.restoreMedia();
    await core.connect();
    void pushInit();
  }
})();
