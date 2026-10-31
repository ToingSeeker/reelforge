import { parseArgs } from "node:util";
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  AnalysisStore,
  ANALYSIS_KINDS,
  AssetStore,
  buildProjectContext,
  captionsToSrt,
  isReelForgeError,
  JobStore,
  OPERATION_TYPES,
  planCaptions,
  ProposalStore,
  WorkflowRunStore,
  type AnalysisKind,
  openDatabase,
  parseFps,
  parseTime,
  ProjectStore,
  ReelForgeError,
  resolveCacheDir,
  resolveDbPath,
  resolveHome,
  TimelineStore,
  trackLabels,
  type Database,
  type ErrorCode,
  type TimelineOp,
} from "@reelforge/core";
import { ANTHROPIC_DEFAULT_MODEL, credentialSource, listOllamaModels, OllamaProvider, propose, providerFor, setCredential } from "@reelforge/ai";
import { AnalysisRunner, createRenderJob, importMedia, relinkMedia, RenderRunner, retryRenderJob } from "@reelforge/media";
import { startApiServer } from "@reelforge/server";
import { createMcpServer } from "@reelforge/mcp";
import { readWorkflowFile, runWorkflow } from "@reelforge/automation";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

// Every command prints exactly one JSON document to stdout (errors go to
// stderr as {"error": …}) so agents and scripts can parse the result.

const VERSION = "0.1.0-alpha.1";

const EXIT: Record<ErrorCode, number> = {
  INTERNAL: 1,
  VALIDATION_ERROR: 2,
  NOT_FOUND: 3,
  REVISION_CONFLICT: 4,
  UNAUTHORIZED: 5,
  UNAVAILABLE: 6,
  CONSENT_REQUIRED: 7,
};

const USAGE = `reelforge ${VERSION} — AI-native video editing engine

Usage:
  reelforge info
  reelforge project list | get <id> | history <id>
  reelforge project create --name <name> [--width 1080] [--height 1920] [--fps 30]
  reelforge project rename <id> --name <name> --base-revision <n>

  reelforge media import <project> <file>...
  reelforge media list <project>
  reelforge media relink <project> <asset> <file>

  reelforge timeline get <project>
  reelforge timeline apply <project> (--ops '<json array>' | --ops-file <file|->) [--base-revision <n>]
  reelforge timeline undo|redo <project> [--base-revision <n>]

  reelforge clip add <project> --track <V1|A1|id> --asset <id> --start <t> [--in <t>] [--duration <t>]
  reelforge clip move <project> <clip> --start <t> [--track <V1|id>]
  reelforge clip trim <project> <clip> --edge start|end --at <t>
  reelforge clip split <project> <clip> --at <t>
  reelforge clip delete <project> <clip>... [--ripple]
  reelforge clip set <project> <clip> --props '{"opacity":0.5,"fadeIn":15,"transitionIn":10,"gainDb":-6}'
                   (also on clip add; fields: fit scale scaleEnd x y xEnd yEnd rotation opacity crop* fadeIn fadeOut transitionIn gainDb
                    blur sharpen vignette grayscale sepia grain)

  reelforge media analyze <project> <asset> [--kinds scenes,beats,transcript] [--language auto|id|en…]
  reelforge media analysis <project> <asset>
  reelforge captions generate <project> [--track C1] [--source A1,A2] [--max-words 3] [--language auto]
  reelforge captions srt <project> [--track C1] [--out file.srt]
  reelforge project context <project>          (structured view for AI planners)

  reelforge ai providers
  reelforge ai propose <project> "<instruction>" [--provider ollama|anthropic] [--model <id>] [--selection <clip>,…]
  reelforge ai proposals <project> | ai show <proposal>
  reelforge ai apply <proposal> --yes          (your approval; never automatic)
  reelforge ai reject <proposal>
  reelforge ai consent <project> --grant|--revoke   (allow sending this project's context to an external provider)

  reelforge render <project> --out <file.mp4>      (H.264/AAC at project size; never overwrites)
  reelforge preview <project>                      (low-res render of the same graph, from proxies)
  reelforge jobs list <project> | get <job> | cancel <job> | retry <job> [--wait]

  reelforge workflow run <file.json> [--approve-ai]   (repeatable recipe; --approve-ai also applies AI Director steps)
  reelforge workflow validate <file.json> | workflow runs [--project <id>]
  reelforge mcp                                (MCP server on stdio, for Claude, ChatGPT, Gemini CLI…)

  reelforge serve [--port 0] [--allow-origin <origin>]... [--token-stdin]

Times <t>: frames (90), seconds (2.5s), timecode (00:00:03:00) or MM:SS.FF (00:03.10).
Edits accept --base-revision for strict conflict detection; without it the
current revision is used, so the edit applies unless it is invalid.

Global options:
  --home <dir>   workspace directory (default: $REELFORGE_HOME or the OS app-data dir)
  --pretty       indent JSON output (default when stdout is a terminal)
  -h, --help     show this help

Exit codes: 0 ok, 1 internal, 2 invalid input, 3 not found, 4 revision conflict, 6 dependency unavailable.
`;

