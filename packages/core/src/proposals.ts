import { randomUUID } from "node:crypto";
import type { Database } from "./db.ts";
import { ReelForgeError } from "./errors.ts";
import { assertRevision } from "./revisions.ts";
import { buildRenderPlan } from "./render-plan.ts";
import { TimelineStore } from "./timeline.ts";
import { isEmptyDiff, type TimelineDiff } from "./timeline-ops.ts";
import { ProjectIdSchema, trackLabels, type Actor, type AiFx, type AIConsent, type AIProposal, type ProposalChange, type Timeline, type TimelineOp } from "./schema.ts";
import { parse } from "./validate.ts";

interface ProposalRow {
  id: string;
  project_id: string;
  base_revision: number;
  instruction: string;
  requested_by: AIProposal["requestedBy"];
  selection: string;
  provider: string;
  model: string;
  status: AIProposal["status"];
  summary: string;
  operations: string;
  explanations: string;
  warnings: string;
  changes: string;
  duration_before: number;
  duration_after: number;
  usage: string | null;
  approved_by: string | null;
  approval_channel: string | null;
  decided_at: string | null;
  applied_revision: number | null;
  created_at: string;
}

const toProposal = (r: ProposalRow): AIProposal => ({
  id: r.id,
  projectId: r.project_id,
  baseRevision: r.base_revision,
  instruction: r.instruction,
  requestedBy: r.requested_by,
  selection: JSON.parse(r.selection) as string[],
  provider: r.provider,
  model: r.model,
  status: r.status,
  summary: r.summary,
  operations: JSON.parse(r.operations) as TimelineOp[],
  explanations: JSON.parse(r.explanations) as string[],
  warnings: JSON.parse(r.warnings) as string[],
  changes: JSON.parse(r.changes) as ProposalChange[],
  durationBefore: r.duration_before,
  durationAfter: r.duration_after,
  usage: r.usage ? (JSON.parse(r.usage) as Record<string, unknown>) : null,
  approval: r.approved_by && r.approval_channel && r.decided_at ? { by: r.approved_by, channel: r.approval_channel, at: r.decided_at } : null,
  appliedRevision: r.applied_revision,
  createdAt: r.created_at,
});

/** Human-readable before/after lines for every row a proposal changes. */
export function describeChanges(before: Timeline, diff: TimelineDiff): ProposalChange[] {
  const { fps } = before.project.settings;
  const s = (f: number) => `${((f * fps.den) / fps.num).toFixed(2)}s`;
  const labels = trackLabels(before.tracks);
  const name = new Map(before.assets.map((a) => [a.id, a.filename]));
  const props = (p: Record<string, unknown>) => {
    const value = (k: string, v: unknown) => {
      if (typeof v === "number") return Math.round(v * 1000) / 1000;
      // AI effects: name, source time range and text (times are in the clip's source, like sourceIn).
      if (k === "aiEffects" && Array.isArray(v)) {
        return (v as AiFx[]).map((e) => `${e.fx} ${s(e.start)}–${s(e.end)} of source${e.text ? ` “${e.text.slice(0, 40)}”` : ""}`).join("; ") || "none";
      }
      return v !== null && typeof v === "object" ? JSON.stringify(v) : v;
    };
    const keys = Object.entries(p).map(([k, v]) => `${k} ${value(k, v)}`);
    return keys.length ? ` · ${keys.join(", ")}` : "";
  };
  const out: ProposalChange[] = [];
  const kindOf = (b: unknown, a: unknown): ProposalChange["kind"] => (!b ? "added" : !a ? "removed" : "changed");
  for (const ch of diff.clips) {
    const c = (ch.after ?? ch.before)!;
    const fmt = (x: typeof ch.before) => (x ? `${labels.get(x.trackId) ?? "?"} · ${s(x.start)}–${s(x.start + x.duration)} · from ${s(x.sourceIn)}${props(x.props)}` : null);
    out.push({ kind: kindOf(ch.before, ch.after), target: "clip", id: ch.id, label: name.get(c.assetId) ?? "clip", before: fmt(ch.before), after: fmt(ch.after) });
  }
  for (const ch of diff.captions ?? []) {
    const c = (ch.after ?? ch.before)!;
    const fmt = (x: typeof ch.before) => (x ? `${s(x.start)}–${s(x.start + x.duration)} · “${x.text}”` : null);
    out.push({ kind: kindOf(ch.before, ch.after), target: "caption", id: ch.id, label: `Caption “${c.text.slice(0, 40)}”`, before: fmt(ch.before), after: fmt(ch.after) });
  }
  for (const ch of diff.tracks) {
    const t = (ch.after ?? ch.before)!;
    const fmt = (x: typeof ch.before) =>
      x ? [`“${x.name}”`, x.muted && "muted", x.hidden && "hidden", x.locked && "locked", x.captionStyle && `style ${JSON.stringify(x.captionStyle)}`].filter(Boolean).join(", ") : null;
    out.push({ kind: kindOf(ch.before, ch.after), target: "track", id: ch.id, label: `${labels.get(t.id) ?? ""} ${t.name}`.trim(), before: fmt(ch.before), after: fmt(ch.after) });
  }
  // Approval screens may show only the start of this list, so the changes with the most reach
  // come first: edits to existing tracks (hide, mute, lock, restyle), then removals, then
  // changes, then additions. Filler additions can never push a track change out of sight.
  const rank = (c: ProposalChange) => (c.target === "track" && c.kind !== "added" ? 0 : c.kind === "removed" ? 1 : c.kind === "changed" ? 2 : 3);
  return out.map((c, i) => ({ c, i })).sort((x, y) => rank(x.c) - rank(y.c) || x.i - y.i).map((x) => x.c);
}

