// Workflow JSON: a repeatable recipe (import → analyse → assemble → captions →
// AI pass → render) run by the same engine as the editor. Steps written out in
// the file are approved by running it; an AI Director step still needs its
// own explicit approval (--approve-ai), otherwise the run stops for review.

import { existsSync, mkdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { glob } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import {
  ANALYSIS_KINDS,
  AnalysisStore,
  AssetStore,
  CAPTION_PRESETS,
  CaptionStylePatchSchema,
  ClipPropsPatchSchema,
  clipEnd,
  OPERATION_TYPES,
  parseFps,
  parseTime,
  planCaptions,
  ProjectSettingsSchema,
  ProjectStore,
  ProposalStore,
  ReelForgeError,
  TimelineOpSchema,
  TimelineStore,
  trackLabels,
  WorkflowRunStore,
  type Actor,
  type AnalysisKind,
  type Database,
  type Timeline,
  type TimelineOp,
  type WorkflowRun,
  type WorkflowStepResult,
} from "@reelforge/core";
import { AnalysisRunner, createRenderJob, importMedia, MAX_IMPORT_BATCH, RenderRunner, SUPPORTED_EXTENSIONS } from "@reelforge/media";
import { ANTHROPIC_DEFAULT_MODEL, defaultOllamaModel, parseModelOutput, propose, providerFor } from "@reelforge/ai";

const Time = z.union([z.number().int().nonnegative(), z.string().min(1)]);

const StepSchema = z.union([
  z.object({ import: z.object({ paths: z.array(z.string().min(1)).min(1).max(500) }).strict() }).strict(),
  z.object({ analyze: z.object({ assets: z.array(z.string()).optional(), kinds: z.array(z.enum(ANALYSIS_KINDS)).optional(), language: z.string().optional() }).strict() }).strict(),
  z.object({
    append: z.object({ asset: z.string().min(1), track: z.string().min(1), duration: Time.optional(), sourceIn: Time.optional(), props: z.record(z.string(), z.unknown()).optional() }).strict(),
  }).strict(),
  z.object({ edit: z.object({ operations: z.array(z.record(z.string(), z.unknown())).min(1).max(500) }).strict() }).strict(),
  z.object({
    captions: z.object({
      source: z.array(z.string()).optional(),
      maxWords: z.number().int().min(1).max(12).optional(),
      language: z.string().optional(),
      style: z.union([z.enum(["bold", "clean", "boxed"]), CaptionStylePatchSchema]).optional(),
    }).strict(),
  }).strict(),
  z.object({ director: z.object({ instruction: z.string().min(1).max(4000), provider: z.enum(["anthropic", "ollama"]).optional(), model: z.string().optional() }).strict() }).strict(),
  z.object({ preview: z.object({}).strict() }).strict(),
  z.object({ render: z.object({ out: z.string().min(1) }).strict() }).strict(),
]);
export type WorkflowStep = z.infer<typeof StepSchema>;

export const WorkflowSpecSchema = z
  .object({
    version: z.literal(1),
    name: z.string().min(1).max(200),
    project: z.union([
      z.object({ id: z.uuid() }).strict(),
      z.object({ name: z.string().min(1).max(120), width: z.number().int().optional(), height: z.number().int().optional(), fps: z.string().optional() }).strict(),
    ]),
    steps: z.array(StepSchema).min(1).max(200),
  })
  .strict();
export type WorkflowSpec = z.infer<typeof WorkflowSpecSchema>;

type Issue = { path: string; message: string };
const STEP_KINDS = StepSchema.options.map((o) => Object.keys(o.shape)[0]!);

/** Why one step doesn't match: a union failure only says "Invalid input", so check it against its own kind. */
function explainStep(raw: unknown, index: number): Issue[] {
  const at = `steps.${index}`;
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).length !== 1) {
    return [{ path: at, message: `a step is an object with exactly one key, one of: ${STEP_KINDS.join(", ")}` }];
  }
  const kind = Object.keys(raw)[0]!;
  const schema = StepSchema.options.find((o) => kind in o.shape);
  if (!schema) return [{ path: at, message: `unknown step "${kind}" (use ${STEP_KINDS.join(", ")})` }];
  const r = schema.safeParse(raw);
  return r.success ? [] : r.error.issues.map((i) => ({ path: [at, ...i.path].join("."), message: i.message }));
}

