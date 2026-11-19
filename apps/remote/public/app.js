// ReelForge Remote, the phone app: direct the agent editing on your Mac from anywhere.
// Talks only to the relay that served it (core.js); everything it sends and receives is sealed with keys
// the relay never has. Screens: Home, Projects, Session, Exports (dock), Review, Edit (manual editing), pairing.
import * as core from './core.js';
import { codeFromText, formatCode } from './pairing.js';
import { editorActive, editScreen, initEditor, leaveEditor } from './edit.js';
import { ago, aspect, button, clock, closeSheet, duration, h, icon, iconButton, mark, pill, plural, progress, sheet, sheetIsOpen, size } from './ui.js';

const { saved, live } = core;
const app = document.getElementById('app');
const toastEl = document.getElementById('toast');

// ── routes ──────────────────────────────────────────────────────────────────
// #/ (Home, also any unknown hash) · #/projects · #/session[/<id>] · #/review/<project>/<version>
// #/review/<project>/rev/<revision>[/s/<session>] · #/edit/<project>/<revision> · #/exports[/<job>] · #/pair[=CODE]
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
function route() {
  const hash = location.hash;
  let m;
  if (/^#\/?pair/.test(hash) || /[#&]pair=/.test(hash)) return { name: 'pair', code: codeFromText(hash) };
  if ((m = new RegExp(`^#/session/(${UUID})$`, 'i').exec(hash))) return { name: 'session', id: m[1] };
  if (hash === '#/session') return { name: 'session', id: null };
  if ((m = new RegExp(`^#/review/(${UUID})/(${UUID})$`, 'i').exec(hash))) return { name: 'review', id: m[1], version: m[2] };
  if ((m = new RegExp(`^#/review/(${UUID})/rev/(\\d{1,9})(?:/s/(${UUID}))?$`, 'i').exec(hash))) return { name: 'review-rev', id: m[1], revision: Number(m[2]), session: m[3] ?? null };
  if ((m = new RegExp(`^#/edit/(${UUID})/(\\d{1,9})$`, 'i').exec(hash))) return { name: 'edit', id: m[1], revision: Number(m[2]) };
  if (hash === '#/exports') return { name: 'exports', focus: null };
  if ((m = new RegExp(`^#/exports/(${UUID})$`, 'i').exec(hash))) return { name: 'exports', focus: m[1] };
  if (hash === '#/projects') return { name: 'projects' };
  return { name: 'home' };
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
const editingOf = (id) => (snap()?.editing ?? []).find((x) => x.projectId === id && Date.parse(x.expiresAt) > Date.now()) ?? null;

/** Opens the manual editor on a project's timeline at `revision`; Back returns to `from`. */
let editReturn = null;
function openEditor(projectId, revision, from = location.hash) {
  rememberProject(projectId);
  editReturn = from;
  go(`#/edit/${projectId}/${revision}`);
}

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
  const editing = editingOf(p.id);
  if (editing) return { text: editing.deviceId === pairing()?.deviceId ? 'Editing by hand' : `${editing.deviceName} is editing`, tone: 'mint', icon: 'pencil', busy: true };
  if (ask) return { text: 'Agent editing', tone: 'mint', icon: 'director', busy: true };
  if (job) return { text: job.kind === 'export' ? `Exporting ${Math.round(job.progress * 100)}%` : 'Rendering preview', tone: 'orange', icon: 'film', busy: true };
  if (p.pendingProposals) return { text: 'Review ready', tone: 'mint', icon: 'checkCircle' };
  if (queued) return { text: `${plural(queued, 'instruction')} queued`, tone: 'neutral', icon: 'queue' };
  return { text: 'Ready', tone: 'ok', icon: null };
}

// ── shell: phone = top bar + bottom tabs; iPad (≥700 px) = side rail ─────────
/** The plain header the pairing screen keeps. */
function header({ back = null } = {}) {
  return h(
    'header',
    { class: 'top' },
    back ? iconButton('back', 'Back', () => (history.length > 1 ? history.back() : go(back))) : h('span', { class: 'top-spacer' }),
    h('div', { class: 'brand' }, mark(busyState()), h('b', { class: 'brand-word', text: 'ReelForge' })),
    h('span', { class: 'top-spacer' }),
  );
}

/** What the mark shows: the agent editing, a render running, or nothing. */
function busyState() {
  if (!core.status().live) return 'idle';
  return projects().some((p) => askOf(p.id)) ? 'edit' : (snap()?.jobs ?? []).length ? 'render' : 'idle';
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

/** "Mac online" with a dot: the Mac's state as the relay and the Mac report it now; opens the connection details. */
function statusPill() {
  const m = macLine();
  return h(
    'button',
    { class: `status-pill ${m.tone}`, type: 'button', onclick: () => openDeviceSheet(), 'aria-label': `${m.aria}. Connection details` },
    h('span', { class: `dot ${m.tone}`, 'aria-hidden': 'true' }),
    h('span', { class: 'ellipsis', text: m.text }),
  );
}

function topbar(title) {
  return h(
    'header',
    { class: 'topbar' },
    h('div', { class: 'brand' }, mark(busyState()), h('b', { class: 'brand-word', text: 'ReelForge' })),
    h('h1', { class: 'page-title', text: title }),
    h('span', { class: 'spacer' }),
    statusPill(),
  );
}

function navItems(current) {
  const running = (snap()?.jobs ?? []).filter((j) => j.kind === 'export').length;
  const link = (name, label, hash, iconName, badge) =>
    h(
      'a',
      { class: `tab${current === name ? ' on' : ''}`, href: hash, 'aria-current': current === name ? 'page' : null },
      h('span', { class: 'tab-ic' }, icon(iconName, { size: 22 }), badge ? h('span', { class: 'badge', text: String(badge), 'aria-label': `${badge} running` }) : null),
      h('span', { class: 'tab-label', text: label }),
    );
  const action = (label, iconName, onclick) => h('button', { class: 'tab', type: 'button', onclick, 'aria-label': label === 'Mac' ? `Mac: ${macLine().text}. Connection details` : label }, h('span', { class: 'tab-ic' }, icon(iconName, { size: 22 })), h('span', { class: 'tab-label', text: label }));
  return {
    home: link('home', 'Home', '#/', 'home'),
    projects: link('projects', 'Projects', '#/projects', 'layers'),
    exports: link('exports', 'Exports', '#/exports', 'exports', running || null),
    mac: (part) => action('Mac', 'laptop', () => openDeviceSheet(part)),
    settings: action('Settings', 'settings', () => openDeviceSheet('settings')),
  };
}

/** Phone: Home · Projects · Exports · Mac along the bottom. */
function tabs(current) {
  const n = navItems(current);
  return h('nav', { class: 'tabs', 'aria-label': 'Sections' }, n.home, n.projects, n.exports, n.mac('all'));
}

/** iPad: the same sections down the side, the Mac and settings at the foot. */
function rail(current) {
  const n = navItems(current);
  return h('nav', { class: 'rail', 'aria-label': 'Sections' }, mark(busyState(), 36), n.home, n.projects, n.exports, h('span', { class: 'spacer' }), n.mac('mac'), n.settings);
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
// Search, sort and filter stay while the app is open, so coming back from a Session finds the gallery as it was
// (the scroll position too: render() keeps it).
const gallery = { query: '', sort: 'recent', filter: 'all', scrollY: 0 };
const FILTERS = [
  ['all', 'All projects'],
  ['review', 'Review ready'],
  ['busy', 'Rendering or exporting'],
  ['empty', 'No media yet'],
];
const SORTS = [
  ['recent', 'Last updated'],
  ['name', 'Name'],
];
const filterTest = {
  all: () => true,
  review: (p) => p.pendingProposals > 0,
  busy: (p) => jobsOf(p.id).length > 0,
  empty: (p) => !p.durationFrames,
};
const filtered = () => gallery.filter !== 'all' || gallery.sort !== 'recent';
function resetGallery() {
  gallery.query = '';
  gallery.filter = 'all';
  gallery.sort = 'recent';
  searchInput.value = '';
  render();
}
// Kept between redraws so typing in it is never interrupted.
// Typing redraws only the results: rebuilding the page would move the field and take the keyboard away.
const searchInput = h('input', { class: 'search', type: 'search', placeholder: 'Search projects', 'aria-label': 'Search projects by title', autocomplete: 'off', enterkeyhint: 'search', oninput: (e) => ((gallery.query = e.target.value), fillResults()) });
const resultsBox = h('div', { class: 'results' });

const byRecent = (a, b) => b.updatedAt.localeCompare(a.updatedAt);

/** What can't load yet, in place of a list: still connecting, nothing synced, or the Mac never answered. */
function notSynced(what) {
  const st = core.status();
  if (st.transport === 'connecting' || (st.transport === 'connected' && !live.relayWaiting && live.agentOnline)) return skeleton();
  return h(
    'section',
    { class: 'card empty', role: 'status' },
    icon(st.live ? 'refresh' : 'wifiOff', { size: 28 }),
    h('p', { text: `Couldn’t load ${what}: nothing has been synced from your Mac yet. It appears once the Mac connects.` }),
    button('Try again', { iconName: 'refresh', small: true, onclick: () => core.connect() }),
  );
}

function projectsHeader() {
  return h(
    'header',
    { class: 'page-head' },
    h('div', { class: 'brand head-brand' }, mark(busyState()), h('b', { class: 'brand-word', text: 'ReelForge' })),
    h('div', { class: 'head-row' }, h('h1', { class: 'head-title', text: 'Projects' }), h('span', { class: 'spacer' }), statusPill(), iconButton('plus', 'New Project', () => newProjectSheet(), { cls: 'boxed add-btn' })),
  );
}

function projectsScreen() {
  const s = snap();
  const list = projects();
  const st = core.status();
  const body = [];
  if (s && !st.live && cache()?.syncedAt) body.push(h('p', { class: 'synced', text: `Last synced ${ago(cache().syncedAt)} · saved on this phone` }));
  if (!st.live) body.push(unavailableCard({ compact: true }));
  if (!s) return [...body, notSynced('your projects')];
  if (!list.length) return [...body, h('section', { class: 'card empty' }, icon('layers', { size: 28 }), h('p', { text: 'No projects yet. Start one here or in ReelForge on your Mac.' }), button('New Project', { kind: 'primary', iconName: 'plus', onclick: () => newProjectSheet() }))];

  if (searchInput.value !== gallery.query) searchInput.value = gallery.query;
  const on = filtered();
  body.push(
    h(
      'div',
      { class: 'search-row' },
      h('label', { class: 'search-wrap' }, icon('search', { size: 18 }), searchInput),
      h(
        'button',
        { class: `icon-btn boxed filter-btn${on ? ' on' : ''}`, type: 'button', 'aria-label': on ? `Sort and filter: ${filterSummary()}. Change` : 'Sort and filter', 'aria-haspopup': 'dialog', onclick: filterSheet },
        icon('sliders'),
        on ? h('span', { class: 'filter-dot', 'aria-hidden': 'true' }) : null,
      ),
    ),
  );
  if (on) body.push(h('div', { class: 'filter-line' }, h('span', { class: 'grow muted small', text: filterSummary() }), h('button', { class: 'link-btn', type: 'button', onclick: resetGallery }, 'Reset filter')));

  fillResults();
  body.push(resultsBox);
  return body;
}

function fillResults() {
  const list = projects();
  const on = filtered();
  const q = gallery.query.trim().toLowerCase();
  const shown = [...list]
    .filter(filterTest[gallery.filter] ?? filterTest.all)
    .filter((p) => !q || p.name.toLowerCase().includes(q))
    .sort(gallery.sort === 'name' ? (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) : byRecent);
  if (shown.length) resultsBox.replaceChildren(h('div', { class: 'grid', role: 'list', 'aria-label': `${plural(shown.length, 'project')}` }, shown.map(projectCard)));
  else
    resultsBox.replaceChildren(
      h(
        'section',
        { class: 'card empty', role: 'status' },
        icon('search', { size: 26 }),
        h('p', { text: q ? `No project matches “${clipText(gallery.query.trim(), 40)}”${on ? ' with this filter' : ''}.` : 'No project matches this filter.' }),
        button('Reset filter', { small: true, iconName: 'reset', onclick: resetGallery }),
      ),
    );
}

function filterSummary() {
  const parts = [];
  if (gallery.filter !== 'all') parts.push(FILTERS.find(([k]) => k === gallery.filter)[1]);
  if (gallery.sort !== 'recent') parts.push(`Sorted by ${SORTS.find(([k]) => k === gallery.sort)[1].toLowerCase()}`);
  return parts.join(' · ');
}

function filterSheet() {
  const body = h('div', { class: 'stack' });
  const count = (k) => projects().filter(filterTest[k]).length;
  const fill = () => {
    const opt = (cur, [k, label], set, extra) =>
      h('button', { class: `option${cur === k ? ' on' : ''}`, type: 'button', role: 'radio', 'aria-checked': String(cur === k), onclick: () => (set(k), render(), fill()) }, h('span', { class: 'grow', text: label }), extra ? h('span', { class: 'muted small tabular', text: extra }) : null, cur === k ? icon('check', { size: 18 }) : null);
    body.replaceChildren(
      h('h3', { class: 'sheet-label', id: 'sort-label', text: 'Sort by' }),
      h('div', { class: 'list', role: 'radiogroup', 'aria-labelledby': 'sort-label' }, SORTS.map((x) => opt(gallery.sort, x, (k) => (gallery.sort = k)))),
      h('h3', { class: 'sheet-label', id: 'filter-label', text: 'Show' }),
      h('div', { class: 'list', role: 'radiogroup', 'aria-labelledby': 'filter-label' }, FILTERS.map((x) => opt(gallery.filter, x, (k) => (gallery.filter = k), String(x[0] === 'all' ? projects().length : count(x[0]))))),
      button('Reset filter', { full: true, iconName: 'reset', disabled: !filtered() && !gallery.query, onclick: () => (resetGallery(), fill()) }),
      button('Done', { full: true, kind: 'mint', onclick: closeSheet }),
    );
  };
  fill();
  sheet('Sort and filter', body);
  sheetUpdate = fill;
}

function poster(projectId, cls = '') {
  const url = live.posters.get(projectId)?.url;
  return h('div', { class: `poster ${cls}` }, url ? h('img', { src: url, alt: '' }) : coverPlaceholder());
}
/** The same stand-in everywhere a project has no cover yet. */
const coverPlaceholder = () => h('span', { class: 'cover-ph', 'aria-hidden': 'true' }, icon('film', { size: 26 }));

/** today 09:05 · yesterday · Jun 29 · 6/29/2025 */
function shortDate(when) {
  const d = new Date(when);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(now) - day(d)) / 86_400_000);
  if (diff === 0) return `today ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })}`;
  if (diff === 1) return 'yesterday';
  return d.getFullYear() === now.getFullYear() ? d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : d.toLocaleDateString();
}

/** A status worth a badge: only what the user can act on or should wait for. */
function badgeOf(p) {
  const s = projectState(p);
  return s.tone === 'mint' || s.tone === 'orange' ? s : null;
}
const badge = (s, cls = '') => h('span', { class: `badge-pill ${s.tone} ${cls}` }, s.icon ? icon(s.icon, { size: 13 }) : null, h('span', { class: 'ellipsis', text: s.text }));

function projectCard(p) {
  const s = badgeOf(p);
  const url = live.posters.get(p.id)?.url;
  const dur = p.durationFrames ? duration(p.durationFrames, p.fps) : null;
  return h(
    'div',
    { class: 'pcard-wrap', role: 'listitem' },
    h(
      'button',
      { class: 'pcard', type: 'button', onclick: () => openSession(p.id), 'aria-label': `${p.name}${dur ? `, ${dur}` : ', empty timeline'}${s ? `, ${s.text}` : ''}. Open session` },
      h('span', { class: 'thumb' }, url ? h('img', { src: url, alt: '' }) : coverPlaceholder(), h('span', { class: 'dur tabular' }, icon('video', { size: 13 }), h('span', { text: dur ?? 'Empty' }))),
      h('span', { class: 'pbody' }, h('b', { class: 'ptitle', text: p.name }), s ? badge(s) : h('span', { class: 'psub', text: `${aspect(p.width, p.height)} · ${shortDate(p.updatedAt)}` })),
    ),
    h('button', { class: 'pcard-more', type: 'button', 'aria-label': `More for ${p.name}: rename or delete`, 'aria-haspopup': 'dialog', onclick: () => projectActionsSheet(p) }, icon('more', { size: 20 })),
  );
}

// ── Home ────────────────────────────────────────────────────────────────────
function homeHeader() {
  return h(
    'header',
    { class: 'page-head home-head' },
    h('div', { class: 'head-row' }, h('div', { class: 'brand head-brand' }, mark(busyState()), h('b', { class: 'brand-word', text: 'ReelForge' })), h('span', { class: 'spacer' }), statusPill()),
    button('New Project', { kind: 'mint', small: true, iconName: 'plus', onclick: () => newProjectSheet() }),
  );
}

/** The project to pick up again: the last one opened on this phone, else the last one edited. */
function continueProject() {
  return projectById(lastProjectId()) ?? [...projects()].sort(byRecent)[0] ?? null;
}

function homeScreen() {
  const s = snap();
  const st = core.status();
  const body = [];
  if (!st.live) body.push(unavailableCard({ compact: true }));
  if (!s) return [...body, notSynced('your projects')];
  const cont = continueProject();
  body.push(h('h2', { class: 'home-h', text: 'Continue project' }));
  body.push(cont ? continueCard(cont) : h('section', { class: 'card empty' }, icon('layers', { size: 28 }), h('p', { text: 'No projects yet. Start your first one: name it, pick a format, add clips.' }), button('New Project', { kind: 'primary', iconName: 'plus', onclick: () => newProjectSheet() })));

  const attention = attentionItems(cont);
  if (attention.length) body.push(h('h2', { class: 'home-h', text: 'Needs attention' }), h('div', { class: 'list' }, attention.map(actionRow)));

  const working = workingItems();
  if (working.length) {
    body.push(h('div', { class: 'home-h-row' }, h('h2', { class: 'home-h', text: 'In progress' }), !st.live && cache()?.syncedAt ? h('span', { class: 'synced', text: `As of last sync · ${ago(cache().syncedAt)}` }) : null));
    body.push(h('div', { class: 'list' }, working.map(actionRow)));
  }

  const recent = [...projects()].sort(byRecent).filter((p) => p.id !== cont?.id).slice(0, 2);
  if (recent.length) {
    body.push(h('div', { class: 'home-h-row' }, h('h2', { class: 'home-h', text: 'Recent projects' }), h('a', { class: 'link see-all', href: '#/projects' }, h('span', { text: 'See all' }), icon('chevronRight', { size: 16 }))));
    body.push(h('div', { class: 'recent' }, recent.map(recentCard)));
  }
  return body;
}

/** Horizontal: cover, title, status, duration · last edit, and Open session. */
function continueCard(p) {
  const s = badgeOf(p);
  const dur = p.durationFrames ? duration(p.durationFrames, p.fps) : 'Empty timeline';
  return h(
    'article',
    { class: 'continue', 'aria-label': `Continue: ${p.name}` },
    h('button', { class: 'continue-art', type: 'button', tabindex: '-1', 'aria-hidden': 'true', onclick: () => openSession(p.id) }, poster(p.id, 'cont')),
    h(
      'div',
      { class: 'continue-text' },
      h('h3', { class: 'continue-title', text: p.name }),
      s ? badge(s) : null,
      h('p', { class: 'meta tabular' }, h('span', { text: dur }), h('span', { 'aria-hidden': 'true', text: '·' }), h('span', { text: `edited ${ago(p.updatedAt)}` })),
      button('Open session', { kind: 'primary', small: true, iconName: 'chevronRight', aria: `Open the session of ${p.name}`, onclick: () => openSession(p.id) }),
    ),
  );
}

function recentCard(p) {
  const dur = p.durationFrames ? duration(p.durationFrames, p.fps) : null;
  return h(
    'button',
    { class: 'rcard', type: 'button', onclick: () => openSession(p.id), 'aria-label': `${p.name}${dur ? `, ${dur}` : ', empty timeline'}. Open session` },
    h('span', { class: 'rthumb' }, live.posters.get(p.id)?.url ? h('img', { src: live.posters.get(p.id).url, alt: '' }) : coverPlaceholder(), dur ? h('span', { class: 'dur tabular', text: dur }) : null),
    h('b', { class: 'rtitle ellipsis', text: p.name }),
  );
}

/** One tappable line: an icon, what happened, which project, and where it leads. */
function actionRow(it) {
  const inner = [
    h('span', { class: `row-ic ${it.tone}` }, icon(it.icon, { size: 22 })),
    h('span', { class: 'row-text' }, h('b', { text: it.title }), h('span', { class: 'muted small ellipsis', text: it.sub })),
    it.pct !== undefined ? h('span', { class: 'row-pct tabular', text: it.pct === null ? '' : `${it.pct}%` }) : null,
    icon('chevronRight', { size: 18 }),
  ];
  const node = it.href ? h('a', { class: 'row-card action-row', href: it.href, 'aria-label': it.aria ?? `${it.title}: ${it.sub}` }, inner) : h('button', { class: 'row-card action-row', type: 'button', onclick: it.onclick, 'aria-label': it.aria ?? `${it.title}: ${it.sub}` }, inner);
  if (it.bar !== undefined) node.append(h('span', { class: 'row-bar' }, progress(it.bar, it.title)));
  return node;
}

/**
 * Up to three things waiting on the user, problems first: failed exports and imports, instructions the Mac sent
 * back, versions ready to review. The Continue card already shows its own project's review state.
 */
function attentionItems(cont) {
  const items = [];
  const names = new Map(projects().map((p) => [p.id, p.name]));
  const latestExport = new Map();
  for (const e of snap()?.exports ?? []) if (!latestExport.has(e.projectId)) latestExport.set(e.projectId, e); // newest first
  for (const e of latestExport.values()) {
    const when = Date.parse(e.finishedAt ?? e.createdAt);
    if (e.state === 'failed' && Date.now() - when < 7 * 86_400_000) items.push({ rank: 0, at: when, icon: 'alert', tone: 'warn', title: 'Export failed', sub: e.projectName, href: `#/exports/${e.id}` });
  }
  const uploadsSeen = new Set();
  for (const [, u] of live.uploads) {
    if (u.state !== 'failed' || uploadsSeen.has(u.projectId) || !names.has(u.projectId)) continue;
    uploadsSeen.add(u.projectId);
    items.push({ rank: 0, at: Date.now(), icon: 'alert', tone: 'warn', title: 'Media wasn’t added', sub: names.get(u.projectId), onclick: () => openSession(u.projectId) });
  }
  for (const it of saved.outbox) {
    if (it.macId !== pairing()?.macId || !names.has(it.projectId) || !['needs_review', 'failed'].includes(it.state)) continue;
    items.push({ rank: 1, at: it.createdAt, icon: 'alert', tone: 'warn', title: it.state === 'failed' ? 'Instruction not applied' : 'Instruction needs your OK', sub: names.get(it.projectId), onclick: () => openSession(it.projectId) });
  }
  for (const p of projects()) {
    if (p.pendingProposals && p.id !== cont?.id) items.push({ rank: 2, at: Date.parse(p.updatedAt), icon: 'checkCircle', tone: 'mint', title: 'Review ready', sub: p.name, onclick: () => openSession(p.id) });
  }
  return items.sort((a, b) => a.rank - b.rank || b.at - a.at).slice(0, 3);
}

/** Renders and exports running on the Mac, and media on its way from this phone. */
function workingItems() {
  const st = core.status();
  const names = new Map(projects().map((p) => [p.id, p.name]));
  const items = [];
  for (const j of snap()?.jobs ?? []) {
    // A percentage only when the job reports one; a queued job or one without progress gets a moving bar.
    const known = st.live && j.state !== 'queued' && j.progress > 0 ? Math.round(j.progress * 100) : null;
    const name = names.get(j.projectId) ?? 'Project';
    const title = j.kind === 'export' ? (j.state === 'queued' ? 'Export queued' : 'Exporting') : j.state === 'queued' ? 'Preview queued' : 'Rendering preview';
    items.push({
      icon: j.kind === 'export' ? 'exports' : 'film',
      tone: 'orange',
      title,
      sub: st.live ? name : `${name} · unconfirmed until your Mac is back`,
      pct: known,
      bar: known !== null ? j.progress : null,
      ...(j.kind === 'export' ? { href: `#/exports/${j.id}` } : { onclick: () => openSession(j.projectId) }),
      aria: `${title}: ${name}${known !== null ? `, ${known}%` : ''}`,
    });
  }
  for (const [, u] of live.uploads) {
    if (!['sending', 'importing'].includes(u.state) || !names.has(u.projectId)) continue;
    const pct = u.state === 'sending' ? Math.round((u.progress ?? 0) * 100) : null;
    items.push({ icon: 'attach', tone: 'mint', title: u.state === 'importing' ? 'Importing on your Mac' : 'Sending media', sub: `${u.name} · ${names.get(u.projectId)}`, pct, bar: pct !== null ? u.progress ?? 0 : null, onclick: () => openSession(u.projectId) });
  }
  return items;
}

// ── New Project ─────────────────────────────────────────────────────────────
// One form for both entry points (Home's button, Projects' +). What is typed is a draft saved on this phone per
// Mac, so a closed sheet, a lost connection or a reload never loses it. Its request id is fixed the first time
// it is sent and kept until the Mac confirms: a retry after a timeout asks with the same id and gets the project
// that was already made instead of a second one. Picked files can't be saved; they stay while the app is open.
const NAME_MAX = 120; // ProjectNameSchema on the Mac
const FORMATS = [
  { id: '9:16', label: '9:16', note: 'Reels · Shorts', w: 9, h: 16 },
  { id: '1:1', label: '1:1', note: 'Square', w: 1, h: 1 },
  { id: '16:9', label: '16:9', note: 'YouTube', w: 16, h: 9 },
];
const np = { files: [], busy: false, nameError: null, error: null, unsure: false };

function npDraft() {
  const c = cache();
  if (!c) return null;
  c.newProject ??= { name: '', format: '9:16', requestId: null };
  return c.newProject;
}
function npNameProblem(raw) {
  const name = raw.trim();
  if (!name) return 'Give the project a name.';
  if (name.length > NAME_MAX) return `Keep the name under ${NAME_MAX + 1} characters (it has ${name.length}).`;
  if (/[\u0000-\u001f\u007f]/.test(name)) return 'The name can’t contain control characters.';
  return null;
}

function newProjectSheet() {
  const draft = npDraft();
  if (!draft) return;
  np.nameError = null;
  if (!np.busy) np.error = np.unsure ? np.error : null;
  const nameId = 'np-name';
  const name = h('input', { class: 'field', id: nameId, type: 'text', maxlength: String(NAME_MAX + 20), autocomplete: 'off', autocapitalize: 'words', enterkeyhint: 'done', placeholder: 'e.g. Cafe Stories', 'aria-describedby': 'np-name-note', 'aria-required': 'true' });
  name.value = draft.name;
  const nameNote = h('p', { class: 'field-note', id: 'np-name-note', 'aria-live': 'polite' });
  name.addEventListener('input', () => {
    draft.name = name.value;
    core.persist();
    if (np.nameError) np.nameError = npNameProblem(name.value);
    fill();
  });
  name.addEventListener('keydown', (e) => e.key === 'Enter' && (e.preventDefault(), name.blur()));

  const formats = h('div', { class: 'np-formats', role: 'radiogroup', 'aria-label': 'Video format' });
  const filePick = h('input', { type: 'file', multiple: true, accept: 'video/*,image/*,audio/*', class: 'visually-hidden', tabindex: '-1', 'aria-hidden': 'true' });
  filePick.addEventListener('change', () => {
    np.files.push(...(filePick.files ?? []));
    filePick.value = '';
    fill();
  });
  const media = h('div', { class: 'np-media' });
  const status = h('div', { class: 'np-status', role: 'status', 'aria-live': 'polite' });
  const submit = h('button', { class: 'btn primary full', type: 'submit' });
  const form = h(
    'form',
    { class: 'np-form', novalidate: true, onsubmit: (e) => (e.preventDefault(), void createFromForm()) },
    h('label', { class: 'np-label', for: nameId, text: 'Project name' }),
    name,
    nameNote,
    h('p', { class: 'np-label', id: 'np-format-label', text: 'Video format' }),
    formats,
    h('p', { class: 'np-label', text: 'Starting media · optional' }),
    media,
    filePick,
    h('div', { class: 'np-foot' }, status, submit),
  );

  function fill() {
    const st = core.status();
    const typed = draft.name.trim();
    nameNote.textContent = np.nameError ?? `${typed.length}/${NAME_MAX}`;
    nameNote.classList.toggle('error-text', Boolean(np.nameError));
    name.setAttribute('aria-invalid', String(Boolean(np.nameError)));
    formats.replaceChildren(
      ...FORMATS.map((f) =>
        h(
          'button',
          { class: `np-format${draft.format === f.id ? ' on' : ''}`, type: 'button', role: 'radio', 'aria-checked': String(draft.format === f.id), 'aria-label': `${f.label}, ${f.note}`, onclick: () => ((draft.format = f.id), core.persist(), fill()) },
          h('span', { class: 'np-shape', vars: { '--w': f.w, '--h': f.h }, 'aria-hidden': 'true' }),
          h('b', { text: f.label }),
          h('span', { class: 'muted small', text: f.note }),
        ),
      ),
    );
    media.replaceChildren(
      ...np.files.map((f, i) => h('div', { class: 'upload' }, icon('attach', { size: 16 }), h('span', { class: 'grow ellipsis', text: `${f.name} · ${size(f.size)}` }), iconButton('x', `Remove ${f.name}`, () => (np.files.splice(i, 1), fill())))),
      button(np.files.length ? 'Add more' : 'Add media from this phone', { small: true, iconName: 'plus', onclick: () => filePick.click() }),
      h('p', { class: 'muted small', text: np.files.length ? 'Sent to your Mac and imported right after the project is made. Picked files stay only while this app is open.' : 'A project can start empty. Files already on your Mac: add them in ReelForge there.' }),
    );
    const offline = !st.live;
    submit.disabled = np.busy || offline || null;
    submit.replaceChildren(np.busy ? h('span', { text: 'Creating…' }) : h('span', { text: np.unsure ? 'Try again' : 'Create project' }));
    submit.setAttribute('aria-describedby', 'np-status');
    status.id = 'np-status';
    const lines = [];
    if (np.error) lines.push(h('p', { class: np.unsure ? 'warn-text small' : 'error-text small' }, icon('alert', { size: 15 }), h('span', { text: ` ${np.error}` })));
    if (offline)
      lines.push(
        h('p', { class: 'muted small' }, icon('wifiOff', { size: 15 }), h('span', { text: ` ${pairing()?.macName ?? 'Your Mac'} is ${st.transport === 'connected' ? 'offline' : 'not reachable'}. Projects are made on the Mac, so Create waits for it. Your draft is saved on this phone.` })),
      );
    status.replaceChildren(...lines);
  }

  async function createFromForm() {
    if (np.busy) return; // a second tap while the first is on its way does nothing
    const problem = npNameProblem(draft.name);
    if (problem) {
      np.nameError = problem;
      fill();
      return name.focus();
    }
    if (!core.status().live) return fill();
    draft.requestId ??= crypto.randomUUID();
    core.persistNow();
    np.busy = true;
    np.error = null;
    fill();
    const r = await core.createProject({ requestId: draft.requestId, name: draft.name.trim(), format: draft.format });
    np.busy = false;
    np.unsure = false;
    if (r?.t === 'project.created') {
      const files = np.files.splice(0);
      const c = cache();
      c.newProject = { name: '', format: '9:16', requestId: null };
      core.persistNow();
      np.error = null;
      closeSheet();
      if (r.existing) toast('Your Mac had already made this project. Opening it.');
      openSession(r.project.id);
      for (const f of files) await core.upload(r.project.id, f);
      return;
    }
    if (!r) np.error = 'Couldn’t reach your Mac. Nothing was made; your draft is saved here.';
    else if (r.timeout) {
      // It may have gone through. Trying again asks with the same id, so the Mac answers with that project.
      np.unsure = true;
      np.error = 'Your Mac didn’t answer in time. It may have made the project already: Try again checks first and never makes a second one.';
    } else if (r.code === 'VALIDATION_ERROR' && /name/i.test(r.message ?? '')) {
      np.nameError = r.message;
    } else if (r.code === 'NOT_FOUND') {
      draft.requestId = null; // that project was deleted on the Mac: the next try is a new one
      core.persist();
      np.error = r.message;
    } else if (/^Unknown command/.test(r.message ?? '')) {
      np.error = 'ReelForge on your Mac is older than this app and can’t make projects from the phone yet. Update it on the Mac; your draft stays here.';
    } else np.error = r.message ?? 'Your Mac couldn’t make the project.';
    fill();
  }

  fill();
  sheet('New Project', form);
  sheetUpdate = fill;
  if (!draft.name) requestAnimationFrame(() => name.focus({ preventScroll: true }));
}

// ── Rename / Delete ─────────────────────────────────────────────────────────
// Both happen on the Mac (its ProjectStore), so they need it connected. Delete always asks first and says
// what goes (the project) and what stays (media files and exported videos on the Mac).

/** The ⋯ on a project card: what can be done to the project itself. */
function projectActionsSheet(p) {
  const online = isLive();
  const row = (ic, label, fn, { danger = false } = {}) =>
    h('button', { class: `option${danger ? ' danger' : ''}`, type: 'button', disabled: !online || null, onclick: () => (closeSheet(), fn()) }, icon(ic), h('span', { class: 'grow', text: label }));
  sheet(
    p.name,
    h(
      'div',
      { class: 'stack' },
      h('div', { class: 'list' }, h('button', { class: 'option', type: 'button', onclick: () => (closeSheet(), openSession(p.id)) }, icon('session'), h('span', { class: 'grow', text: 'Open session' })), row('pencil', 'Rename', () => renameSheet(p)), row('trash', 'Delete project', () => deleteSheet(p), { danger: true })),
      online ? null : h('p', { class: 'muted small', text: `Renaming and deleting happen on ${pairing()?.macName ?? 'your Mac'}, so they wait until it’s connected.` }),
    ),
  );
}

function renameSheet(p) {
  const state = { busy: false, error: null };
  const field = h('input', { class: 'field', id: 'rn-name', type: 'text', maxlength: String(NAME_MAX + 20), autocomplete: 'off', autocapitalize: 'words', enterkeyhint: 'done', 'aria-describedby': 'rn-note', 'aria-required': 'true' });
  field.value = p.name;
  const note = h('p', { class: 'field-note', id: 'rn-note', 'aria-live': 'polite' });
  const submit = h('button', { class: 'btn primary full', type: 'submit' });
  const fill = () => {
    const typed = field.value.trim();
    note.textContent = state.error ?? `${typed.length}/${NAME_MAX}`;
    note.classList.toggle('error-text', Boolean(state.error));
    field.setAttribute('aria-invalid', String(Boolean(state.error)));
    submit.disabled = state.busy || !isLive() || null;
    submit.replaceChildren(h('span', { text: state.busy ? 'Renaming…' : 'Rename' }));
  };
  field.addEventListener('input', () => ((state.error = null), fill()));
  const save = async () => {
    if (state.busy) return;
    const name = field.value.trim();
    state.error = npNameProblem(field.value);
    if (state.error) return (fill(), field.focus());
    if (name === p.name) return closeSheet();
    state.busy = true;
    fill();
    const r = await core.renameProject(p.id, name);
    state.busy = false;
    if (r?.t === 'project.renamed') {
      closeSheet();
      toast(`Renamed to “${clipText(r.project.name, 40)}”.`);
      return render();
    }
    if (!r) state.error = 'Couldn’t reach your Mac. The name wasn’t changed.';
    else if (r.timeout) state.error = 'Your Mac didn’t answer in time. Check the name in a moment; Rename again is safe.';
    else if (/^Unknown command/.test(r.message ?? '')) state.error = 'ReelForge on your Mac is older than this app. Update it on the Mac to rename from here.';
    else state.error = r.message ?? 'Your Mac couldn’t rename the project.';
    fill();
  };
  fill();
  sheet('Rename project', h('form', { class: 'np-form', novalidate: true, onsubmit: (e) => (e.preventDefault(), void save()) }, h('label', { class: 'np-label', for: 'rn-name', text: 'Project name' }), field, note, submit));
  sheetUpdate = fill;
  requestAnimationFrame(() => (field.focus({ preventScroll: true }), field.select()));
}

function deleteSheet(p) {
  const state = { busy: false, error: null };
  const mac = pairing()?.macName ?? 'your Mac';
  const busyNow = jobsOf(p.id).length > 0 || Boolean(askOf(p.id)) || Boolean(editingOf(p.id));
  const status = h('div', { role: 'status', 'aria-live': 'polite' });
  const confirm = h('button', { class: 'btn danger full', type: 'button', onclick: () => void remove() });
  const fill = () => {
    confirm.disabled = state.busy || !isLive() || null;
    confirm.replaceChildren(icon('trash', { size: 18 }), h('span', { text: state.busy ? 'Deleting…' : 'Delete project' }));
    status.replaceChildren(state.error ? h('p', { class: 'error-text small' }, icon('alert', { size: 15 }), h('span', { text: ` ${state.error}` })) : busyNow ? h('p', { class: 'warn-text small', text: 'Something is still working on this project (a render, the agent or a hand edit). Your Mac will ask you to wait for it.' }) : '');
  };
  const remove = async () => {
    if (state.busy) return;
    state.busy = true;
    state.error = null;
    fill();
    const r = await core.deleteProject(p.id);
    state.busy = false;
    if (r?.t === 'project.deleted' || r?.code === 'NOT_FOUND') {
      closeSheet();
      composers.delete(p.id);
      toast(`“${clipText(p.name, 40)}” was deleted.`);
      if (route().id === p.id) return go('#/projects');
      return render();
    }
    if (!r) state.error = 'Couldn’t reach your Mac. Nothing was deleted.';
    else if (r.timeout) state.error = 'Your Mac didn’t answer in time. Check the project list in a moment before trying again.';
    else if (/^Unknown command/.test(r.message ?? '')) state.error = 'ReelForge on your Mac is older than this app. Update it on the Mac to delete from here.';
    else state.error = r.message ?? 'Your Mac couldn’t delete the project.';
    fill();
  };
  fill();
  sheet(
    'Delete project?',
    h(
      'div',
      { class: 'stack' },
      h('p', { text: `“${p.name}” is removed from ReelForge on ${mac}: its timeline, captions, versions and history. This can’t be undone.` }),
      h('p', { class: 'muted small', text: 'Your media files and exported videos stay on the Mac. Its exports leave the Exports list here.' }),
      status,
      confirm,
      button('Cancel', { full: true, kind: 'ghost', onclick: closeSheet }),
    ),
  );
  sheetUpdate = fill;
}

function skeleton() {
  return h('div', { class: 'skeleton', 'aria-busy': 'true', 'aria-label': 'Loading projects' }, h('div', { class: 'sk hero-sk' }), h('div', { class: 'sk row-sk' }), h('div', { class: 'sk row-sk' }));
}

// Session's Back returns to the screen it was opened from (Home or Projects), where that screen left off.
let sessionReturn = null;
function openSession(id) {
  rememberProject(id);
  const r = route().name;
  if (r === 'home' || r === 'projects') sessionReturn = location.hash || '#/';
  go(`#/session/${id}`);
}
const sessionBack = () => sessionReturn ?? '#/';

// ── Session ─────────────────────────────────────────────────────────────────
/** Where Export leads: the version waiting for review, the applied one, or the timeline as it is. */
function exportTarget(p, d) {
  const v = d?.versions?.[0];
  if (v && v.status === 'pending' && !v.stale) return `#/review/${p.id}/${v.id}`;
  if (v && v.status === 'applied' && v.appliedRevision === p.revision) return `#/review/${p.id}/${v.id}`;
  return `#/review/${p.id}/rev/${p.revision}`;
}

/** The Mac's connection in a few words, for the Session header: what the relay and the Mac report now. */
function macLine() {
  const st = core.status();
  const name = pairing()?.macName ?? 'Mac';
  if (live.revoked) return { text: 'Not paired', tone: 'error', aria: 'This phone is no longer paired' };
  if (st.transport === 'connecting') return { text: 'Connecting…', tone: 'neutral', aria: `Connecting to ${name}` };
  if (st.transport === 'reconnecting' || st.transport === 'disconnected') return { text: 'Reconnecting…', tone: 'warn', aria: `Reconnecting to ${name}` };
  if (st.engine === 'stopped') return { text: 'Mac engine stopped', tone: 'neutral', aria: `${name}: engine stopped` };
  if (!st.live) return { text: 'Mac offline', tone: 'warn', aria: `${name} is offline` };
  return { text: 'Mac online', tone: 'ok', aria: `${name} is online` };
}

function sessionScreen(r) {
  const id = r.id ?? lastProjectId();
  if (!id || !projectById(id)) {
    return h(
      'div',
      { class: 'session' },
      h('header', { class: 's-head' }, iconButton('back', 'Back', () => go(sessionBack())), h('div', { class: 's-title' }, h('b', { text: 'Session' }))),
      h('div', { class: 's-scroll' }, h('section', { class: 'card empty' }, icon('session', { size: 28 }), h('p', { text: 'Pick a project to direct. Its preview, the agent’s work and your conversation live here.' }), button('Choose project', { kind: 'primary', onclick: chooseProjectSheet }))),
    );
  }
  if (r.id !== id) history.replaceState(null, '', `#/session/${id}`);
  rememberProject(id);
  core.openProject(id);
  void core.restorePreview(id);
  const p = projectById(id);
  const d = detailOf(id);
  const st = core.status();
  const editing = editingOf(p.id);
  const elsewhere = editing && editing.deviceId !== pairing()?.deviceId;
  const mac = macLine();
  const head = h(
    'header',
    { class: 's-head' },
    iconButton('back', sessionBack() === '#/projects' ? 'Back to projects' : 'Back to home', () => go(sessionBack())),
    h(
      'button',
      { class: 's-title', type: 'button', onclick: () => pageMenu({ name: 'session', id }), 'aria-label': `${p.name}. ${mac.aria}. Project actions` },
      h('b', { text: p.name }),
      h('span', { class: `s-mac ${mac.tone}` }, h('span', { class: `dot ${mac.tone}`, 'aria-hidden': 'true' }), h('span', { class: 'ellipsis', text: mac.text })),
    ),
    h(
      'button',
      { class: 'btn s-edit sm', type: 'button', disabled: elsewhere || (!st.live && !editing) || null, 'aria-label': elsewhere ? `${editing.deviceName} is editing this project by hand` : 'Edit the timeline by hand', onclick: () => openEditor(p.id, p.revision) },
      icon('pencil', { size: 16 }),
      h('span', { class: 'lbl', text: 'Edit' }),
    ),
    h('a', { class: 'btn primary sm s-export', href: exportTarget(p, d), 'aria-label': 'Export: review what will be exported' }, icon('exports', { size: 16 }), h('span', { class: 'lbl', text: 'Export' })),
  );
  return h(
    'div',
    { class: 'session' },
    head,
    h(
      'div',
      { class: 's-body' },
      h('div', { class: 's-scroll', 'data-project': p.id }, previewPanel(p, d), emptyProjectCard(p, d), h('section', { class: 's-feed', 'aria-label': 'Session activity' }, feedHead(p, d), thread(p, d))),
      composerSlot(p.id),
    ),
  );
}

// The composer stays where it is across redraws: moving it out of the page, even for a moment, takes the
// focus from the text and iOS closes the keyboard (every update from the Mac would do that mid-sentence).
// A placeholder stands in its place and render() rebuilds everything around it.
function composerSlot(projectId) {
  const root = composer(projectId);
  return app.contains(root) ? h('div', { class: 'composer-slot', 'data-project': projectId }) : root;
}

// Puts `next` in place of `current`, except `keep` (inside current) which stays put where `slot` (inside next) is.
function swapAround(current, next, keep, slot) {
  let o = keep;
  let n = slot;
  while (o !== current) {
    const op = o.parentNode;
    const np = n.parentNode;
    const nodes = [...np.childNodes];
    const at = nodes.indexOf(n);
    for (const ch of [...op.childNodes]) if (ch !== o) ch.remove();
    o.before(...nodes.slice(0, at));
    o.after(...nodes.slice(at + 1));
    copyAttributes(op, np);
    o = op;
    n = np;
  }
}
function copyAttributes(to, from) {
  for (const { name } of [...to.attributes]) if (!from.hasAttribute(name)) to.removeAttribute(name);
  for (const { name, value } of [...from.attributes]) if (to.getAttribute(name) !== value) to.setAttribute(name, value);
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

// The player is kept between redraws so playback isn't interrupted every time the state changes. It owns the
// preview it shows: `revision` is only set once the video for it has actually loaded, and a newer preview is
// swapped in by itself only while nothing is being watched (else the card offers "Load latest preview").
const players = new Map(); // projectId → { box, video, controls, time, seek, playBtn, url, revision, loading, sync }

function player(projectId) {
  let pl = players.get(projectId);
  if (!pl) {
    const video = h('video', { playsinline: true, preload: 'metadata', class: 'video' });
    const toggle = () => (video.paused ? void video.play() : video.pause());
    const playBtn = h('button', { class: 'pv-btn', type: 'button', 'aria-label': 'Play', onclick: toggle }, icon('play', { size: 20 }));
    const time = h('span', { class: 'pv-time tabular', text: '00:00 / 00:00', 'aria-hidden': 'true' });
    const seek = h('input', { class: 'seek', type: 'range', min: 0, max: 1000, value: 0, step: 1, 'aria-label': 'Playback position' });
    const fullBtn = h('button', { class: 'pv-btn', type: 'button', 'aria-label': 'Full screen', onclick: () => fullScreen(pl) }, icon('maximize', { size: 19 }));
    let seeking = false;
    const sync = () => {
      const dur = Number.isFinite(video.duration) ? video.duration : 0;
      time.textContent = `${clock(video.currentTime)} / ${clock(dur)}`;
      seek.setAttribute('aria-valuetext', `${clock(video.currentTime)} of ${clock(dur)}`);
      if (!seeking) seek.value = String(dur ? Math.round((video.currentTime / dur) * 1000) : 0);
      seek.style.setProperty('--p', `${dur ? (video.currentTime / dur) * 100 : 0}%`);
      playBtn.replaceChildren(icon(video.paused ? 'play' : 'pause', { size: 20 }));
      playBtn.setAttribute('aria-label', video.paused ? 'Play' : 'Pause');
    };
    seek.addEventListener('pointerdown', () => (seeking = true));
    seek.addEventListener('input', () => {
      if (Number.isFinite(video.duration)) video.currentTime = (Number(seek.value) / 1000) * video.duration;
      sync();
    });
    seek.addEventListener('change', () => (seeking = false));
    for (const ev of ['timeupdate', 'play', 'pause', 'loadedmetadata', 'ended', 'seeked']) video.addEventListener(ev, sync);
    video.addEventListener('click', toggle);
    // The label follows the media actually in the player, not the download.
    video.addEventListener('loadeddata', () => {
      if (pl.loading === null) return;
      pl.revision = pl.loading;
      pl.loading = null;
      render();
    });
    video.addEventListener('error', () => {
      if (pl.loading === null) return;
      pl.loading = null;
      render();
    });
    const box = h('div', { class: 'pv-frame' }, video);
    const controls = h('div', { class: 'pv-controls' }, playBtn, seek, time, fullBtn);
    pl = { box, video, controls, time, seek, playBtn, url: null, revision: null, loading: null, sync };
    players.set(projectId, pl);
  }
  return pl;
}

/** Full screen keeps the place: the same element goes full screen, and comes back where it was. */
function fullScreen(pl) {
  const v = pl.video;
  if (v.requestFullscreen) void v.requestFullscreen().catch(() => v.webkitEnterFullscreen?.());
  else v.webkitEnterFullscreen?.();
}

/** Puts a downloaded preview into the player, keeping the position; never starts playback by itself. */
function showPreview(pl, pv) {
  const old = pl.url;
  const at = pl.video.currentTime;
  pl.url = pv.url;
  pl.loading = pv.revision ?? null;
  pl.video.src = pv.url;
  pl.video.addEventListener('loadedmetadata', () => (pl.video.currentTime = Math.min(at, pl.video.duration || 0)), { once: true });
  if (old && old !== pv.url) URL.revokeObjectURL(old);
}

/** Someone is watching: playing, or stopped part-way (not at the start or the end). */
const watching = (pl) => Boolean(pl?.url) && (!pl.video.paused || (pl.video.currentTime > 0.05 && !pl.video.ended));

/** The newest preview job the Mac reported for this project, finished or not (a failure included). */
function newestPreviewJob(d) {
  const list = (d?.jobs ?? []).filter((j) => j.kind === 'preview' && j.state !== 'cancelled');
  return list.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0] ?? null;
}

function previewPanel(p, d) {
  const pv = live.previews.get(p.id);
  const remote = d?.preview ?? null; // the Mac's newest preview job that hasn't failed
  const st = core.status();
  const rendering = jobsOf(p.id).find((j) => j.kind === 'preview') ?? (st.live && remote && ['queued', 'running'].includes(remote.state) ? remote : null);
  const failedJob = (() => {
    const j = newestPreviewJob(d);
    return j?.state === 'failed' && !rendering && (!remote || j.revision >= remote.revision) ? j : null;
  })();

  // The footage: the player once a preview is on the phone, else the poster.
  const pl = pv?.url ? player(p.id) : players.get(p.id) ?? null;
  if (pl && pv?.url && pl.url !== pv.url && (!pl.url || !watching(pl))) showPreview(pl, pv);
  let frame;
  if (pl?.url) {
    pl.box.style.setProperty('--arw', String(pv?.width ?? p.width));
    pl.box.style.setProperty('--arh', String(pv?.height ?? p.height));
    pl.sync();
    frame = pl.box;
  } else {
    const url = live.posters.get(p.id)?.url;
    frame = h('div', { class: 'pv-frame placeholder', vars: { '--arw': p.width, '--arh': p.height } }, url ? h('img', { src: url, alt: '' }) : icon('film', { size: 28 }));
  }
  const newer = pl?.url && pv?.url && pl.url !== pv.url ? pv : null; // downloaded, not swapped in (being watched)

  // Line 1: what the player shows. Line 2: what the Mac is rendering, or what is ready / failed / missing.
  const lines = [];
  let showing;
  if (pl?.loading != null) showing = h('p', { class: 'pv-line' }, h('span', { text: `Loading revision ${pl.loading}…` }));
  else if (pl?.revision != null) {
    const latest = pl.revision === p.revision;
    showing = h('p', { class: 'pv-line' }, h('span', { class: 'grow', text: `Showing revision ${pl.revision}` }), latest ? h('span', { class: 'pv-tag ok', text: 'Latest' }) : !st.live && pv?.saved ? h('span', { class: 'pv-tag', text: 'Saved on this phone' }) : null);
  } else if (pv?.state === 'loading') showing = h('p', { class: 'pv-line muted' }, h('span', { text: 'No preview on this phone yet' }));
  else showing = h('p', { class: 'pv-line muted' }, h('span', { text: st.live ? (d ? 'No preview yet' : 'Loading…') : 'No preview saved on this phone' }));
  lines.push(showing);

  const act = [];
  if (pv?.state === 'loading' && pv.pending) {
    const pct = typeof pv.progress === 'number' && pv.progress > 0 ? Math.round(pv.progress * 100) : null;
    lines.push(h('p', { class: 'pv-line' }, h('span', { class: 'grow', text: `Downloading revision ${pv.pending.revision}` }), pct !== null ? h('span', { class: 'pv-pct dl tabular', text: `${pct}%` }) : null), h('div', { class: 'pv-bar download' }, progress(pct !== null ? pv.progress : null, `Downloading the preview of revision ${pv.pending.revision}`)));
  } else if (rendering) {
    const known = rendering.state === 'running' && rendering.progress > 0;
    lines.push(
      h('p', { class: 'pv-line' }, h('span', { class: 'grow', text: `Rendering preview of revision ${rendering.revision}` }), h('span', { class: 'pv-pct tabular', text: known ? `${Math.round(rendering.progress * 100)}%` : rendering.state === 'queued' ? 'Waiting' : 'Starting' })),
      h('div', { class: 'pv-bar render' }, progress(known ? rendering.progress : null, `Rendering the preview of revision ${rendering.revision}`)),
    );
  } else if (newer) {
    lines.push(h('p', { class: 'pv-line' }, h('span', { class: 'grow', text: `Preview of revision ${newer.revision} is ready` })));
    act.push(button('Load latest preview', { small: true, kind: 'mint', iconName: 'refresh', aria: `Load the preview of revision ${newer.revision}`, onclick: () => (showPreview(pl, newer), render()) }));
  } else if (st.live && remote?.state === 'completed' && pv?.jobId !== remote.jobId && (pl?.revision == null || remote.revision > pl.revision)) {
    lines.push(h('p', { class: 'pv-line' }, h('span', { class: 'grow', text: `Preview of revision ${remote.revision} is ready on your Mac` })));
    act.push(button(`Load latest preview${remote.sizeBytes ? ` · ${size(remote.sizeBytes)}` : ''}`, { small: true, kind: 'mint', iconName: 'exports', aria: `Download the preview of revision ${remote.revision}`, onclick: () => core.loadPreview(p.id, remote) }));
  } else if (failedJob) {
    lines.push(h('p', { class: 'pv-line err' }, icon('alert', { size: 15 }), h('span', { class: 'grow', text: `Preview of revision ${failedJob.revision} failed` })));
    if (failedJob.error) lines.push(h('p', { class: 'pv-note', text: clipText(failedJob.error, 140) }));
    if (st.live) act.push(button('Try again', { small: true, iconName: 'refresh', onclick: () => startPreview(p.id) }));
  } else if (pv?.state === 'failed' && pv.error) {
    lines.push(h('p', { class: 'pv-line err' }, icon('alert', { size: 15 }), h('span', { class: 'grow', text: 'The preview didn’t download' })));
    if (st.live && remote?.state === 'completed') act.push(button('Try again', { small: true, iconName: 'refresh', onclick: () => core.loadPreview(p.id, remote) }));
  } else if (pl?.revision != null && pl.revision !== p.revision) {
    lines.push(h('p', { class: 'pv-line muted' }, h('span', { class: 'grow', text: `The timeline is at revision ${p.revision}` })));
    if (st.live) act.push(button('Render preview', { small: true, iconName: 'film', aria: `Render a preview of revision ${p.revision}`, onclick: () => startPreview(p.id) }));
  } else if (!pl?.url && st.live && d && p.durationFrames && !(remote && remote.current)) {
    act.push(button('Render preview', { small: true, iconName: 'film', aria: `Render a preview of revision ${p.revision}`, onclick: () => startPreview(p.id) }));
  }

  return h(
    'section',
    { class: 'pv-card', 'aria-label': 'Preview' },
    h('div', { class: 'pv-stage', vars: { '--arw': pv?.width ?? p.width, '--arh': pv?.height ?? p.height } }, frame),
    pl?.url ? pl.controls : null,
    h('div', { class: 'pv-status', role: 'status', 'aria-live': 'polite' }, lines, act.length ? h('div', { class: 'pv-actions' }, act) : null),
  );
}

// A project with nothing on its timeline yet (a new one, usually): how to get footage in. Files from the phone go
// through the same upload as the composer's attach button and land in the project's media on the Mac; the
// editor's Media tool places them on the timeline.
const emptyPick = h('input', { type: 'file', multiple: true, accept: 'video/*,image/*,audio/*', class: 'visually-hidden', tabindex: '-1', 'aria-hidden': 'true' });
let emptyPickFor = null;
emptyPick.addEventListener('change', async () => {
  const files = [...(emptyPick.files ?? [])];
  emptyPick.value = '';
  for (const f of files) await core.upload(emptyPickFor, f);
});
function emptyProjectCard(p, d) {
  if (p.durationFrames) return null;
  const st = core.status();
  const inLibrary = d ? d.assets.video + d.assets.audio + d.assets.image : 0;
  const editing = editingOf(p.id);
  const elsewhere = editing && editing.deviceId !== pairing()?.deviceId;
  return h(
    'section',
    { class: 'card empty-project', 'aria-label': 'Add media' },
    h('div', { class: 'row gap' }, h('span', { class: 'row-ic mint' }, icon('film', { size: 22 })), h('div', { class: 'grow' }, h('b', { text: inLibrary ? 'Nothing on the timeline yet' : 'This project is empty' }), h('p', { class: 'muted small', text: inLibrary ? `${plural(inLibrary, 'media file')} ${inLibrary === 1 ? 'is' : 'are'} in the project. Place ${inLibrary === 1 ? 'it' : 'them'} on the timeline from Media in the editor, or ask the agent.` : 'Add clips, photos or music from this phone. They’re imported on your Mac.' }))),
    uploadList(p.id),
    h(
      'div',
      { class: 'row gap wrap' },
      button('Add media', { kind: inLibrary ? 'secondary' : 'primary', small: true, iconName: 'plus', disabled: !st.live, onclick: () => ((emptyPickFor = p.id), emptyPick.click()) }),
      button('Edit by hand', { small: true, iconName: 'pencil', disabled: elsewhere || (!st.live && !editing), aria: 'Open the editor to place media on the timeline', onclick: () => openEditor(p.id, p.revision) }),
    ),
    st.live ? null : h('p', { class: 'muted small', text: 'Adding media needs your Mac online: files go straight to it.' }),
    emptyPick,
  );
}

/** Files on their way from this phone to a project, with Try again (same project) for one that failed. */
function uploadList(projectId) {
  const ups = [...live.uploads.entries()].filter(([, u]) => u.projectId === projectId && !(u.state === 'imported' && Date.now() - (u.doneAt ??= Date.now()) > 8000));
  if (!ups.length) return null;
  return h('div', { class: 'uploads' }, ups.map(([uid, u]) => uploadRow(uid, u)));
}
function uploadRow(uid, u) {
  return h(
    'div',
    { class: `upload ${u.state}` },
    icon(u.state === 'imported' ? 'checkCircle' : u.state === 'failed' ? 'alert' : 'attach', { size: 16 }),
    h('span', { class: 'grow ellipsis', text: u.state === 'failed' ? `${u.name}: ${u.error ?? 'failed'}` : u.state === 'cancelled' ? `${u.name} · cancelled` : u.state === 'imported' ? `${u.filename ?? u.name} added to the project` : u.state === 'importing' ? `${u.name} · importing on your Mac` : `${u.name} · ${Math.round((u.progress ?? 0) * 100)}%` }),
    u.state === 'sending' ? iconButton('x', 'Cancel upload', () => core.cancelUpload(uid)) : null,
    ['failed', 'cancelled'].includes(u.state) && u.file ? h('button', { class: 'btn sm ghost retry', type: 'button', disabled: !isLive() || null, 'aria-label': `Try sending ${u.name} again`, onclick: () => core.retryUpload(uid) }, icon('refresh', { size: 15 }), h('span', { text: 'Try again' })) : null,
  );
}

async function startPreview(projectId) {
  const r = await core.command('preview.start', { projectId });
  if (!r) return toast('Your Mac isn’t connected.');
  if (r.t === 'error') return toast(r.message);
  core.openProject(projectId, true);
}

/** "Session activity", and the version history behind a button (it used to sit by the player as chips). */
function feedHead(p, d) {
  const n = d?.versions?.length ?? 0;
  return h(
    'div',
    { class: 'feed-head' },
    h('h2', { text: 'Session activity' }),
    h('button', { class: 'btn sm hist-btn', type: 'button', disabled: !n || null, 'aria-label': n ? `Version history, ${plural(n, 'version')}` : 'Version history: no versions yet', onclick: () => versionHistorySheet(p, d) }, icon('history', { size: 17 }), h('span', { text: 'Version history' })),
  );
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
      { class: 'agent activity', 'aria-live': 'polite', 'data-key': `ask:${ask?.queueId ?? pending?.id ?? ''}` },
      h('div', { class: 'hd' }, icon('spark'), h('span', { class: 'grow', text: 'Agent is planning changes' })),
      h('p', { text: `${clipText(ask?.instruction ?? pending?.instruction ?? '', 70)}${since ? ` · started ${since}` : ''}` }),
      h('ol', { class: 'steps' }, steps.map((s) => h('li', { class: s.state }, h('span', { class: 'step-dot', 'aria-hidden': 'true' }, s.state === 'done' ? icon('check', { size: 12 }) : null), h('span', { text: s.label }), h('span', { class: 'sr', text: s.state === 'done' ? ' complete' : s.state === 'active' ? ' in progress' : ' pending' })))),
      progress(null, 'Planning'),
      st.live
        ? h('div', { class: 'row' }, h('p', { class: 'grow', text: 'Cancel stops the request. Nothing on your timeline changes.' }), button('Cancel', { small: true, kind: 'ghost', iconName: 'x', onclick: () => cancelAsk(p.id) }))
        : h('p', { text: 'Status from before the connection dropped. It’s confirmed once your Mac is back.' }),
    );
  }
  return h(
    'section',
    { class: 'agent activity', 'data-key': `export:${job.id}` },
    h('div', { class: 'hd' }, icon('exports'), h('span', { class: 'grow', text: 'Exporting' }), h('span', { class: 'chip tabular', text: job.state === 'queued' ? 'Waiting' : `${Math.round(job.progress * 100)}%` })),
    progress(job.state === 'queued' ? null : job.progress, 'Export progress'),
    h('div', { class: 'row' }, h('a', { class: 'btn ghost sm', href: '#/exports' }, h('span', { text: 'Open Exports' }), icon('chevronRight', { size: 16 }))),
  );
}

