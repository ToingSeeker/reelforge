// The editor's studio panels, the ones that need the Mac to do work beyond a timeline edit: face-tracked AI
// effects (baked by the effects engine on the Mac), captions from speech (transcribed on the Mac), media,
// motion-graphic templates (rendered on the Mac), the AI Director and settings. Whatever ends up on the
// timeline still goes through the editor's own queue (ed.submit), so it is one undo step of this session,
// checked by the same rules, and never written behind the phone's back.
import * as core from './core.js';
import * as M from './edit-model.js';
import { completeSlash, isSlashCommand, slashSuggestions } from './slash.js';
import { button, h, icon, iconButton } from './ui.js';

const { live } = core;
const uuid = () => crypto.randomUUID();
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const POLL_MS = 1500;
const MAX_FX = 20;
const LANGUAGES = [
  ['auto', 'Detect'],
  ['en', 'English'],
  ['id', 'Indonesian'],
  ['es', 'Spanish'],
  ['pt', 'Portuguese'],
  ['fr', 'French'],
  ['de', 'German'],
  ['it', 'Italian'],
  ['nl', 'Dutch'],
  ['ja', 'Japanese'],
  ['ko', 'Korean'],
  ['zh', 'Chinese'],
  ['hi', 'Hindi'],
  ['ar', 'Arabic'],
  ['ru', 'Russian'],
  ['tr', 'Turkish'],
];
const FX_FILTERS = [
  ['all', 'All'],
  ['graphics', 'Graphics'],
  ['camera', 'Camera'],
  ['cards', 'Pictures'],
];

// ── what the Mac offers (catalogues, engines) ───────────────────────────────
const infoCache = new Map(); // macId → { at, info }
/** The Mac's catalogues and engine status, fetched once per Mac (refreshed every few minutes). */
export async function studioInfo(ed) {
  const macId = core.activePairing()?.macId;
  const hit = infoCache.get(macId);
  if (hit && Date.now() - hit.at < 5 * 60_000) return hit.info;
  // One request at a time; whoever asks meanwhile waits for the same answer.
  if (ed.studioLoading) return ed.studioLoading;
  ed.studioLoading = (async () => {
    const r = await core.command('studio.info', {}, { timeout: 15_000 });
    if (r?.t !== 'studio') {
      ed.studioError = /Unknown command/.test(r?.message ?? '') ? 'update ReelForge on your Mac to use this from the phone' : (r?.message ?? 'Your Mac didn’t answer.');
      return hit?.info ?? null;
    }
    ed.studioError = null;
    infoCache.set(macId, { at: Date.now(), info: r });
    return r;
  })().finally(() => {
    ed.studioLoading = null;
  });
  return ed.studioLoading;
}
function info(ed) {
  const i = infoCache.get(core.activePairing()?.macId)?.info ?? null;
  if (!i && ed.live && !ed.studioLoading) void studioInfo(ed).then(() => ed.repaint());
  return i;
}
const loading = (ed, what) => h('p', { class: 'muted', text: ed.studioError ? `${what}: ${ed.studioError}` : ed.live ? `Loading ${what.toLowerCase()} from your Mac…` : `${what} need your Mac online.` });
function notice(text, kind = '') {
  return h('div', { class: `ed-callout ${kind}` }, h('p', { text }));
}