const OP_SCHEMAS = new Map(TimelineOpSchema.options.map((o) => [(o.shape.type as { value: string }).value, o]));

/**
 * What can be checked before anything runs (values like "${asset:…}" or "2s" resolve at run time):
 * project settings, operation types and field names, clip property names.
 */
function deepIssues(spec: WorkflowSpec): Issue[] {
  const issues: Issue[] = [];
  if (!("id" in spec.project)) {
    const p = spec.project;
    let fps: unknown;
    if (p.fps !== undefined) {
      try {
        fps = parseFps(p.fps);
      } catch (e) {
        issues.push({ path: "project.fps", message: e instanceof Error ? e.message : String(e) });
      }
    }
    const settings = ProjectSettingsSchema.partial().safeParse({ ...(p.width !== undefined ? { width: p.width } : {}), ...(p.height !== undefined ? { height: p.height } : {}), ...(fps ? { fps } : {}) });
    if (!settings.success) for (const i of settings.error.issues) issues.push({ path: ["project", ...i.path].join("."), message: i.message });
  }
  const propKeys = (props: unknown, at: string) => {
    if (!props || typeof props !== "object") return;
    for (const k of Object.keys(props)) if (!(k in ClipPropsPatchSchema.shape)) issues.push({ path: `${at}.${k}`, message: `unknown clip property "${k}"` });
  };
  spec.steps.forEach((step, i) => {
    if ("append" in step) propKeys(step.append.props, `steps.${i}.append.props`);
    if (!("edit" in step)) return;
    step.edit.operations.forEach((op, j) => {
      const at = `steps.${i}.edit.operations.${j}`;
      const schema = OP_SCHEMAS.get(String(op.type));
      if (!schema) return issues.push({ path: `${at}.type`, message: `unknown operation type ${JSON.stringify(op.type ?? null)} (use ${OPERATION_TYPES.join(", ")})` });
      for (const k of Object.keys(op)) if (k !== "why" && !(k in schema.shape)) issues.push({ path: `${at}.${k}`, message: `${String(op.type)} has no field "${k}"` });
      if (op.type === "clip.add" || op.type === "clip.update") propKeys(op.props, `${at}.props`);
    });
  });
  return issues;
}

export function parseWorkflow(input: unknown): WorkflowSpec {
  const r = WorkflowSpecSchema.safeParse(input);
  if (!r.success) {
    const steps = (input as { steps?: unknown } | null)?.steps;
    const issues = r.error.issues.flatMap((i): Issue[] =>
      i.code === "invalid_union" && i.path.length === 2 && i.path[0] === "steps" && Array.isArray(steps)
        ? explainStep(steps[i.path[1] as number], i.path[1] as number)
        : [{ path: i.path.join("."), message: i.message }],
    );
    throw new ReelForgeError("VALIDATION_ERROR", `invalid workflow: ${issues.map((i) => `${i.path || "workflow"}: ${i.message}`).join("; ")}`, { issues });
  }
  const issues = deepIssues(r.data);
  if (issues.length) throw new ReelForgeError("VALIDATION_ERROR", `invalid workflow: ${issues.map((i) => `${i.path}: ${i.message}`).join("; ")}`, { issues });
  return r.data;
}

const stepKind = (s: WorkflowStep) => Object.keys(s)[0]!;

/**
 * Text from an untrusted author (an AI client, a media filename, a transcript) made safe to show inside an
 * approval prompt: no control characters or line breaks (which could fake prompt lines), whitespace
 * collapsed, length capped, and no live markup. Clients may render the prompt as Markdown or HTML, so `<`/`>`
 * become ‹ › (no tags, no `<!--` hiding the lines after it) and Markdown metacharacters are backslash-escaped
 * (no links or images: `[` is escaped, so `](…)` never closes one; no emphasis, strikethrough, code spans or entities). Escaping runs after the cut, so it never leaves half an escape.
 */