interface Io {
  out: (s: string) => void;
  err: (s: string) => void;
  isTTY: boolean;
  env: NodeJS.ProcessEnv;
  cwd?: string;
  stdin?: () => string;
  /** Human progress lines on stderr. Only for terminals: scripts and agents get a clean single JSON error stream. */
  progress?: boolean;
}

const defaultIo: Io = {
  out: (s) => process.stdout.write(s),
  err: (s) => process.stderr.write(s),
  isTTY: Boolean(process.stdout.isTTY),
  env: process.env,
  stdin: () => readFileSync(0, "utf8"),
  progress: Boolean(process.stderr.isTTY),
};

const OPTIONS = {
  home: { type: "string" },
  pretty: { type: "boolean" },
  help: { type: "boolean", short: "h" },
  name: { type: "string" },
  width: { type: "string" },
  height: { type: "string" },
  fps: { type: "string" },
  "base-revision": { type: "string" },
  port: { type: "string" },
  "allow-origin": { type: "string", multiple: true },
  "token-stdin": { type: "boolean" },
  ops: { type: "string" },
  "ops-file": { type: "string" },
  track: { type: "string" },
  asset: { type: "string" },
  start: { type: "string" },
  in: { type: "string" },
  duration: { type: "string" },
  at: { type: "string" },
  edge: { type: "string" },
  ripple: { type: "boolean" },
  out: { type: "string" },
  props: { type: "string" },
  kinds: { type: "string" },
  language: { type: "string" },
  source: { type: "string" },
  "max-words": { type: "string" },
  provider: { type: "string" },
  model: { type: "string" },
  selection: { type: "string" },
  yes: { type: "boolean" },
  grant: { type: "boolean" },
  "approve-ai": { type: "boolean" },
  project: { type: "string" },
  revoke: { type: "boolean" },
  wait: { type: "boolean" },
} as const;

type Values = ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>>["values"];

function invalid(message: string): never {
  throw new ReelForgeError("VALIDATION_ERROR", message);
}

function int(flag: string, v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  if (!/^-?\d+$/.test(v)) invalid(`--${flag} must be an integer`);
  return Number(v);
}

function need<T>(v: T | undefined, what: string): T {
  if (v === undefined || v === "") invalid(`missing ${what}`);
  return v;
}

function rangeToValidation<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof RangeError) invalid(e.message);
    throw e;
  }
}