// ── AI effects ──────────────────────────────────────────────────────────────
/** Face-tracked effects on one video clip. Times are stored in SOURCE frames, shown on the timeline clock. */
export function fxPanel(ed, v, kit) {
  const head = (meta) => h('div', { class: 'ed-head' }, h('h2', { class: 'ed-h', text: 'AI effects' }), meta ? h('span', { class: 'ed-meta', text: meta }) : null);
  const c = ed.selectedClip(v);
  const a = c ? M.assetOf(v, c.assetId) : null;
  if (!c || a?.kind !== 'video') return [head(), h('p', { class: 'muted', text: c ? 'AI effects go on video clips (they follow the speaker’s face).' : 'Select a video clip in the timeline. Best on talking-head shots.' })];
  // An older engine sends only a count: editing would wipe the list it can't show, so it asks for an update.
  if (typeof c.aiEffects === 'number') return [head(), notice('Update ReelForge on your Mac to see and edit AI effects from here.', 'warn')];
  const cat = info(ed);
  if (!cat) return [head(), loading(ed, 'AI effects')];
  const catalog = cat.fx.catalog;
  const byName = new Map(catalog.map((f) => [f.fx, f]));
  const fps = ed.fps;
  const effects = c.aiEffects ?? [];
  const track = M.trackOf(v, c.trackId);
  const off = !ed.editable() || track?.locked;
  const toTl = (src) => c.start + (src - c.sourceIn);
  const toSrc = (tl) => c.sourceIn + (tl - c.start);
  const end = M.clipEnd(c);
  const secs = (f) => (f / M.fpsValue(fps)).toFixed(1);
  const commit = (next, label) => ed.submit([{ type: 'clip.update', clipId: c.id, props: { aiEffects: next } }], label);
  const st = ed.fxState ??= { open: null, query: '', filter: 'all' };
  if (st.clipId !== c.id) Object.assign(st, { clipId: c.id, open: null });

  const out = [head(`${effects.length} on this clip`)];
  if (!cat.fx.engine.ok) out.push(notice(`The effects engine isn’t available on your Mac: ${cat.fx.engine.reason ?? 'not installed'}. Effects can be placed, but they won’t render until it is.`, 'warn'));
  if (effects.length) {
    out.push(bakeStatus(ed));
    out.push(
      h(
        'ul',
        { class: 'fx-list' },
        effects.map((e, i) => {
          const f = byName.get(e.fx);
          const shown = Math.max(c.start, toTl(e.start)) < Math.min(end, toTl(e.end));
          const isOpen = st.open === i;
          return h(
            'li',
            { class: `fx-item${isOpen ? ' open' : ''}` },
            h(
              'button',
              { class: 'fx-row', type: 'button', 'aria-expanded': isOpen ? 'true' : 'false', onclick: () => ((st.open = isOpen ? null : i), ed.repaint()) },
              icon('spark', { size: 16 }),
              h('span', { class: 'grow ellipsis', text: f?.label ?? e.fx }),
              h('span', { class: 'fx-time tabular', text: shown ? `${secs(toTl(e.start))}–${secs(toTl(e.end))} s` : 'outside the clip' }),
              icon(isOpen ? 'chevronUp' : 'chevronDown', { size: 16 }),
            ),
            isOpen && f ? fxEditor(ed, v, kit, { c, e, i, f, effects, off, toTl, toSrc, commit }) : null,
          );
        }),
      ),
    );
  }

  // the catalogue
  const search = h('input', { class: 'ed-input', type: 'search', placeholder: `Search ${catalog.length} effects…`, value: st.query, 'aria-label': 'Search AI effects', enterkeyhint: 'search', autocomplete: 'off' });
  search.addEventListener('input', () => {
    st.query = search.value;
    ed.fxListEl?.replaceChildren(...catalogItems());
  });
  const add = (f) => {
    // At the playhead when it's over the clip, else the clip's start; 3 s reads best (the desktop's rule).
    const at = ed.playhead >= c.start && ed.playhead < end - 1 ? ed.playhead : c.start;
    const to = Math.min(end, at + Math.round(3 * M.fpsValue(fps)));
    const next = [...effects.map((x) => ({ ...x })), { fx: f.fx, start: toSrc(at), end: toSrc(Math.max(at + 1, to)) }];
    if (commit(next, `AI effect: ${f.label}`)) st.open = next.length - 1;
  };
  const catalogItems = () => {
    const qq = st.query.trim().toLowerCase();
    const items = catalog.filter(
      (f) => (st.filter === 'all' || (st.filter === 'camera' ? f.camera : st.filter === 'cards' ? f.images : !f.camera && !f.images)) && (!qq || f.label.toLowerCase().includes(qq) || f.fx.includes(qq) || f.about.toLowerCase().includes(qq)),
    );
    if (!items.length) return [h('li', { class: 'muted small', text: `No effect matches “${st.query}”.` })];
    return items.map((f) =>
      h(
        'li',
        {},
        h(
          'button',
          { class: 'fx-add', type: 'button', disabled: off || effects.length >= MAX_FX || null, 'aria-label': `Add ${f.label} at the playhead`, onclick: () => add(f) },
          h('span', { class: 'fx-add-t' }, h('b', { text: f.label }), f.camera ? h('span', { class: 'fx-tag', text: 'camera' }) : null, f.images ? h('span', { class: 'fx-tag', text: 'pictures' }) : null),
          h('span', { class: 'fx-add-a', text: f.about }),
          icon('plus', { size: 18 }),
        ),
      ),
    );
  };
  ed.fxListEl = h('ul', { class: 'fx-catalog', 'aria-label': 'AI effects catalogue' }, ...catalogItems());
  out.push(
    h('div', { class: 'ed-subhead' }, h('span', { text: 'Add an effect' }), h('span', { class: 'ed-scope', text: effects.length >= MAX_FX ? `${MAX_FX} is the most per clip` : 'At the playhead · 3 s' })),
    search,
    h(
      'div',
      { class: 'ed-seg small fx-filter', role: 'radiogroup', 'aria-label': 'Effect type' },
      FX_FILTERS.map(([id, label]) => h('button', { class: `ed-seg-btn${st.filter === id ? ' on' : ''}`, type: 'button', role: 'radio', 'aria-checked': st.filter === id ? 'true' : 'false', onclick: () => ((st.filter = id), ed.repaint()) }, label)),
    ),
    ed.fxListEl,
    h('p', { class: 'ed-hint', text: 'Rendered by the effects engine on your Mac: they show in the rendered preview and the export, not in the live picture. Effects keep to the words they were put on when the clip moves or is trimmed.' }),
  );
  if (track?.locked) out.push(h('p', { class: 'ed-hint warn', text: `${track.label} is locked on the Mac.` }));
  return out;
}