export function quoteUntrusted(text: unknown, max = 80): string {
  const flat = String(text ?? "").replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200b-\u200f\u202a-\u202e\u2066-\u2069]+/g, " ").replace(/\s+/g, " ").trim();
  const cut = flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
  return `“${cut.replace(/</g, "‹").replace(/>/g, "›").replace(/[\\`*_[\]~&]/g, "\\$&")}”`;
}

/** What a timeline-changing step will do, in words a person can check before approving. */
export function describeTimelineStep(step: WorkflowStep): string {
  if ("append" in step) {
    const a = step.append;
    return `add ${quoteUntrusted(a.asset, 60)} at the end of track ${quoteUntrusted(a.track, 12)}${a.duration !== undefined ? `, duration ${quoteUntrusted(a.duration, 12)}` : ""}${a.props ? `, with ${quoteUntrusted(Object.keys(a.props).join(", "), 60)}` : ""}`;
  }
  if ("edit" in step) {
    const ops = step.edit.operations;
    const counts = new Map<string, number>();
    for (const o of ops) counts.set(String(o.type), (counts.get(String(o.type)) ?? 0) + 1);
    const deletes = ops.filter((o) => o.type === "clip.delete" || o.type === "caption.delete" || o.type === "captions.replace").length;
    return `${ops.length} operation${ops.length === 1 ? "" : "s"}: ${[...counts].map(([k, n]) => `${n}× ${quoteUntrusted(k, 24)}`).join(", ")}${deletes ? ` (includes ${deletes} that remove or replace content)` : ""}`;
  }
  if ("captions" in step) {
    return `transcribe if needed and REPLACE all captions${step.captions.source ? ` from tracks ${quoteUntrusted(step.captions.source.join(", "), 40)}` : ""}${step.captions.style ? `, set the caption style` : ""}`;
  }
  return Object.keys(step)[0]!;
}

/** Steps that change the timeline directly (director steps make proposals and are gated separately). */
export const TIMELINE_STEPS = new Set(["append", "edit", "captions"]);
export function timelineSteps(spec: WorkflowSpec): { index: number; kind: string; description: string }[] {
  return spec.steps.flatMap((s, index) => (TIMELINE_STEPS.has(stepKind(s)) ? [{ index, kind: stepKind(s), description: describeTimelineStep(s) }] : []));
}

export interface RunOptions {
  cacheDir: string;
  actor: Actor;
  /** Where relative paths in the workflow resolve from (the file's folder). */
  baseDir: string;
  source?: string | null;
  /** The person running it also approves AI Director proposals. */
  approveAi?: boolean;
  /**
   * Whether the steps that change the timeline (append, edit, captions) are approved. True when a person runs
   * the file (CLI, desktop). An AI client (MCP) that wrote the workflow must get the user's approval first.
   */
  timelineEditsApproved?: boolean;
  /**
   * Whether import steps may expand glob patterns. A glob reads directory listings, so an AI client (MCP)
   * needs the user's approval first; false refuses them.
   */
  globsApproved?: boolean;
  /**
   * Create a missing export folder inside baseDir. Only for callers whose baseDir is the recipe file's own
   * folder (CLI, desktop); an MCP client chooses its baseDir, so it never gets this.
   */
  createOutputDirs?: boolean;
  signal?: AbortSignal;
  /** Called with the run id as soon as the run is recorded (for callers that don't wait). */
  onStart?: (runId: string) => void;
}

function expandPath(p: string, baseDir: string): string {
  const home = p === "~" || p.startsWith("~/") ? join(homedir(), p.slice(1)) : p;
  return isAbsolute(home) ? home : resolve(baseDir, home);
}

/**
 * Import steps whose paths are glob patterns once resolved against baseDir (a baseDir can carry the
 * pattern too), with the resolved patterns: exactly what expandGlobs will search.
 */
export function globImportSteps(spec: WorkflowSpec, baseDir: string): { index: number; patterns: string[] }[] {
  return spec.steps.flatMap((s, index) => {
    if (!("import" in s)) return [];
    const patterns = s.import.paths.map((p) => expandPath(p, baseDir)).filter(isGlob);
    return patterns.length ? [{ index, patterns }] : [];
  });
}

const isGlob = (p: string) => /[*?[]/.test(p);

/**
 * Literal paths pass through (import reports their errors). A glob keeps only regular files with a
 * supported extension, and other entries are counted, never named, so a broad pattern can't list a folder.
 */
/** A glob stops early instead of walking a whole disk ("/**" ) or importing thousands of files. */
export const MAX_GLOB_MATCHES = MAX_IMPORT_BATCH;
export const MAX_GLOB_ENTRIES = 20_000;

async function expandGlobs(paths: string[], baseDir: string, approved: boolean): Promise<{ paths: string[]; skipped: number }> {
  let skipped = 0;
  const out: string[] = [];
  for (const p of paths) {
    const abs = expandPath(p, baseDir);
    if (!isGlob(abs)) {
      out.push(abs);
      continue;
    }
    if (!approved) throw new ReelForgeError("VALIDATION_ERROR", `the glob pattern ${p} needs the user's approval`);
    const hits: string[] = [];
    let seen = 0;
    for await (const h of glob(abs)) {
      if (++seen > MAX_GLOB_ENTRIES) throw new ReelForgeError("VALIDATION_ERROR", `${p} matches more than ${MAX_GLOB_ENTRIES} entries; use a narrower pattern`);
      if (extname(h).toLowerCase() in SUPPORTED_EXTENSIONS && isRegularFile(h)) hits.push(h);
      else skipped++;
      if (hits.length > MAX_GLOB_MATCHES) throw new ReelForgeError("VALIDATION_ERROR", `${p} matches more than ${MAX_GLOB_MATCHES} media files; use a narrower pattern`);
    }
    if (!hits.length) throw new ReelForgeError("VALIDATION_ERROR", `no media files match ${p}`);
    out.push(...hits.sort());
  }
  return { paths: out, skipped };
}