export async function main(argv: string[], io: Io = defaultIo): Promise<number> {
  let pretty = io.isTTY;
  const print = (v: unknown) => io.out(JSON.stringify(v, null, pretty ? 2 : 0) + "\n");

  try {
    const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, strict: true, options: OPTIONS });
    if (values.pretty) pretty = true;
    const [cmd, sub, ...rest] = positionals;

    if (values.help || !cmd) {
      io.out(USAGE);
      return values.help ? 0 : EXIT.VALIDATION_ERROR;
    }

    const env = values.home ? { ...io.env, REELFORGE_HOME: values.home } : io.env;

    if (cmd === "info") {
      print({ version: VERSION, home: resolveHome(env), database: resolveDbPath(env), cache: resolveCacheDir(env) });
      return 0;
    }
    if (cmd === "serve") return await serve(env, values, io);
    if (cmd === "mcp") return await mcp(env);

    if (cmd === "render" || cmd === "preview") {
      const db = openDatabase(resolveDbPath(env));
      try {
        const job = await runJob(db, env, io, (sub ? [sub, ...rest] : rest)[0], cmd === "render" ? "export" : "preview", values.out);
        print({ job });
        return job.state === "completed" ? 0 : job.error?.code === "MEDIA_OFFLINE" || job.state === "cancelled" ? EXIT.VALIDATION_ERROR : EXIT.INTERNAL;
      } finally {
        db.close();
      }
    }
    if (cmd === "workflow" && sub === "run") {
      const db = openDatabase(resolveDbPath(env));
      try {
        const { spec, baseDir } = readWorkflowFile(resolve(io.cwd ?? process.cwd(), need(rest[0], "<file.json>")));
        const run = await runWorkflow(db, spec, { cacheDir: resolveCacheDir(env), actor: "cli", baseDir, source: rest[0]!, approveAi: !!values["approve-ai"], createOutputDirs: true });
        print({ run });
        return run.status === "completed" ? 0 : run.status === "waiting_approval" ? 0 : EXIT.INTERNAL;
      } finally {
        db.close();
      }
    }
    if (cmd === "ai" && (sub === "propose" || sub === "providers")) {
      const db = openDatabase(resolveDbPath(env));
      try {
        print(sub === "providers" ? await providersInfo() : await proposeInline(db, rest, values));
        return 0;
      } finally {
        db.close();
      }
    }
    if ((cmd === "media" && sub === "analyze") || (cmd === "captions" && sub === "generate")) {
      const db = openDatabase(resolveDbPath(env));
      try {
        print(cmd === "media" ? await analyzeInline(db, env, io, rest, values) : await captionsInline(db, env, io, rest, values));
        return 0;
      } finally {
        db.close();
      }
    }
    if (cmd === "jobs" && sub === "retry" && values.wait) {
      const db = openDatabase(resolveDbPath(env));
      try {
        const job = retryRenderJob(db, need(rest[0], "<job>"));
        const done = await runQueued(db, env, io, job.id);
        print({ job: done });
        return done.state === "completed" ? 0 : EXIT.INTERNAL;
      } finally {
        db.close();
      }
    }

    const handler = COMMANDS[`${cmd} ${sub ?? ""}`];
    if (!handler) invalid(`unknown command "${[cmd, sub].filter(Boolean).join(" ")}" (see --help)`);

    const db = openDatabase(resolveDbPath(env));
    try {
      print(await handler({ db, values, args: rest, io }));
      return 0;
    } finally {
      db.close();
    }
  } catch (e) {
    const err = isReelForgeError(e)
      ? e
      : e instanceof Error && "code" in e && String(e.code).startsWith("ERR_PARSE_ARGS")
        ? new ReelForgeError("VALIDATION_ERROR", e.message)
        : new ReelForgeError("INTERNAL", e instanceof Error ? e.message : String(e));
    io.err(JSON.stringify({ error: err.toJSON() }, null, pretty ? 2 : 0) + "\n");
    return EXIT[err.code];
  }
}

interface Ctx {
  db: Database;
  values: Values;
  args: string[];
  io: Io;
}

/** Apply ops at --base-revision, or at the current revision when none is given. */
function edit(ctx: Ctx, projectId: string, operations: TimelineOp[]) {
  const timeline = new TimelineStore(ctx.db);
  const baseRevision = int("base-revision", ctx.values["base-revision"]) ?? timeline.get(projectId).project.revision;
  return { timeline: timeline.apply(projectId, { baseRevision, operations }, "cli") };
}

function projectFps(ctx: Ctx, projectId: string) {
  return new ProjectStore(ctx.db).get(projectId).settings.fps;
}

function time(ctx: Ctx, projectId: string, v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  const fps = projectFps(ctx, projectId);
  return rangeToValidation(() => parseTime(v, fps));
}

/** Accept a track id or an editor label (V1, A2, C1). */
function trackId(ctx: Ctx, projectId: string, ref: string): string {
  const tracks = new TimelineStore(ctx.db).get(projectId).tracks;
  if (tracks.some((t) => t.id === ref)) return ref;
  const labels = trackLabels(tracks);
  for (const [id, label] of labels) if (label === ref.toUpperCase()) return id;
  invalid(`unknown track "${ref}" (have ${[...labels.values()].join(", ")})`);
}