function fxEditor(ed, v, kit, { c, e, i, f, effects, off, toTl, toSrc, commit }) {
  const fps = ed.fps;
  const update = (patch, label) => {
    const next = effects.map((x, k) => (k === i ? cleanFx({ ...x, ...patch }) : { ...x }));
    commit(next, label);
  };
  const time = (key, label) =>
    kit.stepper({
      label,
      value: `${(toTl(e[key]) / M.fpsValue(fps)).toFixed(1)} s`,
      disabled: off,
      onStep: (d) => setTime(key, toTl(e[key]) + d * Math.max(1, Math.round(M.fpsValue(fps) / 10))),
      onCommit: (t) => kit.numberCommit(t, (n) => setTime(key, M.secondsToFrames(n, fps))),
    });
  const setTime = (key, tl) => {
    const src = Math.max(0, toSrc(tl));
    const next = { start: e.start, end: e.end, [key]: src };
    if (next.end <= next.start) return ed.say(key === 'start' ? 'The start must stay before the end.' : 'The end must stay after the start.');
    update({ [key]: src }, 'AI effect timing');
  };
  const field = (label, value, placeholder, onCommit, { numeric = false } = {}) => {
    const input = h('input', { class: 'ed-input sm', type: 'text', value: value ?? '', placeholder, maxlength: 400, 'aria-label': `${f.label}: ${label}`, disabled: off || null, inputmode: numeric ? 'decimal' : null, enterkeyhint: 'done', autocomplete: 'off', spellcheck: 'false' });
    input.addEventListener('keydown', (ev) => ev.key === 'Enter' && input.blur());
    input.addEventListener('change', () => onCommit(input.value.trim()));
    return h('label', { class: 'ed-row fx-field' }, h('span', { class: 'ed-label wide', text: label }), input);
  };
  const keys = f.keys.filter((k) => !['text', 'color', 'images'].includes(k));
  const media = v.assets.filter((a) => (a.kind === 'image' || a.kind === 'video') && a.status !== 'missing');
  return h(
    'div',
    { class: 'fx-edit' },
    h('p', { class: 'ed-hint', text: f.about }),
    h('div', { class: 'ed-grid2' }, time('start', 'From'), time('end', 'To')),
    f.keys.includes('text') ? field('Text', e.text, 'Lines with |', (t) => t !== (e.text ?? '') && update({ text: t || undefined }, 'AI effect text')) : null,
    f.keys.includes('color')
      ? kit.colorField({ label: 'Colour', value: e.color ?? null, optional: true, fallback: '#ffffff', disabled: off, onChange: (col) => update({ color: col ? col.slice(0, 7) : undefined }, 'AI effect colour') })
      : null,
    keys.map((k) =>
      field(k.replace(/_/g, ' '), e.opts?.[k] === undefined ? '' : String(e.opts[k]), 'default', (t) => {
        const numeric = f.numeric.includes(k);
        const opts = { ...(e.opts ?? {}) };
        if (t === '') delete opts[k];
        else if (numeric) {
          const n = Number(t.replace(',', '.'));
          if (!Number.isFinite(n)) return ed.say(`${k} takes a number.`, 'error');
          opts[k] = n;
        } else opts[k] = /^-?\d+(\.\d+)?$/.test(t) ? Number(t) : t;
        if (JSON.stringify(opts) === JSON.stringify(e.opts ?? {})) return;
        update({ opts: Object.keys(opts).length ? opts : undefined }, `AI effect ${k}`);
      }, { numeric: f.numeric.includes(k) }),
    ),
    f.images
      ? h(
          'fieldset',
          { class: 'fx-images', disabled: off || null },
          h('legend', { text: 'Pictures' }),
          media.length
            ? media.map((a) => {
                const on = e.images?.includes(a.id) ?? false;
                return h('div', { class: 'ed-row' }, h('span', { class: 'ed-label grow ellipsis', text: a.filename }), kit.toggle(on, `Use ${a.filename}`, off, () => {
                  const set = new Set(e.images ?? []);
                  if (on) set.delete(a.id);
                  else set.add(a.id);
                  update({ images: set.size ? [...set].slice(0, 24) : undefined }, 'AI effect pictures');
                }));
              })
            : h('p', { class: 'ed-hint', text: 'Frames of this clip are used. Import screenshots or reels (Media) to use them instead.' }),
        )
      : null,
    h('p', { class: 'ed-hint', text: `Options: ${f.options.replace(/`/g, '')}` }),
    button('Remove effect', { iconName: 'trash', small: true, full: true, disabled: off, onclick: () => {
      ed.fxState.open = null;
      commit(effects.filter((_, k) => k !== i).map((x) => ({ ...x })), 'Remove AI effect');
    } }),
  );
}

/** The engine's schema drops nothing silently: undefined keys are removed so the edit stays strict JSON. */
function cleanFx(e) {
  const out = {};
  for (const [k, val] of Object.entries(e)) if (val !== undefined) out[k] = val;
  return out;
}

/** Baking progress for the timeline's AI effects (the rendered preview and export wait for it). */
function bakeStatus(ed) {
  const b = ed.fxBake;
  if (!b) {
    ensureBakePoll(ed);
    return h('p', { class: 'ed-hint', text: 'Checking the effects on your Mac…' });
  }
  if (b.error) return h('p', { class: 'ed-hint warn', text: b.error });
  if (!b.engine?.ok) return null;
  const bakes = b.bakes ?? [];
  if (!bakes.length) return h('p', { class: 'ed-hint', text: 'Effects render with the next preview.' });
  const failed = bakes.find((x) => x.state === 'failed');
  if (failed) return h('p', { class: 'ed-hint warn', text: `An effect failed to render on your Mac: ${failed.error ?? 'unknown error'}` });
  const left = bakes.filter((x) => x.state !== 'done');
  if (!left.length) return h('p', { class: 'ed-hint ok', text: `${bakes.length} effect render${bakes.length === 1 ? '' : 's'} ready on your Mac.` });
  const running = left.find((x) => x.state === 'running');
  ensureBakePoll(ed);
  return h(
    'div',
    { class: 'fx-bake' },
    h('span', { text: `Rendering effects on your Mac · ${bakes.length - left.length}/${bakes.length}${running?.progress != null ? ` · ${Math.round(running.progress * 100)}%` : ''}` }),
    h('span', { class: 'fx-bake-bar', style: null }, h('i', { 'data-p': String(Math.round((running?.progress ?? 0) * 100)) })),
  );
}

/** Starts the bakes the timeline needs (the desktop's preview does the same) and follows them while visible. */
function ensureBakePoll(ed) {
  if (ed.fxPolling || !ed.live) return;
  ed.fxPolling = true;
  void (async () => {
    let first = !ed.fxBake || ed.fxBakeRev !== ed.model?.revision;
    try {
      while (!ed.disposed && ed.tool === 'fx' && ed.live) {
        const rev = ed.model?.revision;
        const r = await core.command(first ? 'fx.bake' : 'fx.status', { projectId: ed.projectId }, { timeout: 15_000 });
        first = false;
        if (ed.disposed) return;
        ed.fxBake = r?.t === 'fx' ? r : { error: r?.message ?? 'Your Mac didn’t answer.' };
        ed.fxBakeRev = rev;
        ed.repaint();
        const busy = r?.t === 'fx' && r.engine?.ok && r.bakes.some((x) => x.state === 'queued' || x.state === 'running' || x.state === 'missing');
        if (!busy) break;
        await core.sleep(POLL_MS);
        if (ed.model?.revision !== rev) first = true;
      }
    } finally {
      ed.fxPolling = false;
    }
  })();
}

/** A new revision may need new bakes: the next look at the panel asks again. */
export function fxRevisionChanged(ed) {
  // The last status stays on screen while the Mac is asked again (the poll sees the revision moved).
  if (ed.fxBake && ed.fxBakeRev !== ed.model?.revision && ed.tool === 'fx') ensureBakePoll(ed);
}

// ── captions: generate from speech, add, delete ─────────────────────────────
/** Tracks heard on the timeline (audio tracks, picture tracks holding videos with sound): the desktop's list. */
function voicedTracks(v) {
  const voiced = new Set(v.assets.filter((a) => a.hasAudio).map((a) => a.id));
  return v.tracks.filter((t) => t.kind !== 'caption' && v.clips.some((c) => c.trackId === t.id && voiced.has(c.assetId)));
}

/** The "Generate from speech" block: sources, words per caption, language, and the transcription progress. */
export function generateBlock(ed, v, kit) {
  const capTrack = v.tracks.find((t) => t.kind === 'caption');
  if (!capTrack) return [h('p', { class: 'ed-hint warn', text: 'This project has no caption track, so captions can’t be added here.' })];
  const tracks = voicedTracks(v);
  const g = (ed.capGen ??= { sources: null, maxWords: 3, language: 'auto', state: 'idle', missing: [], error: null });
  if (!g.sources || g.sources.some((id) => !M.trackOf(v, id))) {
    const voice = tracks.filter((t) => /voice/i.test(t.name ?? ''));
    g.sources = (voice.length ? voice : tracks).map((t) => t.id);
  }
  const has = v.captions.some((c) => c.trackId === capTrack.id);
  const busy = g.state === 'working' || g.state === 'transcribing';
  const off = !ed.editable() || capTrack.locked;
  const lang = h('select', { class: 'ed-select', 'aria-label': 'Spoken language', disabled: busy || null }, LANGUAGES.map(([id, label]) => h('option', { value: id, selected: id === g.language || null, text: label })));
  lang.addEventListener('change', () => (g.language = lang.value));
  const running = g.missing.filter((m) => m.state === 'queued' || m.state === 'running');
  const pct = running.length ? Math.round((running.reduce((s, m) => s + (m.progress ?? 0), 0) / running.length) * 100) : null;
  const label = g.state === 'transcribing' ? `Transcribing on your Mac… ${pct ?? 0}%` : g.state === 'working' ? 'Working…' : has ? 'Regenerate captions' : 'Generate captions';
  return [
    tracks.length
      ? h(
          'div',
          { class: 'cap-sources', role: 'group', 'aria-label': 'Speech comes from' },
          tracks.map((t) => {
            const on = g.sources.includes(t.id);
            return h('div', { class: 'ed-row' }, h('span', { class: 'ed-label grow ellipsis', text: `${t.label} ${t.name ?? ''}`.trim() }), kit.toggle(on, `Caption speech on ${t.label}`, busy, () => {
              g.sources = on ? g.sources.filter((x) => x !== t.id) : [...g.sources, t.id];
              ed.repaint();
            }));
          }),
        )
      : h('p', { class: 'ed-hint', text: 'Nothing on the timeline has sound yet. Add a clip with speech first.' }),
    kit.slider({ label: 'Words each', value: g.maxWords, min: 1, max: 6, step: 1, suffix: '', limit: [1, 12], disabled: busy, onChange: (n) => (g.maxWords = Math.round(clamp(n, 1, 12))) }),
    h('div', { class: 'ed-row' }, h('span', { class: 'ed-label wide', text: 'Language' }), lang),
    button(label, { kind: 'mint', iconName: 'director', full: true, disabled: busy || off || !tracks.length || !g.sources.length, onclick: () => void generateCaptions(ed) }),
    g.state === 'transcribing' && g.missing.length
      ? h('ul', { class: 'cap-missing' }, g.missing.map((m) => h('li', { class: 'small muted' }, h('span', { class: 'grow ellipsis', text: m.filename }), h('span', { class: 'tabular', text: m.state === 'running' ? `${Math.round((m.progress ?? 0) * 100)}%` : m.state }))))
      : null,
    g.error ? h('p', { class: 'ed-hint warn', text: g.error }) : null,
    h('p', { class: 'ed-hint', text: `Speech is transcribed on your Mac (whisper.cpp)${has ? '. Regenerating replaces every caption on the track as one step; Undo brings the old ones back.' : '.'}` }),
  ];
}

async function generateCaptions(ed) {
  const g = ed.capGen;
  const v = ed.view();
  const capTrack = v?.tracks.find((t) => t.kind === 'caption');
  if (!capTrack || g.state === 'working' || g.state === 'transcribing') return;
  g.state = 'working';
  g.error = null;
  ed.repaint();
  // The captions follow the clips as the Mac has them: everything queued here goes first.
  if (!(await ed.settle())) {
    g.state = 'idle';
    g.error = 'Your edits haven’t all reached the Mac yet. Try again once they’re saved.';
    return ed.repaint();
  }
  let poll = false;
  while (!ed.disposed) {
    const r = await core.command('captions.plan', { projectId: ed.projectId, trackId: capTrack.id, sourceTrackIds: g.sources, maxWords: g.maxWords, language: g.language, poll }, { timeout: 30_000 });
    if (ed.disposed) return;
    poll = true;
    if (!r || r.t === 'error') {
      g.state = 'idle';
      g.error = r?.message ?? 'Your Mac didn’t answer.';
      return ed.repaint();
    }
    if (r.state === 'failed') {
      g.state = 'idle';
      g.missing = r.missing ?? [];
      g.error = `Transcription failed on your Mac: ${(r.missing ?? []).find((m) => m.error)?.error ?? 'unknown error'}`;
      return ed.repaint();
    }
    if (r.state === 'transcribing') {
      g.state = 'transcribing';
      g.missing = r.missing ?? [];
      ed.repaint();
      await core.sleep(POLL_MS);
      continue;
    }
    // Ready: one captions.replace, sent through this session's queue like any other edit.
    g.state = 'idle';
    g.missing = [];
    if (!r.count) {
      g.error = 'No speech was found in those tracks.';
      return ed.repaint();
    }
    const had = ed.view().captions.some((c) => c.trackId === r.trackId);
    if (ed.submit(r.ops, had ? 'Regenerate captions' : 'Generate captions')) {
      ed.say(`${r.count} caption${r.count === 1 ? '' : 's'} created.`);
      const first = r.ops[0].captions[0];
      if (first) ed.sel.captionId = first.captionId;
    }
    return ed.repaint();
  }
}

/** A caption at the playhead: 2 s, or up to the next caption; never over one. */
export function addCaptionAtPlayhead(ed) {
  const v = ed.view();
  const track = v?.tracks.find((t) => t.kind === 'caption');
  if (!track) return ed.say('This project has no caption track.');
  if (track.locked) return ed.say(`${track.label} is locked on the Mac.`);
  const at = Math.max(0, ed.playhead);
  const on = M.captionsOn(v, track.id);
  if (on.some((c) => c.start <= at && at < c.start + c.duration)) return ed.say('There’s already a caption at the playhead. Move the playhead to an empty spot.');
  const next = on.find((c) => c.start > at);
  const want = M.secondsToFrames(2, ed.fps);
  const duration = Math.max(1, Math.min(want, (next?.start ?? Infinity) - at));
  const captionId = uuid();
  if (ed.submit([{ type: 'caption.add', trackId: track.id, captionId, start: at, duration, text: 'New caption' }], 'Add caption')) {
    ed.sel.captionId = captionId;
    ed.focusCaptionText = captionId;
    ed.repaint();
  }
}

export function deleteCaption(ed, c) {
  const v = ed.view();
  const caps = [...v.captions].sort(M.byStart);
  const i = caps.findIndex((x) => x.id === c.id);
  delete ed.textDrafts[c.id];
  if (ed.submit([{ type: 'caption.delete', captionIds: [c.id] }], 'Delete caption')) {
    ed.sel.captionId = (caps[i + 1] ?? caps[i - 1])?.id ?? null;
    ed.repaint();
  }
}

// ── media ───────────────────────────────────────────────────────────────────
const fmtLen = (a, fps) => (a.durationFrames === null ? 'Photo' : `${M.framesToSeconds(a.durationFrames, fps).toFixed(1)} s`);

export function mediaPanel(ed, v) {
  const fps = ed.fps;
  const file = h('input', { type: 'file', accept: 'video/*,image/*,audio/*', class: 'visually-hidden', tabindex: '-1', 'aria-hidden': 'true', multiple: true });
  file.addEventListener('change', () => {
    const files = [...(file.files ?? [])];
    file.value = '';
    void importFiles(ed, files);
  });
  const ups = [...live.uploads.entries()].filter(([, u]) => u.projectId === ed.projectId && !(u.state === 'imported' && Date.now() - (u.doneAt ??= Date.now()) > 8000));
  const assets = [...v.assets].sort((a, b) => a.filename.localeCompare(b.filename));
  const used = new Set(v.clips.map((c) => c.assetId));
  return [
    h('div', { class: 'ed-head' }, h('h2', { class: 'ed-h', text: 'Media' }), h('span', { class: 'ed-meta', text: `${assets.length} item${assets.length === 1 ? '' : 's'}` })),
    button('Import from this phone', { iconName: 'attach', full: true, disabled: !ed.live, onclick: () => file.click() }),
    file,
    ups.length
      ? h(
          'div',
          { class: 'uploads' },
          ups.map(([uid, u]) =>
            h(
              'div',
              { class: `upload ${u.state}` },
              icon(u.state === 'imported' ? 'checkCircle' : u.state === 'failed' ? 'alert' : 'attach', { size: 16 }),
              h('span', { class: 'grow ellipsis', text: u.state === 'failed' ? `${u.name}: ${u.error ?? 'failed'}` : u.state === 'imported' ? `${u.filename ?? u.name} added` : u.state === 'importing' ? `${u.name} · importing on your Mac` : `${u.name} · ${Math.round((u.progress ?? 0) * 100)}%` }),
              u.state === 'sending' ? iconButton('x', 'Cancel upload', () => core.cancelUpload(uid)) : null,
            ),
          ),
        )
      : null,
    assets.length
      ? h(
          'ul',
          { class: 'media-grid' },
          assets.map((a) => {
            const offline = a.status === 'missing';
            return h(
              'li',
              { class: `media-card${offline ? ' offline' : ''}` },
              h('div', { class: 'media-thumb' }, thumb(ed, a), h('span', { class: 'media-len tabular', text: fmtLen(a, fps) }), used.has(a.id) ? h('span', { class: 'media-used', text: 'In use' }) : null),
              h('div', { class: 'media-name ellipsis', title: a.filename, text: a.filename }),
              offline
                ? h('p', { class: 'ed-hint warn', text: 'Offline on the Mac (moved or deleted).' })
                : h(
                    'div',
                    { class: 'media-actions' },
                    button('Playhead', { small: true, iconName: 'plus', disabled: !ed.editable(), aria: `Add ${a.filename} at the playhead`, onclick: () => placeAsset(ed, a, 'playhead') }),
                    button('End', { small: true, iconName: 'skipForward', disabled: !ed.editable(), aria: `Append ${a.filename} to the end`, onclick: () => placeAsset(ed, a, 'end') }),
                  ),
            );
          }),
        )
      : h('p', { class: 'muted', text: 'No media in this project yet. Import a clip, photo or song from this phone.' }),
    h('p', { class: 'ed-hint', text: 'Files go to your Mac and are added to the project there. Playhead puts the media on the first free track at the playhead; End adds it after the last clip, like the desktop’s Append.' }),
  ];
}

function thumb(ed, a) {
  if (a.kind === 'audio') return h('span', { class: 'media-ic' }, icon('audio', { size: 26 }));
  ed.thumbs ??= new Map();
  const t = ed.thumbs.get(a.id);
  if (t?.url) return h('img', { src: t.url, alt: '', loading: 'lazy' });
  if (!t && ed.live && a.status !== 'missing') {
    ed.thumbs.set(a.id, { loading: true });
    void (async () => {
      const r = await core.command('media.thumb', { projectId: ed.projectId, assetId: a.id }, { timeout: 30_000 });
      if (ed.disposed) return;
      if (r?.t !== 'thumb' || !r.blob) return ed.thumbs.set(a.id, { none: true });
      try {
        const url = URL.createObjectURL(await core.fetchBlob(r.blob));
        if (ed.disposed) return URL.revokeObjectURL(url);
        ed.thumbs.set(a.id, { url });
        ed.repaint();
      } catch {
        ed.thumbs.set(a.id, { none: true });
      }
    })();
  }
  return h('span', { class: 'media-ic' }, icon(a.kind === 'image' ? 'frame' : 'film', { size: 26 }));
}

async function importFiles(ed, files) {
  if (!files.length) return;
  if (!ed.live) return ed.say('Imports go straight to your Mac, so it needs to be online.');
  // An import moves the project's revision; edits still on their way would come back as a conflict.
  await ed.settle();
  ed.expectImport = (ed.expectImport ?? 0) + files.length;
  for (const f of files) void core.upload(ed.projectId, f);
  ed.repaint();
}

/** Where a piece of media goes, as the desktop decides it (Append, or the free track at the playhead). */
export function placementFor(v, a, how, at, fps) {
  const free = (trackId, start, len) => !v.clips.some((c) => c.trackId === trackId && c.start < start + len && start < M.clipEnd(c));
  const len = a.durationFrames ?? M.secondsToFrames(M.DEFAULT_STILL_SECONDS, fps);
  const fits = v.tracks.filter((t) => !t.locked && M.canPlace(a, t.kind));
  if (how === 'end') {
    const want = a.kind === 'audio' ? 'audio' : 'video';
    const track = fits.find((t) => t.kind === want) ?? fits[0];
    if (!track) return { error: `No unlocked track can hold ${a.filename}.` };
    const start = v.clips.filter((c) => c.trackId === track.id).reduce((m, c) => Math.max(m, M.clipEnd(c)), 0);
    return { trackId: track.id, start };
  }
  // At the playhead: the main picture track if it's free there, then overlays (top first), then audio.
  const order = [...fits].sort((x, y) => (x.kind === 'video' ? 0 : x.kind === 'overlay' ? 1 : 2) - (y.kind === 'video' ? 0 : y.kind === 'overlay' ? 1 : 2) || x.position - y.position);
  const track = order.find((t) => free(t.id, at, len));
  if (!track) return { error: `Every track that can hold ${a.filename} is busy at the playhead. Move the playhead or use End.` };
  return { trackId: track.id, start: at };
}

function placeAsset(ed, a, how) {
  const v = ed.view();
  const p = placementFor(v, a, how, ed.playhead, ed.fps);
  if (p.error) return ed.say(p.error, 'error');
  const clipId = uuid();
  if (ed.submit([{ type: 'clip.add', trackId: p.trackId, assetId: a.id, start: p.start, clipId }], how === 'end' ? 'Append clip' : 'Add clip')) {
    ed.sel.clipId = clipId;
    ed.seek(p.start, { follow: true });
    ed.say(`${a.filename} added on ${M.trackOf(v, p.trackId)?.label ?? 'the timeline'}.`);
  }
}

// ── motion-graphic templates ────────────────────────────────────────────────
export function templatesPanel(ed, v, kit) {
  const head = h('div', { class: 'ed-head' }, h('h2', { class: 'ed-h', text: 'Templates' }), h('span', { class: 'ed-meta', text: 'Motion graphics' }));
  const cat = info(ed);
  if (!cat) return [head, loading(ed, 'Templates')];
  const tpls = cat.motion.templates;
  const st = (ed.tplState ??= { id: tpls[0]?.id, values: {}, seconds: {}, job: null });
  const t = tpls.find((x) => x.id === st.id) ?? tpls[0];
  if (!t) return [head, h('p', { class: 'muted', text: 'No templates on this Mac.' })];
  const vals = (st.values[t.id] ??= { ...t.defaults });
  const seconds = (st.seconds[t.id] ??= t.defaultSeconds);
  const job = st.job;
  const busy = job && (job.state === 'starting' || job.state === 'queued' || job.state === 'running' || job.state === 'placing');
  const off = !ed.editable() || busy || !cat.motion.engine.ok;
  const out = [head];
  if (!cat.motion.engine.ok) out.push(notice(`The motion-graphics renderer isn’t available on your Mac: ${cat.motion.engine.reason ?? 'not installed'}.`, 'warn'));
  out.push(
    h(
      'div',
      { class: 'tpl-row', role: 'radiogroup', 'aria-label': 'Template' },
      tpls.map((x) =>
        h('button', { class: `tpl${x.id === t.id ? ' on' : ''}`, type: 'button', role: 'radio', 'aria-checked': x.id === t.id ? 'true' : 'false', disabled: busy || null, onclick: () => ((st.id = x.id), ed.repaint()) }, h('b', { text: x.label }), h('span', { text: x.description })),
      ),
    ),
  );
  for (const f of t.fields) {
    const label = f.key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (ch) => ch.toUpperCase());
    if (f.kind === 'color') {
      out.push(kit.colorField({ label, value: vals[f.key], disabled: busy, onChange: (col) => col && (vals[f.key] = col.slice(0, 7)) }));
    } else if (f.kind === 'choice') {
      const sel = h('select', { class: 'ed-select', 'aria-label': label, disabled: busy || null }, f.options.map((o) => h('option', { value: o, selected: o === vals[f.key] || null, text: o.replace(/-/g, ' ') })));
      sel.addEventListener('change', () => (vals[f.key] = sel.value));
      out.push(h('div', { class: 'ed-row' }, h('span', { class: 'ed-label wide', text: label }), sel));
    } else {
      const input = h('input', { class: 'ed-input sm', type: 'text', value: vals[f.key] ?? '', maxlength: f.max ?? 120, 'aria-label': label, disabled: busy || null, enterkeyhint: 'done', autocomplete: 'off' });
      input.addEventListener('input', () => (vals[f.key] = input.value));
      input.addEventListener('keydown', (e) => e.key === 'Enter' && input.blur());
      out.push(h('label', { class: 'ed-row' }, h('span', { class: 'ed-label wide', text: `${label}${f.required ? '' : ' (optional)'}` }), input));
    }
  }
  out.push(
    kit.stepper({
      label: 'Length',
      value: `${seconds.toFixed(1)} s`,
      disabled: busy,
      onStep: (d) => ((st.seconds[t.id] = clamp(Math.round((seconds + d * 0.5) * 10) / 10, 0.5, cat.motion.maxSeconds)), ed.repaint()),
      onCommit: (txt) => kit.numberCommit(txt, (n) => ((st.seconds[t.id] = clamp(n, 0.5, cat.motion.maxSeconds)), ed.repaint())),
    }),
    button(busy ? jobLabel(job) : 'Render & place at the playhead', { kind: 'mint', iconName: busy ? 'clock' : 'layers', full: true, disabled: off, onclick: () => void renderTemplate(ed, t, { ...vals }, seconds) }),
    job?.state === 'failed' ? h('p', { class: 'ed-hint warn', text: job.error }) : null,
    job?.state === 'done' ? h('p', { class: 'ed-hint ok', text: job.note }) : null,
    h('p', { class: 'ed-hint', text: 'Rendered once on your Mac as a transparent clip, placed on the first free overlay track at the playhead. It also appears in Media.' }),
  );
  return out;
}

function jobLabel(job) {
  if (job.state === 'placing') return 'Placing on the timeline…';
  if (job.state === 'running' && job.progress != null) return `Rendering on your Mac… ${Math.round(job.progress * 100)}%`;
  return 'Rendering on your Mac…';
}

async function renderTemplate(ed, t, props, seconds) {
  const st = ed.tplState;
  for (const f of t.fields) if (f.required && !String(props[f.key] ?? '').trim()) return ed.say(`${f.key} is required.`, 'error');
  const durationFrames = Math.max(1, M.secondsToFrames(seconds, ed.fps));
  st.job = { state: 'starting' };
  ed.repaint();
  if (!(await ed.settle())) {
    st.job = { state: 'failed', error: 'Your edits haven’t all reached the Mac yet. Try again once they’re saved.' };
    return ed.repaint();
  }
  const at = ed.playhead;
  let r = await core.command('motion.create', { projectId: ed.projectId, template: t.id, props, durationFrames }, { timeout: 30_000 });
  while (!ed.disposed && r?.t === 'motion' && r.motion.state !== 'done' && r.motion.state !== 'failed') {
    st.job = { state: r.motion.state === 'missing' ? 'queued' : r.motion.state, progress: r.motion.progress };
    ed.repaint();
    await core.sleep(POLL_MS);
    r = await core.command('motion.status', { projectId: ed.projectId, key: r.motion.key }, { timeout: 15_000 });
  }
  if (ed.disposed) return;
  if (!r || r.t !== 'motion' || r.motion.state === 'failed' || !r.motion.asset) {
    st.job = { state: 'failed', error: r?.motion?.error ?? r?.message ?? 'Your Mac didn’t answer.' };
    return ed.repaint();
  }
  // The import moved the revision: load the timeline as the Mac has it, then place it as one edit.
  st.job = { state: 'placing' };
  ed.repaint();
  await ed.syncFromMac();
  const v = ed.view();
  const free = (trackId) => !v.clips.some((c) => c.trackId === trackId && c.start < at + durationFrames && at < M.clipEnd(c));
  const byTop = [...v.tracks].sort((a, b) => a.position - b.position);
  const track = byTop.find((x) => !x.locked && x.kind === 'overlay' && free(x.id)) ?? byTop.find((x) => !x.locked && x.kind === 'video' && free(x.id));
  if (!track) {
    st.job = { state: 'failed', error: 'The graphic is in Media, but every picture track is busy at the playhead. Move the playhead and add it from Media.' };
    return ed.repaint();
  }
  const clipId = uuid();
  const ok = ed.submit([{ type: 'clip.add', trackId: track.id, assetId: r.motion.asset.id, start: at, duration: durationFrames, clipId }], 'Add motion graphic');
  if (ok) ed.sel.clipId = clipId;
  st.job = ok ? { state: 'done', note: `${t.label} placed on ${track.label} at ${M.timecode(at, ed.fps)}.` } : { state: 'failed', error: 'It couldn’t be placed; it’s in Media.' };
  ed.repaint();
}

// ── AI Director ─────────────────────────────────────────────────────────────
// Typing "/" turns the box into slash commands (the desktop's: /bw, /noir, /zoom in, /fx spotlight, chains
// with ";"). They edit the selected clip at once, as one undo step of this session, and need no AI model.
export function directorPanel(ed, v) {
  const p = ed.project();
  const st = (ed.slashState ??= { error: null, busy: false });
  const area = h('textarea', { class: 'ed-text', rows: 3, placeholder: 'Tell the agent what to change, or type / for commands…', 'aria-label': 'Instruction for the agent, or a slash command', enterkeyhint: 'send', autocapitalize: 'sentences', autocomplete: 'off' });
  area.value = ed.askDraft ?? '';
  const slashList = h('ul', { class: 'slash-list', role: 'listbox', 'aria-label': 'Slash commands' });
  const err = h('p', { class: 'ed-hint warn', role: 'alert' });
  const sendBtn = h('div', { class: 'slash-send' });
  const c = ed.selectedClip(v);
  const target = h('p', { class: 'ed-hint' });
  const paint = () => {
    const text = area.value;
    const slash = isSlashCommand(text);
    area.setAttribute('autocapitalize', slash ? 'none' : 'sentences');
    const items = slash ? slashSuggestions(info(ed)?.slash, text) : [];
    slashList.hidden = !items.length;
    slashList.replaceChildren(
      ...items.map((s) =>
        h(
          'li',
          {},
          h('button', { class: 'slash-item', type: 'button', role: 'option', onclick: () => {
            area.value = completeSlash(area.value, s);
            ed.askDraft = area.value;
            st.error = null;
            paint();
            area.focus();
          } }, h('b', { class: 'slash-usage', text: s.usage }), h('span', { class: 'slash-hint', text: s.hint })),
        ),
      ),
    );
    err.hidden = !st.error;
    err.textContent = st.error ?? '';
    target.hidden = !slash;
    target.textContent = c ? `Applies to the selected clip (${M.assetOf(v, c.assetId)?.filename ?? 'clip'}) right away, as one Undo step. No AI model.` : 'Select a clip in the timeline first: commands change the selected clip.';
    if (slash && !info(ed)?.slash) target.textContent += ed.studioError ? ` Command list: ${ed.studioError}.` : '';
    sendBtn.replaceChildren(
      slash
        ? button(st.busy ? 'Working it out on your Mac…' : 'Run command', { kind: 'mint', iconName: 'spark', full: true, disabled: st.busy || !ed.live || !c || !text.trim(), onclick: run })
        : button(ed.live ? 'Send to the agent' : 'Queue for the agent', { kind: 'mint', iconName: 'send', full: true, disabled: ed.phase === 'ending', onclick: run }),
    );
  };
  const run = () => {
    const text = area.value.trim();
    if (!text) return area.focus();
    if (isSlashCommand(text)) {
      // The panel isn't rebuilt while the box has focus, so this one clears itself.
      const done = runSlash(ed, text).then((ok) => {
        if (ok) area.value = '';
        paint();
      });
      paint();
      return void done;
    }
    void ed.askAgent(text);
  };
  area.addEventListener('input', () => {
    ed.askDraft = area.value;
    st.error = null;
    paint();
  });
  area.addEventListener('keydown', (e) => {
    // Enter runs a command (a one-liner); an instruction for the agent keeps Enter for new lines.
    if (e.key === 'Enter' && !e.shiftKey && isSlashCommand(area.value)) {
      e.preventDefault();
      run();
    }
  });
  const suggestions = ['Tighten the pacing and cut the pauses', 'Add captions for the speech', 'Make it punchier for Reels', 'Add a title card at the start'];
  const quick = ['/cinematic', '/noir', '/vintage', '/zoom in', '/fade'];
  const pending = p?.pendingProposals ?? 0;
  paint();
  // The panel isn't rebuilt while the box has focus, so it fills in the command list itself once it arrives.
  if (!info(ed)?.slash && ed.live) void studioInfo(ed).then(() => !ed.disposed && paint());
  return [
    h('div', { class: 'ed-head' }, h('h2', { class: 'ed-h', text: 'AI Director' }), h('span', { class: 'ed-meta', text: ed.modelLabel?.() ?? '' })),
    h('p', { class: 'ed-hint', text: 'The agent plans changes on your Mac and proposes them as a new version; nothing changes until you apply it. Sending ends this hand-editing session (your edits are saved first) and opens the conversation.' }),
    area,
    slashList,
    err,
    target,
    h('div', { class: 'suggest' }, suggestions.map((s) => h('button', { class: 'chip', type: 'button', onclick: () => {
      area.value = area.value.trim() && !isSlashCommand(area.value) ? `${area.value.trim()}\n${s}` : s;
      ed.askDraft = area.value;
      st.error = null;
      paint();
      area.focus();
    } }, s))),
    h('div', { class: 'suggest' }, quick.map((q) => h('button', { class: 'chip mono', type: 'button', 'aria-label': `Command ${q}`, onclick: () => {
      area.value = q;
      ed.askDraft = q;
      st.error = null;
      paint();
      area.focus();
    } }, q))),
    sendBtn,
    pending ? button(`Review ${pending} waiting version${pending === 1 ? '' : 's'}`, { iconName: 'history', full: true, small: true, onclick: () => void ed.leaveTo(`#/session/${ed.projectId}`) }) : null,
    v.captions.length === 0 ? h('p', { class: 'ed-hint', text: 'Tip: captions from speech are quicker in Captions → Generate; the agent is for edits that need judgement.' }) : null,
  ];
}