/** At most a few failures by name in errors and run records; the rest as a count. */
const MAX_LISTED_FAILURES = 10;

function isRegularFile(p: string) {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Whether `dir` is `base` or inside it (after resolving symlinks of the existing part of `dir`). */
function isInside(base: string, dir: string) {
  let existing = dir;
  while (!existsSync(existing) && dirname(existing) !== existing) existing = dirname(existing);
  const real = join(realpathSync(existing), relative(existing, dir));
  const rel = relative(realpathSync(base), real);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function findAsset(tl: Timeline, ref: string) {
  const a = tl.assets.find((x) => x.id === ref) ?? tl.assets.find((x) => x.filename === ref) ?? tl.assets.find((x) => x.filename.toLowerCase() === ref.toLowerCase());
  if (!a) throw new ReelForgeError("VALIDATION_ERROR", `no imported media named "${ref}"`);
  return a;
}

function findTrack(tl: Timeline, ref: string) {
  if (tl.tracks.some((t) => t.id === ref)) return ref;
  for (const [id, label] of trackLabels(tl.tracks)) if (label === ref.toUpperCase()) return id;
  const byName = tl.tracks.find((t) => t.name.toLowerCase() === ref.toLowerCase());
  if (byName) return byName.id;
  throw new ReelForgeError("VALIDATION_ERROR", `no track "${ref}"`);
}

/** Frame-valued fields that also take "2s"-style times (fades and dissolves too; `end` of an AI effect). */
const FRAME_KEYS = new Set(["start", "end", "duration", "sourceIn", "frame", "fadeIn", "fadeOut", "transitionIn"]);

/** Resolve ${asset:…}, ${track:…}, ${clip:…#n} and "2s"-style times in workflow operations. */
export function resolveOperations(tl: Timeline, ops: Record<string, unknown>[]): TimelineOp[] {
  const fps = tl.project.settings.fps;
  const sub = (v: string) =>
    v.replace(/\$\{(asset|track|clip):([^}#]+)(?:#(\d+))?\}/g, (_, kind: string, ref: string, nth?: string) => {
      if (kind === "asset") return findAsset(tl, ref).id;
      if (kind === "track") return findTrack(tl, ref);
      const asset = findAsset(tl, ref);
      const clips = tl.clips.filter((c) => c.assetId === asset.id).sort((a, b) => a.start - b.start);
      const c = clips[(nth ? Number(nth) : 1) - 1];
      if (!c) throw new ReelForgeError("VALIDATION_ERROR", `no clip #${nth ?? 1} of "${ref}" on the timeline`);
      return c.id;
    });
  const walk = (v: unknown, key?: string): unknown => {
    if (typeof v === "string") {
      const s = sub(v);
      if (key && FRAME_KEYS.has(key) && !/^\d+$/.test(s)) {
        try {
          return parseTime(s, fps);
        } catch (e) {
          throw new ReelForgeError("VALIDATION_ERROR", e instanceof Error ? e.message : String(e));
        }
      }
      return key && FRAME_KEYS.has(key) ? Number(s) : s;
    }
    if (Array.isArray(v)) return v.map((x) => walk(x));
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, k)]));
    return v;
  };
  // Same parser as AI output: placeholders ("new-1") and strict schema checks.
  const parsed = parseModelOutput(JSON.stringify({ summary: "", warnings: [], operations: ops.map((o) => ({ why: "", ...(walk(o) as object) })) }));
  if (parsed.errors.length) throw new ReelForgeError("VALIDATION_ERROR", parsed.errors.join("; "));
  return parsed.operations;
}