/**
 * What the engine can tell about a result that the model can't see: dissolves
 * shortened by missing handles (or with no clip to dissolve from).
 */
export function engineWarnings(after: Timeline): string[] {
  const out: string[] = [];
  let plan;
  try {
    plan = buildRenderPlan(after);
  } catch {
    return out;
  }
  const { fps } = after.project.settings;
  const s = (f: number) => `${((f * fps.den) / fps.num).toFixed(2)}s`;
  const name = new Map(after.assets.map((a) => [a.id, a.filename]));
  for (const seg of [...plan.layers.flat(), ...plan.audio]) {
    const asked = seg.props.transitionIn;
    if (asked < 2) continue;
    const got = seg.inH * 2;
    if (got >= asked - 1) continue;
    const who = name.get(seg.assetId) ?? "a clip";
    out.push(
      got === 0
        ? `Engine: the ${s(asked)} transition into ${who} won't play: ${seg.start > 0 && after.clips.some((c) => c.trackId === seg.trackId && c.start + c.duration === seg.start) ? "there are no spare source frames on both sides of the cut (trim the clips so they have handles)" : "no clip ends exactly where it starts"}.`
        : `Engine: the transition into ${who} is shortened to ${s(got)} (only that many spare source frames around the cut).`,
    );
  }
  return out;
}

/** Applying is refused for good once the timeline moved on: retrying can't help, a new proposal can. */
function staleError(p: AIProposal, details?: Record<string, unknown>): ReelForgeError {
  return new ReelForgeError(
    "REVISION_CONFLICT",
    `the timeline changed since this proposal was made (revision ${p.baseRevision}), so it can no longer be applied; ask for a new proposal`,
    { ...details, proposalId: p.id, baseRevision: p.baseRevision, status: "stale" },
  );
}

/**
 * AI effects the proposal adds or changes must lie inside their clip's source media: an effect past the end
 * of the footage never plays. (The schema can't check this: it doesn't know the media's length.)
 */
function assertEffectsInSource(before: Timeline, diff: TimelineDiff) {
  const length = new Map(before.assets.map((a) => [a.id, a.durationFrames]));
  const issues: { path: string; message: string }[] = [];
  for (const ch of diff.clips) {
    const c = ch.after;
    const max = c ? length.get(c.assetId) : null;
    if (!c || max == null) continue;
    const old = new Set((ch.before?.props.aiEffects ?? []).map((e) => JSON.stringify(e)));
    (c.props.aiEffects ?? []).forEach((e, i) => {
      if (old.has(JSON.stringify(e))) return;
      if (e.end > max) {
        issues.push({ path: `clip ${c.id} props.aiEffects.${i}`, message: `${e.fx} runs to source frame ${e.end} but the media is only ${max} frames long (start/end are source frames)` });
      }
    });
  }
  if (issues.length) throw new ReelForgeError("VALIDATION_ERROR", issues.map((i) => `${i.path}: ${i.message}`).join("; "), { issues });
}