/**
 * Runs a slash command: everything queued reaches the Mac first, the Mac works the command out on that exact
 * timeline (core slash.ts, the desktop's code), and the edit comes back through this session's queue.
 */
export async function runSlash(ed, text) {
  const st = (ed.slashState ??= { error: null, busy: false });
  const fail = (msg) => {
    st.error = msg;
    st.busy = false;
    return false;
  };
  if (st.busy) return false;
  if (!ed.editable()) return fail('Not editing right now.');
  if (!ed.live) return fail('Commands are worked out on your Mac, so it needs to be online.');
  const clipId = ed.sel.clipId;
  if (!clipId) return fail('Select a clip on the timeline first.');
  st.busy = true;
  st.error = null;
  if (!(await ed.settle())) return fail('Your edits haven’t all reached the Mac yet. Try again once they’re saved.');
  const playhead = Math.max(0, Math.round(ed.playhead));
  const r = await core.command('slash.plan', { projectId: ed.projectId, text, clipIds: [clipId], playhead }, { timeout: 15_000 });
  if (ed.disposed) return false;
  if (!r || r.timeout) return fail('Your Mac didn’t answer. Try again.');
  if (r.t !== 'slash') return fail(/Unknown command/.test(r.message ?? '') ? 'Update ReelForge on your Mac to use commands from the phone.' : (r.message ?? 'Your Mac couldn’t run that.'));
  if (!r.ok) return fail(r.error);
  // Planned on the Mac's timeline; if that isn't the one shown here any more, the ops may not fit it.
  if (ed.pending.length || r.revision !== ed.model?.revision) return fail('The timeline changed while that was worked out. Run it again.');
  st.busy = false;
  if (!ed.submit(r.ops, r.label)) return fail(`${r.label} couldn’t be applied here.`);
  ed.askDraft = '';
  const n = r.ops.length;
  ed.say(`${r.label} on ${n} clip${n === 1 ? '' : 's'}${r.skipped ? ` (${r.skipped} skipped)` : ''}. Undo takes it back.`);
  ed.repaint();
  return true;
}