async function runAnalyses(db: Database, cacheDir: string, ids: string[]) {
  const runner = new AnalysisRunner(db, { cacheDir });
  for (const id of ids) runner.enqueue(id);
  const done = await Promise.all(ids.map((id) => runner.wait(id)));
  const failed = done.filter((a) => a.state === "failed");
  if (failed.length) throw new ReelForgeError("INTERNAL", failed.map((a) => `${a.kind}: ${a.error}`).join("; "));
  return done;
}

async function runRender(db: Database, cacheDir: string, projectId: string, kind: "export" | "preview", out?: string) {
  const job = createRenderJob(db, projectId, kind, out);
  const runner = new RenderRunner(db, { cacheDir });
  runner.enqueue(job.id);
  const done = await runner.wait(job.id);
  if (done.state !== "completed") throw new ReelForgeError("INTERNAL", `render ${done.state}: ${done.error?.message ?? ""}`);
  return done;
}

export async function runWorkflow(db: Database, input: unknown, opts: RunOptions): Promise<WorkflowRun> {
  const spec = parseWorkflow(input);
  const runs = new WorkflowRunStore(db);
  const steps: WorkflowStepResult[] = spec.steps.map((s, index) => ({ index, kind: stepKind(s), status: "pending", detail: null, result: null }));
  const run = runs.start(spec.name, spec, steps, opts.actor, opts.source ?? null);
  opts.onStart?.(run.id);

  let projectId: string;
  try {
    if ("id" in spec.project) {
      projectId = new ProjectStore(db).get(spec.project.id).id;
    } else {
      const p = spec.project;
      projectId = new ProjectStore(db).create(
        { name: p.name, settings: { ...(p.width ? { width: p.width } : {}), ...(p.height ? { height: p.height } : {}), ...(p.fps ? { fps: parseFps(p.fps) } : {}) } },
        opts.actor,
      ).id;
    }
  } catch (e) {
    // No step ran: none is left looking as if it might still run.
    for (const st of steps) runs.updateStep(run.id, { ...st, status: "skipped" });
    return runs.finish(run.id, "failed", `project: ${e instanceof Error ? e.message : String(e)}`);
  }
  runs.setProject(run.id, projectId);
  return runSteps(db, spec, run.id, projectId, 0, opts);
}