const COMMANDS: Record<string, (ctx: Ctx) => unknown> = {
  "project list": ({ db }) => ({ projects: new ProjectStore(db).list() }),
  "project create": ({ db, values }) => ({
    project: new ProjectStore(db).create(
      {
        name: need(values.name, "--name"),
        settings: {
          ...(values.width !== undefined ? { width: int("width", values.width) } : {}),
          ...(values.height !== undefined ? { height: int("height", values.height) } : {}),
          ...(values.fps !== undefined ? { fps: rangeToValidation(() => parseFps(values.fps!)) } : {}),
        },
      },
      "cli",
    ),
  }),
  "project get": ({ db, args }) => ({ project: new ProjectStore(db).get(need(args[0], "<project>")) }),
  "project rename": ({ db, args, values }) => ({
    project: new ProjectStore(db).rename(
      need(args[0], "<project>"),
      { name: need(values.name, "--name"), baseRevision: need(int("base-revision", values["base-revision"]), "--base-revision") },
      "cli",
    ),
  }),
  "project history": ({ db, args }) => ({ operations: new ProjectStore(db).history(need(args[0], "<project>")) }),

  "media import": async ({ db, args, io }) => {
    const [projectId, ...files] = args;
    if (!files.length) invalid("missing <file>...");
    const cwd = io.cwd ?? process.cwd();
    return importMedia(db, need(projectId, "<project>"), files.map((f) => resolve(cwd, f)), "cli");
  },
  "media list": ({ db, args }) => ({ assets: new AssetStore(db).list(need(args[0], "<project>")) }),
  "media relink": async ({ db, args, io }) => ({
    asset: await relinkMedia(db, need(args[0], "<project>"), need(args[1], "<asset>"), resolve(io.cwd ?? process.cwd(), need(args[2], "<file>")), "cli"),
  }),

  "timeline get": ({ db, args }) => ({ timeline: new TimelineStore(db).get(need(args[0], "<project>")) }),
  "timeline apply": (ctx) => {
    const { values, io } = ctx;
    const raw =
      values.ops ??
      (values["ops-file"] === "-" ? io.stdin?.() : values["ops-file"] ? readFileSync(resolve(io.cwd ?? process.cwd(), values["ops-file"]), "utf8") : undefined);
    if (raw === undefined) invalid("provide --ops '<json>' or --ops-file <file|->");
    let ops: unknown;
    try {
      ops = JSON.parse(raw);
    } catch {
      invalid("operations are not valid JSON");
    }
    return edit(ctx, need(ctx.args[0], "<project>"), (Array.isArray(ops) ? ops : [ops]) as TimelineOp[]);
  },
  "timeline undo": (ctx) => history(ctx, "undo"),
  "timeline redo": (ctx) => history(ctx, "redo"),

  "clip add": (ctx) => {
    const p = need(ctx.args[0], "<project>");
    const v = ctx.values;
    const duration = time(ctx, p, v.duration);
    const sourceIn = time(ctx, p, v.in);
    return edit(ctx, p, [
      {
        type: "clip.add",
        trackId: trackId(ctx, p, need(v.track, "--track")),
        assetId: need(v.asset, "--asset"),
        start: need(time(ctx, p, v.start), "--start"),
        ...(sourceIn !== undefined ? { sourceIn } : {}),
        ...(duration !== undefined ? { duration } : {}),
        ...(v.props !== undefined ? { props: propsFlag(v.props) } : {}),
      } as TimelineOp,
    ]);
  },
  "clip move": (ctx) => {
    const p = need(ctx.args[0], "<project>");
    return edit(ctx, p, [
      {
        type: "clip.move",
        clipId: need(ctx.args[1], "<clip>"),
        start: need(time(ctx, p, ctx.values.start), "--start"),
        ...(ctx.values.track ? { trackId: trackId(ctx, p, ctx.values.track) } : {}),
      },
    ]);
  },
  "clip trim": (ctx) => {
    const p = need(ctx.args[0], "<project>");
    const edge = need(ctx.values.edge, "--edge");
    if (edge !== "start" && edge !== "end") invalid("--edge must be start or end");
    return edit(ctx, p, [{ type: "clip.trim", clipId: need(ctx.args[1], "<clip>"), edge, frame: need(time(ctx, p, ctx.values.at), "--at") }]);
  },
  "clip split": (ctx) => {
    const p = need(ctx.args[0], "<project>");
    return edit(ctx, p, [{ type: "clip.split", clipId: need(ctx.args[1], "<clip>"), frame: need(time(ctx, p, ctx.values.at), "--at") }]);
  },
  "clip set": (ctx) => {
    const p = need(ctx.args[0], "<project>");
    return edit(ctx, p, [{ type: "clip.update", clipId: need(ctx.args[1], "<clip>"), props: need(propsFlag(ctx.values.props), "--props") } as TimelineOp]);
  },
  "media analysis": ({ db, args }) => ({ analyses: new AnalysisStore(db).list(need(args[0], "<project>"), need(args[1], "<asset>")) }),
  "project context": ({ db, args }) => {
    const id = need(args[0], "<project>");
    return { context: buildProjectContext(new TimelineStore(db).get(id), new AnalysisStore(db).forProject(id), OPERATION_TYPES) };
  },
  "captions srt": (ctx) => {
    const projectId = need(ctx.args[0], "<project>");
    const tl = new TimelineStore(ctx.db).get(projectId);
    const track = ctx.values.track ? trackId(ctx, projectId, ctx.values.track) : tl.tracks.find((t) => t.kind === "caption")?.id;
    const srt = captionsToSrt(tl.captions.filter((c) => c.trackId === track), tl.project.settings.fps);
    if (ctx.values.out) {
      const out = resolve(ctx.io.cwd ?? process.cwd(), ctx.values.out);
      try {
        writeFileSync(out, srt, { flag: "wx" }); // never overwrite
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "EEXIST") invalid(`${out} already exists`);
        throw e;
      }
      return { path: out, captions: srt ? srt.split("\n\n").length : 0 };
    }
    return { srt };
  },
  "workflow validate": ({ args, io }) => {
    const { spec } = readWorkflowFile(resolve(io.cwd ?? process.cwd(), need(args[0], "<file.json>")));
    return { valid: true, name: spec.name, steps: spec.steps.map((s) => Object.keys(s)[0]) };
  },
  "workflow runs": ({ db, values }) => ({ runs: new WorkflowRunStore(db).list(values.project ? { projectId: values.project } : {}) }),
  "ai proposals": ({ db, args }) => ({ proposals: new ProposalStore(db).list(need(args[0], "<project>")) }),
  "ai show": ({ db, args }) => ({ proposal: new ProposalStore(db).get(need(args[0], "<proposal>")) }),
  "ai apply": ({ db, args, values }) => {
    // The approval is the person typing --yes; nothing an AI writes can stand in for it.
    if (!values.yes) invalid("applying a proposal needs your approval: re-run with --yes after reviewing `reelforge ai show`");
    return new ProposalStore(db).apply(need(args[0], "<proposal>"), { by: "cli", channel: "cli:--yes" });
  },
  "ai reject": ({ db, args }) => ({ proposal: new ProposalStore(db).reject(need(args[0], "<proposal>"), "cli") }),
  "ai consent": ({ db, args, values }) => {
    if (values.grant === values.revoke) invalid("use exactly one of --grant or --revoke");
    return { consent: new ProposalStore(db).setConsent(need(args[0], "<project>"), !!values.grant, "cli") };
  },
  "jobs list": ({ db, args }) => ({ jobs: new JobStore(db).list(need(args[0], "<project>")) }),
  "jobs get": ({ db, args }) => ({ job: new JobStore(db).get(need(args[0], "<job>")) }),
  "jobs cancel": ({ db, args }) => ({ job: new JobStore(db).cancel(need(args[0], "<job>")) }),
  "jobs retry": ({ db, args }) => ({ job: retryRenderJob(db, need(args[0], "<job>")), note: "queued; a running engine (reelforge serve / desktop) picks it up, or use --wait to render here" }),
  "clip delete": (ctx) => {
    const [p, ...clipIds] = ctx.args;
    if (!clipIds.length) invalid("missing <clip>...");
    return edit(ctx, need(p, "<project>"), [{ type: "clip.delete", clipIds, ...(ctx.values.ripple ? { ripple: true } : {}) }]);
  },
};