async function cancelAsk(projectId) {
  const r = await core.command('ai.cancel', { projectId });
  if (!r) toast('Your Mac isn’t connected.');
}

/** Oct 30 · Today · Yesterday */
function dayLabel(at) {
  const d = new Date(at);
  const now = new Date();
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(now) - day(d)) / 86_400_000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(d.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }) });
}

/** User messages and the agent's answers (versions), plus instructions not answered yet, by day. */
function thread(p, d) {
  const items = [];
  const versions = [...(d?.versions ?? [])].reverse(); // oldest first
  for (const v of versions) {
    items.push({ at: Date.parse(v.createdAt) - 1, key: `q:${v.id}`, node: userBubble(stripAbout(v.instruction), v.createdAt, v.requestedBy === 'mcp' ? 'From an AI app' : null) });
    items.push({ at: Date.parse(v.createdAt), key: `v:${v.id}`, node: versionCard(p, d, v) });
  }
  const shown = new Set(versions.map((v) => v.id));
  for (const it of core.instructionsFor(p.id)) {
    if (it.state === 'done' && (!it.proposalId || shown.has(it.proposalId))) continue;
    if (it.state === 'cancelled' && Date.now() - (it.finishedAt ?? 0) > 60_000) continue;
    items.push({ at: it.createdAt, key: `i:${it.id}`, node: instructionCard(p, it) });
  }
  const techs = live.activity.filter((a) => a.projectId === p.id);
  if (techs.length) items.push({ at: techs.at(-1).at, key: 'tech', node: h('details', { class: 'tech', open: openDetails.has(`tech:${p.id}`) || null, ontoggle: (e) => remember(`tech:${p.id}`, e.target.open) }, h('summary', { text: `Activity · ${plural(techs.length, 'update')}` }), h('ul', {}, techs.map((a) => h('li', { text: `${ago(a.at)} · ${a.text}` })))) });
  items.sort((a, b) => a.at - b.at);
  const nodes = [];
  let lastDay = null;
  for (const it of items) {
    const label = Number.isFinite(it.at) ? dayLabel(it.at) : null;
    if (label && label !== lastDay) nodes.push(h('div', { class: 'day', text: label }));
    lastDay = label ?? lastDay;
    for (const n of [it.node].flat()) {
      n.dataset.key ??= it.key;
      nodes.push(n);
    }
  }
  return h(
    'div',
    { class: 'thread', 'data-project': p.id, role: 'log', 'aria-label': 'Conversation' },
    unavailableCard({ compact: false }),
    nodes.length ? nodes : h('p', { class: 'muted center empty-thread', text: d ? 'Tell the agent what to change. It proposes; you review before anything is applied.' : isLive() ? 'Loading the conversation…' : 'The conversation appears once your Mac has synced this project.' }),
    activityCard(p, d),
  );
}