// ── Settings ────────────────────────────────────────────────────────────────
export function settingsPanel(ed, v) {
  const cat = info(ed);
  const ai = ed.aiOptions;
  if (!ai && ed.live && !ed.aiLoading) {
    ed.aiLoading = true;
    void core.command('ai.options', { projectId: ed.projectId }, { timeout: 15_000 }).then((r) => {
      ed.aiLoading = false;
      ed.aiOptions = r?.t === 'ai.options' ? r : { error: r?.message ?? 'Your Mac didn’t answer.' };
      ed.repaint();
    });
  }
  const W = v.width;
  const H = v.height;
  const d = gcd(W, H) || 1;
  const fpsLabel = Number(M.fpsValue(v.fps).toFixed(2));
  const row = (label, value, cls = '') => h('div', { class: `set-row ${cls}` }, h('span', { class: 'set-k', text: label }), h('span', { class: 'set-v', text: value }));
  const status = (ok, text) => h('span', { class: `set-dot ${ok ? 'ok' : 'off'}`, text });
  const engine = cat?.engine;
  const pairing = core.activePairing();
  return [
    h('h2', { class: 'ed-h', text: 'Settings' }),
    ed.section('set-project', 'This project', null, [
      row('Name', v.name ?? '—'),
      row('Format', `${W / d}:${H / d} · ${W}×${H}`),
      row('Frame rate', `${fpsLabel} fps`),
      row('Length', M.timecode(M.durationFrames(v), v.fps)),
      row('Revision', String(v.revision)),
      h('p', { class: 'ed-hint', text: 'Format and frame rate are set on the Mac (the format chips change them there).' }),
    ], true),
    ed.section('set-mac', 'Your Mac', null, [
      row('Name', cat?.macName ?? pairing?.macName ?? '—'),
      row('Connection', ed.live ? 'Online' : 'Offline'),
      engine ? row('Engine', engine.background ? 'Running in the background' : 'Running with the editor window') : null,
      cat?.version ? row('ReelForge', cat.version) : null,
      row('This phone', pairing?.deviceName ?? '—'),
      button('Phone, notifications & pairing', { iconName: 'settings', small: true, full: true, onclick: () => ed.openDeviceSheet() }),
    ], true),
    ed.section('set-ai', 'AI providers', null, [
      !ai ? h('p', { class: 'muted small', text: ed.live ? 'Asking your Mac…' : 'Needs your Mac online.' }) : ai.error ? h('p', { class: 'ed-hint warn', text: ai.error }) : null,
      ...(ai?.providers ?? []).map((p) =>
        h(
          'div',
          { class: 'set-row' },
          h('span', { class: 'set-k', text: p.label }),
          status(p.ready && (!p.external || p.consented), !p.ready ? 'Not set up on the Mac' : p.external && !p.consented ? 'Needs your OK on the Mac' : p.external ? `Ready · ${p.defaultModel ?? 'default model'}` : `On your Mac · ${p.defaultModel ?? 'local'}`),
        ),
      ),
      h('p', { class: 'ed-hint', text: 'API keys stay in the Mac’s Keychain and consent to send a project to a cloud provider is given on the Mac (Settings): neither can be changed from a phone.' }),
    ]),
    ed.section('set-engines', 'Studio engines', null, [
      cat ? h('div', { class: 'set-row' }, h('span', { class: 'set-k', text: 'AI effects' }), status(cat.fx.engine.ok, cat.fx.engine.ok ? `Ready · ${cat.fx.catalog.length} effects` : 'Not available')) : null,
      cat ? h('div', { class: 'set-row' }, h('span', { class: 'set-k', text: 'Templates' }), status(cat.motion.engine.ok, cat.motion.engine.ok ? `Ready · ${cat.motion.templates.length} templates` : 'Not available')) : null,
      h('div', { class: 'set-row' }, h('span', { class: 'set-k', text: 'Captions' }), status(true, 'Transcribed on your Mac')),
      cat && !cat.fx.engine.ok ? h('p', { class: 'ed-hint warn', text: cat.fx.engine.reason }) : null,
      cat && !cat.motion.engine.ok ? h('p', { class: 'ed-hint warn', text: cat.motion.engine.reason }) : null,
      !cat ? loading(ed, 'Engine status') : null,
    ]),
    ed.section('set-editor', 'Editor', null, [
      h('div', { class: 'ed-row' }, h('span', { class: 'ed-label grow', text: 'Fit the timeline to the screen' }), button('Fit', { small: true, iconName: 'fit', onclick: () => ed.fitTimeline() })),
      h('p', { class: 'ed-hint', text: 'Edits are saved on your Mac as you make them; Undo here only steps through this phone’s session.' }),
    ]),
  ];
}
const gcd = (a, b) => (b ? gcd(b, a % b) : a);