/**
 * Continue a run that stopped at an AI Director step once its proposal has been decided (applied in
 * ReelForge, with `reelforge ai apply`, or over MCP). An applied proposal completes the step and the
 * remaining steps run; a rejected or stale one fails the run. `input` is the same workflow file: its
 * folder is where relative paths resolve from, and it must not have changed since the run started.
 */
export async function resumeWorkflow(db: Database, runId: string, input: unknown, opts: RunOptions): Promise<WorkflowRun> {
  const spec = parseWorkflow(input);
  const runs = new WorkflowRunStore(db);
  const run = runs.get(runId);
  if (run.status !== "waiting_approval") throw new ReelForgeError("VALIDATION_ERROR", `workflow run ${run.id} is ${run.status}; only a run waiting for approval can be resumed`);
  if (JSON.stringify(runs.spec(run.id)) !== JSON.stringify(spec)) {
    throw new ReelForgeError("VALIDATION_ERROR", "this workflow file is not the one the run started with (it changed since, or it is another file)");
  }
  const waiting = run.steps.find((x) => x.status === "waiting_approval");
  const proposalId = waiting?.result?.proposalId;
  if (!waiting || typeof proposalId !== "string" || !run.projectId) throw new ReelForgeError("VALIDATION_ERROR", `workflow run ${run.id} has no step waiting for approval`);
  const proposal = new ProposalStore(db).get(proposalId);
  if (proposal.status === "pending") {
    throw new ReelForgeError("VALIDATION_ERROR", `proposal ${proposal.id} is still waiting for your approval: review it in ReelForge (AI Director) or run \`reelforge ai apply ${proposal.id} --yes\`, then resume`, { proposalId: proposal.id });
  }
  if (!runs.reopen(run.id)) throw new ReelForgeError("VALIDATION_ERROR", `workflow run ${run.id} is already being resumed`);
  opts.onStart?.(run.id);
  if (proposal.status !== "applied") {
    const why = proposal.status === "rejected" ? "the proposal was rejected" : "the proposal went stale (the timeline changed before it was applied)";
    runs.updateStep(run.id, { ...waiting, status: "failed", detail: why });
    for (const later of run.steps.slice(waiting.index + 1)) runs.updateStep(run.id, { ...later, status: "skipped" });
    return runs.finish(run.id, "failed", `step ${waiting.index + 1} (director): ${why}`);
  }
  runs.updateStep(run.id, { ...waiting, status: "completed", detail: `applied: ${proposal.summary}`, result: { ...waiting.result, appliedRevision: proposal.appliedRevision } });
  return runSteps(db, spec, run.id, run.projectId, waiting.index + 1, opts);
}

