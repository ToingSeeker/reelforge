// ReelForge over MCP (PRD §14). The same engine as the desktop and CLI: same
// database, same validation, same jobs. Tools that would change the timeline
// only create proposals; applying one needs a person: an elicitation answered
// in the MCP client, or Apply in ReelForge / `reelforge ai apply --yes`.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  ANALYSIS_KINDS,
  AnalysisStore,
  buildProjectContext,
  isReelForgeError,
  JobStore,
  OPERATION_TYPES,
  parseFps,
  planCaptions,
  ProjectStore,
  ProposalStore,
  ReelForgeError,
  TimelineStore,
  trackLabels,
  WorkflowRunStore,
  type AIProposal,
  type AnalysisKind,
  type Database,
} from "@reelforge/core";
import { AnalysisRunner, createRenderJob, importMedia, RenderRunner } from "@reelforge/media";
import { ANTHROPIC_DEFAULT_MODEL, listOllamaModels, OPERATIONS_GUIDE, parseModelOutput, propose, providerFor } from "@reelforge/ai";
import { globImportSteps, parseWorkflow, quoteUntrusted, runWorkflow, timelineSteps } from "@reelforge/automation";

export const SERVER_INFO = { name: "reelforge", version: "0.1.0-alpha.1" };

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

const ok = (data: unknown): ToolResult => ({ content: [{ type: "text", text: JSON.stringify(data, null, 2) }] });
const fail = (e: unknown): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify({ error: isReelForgeError(e) ? e.toJSON() : { code: "INTERNAL", message: e instanceof Error ? e.message : String(e) } }, null, 2) }],
  isError: true,
});

/** Wrap a handler so every failure comes back as a tool error the model can read. */
function tool<A>(fn: (args: A) => unknown | Promise<unknown>) {
  return async (args: A): Promise<ToolResult> => {
    try {
      return ok(await fn(args));
    } catch (e) {
      return fail(e);
    }
  };
}

const Id = z.string().describe("UUID");
const READ = { readOnlyHint: true, openWorldHint: false } as const;
const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: false } as const;

export interface McpOptions {
  cacheDir: string;
}

