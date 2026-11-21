import { randomUUID } from "node:crypto";
import type { Database } from "./db.ts";
import { ReelForgeError } from "./errors.ts";
import { assertRevision } from "./revisions.ts";
import { buildRenderPlan } from "./render-plan.ts";
import { TimelineStore } from "./timeline.ts";
import type { TimelineDiff } from "./timeline-ops.ts";
import { ProjectIdSchema, trackLabels, type Actor, type AIConsent, type AIProposal, type ProposalChange, type Timeline, type TimelineOp } from "./schema.ts";
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
    const keys = Object.entries(p).map(([k, v]) => `${k} ${typeof v === "number" ? Math.round(v * 1000) / 1000 : v}`);
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
    const warnings = [...p.warnings, ...engineWarnings(preview.after)];
    const id = randomUUID();
    this.#db
      .prepare(
        `INSERT INTO ai_proposals (id, project_id, base_revision, instruction, requested_by, selection, provider, model, status, summary, operations,
           explanations, warnings, changes, duration_before, duration_after, usage, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id, pid, preview.before.project.revision, p.instruction, p.requestedBy ?? "user", JSON.stringify(p.selection), p.provider, p.model, p.summary,
        JSON.stringify(preview.operations), JSON.stringify(p.explanations), JSON.stringify(warnings),
        JSON.stringify(describeChanges(preview.before, preview.diff)), preview.before.durationFrames, preview.durationAfter,
        p.usage ? JSON.stringify(p.usage) : null, this.#now(),
      );
    return this.get(id);
  }

  get(id: string): AIProposal {
    const pid = parse(ProjectIdSchema, id);
    const row = this.#db.prepare("SELECT * FROM ai_proposals WHERE id = ?").get(pid) as unknown as ProposalRow | undefined;
    if (!row) throw new ReelForgeError("NOT_FOUND", `proposal ${pid} not found`, { proposalId: pid });
    return toProposal(row);
  }

  list(projectId: string, limit = 50): AIProposal[] {
    const pid = parse(ProjectIdSchema, projectId);
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
    if (p.status !== "pending") throw new ReelForgeError("VALIDATION_ERROR", `proposal is already ${p.status}`, { proposalId, status: p.status });
    if (!p.operations.length) throw new ReelForgeError("VALIDATION_ERROR", "this proposal has no changes to apply");
    if (!approval.channel) throw new ReelForgeError("VALIDATION_ERROR", "an approval needs a channel (how the person approved it)");
    try {
      assertRevision(this.#db, p.projectId, p.baseRevision);
    } catch (e) {
      if (e instanceof ReelForgeError && e.code === "REVISION_CONFLICT") {
        this.#db.prepare("UPDATE ai_proposals SET status = 'stale' WHERE id = ? AND status = 'pending'").run(p.id);
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

  reject(proposalId: string, by: Actor): AIProposal {
    const p = this.get(proposalId);
    if (p.status !== "pending") throw new ReelForgeError("VALIDATION_ERROR", `proposal is already ${p.status}`, { proposalId, status: p.status });
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
