// Manual editing on the phone: the Edit screen. It edits the same timeline as the desktop through the same
// operations (clip.trim, clip.split, clip.update, caption.update, …), sent to the Mac one gesture at a time.
//
//   lease     the Mac lets one phone edit a project at a time (edit.begin); a heartbeat keeps it, and it
//             lapses by itself if this phone goes away, so a closed tab never leaves the project locked.
//   queue     edits are queued in order, each with a command id and the revision it was made against
//             (`base`, moved forward only by the Mac's answers to the edits before it). A retry after a lost
//             answer reuses the id (the Mac applies it once); a revision that moved (the desktop edited,
//             even while this phone was offline) is a conflict the user resolves, never an overwrite.
//   guess     the screen shows an edit at once (edit-model.js, the engine's rules in JS) and replaces the
//             guess with the Mac's answer. "Saved" only ever means the Mac answered.
//   preview   paused, the picture is composited here from source stills with the export's own placement
//             maths and caption layout ("Live"); playing, it is the Mac's rendered preview, labelled with
//             the revision it shows ("Rendered").
import * as core from './core.js';
import * as M from './edit-model.js';
import { ago, button, closeSheet, h, icon, iconButton, sheet } from './ui.js';

const { saved, live } = core;
const HEARTBEAT_MS = 15_000;
const DRAFT_MS = 700;
const TEXT_MS = 1500;
const PAD = 34;
const MIN_PPS = 6;
const MAX_PPS = 260;
const SNAP_PX = 10;
const TOOLS = [
  ['clip', 'Clip', 'clip'],
  ['frame', 'Frame', 'frame'],
  ['captions', 'Captions', 'cc'],
  ['audio', 'Audio', 'audio'],
  ['style', 'Style', 'sliders'],
];
const LOOKS = [
  ['vignette', 'Vignette', 'Darker corners', true],
  ['grayscale', 'Black & white', 'No colour', true],
  ['sepia', 'Sepia', 'Warm old photo', true],
  ['blur', 'Blur', 'Soft focus', true],
  ['sharpen', 'Sharpen', 'Crisper edges', false],
  ['grain', 'Film grain', 'Moving noise', false],
];

let host = null; // { toast, go, render, projectById, detailOf, pausePlayers }
let ed = null;

/** app.js hands in what the editor needs from the rest of the app. */
export function initEditor(hooks) {
  host = hooks;
}

/** The Edit screen for #/edit/<project>/<revision>; one editor lives at a time and survives redraws. */
export function editScreen(r) {
  if (!ed || ed.projectId !== r.id) {
    ed?.dispose();
    ed = new Editor(r.id, r.revision, r.from);
  }
  ed.refresh();
  return ed.root;
}

/** Leaving the route some other way (system back, a notification): end politely, keep unsent edits saved. */
export function leaveEditor() {
  if (!ed) return;
  const e = ed;
  ed = null;
  // A slider still settling is kept as a queued edit, not lost; it's sent when Edit opens again.
  e.stashDrafts();
  e.persistState();
  e.dispose({ endSession: e.pending.length === 0 && !e.hasDrafts() });
}

export const editorActive = () => ed !== null;

// ── persisted per project ───────────────────────────────────────────────────
const storeKey = (projectId) => `${core.activePairing()?.macId}:${projectId}`;
function stored(projectId) {
  return saved.edits[storeKey(projectId)] ?? null;
}
function store(projectId, value) {
  if (value) saved.edits[storeKey(projectId)] = value;
  else delete saved.edits[storeKey(projectId)];
  core.persist();
}

const uuid = () => crypto.randomUUID();
/** Volume sliders start at −30 dB, lower only when a clip is already quieter (set on the Mac). */
const gainMin = (db) => Math.max(M.LIMITS.gainDb[0], Math.min(-30, Math.floor(db)));
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const round2 = (x) => Math.round(x * 100) / 100;

class Editor {
  constructor(projectId, revision, from) {
    this.projectId = projectId;
    this.openedRevision = revision;
    this.from = from;
    const prev = stored(projectId);
    // A session left open (app closed, connection lost) is resumed: same id, same unsent edits.
    this.sessionId = prev?.sessionId ?? uuid();
    // Each queued edit keeps the revision it was made against (older saves: the saved model's revision).
    this.pending = Array.isArray(prev?.pending) ? prev.pending.map((p) => ({ ...p, base: Number.isInteger(p.base) ? p.base : (prev.model?.revision ?? null) })) : [];
    this.textDrafts = prev?.textDrafts ?? {};
    this.model = prev?.model ?? null;
    this.tool = prev?.tool ?? 'clip';
    this.playhead = prev?.playhead ?? 0;
    this.sel = prev?.sel ?? { clipId: null, captionId: null };
    this.phase = 'opening'; // opening | agent | stopping | locked | ready | conflict | lost | ending | failed
    this.lease = null;
    this.agent = null;
    this.agentStopped = false;
    this.conflict = null;
    this.lastSync = prev?.at ?? null;
    this.saveError = null;
    this.drafts = new Map(); // key → { ops, label, timer }
    this.gesture = null; // a drag in progress: { ops } shown but not queued
    this.busy = false;
    this.pps = prev?.pps ?? 40;
    this.playing = false;
    this.strips = new Map();
    this.stills = new Map();
    this.fonts = new Map();
    this.lastAck = 0;
    this.previewAsked = new Set();
    this.disposed = false;
    this.build();
    this.timers = [setInterval(() => this.heartbeat(), HEARTBEAT_MS), setInterval(() => this.tick(), 1000)];
    // Where the playhead was is saved when the app goes to the background, not on every seek.
    this.onHide = () => {
      if (document.visibilityState !== 'hidden') return;
      this.persistState();
      core.persistNow();
    };
    document.addEventListener('visibilitychange', this.onHide);
    host.pausePlayers?.();
    // Said once per phone: undo here can't reach edits made before this session or on the Mac.
    if (!saved.prefs.editUndoHint) {
      saved.prefs.editUndoHint = true;
      core.persist();
      setTimeout(() => host.toast('Undo and redo step through this editing session only.'), 600);
    }
    void this.open();
  }

  // ── derived ───────────────────────────────────────────────────────────────
  get fps() {
    return this.model?.fps ?? { num: 30, den: 1 };
  }
  get live() {
    return core.status().live;
  }
  /** The model with every unconfirmed change on top: what the screen shows. */
  view() {
    let v = this.model;
    if (!v) return null;
    const layers = [...this.pending.filter((p) => p.kind === 'apply').map((p) => p.ops), ...[...this.drafts.values()].map((d) => d.ops), ...(this.gesture ? [this.gesture.ops] : [])];
    for (const ops of layers) {
      try {
        v = M.applyOps(v, ops);
      } catch {
        // a guess that no longer fits; the Mac's answer will settle it
      }
    }
    return v;
  }
  /** Everything the screen derives from the timeline; equal signatures draw the same timeline and panel. */
  sig() {
    const d = [...this.drafts.entries()].map(([k, v]) => [k, v.ops]);
    return JSON.stringify([this.model?.revision, this.pending.map((p) => [p.commandId, p.ops]), d, this.gesture?.ops ?? null, this.textDrafts, this.model?.history]);
  }
  hasDrafts() {
    return this.drafts.size > 0 || Object.keys(this.textDrafts).length > 0;
  }
  editable() {
    return this.phase === 'ready' && this.live && !!this.model;
  }

  persistState() {
    if (this.disposed) return;
    store(this.projectId, {
      sessionId: this.sessionId,
      pending: this.pending.map(({ commandId, kind, ops, label, base, sent }) => ({ commandId, kind, ops, label, base, sent })),
      textDrafts: this.textDrafts,
      model: this.model,
      tool: this.tool,
      playhead: this.playhead,
      sel: this.sel,
      pps: this.pps,
      at: this.lastSync,
    });
  }

  // ── talking to the Mac ────────────────────────────────────────────────────
  async open() {
    if (!this.live) {
      this.phase = this.model ? 'lost' : 'opening';
      return this.refresh();
    }
    const r = await core.command('edit.open', { projectId: this.projectId });
    if (this.disposed) return;
    if (!r || r.t === 'error') {
      this.phase = 'failed';
      this.failText = r?.message ?? 'Your Mac isn’t connected.';
      return this.refresh();
    }
    this.take(r);
    if (r.lease && r.lease.sessionId !== this.sessionId) {
      // Held by another phone, or by another tab/window of this one: never taken without asking.
      this.phase = r.lease.deviceId === core.activePairing()?.deviceId ? 'elsewhere' : 'locked';
      return this.refresh();
    }
    if (r.agent) {
      this.phase = 'agent';
      this.refresh();
      return this.agentSheet();
    }
    await this.begin();
  }

  async begin({ stopAgent = false } = {}) {
    if (stopAgent) this.phase = 'stopping';
    this.refresh();
    const r = await core.command('edit.begin', { projectId: this.projectId, sessionId: this.sessionId, stopAgent }, { timeout: 20_000 });
    if (this.disposed) return;
    if (!r) {
      this.phase = 'lost';
      return this.refresh();
    }
    if (r.t === 'error') {
      if (r.code === 'EDIT_LOCKED') {
        this.lease = { deviceName: r.details?.deviceName ?? 'Another phone', expiresAt: r.details?.expiresAt };
        this.phase = 'locked';
      } else if (r.code === 'AGENT_BUSY') {
        this.phase = 'agent';
        this.agentSheet();
      } else {
        this.phase = 'failed';
        this.failText = r.message;
      }
      return this.refresh();
    }
    if (stopAgent) this.agentStopped = true;
    this.take(r);
    this.phase = 'ready';
    // Opened from an older revision (a stale link): say once that the latest is what's being edited.
    if (this.openedRevision && this.model.revision !== this.openedRevision && !this.pending.length) host.toast(`The timeline is at revision ${this.model.revision} now; you’re editing the latest.`);
    this.openedRevision = null;
    this.ensureSelection();
    this.persistState();
    this.refresh();
    this.pump();
  }

  /** The Mac's answer replaces the guess. */
  take(r) {
    // Revisions only grow (undo is a new revision too): a late answer never rolls the screen back.
    if (r.model && !(this.model && r.model.revision < this.model.revision)) {
      this.model = r.model;
      this.lastSync = Date.now();
    }
    if ('lease' in r) this.lease = r.lease;
    if ('agent' in r) this.agent = r.agent;
  }

  async heartbeat() {
    if (this.phase !== 'ready' || !this.live || this.disposed) return;
    const r = await core.command('edit.heartbeat', { projectId: this.projectId, sessionId: this.sessionId }, { timeout: 10_000 });
    if (this.disposed || !r) return;
    if (r.t === 'error' && (r.code === 'LEASE_LOST' || r.code === 'LEASE_EXPIRED')) return this.open();
    if (r.t === 'edit' && typeof r.revision === 'number' && this.model && r.revision !== this.model.revision && !this.pending.length && !this.busy) {
      // Someone else changed the timeline (desktop): fetch it, nothing of ours is waiting.
      const o = await core.command('edit.open', { projectId: this.projectId });
      if (o?.t === 'edit') {
        this.take(o);
        this.ensureSelection();
        this.refresh();
      }
    }
  }

  /** Once a second: reconnects, settles, asks for a fresh rendered preview when edits pause. */
  tick() {
    if (this.disposed) return;
    const liveNow = this.live;
    if (liveNow && (this.phase === 'lost' || (this.phase === 'opening' && !this.model))) void this.open();
    if (liveNow && this.phase === 'ready') this.pump();
    if (!liveNow && this.phase === 'ready') {
      this.phase = 'lost';
      this.refresh();
    }
    const m = this.model;
    const d = host.detailOf(this.projectId);
    if (liveNow && m && this.phase === 'ready' && !this.pending.length && !this.drafts.size && !this.playing && Date.now() - this.lastAck > 3000) {
      const pv = d?.preview;
      const macId = core.activePairing()?.macId;
      const rendering = (macId ? (core.macCache(macId).snapshot?.jobs ?? []) : []).some((j) => j.projectId === this.projectId && j.kind === 'preview');
      if (!rendering && (!pv || pv.revision !== m.revision) && !this.previewAsked.has(m.revision) && m.durationFrames > 0) {
        this.previewAsked.add(m.revision);
        void core.command('preview.start', { projectId: this.projectId }, { wait: false });
      }
    }
    core.openProject(this.projectId);
    this.refreshStatus();
  }

  /** Queues one edit (one undo step). The screen shows it at once; the Mac decides. */
  submit(ops, label) {
    if (!this.editable() && this.phase !== 'lost') return false;
    const v = this.view();
    try {
      M.applyOps(v, ops);
    } catch (e) {
      host.toast(e.message, 'error');
      return false;
    }
    this.pending.push({ commandId: uuid(), kind: 'apply', ops, label, base: this.nextBase() });
    this.saveError = null;
    this.persistState();
    this.refresh();
    this.pump();
    return true;
  }