const stripAbout = (text) => String(text ?? '').replace(/\n\n\(About the earlier proposal[\s\S]*\)$/, '');

function userBubble(text, when, note) {
  return h('div', { class: 'me' }, h('p', { text }), h('span', { class: 'msg-meta', text: [note, when ? ago(when) : null].filter(Boolean).join(' · ') }));
}

// "View details" panels and the activity log stay open across redraws.
const openDetails = new Set();
function remember(key, open) {
  if (open) openDetails.add(key);
  else openDetails.delete(key);
}

/** A version's standing, in words that say what it means for the user (amber when it needs a look). */
function versionStanding(p, v) {
  if (v.status === 'rejected') return { text: 'Dismissed', tone: 'neutral', why: 'You dismissed this version; nothing of it is on the timeline.' };
  if (v.stale || v.status === 'stale') return { text: 'Out of date', tone: 'warn', why: `The timeline changed after this version was made (from revision ${v.baseRevision}), so it can no longer be applied. Ask again to get one for the timeline as it is now.` };
  if (v.status === 'pending') return { text: 'Ready to review', tone: 'mint', why: 'Nothing is applied until you approve it.' };
  if (v.status === 'applied' && v.appliedRevision === p.revision) return { text: 'On the timeline', tone: 'ok', why: `Applied as revision ${v.appliedRevision}, which is the timeline now.` };
  if (v.status === 'applied') return { text: 'Older version', tone: 'warn', why: `Applied as revision ${v.appliedRevision}; the timeline has changed since (now revision ${p.revision}).` };
  return { text: capital(v.status), tone: 'neutral', why: null };
}