async function runSteps(db: Database, spec: WorkflowSpec, runId: string, projectId: string, from: number, opts: RunOptions): Promise<WorkflowRun> {
  const runs = new WorkflowRunStore(db);
  const run = { id: runId };
  const steps: WorkflowStepResult[] = spec.steps.map((s, index) => ({ index, kind: stepKind(s), status: "pending", detail: null, result: null }));
  const set = (s: WorkflowStepResult) => runs.updateStep(run.id, s);
  const timeline = new TimelineStore(db);
  const apply = (ops: TimelineOp[], label: string) => {
    // Enforced here too, not only by callers: an unapproved run can never write to the timeline.
    if (opts.timelineEditsApproved === false) throw new ReelForgeError("VALIDATION_ERROR", `${label} needs the user's approval before it can change the timeline`);
    return timeline.apply(projectId, { baseRevision: timeline.get(projectId).project.revision, operations: ops }, opts.actor, { workflowRunId: run.id, step: label });
  };

  for (const [index, step] of spec.steps.entries()) {
    if (index < from) continue;
    if (opts.signal?.aborted) return runs.finish(run.id, "failed", "cancelled");
    const kind = stepKind(step);
    set({ index, kind, status: "running", detail: null, result: null });
    try {
      let detail = "";
      let result: Record<string, unknown> = {};
      if ("import" in step) {
        const files = await expandGlobs(step.import.paths, opts.baseDir, opts.globsApproved !== false);
        const r = await importMedia(db, projectId, files.paths, opts.actor);
        const more = r.failed.length > MAX_LISTED_FAILURES ? ` (and ${r.failed.length - MAX_LISTED_FAILURES} more)` : "";
        const failed = r.failed.slice(0, MAX_LISTED_FAILURES);
        if (!r.imported.length && !r.existing.length) throw new ReelForgeError("VALIDATION_ERROR", `nothing imported: ${failed.map((f) => `${f.path}: ${f.error.message}`).join("; ")}${more}`);
        detail = `${r.imported.length} imported${r.existing.length ? `, ${r.existing.length} already there` : ""}${r.failed.length ? `, ${r.failed.length} failed` : ""}${files.skipped ? `, ${files.skipped} non-media entries skipped` : ""}`;
        result = { assetIds: [...r.imported, ...r.existing].map((a) => a.id), failed, ...(more ? { failedCount: r.failed.length } : {}) };
      } else if ("analyze" in step) {
        const tl = timeline.get(projectId);
        const assets = step.analyze.assets?.length ? step.analyze.assets.map((ref) => findAsset(tl, ref)) : tl.assets;
        const store = new AnalysisStore(db);
        const ids = assets.flatMap((a) => {
          const applicable: AnalysisKind[] = [...(a.kind === "video" ? (["scenes"] as const) : []), ...(a.hasAudio ? (["beats", "transcript"] as const) : [])];
          const kinds = (step.analyze.kinds ?? applicable).filter((k) => applicable.includes(k));
          return kinds.length ? store.enqueue(projectId, a.id, kinds, step.analyze.language ? { language: step.analyze.language } : {}).map((x) => x.id) : [];
        });
        await runAnalyses(db, opts.cacheDir, ids);
        detail = `${ids.length} analyses`;
        result = { analysisIds: ids };
      } else if ("append" in step) {
        const tl = timeline.get(projectId);
        const asset = findAsset(tl, step.append.asset);
        const trackId = findTrack(tl, step.append.track);
        const start = tl.clips.filter((c) => c.trackId === trackId).reduce((m, c) => Math.max(m, clipEnd(c)), 0);
        const time = (v: string | number | undefined) => (v === undefined ? undefined : typeof v === "number" ? v : parseTime(v, tl.project.settings.fps));
        const op = resolveOperations(tl, [
          {
            type: "clip.add",
            trackId,
            assetId: asset.id,
            start,
            ...(step.append.duration !== undefined ? { duration: time(step.append.duration) } : {}),
            ...(step.append.sourceIn !== undefined ? { sourceIn: time(step.append.sourceIn) } : {}),
            ...(step.append.props ? { props: step.append.props } : {}),
          },
        ]);
        const after = apply(op, `append ${asset.filename}`);
        detail = `${asset.filename} → ${trackLabels(tl.tracks).get(trackId)} at ${start}`;
        result = { clipId: after.clips.find((c) => c.trackId === trackId && c.start === start)?.id };
      } else if ("edit" in step) {
        const ops = resolveOperations(timeline.get(projectId), step.edit.operations);
        const after = apply(ops, "edit");
        detail = `${ops.length} operation${ops.length === 1 ? "" : "s"}`;
        result = { revision: after.project.revision };
      } else if ("captions" in step) {
        const tl = timeline.get(projectId);
        const cfg = step.captions;
        const opts2 = {
          ...(cfg.source ? { sourceTrackIds: cfg.source.map((t) => findTrack(tl, t)) } : {}),
          ...(cfg.maxWords ? { maxWords: cfg.maxWords } : {}),
        };
        let plan = planCaptions(db, projectId, opts2);
        if (plan.missing.length) {
          const store = new AnalysisStore(db);
          await runAnalyses(db, opts.cacheDir, plan.missing.flatMap((m) => store.enqueue(projectId, m.assetId, ["transcript"], cfg.language ? { language: cfg.language } : {}).map((a) => a.id)));
          plan = planCaptions(db, projectId, opts2);
        }
        const ops: TimelineOp[] = [{ type: "captions.replace", trackId: plan.trackId, captions: plan.captions }];
        if (cfg.style) ops.push({ type: "track.update", trackId: plan.trackId, captionStyle: typeof cfg.style === "string" ? CAPTION_PRESETS[cfg.style] : cfg.style });
        apply(ops, "captions");
        detail = `${plan.captions.length} captions`;
        result = { count: plan.captions.length };
      } else if ("director" in step) {
        const provider = providerFor(step.director.provider ?? "ollama");
        const model = step.director.model ?? (provider.id === "anthropic" ? ANTHROPIC_DEFAULT_MODEL : await defaultOllamaModel());
        const requestedBy = opts.actor === "mcp" ? "mcp" : "user"; // an MCP client wrote this workflow
        const proposal = await propose(db, projectId, provider, { instruction: step.director.instruction, model, requestedBy }, opts.signal ? { signal: opts.signal } : {});
        result = { proposalId: proposal.id, summary: proposal.summary, warnings: proposal.warnings };
        if (!proposal.operations.length) {
          detail = `no changes: ${proposal.warnings.join(" ") || proposal.summary}`;
        } else if (opts.approveAi) {
          new ProposalStore(db).apply(proposal.id, { by: opts.actor, channel: "workflow:--approve-ai" });
          detail = `applied: ${proposal.summary}`;
        } else {
          set({ index, kind, status: "waiting_approval", detail: `review proposal ${proposal.id}: ${proposal.summary} (once applied, resume the run for the remaining steps)`, result });
          return runs.finish(run.id, "waiting_approval");
        }
      } else if ("preview" in step) {
        const job = await runRender(db, opts.cacheDir, projectId, "preview");
        detail = `preview ${job.outputPath}`;
        result = { jobId: job.id, path: job.outputPath };
      } else if ("render" in step) {
        const out = expandPath(step.render.out, opts.baseDir);
        if (extname(out).toLowerCase() !== ".mp4") throw new ReelForgeError("VALIDATION_ERROR", "export path must end in .mp4");
        if (existsSync(out)) throw new ReelForgeError("VALIDATION_ERROR", `${out} already exists; exports never overwrite`);
        // A recipe's own output folder (e.g. "out/") is created; folders outside the recipe's are not.
        if (opts.createOutputDirs && !existsSync(dirname(out)) && isInside(opts.baseDir, dirname(out))) mkdirSync(dirname(out), { recursive: true });
        const job = await runRender(db, opts.cacheDir, projectId, "export", out);
        detail = `rendered ${job.outputPath}`;
        result = { jobId: job.id, path: job.outputPath };
      }
      set({ index, kind, status: "completed", detail, result });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      set({ index, kind, status: "failed", detail: message, result: null });
      for (const later of steps.slice(index + 1)) set({ ...later, status: "skipped" });
      return runs.finish(run.id, "failed", `step ${index + 1} (${kind}): ${message}`);
    }
  }
  return runs.finish(run.id, "completed");
}

/** Read a workflow file (JSON, ≤1 MB). Relative paths inside it resolve from its folder. */
export function readWorkflowFile(path: string): { spec: WorkflowSpec; baseDir: string } {
  if (!path.toLowerCase().endsWith(".json")) throw new ReelForgeError("VALIDATION_ERROR", "a workflow is a .json file");
  let text: string;
  try {
    if (statSync(path).size > 1_000_000) throw new ReelForgeError("VALIDATION_ERROR", "workflow file is larger than 1 MB");
    text = readFileSync(path, "utf8");
  } catch (e) {
    if (e instanceof ReelForgeError) throw e;
    throw new ReelForgeError("NOT_FOUND", `can't read ${path}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new ReelForgeError("VALIDATION_ERROR", `${path} is not valid JSON`);
  }
  return { spec: parseWorkflow(json), baseDir: dirname(resolve(path)) };
}