  /**
   * The revision a new edit is made against: the one the queued edit before it was made against (the
   * Mac's answer moves it forward), or the Mac's latest when nothing is queued.
   */
  nextBase() {
    return this.pending.length ? this.pending.at(-1).base : (this.model?.revision ?? null);
  }

  /** Sends queued edits one by one, in order. */
  async pump() {
    if (this.busy || this.phase !== 'ready' || !this.live || !this.pending.length || this.disposed) return;
    this.busy = true;
    this.refreshStatus();
    try {
      while (this.pending.length && this.phase === 'ready' && !this.disposed) {
        const item = this.pending[0];
        const type = item.kind === 'apply' ? 'edit.apply' : `edit.${item.kind}`;
        // The revision this edit was made against, never "whatever the Mac has now": a desktop edit made
        // while this phone was offline must come back as a conflict, not be edited over.
        const base = item.base ?? this.model.revision;
        if (!item.sent) {
          item.sent = true;
          this.persistState();
        }
        const r = await core.command(type, { projectId: this.projectId, sessionId: this.sessionId, commandId: item.commandId, baseRevision: base, operations: item.ops, label: item.label }, { timeout: 20_000 });
        if (this.disposed) return;
        if (!r || r.timeout) {
          // Not delivered or no answer: it stays first in line with the same id; the retry can't double it.
          this.refreshStatus();
          return;
        }
        if (r.t === 'edit') {
          this.pending.shift();
          // Edits queued on top of this one were made against its result.
          for (const p of this.pending) if (p.base === base) p.base = r.revision;
          this.take(r);
          this.lastAck = Date.now();
          this.ensureSelection();
          this.persistState();
          this.refresh();
          continue;
        }
        if (r.code === 'REVISION_CONFLICT') {
          this.phase = 'conflict';
          this.conflict = { current: r.details?.currentRevision ?? null };
          this.persistState();
          this.refresh();
          return this.conflictSheet();
        }
        if (r.code === 'LEASE_LOST' || r.code === 'LEASE_EXPIRED') {
          // Lapsed (phone was away): resumed with the same id. Taken by another tab: open() says so.
          this.busy = false;
          return this.open();
        }
        // The Mac refused this edit (the rules changed under it): drop it, show why, keep the rest.
        // (The ones after it were made on top of it; they go to the Mac as they are and it decides.)
        this.pending.shift();
        this.saveError = `${item.label}: ${r.message}`;
        host.toast(`Not applied: ${r.message}`, 'error');
        this.persistState();
        this.refresh();
      }
    } finally {
      this.busy = false;
      this.refreshStatus();
    }
  }

  undo() {
    const last = this.pending.at(-1);
    if (last && last !== this.pending[0] && last.kind === 'apply') {
      // Never reached the Mac: undoing it here is the whole story.
      this.pending.pop();
      this.persistState();
      return this.refresh();
    }
    if (this.drafts.size) return this.discardDrafts();
    if (!this.model?.history?.canUndo || this.pending.length) return;
    this.pending.push({ commandId: uuid(), kind: 'undo', ops: null, label: 'Undo', base: this.model.revision });
    this.persistState();
    this.refresh();
    this.pump();
  }

  redo() {
    if (!this.model?.history?.canRedo || this.pending.length || this.drafts.size) return;
    this.pending.push({ commandId: uuid(), kind: 'redo', ops: null, label: 'Redo', base: this.model.revision });
    this.persistState();
    this.refresh();
    this.pump();
  }

  /** A slider or stepper: shown at once, sent as one edit once the hand pauses. */
  draft(key, ops, label, ms = DRAFT_MS) {
    try {
      M.applyOps(this.viewWithout(key), ops);
    } catch (e) {
      host.toast(e.message, 'error');
      return false;
    }
    const d = this.drafts.get(key);
    if (d) clearTimeout(d.timer);
    this.drafts.set(key, { ops, label, timer: setTimeout(() => this.commitDraft(key), ms) });
    this.refresh();
    return true;
  }
  viewWithout(key) {
    const saveD = this.drafts.get(key);
    if (saveD) this.drafts.delete(key);
    const v = this.view();
    if (saveD) this.drafts.set(key, saveD);
    return v;
  }
  commitDraft(key) {
    const d = this.drafts.get(key);
    if (!d) return;
    clearTimeout(d.timer);
    this.drafts.delete(key);
    this.submit(d.ops, d.label);
  }
  flushDrafts() {
    for (const key of [...this.drafts.keys()]) this.commitDraft(key);
    for (const [captionId, text] of Object.entries(this.textDrafts)) this.commitText(captionId, text);
  }
  /** Slider/stepper drafts become queued edits right away (leaving the screen mid-gesture). */
  stashDrafts() {
    for (const [key, d] of [...this.drafts]) {
      clearTimeout(d.timer);
      this.drafts.delete(key);
      if (this.model) this.pending.push({ commandId: uuid(), kind: 'apply', ops: d.ops, label: d.label, base: this.nextBase() });
    }
  }

  discardDrafts() {
    for (const d of this.drafts.values()) clearTimeout(d.timer);
    this.drafts.clear();
    this.textDrafts = {};
    this.persistState();
    this.refresh();
  }

  /** Waits until everything queued has been answered (or can't be, right now). */
  async settle(ms = 25_000) {
    this.flushDrafts();
    const end = Date.now() + ms;
    while (this.pending.length && Date.now() < end && this.phase === 'ready' && this.live && !this.disposed) {
      this.pump();
      await core.sleep(120);
    }
    return this.pending.length === 0;
  }

  async done() {
    if (!this.editable()) return host.toast(this.phase === 'lost' ? 'Saving needs your Mac online. Your changes stay on this phone until then.' : 'Not editing right now.');
    this.ending = true;
    this.refresh();
    const ok = await this.settle();
    if (!ok) {
      this.ending = false;
      this.refresh();
      return host.toast(this.phase === 'conflict' ? 'Resolve the conflict first.' : 'Some changes haven’t reached your Mac yet. Try Done again.', 'error');
    }
    const r = await core.command('edit.end', { projectId: this.projectId, sessionId: this.sessionId });
    this.ending = false;
    if (!r || r.t === 'error') {
      this.refresh();
      return host.toast(r?.message ?? 'Your Mac didn’t answer. Try Done again.', 'error');
    }
    const revision = r.revision;
    store(this.projectId, null);
    this.disposed = true;
    this.dispose({ endSession: false });
    ed = null;
    core.openProject(this.projectId, true);
    host.go(`#/review/${this.projectId}/rev/${revision}/s/${this.sessionId}`);
  }

  /** Back: leave cleanly, or ask what to do with changes that haven't reached the Mac. */
  back() {
    const unsent = this.pending.length + this.drafts.size + Object.keys(this.textDrafts).length;
    const leave = async ({ save }) => {
      closeSheet();
      if (save) {
        if (!(await this.settle())) return host.toast('Some changes haven’t reached your Mac yet. They stay on this phone; open Edit again to send them.', 'error');
      } else {
        // What reached the Mac without an answer can't be recalled (it may already be applied): it stays
        // queued, so its outcome is settled with the same id. Everything after it is dropped.
        this.pending = this.busy || this.pending[0]?.sent ? this.pending.slice(0, 1) : [];
        this.discardDrafts();
      }
      if (this.live && this.phase === 'ready') await core.command('edit.end', { projectId: this.projectId, sessionId: this.sessionId }, { timeout: 8000 });
      if (!this.pending.length) store(this.projectId, null);
      this.dispose({ endSession: false });
      ed = null;
      host.go(this.from || `#/session/${this.projectId}`);
    };
    if (!unsent) return leave({ save: true });
    sheet(
      'Leave the editor?',
      h(
        'div',
        { class: 'stack' },
        h('p', { text: `${unsent === 1 ? 'One change hasn’t' : `${unsent} changes haven’t`} reached your Mac yet.` }),
        h('p', { class: 'muted small', text: 'Changes your Mac already saved stay on the timeline either way; Undo in the editor takes them back. A change already on its way to the Mac can’t be called back.' }),
        button('Keep editing', { kind: 'mint', full: true, onclick: closeSheet }),
        button('Save & leave', { full: true, iconName: 'check', disabled: !this.live, onclick: () => leave({ save: true }) }),
        !this.live ? h('p', { class: 'muted small', text: 'Saving needs your Mac online.' }) : null,
        button('Discard unsent changes', { kind: 'danger', full: true, iconName: 'trash', onclick: () => leave({ save: false }) }),
      ),
    );
  }

  agentSheet() {
    const a = this.agent;
    sheet(
      'Pause agent to edit?',
      h(
        'div',
        { class: 'stack' },
        h('p', { text: a ? `The agent is planning: “${String(a.instruction).slice(0, 120)}”` : 'The agent is planning changes to this project.' }),
        h('p', { class: 'muted small', text: 'It can’t pause halfway through a plan. Stopping it cancels the request: it only proposes, so nothing on your timeline has changed. You can ask it again after editing.' }),
        button('Stop agent & edit', { kind: 'mint', full: true, iconName: 'stop', onclick: () => (closeSheet(), this.begin({ stopAgent: true })) }),
        button('Wait for the agent', { full: true, iconName: 'clock', onclick: () => (closeSheet(), this.waitForAgent()) }),
        button('Cancel', { kind: 'ghost', full: true, onclick: () => (closeSheet(), this.back()) }),
      ),
    );
  }

  async waitForAgent() {
    this.phase = 'agent';
    this.waiting = true;
    this.refresh();
    while (!this.disposed && this.waiting) {
      await core.sleep(1500);
      const macId = core.activePairing()?.macId;
      const busy = (macId ? (core.macCache(macId).snapshot?.asks ?? []) : []).some((x) => x.projectId === this.projectId);
      if (!busy && this.live) {
        this.waiting = false;
        return this.open();
      }
    }
  }

  conflictSheet() {
    const unsent = this.pending.filter((p) => p.kind === 'apply');
    sheet(
      'The timeline changed on your Mac',
      h(
        'div',
        { class: 'stack' },
        h('p', { text: `Someone edited this project on the Mac (now revision ${this.conflict?.current ?? '?'}). ${unsent.length ? `${unsent.length === 1 ? 'Your last change wasn’t' : `${unsent.length} of your changes weren’t`} applied.` : ''}` }),
        h('p', { class: 'muted small', text: 'Nothing is overwritten without you choosing it.' }),
        unsent.length ? button('Re-apply my changes on top', { kind: 'mint', full: true, onclick: () => (closeSheet(), this.resolve('reapply')) }) : null,
        button(unsent.length ? 'Use the Mac’s version, drop mine' : 'Load the Mac’s version', { full: true, onclick: () => (closeSheet(), this.resolve('theirs')) }),
      ),
    );
  }

  async resolve(how) {
    const o = await core.command('edit.open', { projectId: this.projectId });
    if (!o || o.t === 'error') return host.toast(o?.message ?? 'Your Mac isn’t connected.', 'error');
    this.take(o);
    // The conflicted edit was refused for certain (that was the answer), so dropping it is safe.
    if (how === 'theirs') this.pending = [];
    else {
      // Re-check each against the Mac's version; keep the ones that still make sense.
      let v = this.model;
      const kept = [];
      for (const p of this.pending) {
        if (p.kind !== 'apply') continue;
        try {
          v = M.applyOps(v, p.ops);
          kept.push({ ...p, commandId: uuid(), sent: false, base: this.model.revision });
        } catch (e) {
          host.toast(`${p.label} no longer fits: ${e.message}`, 'error');
        }
      }
      this.pending = kept;
    }
    this.phase = 'ready';
    this.conflict = null;
    this.ensureSelection();
    this.persistState();
    this.refresh();
    this.pump();
  }

  dispose({ endSession = false } = {}) {
    this.disposed = true;
    for (const t of this.timers ?? []) clearInterval(t);
    for (const d of this.drafts.values()) clearTimeout(d.timer);
    for (const t of [this.textTimer, this.stillTimer, this.saveTimer]) clearTimeout(t);
    document.removeEventListener('visibilitychange', this.onHide);
    this.resizer?.disconnect();
    this.stopGestures?.();
    cancelAnimationFrame(this.raf);
    this.video?.pause();
    for (const s of this.stills.values()) if (s.url) URL.revokeObjectURL(s.url);
    for (const s of this.strips.values()) if (s.url) URL.revokeObjectURL(s.url);
    if (endSession && core.status().live) void core.command('edit.end', { projectId: this.projectId, sessionId: this.sessionId }, { wait: false });
  }

  // ── selection & time ──────────────────────────────────────────────────────
  ensureSelection() {
    const v = this.view();
    if (!v) return;
    if (this.sel.clipId && !M.clipById(v, this.sel.clipId)) this.sel.clipId = null;
    if (this.sel.captionId && !M.captionById(v, this.sel.captionId)) this.sel.captionId = null;
    const total = M.durationFrames(v);
    this.playhead = clamp(this.playhead, 0, Math.max(0, total - 1));
    if (!this.sel.clipId) {
      const main = M.mainTrack(v);
      const list = main ? M.clipsOn(v, main.id) : [];
      this.sel.clipId = (list.find((c) => c.start <= this.playhead && this.playhead < M.clipEnd(c)) ?? list[0])?.id ?? null;
    }
    if (!this.sel.captionId) {
      const caps = [...v.captions].sort(M.byStart);
      this.sel.captionId = (caps.find((c) => c.start <= this.playhead && this.playhead < c.start + c.duration) ?? caps.find((c) => c.start >= this.playhead) ?? caps[0])?.id ?? null;
    }
  }