/** The result in one line, from the proposal's own change list. The agent only ever edits the timeline. */
function resultTitle(v) {
  if (!v.changes) return 'Nothing changed on the timeline';
  if (v.list.length !== v.changes) return `Timeline: ${plural(v.changes, 'change')}`;
  const counts = new Map();
  for (const c of v.list) counts.set(`${c.kind}|${c.target}`, (counts.get(`${c.kind}|${c.target}`) ?? 0) + 1);
  const parts = [...counts].map(([k, n]) => {
    const [kind, target] = k.split('|');
    return `${kind} ${plural(n, target)}`;
  });
  return `Timeline: ${parts.join(', ')}`;
}

function versionCard(p, d, v) {
  const s = versionStanding(p, v);
  const pending = v.status === 'pending' && !v.stale;
  const onTimeline = v.status === 'applied' && v.appliedRevision === p.revision;
  const pl = players.get(p.id);
  const list = v.list ?? [];
  const removed = list.some((c) => c.kind === 'removed');
  // Proposals are timeline operations only: nothing in one can delete a file from the media library.
  const assetsNote = !v.changes ? 'No assets were deleted. The media library is unchanged.' : removed ? 'Removed from the timeline only. No assets were deleted.' : null;
  const key = `v:${v.id}`;
  const detailActions = [];
  detailActions.push(button(pending ? 'Review & export' : 'Open', { small: true, kind: pending ? 'mint' : 'secondary', iconName: 'chevronRight', onclick: () => go(`#/review/${p.id}/${v.id}`) }));
  if (onTimeline && pl?.url && pl.revision === p.revision) detailActions.push(button('Watch', { small: true, iconName: 'play', onclick: () => watch(p.id) }));
  if (onTimeline && isLive() && d?.canUndo) detailActions.push(button('Undo on the Mac', { small: true, kind: 'ghost', iconName: 'undo', onclick: () => history_(p.id, 'undo', p.revision) }));
  const reasons = v.reasons ?? [];
  const warnings = v.warnings ?? [];
  return h(
    'article',
    { class: 'agent result', 'aria-label': `Version ${v.version}: ${resultTitle(v)}. ${s.text}` },
    h('div', { class: 'hd' }, icon('spark'), h('span', { class: 'grow', text: resultTitle(v) })),
    h('p', { text: v.summary || (v.changes ? 'The agent didn’t write a summary.' : 'The agent proposed no changes.') }),
    assetsNote ? h('p', { class: 'res-note', text: assetsNote }) : null,
    pending ? h('div', { class: 'row' }, button('Review', { small: true, kind: 'mint', iconName: 'chevronRight', aria: `Review version ${v.version}`, onclick: () => go(`#/review/${p.id}/${v.id}`) })) : null,
    h(
      'details',
      { class: 'res-more', open: openDetails.has(key) || null, ontoggle: (e) => remember(key, e.target.open) },
      h('summary', { 'aria-label': `Version ${v.version}, ${s.text}. View details` }, h('span', { class: `vbadge ${s.tone}`, text: `V${v.version} · ${s.text}` }), h('span', { class: 'spacer' }), h('span', { class: 'res-link', 'aria-hidden': 'true' }, h('span', { class: 'when-closed', text: 'View details' }), h('span', { class: 'when-open', text: 'Hide details' }), icon('chevronRight', { size: 16 }))),
      h(
        'div',
        { class: 'res-body' },
        s.why ? h('p', { class: 'muted small', text: s.why }) : null,
        list.length
          ? h(
              'ul',
              { class: 'changes' },
              list.map((c) => h('li', {}, icon(c.kind === 'removed' ? 'x' : c.kind === 'added' ? 'plus' : 'check', { size: 16 }), h('span', { class: 'grow' }, h('span', { class: 'block', text: `${capital(c.kind)} ${c.target}: ${c.label}` }), c.before ? h('span', { class: 'block muted small diff', text: `− ${c.before}` }) : null, c.after ? h('span', { class: 'block small diff', text: `+ ${c.after}` }) : null))),
            )
          : null,
        v.changes > list.length ? h('p', { class: 'muted small', text: `and ${v.changes - list.length} more on your Mac` }) : null,
        reasons.length ? [h('h3', { class: 'res-h', text: 'Why' }), h('ul', { class: 'res-why' }, reasons.map((r) => h('li', { text: r })))] : null,
        warnings.length ? [h('h3', { class: 'res-h', text: plural(warnings.length, 'warning') }), h('ul', { class: 'warnings' }, warnings.map((w) => h('li', {}, icon('alert', { size: 16 }), h('span', { text: w }))))] : null,
        h('p', { class: 'muted small', text: [v.model ? `Model ${v.model}` : null, `made from revision ${v.baseRevision}`, v.appliedRevision !== null && v.appliedRevision !== undefined ? `applied as revision ${v.appliedRevision}${v.approval?.channel ? ` (${v.approval.channel})` : ''}` : null, ago(v.createdAt)].filter(Boolean).join(' · ') }),
        h('div', { class: 'row' }, detailActions),
      ),
    ),
  );
}