export function createMcpServer(db: Database, opts: McpOptions) {
  const server = new McpServer(SERVER_INFO, {
    instructions:
      "ReelForge edits vertical videos. Typical flow: projects_create → media_import → media_analyze → timeline_get (read the context) → " +
      "timeline_propose_edit (your operations) → the user approves (timeline_apply_proposal asks them) → render_start → jobs_get until completed. " +
      "Timeline changes always need the user's approval; never claim they approved.",
  });
  const projects = new ProjectStore(db);
  const timeline = new TimelineStore(db);
  const proposals = new ProposalStore(db);
  const analyses = new AnalysisStore(db);
  const jobs = new JobStore(db);
  const renderRunner = new RenderRunner(db, { cacheDir: opts.cacheDir });
  const analysisRunner = new AnalysisRunner(db, { cacheDir: opts.cacheDir });
  renderRunner.start();
  analysisRunner.start();
  const clientName = () => server.server.getClientVersion()?.name ?? "client";

  // ---- projects -------------------------------------------------------------
  server.registerTool("projects_list", { title: "List projects", description: "All projects, most recently changed first.", annotations: READ }, tool(() => ({ projects: projects.list() })));
  server.registerTool(
    "projects_create",
    {
      title: "Create project",
      description: "Create a project. Defaults: 1080×1920 (9:16) at 30 fps.",
      inputSchema: { name: z.string(), width: z.number().int().optional(), height: z.number().int().optional(), fps: z.string().optional().describe('"30", "25", "29.97" or "30000/1001"') },
      annotations: WRITE,
    },
    tool(({ name, width, height, fps }: { name: string; width?: number; height?: number; fps?: string }) => ({
      project: projects.create({ name, settings: { ...(width ? { width } : {}), ...(height ? { height } : {}), ...(fps ? { fps: parseFps(fps) } : {}) } }, "mcp"),
    })),
  );
  server.registerTool("projects_get", { title: "Get project", inputSchema: { projectId: Id }, annotations: READ }, tool(({ projectId }: { projectId: string }) => ({ project: projects.get(projectId) })));

  // ---- media ------------------------------------------------------------------
  server.registerTool(
    "media_import",
    {
      title: "Import media",
      description: "Import local files (absolute paths: MP4, MOV, JPEG, PNG, WAV, MP3). Originals are only read, never modified.",
      inputSchema: { projectId: Id, paths: z.array(z.string()).min(1).max(200) },
      annotations: WRITE,
    },
    tool(({ projectId, paths }: { projectId: string; paths: string[] }) => importMedia(db, projectId, paths, "mcp")),
  );
  server.registerTool(
    "media_analyze",
    {
      title: "Analyse media",
      description: "Start local analysis of an asset: scenes (video), beats and transcript (audio). Returns job ids; poll jobs_get or media_get_analysis.",
      inputSchema: { projectId: Id, assetId: Id, kinds: z.array(z.enum(ANALYSIS_KINDS)).optional(), language: z.string().optional().describe('ISO code or "auto"') },
      annotations: WRITE,
    },
    tool(({ projectId, assetId, kinds, language }: { projectId: string; assetId: string; kinds?: AnalysisKind[]; language?: string }) => {
      const asset = timeline.get(projectId).assets.find((a) => a.id === assetId);
      if (!asset) throw new ReelForgeError("NOT_FOUND", "asset not in this project");
      const applicable: AnalysisKind[] = [...(asset.kind === "video" ? (["scenes"] as const) : []), ...(asset.hasAudio ? (["beats", "transcript"] as const) : [])];
      const queued = analyses.enqueue(projectId, assetId, kinds ?? applicable, language ? { language } : {});
      for (const a of queued) if (a.state === "queued") analysisRunner.enqueue(a.id);
      return { jobs: queued.map((a) => ({ jobId: a.id, kind: a.kind, state: a.state })) };
    }),
  );
  server.registerTool(
    "media_get_analysis",
    { title: "Get analysis", inputSchema: { projectId: Id, assetId: Id }, annotations: READ },
    tool(({ projectId, assetId }: { projectId: string; assetId: string }) => ({ analyses: analyses.list(projectId, assetId) })),
  );
  server.registerTool(
    "audio_detect_beats",
    { title: "Detect beats", description: "Find tempo and beat times of an asset (waits for the result; takes seconds).", inputSchema: { projectId: Id, assetId: Id }, annotations: WRITE },
    tool(async ({ projectId, assetId }: { projectId: string; assetId: string }) => {
      const [a] = analyses.enqueue(projectId, assetId, ["beats"]);
      analysisRunner.enqueue(a!.id);
      const done = await analysisRunner.wait(a!.id);
      if (done.state !== "completed") throw new ReelForgeError("INTERNAL", done.error ?? "beat detection failed");
      return { beats: done.result };
    }),
  );

  // ---- timeline -------------------------------------------------------------
  server.registerTool(
    "timeline_get",
    {
      title: "Get timeline and context",
      description: "The project as a planner sees it: settings, media with analysis (scenes, beats, transcripts), tracks, clips and captions in frames and seconds, and the accepted operation types.",
      inputSchema: { projectId: Id },
      annotations: READ,
    },
    tool(({ projectId }: { projectId: string }) => ({ context: buildProjectContext(timeline.get(projectId), analyses.forProject(projectId), OPERATION_TYPES) })),
  );
  server.registerTool(
    "timeline_propose_edit",
    {
      title: "Propose an edit",
      description:
        "Propose timeline operations for the user to review. They are validated against the current timeline (nothing changes yet). " +
        "Either give `operations` you planned, or an `instruction` for ReelForge's own AI Director.\n\n" + OPERATIONS_GUIDE,
      inputSchema: {
        projectId: Id,
        summary: z.string().describe("What the edit does, for the user"),
        operations: z.array(z.record(z.string(), z.unknown())).optional().describe("Operation objects, each with `type` and an optional `why`"),
        instruction: z.string().optional().describe("Ask ReelForge's AI Director to plan instead of sending operations"),
        director: z.object({ provider: z.enum(["ollama", "anthropic"]), model: z.string().optional() }).optional(),
        selection: z.array(z.string()).optional(),
      },
      annotations: WRITE,
    },
    tool(async (a: { projectId: string; summary: string; operations?: Record<string, unknown>[]; instruction?: string; director?: { provider: string; model?: string }; selection?: string[] }) => {
      if (a.operations) {
        const parsed = parseModelOutput(JSON.stringify({ summary: a.summary, warnings: [], operations: a.operations }));
        if (parsed.errors.length) throw new ReelForgeError("VALIDATION_ERROR", parsed.errors.join("; "));
        const proposal = proposals.create(a.projectId, {
          instruction: "", // the summary is the client's words, never shown as the user's instruction
          selection: a.selection ?? [],
          provider: "mcp",
          model: clientName(),
          summary: a.summary,
          operations: parsed.operations,
          explanations: parsed.explanations,
          warnings: [],
        });
        return describe(proposal);
      }
      if (!a.instruction) throw new ReelForgeError("VALIDATION_ERROR", "give operations, or an instruction for the AI Director");
      const provider = providerFor(a.director?.provider ?? "ollama");
      const model = a.director?.model ?? (provider.id === "anthropic" ? ANTHROPIC_DEFAULT_MODEL : (await listOllamaModels()).models[0]);
      if (!model) throw new ReelForgeError("UNAVAILABLE", "no local model available in Ollama");
      return describe(await propose(db, a.projectId, provider, { instruction: a.instruction, model, selection: a.selection ?? [] }));
    }),
  );
  server.registerTool(
    "timeline_get_proposal",
    { title: "Get proposal", inputSchema: { proposalId: Id }, annotations: READ },
    tool(({ proposalId }: { proposalId: string }) => describe(proposals.get(proposalId))),
  );
  server.registerTool(
    "timeline_apply_proposal",
    {
      title: "Apply a proposal (asks the user)",
      description:
        "Ask the user to approve a pending proposal; it is applied only if they accept. If this client can't ask, the user must approve it in ReelForge " +
        "(AI Director panel) or with `reelforge ai apply <id> --yes`. Never tell the user it was approved unless this tool says applied.",
      inputSchema: { proposalId: Id },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    tool(async ({ proposalId }: { proposalId: string }) => {
      const p = proposals.get(proposalId);
      if (p.status !== "pending") return { status: p.status, proposal: describe(p) };
      if (!p.operations.length) return { status: "nothing_to_apply", warnings: p.warnings };
      const human = { approve_in_reelforge: `Open ReelForge → AI Director and press Apply, or run: reelforge ai apply ${p.id} --yes` };
      if (!server.server.getClientCapabilities()?.elicitation) return { status: "approval_required", ...human };
      // Change lines are generated by the engine from the dry run; the summary and warnings may come from the client: quote them.
      const redo = timeline.get(p.projectId).history.canRedo;
      const lines = p.changes.slice(0, 12).map((c) => `• ${c.kind} ${quoteUntrusted(c.label, 60)}${c.after ? `: ${quoteUntrusted(c.after, 120)}` : ""}`);
      const answer = await server.server.elicitInput({
        message:
          `Apply ${p.operations.length} change${p.operations.length === 1 ? "" : "s"} to ${quoteUntrusted(projects.get(p.projectId).name)}?\n\n${lines.join("\n")}` +
          `${p.changes.length > 12 ? `\n…and ${p.changes.length - 12} more` : ""}\n\n` +
          `Summary (written by ${p.provider === "mcp" ? "the client" : "the AI"}): ${quoteUntrusted(p.summary, 200)}` +
          `${p.warnings.length ? `\nWarnings: ${p.warnings.map((w) => quoteUntrusted(w, 160)).join(" ")}` : ""}` +
          `${redo ? "\n\nThis project has undone edits: applying this means they can no longer be redone." : ""}`,
        requestedSchema: { type: "object", properties: { approve: { type: "boolean", title: "Apply to the timeline", description: "Can be undone in ReelForge" } }, required: ["approve"] },
      });
      if (answer.action !== "accept" || answer.content?.approve !== true) return { status: "not_approved", action: answer.action, ...human };
      const r = proposals.apply(p.id, { by: "mcp", channel: `mcp:elicitation:${clientName()}` });
      return { status: "applied", revision: r.timeline.project.revision, proposal: describe(r.proposal) };
    }),
  );
  server.registerTool(
    "timeline_undo",
    {
      title: "Undo (asks the user)",
      description:
        "Ask the user to undo the last timeline edit (which may be one they made themselves); it is undone only if they accept. " +
        "An undone edit can be redone in ReelForge until the next edit. If this client can't ask, the user must undo it in ReelForge.",
      inputSchema: { projectId: Id },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    tool(async ({ projectId }: { projectId: string }) => {
      const cur = timeline.get(projectId);
      if (!cur.history.canUndo) return { status: "nothing_to_undo" };
      const human = { approve_in_reelforge: "Use Undo (⌘Z) in ReelForge" };
      if (!server.server.getClientCapabilities()?.elicitation) return { status: "approval_required", ...human };
      const answer = await server.server.elicitInput({
        message:
          `An AI client wants to undo the last edit of ${quoteUntrusted(cur.project.name)}. It may be an edit you made yourself.\n\n` +
          "You can redo it in ReelForge, but only until the next edit: after that it is gone.",
        requestedSchema: { type: "object", properties: { approve: { type: "boolean", title: "Undo the last edit" } }, required: ["approve"] },
      });
      if (answer.action !== "accept" || answer.content?.approve !== true) return { status: "not_approved", action: answer.action, ...human };
      const tl = timeline.undo(projectId, { baseRevision: cur.project.revision }, "mcp");
      return { status: "undone", revision: tl.project.revision, canUndo: tl.history.canUndo, canRedo: tl.history.canRedo };
    }),
  );
  server.registerTool(
    "captions_generate",
    {
      title: "Generate captions",
      description: "Caption speech from audio tracks (default: every unmuted audio track; pass labels like [\"A2\"]). If transcripts are missing it starts them and returns their job ids; call again when done. The result is a proposal for the user to approve.",
      inputSchema: { projectId: Id, sourceTracks: z.array(z.string()).optional(), maxWords: z.number().int().min(1).max(12).optional(), language: z.string().optional() },
      annotations: WRITE,
    },
    tool(({ projectId, sourceTracks, maxWords, language }: { projectId: string; sourceTracks?: string[]; maxWords?: number; language?: string }) => {
      const tl = timeline.get(projectId);
      const labels = trackLabels(tl.tracks);
      const ids = sourceTracks?.map((ref) => {
        for (const [id, label] of labels) if (label === ref.toUpperCase() || id === ref) return id;
        throw new ReelForgeError("VALIDATION_ERROR", `no track "${ref}"`);
      });
      const plan = planCaptions(db, projectId, { ...(ids ? { sourceTrackIds: ids } : {}), ...(maxWords ? { maxWords } : {}) });
      if (plan.missing.length) {
        const started = plan.missing.flatMap((m) =>
          m.state === "queued" || m.state === "running" ? [] : analyses.enqueue(projectId, m.assetId, ["transcript"], language ? { language } : {}).map((a) => (analysisRunner.enqueue(a.id), a.id)),
        );
        return { status: "transcribing", jobs: started, missing: plan.missing };
      }
      const proposal = proposals.create(projectId, {
        instruction: "Generate captions from speech",
        selection: [],
        provider: "mcp",
        model: clientName(),
        summary: `${plan.captions.length} captions from speech`,
        operations: [{ type: "captions.replace", trackId: plan.trackId, captions: plan.captions }],
        explanations: ["captions from the transcript"],
        warnings: [],
      });
      return { result: "proposed", ...describe(proposal) };
    }),
  );

  // ---- rendering & jobs -----------------------------------------------------
  server.registerTool(
    "preview_create",
    { title: "Create preview", description: "Low-resolution render of the current timeline (same graph as the export). Returns a job id.", inputSchema: { projectId: Id }, annotations: WRITE },
    tool(({ projectId }: { projectId: string }) => {
      const job = createRenderJob(db, projectId, "preview");
      renderRunner.enqueue(job.id);
      return { jobId: job.id, state: job.state };
    }),
  );
  server.registerTool(
    "render_start",
    {
      title: "Render MP4",
      description: "Export H.264/AAC MP4 at the project size to an absolute .mp4 path (never overwrites an existing file). Returns a job id.",
      inputSchema: { projectId: Id, outputPath: z.string() },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    tool(({ projectId, outputPath }: { projectId: string; outputPath: string }) => {
      const job = createRenderJob(db, projectId, "export", outputPath);
      renderRunner.enqueue(job.id);
      return { jobId: job.id, state: job.state, outputPath: job.outputPath };
    }),
  );
  server.registerTool(
    "jobs_get",
    { title: "Get job", description: "Status of a render/preview job or an analysis job.", inputSchema: { jobId: Id }, annotations: READ },
    tool(({ jobId }: { jobId: string }) => {
      try {
        const j = jobs.get(jobId);
        return { type: j.kind, state: j.state, progress: j.progress, outputPath: j.outputPath, error: j.error };
      } catch (e) {
        if (!isReelForgeError(e) || e.code !== "NOT_FOUND") throw e;
      }
      const a = analyses.get(jobId);
      return { type: `analysis:${a.kind}`, state: a.state, progress: a.progress, error: a.error };
    }),
  );
  server.registerTool(
    "jobs_cancel",
    { title: "Cancel job", inputSchema: { jobId: Id }, annotations: WRITE },
    tool(({ jobId }: { jobId: string }) => {
      const j = renderRunner.cancel(jobId);
      return { state: j.state };
    }),
  );
  server.registerTool(
    "outputs_get",
    { title: "List outputs", description: "Finished exports of a project (paths, sizes, frame counts).", inputSchema: { projectId: Id }, annotations: READ },
    tool(({ projectId }: { projectId: string }) => ({ outputs: jobs.artifacts(projectId) })),
  );

  // ---- automation -------------------------------------------------------------
  server.registerTool(
    "workflows_run",
    {
      title: "Run a workflow",
      description:
        "Run a ReelForge workflow JSON (version 1: name, project {id}|{name}, steps of import/analyze/append/edit/captions/director/preview/render). " +
        "Runs to completion and returns the run record. Steps that change the timeline (append, edit, captions) and imports with glob patterns need the user's approval, which this tool asks for. " +
        "A render step's folder must already exist; " +
        "AI Director steps stop with waiting_approval for the user.",
      inputSchema: { workflow: z.record(z.string(), z.unknown()), baseDir: z.string().optional().describe("Folder relative paths resolve from") },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    tool(async ({ workflow, baseDir }: { workflow: Record<string, unknown>; baseDir?: string }) => {
      // The client wrote this workflow, so running it is not the user's approval. Steps that change the
      // timeline need the user to say yes (elicitation); approveAi is never taken from the client.
      const spec = parseWorkflow(workflow);
      const editing = timelineSteps(spec);
      // A glob reads directory listings, so it needs the same yes (literal paths are media_import's authority).
      const globs = globImportSteps(spec);
      const approved = editing.length > 0 || globs.length > 0;
      if (approved) {
        const how = { approve_in_reelforge: "Save the workflow as a .json file and run it from ReelForge → Automate, or with: reelforge workflow run <file.json>" };
        if (!server.server.getClientCapabilities()?.elicitation) return { status: "approval_required", timelineSteps: editing, globImports: globs, ...how };
        // Server-written summary first; anything the client wrote is flattened and quoted.
        const target = "id" in spec.project ? `the existing project ${quoteUntrusted(projects.get(spec.project.id).name)}` : `a new project ${quoteUntrusted(spec.project.name)}`;
        const changes = editing.length ? `Changes to the timeline:\n${editing.map((x) => `• step ${x.index + 1} (${x.kind}): ${x.description}`).join("\n")}\n\n` : "";
        const searches = globs.length
          ? `Searches your files for media (folder listings are read):\n${globs.map((g) => `• step ${g.index + 1} (import): ${g.patterns.map((p) => quoteUntrusted(p, 120)).join(", ")}`).join("\n")}\n\n`
          : "";
        const answer = await server.server.elicitInput({
          message:
            `An AI client wants to run a workflow on ${target}.\n\n` +
            changes +
            searches +
            `All steps: ${spec.steps.map((st) => Object.keys(st)[0]).join(" → ")}\n` +
            `Workflow name (written by the client): ${quoteUntrusted(spec.name)}`,
          requestedSchema: { type: "object", properties: { approve: { type: "boolean", title: "Run it", description: "Each change can be undone in ReelForge" } }, required: ["approve"] },
        });
        if (answer.action !== "accept" || answer.content?.approve !== true) return { status: "not_approved", action: answer.action, ...how };
      }
      return {
        run: await runWorkflow(db, spec, {
          cacheDir: opts.cacheDir,
          actor: "mcp",
          baseDir: baseDir ?? process.cwd(),
          source: `mcp:${clientName()}`,
          // Only reached with the user's yes. createOutputDirs stays off: the client chose baseDir.
          timelineEditsApproved: approved,
          globsApproved: approved,
        }),
      };
    }),
  );
  server.registerTool(
    "workflows_runs",
    { title: "List workflow runs", inputSchema: { projectId: Id.optional() }, annotations: READ },
    tool(({ projectId }: { projectId?: string }) => ({ runs: new WorkflowRunStore(db).list(projectId ? { projectId } : {}) })),
  );

  const close = () => {
    renderRunner.stop();
    analysisRunner.stop();
  };
  return { server, close };
}

function describe(p: AIProposal) {
  return {
    proposalId: p.id,
    status: p.status,
    summary: p.summary,
    warnings: p.warnings,
    changes: p.changes.map((c) => `${c.kind} ${c.label}${c.before ? ` | before: ${c.before}` : ""}${c.after ? ` | after: ${c.after}` : ""}`),
    operations: p.operations.length,
    durationFrames: { before: p.durationBefore, after: p.durationAfter },
    next: p.status === "pending" && p.operations.length ? "call timeline_apply_proposal to ask the user to approve it" : undefined,
  };
}