  seek(frame, { follow = false } = {}) {
    const v = this.view();
    if (!v) return;
    this.playhead = clamp(Math.round(frame), 0, Math.max(0, M.durationFrames(v) - 1));
    if (this.video && this.playing) this.video.currentTime = M.framesToSeconds(this.playhead, this.fps);
    if (follow) this.follow();
    this.placePlayhead();
    this.updateTime();
    this.drawSoon();
    this.panelSoon();
  }

  saveSoon() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.persistState(), 400);
  }

  // ── DOM ───────────────────────────────────────────────────────────────────
  build() {
    this.titleEl = h('b', { class: 'ed-name ellipsis' });
    this.saveEl = h('span', { class: 'ed-save', 'aria-live': 'polite' });
    this.undoBtn = iconButton('undo', 'Undo', () => this.undo(), { cls: 'ed-ic' });
    this.redoBtn = iconButton('redo', 'Redo', () => this.redo(), { cls: 'ed-ic' });
    this.doneBtn = h('button', { class: 'ed-done', type: 'button', onclick: () => this.done() }, 'Done');
    const header = h(
      'header',
      { class: 'ed-top' },
      iconButton('back', 'Back', () => this.back(), { cls: 'ed-ic' }),
      h('span', { class: 'ed-brand' }, h('img', { src: '/mark.svg', alt: '', width: 26, height: 26 }), h('span', { class: 'ed-word', text: 'ReelForge' })),
      h('span', { class: 'ed-sep', 'aria-hidden': 'true' }),
      h('div', { class: 'ed-title' }, this.titleEl, this.saveEl),
      this.undoBtn,
      this.redoBtn,
      this.doneBtn,
    );
    this.statusEl = h('div', { class: 'ed-status', role: 'status', 'aria-live': 'polite' });

    // preview
    this.canvas = h('canvas', { class: 'ed-canvas', 'aria-label': 'Preview' });
    this.ctx = this.canvas.getContext('2d');
    this.video = h('video', { class: 'ed-video', playsinline: true, preload: 'auto', hidden: true });
    this.guides = h('div', { class: 'ed-guides', 'aria-hidden': 'true' }, h('span', { class: 'v1' }), h('span', { class: 'v2' }), h('span', { class: 'h1' }), h('span', { class: 'h2' }));
    this.picBox = h('div', { class: 'ed-picbox', 'aria-hidden': 'true' });
    this.capBox = h('div', { class: 'ed-capbox', 'aria-hidden': 'true' }, h('i', { class: 'tl' }), h('i', { class: 'tr' }), h('i', { class: 'bl' }), h('i', { class: 'br' }));
    this.badge = h('span', { class: 'ed-badge' });
    this.notice = h('div', { class: 'ed-notice', hidden: true });
    this.frameEl = h('div', { class: 'ed-frame' }, this.canvas, this.video, this.picBox, this.guides, this.capBox, this.badge, this.notice);
    this.stage = h('div', { class: 'ed-stage' }, this.frameEl);
    this.bindPreviewGestures();

    // transport
    this.playBtn = iconButton('play', 'Play', () => this.togglePlay(), { cls: 'ed-ic' });
    this.timeEl = h('span', { class: 'ed-time tabular' });
    this.muteBtn = iconButton('volume', 'Mute', () => {
      this.video.muted = !this.video.muted;
      this.updateTransport();
    }, { cls: 'ed-ic' });
    this.fullBtn = iconButton('maximize', 'Full screen', () => this.fullscreen(), { cls: 'ed-ic' });
    const transport = h('div', { class: 'ed-transport' }, this.playBtn, h('span', { class: 'grow center' }, this.timeEl), this.muteBtn, this.fullBtn);

    // timeline
    this.tlContent = h('div', { class: 'ed-tl-content' });
    this.tlScroll = h('div', { class: 'ed-tl-scroll', role: 'group', 'aria-label': 'Timeline. Drag the ruler to seek, drag clip edges to trim, pinch to zoom.' }, this.tlContent);
    this.tl = h('div', { class: 'ed-tl' }, this.tlScroll);
    this.bindTimelineGestures();

    this.panel = h('section', { class: 'ed-panel', 'aria-label': 'Tool settings' });
    this.dockEl = h(
      'nav',
      { class: 'ed-dock', 'aria-label': 'Edit tools' },
      TOOLS.map(([id, label, ic]) => h('button', { class: 'ed-tool', type: 'button', 'data-tool': id, 'aria-pressed': 'false', onclick: () => this.setTool(id) }, icon(ic, { size: 22 }), h('span', { text: label }))),
    );
    this.root = h('div', { class: 'editor' }, header, this.statusEl, this.stage, transport, this.tl, this.panel, this.dockEl);

    this.video.addEventListener('play', () => {
      this.playing = true;
      this.loop();
      this.refreshPreviewMode();
    });
    this.video.addEventListener('pause', () => {
      this.playing = false;
      this.refreshPreviewMode();
      this.updateTransport();
      this.drawSoon();
    });
    this.video.addEventListener('ended', () => this.video.pause());
    this.video.muted = false;
    this.resizer = new ResizeObserver(() => {
      this.sizeCanvas();
      this.renderTimeline();
    });
    this.resizer.observe(this.frameEl);
  }

  setTool(id) {
    if (this.tool === id) return;
    this.flushDrafts();
    this.tool = id;
    this.persistState();
    this.refresh();
  }

  refresh() {
    if (this.disposed) return;
    const p = host.projectById(this.projectId);
    const v = this.view();
    this.titleEl.textContent = v?.name ?? p?.name ?? 'Project';
    this.root.dataset.tool = this.tool;
    this.root.dataset.phase = this.phase;
    for (const b of this.dockEl.querySelectorAll('.ed-tool')) {
      const on = b.dataset.tool === this.tool;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
    this.refreshStatus();
    this.renderTimeline();
    this.renderPanel();
    this.updateTransport();
    this.refreshPreviewMode();
    this.drawSoon();
  }

  refreshStatus() {
    if (this.disposed) return;
    const st = core.status();
    const unsent = this.pending.length;
    // Save state: "Saved" only after the Mac answered.
    let save;
    let tone;
    if (this.saveError && !unsent) (save = 'Save failed'), (tone = 'error');
    else if (unsent && !st.live) (save = 'Saved on this phone · not synced'), (tone = 'warn');
    else if (unsent || this.ending) (save = 'Saving…'), (tone = 'busy');
    else if (this.drafts.size || Object.keys(this.textDrafts).length) (save = 'Editing…'), (tone = 'busy');
    else if (this.lastSync) (save = 'Saved'), (tone = 'ok');
    else (save = ''), (tone = '');
    this.saveEl.replaceChildren(...[tone === 'ok' ? icon('check', { size: 13 }) : tone === 'error' ? icon('alert', { size: 13 }) : null, h('span', { text: save })].filter(Boolean));
    this.saveEl.className = `ed-save ${tone}`;

    const h0 = this.model?.history;
    const localUndo = this.pending.length > 1 || this.drafts.size > 0;
    this.undoBtn.disabled = !this.editable() || !(localUndo || (h0?.canUndo && !this.pending.length));
    this.redoBtn.disabled = !this.editable() || !(h0?.canRedo && !this.pending.length && !this.drafts.size);
    this.undoBtn.setAttribute('aria-label', h0?.label?.undo && !localUndo ? `Undo ${h0.label.undo} (this editing session only)` : 'Undo (this editing session only)');
    this.redoBtn.setAttribute('aria-label', h0?.label?.redo ? `Redo ${h0.label.redo}` : 'Redo');
    this.doneBtn.disabled = !this.editable() || this.ending;

    let text;
    let kind = 'ok';
    const editorOpen = st.editor === 'open';
    switch (this.phase) {
      case 'opening':
        text = st.live ? 'Opening the editor…' : 'Waiting for your Mac…';
        kind = 'neutral';
        break;
      case 'agent':
        text = this.waiting ? 'Waiting for the agent to finish…' : 'Agent is planning changes';
        kind = 'warn';
        break;
      case 'stopping':
        text = 'Stopping the agent…';
        kind = 'warn';
        break;
      case 'locked':
        text = `${this.lease?.deviceName ?? 'Another phone'} is editing this project`;
        kind = 'warn';
        break;
      case 'elsewhere':
        text = 'Open for editing in another tab on this phone';
        kind = 'warn';
        break;
      case 'conflict':
        text = 'Timeline changed on your Mac · choose what to keep';
        kind = 'error';
        break;
      case 'lost':
        text = `Reconnecting…${this.lastSync ? ` · last sync ${ago(this.lastSync)}` : ''}${unsent ? ` · ${unsent} not synced` : ''}`;
        kind = 'warn';
        break;
      case 'failed':
        text = this.failText ?? 'Couldn’t open the editor';
        kind = 'error';
        break;
      default:
        text = `Manual editing${this.agentStopped ? ' · Agent stopped' : ''}${editorOpen ? ' · Mac editor open' : ''}`;
    }
    this.statusEl.className = `ed-status ${kind}`;
    this.statusEl.replaceChildren(h('span', { class: `dot ${kind === 'ok' ? 'ok' : kind === 'neutral' ? 'neutral' : kind === 'warn' ? 'warn' : 'error'}`, 'aria-hidden': 'true' }), h('span', { class: 'ellipsis', text }));
    if (this.phase === 'locked' || this.phase === 'failed' || (this.phase === 'agent' && !this.waiting)) {
      this.statusEl.append(h('button', { class: 'ed-status-act', type: 'button', onclick: () => (this.phase === 'agent' ? this.agentSheet() : this.open()) }, this.phase === 'agent' ? 'Options' : 'Try again'));
    }
    if (this.phase === 'elsewhere') this.statusEl.append(h('button', { class: 'ed-status-act', type: 'button', onclick: () => this.begin() }, 'Edit here'));
    if (this.phase === 'conflict') this.statusEl.append(h('button', { class: 'ed-status-act', type: 'button', onclick: () => this.conflictSheet() }, 'Resolve'));
    this.root.classList.toggle('readonly', !this.editable());
  }

  // ── preview ───────────────────────────────────────────────────────────────
  sizeCanvas() {
    const v = this.model;
    const W0 = v?.width ?? 1080;
    const H0 = v?.height ?? 1920;
    this.frameEl.style.setProperty('--arw', String(W0));
    this.frameEl.style.setProperty('--arh', String(H0));
    const rect = this.frameEl.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(2, Math.round(rect.width * dpr));
    const hgt = Math.max(2, Math.round(rect.height * dpr));
    if (this.canvas.width !== w || this.canvas.height !== hgt) {
      this.canvas.width = w;
      this.canvas.height = hgt;
      this.drawSoon();
    }
  }

  refreshPreviewMode() {
    const pv = live.previews.get(this.projectId);
    const m = this.model;
    const rendered = !!pv?.url;
    if (rendered && this.video.dataset.url !== pv.url) {
      const at = this.video.currentTime;
      this.video.src = pv.url;
      this.video.dataset.url = pv.url;
      this.video.addEventListener('loadedmetadata', () => (this.video.currentTime = Math.min(at, this.video.duration || 0)), { once: true });
    }
    this.video.hidden = !this.playing;
    this.canvas.hidden = this.playing;
    let label;
    let tone = 'live';
    if (this.playing) {
      const current = pv && m && pv.revision === m.revision && !this.pending.length;
      label = current ? `Rendered · revision ${pv.revision}` : `Rendered before your latest edits (revision ${pv?.revision ?? '?'})`;
      tone = current ? 'ok' : 'warn';
    } else {
      const fx = this.activeSegments().some((s) => s.clip.aiEffects || s.clip.props.grain > 0 || s.clip.props.sharpen > 0);
      label = fx ? 'Live · AI effects, grain and sharpen show in the render' : 'Live preview';
    }
    this.badge.textContent = label;
    this.badge.className = `ed-badge ${tone}`;
    this.updateTransport();
  }

  updateTransport() {
    const pv = live.previews.get(this.projectId);
    const canPlay = !!pv?.url;
    this.playBtn.disabled = !canPlay && !this.playing;
    this.playBtn.replaceChildren(icon(this.playing ? 'pause' : 'play'));
    const rendering = (core.macCache(core.activePairing()?.macId ?? '').snapshot?.jobs ?? []).find((j) => j.projectId === this.projectId && j.kind === 'preview');
    this.playBtn.setAttribute('aria-label', this.playing ? 'Pause' : canPlay ? 'Play the rendered preview' : rendering ? `Rendering a preview ${Math.round((rendering.progress ?? 0) * 100)}%` : 'No rendered preview yet');
    this.playBtn.title = this.playBtn.getAttribute('aria-label');
    this.muteBtn.replaceChildren(icon(this.video.muted ? 'mute' : 'volume'));
    this.muteBtn.setAttribute('aria-label', this.video.muted ? 'Unmute' : 'Mute');
    this.updateTime();
  }

  updateTime() {
    const v = this.view();
    const total = v ? M.durationFrames(v) : 0;
    const fps = this.fps;
    const short = (f) => M.timecode(f, fps).replace(/\.\d+$/, '');
    this.timeEl.replaceChildren(h('b', { text: short(this.playhead) }), h('span', { class: 'muted', text: ` / ${short(total)}` }));
    this.timeEl.setAttribute('aria-label', `${M.timecode(this.playhead, fps)} of ${M.timecode(total, fps)}`);
  }

  async togglePlay() {
    if (this.playing) return this.video.pause();
    const pv = live.previews.get(this.projectId);
    if (!pv?.url) return host.toast('There’s no rendered preview yet. It renders on your Mac once your edits pause.');
    this.flushDrafts();
    this.video.currentTime = M.framesToSeconds(this.playhead, this.fps);
    try {
      await this.video.play();
    } catch {
      host.toast('Couldn’t start playback.');
    }
  }

  loop() {
    cancelAnimationFrame(this.raf);
    const step = () => {
      if (!this.playing || this.disposed) return;
      this.playhead = Math.round(this.video.currentTime * M.fpsValue(this.fps));
      this.placePlayhead();
      this.updateTime();
      this.follow();
      this.raf = requestAnimationFrame(step);
    };
    this.raf = requestAnimationFrame(step);
  }

  fullscreen() {
    const target = this.playing && this.video.webkitEnterFullscreen && !this.stage.requestFullscreen ? this.video : this.stage;
    if (document.fullscreenElement) return document.exitFullscreen();
    if (target.requestFullscreen) return target.requestFullscreen().catch(() => host.toast('Full screen isn’t available here.'));
    if (this.video.webkitEnterFullscreen && this.video.src) return this.video.webkitEnterFullscreen();
    host.toast('Full screen isn’t available here.');
  }

  /** Picture clips under the playhead, bottom layer first; through a dissolve both clips are under it. */
  activeSegments(v = this.view(), frame = this.playhead) {
    if (!v) return [];
    const out = [];
    for (const t of M.pictureTracks(v)) {
      if (t.hidden) continue;
      for (const seg of M.planSegments(v, t.id)) {
        if (frame >= seg.renderStart && frame < seg.renderEnd) out.push({ clip: M.clipById(v, seg.id), seg, track: t, asset: M.assetOf(v, seg.assetId) });
      }
    }
    return out;
  }

  drawSoon() {
    if (this.drawQueued || this.disposed) return;
    this.drawQueued = true;
    requestAnimationFrame(() => {
      this.drawQueued = false;
      this.draw();
    });
  }

  draw() {
    const v = this.view();
    const ctx = this.ctx;
    const W = this.canvas.width;
    const H = this.canvas.height;
    ctx.save();
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    if (!v) return ctx.restore();
    let missing = false;
    for (const seg of this.activeSegments(v)) {
      const { clip, asset } = seg;
      if (!asset || asset.kind === 'audio') continue;
      const sourceFrame = asset.kind === 'image' ? 0 : seg.seg.renderSourceIn + (this.playhead - seg.seg.renderStart);
      const pic = this.picture(asset, sourceFrame);
      if (!pic) {
        missing = true;
        continue;
      }
      const pl = M.placement(clip, this.playhead, pic.w, pic.h, W, H);
      const alpha = M.pictureAlpha(seg.seg, this.playhead);
      ctx.save();
      ctx.globalAlpha = alpha;
      const p = clip.props;
      const filters = [];
      // Blur is applied to the fitted picture before zoom (effects.ts blurSigma), so it grows with the zoom.
      if (p.blur > 0) filters.push(`blur(${p.blur * 0.025 * W * (pl.dw / pl.fw)}px)`);
      if (p.grayscale > 0) filters.push(`grayscale(${p.grayscale})`);
      if (p.sepia > 0) filters.push(`sepia(${p.sepia})`);
      ctx.filter = filters.join(' ') || 'none';
      ctx.translate(pl.cx, pl.cy);
      ctx.rotate(pl.rotation);
      ctx.drawImage(pic.src, pic.x + (pl.sx / pic.w) * pic.sw, pic.y + (pl.sy / pic.h) * pic.sh, (pl.sw / pic.w) * pic.sw, (pl.sh / pic.h) * pic.sh, -pl.dw / 2, -pl.dh / 2, pl.dw, pl.dh);
      ctx.filter = 'none';
      if (p.vignette > 0) {
        // FFmpeg's vignette: × cos(angle·d)⁴, d = distance over the half-diagonal, on the fitted picture.
        const angle = p.vignette * (Math.PI / 2.5);
        const r = Math.hypot(pl.dw, pl.dh) / 2;
        const g = ctx.createRadialGradient(0, 0, 0, 0, 0, r);
        for (let i = 0; i <= 10; i++) g.addColorStop(i / 10, `rgba(0,0,0,${1 - Math.cos(angle * (i / 10)) ** 4})`);
        ctx.fillStyle = g;
        ctx.fillRect(-pl.dw / 2, -pl.dh / 2, pl.dw, pl.dh);
      }
      ctx.restore();
      if (pic.low) missing = true;
    }
    this.drawCaptions(v, W, H);
    ctx.restore();
    this.loadingFrame = missing;
    this.placeOverlays(v);
  }

  /** The best picture we have for a source frame: the exact still, else the filmstrip's nearest tile. */
  picture(asset, sourceFrame) {
    const key = `${asset.id}:${sourceFrame}`;
    const s = this.stills.get(key);
    if (s?.img) return { src: s.img, x: 0, y: 0, sw: s.img.naturalWidth, sh: s.img.naturalHeight, w: s.img.naturalWidth, h: s.img.naturalHeight };
    this.wantStill(asset, sourceFrame);
    // Nearest still we already have for this asset (scrubbing), then the strip tile.
    let best = null;
    for (const [k, v] of this.stills) {
      if (!v.img || !k.startsWith(`${asset.id}:`)) continue;
      const f = Number(k.split(':')[1]);
      if (!best || Math.abs(f - sourceFrame) < Math.abs(best.f - sourceFrame)) best = { f, img: v.img };
    }
    if (best && Math.abs(best.f - sourceFrame) < M.fpsValue(this.fps) * 2) return { src: best.img, x: 0, y: 0, sw: best.img.naturalWidth, sh: best.img.naturalHeight, w: best.img.naturalWidth, h: best.img.naturalHeight, low: true };
    const strip = this.strip(asset);
    if (strip?.img) {
      const tw = strip.img.naturalWidth / strip.count;
      const us = (sourceFrame * this.fps.den * 1e6) / this.fps.num;
      const i = clamp(Math.floor(us / strip.stepUs), 0, strip.count - 1);
      return { src: strip.img, x: i * tw, y: 0, sw: tw, sh: strip.img.naturalHeight, w: tw, h: strip.img.naturalHeight, low: true };
    }
    return null;
  }

  wantStill(asset, sourceFrame) {
    clearTimeout(this.stillTimer);
    // Scrubbing asks for nothing until the hand rests; the strip covers the motion.
    this.stillTimer = setTimeout(() => void this.fetchStill(asset, sourceFrame), this.scrubbing ? 220 : 60);
  }

  async fetchStill(asset, sourceFrame) {
    const key = `${asset.id}:${sourceFrame}`;
    if (this.stills.has(key) || !this.live || this.disposed) return;
    this.stills.set(key, { loading: true });
    const r = await core.command('edit.still', { projectId: this.projectId, assetId: asset.id, sourceFrame }, { timeout: 20_000 });
    if (!r || r.t !== 'still') return this.stills.delete(key);
    try {
      const blob = await core.fetchBlob(r.blob);
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.src = url;
      await img.decode();
      if (this.disposed) return URL.revokeObjectURL(url);
      this.stills.set(key, { url, img });
      if (this.stills.size > 80) {
        const [k0, s0] = this.stills.entries().next().value;
        if (s0.url) URL.revokeObjectURL(s0.url);
        this.stills.delete(k0);
      }
      this.drawSoon();
    } catch {
      this.stills.delete(key);
    }
  }

  strip(asset) {
    let s = this.strips.get(asset.id);
    if (!s && this.live && asset.kind !== 'audio') {
      s = { loading: true };
      this.strips.set(asset.id, s);
      void (async () => {
        const r = await core.command('edit.strip', { projectId: this.projectId, assetId: asset.id }, { timeout: 60_000 });
        if (!r || r.t !== 'strip') return this.strips.delete(asset.id);
        try {
          const url = URL.createObjectURL(await core.fetchBlob(r.blob));
          const img = new Image();
          img.src = url;
          await img.decode();
          if (this.disposed) return URL.revokeObjectURL(url);
          this.strips.set(asset.id, { url, img, count: r.count, stepUs: r.stepUs });
          this.renderTimeline();
          this.drawSoon();
        } catch {
          this.strips.delete(asset.id);
        }
      })();
    }
    return s?.img ? s : null;
  }

  // captions: the export's layout (edit-model.js), drawn with the same bundled fonts
  font(name) {
    const f = this.fonts.get(name);
    if (f?.ready) return f;
    if (!f) {
      const entry = { ready: false };
      this.fonts.set(name, entry);
      void (async () => {
        try {
          const buf = await (await fetch(`/fonts/${M.CAPTION_FONTS[name]}`)).arrayBuffer();
          const family = `RF ${name}`;
          const face = new FontFace(family, buf);
          await face.load();
          document.fonts.add(face);
          Object.assign(entry, ttfMetrics(buf), { family, ready: true });
          this.drawSoon();
        } catch {
          this.fonts.delete(name);
        }
      })();
    }
    return null;
  }

  captionLayout(c, style, W, H) {
    const f = this.font(style.font);
    if (!f) return null;
    const ctx = this.ctx;
    const font = {
      unitsPerEm: f.unitsPerEm,
      ascender: f.ascender,
      descender: f.descender,
      getAdvanceWidth: (text, size) => {
        ctx.font = `${size}px "${f.family}"`;
        return ctx.measureText(text).width;
      },
    };
    return { L: M.layoutCaption(c, style, W, H, font), f };
  }

  drawCaptions(v, W, H) {
    const ctx = this.ctx;
    for (const t of M.captionTracks(v)) {
      if (t.hidden) continue;
      const c = M.captionsOn(v, t.id).find((x) => x.start <= this.playhead && this.playhead < x.start + x.duration);
      if (!c) continue;
      const shown = this.textDrafts[c.id] !== undefined ? { ...c, text: this.textDrafts[c.id], words: [] } : c;
      const style = t.captionStyle;
      const got = this.captionLayout(shown, style, W, H);
      if (!got) continue;
      const { L, f } = got;
      const active = style.highlight ? M.activeWordAt(shown, this.playhead - c.start) : -1;
      ctx.save();
      ctx.font = `${L.fontSize}px "${f.family}"`;
      ctx.textBaseline = 'alphabetic';
      const r = style.stroke * L.fontSize;
      if (style.box) {
        ctx.fillStyle = cssColor(style.box);
        for (const ln of L.lines) {
          ctx.beginPath();
          ctx.roundRect(ln.x, ln.y, ln.width, ln.height, L.fontSize * 0.18);
          ctx.fill();
        }
      }
      if (style.shadow) {
        const off = Math.round(L.fontSize * 0.05);
        ctx.save();
        ctx.translate(off, off);
        ctx.globalAlpha = 0.55;
        ctx.filter = `blur(${Math.max(1, Math.round(L.fontSize * 0.04)) / 1.5}px)`;
        ctx.fillStyle = '#000';
        ctx.strokeStyle = '#000';
        ctx.lineJoin = 'round';
        ctx.lineWidth = 2 * r;
        for (const w of L.words) {
          if (r > 0.3) ctx.strokeText(w.text, w.x, w.baseline);
          ctx.fillText(w.text, w.x, w.baseline);
        }
        ctx.restore();
      }
      if (r > 0.3) {
        ctx.strokeStyle = style.strokeColor;
        ctx.lineJoin = 'round';
        ctx.lineWidth = 2 * r;
        for (const w of L.words) ctx.strokeText(w.text, w.x, w.baseline);
      }
      for (const w of L.words) {
        ctx.fillStyle = style.highlight && w.index === active ? style.highlight : style.color;
        ctx.fillText(w.text, w.x, w.baseline);
      }
      ctx.restore();
      this.lastCaptionBounds = { id: c.id, bounds: L.bounds, W, H };
    }
  }

  /** Guides, the selected picture's outline, and the selected caption's box, over the canvas. */
  placeOverlays(v) {
    const frameTool = this.tool === 'frame' && !this.playing;
    const W = this.canvas.width;
    const H = this.canvas.height;
    this.guides.hidden = !frameTool;
    const sel = M.clipById(v, this.sel.clipId);
    const under = sel && this.playhead >= sel.start && this.playhead < M.clipEnd(sel);
    const seg = under ? this.activeSegments(v).find((s) => s.clip.id === sel.id) : null;
    let pic = null;
    if (seg && seg.asset && seg.asset.kind !== 'audio') {
      const s = this.picture(seg.asset, seg.asset.kind === 'image' ? 0 : sel.sourceIn + (this.playhead - sel.start));
      if (s) pic = M.placement(sel, this.playhead, s.w, s.h, W, H);
    }
    this.picBox.hidden = !frameTool || !pic;
    if (pic) {
      this.picBox.style.setProperty('--l', `${((pic.cx - pic.dw / 2) / W) * 100}%`);
      this.picBox.style.setProperty('--t', `${((pic.cy - pic.dh / 2) / H) * 100}%`);
      this.picBox.style.setProperty('--w', `${(pic.dw / W) * 100}%`);
      this.picBox.style.setProperty('--h', `${(pic.dh / H) * 100}%`);
    }
    const capTool = this.tool === 'captions' && !this.playing;
    const cb = this.lastCaptionBounds;
    const showCap = capTool && cb && cb.id === this.sel.captionId && v.captions.some((c) => c.id === cb.id && c.start <= this.playhead && this.playhead < c.start + c.duration);
    this.capBox.hidden = !showCap;
    if (showCap) {
      this.capBox.style.setProperty('--l', `${(cb.bounds.x / cb.W) * 100}%`);
      this.capBox.style.setProperty('--t', `${(cb.bounds.y / cb.H) * 100}%`);
      this.capBox.style.setProperty('--w', `${(cb.bounds.width / cb.W) * 100}%`);
      this.capBox.style.setProperty('--h', `${(cb.bounds.height / cb.H) * 100}%`);
    }
    // Frame tool, but the selected clip isn't on screen at the playhead: say so, offer to go there.
    const note = this.tool === 'frame' && sel && !under && !this.playing;
    this.notice.hidden = !note;
    if (note) {
      this.notice.replaceChildren(h('span', { text: 'The selected clip isn’t at the playhead.' }), button('Show it', { small: true, kind: 'mint', onclick: () => this.seek(sel.start + Math.floor(sel.duration / 2), { follow: true }) }));
    }
    this.badge.classList.toggle('loading', !!this.loadingFrame && !this.playing);
    if (!this.playing) this.badge.dataset.extra = this.loadingFrame ? (this.live ? ' · loading frame' : ' · thumbnail (offline)') : '';
  }

  bindPreviewGestures() {
    const pts = new Map();
    let start = null;
    const el = this.frameEl;
    el.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button')) return;
      el.setPointerCapture?.(e.pointerId);
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const v = this.view();
      const clip = M.clipById(v, this.sel.clipId);
      start = { pts: new Map(pts), props: clip ? { ...clip.props } : null, rect: el.getBoundingClientRect(), moved: false, t: performance.now() };
    });
    el.addEventListener('pointermove', (e) => {
      if (!pts.has(e.pointerId) || !start) return;
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
      const first = [...start.pts.values()];
      const now = [...pts.values()];
      if (Math.abs(now[0].x - first[0].x) + Math.abs(now[0].y - first[0].y) > 6) start.moved = true;
      if (this.tool !== 'frame' || !start.props || !this.editable() || this.playing) return;
      const clip = M.clipById(this.view(), this.sel.clipId);
      if (!clip || this.playhead < clip.start || this.playhead >= M.clipEnd(clip)) return;
      const p = start.props;
      let patch;
      if (now.length >= 2 && first.length >= 2) {
        const k = d(now[0], now[1]) / Math.max(1, d(first[0], first[1]));
        patch = { scale: round2(clamp(p.scale * k, ...M.LIMITS.scale)) };
      } else {
        const dx = (now[0].x - first[0].x) / start.rect.width;
        const dy = (now[0].y - first[0].y) / start.rect.height;
        patch = { x: round2(clamp(p.x + dx, ...M.LIMITS.pos)), y: round2(clamp(p.y + dy, ...M.LIMITS.pos)) };
      }
      this.gesture = { ops: [{ type: 'clip.update', clipId: clip.id, props: patch }], label: 'Framing' };
      this.drawSoon();
      this.panelSoon();
    });
    const end = (e) => {
      if (!pts.has(e.pointerId)) return;
      pts.delete(e.pointerId);
      if (pts.size) {
        // one finger lifted from a pinch: continue from here as a drag
        start = { ...start, pts: new Map(pts), props: { ...(M.clipById(this.view(), this.sel.clipId)?.props ?? start.props) } };
        return;
      }
      const g = this.gesture;
      this.gesture = null;
      if (g) this.submit(g.ops, g.label);
      else if (!start?.moved && this.tool === 'captions') this.tapCaption(e);
      start = null;
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
  }

  tapCaption(e) {
    const cb = this.lastCaptionBounds;
    if (!cb) return;
    const rect = this.frameEl.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * cb.W;
    const y = ((e.clientY - rect.top) / rect.height) * cb.H;
    const b = cb.bounds;
    if (x >= b.x && x <= b.x + b.width && y >= b.y && y <= b.y + b.height) {
      this.selectCaption(cb.id, { seek: false });
    }
  }

  // ── timeline ──────────────────────────────────────────────────────────────
  ppf() {
    return this.pps / M.fpsValue(this.fps);
  }
  xOf(frame) {
    return PAD + frame * this.ppf();
  }
  frameAt(x) {
    return Math.round((x - PAD) / this.ppf());
  }

  renderTimeline(force = false) {
    const v = this.view();
    if (!v || this.disposed) return;
    // Rebuilt only when what it shows changed: a redraw under a finger would drop focus and the gesture.
    const key = `${this.sig()}|${this.tool}|${this.pps}|${this.sel.clipId}|${this.sel.captionId}|${[...this.strips.values()].filter((x) => x.img).length}|${this.tlScroll.clientWidth}`;
    if (!force && key === this.tlKey) return this.placePlayhead();
    this.tlKey = key;
    const total = Math.max(1, M.durationFrames(v));
    const vw = this.tlScroll.clientWidth || 360;
    const ppf = this.ppf();
    const width = PAD * 2 + total * ppf + vw * 0.4;
    this.tlContent.style.setProperty('--w', `${width}px`);
    const kids = [this.ruler(total, ppf)];
    const lanes = [];
    const main = M.mainTrack(v);
    for (const t of M.pictureTracks(v)) {
      const clips = M.clipsOn(v, t.id);
      if (!clips.length && t !== main) continue;
      lanes.push(this.lane(v, t, clips, t === main ? 'main' : 'overlay'));
    }
    if (this.tool === 'captions') for (const t of M.captionTracks(v)) lanes.push(this.captionLane(v, t));
    if (this.tool === 'audio') for (const t of M.audioTracks(v)) if (M.clipsOn(v, t.id).length) lanes.push(this.lane(v, t, M.clipsOn(v, t.id), 'audio'));
    kids.push(h('div', { class: 'ed-lanes' }, lanes));
    this.playheadEl = h('div', { class: 'ed-playhead', 'aria-hidden': 'true' }, h('span', { class: 'ed-ph-label tabular' }));
    this.snapEl = h('div', { class: 'ed-snap', hidden: true, 'aria-hidden': 'true' });
    kids.push(this.playheadEl, this.snapEl);
    this.tlContent.replaceChildren(...kids);
    this.placePlayhead();
  }

  ruler(total, ppf) {
    const pps = this.pps;
    const steps = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
    const major = steps.find((s) => s * pps >= 64) ?? 600;
    const minor = major / 5;
    const ticks = [];
    const end = M.framesToSeconds(total, this.fps) + 2;
    for (let s = 0, i = 0; s <= end && i < 2000; s = ++i * minor) {
      const isMajor = i % 5 === 0;
      const x = PAD + s * pps;
      ticks.push(h('span', { class: `tick${isMajor ? ' major' : ''}`, vars: { '--x': `${x}px` } }, isMajor ? h('i', { text: M.timecode(M.secondsToFrames(s, this.fps), this.fps).replace(/\.\d+$/, '') }) : null));
    }
    void ppf;
    return h('div', { class: 'ed-ruler', 'data-zone': 'ruler' }, ticks);
  }

  lane(v, track, clips, kind) {
    const lane = h('div', { class: `ed-lane ${kind}`, 'data-track': track.id }, kind === 'main' ? null : h('span', { class: 'ed-lane-label', text: track.label }));
    for (const c of clips) {
      const sel = c.id === this.sel.clipId;
      const asset = M.assetOf(v, c.assetId);
      const el = h(
        'div',
        {
          class: `ed-clip${sel ? ' sel' : ''}${track.locked ? ' locked' : ''}`,
          'data-clip': c.id,
          role: 'button',
          tabindex: '0',
          'aria-pressed': sel ? 'true' : 'false',
          'aria-label': `${asset?.filename ?? 'Clip'} on ${track.label}, ${M.timecode(c.start, this.fps)} to ${M.timecode(M.clipEnd(c), this.fps)}${sel ? ', selected' : ''}`,
          vars: { '--x': `${this.xOf(c.start)}px`, '--cw': `${c.duration * this.ppf()}px` },
          onkeydown: (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), this.selectClip(c.id)),
        },
        kind === 'audio' || asset?.kind === 'audio' ? h('span', { class: 'ed-clip-name ellipsis', text: asset?.filename ?? '' }) : this.filmstrip(c, asset, kind === 'main' ? 52 : 32),
        sel && !track.locked ? [h('span', { class: 'ed-handle l', 'data-edge': 'start', 'aria-hidden': 'true' }), h('span', { class: 'ed-handle r', 'data-edge': 'end', 'aria-hidden': 'true' })] : null,
        sel ? h('span', { class: 'sr', text: 'selected' }) : null,
      );
      lane.append(el);
    }
    return lane;
  }

  /** Thumbnails along the clip: each one shows the source at that point in time. */
  filmstrip(c, asset, height) {
    const strip = asset ? this.strip(asset) : null;
    const w = Math.max(1, Math.round(c.duration * this.ppf()));
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const cv = h('canvas', { class: 'ed-strip', width: Math.min(4096, Math.round(w * dpr)), height: Math.round(height * dpr), 'aria-hidden': 'true' });
    if (!strip) return cv;
    const ctx = cv.getContext('2d');
    const tw0 = strip.img.naturalWidth / strip.count;
    const th0 = strip.img.naturalHeight;
    const tw = (height * tw0) / th0;
    const scale = cv.width / w;
    for (let x = 0; x < w; x += tw) {
      const f = c.sourceIn + (x + tw / 2) / this.ppf();
      const us = (f * this.fps.den * 1e6) / this.fps.num;
      const i = clamp(Math.floor(us / strip.stepUs), 0, strip.count - 1);
      ctx.drawImage(strip.img, i * tw0, 0, tw0, th0, x * scale, 0, tw * scale, height * dpr);
    }
    return cv;
  }

  captionLane(v, track) {
    const lane = h('div', { class: 'ed-lane captions', 'data-track': track.id }, h('span', { class: 'ed-lane-label', text: 'CC' }));
    for (const c of M.captionsOn(v, track.id)) {
      const sel = c.id === this.sel.captionId;
      lane.append(
        h(
          'div',
          {
            class: `ed-cap${sel ? ' sel' : ''}`,
            'data-caption': c.id,
            role: 'button',
            tabindex: '0',
            'aria-pressed': sel ? 'true' : 'false',
            'aria-label': `Caption “${c.text}”, ${M.timecode(c.start, this.fps)}${sel ? ', selected' : ''}`,
            vars: { '--x': `${this.xOf(c.start)}px`, '--cw': `${c.duration * this.ppf()}px` },
            onkeydown: (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), this.selectCaption(c.id)),
          },
          h('span', { class: 'ellipsis', text: this.textDrafts[c.id] ?? c.text }),
        ),
      );
    }
    return lane;
  }

  placePlayhead() {
    if (!this.playheadEl) return;
    this.playheadEl.style.setProperty('--x', `${this.xOf(this.playhead)}px`);
    this.playheadEl.firstChild.textContent = M.timecode(this.playhead, this.fps).replace(/\.\d+$/, '');
  }

  follow() {
    const x = this.xOf(this.playhead);
    const s = this.tlScroll;
    if (x < s.scrollLeft + 24 || x > s.scrollLeft + s.clientWidth - 24) s.scrollLeft = x - s.clientWidth * 0.35;
  }

  selectClip(id, { seek = false } = {}) {
    this.flushDrafts();
    this.sel.clipId = id;
    const c = M.clipById(this.view(), id);
    if (seek && c && (this.playhead < c.start || this.playhead >= M.clipEnd(c))) this.seek(c.start);
    this.persistState();
    this.refresh();
  }

  selectCaption(id, { seek = true } = {}) {
    this.flushDrafts();
    this.sel.captionId = id;
    const c = M.captionById(this.view(), id);
    if (seek && c) this.seek(c.start + Math.min(2, c.duration - 1));
    this.persistState();
    this.refresh();
  }

  bindTimelineGestures() {
    const el = this.tlScroll;
    const pts = new Map();
    let g = null; // { mode: 'seek'|'trim'|'pan'|'pinch'|'tap', ... }
    const contentX = (clientX) => clientX - el.getBoundingClientRect().left + el.scrollLeft;
    // A trim's auto-scroll loop ends with the trim, however it ends (lifted, pinched over, left the screen).
    const stopTrim = () => {
      if (g?.mode !== 'trim') return;
      cancelAnimationFrame(g.raf);
      g.stopped = true;
      this.root.classList.remove('trimming', 'trim-limit');
    };
    this.stopGestures = () => {
      stopTrim();
      g = null;
    };

    el.addEventListener('pointerdown', (e) => {
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pts.size === 2) {
        // Pinch takes over whatever the first finger started (a trim in progress is abandoned, not applied).
        const [a, b] = [...pts.values()];
        stopTrim();
        this.gesture = null;
        this.snapEl.hidden = true;
        g = { mode: 'pinch', dist: Math.abs(a.x - b.x) || 1, pps: this.pps, anchor: this.frameAt(contentX((a.x + b.x) / 2)), mid: (a.x + b.x) / 2 };
        return;
      }
      if (pts.size > 2) return;
      el.setPointerCapture?.(e.pointerId);
      const handle = e.target.closest('.ed-handle');
      const onRuler = e.target.closest('[data-zone="ruler"]');
      if (handle && this.editable()) {
        const clip = M.clipById(this.view(), handle.closest('[data-clip]').dataset.clip);
        g = { mode: 'trim', edge: handle.dataset.edge, clip, limits: this.trimLimits(clip, handle.dataset.edge), x0: e.clientX, id: e.pointerId };
        this.root.classList.add('trimming');
      } else if (onRuler) {
        g = { mode: 'seek', id: e.pointerId };
        this.scrubbing = true;
        this.seek(this.frameAt(contentX(e.clientX)));
      } else {
        g = { mode: 'tap', x0: e.clientX, y0: e.clientY, scroll0: el.scrollLeft, target: e.target, id: e.pointerId, t: performance.now(), v: 0, lastX: e.clientX, lastT: performance.now() };
      }
      e.preventDefault();
    });

    el.addEventListener('pointermove', (e) => {
      if (!pts.has(e.pointerId) || !g) return;
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (g.mode === 'pinch' && pts.size >= 2) {
        const [a, b] = [...pts.values()];
        this.pps = clamp((g.pps * Math.abs(a.x - b.x)) / g.dist, MIN_PPS, MAX_PPS);
        this.renderTimeline();
        // Keep the time under the fingers where it was.
        el.scrollLeft = this.xOf(g.anchor) - (g.mid - el.getBoundingClientRect().left);
        return;
      }
      if (e.pointerId !== g.id) return;
      if (g.mode === 'seek') return this.seek(this.frameAt(contentX(e.clientX)));
      if (g.mode === 'tap' || g.mode === 'pan') {
        const dx = e.clientX - g.x0;
        if (g.mode === 'tap' && Math.abs(dx) > 8) g.mode = 'pan';
        if (g.mode === 'pan') {
          el.scrollLeft = g.scroll0 - dx;
          const now = performance.now();
          g.v = (e.clientX - g.lastX) / Math.max(1, now - g.lastT);
          g.lastX = e.clientX;
          g.lastT = now;
        }
        return;
      }
      if (g.mode === 'trim') {
        g.clientX = e.clientX;
        this.trimTo(g, e.clientX);
        this.autoScroll(g);
      }
    });

    const up = (e) => {
      if (!pts.has(e.pointerId)) return;
      pts.delete(e.pointerId);
      if (!g) return;
      if (g.mode === 'pinch') {
        if (pts.size === 0) g = null;
        else g = { mode: 'none' };
        this.persistState();
        return;
      }
      if (e.pointerId !== g.id) return;
      if (g.mode === 'seek') this.scrubbing = false;
      if (g.mode === 'seek') this.drawSoon();
      if (g.mode === 'trim') {
        stopTrim();
        this.snapEl.hidden = true;
        const ghost = this.gesture;
        this.gesture = null;
        // One gesture, one edit, one undo step.
        if (ghost && e.type === 'pointerup') this.submit(ghost.ops, 'Trim clip');
        else this.refresh();
      }
      if (g.mode === 'tap' && e.type === 'pointerup') {
        const clipEl = g.target.closest?.('[data-clip]');
        const capEl = g.target.closest?.('[data-caption]');
        if (capEl) this.selectCaption(capEl.dataset.caption);
        else if (clipEl) this.selectClip(clipEl.dataset.clip);
        else this.seek(this.frameAt(contentX(e.clientX)));
      }
      if (g.mode === 'pan' && Math.abs(g.v) > 0.3 && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
        // A flick keeps going and slows down.
        let v = g.v * 16;
        const coast = () => {
          el.scrollLeft -= v;
          v *= 0.92;
          if (Math.abs(v) > 0.5) requestAnimationFrame(coast);
        };
        requestAnimationFrame(coast);
      }
      g = null;
    };
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener(
      'wheel',
      (e) => {
        if (!e.ctrlKey) return; // plain wheel / trackpad scrolls natively
        e.preventDefault();
        const anchor = this.frameAt(contentX(e.clientX));
        this.pps = clamp(this.pps * Math.exp(-e.deltaY / 200), MIN_PPS, MAX_PPS);
        this.renderTimeline();
        el.scrollLeft = this.xOf(anchor) - (e.clientX - el.getBoundingClientRect().left);
      },
      { passive: false },
    );
  }

  /** How far an edge can go: not past the neighbour, the source media, or a one-frame clip. */
  trimLimits(c, edge) {
    const v = this.view();
    const others = M.clipsOn(v, c.trackId).filter((x) => x.id !== c.id);
    const asset = M.assetOf(v, c.assetId);
    if (edge === 'start') {
      const prevEnd = Math.max(0, ...others.filter((x) => M.clipEnd(x) <= c.start).map(M.clipEnd));
      return { min: Math.max(prevEnd, c.start - c.sourceIn), max: M.clipEnd(c) - 1, why: c.start - c.sourceIn >= prevEnd ? 'source' : 'neighbour' };
    }
    const nextStart = Math.min(Infinity, ...others.filter((x) => x.start >= M.clipEnd(c)).map((x) => x.start));
    const srcEnd = asset?.durationFrames == null ? Infinity : c.start + (asset.durationFrames - c.sourceIn);
    return { min: c.start + 1, max: Math.min(nextStart, srcEnd, 24 * 3600 * 240), why: srcEnd <= nextStart ? 'source' : 'neighbour' };
  }

  trimTo(g, clientX) {
    const el = this.tlScroll;
    const x = clientX - el.getBoundingClientRect().left + el.scrollLeft;
    let frame = this.frameAt(x);
    // Snap to the playhead and to clip edges nearby (any track), with a visible line.
    const v = this.view();
    const targets = [this.playhead, 0, ...v.clips.filter((c) => c.id !== g.clip.id).flatMap((c) => [c.start, M.clipEnd(c)]), ...v.captions.flatMap((c) => [c.start, c.start + c.duration])];
    let snapped = null;
    for (const t of targets) if (Math.abs(this.xOf(t) - this.xOf(frame)) <= SNAP_PX && (snapped === null || Math.abs(t - frame) < Math.abs(snapped - frame))) snapped = t;
    if (snapped !== null) frame = snapped;
    const limited = frame < g.limits.min || frame > g.limits.max;
    frame = clamp(frame, g.limits.min, g.limits.max);
    this.snapEl.hidden = snapped === null || limited;
    if (snapped !== null && !limited) {
      this.snapEl.style.setProperty('--x', `${this.xOf(frame)}px`);
      if (g.lastSnap !== snapped) navigator.vibrate?.(4);
    }
    g.lastSnap = snapped;
    this.root.classList.toggle('trim-limit', limited);
    this.gesture = { ops: [{ type: 'clip.trim', clipId: g.clip.id, edge: g.edge, frame }], label: 'Trim clip' };
    this.renderTimeline();
    this.drawSoon();
    this.panelSoon();
    if (limited && !g.toldLimit) {
      g.toldLimit = true;
      this.statusEl.setAttribute('aria-label', g.limits.why === 'source' ? 'The source media ends here' : 'The next clip starts here');
    }
  }

  /** Near an edge while trimming: scroll that way, keep trimming under the finger. */
  autoScroll(g) {
    cancelAnimationFrame(g.raf);
    const el = this.tlScroll;
    const r = el.getBoundingClientRect();
    const edge = 36;
    const dir = g.clientX < r.left + edge ? -1 : g.clientX > r.right - edge ? 1 : 0;
    if (!dir) return;
    const step = () => {
      if (g.stopped || this.disposed) return;
      el.scrollLeft += dir * 8;
      this.trimTo(g, g.clientX);
      g.raf = requestAnimationFrame(step);
    };
    g.raf = requestAnimationFrame(step);
  }

  // ── panels ────────────────────────────────────────────────────────────────
  panelSoon() {
    if (this.panelQueued) return;
    this.panelQueued = true;
    requestAnimationFrame(() => {
      this.panelQueued = false;
      this.renderPanel();
    });
  }

  renderPanel() {
    if (this.disposed) return;
    // Never rebuild under a finger typing.
    if (this.panel.contains(document.activeElement) && document.activeElement.matches('input, textarea, select')) return this.updatePanelValues?.();
    const v = this.view();
    const key = `${this.sig()}|${this.tool}|${this.phase}|${this.live}|${this.sel.clipId}|${this.sel.captionId}|${this.playhead}|${this.ending}`;
    if (key === this.panelKey) return;
    this.panelKey = key;
    let body;
    if (!v) body = [h('p', { class: 'muted', text: this.phase === 'failed' ? this.failText : 'Loading the timeline from your Mac…' })];
    else if (this.tool === 'clip') body = this.clipPanel(v);
    else if (this.tool === 'frame') body = this.framePanel(v);
    else if (this.tool === 'captions') body = this.captionsPanel(v);
    else if (this.tool === 'audio') body = this.audioPanel(v);
    else body = this.stylePanel(v);
    this.updatePanelValues = null;
    this.panel.replaceChildren(...[body].flat(Infinity).filter(Boolean));
    // A new tool or a new selection starts at the top of its panel.
    const place = `${this.tool}|${this.tool === 'captions' ? this.sel.captionId : this.sel.clipId}`;
    if (place !== this.panelPlace) this.panel.scrollTop = 0;
    this.panelPlace = place;
  }

  selectedClip(v) {
    return M.clipById(v, this.sel.clipId);
  }

  clipPanel(v) {
    const c = this.selectedClip(v);
    if (!c) return [h('h2', { class: 'ed-h', text: 'Trim clip' }), h('p', { class: 'muted', text: 'Tap a clip in the timeline to select it.' })];
    const fps = this.fps;
    const track = M.trackOf(v, c.trackId);
    const lim = { start: this.trimLimits(c, 'start'), end: this.trimLimits(c, 'end') };
    const siblings = M.clipsOn(v, c.trackId);
    const canSplit = this.playhead > c.start && this.playhead < M.clipEnd(c);
    const trim = (edge, frame) => {
      const l = lim[edge];
      const f = clamp(frame, l.min, l.max);
      if (f !== frame) host.toast(edge === 'start' ? (l.why === 'source' ? 'That’s the start of the source media.' : 'The previous clip ends there.') : l.why === 'source' ? 'That’s the end of the source media.' : 'The next clip starts there.');
      this.draft(`trim:${c.id}:${edge}`, [{ type: 'clip.trim', clipId: c.id, edge, frame: f }], 'Trim clip');
    };
    const locked = track?.locked;
    return [
      h('div', { class: 'ed-head' }, h('h2', { class: 'ed-h', text: 'Trim clip' }), h('span', { class: 'ed-meta tabular', text: `Duration: ${M.timecode(c.duration, fps)}` })),

      h(
        'div',
        { class: 'ed-grid2' },
        stepper({ label: 'Start', value: M.timecode(c.start, fps), disabled: locked || !this.editable(), onStep: (d) => trim('start', c.start + d), onCommit: (t) => commitTime(t, fps, (f) => trim('start', f)) }),
        stepper({ label: 'End', value: M.timecode(M.clipEnd(c), fps), disabled: locked || !this.editable(), onStep: (d) => trim('end', M.clipEnd(c) + d), onCommit: (t) => commitTime(t, fps, (f) => trim('end', f)) }),
      ),
      h('p', { class: 'ed-hint tabular', text: `Timeline in/out · source ${M.timecode(c.sourceIn, fps)}–${M.timecode(c.sourceIn + c.duration, fps)} · no ripple: trimming leaves a gap` }),
      h(
        'div',
        { class: 'ed-grid2' },
        button('Split', { iconName: 'scissors', disabled: !canSplit || locked || !this.editable(), aria: canSplit ? `Split at ${M.timecode(this.playhead, fps)}` : 'Split: move the playhead inside the clip first', onclick: () => this.submit([{ type: 'clip.split', clipId: c.id, frame: this.playhead, newClipId: uuid() }], 'Split clip') }),
        button('Delete', { iconName: 'trash', disabled: locked || !this.editable(), onclick: () => this.deleteSheet(c) }),
      ),
      !canSplit ? h('p', { class: 'ed-hint', text: 'Split needs the playhead inside the selected clip.' }) : null,
      siblings.length > 1 ? button('Reorder clips', { iconName: 'list', full: true, small: true, disabled: locked || !this.editable(), onclick: () => this.reorderSheet(v, c.trackId) }) : null,
      locked ? h('p', { class: 'ed-hint warn', text: `${track.label} is locked on the Mac.` }) : null,
    ];
  }

  deleteSheet(c) {
    const v = this.view();
    const track = M.trackOf(v, c.trackId);
    const later = M.clipsOn(v, c.trackId).filter((x) => x.start >= M.clipEnd(c)).length;
    sheet(
      'Delete clip',
      h(
        'div',
        { class: 'stack' },
        button('Delete, leave the gap', { full: true, iconName: 'trash', onclick: () => (closeSheet(), this.submit([{ type: 'clip.delete', clipIds: [c.id] }], 'Delete clip')) }),
        button('Delete and close the gap (ripple)', { full: true, iconName: 'ripple', disabled: !later, onclick: () => (closeSheet(), this.submit([{ type: 'clip.delete', clipIds: [c.id], ripple: true }], 'Ripple delete')) }),
        h('p', { class: 'muted small', text: later ? `Ripple moves the ${later} later clip${later === 1 ? '' : 's'} on ${track.label} left. Other tracks (captions, music) don’t move. Undo brings it back.` : 'Nothing comes after this clip, so there’s no gap to close. Undo brings it back.' }),
      ),
    );
  }

  reorderSheet(v, trackId) {
    const track = M.trackOf(v, trackId);
    let order = M.clipsOn(v, trackId).map((c) => c.id);
    const ok = M.contiguous(v, trackId);
    const list = h('ol', { class: 'ed-reorder' });
    const draw = () => {
      list.replaceChildren(
        ...order.map((id, i) => {
          const c = M.clipById(v, id);
          const a = M.assetOf(v, c.assetId);
          return h(
            'li',
            {},
            icon('grip', { size: 18 }),
            h('span', { class: 'grow ellipsis', text: `${i + 1}. ${a?.filename ?? 'Clip'} · ${M.timecode(c.duration, this.fps)}` }),
            iconButton('arrowUp', `Move ${a?.filename ?? 'clip'} up`, () => (i > 0 ? (([order[i - 1], order[i]] = [order[i], order[i - 1]]), draw()) : null), { disabled: i === 0 }),
            iconButton('arrowDown', `Move ${a?.filename ?? 'clip'} down`, () => (i < order.length - 1 ? (([order[i + 1], order[i]] = [order[i], order[i + 1]]), draw()) : null), { disabled: i === order.length - 1 }),
          );
        }),
      );
    };
    draw();
    sheet(
      `Reorder ${track.label}`,
      h(
        'div',
        { class: 'stack' },
        ok ? h('p', { class: 'muted small', text: 'Clips play back to back in this order. Captions and music stay where they are.' }) : h('p', { class: 'ed-hint warn', text: `The clips on ${track.label} have gaps between them; reordering would close them. It packs them back to back from the first clip.` }),
        list,
        button('Apply order', {
          kind: 'mint',
          full: true,
          onclick: () => {
            closeSheet();
            const same = order.every((id, i) => id === M.clipsOn(this.view(), trackId)[i]?.id);
            if (!same) this.submit(M.reorderOps(this.view(), trackId, order), 'Reorder clips');
          },
        }),
      ),
    );
  }

  framePanel(v) {
    const c = this.selectedClip(v);
    if (!c) return [h('h2', { class: 'ed-h', text: 'Framing' }), h('p', { class: 'muted', text: 'Select a clip to frame it.' })];
    const a = M.assetOf(v, c.assetId);
    if (a?.kind === 'audio') return [h('h2', { class: 'ed-h', text: 'Framing' }), h('p', { class: 'muted', text: 'Audio clips have no picture.' })];
    const p = c.props;
    const off = !this.editable() || M.trackOf(v, c.trackId)?.locked;
    const set = (patch, label = 'Framing', key = 'frame') => this.draft(`${key}:${c.id}`, [{ type: 'clip.update', clipId: c.id, props: patch }], label);
    const animated = p.scaleEnd !== null || p.xEnd !== null || p.yEnd !== null;
    // The slider covers the usual range, widened to include a value set on the Mac, so touching it never jumps.
    const scalePct = Math.round(p.scale * 100);
    const scaleIn = h('input', { class: 'ed-range', type: 'range', min: Math.min(25, scalePct), max: Math.max(400, scalePct), step: 1, value: scalePct, 'aria-label': 'Scale, percent', disabled: off || null });
    scaleIn.addEventListener('input', () => set({ scale: Number(scaleIn.value) / 100 }));
    const pct = (x) => `${x > 0 ? '+' : ''}${Math.round(x * 100)}`;
    return [
      h('div', { class: 'ed-head' }, h('h2', { class: 'ed-h', text: 'Framing' }), h('span', { class: 'ed-meta', text: 'Drag to move · Pinch to scale' })),
      h(
        'div',
        { class: 'ed-seg', role: 'radiogroup', 'aria-label': 'Fit or fill' },
        [['contain', 'Fit'], ['cover', 'Fill']].map(([id, label]) => h('button', { class: `ed-seg-btn${p.fit === id ? ' on' : ''}`, type: 'button', role: 'radio', 'aria-checked': p.fit === id ? 'true' : 'false', disabled: off || null, onclick: () => this.submit([{ type: 'clip.update', clipId: c.id, props: { fit: id } }], label === 'Fit' ? 'Fit to frame' : 'Fill frame') }, label)),
      ),
      h('div', { class: 'ed-row' }, h('span', { class: 'ed-label', text: 'Scale' }), scaleIn, numberField({ value: scalePct, suffix: '%', label: 'Scale percent', min: M.LIMITS.scale[0] * 100, max: M.LIMITS.scale[1] * 100, disabled: off, onCommit: (n) => set({ scale: n / 100 }) })),
      h(
        'div',
        { class: 'ed-row wrap' },
        h('span', { class: 'ed-label', text: 'X' }),
        stepper({ label: 'Position X, percent of the frame width', compact: true, value: pct(p.x), disabled: off, onStep: (d) => set({ x: round2(clamp(p.x + d / 100, -2, 2)) }), onCommit: (t) => numberCommit(t, (n) => set({ x: round2(clamp(n / 100, -2, 2)) })) }),
        h('span', { class: 'ed-label', text: 'Y' }),
        stepper({ label: 'Position Y, percent of the frame height', compact: true, value: pct(p.y), disabled: off, onStep: (d) => set({ y: round2(clamp(p.y + d / 100, -2, 2)) }), onCommit: (t) => numberCommit(t, (n) => set({ y: round2(clamp(n / 100, -2, 2)) })) }),
        button('Reset', { small: true, iconName: 'reset', disabled: off, onclick: () => this.submit([{ type: 'clip.update', clipId: c.id, props: { fit: 'cover', scale: 1, x: 0, y: 0, cropLeft: 0, cropTop: 0, cropRight: 0, cropBottom: 0 } }], 'Reset framing') }),
      ),
      h('p', { class: 'ed-hint', text: 'X / Y: % of the frame, identical on every screen and in the export. Reset changes framing only.' }),
      animated
        ? h(
            'div',
            { class: 'ed-callout' },
            h('p', { text: `This clip has a zoom/pan animation (${Math.round(p.scale * 100)}% → ${Math.round((p.scaleEnd ?? p.scale) * 100)}%). Scale, X and Y set where it starts; the animation still runs to its end values.` }),
            button('Use static framing', { small: true, disabled: off, onclick: () => this.submit([{ type: 'clip.update', clipId: c.id, props: { scaleEnd: null, xEnd: null, yEnd: null } }], 'Static framing') }),
          )
        : null,
      c.aiEffects ? h('p', { class: 'ed-hint', text: `${c.aiEffects} AI effect${c.aiEffects === 1 ? '' : 's'} on this clip show in the rendered preview, not the live one.` }) : null,
    ];
  }

  captionsPanel(v) {
    const caps = [...v.captions].sort(M.byStart);
    if (!caps.length) return [h('h2', { class: 'ed-h', text: 'Edit caption' }), h('p', { class: 'muted', text: 'This project has no captions. Generate them on the Mac (Captions), then fix them here.' })];
    const c = M.captionById(v, this.sel.captionId) ?? caps[0];
    const i = caps.findIndex((x) => x.id === c.id);
    const track = M.trackOf(v, c.trackId);
    const style = track.captionStyle;
    const fps = this.fps;
    const off = !this.editable() || track.locked;
    const total = M.durationFrames(v);
    const onTrack = M.captionsOn(v, c.trackId);
    const k = onTrack.findIndex((x) => x.id === c.id);
    const prevEnd = k > 0 ? onTrack[k - 1].start + onTrack[k - 1].duration : 0;
    const nextStart = k < onTrack.length - 1 ? onTrack[k + 1].start : Math.max(total, c.start + c.duration);
    const timing = (start, end) => {
      const s = clamp(start, prevEnd, c.start + c.duration - 1);
      const e2 = clamp(end, s + 1, nextStart);
      if (s !== start || e2 !== end) host.toast('Captions can’t overlap; it stops at the neighbouring caption.');
      this.draft(`captime:${c.id}`, [{ type: 'caption.update', captionId: c.id, start: s, duration: e2 - s }], 'Caption timing');
    };
    const area = h('textarea', { class: 'ed-text', rows: 2, maxlength: M.LIMITS.captionText, 'aria-label': 'Caption text', enterkeyhint: 'done', disabled: off || null });
    area.value = this.textDrafts[c.id] ?? c.text;
    area.addEventListener('input', () => {
      this.textDrafts[c.id] = area.value;
      this.saveSoon();
      this.drawSoon();
      this.refreshStatus();
      clearTimeout(this.textTimer);
      this.textTimer = setTimeout(() => this.commitText(c.id, area.value), TEXT_MS);
    });
    area.addEventListener('blur', () => this.commitText(c.id, area.value));
    const styleNow = (patch, label) => this.submit([{ type: 'track.update', trackId: track.id, captionStyle: patch }], label);
    const preset = Object.entries(M.CAPTION_PRESETS).find(([, s]) => s.font === style.font && s.stroke === style.stroke && (s.box ?? null) === (style.box ?? null))?.[0] ?? null;
    const base = preset ? M.CAPTION_PRESETS[preset].size : style.size;
    const sizes = [['S', 0.85], ['M', 1], ['L', 1.2]];
    const pos = M.positionOf(style.y);
    const posSel = h('select', { class: 'ed-select', 'aria-label': 'Caption position', disabled: off || null }, M.CAPTION_POSITIONS.map((p) => h('option', { value: p.id, selected: p.id === pos.id || null, text: p.label })));
    posSel.addEventListener('change', () => styleNow({ y: M.CAPTION_POSITIONS.find((p) => p.id === posSel.value).y }, 'Caption position'));
    this.updatePanelValues = () => {
      if (document.activeElement !== area && area.value !== (this.textDrafts[c.id] ?? c.text)) area.value = this.textDrafts[c.id] ?? c.text;
    };
    return [
      h(
        'div',
        { class: 'ed-head' },
        h('h2', { class: 'ed-h', text: 'Edit caption' }),
        h('span', { class: 'ed-meta tabular', text: `${M.timecode(c.start, fps)} – ${M.timecode(c.start + c.duration, fps)}` }),
      ),
      h(
        'div',
        { class: 'ed-row' },
        iconButton('chevronLeft', 'Previous caption', () => this.selectCaption(caps[i - 1].id), { disabled: i === 0, cls: 'ed-ic boxed' }),
        h('button', { class: 'ed-capnav grow', type: 'button', onclick: () => this.captionList(v) }, icon('list', { size: 16 }), h('span', { text: `Caption ${i + 1} of ${caps.length}` })),
        iconButton('chevronRight', 'Next caption', () => this.selectCaption(caps[i + 1].id), { disabled: i === caps.length - 1, cls: 'ed-ic boxed' }),
      ),
      h('div', { class: 'ed-textwrap' }, area, h('button', { class: 'ed-textdone', type: 'button', onclick: () => (area.blur(), this.commitText(c.id, area.value)) }, 'Done')),
      h('div', { class: 'ed-subhead' }, h('span', { text: 'Style' }), h('span', { class: 'ed-scope', text: `All captions on ${track.label}` })),
      h(
        'div',
        { class: 'ed-seg three', role: 'radiogroup', 'aria-label': 'Caption style preset' },
        [['clean', 'Clean'], ['bold', 'Bold'], ['boxed', 'Boxed']].map(([id, label]) =>
          h('button', { class: `ed-seg-btn${preset === id ? ' on' : ''} p-${id}`, type: 'button', role: 'radio', 'aria-checked': preset === id ? 'true' : 'false', disabled: off || null, onclick: () => styleNow({ ...M.CAPTION_PRESETS[id], y: style.y }, `${label} captions`) }, label),
        ),
      ),
      h(
        'div',
        { class: 'ed-row' },
        h('span', { class: 'ed-label', text: 'Highlight' }),
        h('button', { class: `ed-toggle${style.highlight ? ' on' : ''}`, type: 'button', role: 'switch', 'aria-checked': style.highlight ? 'true' : 'false', 'aria-label': 'Highlight the word being spoken', disabled: off || null, onclick: () => styleNow({ highlight: style.highlight ? null : (M.CAPTION_PRESETS[preset ?? 'bold'].highlight ?? '#ffd84a') }, style.highlight ? 'Highlight off' : 'Highlight on') }, h('span')),
        h('span', { class: 'ed-label', text: 'Size' }),
        h('div', { class: 'ed-seg small', role: 'radiogroup', 'aria-label': 'Caption size' }, sizes.map(([label, k]) => {
          const on = Math.abs(style.size - base * k) < 0.0015;
          return h('button', { class: `ed-seg-btn${on ? ' on' : ''}`, type: 'button', role: 'radio', 'aria-checked': on ? 'true' : 'false', 'aria-label': `Size ${label}`, disabled: off || null, onclick: () => styleNow({ size: round4(clamp(base * k, 0.015, 0.2)) }, 'Caption size') }, label);
        })),
      ),
      h('div', { class: 'ed-row' }, h('span', { class: 'ed-label', text: 'Positioning' }), posSel),
      h('div', { class: 'ed-subhead' }, h('span', { text: 'Timing' }), h('span', { class: 'ed-scope', text: 'This caption · frame steps' })),
      h(
        'div',
        { class: 'ed-grid2' },
        stepper({ label: 'Start', value: M.timecode(c.start, fps), disabled: off, onStep: (d) => timing(c.start + d, c.start + c.duration), onCommit: (t) => commitTime(t, fps, (f) => timing(f, c.start + c.duration)) }),
        stepper({ label: 'End', value: M.timecode(c.start + c.duration, fps), disabled: off, onStep: (d) => timing(c.start, c.start + c.duration + d), onCommit: (t) => commitTime(t, fps, (f) => timing(c.start, f)) }),
      ),
      h('p', { class: 'ed-hint', text: 'Text and timing change this caption only; it stops at its neighbours (no overlaps). The Mac styles captions per track, so style, size and position change all of them. Lines wrap to the caption width; positions stay inside the safe area.' }),
    ];
  }

  commitText(captionId, text) {
    clearTimeout(this.textTimer);
    const c = M.captionById(this.view(), captionId);
    if (this.textDrafts[captionId] === undefined) return;
    delete this.textDrafts[captionId];
    const t = String(text ?? '').trim();
    if (!c || t === c.text) return this.persistState(), this.refreshStatus();
    if (!t) {
      host.toast('A caption needs some text; it was left as it was.', 'error');
      return this.refresh();
    }
    this.submit([{ type: 'caption.update', captionId, text: t.slice(0, M.LIMITS.captionText) }], 'Caption text');
  }

  captionList(v) {
    const caps = [...v.captions].sort(M.byStart);
    sheet(
      `Captions · ${caps.length}`,
      h(
        'div',
        { class: 'list' },
        caps.map((c) =>
          h(
            'button',
            { class: `option${c.id === this.sel.captionId ? ' on' : ''}`, type: 'button', onclick: () => (closeSheet(), this.selectCaption(c.id)) },
            h('span', { class: 'ed-cap-time tabular', text: M.timecode(c.start, this.fps) }),
            h('span', { class: 'grow', text: this.textDrafts[c.id] ?? c.text }),
          ),
        ),
      ),
    );
  }

  audioPanel(v) {
    const c = this.selectedClip(v);
    const a = c ? M.assetOf(v, c.assetId) : null;
    const track = c ? M.trackOf(v, c.trackId) : null;
    const off = !this.editable();
    const fps = this.fps;
    const out = [h('h2', { class: 'ed-h', text: 'Audio' })];
    if (c && a?.hasAudio) {
      const p = c.props;
      const gain = h('input', { class: 'ed-range', type: 'range', min: gainMin(p.gainDb), max: M.LIMITS.gainDb[1], step: 0.5, value: p.gainDb, 'aria-label': 'Clip volume in decibels', disabled: off || track.locked || null });
      gain.addEventListener('input', () => this.draft(`gain:${c.id}`, [{ type: 'clip.update', clipId: c.id, props: { gainDb: Number(gain.value) } }], 'Clip volume'));
      const fade = (key, label) =>
        stepper({
          label,
          value: `${M.framesToSeconds(p[key], fps).toFixed(1)} s`,
          disabled: off || track.locked,
          onStep: (d) => this.draft(`${key}:${c.id}`, [{ type: 'clip.update', clipId: c.id, props: { [key]: clamp(p[key] + d * Math.round(M.fpsValue(fps) / 10), 0, c.duration) } }], label),
          onCommit: (t) => numberCommit(t, (n) => this.draft(`${key}:${c.id}`, [{ type: 'clip.update', clipId: c.id, props: { [key]: clamp(M.secondsToFrames(n, fps), 0, c.duration) } }], label)),
        });
      out.push(
        h('p', { class: 'ed-target', text: `Selected clip · ${a.filename} (${track.label})` }),
        h('div', { class: 'ed-row' }, h('span', { class: 'ed-label', text: 'Volume' }), gain, h('span', { class: 'ed-val tabular', text: `${p.gainDb > 0 ? '+' : ''}${p.gainDb} dB` })),
        h('div', { class: 'ed-grid2' }, fade('fadeIn', 'Fade in'), fade('fadeOut', 'Fade out')),
        h('div', { class: 'ed-row' }, h('span', { class: 'ed-label grow', text: `Mute ${track.label}` }), toggle(track.muted, `Mute all sound on ${track.label}`, off || track.locked, () => this.submit([{ type: 'track.update', trackId: track.id, muted: !track.muted }], track.muted ? `Unmute ${track.label}` : `Mute ${track.label}`))),
        h('p', { class: 'ed-hint', text: `Mute is per track: it silences every clip on ${track.label}. Volume and fades are this clip’s.` }),
      );
    } else out.push(h('p', { class: 'muted', text: c ? 'The selected clip has no sound.' : 'Select a clip to change its sound.' }));
    const music = M.audioTracks(v).filter((t) => M.clipsOn(v, t.id).length);
    if (music.length) {
      out.push(h('div', { class: 'ed-subhead' }, h('span', { text: 'Music & other audio' })));
      for (const t of music) {
        const clips = M.clipsOn(v, t.id);
        const g = clips[0].props.gainDb;
        const same = clips.every((x) => x.props.gainDb === g);
        const r = h('input', { class: 'ed-range', type: 'range', min: gainMin(g), max: M.LIMITS.gainDb[1], step: 0.5, value: g, 'aria-label': `${t.label} volume in decibels`, disabled: off || t.locked || null });
        r.addEventListener('input', () => this.draft(`trackgain:${t.id}`, clips.map((x) => ({ type: 'clip.update', clipId: x.id, props: { gainDb: Number(r.value) } })), `${t.label} volume`));
        out.push(
          h('div', { class: 'ed-row' }, h('span', { class: 'ed-label', text: t.label }), r, h('span', { class: 'ed-val tabular', text: `${same ? `${g > 0 ? '+' : ''}${g}` : 'mixed'} dB` }), toggle(t.muted, `Mute ${t.label}`, off || t.locked, () => this.submit([{ type: 'track.update', trackId: t.id, muted: !t.muted }], t.muted ? `Unmute ${t.label}` : `Mute ${t.label}`))),
        );
      }
      out.push(h('p', { class: 'ed-hint', text: 'A track’s volume sets every clip on it. There’s no automatic ducking: these are the levels as they will export.' }));
    }
    out.push(h('p', { class: 'ed-hint', text: 'You hear new levels in the rendered preview once it updates.' }));
    return out;
  }

  stylePanel(v) {
    const c = this.selectedClip(v);
    const a = c ? M.assetOf(v, c.assetId) : null;
    if (!c || a?.kind === 'audio') return [h('h2', { class: 'ed-h', text: 'Look' }), h('p', { class: 'muted', text: 'Select a video or image clip.' })];
    const off = !this.editable() || M.trackOf(v, c.trackId)?.locked;
    const rows = LOOKS.map(([key, label, hint, live]) => {
      const r = h('input', { class: 'ed-range', type: 'range', min: 0, max: 100, step: 1, value: Math.round(c.props[key] * 100), 'aria-label': `${label}, percent`, disabled: off || null });
      r.addEventListener('input', () => this.draft(`look:${c.id}:${key}`, [{ type: 'clip.update', clipId: c.id, props: { [key]: Number(r.value) / 100 } }], label));
      return h('div', { class: 'ed-row' }, h('span', { class: 'ed-label wide', text: label, title: hint }), r, h('span', { class: 'ed-val tabular', text: `${Math.round(c.props[key] * 100)}%${live ? '' : ' ≈'}` }));
    });
    return [
      h('div', { class: 'ed-head' }, h('h2', { class: 'ed-h', text: 'Look' }), button('Reset', { small: true, iconName: 'reset', disabled: off, onclick: () => this.submit([{ type: 'clip.update', clipId: c.id, props: Object.fromEntries(LOOKS.map(([k]) => [k, 0])) }], 'Reset look') })),
      rows,
      h('p', { class: 'ed-hint', text: '≈ Sharpen and grain show only in the rendered preview and the export.' }),
      h('div', { class: 'ed-subhead' }, h('span', { text: 'Exposure, contrast, saturation' })),
      h('p', { class: 'ed-hint', text: 'Not available yet: the export engine has no exposure, contrast or saturation control, so the phone doesn’t offer sliders that wouldn’t change the video.' }),
    ];
  }
}