/** Plays the session preview from the start (Watch on a version that is on the timeline). */
function watch(projectId) {
  const pl = players.get(projectId);
  if (!pl) return;
  pl.video.currentTime = 0;
  void pl.video.play();
  pl.box.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

const INSTRUCTION_STATE = {
  local: ['Saved on this phone', 'neutral', 'phone', 'It goes to the relay as soon as there’s a connection.'],
  queued: ['Queued', 'neutral', 'queue', 'Waiting on the relay. It runs when your Mac takes it.'],
  accepted: ['Accepted', 'mint', 'check', 'Your Mac took it.'],
  running: ['Running', 'orange', 'director', 'The agent is working on it.'],
  needs_review: ['Needs review', 'warn', 'alert', null],
  done: ['Review ready', 'mint', 'checkCircle', null],
  failed: ['Not applied', 'error', 'alert', null],
  expired: ['Expired', 'neutral', 'clock', 'It waited too long and was not run.'],
  cancelled: ['Cancelled', 'neutral', 'x', null],
};

function instructionCard(p, it) {
  // Taken by the Mac: "Agent is planning changes" (activityCard) reports it, from the Mac's own events.
  if (['accepted', 'running'].includes(it.state)) return userBubble(it.instruction, it.createdAt, it.about ? 'About a version' : null);
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
      ? it.reason === 'editing'
        ? 'It arrived while the project was being edited by hand, so it didn’t run. Run it on the timeline as it is now, or cancel it.'
        : `The timeline changed on your Mac since you wrote this (revision ${it.baseRevision} → ${it.currentRevision}). Run it on the timeline as it is now, or cancel it.`
      : it.state === 'failed'
        ? it.error ?? 'The agent couldn’t do that.'
        : hint;
  const warn = it.state === 'failed' || it.state === 'needs_review';
  const waiting = ['local', 'queued', 'accepted', 'running'].includes(it.state);
  const title = it.state === 'failed' ? 'Couldn’t do that' : it.state === 'needs_review' ? 'Waiting for you' : waiting ? 'Waiting for the result' : text;
  return [
    userBubble(it.instruction, it.createdAt, it.about ? 'About a version' : null),
    h(
      'div',
      { class: `agent${warn ? ' warn' : ''}` },
      h('div', { class: 'hd' }, icon(warn ? 'alert' : (ic ?? 'spark')), h('span', { class: 'grow', text: title })),
      why ? h('p', { text: why }) : null,
      h('div', { class: 'row res-foot' }, h('span', { class: `vbadge ${warn ? 'warn' : tone === 'orange' ? 'mint' : tone}`, text: text }), actions),
    ),
  ];
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

// At most three, short enough to fit a 320 px screen side by side; a tap writes one into the field to read
// over (or change) before sending, it never sends by itself.
const SUGGESTIONS = [
  ['Cut pauses', 'Cut the pauses and silences'],
  ['Add music', 'Add background music'],
  ['Make it 15 s', 'Make it 15 seconds long'],
];
let justSent = null; // project id: the next redraw follows the conversation to its end

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
      fit();
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
    // One tap, one instruction: a second tap while the first is being taken does nothing. The text is put in
    // the phone's outbox before the field is cleared, so a failed send or a lost connection never loses it
    // (the card in the conversation offers Edit / Try again).
    let sending = false;
    const submit = () => {
      if (sending) return;
      const text = area.value.trim();
      if (!text) return area.focus();
      sending = true;
      setTimeout(() => (sending = false), 700);
      justSent = projectId;
      const ab = pendingAbout?.projectId === projectId ? pendingAbout.versionId : null;
      core.addInstruction(projectId, text, { about: ab });
      pendingAbout = null;
      area.value = '';
      core.setDraft(projectId, '');
      grow();
      fit();
      maybeAskForNotifications('instruction');
      render();
    };
    sendBtn.addEventListener('click', submit);
    // Ready-made asks, only while the field is empty.
    const suggest = h(
      'div',
      { class: 'suggest', role: 'group', 'aria-label': 'Suggestions' },
      SUGGESTIONS.map(([label, text]) =>
        h('button', { class: 'chip', type: 'button', 'aria-label': `Suggestion: ${text}. Puts it in the message box`, onclick: () => {
          area.value = text;
          core.setDraft(projectId, area.value);
          grow();
          fit();
          area.focus();
        } }, label),
      ),
    );
    const fit = () => (suggest.hidden = Boolean(area.value.trim()));
    const root = h('div', { class: 'composer', role: 'form', 'aria-label': 'Message the agent' }, about, uploads, hint, suggest, h('div', { class: 'composer-row' }, attach, area, sendBtn), file);
    c = { root, area, sendBtn, hint, about, uploads, grow, fit };
    composers.set(projectId, c);
    fit();
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
  // An empty project lists its uploads in its Add media card instead.
  const ups = projectById(projectId)?.durationFrames === 0 ? [] : [...live.uploads.entries()].filter(([, u]) => u.projectId === projectId && !(u.state === 'imported' && Date.now() - (u.doneAt ??= Date.now()) > 8000));
  c.uploads.replaceChildren(...ups.map(([uid, u]) => uploadRow(uid, u)));
  return c.root;
}

// ── Review ──────────────────────────────────────────────────────────────────
const reviewOpened = new Map(); // `${project}:${version}` → newest version number when opened
const exportChoice = { resolution: 'full', quality: 'standard' };

function reviewScreen(r) {
  const p = projectById(r.id);
  if (!p) return [h('section', { class: 'card empty' }, h('p', { text: 'That project isn’t synced on this phone.' }), button('Projects', { onclick: () => go('#/projects') }))];
  rememberProject(p.id);
  core.openProject(p.id);
  const d = detailOf(p.id);
  const v = d?.versions?.find((x) => x.id === r.version);
  if (!v) return [d ? h('section', { class: 'card empty' }, h('p', { text: 'This version isn’t in the recent history any more.' })) : skeleton()];
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
  const target = pending
    ? exportTargetCard(p, { target: `Version ${v.version}`, revision: null, preview: `Approving applies version ${v.version} to revision ${v.baseRevision} on your Mac, then exports the revision that makes. No preview of it exists until then.` })
    : v.status === 'applied'
      ? exportTargetCard(p, { target: `Revision ${v.appliedRevision}`, revision: v.appliedRevision })
      : null;
  // The target moved on while this was open (or before): offer the timeline as it is now, to review again.
  const latest = (v.stale || (v.status === 'applied' && !appliedCurrent)) && exportTarget(p, d) !== location.hash ? exportTarget(p, d) : null;
  const requestInput = h('input', {
    class: 'field request',
    type: 'text',
    placeholder: 'Request a change…',
    'aria-label': 'Request a change to this version',
    enterkeyhint: 'go',
    onkeydown: (e) => e.key === 'Enter' && requestChange(p, v, e.target.value),
  });
  return [
    target,
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
          (() => {
            const s = versionStanding(p, v);
            return h('span', { class: `vbadge ${s.tone}`, text: s.text });
          })(),
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
    latest ? button(`Review revision ${p.revision} instead`, { kind: 'mint', full: true, iconName: 'refresh', onclick: () => go(latest) }) : null,
    button(pending ? 'Approve & export' : 'Export this version', {
      kind: 'primary',
      iconName: 'exports',
      full: true,
      disabled: Boolean(cannot) || exportBusy,
      onclick: () => approveAndExport(p, v, pending ? v.id : v.status === 'applied' ? v.id : null, exportRevision),
    }),
    adjustButton(p, v, pending, appliedCurrent),
    pending && isLive() ? button('Dismiss this version', { kind: 'ghost', full: true, onclick: () => dismissVersion(v) }) : null,
    h('div', { class: 'row between mt' }, button('Version history', { small: true, iconName: 'history', onclick: () => versionHistorySheet(p, d) })),
    projectExports(p.id),
  ];
}

/** "Adjust edit": fix the agent's result by hand. A pending version is applied first (with the user's OK). */
function adjustButton(p, v, pending, appliedCurrent) {
  const why = !isLive() ? 'Editing needs your Mac online.' : v.stale ? 'This version is out of date.' : v.status === 'rejected' ? 'This version was dismissed.' : !pending && !appliedCurrent ? 'The timeline changed after this version; edit the latest instead.' : null;
  const go2 = () => {
    if (appliedCurrent) return openEditor(p.id, p.revision);
    sheet(
      `Adjust version ${v.version}?`,
      h(
        'div',
        { class: 'stack' },
        h('p', { text: `Version ${v.version} is applied to the timeline first, then you fix it by hand. Undo on the Mac takes it back.` }),
        button('Apply & edit', {
          kind: 'mint',
          full: true,
          iconName: 'pencil',
          onclick: async () => {
            closeSheet();
            const r = await core.command('proposal.apply', { proposalId: v.id });
            if (!r) return toast('Your Mac isn’t connected.');
            if (r.t === 'error') return toast(r.message);
            core.openProject(p.id, true);
            openEditor(p.id, r.revision);
          },
        }),
        button('Cancel', { kind: 'ghost', full: true, onclick: closeSheet }),
      ),
    );
  };
  return h('div', { class: 'stack-tight' }, button('Adjust edit', { full: true, iconName: 'pencil', disabled: Boolean(why), onclick: go2 }), why && (pending || appliedCurrent || v.stale) ? h('p', { class: 'muted small center', text: why }) : null);
}

// ── Review of a manual edit (a revision, not an agent version) ─────────────
function reviewRevisionScreen(r) {
  const p = projectById(r.id);
  if (!p) return [h('section', { class: 'card empty' }, h('p', { text: 'That project isn’t synced on this phone.' }), button('Projects', { onclick: () => go('#/projects') }))];
  rememberProject(p.id);
  core.openProject(p.id);
  const d = detailOf(p.id);
  const n = r.revision;
  // The editing session that led here (Done names it): its last step may sit under a later desktop edit.
  const s = (r.session ? d?.manual?.find((x) => x.sessionId === r.session) : null) ?? d?.manual?.find((x) => x.toRevision === n) ?? null;
  const current = p.revision === n;
  if (!live.exportOptions.has(p.id) && isLive()) void core.command('export.options', { projectId: p.id }, { wait: false });
  const opts = live.exportOptions.get(p.id);
  const res = opts?.resolutions?.find((x) => x.id === exportChoice.resolution) ?? opts?.resolutions?.[0];
  const pv = live.previews.get(p.id);
  const cannot = !current ? `The export target changed: the timeline moved from revision ${n} to ${p.revision} while this was open. Review the new target before exporting.` : !isLive() ? 'Exporting runs on your Mac, so it needs to be online.' : null;
  // Consecutive repeats read as one line: "Trim clip × 3".
  const steps = [];
  for (const label of s?.steps ?? []) {
    const last = steps.at(-1);
    if (last?.label === label) last.n += 1;
    else steps.push({ label, n: 1 });
  }
  return [
    exportTargetCard(p, { target: `Revision ${n}`, revision: n }),
    !current ? h('section', { class: 'card notice warn' }, h('p', { text: `The export target changed while this was open: the timeline is now at revision ${p.revision}.` }), button(`Review revision ${p.revision}`, { small: true, kind: 'mint', iconName: 'refresh', onclick: () => go(exportTarget(p, detailOf(p.id))) })) : null,
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
          h('h2', { text: `${p.name} · Manual edit` }),
          pill(current ? `Revision ${n} · current` : `Revision ${n}`, current ? 'ok' : 'warn', current ? 'check' : 'alert'),
          h('p', { class: 'muted small mt', text: s ? `Edited by hand${s.deviceName ? ` on ${s.deviceName}` : ''} · ${ago(s.endedAt)}` : d ? 'Edited by hand' : 'Loading…' }),
          s?.steps.length === 0 ? h('p', { text: s.undone ? 'Everything in this edit was undone.' : 'No changes in this edit.' }) : d && !s ? h('p', { class: 'muted', text: 'The timeline as it is now on your Mac.' }) : null,
        ),
      ),
      steps.length ? h('ul', { class: 'changes' }, steps.map((x) => h('li', {}, icon('check', { size: 16 }), h('span', { class: 'grow', text: x.n > 1 ? `${x.label} × ${x.n}` : x.label })))) : null,
      s?.undone ? h('p', { class: 'muted small', text: `${plural(s.undone, 'step')} undone along the way.` }) : null,
      h('p', { class: 'muted small', text: pv?.url && pv.revision === n ? 'The preview in Session shows this revision.' : 'A preview of this revision renders on your Mac; it shows in Session when ready.' }),
      h('div', { class: 'row gap' }, button('Adjust edit', { small: true, iconName: 'pencil', disabled: !current || !isLive(), onclick: () => openEditor(p.id, p.revision) }), button('Continue with agent', { small: true, kind: 'mint', iconName: 'director', onclick: () => continueWithAgent(p) })),
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
    button(`Export revision ${n}`, { kind: 'primary', iconName: 'exports', full: true, disabled: Boolean(cannot) || exportBusy, onclick: () => approveAndExport(p, null, null, n) }),
    projectExports(p.id),
  ];
}

