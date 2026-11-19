// Manual editing from the phone. The phone edits the same timeline the desktop edits, through the same
// operations (TimelineStore.apply → the shared reducer in core/timeline-ops.ts), so a trim on the phone is
// exactly a trim on the Mac: same validation, same revision bump, same undo record.
//
// What this adds on top:
//   lease        one phone at a time edits a project ("edit session"): device, project, base revision,
//                session id, expiry. Kept alive by a heartbeat; it lapses on its own if the phone goes away,
//                so a closed browser never leaves the project locked.
//   idempotency  every edit carries a command id, recorded with the revision it made; a retry after a lost
//                answer finds it and returns the same result instead of applying it twice (survives restarts:
//                it's read back from edit_operations).
//   ordering     each edit names the revision it was made against; anything else (the desktop edited in
//                between) is a REVISION_CONFLICT, never a silent overwrite.
//   undo scope   the phone's undo/redo only steps through what this session did, on the phone that did it
//                (a session id is bound to its device: another phone can't adopt it to reach those steps).

import { randomUUID } from "node:crypto";
import {
  ProjectStore,
  ReelForgeError,
  resolveCaptionStyle,
  resolveClipProps,
  TimelineStore,
  trackLabels,
  type Database,
  type TimelineOp,
} from "@reelforge/core";