// ── controls ────────────────────────────────────────────────────────────────
/** ‹ value › with a typeable value; taps are steps of one (frame, percent, …). */
function stepper({ label, value, onStep, onCommit, disabled, compact = false }) {
  const input = h('input', { class: 'ed-num tabular', type: 'text', inputmode: 'decimal', value, 'aria-label': label, enterkeyhint: 'done', disabled: disabled || null, spellcheck: 'false', autocomplete: 'off' });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') input.blur();
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      onStep(e.key === 'ArrowUp' ? 1 : -1);
    }
  });
  input.addEventListener('change', () => onCommit(input.value));
  return h(
    'div',
    { class: `ed-stepper${compact ? ' compact' : ''}` },
    compact ? null : h('span', { class: 'ed-step-label', text: label }),
    h('div', { class: 'ed-step-row' }, iconButton('chevronLeft', `${label}: one less`, () => onStep(-1), { disabled, cls: 'ed-step-btn' }), input, iconButton('chevronRight', `${label}: one more`, () => onStep(1), { disabled, cls: 'ed-step-btn' })),
  );
}

function numberField({ value, suffix, label, min, max, onCommit, disabled }) {
  const input = h('input', { class: 'ed-num small tabular', type: 'text', inputmode: 'decimal', value: String(value), 'aria-label': label, disabled: disabled || null });
  input.addEventListener('keydown', (e) => e.key === 'Enter' && input.blur());
  input.addEventListener('change', () => numberCommit(input.value, (n) => onCommit(clamp(n, min, max))));
  return h('span', { class: 'ed-numwrap' }, input, h('span', { class: 'muted', text: suffix }));
}

