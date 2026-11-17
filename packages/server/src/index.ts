import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { createReadStream, statSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import {
  ActorSchema,
  AnalysisStore,
  ANALYSIS_KINDS,
  AssetStore,
  buildProjectContext,
  buildRenderPlan,
  CAPTION_FONTS,
  captionsToSrt,
  CreateMotionInputSchema,
  isReelForgeError,
  MotionGraphicStore,
  motionRenderSpec,
  parse,
  JobStore,
  OPERATION_TYPES,
  ProposalStore,
  WorkflowRunStore,
  planCaptions,
  planSpeechCaptions,
  type AnalysisKind,
  ProjectStore,
  ReelForgeError,
  TimelineStore,
  type Actor,
  type Database,
  type ErrorCode,
} from "@reelforge/core";
import { ANTHROPIC_DEFAULT_MODEL, CLAUDE_CODE_MODELS, claudeBinary, codexBinary, consentRecipient, credentialSource, defaultModelFor, listCodexModels, listOllamaModels, OllamaProvider, propose, providerFor } from "@reelforge/ai";
import { readWorkflowFile, runWorkflow } from "@reelforge/automation";
import {
  AnalysisRunner,
  bakePath,
  createRenderJob,
  ensureProxy,
  ensureThumbnail,
  expandFolders,
  fontsDir,
  fxAvailable,
  FxBaker,
  importMedia,
  motionAvailable,
  MotionRenderer,
  relinkMedia,
  RenderRunner,
  retryRenderJob,
} from "@reelforge/media";
import { dirname, join } from "node:path";

// Local REST API (PRD §15). Loopback only, bearer token always required,
// Host/Origin checked so a web page can't reach it via DNS rebinding.

export interface ApiServerOptions {
  db: Database;
  token: string;
  /** 0 picks a free port. */
  port?: number;
  /** Browser origins allowed to call the API (the desktop webview). */
  allowedOrigins?: readonly string[];
  /** Where derived files (thumbnails) are cached. */
  cacheDir: string;
  /** Files the engine makes that projects reference (motion graphics); not disposable. Default: next to the cache. */
  generatedDir?: string;
  /** Optional access log (method, path, status, origin). Never logs headers or bodies. */
  log?: (line: string) => void;
  /** The Claude.ai / ChatGPT connector, run by the same process (`reelforge serve` passes one). */
  connector?: ConnectorControl;
}

/** What Settings needs from the remote connector (implemented by ConnectorManager in @reelforge/mcp). */
export interface ConnectorControl {
  status(): unknown;
  start(input: { tunnel?: "ngrok" | "none"; domain?: string | null; publicUrl?: string | null }): Promise<unknown>;
  stop(): Promise<unknown>;
  rotateKey(): unknown;
  revokeAll(): unknown;
}

export interface RunningServer {
  url: string;
  port: number;
  server: Server;
  close(): Promise<void>;
}

const MAX_BODY_BYTES = 64 * 1024;

const STATUS: Record<ErrorCode, number> = {
  VALIDATION_ERROR: 400,
  UNAUTHORIZED: 401,
  UNAVAILABLE: 503,
  CONSENT_REQUIRED: 403,
  NOT_FOUND: 404,
  REVISION_CONFLICT: 409,
  INTERNAL: 500,
};

function send(res: ServerResponse, status: number, body: unknown) {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(json);
}

function sendError(res: ServerResponse, err: ReelForgeError) {
  send(res, STATUS[err.code], { error: err.toJSON() });
}

function sameToken(given: string, token: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

function tokenMatches(header: string | undefined, token: string): boolean {
  const m = /^Bearer (.+)$/.exec(header ?? "");
  return !!m?.[1] && sameToken(m[1], token);
}

/**
 * Stream a file, honouring a single byte Range so <video>/<audio> can seek
 * without downloading everything first.
 */
function sendFile(req: IncomingMessage, res: ServerResponse, path: string, contentType: string) {
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    throw new ReelForgeError("NOT_FOUND", "file is no longer on disk");
  }
  const headers = { "content-type": contentType, "accept-ranges": "bytes", "cache-control": "private, max-age=3600", "x-content-type-options": "nosniff" };
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "");
  if (range && (range[1] || range[2])) {
    const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
    const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (start > end || start >= size) {
      res.writeHead(416, { "content-range": `bytes */${size}` });
      return res.end();
    }
    res.writeHead(206, { ...headers, "content-range": `bytes ${start}-${end}/${size}`, "content-length": String(end - start + 1) });
    return createReadStream(path, { start, end }).pipe(res);
  }
  res.writeHead(200, { ...headers, "content-length": String(size) });
  createReadStream(path).pipe(res);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const type = req.headers["content-type"] ?? "";
  if (!type.startsWith("application/json")) {
    throw new ReelForgeError("VALIDATION_ERROR", "content-type must be application/json");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new ReelForgeError("VALIDATION_ERROR", "request body too large");
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw new ReelForgeError("VALIDATION_ERROR", "request body is not valid JSON");
  }
}