/** Back to the conversation with the agent; its next instruction starts from the latest revision. */
function continueWithAgent(p) {
  openSession(p.id);
  requestAnimationFrame(() => composers.get(p.id)?.area.focus());
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

/** The agent's versions of this project, newest first, each with where it stands now; a tap opens it. */
function versionHistorySheet(p, d) {
  const list = d?.versions ?? [];
  sheet(
    'Version history',
    list.length
      ? h(
          'div',
          { class: 'list vhist' },
          h('p', { class: 'muted small', text: `The timeline is at revision ${p.revision}.` }),
          list.map((v) => {
            const s = versionStanding(p, v);
            return h(
              'button',
              { class: `row-card${s.tone === 'ok' ? ' on' : ''}`, type: 'button', 'aria-label': `Version ${v.version}, ${s.text}. ${resultTitle(v)}. Open`, onclick: () => (closeSheet(), go(`#/review/${p.id}/${v.id}`)) },
              h('span', { class: 'row-text' }, h('span', { class: `vbadge ${s.tone}`, text: `V${v.version} · ${s.text}` }), h('b', { class: 'ellipsis', text: resultTitle(v) }), v.summary ? h('span', { class: 'muted small clamp2', text: v.summary }) : null, h('span', { class: 'muted small', text: `${ago(v.createdAt)} · from revision ${v.baseRevision}${v.appliedRevision != null ? ` → ${v.appliedRevision}` : ''}` })),
              icon('chevronRight', { size: 18 }),
            );
          }),
        )
      : h('p', { class: 'muted', text: 'No versions yet. Each answer from the agent becomes a version here.' }),
  );
}

/**
 * What an export will be of, said before it starts: the target revision (from the project and the export
 * rule: the engine exports exactly the revision named, and refuses if the timeline moved), next to the
 * revision the Session player is showing when that is a different one.
 */
function exportTargetCard(p, { target, revision, preview }) {
  const pl = players.get(p.id);
  const playing = pl?.revision ?? null;
  const differs = playing !== null && playing !== revision;
  return h(
    'section',
    { class: 'card target', 'aria-label': 'Export target' },
    h('div', { class: 'target-row' }, h('span', { class: 'muted', text: 'Export target' }), h('b', { class: 'tabular', text: target })),
    playing !== null
      ? h('div', { class: `target-row${differs ? ' warn' : ''}` }, h('span', { class: 'muted', text: 'Preview playing' }), h('b', { class: 'tabular', text: `Revision ${playing}` }))
      : h('div', { class: 'target-row' }, h('span', { class: 'muted', text: 'Preview playing' }), h('span', { class: 'muted', text: 'None on this phone' })),
    preview ? h('p', { class: 'muted small', text: preview }) : differs ? h('p', { class: 'small warn-text', text: `The preview you watched is revision ${playing}, not the export target. The export renders revision ${revision} from the timeline on your Mac.` }) : null,
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
    if (c) {
      c.area.value = next;
      c.fit();
    }
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
function exportsScreen(focus = null) {
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
    body.push(h('div', { class: 'list' }, list.map((e) => exportRow(e, { job: jobs.get(e.id), focus: e.id === focus }))));
  }
  return body;
}

function exportRow(e, { compact = false, job = null, focus = false } = {}) {
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
    { class: `export-card${compact ? ' compact' : ''}${focus ? ' focus' : ''}`, id: compact ? null : `export-${e.id}` },
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
/** `part`: 'all' (phone), or the iPad rail's 'mac' (devices, status) and 'settings' (notifications, pairing). */
function openDeviceSheet(part = 'all') {
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
    const mac = part !== 'settings';
    const settings = part !== 'mac';
    body.replaceChildren(
      ...[
      mac && h('div', { class: 'list' }, saved.pairings.map((x) =>
        h(
          'button',
          { class: `row-card device${x.macId === p?.macId ? ' on' : ''}`, type: 'button', 'aria-current': x.macId === p?.macId ? 'true' : null, onclick: () => (x.macId === p?.macId ? null : core.switchMac(x.macId).then(fill)) },
          icon('monitor'),
          h('span', { class: 'row-text' }, h('b', { text: x.macName }), h('span', { class: 'muted small', text: x.macId === p?.macId ? `${w.word}${w.detail ? ` · ${w.detail}` : ''}` : 'Tap to switch' })),
          x.macId === p?.macId ? icon('check', { size: 18 }) : null,
        ),
      )),
      mac && h('dl', { class: 'facts' }, rows.map(([k, v]) => [h('dt', { text: k }), h('dd', { text: v })])),
      settings && notificationsCard(),
      settings && button('Pair another Mac', { iconName: 'plus', full: true, onclick: () => (closeSheet(), go('#/pair')) }),
      settings && h('p', { class: 'muted small', text: 'Other phones are managed on the Mac: ReelForge → Settings → Remote Access → Paired devices.' }),
      settings && p ? button('Unpair', { kind: 'danger', full: true, iconName: 'trash', onclick: () => removeThisPhone(p) }) : null,
      ].filter(Boolean),
    );
  };
  fill();
  const { close } = sheet(part === 'settings' ? 'Settings' : (pairing()?.macName ?? 'Your Mac'), body);
  sheetUpdate = fill;
  return close;
}
let sheetUpdate = null;

async function removeThisPhone(p) {
  if (!confirm(`Remove this phone from ${p.macName}? You’ll need a new pairing code to connect again.`)) return;
  await core.forgetPairing(p.macId);
  closeSheet();
  go(saved.pairings.length ? '#/' : '#/pair');
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
    if (p && st.live) items.push(['pencil', 'Rename project', () => renameSheet(p)], ['trash', 'Delete project', () => deleteSheet(p), 'danger']);
  }
  if (r.name === 'session' && r.id && (st.live || editingOf(r.id))) items.splice(1, 0, ['pencil', 'Edit by hand', () => openEditor(r.id, projectById(r.id).revision)]);
  if (r.name === 'review') items.push(['history', 'Version history', () => versionHistorySheet(projectById(r.id), detailOf(r.id))]);
  items.push(['refresh', 'Refresh from the Mac', () => (st.live ? core.command('sync', {}, { wait: false }) : core.connect())]);
  items.push(['monitor', 'Device & pairing', openDeviceSheet]);
  sheet('Actions', h('div', { class: 'list' }, items.map(([ic, label, fn, tone]) => h('button', { class: `option${tone === 'danger' ? ' danger' : ''}`, type: 'button', onclick: () => (closeSheet(), fn()) }, icon(ic), h('span', { class: 'grow', text: label })))));
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
    app.replaceChildren(header({ back: saved.pairings.length ? '#/' : null }), h('main', { class: 'page' }, pairScreen(r)));
    return;
  }
  if (r.name === 'edit') {
    document.body.dataset.screen = 'edit';
    if (!projectById(r.id) && !editorActive()) {
      app.replaceChildren(header({ back: '#/projects' }), h('main', { class: 'page' }, h('section', { class: 'card empty' }, h('p', { text: 'That project isn’t synced on this phone.' }), button('Projects', { onclick: () => go('#/projects') }))));
      return;
    }
    const root = editScreen({ ...r, from: editReturn ?? `#/session/${r.id}` });
    if (app.firstChild !== root || app.childNodes.length !== 1) app.replaceChildren(root);
    if (lastRoute !== location.hash) queueMicrotask(keyboardOffset);
    lastRoute = location.hash;
    return;
  }
  if (editorActive()) leaveEditor();
  const fromScreen = document.body.dataset.screen;
  document.body.dataset.screen = r.name;
  const routeKey = location.hash;
  const fresh = routeKey !== lastRoute;
  lastRoute = routeKey;
  // Leaving the gallery remembers where it was scrolled to; coming back from a project puts it back there.
  if (fresh && fromScreen === 'projects') gallery.scrollY = window.scrollY;
  let restoreY = null;
  if (fresh && r.name === 'projects' && ['session', 'review', 'review-rev', 'edit'].includes(fromScreen)) restoreY = gallery.scrollY;

  if (r.name === 'session') {
    // Preview and conversation scroll together between the header and the composer. Redraws keep the place;
    // the view follows to the end only for something new in the conversation while the reader was already
    // near the end, or right after they sent an instruction themselves.
    const old = feedScroller();
    const keep = !fresh && old ? { top: old.scrollTop, bottom: old.scrollHeight - old.scrollTop - old.clientHeight < 64, project: app.querySelector('.s-scroll')?.dataset.project, sig: feedSignature() } : null;
    const next = sessionScreen(r);
    const slot = next.querySelector('.composer-slot');
    const kept = slot && composers.get(slot.dataset.project)?.root;
    const current = kept && app.firstElementChild;
    if (current && app.childElementCount === 1 && current.contains(kept)) swapAround(current, next, kept, slot);
    else {
      if (slot) slot.replaceWith(composers.get(slot.dataset.project).root);
      app.replaceChildren(next);
    }
    const t = feedScroller();
    if (t) {
      const project = app.querySelector('.s-scroll')?.dataset.project;
      const same = keep && keep.project === project;
      if (!same || justSent === project || (keep.bottom && feedSignature() !== keep.sig)) t.scrollTop = t.scrollHeight;
      else t.scrollTop = keep.top;
      if (justSent === project) justSent = null;
    }
  } else if (r.name === 'review' || r.name === 'review-rev') {
    const p = projectById(r.id);
    app.replaceChildren(
      h(
        'div',
        { class: 'sub-page' },
        h('header', { class: 's-head' }, iconButton('back', 'Back', () => go(`#/session/${r.id}`)), h('div', { class: 's-title' }, h('b', { text: 'Review & export' }), p ? h('span', { class: 'ellipsis', text: p.name }) : null)),
        h('main', { class: 'page', id: 'main' }, r.name === 'review' ? reviewScreen(r) : reviewRevisionScreen(r)),
      ),
    );
  } else {
    const name = r.name;
    const head = name === 'home' ? homeHeader() : name === 'projects' ? projectsHeader() : topbar('Exports');
    const content = name === 'home' ? homeScreen() : name === 'projects' ? projectsScreen() : exportsScreen(r.focus);
    app.replaceChildren(h('div', { class: 'home' }, rail(name), h('div', { class: 'shell' }, head, h('main', { class: 'scroll', id: 'main' }, content), tabs(name))));
  }
  if (restoreY !== null) requestAnimationFrame(() => window.scrollTo(0, restoreY));
  else if (fresh) {
    window.scrollTo(0, 0);
    if (r.name === 'exports' && r.focus) requestAnimationFrame(() => document.getElementById(`export-${r.focus}`)?.scrollIntoView({ block: 'center' }));
  }
  sheetUpdate && sheetIsOpen() ? sheetUpdate() : null;
  if (fresh) queueMicrotask(keyboardOffset); // the full-screen views take their height from it
}