async function providersInfo() {
  const ollama = await listOllamaModels();
  return {
    providers: [
      { id: "anthropic", external: true, credential: credentialSource("anthropic"), defaultModel: ANTHROPIC_DEFAULT_MODEL },
      { id: "ollama", external: new OllamaProvider().external, available: ollama.available, models: ollama.models },
    ],
  };
}

async function proposeInline(db: Database, args: string[], values: Values) {
  const [projectId, ...words] = args;
  const instruction = words.join(" ");
  if (!instruction) invalid('missing "<instruction>"');
  const provider = providerFor(values.provider ?? "anthropic");
  const model = values.model ?? (provider.id === "anthropic" ? ANTHROPIC_DEFAULT_MODEL : (await listOllamaModels()).models[0]);
  if (!model) throw new ReelForgeError("UNAVAILABLE", "no local model available in Ollama");
  const proposal = await propose(db, need(projectId, "<project>"), provider, { instruction, model, selection: values.selection?.split(",").map((x) => x.trim()).filter(Boolean) ?? [] });
  return { proposal, next: proposal.operations.length ? `review it, then: reelforge ai apply ${proposal.id} --yes` : "nothing to apply" };
}

async function runAnalyses(db: Database, env: NodeJS.ProcessEnv, io: Io, ids: string[]) {
  const runner = new AnalysisRunner(db, { cacheDir: resolveCacheDir(env) });
  const store = new AnalysisStore(db);
  const timer = setInterval(() => {
    if (!io.progress) return;
    for (const id of ids) {
      const a = store.get(id);
      if (a.state === "running") io.err(`[reelforge] ${a.kind} ${Math.round(a.progress * 100)}%\n`);
    }
  }, 1000);
  try {
    for (const id of ids) runner.enqueue(id);
    return await Promise.all(ids.map((id) => runner.wait(id)));
  } finally {
    clearInterval(timer);
  }
}