interface RouteContext {
  req: IncomingMessage;
  res: ServerResponse;
  params: string[];
  actor: Actor;
}

interface Route {
  method: string;
  pattern: RegExp;
  handle: (ctx: RouteContext) => unknown;
  /** Read-only media endpoint that also accepts ?token= (for media elements). */
  media?: boolean;
}

const re = (path: string) => new RegExp(`^${path}$`);

function actorOf(req: IncomingMessage): Actor {
  const parsed = ActorSchema.safeParse(req.headers["x-reelforge-actor"] ?? "api");
  return parsed.success ? parsed.data : "api";
}

export function startApiServer(opts: ApiServerOptions): Promise<RunningServer> {
  if (opts.token.length < 32) throw new Error("API token must be at least 32 characters");
  const projects = new ProjectStore(opts.db);
  const assets = new AssetStore(opts.db);
  const timeline = new TimelineStore(opts.db);
  const jobs = new JobStore(opts.db);
  // One baker for AI effects, shared by the live preview and exports, so a bake runs once.
  const fxBaker = new FxBaker(opts.cacheDir);
  const runner = new RenderRunner(opts.db, { cacheDir: opts.cacheDir, fxBaker });
  runner.start();
  const analyses = new AnalysisStore(opts.db);
  const analysisRunner = new AnalysisRunner(opts.db, { cacheDir: opts.cacheDir });
  analysisRunner.start();
  const analyze = (projectId: string, assetId: string, kinds: AnalysisKind[], params: Record<string, unknown>) => {
    const queued = analyses.enqueue(projectId, assetId, kinds, params);
    for (const a of queued) if (a.state === "queued") analysisRunner.enqueue(a.id);
    return queued;
  };
  const fontFiles = new Set<string>(Object.values(CAPTION_FONTS));
  /** The current timeline's AI-effect bakes (none for an empty timeline). */
  const fxBakesOf = (projectId: string) => {
    const t = timeline.get(projectId);
    if (t.durationFrames <= 0 || !t.clips.some((c) => c.props.aiEffects?.length)) return [];
    try {
      return buildRenderPlan(t).fxBakes;
    } catch {
      return []; // offline media: nothing can be baked until it is relinked
    }
  };
  const fxStatus = (projectId: string) => ({
    engine: fxAvailable(),
    bakes: fxBakesOf(projectId).map((b) => {
      const st = fxBaker.state(b.key);
      return st?.state === "done" ? { key: b.key, state: "done" as const } : { key: b.key, ...(st ?? { state: "missing" as const }) };
    }),
  });
  // Motion graphics: one Remotion render at a time; finished files are imported as assets once.
  const motion = new MotionRenderer({ generatedDir: opts.generatedDir ?? join(dirname(opts.cacheDir), "generated"), cacheDir: opts.cacheDir });
  const motionGraphics = new MotionGraphicStore(opts.db);
  const motionImports = new Map<string, Promise<string>>(); // `${projectId}:${key}` → asset id
  const motionErrors = new Map<string, string>(); // same slots: why the last attempt failed
  const motionStatus = (projectId: string, key: string) => {
    const st = motion.state(key);
    const assetId = motionGraphics.list(projectId).find((g) => g.renderKey === key)?.assetId;
    if (assetId) return { key, state: "done" as const, asset: assets.get(projectId, assetId) };
    const error = motionErrors.get(`${projectId}:${key}`);
    if (error && !motionImports.has(`${projectId}:${key}`)) return { key, state: "failed" as const, error };
    if (!st) return { key, state: "missing" as const };
    // The file exists but its import hasn't landed yet: still working, from the caller's view.
    if (st.state === "done") return { key, state: "running" as const, progress: 1 };
    return { key, ...st };
  };
  const proposals = new ProposalStore(opts.db);
  const body = (req: IncomingMessage) => readJson(req) as Promise<never>;
  const pathsOf = (b: unknown): string[] => {
    const paths = (b as { paths?: unknown })?.paths;
    if (!Array.isArray(paths) || paths.length === 0 || !paths.every((p) => typeof p === "string")) {
      throw new ReelForgeError("VALIDATION_ERROR", "body must be {\"paths\": [\"/absolute/file.mp4\", …]}");
    }
    return paths;
  };

  const ID = "([^/]+)";
  const connector = (): ConnectorControl => {
    if (!opts.connector) throw new ReelForgeError("UNAVAILABLE", "this engine was started without the connector");
    return opts.connector;
  };

  const routes: Route[] = [
    { method: "GET", pattern: re("/v1/projects"), handle: ({ res }) => send(res, 200, { projects: projects.list() }) },
    { method: "POST", pattern: re("/v1/projects"), handle: async ({ req, res, actor }) => send(res, 201, { project: projects.create(await body(req), actor) }) },
    { method: "GET", pattern: re(`/v1/projects/${ID}`), handle: ({ res, params: [id] }) => send(res, 200, { project: projects.get(id!) }) },
    {
      method: "PATCH",
      pattern: re(`/v1/projects/${ID}`),
      handle: async ({ req, res, params: [id], actor }) => send(res, 200, { project: projects.rename(id!, await body(req), actor) }),
    },
    {
      method: "PATCH",
      pattern: re(`/v1/projects/${ID}/format`),
      handle: async ({ req, res, params: [id], actor }) => send(res, 200, { project: projects.resize(id!, await body(req), actor) }),
    },
    { method: "GET", pattern: re(`/v1/projects/${ID}/history`), handle: ({ res, params: [id] }) => send(res, 200, { operations: projects.history(id!) }) },
    { method: "GET", pattern: re(`/v1/projects/${ID}/timeline`), handle: ({ res, params: [id] }) => send(res, 200, { timeline: timeline.get(id!) }) },
    {
      method: "POST",
      pattern: re(`/v1/projects/${ID}/operations`),
      handle: async ({ req, res, params: [id], actor }) => send(res, 200, { timeline: timeline.apply(id!, await body(req), actor) }),
    },
    {
      method: "POST",
      pattern: re(`/v1/projects/${ID}/undo`),
      handle: async ({ req, res, params: [id], actor }) => send(res, 200, { timeline: timeline.undo(id!, await body(req), actor) }),
    },
    {
      method: "POST",
      pattern: re(`/v1/projects/${ID}/redo`),
      handle: async ({ req, res, params: [id], actor }) => send(res, 200, { timeline: timeline.redo(id!, await body(req), actor) }),
    },
    { method: "GET", pattern: re(`/v1/projects/${ID}/assets`), handle: ({ res, params: [id] }) => send(res, 200, { assets: assets.list(id!) }) },
    {
      method: "POST",
      pattern: re(`/v1/projects/${ID}/assets`),
      handle: async ({ req, res, params: [id], actor }) => {
        const b = await readJson(req);
        // Folders (Finder drops) open to the media files inside; only for the token holder, i.e. the user.
        const { paths, skipped } = (b as { folders?: unknown })?.folders === true ? expandFolders(pathsOf(b)) : { paths: pathsOf(b), skipped: 0 };
        if (!paths.length) throw new ReelForgeError("VALIDATION_ERROR", `no media files there (${skipped} other item${skipped === 1 ? "" : "s"} skipped)`);
        const result = await importMedia(opts.db, id!, paths, actor);
        return send(res, result.imported.length ? 201 : 200, { ...result, skipped });
      },
    },
    {
      method: "POST",
      pattern: re(`/v1/projects/${ID}/assets/${ID}/relink`),
      handle: async ({ req, res, params: [id, assetId], actor }) => {
        const b = (await readJson(req)) as { path?: unknown };
        if (typeof b?.path !== "string") throw new ReelForgeError("VALIDATION_ERROR", 'body must be {"path": "/absolute/file"}');
        return send(res, 200, { asset: await relinkMedia(opts.db, id!, assetId!, b.path, actor) });
      },
    },
    {
      method: "POST",
      pattern: re(`/v1/projects/${ID}/render-jobs`),
      handle: async ({ req, res, params: [id] }) => {
        const b = (await readJson(req)) as { outputPath?: unknown };
        if (typeof b?.outputPath !== "string") throw new ReelForgeError("VALIDATION_ERROR", 'body must be {"outputPath": "/absolute/file.mp4"}');
        const job = createRenderJob(opts.db, id!, "export", b.outputPath);
        runner.enqueue(job.id);
        return send(res, 202, { job });
      },
    },
    {
      method: "POST",
      pattern: re(`/v1/projects/${ID}/preview-jobs`),
      handle: ({ res, params: [id] }) => {
        // One preview per revision: reuse a running or finished one instead of rendering twice.
        const revision = projects.get(id!).revision;
        const existing = jobs.list(id!, { kind: "preview", limit: 10 }).find((j) => j.revision === revision && !["failed", "cancelled"].includes(j.state));
        if (existing) return send(res, 200, { job: existing });
        const job = createRenderJob(opts.db, id!, "preview");
        runner.enqueue(job.id);
        return send(res, 202, { job });
      },
    },
    {
      method: "GET",
      pattern: re(`/v1/projects/${ID}/jobs`),
      handle: ({ req, res, params: [id] }) => {
        const kind = new URL(req.url ?? "", "http://x").searchParams.get("kind");
        return send(res, 200, { jobs: jobs.list(id!, kind === "export" || kind === "preview" ? { kind } : {}) });
      },
    },
    { method: "GET", pattern: re(`/v1/projects/${ID}/artifacts`), handle: ({ res, params: [id] }) => send(res, 200, { artifacts: jobs.artifacts(id!) }) },
    { method: "GET", pattern: re(`/v1/jobs/${ID}`), handle: ({ res, params: [id] }) => send(res, 200, { job: jobs.get(id!) }) },
    { method: "POST", pattern: re(`/v1/jobs/${ID}/cancel`), handle: ({ res, params: [id] }) => send(res, 200, { job: runner.cancel(id!) }) },
    {
      method: "POST",
      pattern: re(`/v1/jobs/${ID}/retry`),
      handle: ({ res, params: [id] }) => {
        const job = retryRenderJob(opts.db, id!);
        runner.enqueue(job.id);
        return send(res, 202, { job });
      },
    },
    {
      method: "POST",
      pattern: re(`/v1/projects/${ID}/assets/${ID}/analyze`),
      handle: async ({ req, res, params: [id, assetId] }) => {
        const b = (await readJson(req)) as { kinds?: unknown; language?: unknown };
        const kinds = (b.kinds ?? [...ANALYSIS_KINDS]) as AnalysisKind[];
        if (!Array.isArray(kinds) || !kinds.length) throw new ReelForgeError("VALIDATION_ERROR", `kinds must be a non-empty array of ${ANALYSIS_KINDS.join(", ")}`);
        return send(res, 202, { analyses: analyze(id!, assetId!, kinds, typeof b.language === "string" ? { language: b.language } : {}) });
      },
    },
    {
      method: "GET",
      pattern: re(`/v1/projects/${ID}/assets/${ID}/analysis`),
      handle: ({ res, params: [id, assetId] }) => send(res, 200, { analyses: analyses.list(id!, assetId!) }),
    },
    {
      // Status of every analysis in the project (results included), keyed by asset.
      method: "GET",
      pattern: re(`/v1/projects/${ID}/analyses`),
      handle: ({ res, params: [id] }) => send(res, 200, { analyses: Object.fromEntries(analyses.forProject(id!)) }),
    },
    {
      method: "POST",
      pattern: re(`/v1/projects/${ID}/captions/generate`),
      handle: async ({ req, res, params: [id], actor }) => {
        const b = (await readJson(req)) as { trackId?: string; sourceTrackIds?: string[]; maxWords?: number; language?: string; baseRevision?: number };
        const plan = planCaptions(opts.db, id!, {
          ...(b.trackId ? { trackId: b.trackId } : {}),
          ...(b.sourceTrackIds ? { sourceTrackIds: b.sourceTrackIds } : {}),
          ...(typeof b.maxWords === "number" ? { maxWords: Math.max(1, Math.min(12, Math.round(b.maxWords))) } : {}),
        });
        if (plan.missing.length) {
          // Start the transcripts that are missing or stale; the client asks again when they finish.
          for (const m of plan.missing) if (m.state !== "queued" && m.state !== "running") analyze(id!, m.assetId, ["transcript"], b.language ? { language: b.language } : {});
          return send(res, 202, { status: "transcribing", missing: plan.missing });
        }
        const tl = timeline.get(id!);
        const next = timeline.apply(id!, { baseRevision: b.baseRevision ?? tl.project.revision, operations: [{ type: "captions.replace", trackId: plan.trackId, captions: plan.captions }] }, actor);
        return send(res, 200, { status: "applied", count: plan.captions.length, timeline: next });
      },
    },
    {
      // AI Director "caption the speech": transcribe what's missing (202, poll the analyses, ask again),
      // then a proposal planned by the engine from word timings. Applying it is still the user's Apply.
      method: "POST",
      pattern: re(`/v1/projects/${ID}/captions/propose`),
      handle: async ({ req, res, params: [id] }) => {
        const b = (await readJson(req)) as { instruction?: unknown; style?: unknown; language?: unknown; maxWords?: unknown };
        const style = b.style === "bold" || b.style === "clean" || b.style === "boxed" ? b.style : undefined;
        const language = typeof b.language === "string" ? b.language : undefined;
        const plan = planSpeechCaptions(opts.db, id!, { ...(style ? { style } : {}), ...(typeof b.maxWords === "number" ? { maxWords: Math.max(1, Math.min(12, Math.round(b.maxWords))) } : {}) });
        if (plan.status === "needs_transcripts") {
          const started = plan.missing.flatMap((m) => (m.state === "queued" || m.state === "running" ? [] : analyze(id!, m.assetId, ["transcript"], language ? { language } : {})));
          return send(res, 202, { status: "transcribing", missing: plan.missing, analyses: started.map((a) => a.id) });
        }
        const proposal = proposals.create(id!, {
          instruction: typeof b.instruction === "string" ? b.instruction.slice(0, 4000) : "Caption the speech",
          selection: [],
          provider: "reelforge",
          model: "speech captions",
          summary: plan.summary,
          operations: plan.operations,
          explanations: plan.explanations,
          warnings: plan.warnings,
        });
        return send(res, 201, { proposal });
      },
    },
    {
      method: "GET",
      pattern: re(`/v1/projects/${ID}/captions\\.srt`),
      handle: ({ req, res, params: [id] }) => {
        const tl = timeline.get(id!);
        const trackId = new URL(req.url ?? "", "http://x").searchParams.get("trackId") ?? tl.tracks.find((t) => t.kind === "caption")?.id;
        const srt = captionsToSrt(tl.captions.filter((c) => c.trackId === trackId), tl.project.settings.fps);
        res.writeHead(200, { "content-type": "application/x-subrip; charset=utf-8", "content-disposition": `attachment; filename="${tl.project.name.replace(/[^\w.-]+/g, "_")}.srt"` });
        return res.end(srt);
      },
    },
    {
      method: "GET",
      pattern: re("/v1/ai/providers"),
      handle: async ({ res }) => {
        const ollama = await listOllamaModels();
        return send(res, 200, {
          providers: [
            { id: "anthropic", label: "Claude API", external: true, credential: credentialSource("anthropic"), defaultModel: ANTHROPIC_DEFAULT_MODEL, models: [ANTHROPIC_DEFAULT_MODEL, "claude-sonnet-5-5"] },
            { id: "claude-code", label: "Claude Code", external: true, available: !!claudeBinary(), defaultModel: CLAUDE_CODE_MODELS[0], models: CLAUDE_CODE_MODELS },
            { id: "codex", label: "Codex", external: true, available: !!codexBinary(), defaultModel: listCodexModels()[0] ?? null, models: listCodexModels() },
            { id: "ollama", label: "Local (Ollama)", external: new OllamaProvider().external, available: ollama.available, defaultModel: ollama.models[0] ?? null, models: ollama.models },
          ],
        });
      },
    },
    {
      method: "GET",
      pattern: re("/v1/connector"),
      handle: ({ res }) => send(res, 200, { connector: connector().status() }),
    },
    {
      method: "POST",
      pattern: re("/v1/connector/start"),
      handle: async ({ req, res }) => {
        const b = (await readJson(req)) as { tunnel?: unknown; domain?: unknown; publicUrl?: unknown };
        if (b.tunnel !== undefined && b.tunnel !== "ngrok" && b.tunnel !== "none") throw new ReelForgeError("VALIDATION_ERROR", 'tunnel must be "ngrok" or "none"');
        const str = (v: unknown) => (typeof v === "string" ? v : v === null ? null : undefined);
        const input = {
          ...(b.tunnel ? { tunnel: b.tunnel as "ngrok" | "none" } : {}),
          ...(str(b.domain) !== undefined ? { domain: str(b.domain)! } : {}),
          ...(str(b.publicUrl) !== undefined ? { publicUrl: str(b.publicUrl)! } : {}),
        };
        return send(res, 200, { connector: await connector().start(input) });
      },
    },
    { method: "POST", pattern: re("/v1/connector/stop"), handle: async ({ res }) => send(res, 200, { connector: await connector().stop() }) },
    { method: "POST", pattern: re("/v1/connector/rotate-key"), handle: ({ res }) => send(res, 200, { connector: connector().rotateKey() }) },
    { method: "POST", pattern: re("/v1/connector/revoke"), handle: ({ res }) => send(res, 200, { connector: connector().revokeAll() }) },
    {
      method: "GET",
      pattern: re(`/v1/projects/${ID}/ai-consent`),
      handle: ({ res, params: [id] }) => send(res, 200, { consent: proposals.consent(id!) }),
    },
    {
      method: "POST",
      pattern: re(`/v1/projects/${ID}/ai-consent`),
      handle: async ({ req, res, params: [id], actor }) => {
        const b = (await readJson(req)) as { granted?: unknown; provider?: unknown };
        if (typeof b.granted !== "boolean") throw new ReelForgeError("VALIDATION_ERROR", 'body must be {"granted": true|false, "provider"?: string}');
        // Consent is per recipient: allowing Claude doesn't also send the project to OpenAI.
        const recipient = typeof b.provider === "string" ? consentRecipient(b.provider) : undefined;
        return send(res, 200, { consent: proposals.setConsent(id!, b.granted, actor, recipient) });
      },
    },
    {
      method: "POST",
      pattern: re(`/v1/projects/${ID}/proposals`),
      handle: async ({ req, res, params: [id] }) => {
        const b = (await readJson(req)) as { instruction?: unknown; provider?: unknown; model?: unknown; selection?: unknown };
        if (typeof b.instruction !== "string") throw new ReelForgeError("VALIDATION_ERROR", "instruction is required");
        const provider = providerFor(typeof b.provider === "string" ? b.provider : "anthropic");
        const model = typeof b.model === "string" && b.model ? b.model : await defaultModelFor(provider.id);
        if (!model) throw new ReelForgeError("UNAVAILABLE", provider.id === "ollama" ? "no local model available in Ollama" : `no model available for ${provider.id}`);
        // If the client goes away (cancel), stop the model request too.
        const abort = new AbortController();
        res.on("close", () => !res.writableEnded && abort.abort());
        const proposal = await propose(
          opts.db,
          id!,
          provider,
          { instruction: b.instruction, model, selection: Array.isArray(b.selection) ? b.selection.filter((x): x is string => typeof x === "string") : [] },
          { signal: abort.signal },
        );
        return send(res, 201, { proposal });
      },
    },
    { method: "GET", pattern: re(`/v1/projects/${ID}/proposals`), handle: ({ res, params: [id] }) => send(res, 200, { proposals: proposals.list(id!) }) },
    { method: "GET", pattern: re(`/v1/proposals/${ID}`), handle: ({ res, params: [id] }) => send(res, 200, { proposal: proposals.get(id!) }) },
    {
      // The approval: a person pressed "Apply" in a client. The model's output can never reach this.
      method: "POST",
      pattern: re(`/v1/proposals/${ID}/apply`),
      handle: ({ res, params: [id], actor }) => send(res, 200, proposals.apply(id!, { by: actor, channel: `${actor}:apply` })),
    },
    { method: "POST", pattern: re(`/v1/proposals/${ID}/reject`), handle: ({ res, params: [id], actor }) => send(res, 200, { proposal: proposals.reject(id!, actor) }) },
    {
      // Run a workflow file in the background; poll its run record. approveAi comes from the person
      // pressing Run in ReelForge (MCP clients can't set it).
      method: "POST",
      pattern: re("/v1/workflows/run"),
      handle: async ({ req, res, actor }) => {
        const b = (await readJson(req)) as { path?: unknown; approveAi?: unknown };
        if (typeof b.path !== "string" || !b.path.startsWith("/")) throw new ReelForgeError("VALIDATION_ERROR", 'body must be {"path": "/absolute/workflow.json"}');
        const { spec, baseDir } = readWorkflowFile(b.path);
        const runId = await new Promise<string>((resolve, reject) => {
          runWorkflow(opts.db, spec, { cacheDir: opts.cacheDir, actor, baseDir, source: b.path as string, approveAi: b.approveAi === true, createOutputDirs: true, onStart: resolve }).catch(reject);
        });
        return send(res, 202, { run: new WorkflowRunStore(opts.db).get(runId) });
      },
    },
    {
      method: "GET",
      pattern: re("/v1/workflows/runs"),
      handle: ({ req, res }) => {
        const projectId = new URL(req.url ?? "", "http://x").searchParams.get("projectId");
        return send(res, 200, { runs: new WorkflowRunStore(opts.db).list(projectId ? { projectId } : {}) });
      },
    },
    { method: "GET", pattern: re(`/v1/workflows/runs/${ID}`), handle: ({ res, params: [id] }) => send(res, 200, { run: new WorkflowRunStore(opts.db).get(id!) }) },
    {
      // Desktop "Export SRT…": the webview can't write files, so the engine writes where the user chose.
      method: "POST",
      pattern: re(`/v1/projects/${ID}/captions/export-srt`),
      handle: async ({ req, res, params: [id] }) => {
        const b = (await readJson(req)) as { outputPath?: unknown; trackId?: string };
        const out = b.outputPath;
        if (typeof out !== "string" || !out.startsWith("/") || !out.toLowerCase().endsWith(".srt") || out.includes("\0")) {
          throw new ReelForgeError("VALIDATION_ERROR", "outputPath must be an absolute .srt path");
        }
        const tl = timeline.get(id!);
        const trackId = b.trackId ?? tl.tracks.find((t) => t.kind === "caption")?.id;
        try {
          writeFileSync(out, captionsToSrt(tl.captions.filter((c) => c.trackId === trackId), tl.project.settings.fps), { flag: "wx" });
        } catch (e) {
          const code = (e as NodeJS.ErrnoException).code;
          if (code === "EEXIST") throw new ReelForgeError("VALIDATION_ERROR", "a file already exists there; not overwriting it");
          if (code === "ENOENT") throw new ReelForgeError("VALIDATION_ERROR", "that folder does not exist");
          throw e;
        }
        return send(res, 200, { path: out });
      },
    },
    {
      // What an AI planner reads before proposing edits (M4, MCP).
      method: "GET",
      pattern: re(`/v1/projects/${ID}/context`),
      handle: ({ res, params: [id] }) => send(res, 200, { context: buildProjectContext(timeline.get(id!), analyses.forProject(id!), OPERATION_TYPES) }),
    },
    {
      method: "GET",
      media: true,
      pattern: re(`/v1/fonts/([A-Za-z0-9-]+\\.ttf)`),
      handle: ({ req, res, params: [file] }) => {
        if (!fontFiles.has(file!)) throw new ReelForgeError("NOT_FOUND", "unknown font");
        return sendFile(req, res, join(fontsDir(), file!), "font/ttf");
      },
    },
    {
      method: "GET",
      media: true,
      pattern: re(`/v1/jobs/${ID}/output`),
      handle: ({ req, res, params: [id] }) => {
        const job = jobs.get(id!);
        if (job.state !== "completed" || !job.outputPath) throw new ReelForgeError("NOT_FOUND", `job is ${job.state}; no output yet`, { jobId: job.id });
        return sendFile(req, res, job.outputPath, "video/mp4");
      },
    },
    { method: "GET", pattern: re(`/v1/projects/${ID}/fx`), handle: ({ res, params: [id] }) => send(res, 200, fxStatus(id!)) },
    {
      // Start baking every AI effect the timeline uses that isn't cached yet; poll GET …/fx for progress.
      method: "POST",
      pattern: re(`/v1/projects/${ID}/fx/bake`),
      handle: ({ res, params: [id] }) => {
        if (fxAvailable().ok) {
          const specs = fxBakesOf(id!);
          fxBaker.retain(id!, new Set(specs.map((b) => b.key)));
          for (const spec of specs) void fxBaker.ensure(spec, id!);
        }
        return send(res, 202, fxStatus(id!));
      },
    },
    {
      method: "GET",
      pattern: re(`/v1/projects/${ID}/motion`),
      handle: ({ res, params: [id] }) => send(res, 200, { engine: motionAvailable(), graphics: motionGraphics.list(id!) }),
    },
    {
      // Render a motion graphic and import it as an asset; poll GET …/motion/:key until it's done.
      method: "POST",
      pattern: re(`/v1/projects/${ID}/motion`),
      handle: async ({ req, res, params: [id], actor }) => {
        const input = parse(CreateMotionInputSchema, await readJson(req));
        const project = projects.get(id!);
        const avail = motionAvailable();
        if (!avail.ok) throw new ReelForgeError("UNAVAILABLE", avail.reason);
        const spec = motionRenderSpec(input, project.settings);
        const slot = `${project.id}:${spec.key}`;
        if (!motionImports.has(slot) && !motionGraphics.list(project.id).some((g) => g.renderKey === spec.key)) {
          const job = motion.ensure(spec).then(async (path) => {
            const result = await importMedia(opts.db, project.id, [path], actor);
            const asset = result.imported[0] ?? result.existing[0];
            if (!asset) throw new Error(result.failed[0]?.error.message ?? "could not import the rendered graphic");
            motionGraphics.record(project.id, asset.id, spec, input.durationFrames);
            return asset.id;
          });
          job.catch((e: unknown) => motionErrors.set(slot, e instanceof Error ? e.message : String(e))).finally(() => motionImports.delete(slot));
          motionErrors.delete(slot);
          motionImports.set(slot, job);
        }
        return send(res, 202, { motion: motionStatus(project.id, spec.key) });
      },
    },
    {
      method: "GET",
      pattern: re(`/v1/projects/${ID}/motion/${ID}`),
      handle: ({ res, params: [id, key] }) => {
        if (!/^[0-9a-f]{16}$/.test(key!)) throw new ReelForgeError("VALIDATION_ERROR", "invalid motion key");
        return send(res, 200, { motion: motionStatus(projects.get(id!).id, key!) });
      },
    },
    {
      // A baked AI-effects video, only for a bake the project's timeline uses.
      method: "GET",
      media: true,
      pattern: re(`/v1/projects/${ID}/fx/${ID}/media`),
      handle: ({ req, res, params: [id, key] }) => {
        if (!fxBakesOf(id!).some((b) => b.key === key) || fxBaker.state(key!)?.state !== "done") {
          throw new ReelForgeError("NOT_FOUND", "that effect is not baked for this project");
        }
        return sendFile(req, res, bakePath(opts.cacheDir, key!), "video/mp4");
      },
    },
    {
      // What the live preview plays: the proxy for video, a ≤1280 px still for images, the file itself for audio.
      method: "GET",
      media: true,
      pattern: re(`/v1/projects/${ID}/assets/${ID}/media`),
      handle: async ({ req, res, params: [id, assetId] }) => {
        const asset = assets.get(id!, assetId!);
        if (asset.status === "missing") throw new ReelForgeError("NOT_FOUND", "source media is offline", { assetId: asset.id });
        if (asset.kind === "audio") {
          const ext = asset.sourcePath.toLowerCase().endsWith(".mp3") ? "audio/mpeg" : "audio/wav";
          return sendFile(req, res, asset.sourcePath, ext);
        }
        const path = await ensureProxy(opts.db, opts.cacheDir, asset.id, asset.sourcePath, asset.kind, asset.hasAlpha);
        return sendFile(req, res, path, asset.kind === "image" ? (path.endsWith(".png") ? "image/png" : "image/jpeg") : "video/mp4");
      },
    },
    {
      method: "GET",
      media: true,
      pattern: re(`/v1/projects/${ID}/assets/${ID}/thumbnail`),
      handle: async ({ res, params: [id, assetId] }) => {
        const thumb = await ensureThumbnail(opts.cacheDir, assets.get(id!, assetId!));
        res.writeHead(200, { "content-type": thumb.contentType, "cache-control": "private, max-age=3600", "x-content-type-options": "nosniff" });
        createReadStream(thumb.path).pipe(res);
      },
    },
  ];

  const origins = new Set(opts.allowedOrigins ?? []);
  let boundPort = 0;

  const server = createServer(async (req, res) => {
    if (opts.log) {
      const log = opts.log;
      res.on("finish", () => log(`${req.method} ${(req.url ?? "").split("?")[0]} ${res.statusCode} origin=${req.headers.origin ?? "-"}`));
    }
    try {
      const origin = req.headers.origin;
      if (origin !== undefined) {
        if (!origins.has(origin)) return send(res, 403, { error: { code: "UNAUTHORIZED", message: "origin not allowed" } });
        res.setHeader("access-control-allow-origin", origin);
        res.setHeader("vary", "origin");
      }
      const host = req.headers.host ?? "";
      if (host !== `127.0.0.1:${boundPort}` && host !== `localhost:${boundPort}`) {
        return send(res, 403, { error: { code: "UNAUTHORIZED", message: "host not allowed" } });
      }
      if (req.method === "OPTIONS") {
        res.writeHead(204, {
          "access-control-allow-methods": "GET, POST, PATCH, OPTIONS",
          "access-control-allow-headers": "authorization, content-type, x-reelforge-actor, range",
          "access-control-max-age": "600",
        });
        return res.end();
      }

      const url = new URL(req.url ?? "/", `http://${host}`);
      const path = url.pathname.replace(/\/+$/, "") || "/";

      if (req.method === "GET" && path === "/v1/health") {
        return send(res, 200, { ok: true, name: "reelforge", api: "v1" });
      }
      // <video>, <audio> and <img> can't send headers, so media GETs may carry the token as ?token=.
      // Only those routes accept it; the access log never records query strings.
      const queryToken = url.searchParams.get("token");
      const mediaRoute = req.method === "GET" && routes.some((r) => r.media && r.method === "GET" && r.pattern.test(path));
      const authed = tokenMatches(req.headers.authorization, opts.token) || (mediaRoute && queryToken !== null && sameToken(queryToken, opts.token));
      if (!authed) {
        return sendError(res, new ReelForgeError("UNAUTHORIZED", "missing or invalid bearer token"));
      }

      for (const route of routes) {
        if (route.method !== req.method) continue;
        const m = route.pattern.exec(path);
        if (!m) continue;
        const params = m.slice(1).map((p) => decodeURIComponent(p));
        return await route.handle({ req, res, params, actor: actorOf(req) });
      }

      return sendError(res, new ReelForgeError("NOT_FOUND", `no route for ${req.method} ${path}`));
    } catch (e) {
      if (isReelForgeError(e)) return sendError(res, e);
      console.error("[reelforge-server] unhandled error:", e instanceof Error ? e.message : e);
      return sendError(res, new ReelForgeError("INTERNAL", "internal error"));
    }
  });

  // AI proposals from local models can take minutes; Node's default 5-minute request timeout would cut them off.
  server.requestTimeout = 30 * 60_000;
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 0, "127.0.0.1", () => {
      boundPort = (server.address() as AddressInfo).port;
      resolve({
        url: `http://127.0.0.1:${boundPort}`,
        port: boundPort,
        server,
        close: () =>
          new Promise((r, j) => {
            analysisRunner.stop();
            fxBaker.stop();
            motion.stop();
            const renders = runner.stop();
            server.close((err) => (err ? j(err) : renders.then(() => r())));
            // close() already drops idle sockets; also end in-flight ones so shutdown can't hang.
            server.closeAllConnections();
          }),
      });
    });
  });
}