/** Recorded in each edit's payload so the phone's edits can be told apart (and grouped by session). */
export const EDIT_CHANNEL = "phone-remote:edit";
export const LEASE_MS = 45_000;
const ACTOR = "api" as const;
const MAX_CAPTIONS = 3000;
const MAX_OPS = 200;
const LABEL = /^[\p{L}\p{N} .,:·'’()/+-]{1,60}$/u;

/** An edit-session failure the phone acts on (EDIT_LOCKED → who holds it, LEASE_LOST → begin again, …). */
export class EditError extends Error {
  readonly code: string;
  readonly details: Record<string, unknown>;
  constructor(code: "EDIT_LOCKED" | "AGENT_BUSY" | "LEASE_LOST" | "LEASE_EXPIRED", message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

export interface EditLease {
  sessionId: string;
  deviceId: string;
  deviceName: string;
  projectId: string;
  /** The revision the session started from. */
  baseRevision: number;
  startedAt: string;
  expiresAt: number;
}

export interface ManualEditSummary {
  sessionId: string;
  deviceName: string | null;
  /** Revision before the session's first edit, and the revision it left the timeline at. */
  fromRevision: number;
  toRevision: number;
  /** What was done, in order (undone steps are left out). */
  steps: string[];
  undone: number;
  startedAt: string;
  endedAt: string;
  /** Still being edited. */
  open: boolean;
}

interface OpRow {
  id: string;
  revision: number;
  kind: string;
  payload: string;
  state: string;
  created_at: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Who did an edit: the session and the phone, as recorded in its payload. */
export interface EditActor {
  sessionId: string;
  deviceId: string;
}

export class EditSessions {
  readonly #db: Database;
  readonly #now: () => number;
  readonly #leases = new Map<string, EditLease>();
  readonly #expiry = new Map<string, ReturnType<typeof setTimeout>>();
  readonly #onExpire: (projectId: string) => void;

  /** `onExpire` runs when a lease lapses by itself (the phone went quiet), so other phones hear it's free. */
  constructor(db: Database, opts: { now?: () => number; onExpire?: (projectId: string) => void } = {}) {
    this.#db = db;
    this.#now = opts.now ?? Date.now;
    this.#onExpire = opts.onExpire ?? (() => {});
  }

  /** The live lease on a project, if any (lapsed ones are dropped here). */
  lease(projectId: string): EditLease | null {
    const l = this.#leases.get(projectId);
    if (l && l.expiresAt <= this.#now()) {
      this.#drop(projectId);
      return null;
    }
    return l ?? null;
  }

  /** Stops the expiry timers (engine shutdown). */
  close(): void {
    for (const t of this.#expiry.values()) clearTimeout(t);
    this.#expiry.clear();
  }

  /** Every live lease (the snapshot shows other phones who is editing what). */
  leases(): EditLease[] {
    return [...this.#leases.keys()].map((id) => this.lease(id)).filter((l): l is EditLease => !!l);
  }

  /**
   * Starts (or resumes) editing. Another phone's live lease is never taken over; the same phone may
   * resume its own session (reconnect) or replace it (opened again). `agentBusy` is the caller's: an AI
   * request running on this project must be stopped or finished first.
   */
  begin(input: { projectId: string; sessionId: unknown; deviceId: string; deviceName: string; agentBusy: boolean }): { lease: EditLease; resumed: boolean } {
    const sessionId = idOf(input.sessionId, "session");
    const project = new ProjectStore(this.#db).get(input.projectId);
    // A session id another phone already edited with is never adopted (it would reach that phone's undo steps).
    const owner = this.#sessionDevice(project.id, sessionId);
    if (owner !== null && owner !== input.deviceId) throw new ReelForgeError("VALIDATION_ERROR", "That editing session belongs to another phone. Start a new one.");
    const held = this.lease(project.id);
    if (held && held.deviceId !== input.deviceId) {
      throw new EditError("EDIT_LOCKED", `${held.deviceName} is editing this project. It frees up when they tap Done, or ${Math.ceil((held.expiresAt - this.#now()) / 1000)} s after that phone goes quiet.`, {
        deviceName: held.deviceName,
        expiresAt: new Date(held.expiresAt).toISOString(),
      });
    }
    if (input.agentBusy) throw new EditError("AGENT_BUSY", "The agent is planning changes to this project. Stop it or wait for it before editing by hand.");
    const resumed = held?.sessionId === sessionId;
    const lease: EditLease = resumed
      ? { ...held!, expiresAt: this.#now() + LEASE_MS }
      : { sessionId, deviceId: input.deviceId, deviceName: input.deviceName, projectId: project.id, baseRevision: project.revision, startedAt: new Date(this.#now()).toISOString(), expiresAt: this.#now() + LEASE_MS };
    this.#set(lease);
    return { lease, resumed };
  }

  /** Keeps the lease alive. Throws LEASE_LOST if this session no longer holds it. */
  heartbeat(deviceId: string, projectId: string, sessionId: unknown): EditLease {
    const l = this.#mine(deviceId, projectId, sessionId);
    this.#renew(l);
    return l;
  }

  /** Ends the session (Done or leaving). Returns where the timeline is now. */
  end(deviceId: string, projectId: string, sessionId: unknown): { revision: number; summary: ManualEditSummary | null } {
    const sid = idOf(sessionId, "session");
    const l = this.lease(projectId);
    if (l && l.sessionId === sid && l.deviceId === deviceId) this.#drop(projectId);
    const revision = new ProjectStore(this.#db).get(projectId).revision;
    return { revision, summary: this.summaries(projectId).find((s) => s.sessionId === sid) ?? null };
  }

  /** Drops a project's lease without asking (the phone that held it was unpaired). */
  releaseDevice(deviceId: string): void {
    for (const [pid, l] of this.#leases) if (l.deviceId === deviceId) this.#drop(pid);
  }

  /**
   * One edit: a batch of timeline operations made against `baseRevision`, recorded as one undo step.
   * Applied at most once per command id.
   */
  apply(deviceId: string, input: { projectId: string; sessionId: unknown; commandId: unknown; baseRevision: unknown; operations: unknown; label: unknown }): { revision: number; duplicate: boolean } {
    const commandId = idOf(input.commandId, "command");
    // Already applied (its answer was lost): the same answer, even if the lease lapsed since.
    const done = this.#find(input.projectId, commandId, deviceId, "apply");
    if (done) return { revision: done.revision, duplicate: true };
    const l = this.#mine(deviceId, input.projectId, input.sessionId);
    if (typeof input.baseRevision !== "number") throw new ReelForgeError("VALIDATION_ERROR", "baseRevision is required");
    if (!Array.isArray(input.operations) || input.operations.length === 0 || input.operations.length > MAX_OPS) throw new ReelForgeError("VALIDATION_ERROR", "An edit needs 1 to 200 operations.");
    const label = typeof input.label === "string" && LABEL.test(input.label) ? input.label : "Edit";
    // The shared reducer validates every operation (overlaps, source bounds, locked tracks, …).
    const tl = new TimelineStore(this.#db).apply(input.projectId, { baseRevision: input.baseRevision, operations: input.operations as TimelineOp[] }, ACTOR, {
      channel: EDIT_CHANNEL,
      sessionId: l.sessionId,
      deviceId,
      command: "apply",
      commandId,
      label,
    });
    this.#renew(l);
    return { revision: tl.project.revision, duplicate: false };
  }

  /** Undo / redo, only of this session's own steps. */
  travel(deviceId: string, dir: "undo" | "redo", input: { projectId: string; sessionId: unknown; commandId: unknown; baseRevision: unknown }): { revision: number; duplicate: boolean } {
    const commandId = idOf(input.commandId, "command");
    const done = this.#find(input.projectId, commandId, deviceId, dir);
    if (done) return { revision: done.revision, duplicate: true };
    const l = this.#mine(deviceId, input.projectId, input.sessionId);
    if (typeof input.baseRevision !== "number") throw new ReelForgeError("VALIDATION_ERROR", "baseRevision is required");
    const h = this.history(input.projectId, { sessionId: l.sessionId, deviceId });
    if (dir === "undo" ? !h.canUndo : !h.canRedo) throw new ReelForgeError("VALIDATION_ERROR", dir === "undo" ? "Nothing of this editing session left to undo." : "Nothing to redo.");
    const store = new TimelineStore(this.#db);
    const meta = { channel: EDIT_CHANNEL, sessionId: l.sessionId, deviceId, command: dir, commandId };
    const tl = dir === "undo" ? store.undo(input.projectId, { baseRevision: input.baseRevision }, ACTOR, meta) : store.redo(input.projectId, { baseRevision: input.baseRevision }, ACTOR, meta);
    this.#renew(l);
    return { revision: tl.project.revision, duplicate: false };
  }

  /** Undo/redo as this session sees them: the newest step must be one of its own, made on this phone. */
  history(projectId: string, who: EditActor): { canUndo: boolean; canRedo: boolean; label: { undo: string | null; redo: string | null } } {
    const lastApplied = this.#db
      .prepare("SELECT payload FROM edit_operations WHERE project_id = ? AND undoable = 1 AND state = 'applied' ORDER BY revision DESC LIMIT 1")
      .get(projectId) as { payload: string } | undefined;
    const lastUndone = this.#db
      .prepare("SELECT payload FROM edit_operations WHERE project_id = ? AND state = 'undone' ORDER BY undone_at DESC LIMIT 1")
      .get(projectId) as { payload: string } | undefined;
    const ours = (row: { payload: string } | undefined) => {
      const p = row ? (safeJson(row.payload) as { sessionId?: unknown; deviceId?: unknown; label?: unknown }) : null;
      return p?.sessionId === who.sessionId && p.deviceId === who.deviceId ? (typeof p.label === "string" ? p.label : "Edit") : null;
    };
    const undo = ours(lastApplied);
    const redo = ours(lastUndone);
    return { canUndo: undo !== null, canRedo: redo !== null, label: { undo, redo } };
  }

  /** The phone's edit sessions on a project, newest first (from the recorded edits, so they survive restarts). */
  summaries(projectId: string, limit = 10): ManualEditSummary[] {
    const rows = this.#db
      .prepare("SELECT id, revision, kind, payload, state, created_at FROM edit_operations WHERE project_id = ? AND json_extract(payload, '$.channel') = ? ORDER BY revision DESC LIMIT 500")
      .all(projectId, EDIT_CHANNEL) as unknown as OpRow[];
    const live = this.lease(projectId);
    const bySession = new Map<string, OpRow[]>();
    for (const r of rows) {
      const sid = (safeJson(r.payload) as { sessionId?: unknown }).sessionId;
      if (typeof sid !== "string") continue;
      bySession.set(sid, [...(bySession.get(sid) ?? []), r]);
    }
    const out: ManualEditSummary[] = [];
    for (const [sessionId, list] of bySession) {
      const asc = [...list].sort((a, b) => a.revision - b.revision);
      const edits = asc.filter((r) => r.kind === "timeline.edit");
      out.push({
        sessionId,
        deviceName: live?.sessionId === sessionId ? live.deviceName : null,
        fromRevision: asc[0]!.revision - 1,
        toRevision: asc.at(-1)!.revision,
        steps: edits.filter((r) => r.state === "applied").map((r) => String((safeJson(r.payload) as { label?: unknown }).label ?? "Edit")),
        undone: edits.filter((r) => r.state !== "applied").length,
        startedAt: asc[0]!.created_at,
        endedAt: asc.at(-1)!.created_at,
        open: live?.sessionId === sessionId,
      });
    }
    return out.sort((a, b) => b.toRevision - a.toRevision).slice(0, limit);
  }

  /** The timeline as the phone's editor needs it: ids, frames, resolved looks; no file paths. */
  model(projectId: string, who: EditActor | null) {
    const tl = new TimelineStore(this.#db).get(projectId);
    const p = tl.project;
    const labels = trackLabels(tl.tracks);
    return {
      projectId: p.id,
      name: p.name,
      revision: p.revision,
      width: p.settings.width,
      height: p.settings.height,
      fps: p.settings.fps,
      durationFrames: tl.durationFrames,
      tracks: tl.tracks.map((t) => ({
        id: t.id,
        kind: t.kind,
        label: labels.get(t.id) ?? t.name,
        name: t.name,
        position: t.position,
        muted: t.muted,
        locked: t.locked,
        hidden: t.hidden,
        ...(t.kind === "caption" ? { captionStyle: resolveCaptionStyle(t.captionStyle), stylePatch: t.captionStyle ?? {} } : {}),
      })),
      clips: tl.clips.map((c) => {
        const { aiEffects, ...props } = resolveClipProps(c.props);
        return { id: c.id, trackId: c.trackId, assetId: c.assetId, start: c.start, duration: c.duration, sourceIn: c.sourceIn, props, aiEffects: aiEffects.length };
      }),
      captions: tl.captions.slice(0, MAX_CAPTIONS).map((c) => ({ id: c.id, trackId: c.trackId, start: c.start, duration: c.duration, text: c.text, words: c.words })),
      captionsTruncated: tl.captions.length > MAX_CAPTIONS,
      assets: tl.assets.map((a) => ({
        id: a.id,
        kind: a.kind,
        filename: a.filename,
        durationFrames: a.durationFrames,
        durationUs: a.durationUs,
        width: a.width,
        height: a.height,
        rotation: a.rotation,
        hasVideo: a.hasVideo,
        hasAudio: a.hasAudio,
        hasAlpha: a.hasAlpha,
        status: a.status,
      })),
      history: who ? this.history(projectId, who) : { canUndo: false, canRedo: false, label: { undo: null, redo: null } },
    };
  }

  #mine(deviceId: string, projectId: string, sessionId: unknown): EditLease {
    const sid = idOf(sessionId, "session");
    const l = this.#leases.get(projectId);
    if (!l || l.sessionId !== sid || l.deviceId !== deviceId) {
      throw new EditError("LEASE_LOST", "This editing session ended (another phone took over, or your Mac restarted). Start editing again.");
    }
    if (l.expiresAt <= this.#now()) {
      this.#drop(projectId);
      throw new EditError("LEASE_EXPIRED", "This editing session timed out while the phone was away. Start editing again.");
    }
    return l;
  }

  /**
   * A command this phone already ran (same id, same kind of command). An id reused for another command,
   * or by another phone, is refused rather than answered as a duplicate.
   */
  #find(projectId: string, commandId: string, deviceId: string, command: "apply" | "undo" | "redo"): { revision: number } | null {
    const row = this.#db
      .prepare("SELECT revision, payload FROM edit_operations WHERE project_id = ? AND json_extract(payload, '$.commandId') = ? LIMIT 1")
      .get(projectId, commandId) as { revision: number; payload: string } | undefined;
    if (!row) return null;
    const p = safeJson(row.payload) as { deviceId?: unknown; command?: unknown };
    if (p.deviceId !== deviceId || p.command !== command) throw new ReelForgeError("VALIDATION_ERROR", "That command id was already used for something else.");
    return { revision: row.revision };
  }

  /** The phone a session id was used on, from the recorded edits (null: never used). */
  #sessionDevice(projectId: string, sessionId: string): string | null {
    const live = this.#leases.get(projectId);
    if (live?.sessionId === sessionId) return live.deviceId;
    const row = this.#db
      .prepare("SELECT payload FROM edit_operations WHERE project_id = ? AND json_extract(payload, '$.channel') = ? AND json_extract(payload, '$.sessionId') = ? LIMIT 1")
      .get(projectId, EDIT_CHANNEL, sessionId) as { payload: string } | undefined;
    if (!row) return null;
    const d = (safeJson(row.payload) as { deviceId?: unknown }).deviceId;
    return typeof d === "string" ? d : "";
  }

  #set(lease: EditLease): void {
    this.#leases.set(lease.projectId, lease);
    this.#schedule(lease);
  }

  #renew(lease: EditLease): void {
    lease.expiresAt = this.#now() + LEASE_MS;
    this.#schedule(lease);
  }

  #drop(projectId: string): void {
    this.#leases.delete(projectId);
    clearTimeout(this.#expiry.get(projectId));
    this.#expiry.delete(projectId);
  }

  /** Fires once the lease would lapse; if nobody renewed it by then, it's dropped and announced. */
  #schedule(lease: EditLease): void {
    clearTimeout(this.#expiry.get(lease.projectId));
    const t = setTimeout(() => {
      this.#expiry.delete(lease.projectId);
      const cur = this.#leases.get(lease.projectId);
      if (!cur) return;
      if (cur.expiresAt > this.#now()) return this.#schedule(cur);
      this.#leases.delete(lease.projectId);
      this.#onExpire(lease.projectId);
    }, Math.max(0, lease.expiresAt - this.#now()) + 50);
    t.unref?.();
    this.#expiry.set(lease.projectId, t);
  }
}

function idOf(v: unknown, what: string): string {
  if (typeof v !== "string" || !UUID.test(v)) throw new ReelForgeError("VALIDATION_ERROR", `That ${what} id isn't valid.`);
  return v;
}

function safeJson(s: string): Record<string, unknown> {
  try {
    const v = JSON.parse(s);
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

export const newSessionId = () => randomUUID();