async function analyzeInline(db: Database, env: NodeJS.ProcessEnv, io: Io, args: string[], values: Values) {
  const [projectId, assetId] = args;
  const kinds = (values.kinds?.split(",").map((k) => k.trim()) ?? [...ANALYSIS_KINDS]) as AnalysisKind[];
  const queued = new AnalysisStore(db).enqueue(need(projectId, "<project>"), need(assetId, "<asset>"), kinds, values.language ? { language: values.language } : {});
  const done = await runAnalyses(db, env, io, queued.map((a) => a.id));
  const failed = done.filter((a) => a.state === "failed");
  if (failed.length === done.length) throw new ReelForgeError("INTERNAL", failed.map((a) => `${a.kind}: ${a.error}`).join("; "));
  return { analyses: done };
}

async function captionsInline(db: Database, env: NodeJS.ProcessEnv, io: Io, args: string[], values: Values) {
  const projectId = need(args[0], "<project>");
  const opts = {
    ...(values.track ? { trackId: trackId({ db, values, args, io }, projectId, values.track) } : {}),
    ...(values.source ? { sourceTrackIds: values.source.split(",").map((t) => trackId({ db, values, args, io }, projectId, t.trim())) } : {}),
    ...(values["max-words"] ? { maxWords: need(int("max-words", values["max-words"]), "--max-words") } : {}),
  };
  let plan = planCaptions(db, projectId, opts);
  if (plan.missing.length) {
    // Transcribe what's missing here, then plan again.
    const store = new AnalysisStore(db);
    const ids = plan.missing.flatMap((m) => store.enqueue(projectId, m.assetId, ["transcript"], values.language ? { language: values.language } : {}).map((a) => a.id));
    const done = await runAnalyses(db, env, io, ids);
    const failed = done.find((a) => a.state === "failed");
    if (failed) throw new ReelForgeError("INTERNAL", `transcription failed: ${failed.error}`);
    plan = planCaptions(db, projectId, opts);
  }
  const timeline = new TimelineStore(db);
  const baseRevision = int("base-revision", values["base-revision"]) ?? timeline.get(projectId).project.revision;
  const tl = timeline.apply(projectId, { baseRevision, operations: [{ type: "captions.replace", trackId: plan.trackId, captions: plan.captions }] }, "cli");
  return { count: plan.captions.length, captions: tl.captions.filter((c) => c.trackId === plan.trackId) };
}

/** Render in this process, reporting progress on stderr. Ctrl+C cancels the job. */
async function runJob(db: Database, env: NodeJS.ProcessEnv, io: Io, projectId: string | undefined, kind: "export" | "preview", out: string | undefined) {
  if (kind === "export" && !out) invalid("missing --out <file.mp4>");
  const cwd = io.cwd ?? process.cwd();
  const job = createRenderJob(db, need(projectId, "<project>"), kind, out ? resolve(cwd, out) : undefined);
  return runQueued(db, env, io, job.id);
}

async function runQueued(db: Database, env: NodeJS.ProcessEnv, io: Io, jobId: string) {
  const runner = new RenderRunner(db, { cacheDir: resolveCacheDir(env) });
  const jobs = new JobStore(db);
  const onSigint = () => runner.cancel(jobId);
  process.once("SIGINT", onSigint);
  let last = "";
  const timer = setInterval(() => {
    if (!io.progress) return;
    const j = jobs.get(jobId);
    const line = `${j.state} ${Math.round(j.progress * 100)}%`;
    if (line !== last) io.err(`[reelforge] ${line}\n`);
    last = line;
  }, 500);
  try {
    runner.enqueue(jobId);
    return await runner.wait(jobId);
  } finally {
    clearInterval(timer);
    process.removeListener("SIGINT", onSigint);
  }
}