/** What scrolls the Session's conversation: the whole page on a phone, the conversation column on an iPad. */
function feedScroller() {
  const s = app.querySelector('.session .s-scroll');
  if (!s) return null;
  return getComputedStyle(s).display === 'contents' ? app.querySelector('.session .s-feed') : s;
}
/** The conversation's items, in order: a change means something new arrived (not just a status tick). */
const feedSignature = () => [...app.querySelectorAll('.session .thread > [data-key]')].map((n) => n.dataset.key).join(',');

core.onChange(() => {
  // The editor keeps its own DOM and never rebuilds a field being typed in.
  if (route().name === 'edit') return render();
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

// The on-screen keyboard. iOS doesn't shrink the layout viewport for it, so while a field has the keyboard
// the full-screen views (Session, editor) are sized to what is actually visible, which keeps the composer
// and the editor's fields above the keys. Whether the keyboard is up is judged against the tallest the
// visible area has been, not against window.innerHeight: some iOS versions shrink that along with the
// keyboard, and then the two never differ. Only a keyboard that takes room counts, never focus alone
// (a hardware keyboard on an iPad leaves just a slim bar).
const vv = window.visualViewport;
const typingField = () => document.activeElement?.matches?.('textarea, input:not([type=checkbox]):not([type=range]):not([type=file])');
const fixedScreen = () => ['session', 'edit'].includes(document.body.dataset.screen);
const standalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
let vvFull = 0;
let vvWidth = 0;
function keyboardOffset() {
  if (!vv) return;
  if (window.innerWidth !== vvWidth) [vvWidth, vvFull] = [window.innerWidth, 0]; // turned on its side
  vvFull = Math.max(vvFull, vv.height, window.innerHeight);
  // Installed on the home screen the app owns the whole screen, so its height is the screen's (screen.* is
  // in portrait terms on iOS, hence matching on the width to pick the side).
  if (standalone()) {
    if (window.innerWidth === screen.width) vvFull = Math.max(vvFull, screen.height);
    else if (window.innerWidth === screen.height) vvFull = Math.max(vvFull, screen.width);
  }
  // As the keyboard closes iOS reports the height in steps; following those would walk the screen down
  // slowly, so the full height comes back the moment typing ends.
  const keyboard = typingField() && vvFull - vv.height > 120;
  // A conversation read at its latest message stays there as the keyboard takes or gives back room.
  const thread = feedScroller();
  const atBottom = thread && thread.scrollHeight - thread.scrollTop - thread.clientHeight < 64;
  const root = document.documentElement.style;
  // iOS 26 can leave the layout viewport ~70 px short once the keyboard has gone (WebKit bug 301857), and
  // 100lvh and fixed layouts follow it, leaving a black band under the composer. Installed, the screen never
  // changes size otherwise, so the full-screen views are pinned to the tallest height seen instead.
  root.setProperty('--vvh', keyboard ? `${Math.round(vv.height)}px` : standalone() && fixedScreen() ? `${Math.round(vvFull)}px` : '');
  // Only a sheet over a scrolled page (Home) needs where the visible part starts; the full-screen views are
  // put back at the top instead, so nothing follows iOS panning the page under the keys.
  root.setProperty('--vvt', keyboard && !fixedScreen() ? `${Math.round(vv.offsetTop)}px` : '');
  document.body.classList.toggle('kb-open', keyboard);
  // iOS 26 also leaves the visual viewport offset after the keyboard closes; scrolling home resets it.
  if (fixedScreen() && (keyboard || window.scrollY || vv.offsetTop)) window.scrollTo(0, 0);
  if (atBottom) thread.scrollTop = thread.scrollHeight;
  healViewport();
}

// Installed on the home screen, iOS 26 can leave the web view's viewport a status bar short (852 → 793 on a
// Dynamic Island iPhone) once the keyboard has gone, until the app is force-quit. Fixed elements are then
// clipped to that short viewport and the strip under it stays black; no reflow brings it back. Content in
// the page's normal flow still paints there, so while the viewport is short the full-screen views stop
// being fixed and are laid out from the top of a page that is as tall as the screen (on an iPhone running
// iOS 26 the viewport then came back to full height by itself within a frame).
let innerFull = 0;
let innerWidth0 = 0;
function healViewport() {
  if (window.innerWidth !== innerWidth0) [innerWidth0, innerFull] = [window.innerWidth, 0];
  innerFull = Math.max(innerFull, window.innerHeight, standalone() ? vvFull : 0);
  const short = standalone() && fixedScreen() && !document.body.classList.contains('kb-open') && innerFull - window.innerHeight > 4;
  const html = document.documentElement;
  html.classList.toggle('vp-short', short);
  if (short && window.scrollY) window.scrollTo(0, 0);
}
window.addEventListener('scroll', () => document.documentElement.classList.contains('vp-short') && window.scrollY && window.scrollTo(0, 0), { passive: true });

vv?.addEventListener('resize', keyboardOffset);
vv?.addEventListener('scroll', keyboardOffset);
window.addEventListener('resize', keyboardOffset);
// After the tick, so moving from one field to another doesn't count as leaving.
// iOS reports the keyboard going in steps and sometimes not the last one, so look again once it has settled.
document.addEventListener('focusout', () => [0, 150, 400, 800].forEach((ms) => setTimeout(keyboardOffset, ms)));
// The keyboard takes a moment to come up, and not every iOS version reports it when it has.
document.addEventListener('focusin', () => [50, 300, 600].forEach((ms) => setTimeout(keyboardOffset, ms)));

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return closeScanner();
  void core.ping();
  const r = route();
  if (r.name === 'session' && r.id) core.openProject(r.id, true);
});

navigator.serviceWorker?.addEventListener('message', (e) => {
  if (typeof e.data?.open === 'string' && e.data.open.startsWith('/')) location.hash = new URL(e.data.open, location.origin).hash || '#/';
});

setInterval(() => !document.hidden && !document.activeElement?.matches?.('input, textarea') && route().name !== 'edit' && render(), 30_000); // keeps "2 min ago" honest

initEditor({
  toast,
  go,
  render,
  projectById,
  detailOf,
  // One sound at a time: the Session player stops when the editor opens.
  pausePlayers: () => players.forEach((pl) => pl.video.pause()),
  modelLabel,
  deviceSheet: () => openDeviceSheet(),
});
keyboardOffset();

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