export interface NewProposal {
  instruction: string;
  /** Default "user". */
  requestedBy?: AIProposal["requestedBy"];
  selection: string[];
  provider: string;
  model: string;
  summary: string;
  operations: TimelineOp[];
  explanations: string[];
  warnings: string[];
  usage?: Record<string, unknown>;
}

/**
 * AI proposals. A proposal is validated by a dry run before it is stored, and
 * it reaches the timeline only through `apply`, which needs an approval from
 * a person (recorded with who/when/how) — never because the model said so.
 */
export class ProposalStore {
  readonly #db: Database;
  readonly #now: () => string;

  constructor(db: Database, opts: { now?: () => string } = {}) {
    this.#db = db;
    this.#now = opts.now ?? (() => new Date().toISOString());
  }

  /** Validate by dry run (throws VALIDATION_ERROR naming the failing operation) and store as pending. */
  create(projectId: string, p: NewProposal): AIProposal {
    const pid = parse(ProjectIdSchema, projectId);
    const timeline = new TimelineStore(this.#db);
    // An empty plan is a valid answer ("can't do that, here's why"): nothing to dry-run or apply.
    const preview = p.operations.length
      ? timeline.preview(pid, p.operations)
      : (() => {
          const before = timeline.get(pid);
          return { before, after: before, operations: [] as TimelineOp[], diff: { tracks: [], clips: [], captions: [] }, durationAfter: before.durationFrames };
        })();
    assertEffectsInSource(preview.before, preview.diff);
    // Only what this proposal causes: problems the timeline already had are not its warnings.
    const already = new Set(engineWarnings(preview.before));
    const warnings = [...p.warnings, ...engineWarnings(preview.after).filter((w) => !already.has(w))];
    // Operations that change nothing (the timeline already looks like that) are stored as "no changes", so
    // the proposal can't be approved and then recorded as applied without any edit having happened.
    const noop = preview.operations.length > 0 && isEmptyDiff(preview.diff);
    if (noop) warnings.push("These operations would not change anything on the timeline.");
    const operations = noop ? [] : preview.operations;
    const id = randomUUID();
    this.#db
      .prepare(
        `INSERT INTO ai_proposals (id, project_id, base_revision, instruction, requested_by, selection, provider, model, status, summary, operations,
           explanations, warnings, changes, duration_before, duration_after, usage, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id, pid, preview.before.project.revision, p.instruction, p.requestedBy ?? "user", JSON.stringify(p.selection), p.provider, p.model, p.summary,
        JSON.stringify(operations), JSON.stringify(noop ? [] : p.explanations), JSON.stringify(warnings),
        JSON.stringify(describeChanges(preview.before, preview.diff)), preview.before.durationFrames, preview.durationAfter,
        p.usage ? JSON.stringify(p.usage) : null, this.#now(),
      );
    return this.get(id);
  }

  /** Pending proposals whose project has moved on can never apply: record them as stale. */
  #markStale(where: string, arg: string) {
    this.#db
      .prepare(
        `UPDATE ai_proposals SET status = 'stale' WHERE status = 'pending' AND ${where}
           AND base_revision <> (SELECT revision FROM projects WHERE projects.id = ai_proposals.project_id)`,
      )
      .run(arg);
  }

  get(id: string): AIProposal {
    const pid = parse(ProjectIdSchema, id);
    this.#markStale("id = ?", pid);
    const row = this.#db.prepare("SELECT * FROM ai_proposals WHERE id = ?").get(pid) as unknown as ProposalRow | undefined;
    if (!row) throw new ReelForgeError("NOT_FOUND", `proposal ${pid} not found`, { proposalId: pid });
    return toProposal(row);
  }

  list(projectId: string, limit = 50): AIProposal[] {
    const pid = parse(ProjectIdSchema, projectId);
    this.#markStale("project_id = ?", pid);
    const rows = this.#db.prepare("SELECT * FROM ai_proposals WHERE project_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?").all(pid, limit) as unknown as ProposalRow[];
    return rows.map(toProposal);
  }

  /**
   * Apply an approved proposal as one undoable revision (FR-023/024). If the
   * project changed since the proposal was made it is marked stale instead of
   * being merged over newer edits (FR-016).
   */
  apply(proposalId: string, approval: { by: Actor; channel: string }): { proposal: AIProposal; timeline: Timeline } {
    const p = this.get(proposalId);
    if (p.status === "stale") throw staleError(p);
    if (p.status !== "pending") throw new ReelForgeError("VALIDATION_ERROR", `proposal is already ${p.status}`, { proposalId, status: p.status });
    if (!p.operations.length) throw new ReelForgeError("VALIDATION_ERROR", "this proposal has no changes to apply");
    if (!approval.channel) throw new ReelForgeError("VALIDATION_ERROR", "an approval needs a channel (how the person approved it)");
    try {
      assertRevision(this.#db, p.projectId, p.baseRevision);
    } catch (e) {
      if (e instanceof ReelForgeError && e.code === "REVISION_CONFLICT") {
        this.#db.prepare("UPDATE ai_proposals SET status = 'stale' WHERE id = ? AND status = 'pending'").run(p.id);
        throw staleError(p, e.details);
      }
      throw e;
    }
    const timeline = new TimelineStore(this.#db).apply(p.projectId, { baseRevision: p.baseRevision, operations: p.operations }, approval.by, {
      proposalId: p.id,
      approvedVia: approval.channel,
    });
    this.#db
      .prepare("UPDATE ai_proposals SET status = 'applied', approved_by = ?, approval_channel = ?, decided_at = ?, applied_revision = ? WHERE id = ? AND status = 'pending'")
      .run(approval.by, approval.channel, this.#now(), timeline.project.revision, p.id);
    return { proposal: this.get(p.id), timeline };
  }

  /** Dismiss a proposal that was never applied (pending, or stale because the timeline moved on). */
  reject(proposalId: string, by: Actor): AIProposal {
    const p = this.get(proposalId);
    if (p.status !== "pending" && p.status !== "stale") throw new ReelForgeError("VALIDATION_ERROR", `proposal is already ${p.status}`, { proposalId, status: p.status });
    this.#db.prepare("UPDATE ai_proposals SET status = 'rejected', approved_by = ?, decided_at = ? WHERE id = ?").run(by, this.#now(), p.id);
    return this.get(p.id);
  }

  consent(projectId: string): AIConsent | null {
    const pid = parse(ProjectIdSchema, projectId);
    const row = this.#db.prepare("SELECT ai_consent FROM projects WHERE id = ?").get(pid) as { ai_consent: string | null } | undefined;
    if (!row) throw new ReelForgeError("NOT_FOUND", `project ${pid} not found`);
    return row.ai_consent ? (JSON.parse(row.ai_consent) as AIConsent) : null;
  }

  /**
   * Grant adds `recipient` to the existing consent ("*" = anyone); revoke without a recipient
   * clears the whole record, with one it removes just that recipient.
   */
  setConsent(projectId: string, granted: boolean, by: Actor, recipient = "*"): AIConsent | null {
    const pid = parse(ProjectIdSchema, projectId);
    const prev = this.consent(pid);
    const had = prev ? (prev.recipients ?? ["anthropic", "ollama"]) : [];
    const recipients = granted ? [...new Set([...had, recipient])] : recipient === "*" ? [] : had.filter((r) => r !== recipient);
    const value: AIConsent | null = recipients.length ? { grantedAt: granted || !prev ? this.#now() : prev.grantedAt, grantedBy: granted || !prev ? by : prev.grantedBy, recipients } : null;
    const r = this.#db.prepare("UPDATE projects SET ai_consent = ? WHERE id = ?").run(value ? JSON.stringify(value) : null, pid);
    if (Number(r.changes) !== 1) throw new ReelForgeError("NOT_FOUND", `project ${pid} not found`);
    return value;
  }
}