function propsFlag(v: string | undefined): Record<string, unknown> | undefined {
  if (v === undefined) return undefined;
  try {
    const p = JSON.parse(v) as unknown;
    if (p && typeof p === "object" && !Array.isArray(p)) return p as Record<string, unknown>;
  } catch {
    /* fall through */
  }
  invalid('--props must be a JSON object, e.g. \'{"opacity":0.5}\'');
}

function history(ctx: Ctx, dir: "undo" | "redo") {
  const projectId = need(ctx.args[0], "<project>");
  const timeline = new TimelineStore(ctx.db);
  const baseRevision = int("base-revision", ctx.values["base-revision"]) ?? timeline.get(projectId).project.revision;
  return { timeline: timeline[dir](projectId, { baseRevision }, "cli") };
}

/** MCP over stdio: stdout carries the protocol, so nothing else may be printed there. */
async function mcp(env: NodeJS.ProcessEnv): Promise<number> {
  const db = openDatabase(resolveDbPath(env));
  const { server, close } = createMcpServer(db, { cacheDir: resolveCacheDir(env) });
  const transport = new StdioServerTransport();
  const closed = new Promise<void>((resolve) => {
    transport.onclose = () => resolve();
    process.stdin.once("end", () => resolve());
  });
  await server.connect(transport);
  await closed;
  await close();
  await server.close().catch(() => {});
  db.close();
  return 0;
}

async function serve(env: NodeJS.ProcessEnv, values: Values, io: Io): Promise<number> {
  // The desktop shell sends API keys from the OS keychain as JSON lines; they stay in memory only.
  // With --token-stdin the first line carries the engine token, so it is never in the environment
  // (where child processes inherit it and `ps -E` shows it).
  let gotToken: (token: string) => void = () => {};
  const tokenLine = new Promise<string | null>((resolve) => {
    gotToken = resolve;
    process.stdin.once("end", () => resolve(null)); // parent gone before sending it
  });
  let buf = "";
  const onData = (chunk: Buffer) => {
    buf += chunk.toString("utf8");
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line) as { type?: string; provider?: string; apiKey?: string | null; token?: string };
        if (msg.type === "credential" && typeof msg.provider === "string") setCredential(msg.provider, msg.apiKey ?? null);
        else if (msg.type === "token" && typeof msg.token === "string" && msg.token.length >= 32) gotToken(msg.token);
      } catch {
        io.err("[reelforge-server] ignored a malformed control line on stdin\n");
      }
    }
  };
  process.stdin.on("data", onData);
  process.stdin.resume();

  // Standalone runs get a fresh token; an env token (older shells, scripts) is read once and removed
  // so FFmpeg/whisper children don't inherit it.
  const provided = values["token-stdin"] ? await tokenLine : env.REELFORGE_API_TOKEN;
  delete process.env.REELFORGE_API_TOKEN;
  if (values["token-stdin"] && !provided) {
    io.err("[reelforge-server] --token-stdin: stdin closed before a token line arrived\n");
    return 1;
  }
  const token = provided ?? randomBytes(32).toString("base64url");
  const db = openDatabase(resolveDbPath(env));
  const srv = await startApiServer({
    db,
    token,
    cacheDir: resolveCacheDir(env),
    port: int("port", values.port) ?? 0,
    allowedOrigins: values["allow-origin"] ?? [],
    ...(env.REELFORGE_DEBUG ? { log: (line: string) => io.err(`[reelforge-server] ${line}\n`) } : {}),
  });
  // One machine-readable line; the sidecar parent waits for it.
  io.out(JSON.stringify({ event: "ready", url: srv.url, ...(provided ? {} : { token }) }) + "\n");

  await new Promise<void>((resolve) => {
    const stop = () => resolve();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    // When the parent (desktop app) dies, stdin closes: exit instead of lingering.
    process.stdin.once("end", stop);
  });
  // stdin was only a liveness signal; release it or it keeps the event loop alive.
  process.stdin.destroy();
  await srv.close();
  db.close();
  return 0;
}