function toggle(on, label, disabled, onclick) {
  return h('button', { class: `ed-toggle${on ? ' on' : ''}`, type: 'button', role: 'switch', 'aria-checked': on ? 'true' : 'false', 'aria-label': label, disabled: disabled || null, onclick }, h('span'));
}

function commitTime(text, fps, fn) {
  const f = M.parseTimecode(text, fps);
  if (f === null) return ed?.refresh();
  fn(f);
}
function numberCommit(text, fn) {
  const n = Number(String(text).replace(',', '.').replace(/[^\d.+-]/g, ''));
  if (!Number.isFinite(n)) return ed?.refresh();
  fn(n);
}
const round4 = (x) => Math.round(x * 10000) / 10000;

function cssColor(hex) {
  if (hex.length === 9) {
    const a = parseInt(hex.slice(7, 9), 16) / 255;
    return `rgba(${parseInt(hex.slice(1, 3), 16)},${parseInt(hex.slice(3, 5), 16)},${parseInt(hex.slice(5, 7), 16)},${a.toFixed(3)})`;
  }
  return hex;
}

/** unitsPerEm (head), ascender and descender (hhea): what opentype.js reads for the export's layout. */
function ttfMetrics(buf) {
  const dv = new DataView(buf);
  const n = dv.getUint16(4);
  const tables = {};
  for (let i = 0; i < n; i++) {
    const o = 12 + i * 16;
    tables[String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3))] = dv.getUint32(o + 8);
  }
  return { unitsPerEm: dv.getUint16(tables.head + 18), ascender: dv.getInt16(tables.hhea + 4), descender: dv.getInt16(tables.hhea + 6) };
}
