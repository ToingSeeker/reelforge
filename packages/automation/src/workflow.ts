// Workflow JSON: a repeatable recipe (import → analyse → assemble → captions →
// AI pass → render) run by the same engine as the editor. Steps written out in
// the file are approved by running it; an AI Director step still needs its
// own explicit approval (--approve-ai), otherwise the run stops for review.

import { existsSync, globSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import {
  ANALYSIS_KINDS,
  AnalysisStore,
  AssetStore,
  CAPTION_PRESETS,
  CaptionStylePatchSchema,
  clipEnd,
  parseFps,
  parseTime,
  planCaptions,
  ProjectStore,
  ProposalStore,
  ReelForgeError,
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
import { AnalysisRunner, createRenderJob, importMedia, RenderRunner } from "@reelforge/media";
import { ANTHROPIC_DEFAULT_MODEL, listOllamaModels, parseModelOutput, propose, providerFor } from "@reelforge/ai";

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

export function parseWorkflow(input: unknown): WorkflowSpec {
  const r = WorkflowSpecSchema.safeParse(input);
  if (!r.success) {
    throw new ReelForgeError("VALIDATION_ERROR", "invalid workflow", { issues: r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) });
  }
  return r.data;
}

const stepKind = (s: WorkflowStep) => Object.keys(s)[0]!;

/** Steps that change the timeline directly (director steps make proposals and are gated separately). */
export const TIMELINE_STEPS = new Set(["append", "edit", "captions"]);
export function timelineSteps(spec: WorkflowSpec): { index: number; kind: string }[] {
  return spec.steps.map((s, index) => ({ index, kind: stepKind(s) })).filter((x) => TIMELINE_STEPS.has(x.kind));
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
  signal?: AbortSignal;
  /** Called with the run id as soon as the run is recorded (for callers that don't wait). */
  onStart?: (runId: string) => void;
}

function expandPath(p: string, baseDir: string): string {
  const home = p === "~" || p.startsWith("~/") ? join(homedir(), p.slice(1)) : p;
  return isAbsolute(home) ? home : resolve(baseDir, home);
}

function expandGlobs(paths: string[], baseDir: string): string[] {
  return paths.flatMap((p) => {
    const abs = expandPath(p, baseDir);
    if (!/[*?[]/.test(abs)) return [abs];
    const hits = globSync(abs).sort();
    if (!hits.length) throw new ReelForgeError("VALIDATION_ERROR", `no files match ${p}`);
    return hits;
  });
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

const FRAME_KEYS = new Set(["start", "duration", "sourceIn", "frame"]);

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
  const set = (s: WorkflowStepResult) => runs.updateStep(run.id, s);

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
    return runs.finish(run.id, "failed", e instanceof Error ? e.message : String(e));
  }
  runs.setProject(run.id, projectId);

  const timeline = new TimelineStore(db);
  const apply = (ops: TimelineOp[], label: string) => {
    // Enforced here too, not only by callers: an unapproved run can never write to the timeline.
    if (opts.timelineEditsApproved === false) throw new ReelForgeError("VALIDATION_ERROR", `${label} needs the user's approval before it can change the timeline`);
    return timeline.apply(projectId, { baseRevision: timeline.get(projectId).project.revision, operations: ops }, opts.actor, { workflowRunId: run.id, step: label });
  };

  for (const [index, step] of spec.steps.entries()) {
    if (opts.signal?.aborted) return runs.finish(run.id, "failed", "cancelled");
    const kind = stepKind(step);
    set({ index, kind, status: "running", detail: null, result: null });
    try {
      let detail = "";
      let result: Record<string, unknown> = {};
      if ("import" in step) {
        const r = await importMedia(db, projectId, expandGlobs(step.import.paths, opts.baseDir), opts.actor);
        if (!r.imported.length && !r.existing.length) throw new ReelForgeError("VALIDATION_ERROR", `nothing imported: ${r.failed.map((f) => `${f.path}: ${f.error.message}`).join("; ")}`);
        detail = `${r.imported.length} imported${r.existing.length ? `, ${r.existing.length} already there` : ""}${r.failed.length ? `, ${r.failed.length} failed` : ""}`;
        result = { assetIds: [...r.imported, ...r.existing].map((a) => a.id), failed: r.failed };
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
        const model = step.director.model ?? (provider.id === "anthropic" ? ANTHROPIC_DEFAULT_MODEL : (await listOllamaModels()).models[0]);
        if (!model) throw new ReelForgeError("UNAVAILABLE", "no local model available in Ollama");
        const proposal = await propose(db, projectId, provider, { instruction: step.director.instruction, model }, opts.signal ? { signal: opts.signal } : {});
        result = { proposalId: proposal.id, summary: proposal.summary, warnings: proposal.warnings };
        if (!proposal.operations.length) {
          detail = `no changes: ${proposal.warnings.join(" ") || proposal.summary}`;
        } else if (opts.approveAi) {
          new ProposalStore(db).apply(proposal.id, { by: opts.actor, channel: "workflow:--approve-ai" });
          detail = `applied: ${proposal.summary}`;
        } else {
          set({ index, kind, status: "waiting_approval", detail: `review proposal ${proposal.id}: ${proposal.summary}`, result });
          return runs.finish(run.id, "waiting_approval");
        }
      } else if ("preview" in step) {
        const job = await runRender(db, opts.cacheDir, projectId, "preview");
        detail = `preview ${job.outputPath}`;
        result = { jobId: job.id, path: job.outputPath };
      } else if ("render" in step) {
        const out = expandPath(step.render.out, opts.baseDir);
        if (existsSync(out)) throw new ReelForgeError("VALIDATION_ERROR", `${out} already exists; exports never overwrite`);
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
