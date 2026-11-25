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
import { AnalysisRunner, createRenderJob, importMedia, RenderRunner, type ImportResult } from "@reelforge/media";
import type { RenderJob } from "@reelforge/core";
import { ANTHROPIC_DEFAULT_MODEL, defaultOllamaModel, OPERATIONS_GUIDE, parseModelOutput, propose, providerFor } from "@reelforge/ai";
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
/** Most changes an approval prompt lists; a bigger proposal is approved where every change is shown. */
const ELICIT_MAX_CHANGES = 25;
const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: false } as const;

/**
 * What the remote connector (Claude, ChatGPT over HTTPS) adds. A remote client is not on this
 * machine: it can't name local paths, so files arrive by upload link or download, exports land in
 * ReelForge's own folder and come back as links, and approvals happen on a page the user opens.
 */
export interface RemoteHooks {
  createUploadLink(projectId: string): { uploadId: string; url: string; expiresAt: string };
  uploadStatus(uploadId: string): unknown;
  importFromUrl(projectId: string, url: string, fileName?: string): Promise<ImportResult>;
  /** A download link for a finished render, or undefined if this connector may not hand it out. */
  downloadLink(job: RenderJob): string | undefined;
  approvalLink(proposalId: string): string;
  /** A fresh, unused .mp4 path in the connector's export folder. */
  exportPath(projectId: string): string;
}

export interface McpOptions {
  cacheDir: string;
  /** Shared runners (the remote connector serves many sessions from one process). The caller starts and stops them. */
  runners?: { render: RenderRunner; analysis: AnalysisRunner };
  remote?: RemoteHooks;
}

const LOCAL_INSTRUCTIONS =
  "ReelForge edits vertical videos. Typical flow: projects_create → media_import → media_analyze → timeline_get (read the context) → " +
  "timeline_propose_edit (your operations) → the user approves (timeline_apply_proposal asks them) → render_start → jobs_get until completed. " +
  "Timeline changes always need the user's approval; never claim they approved.";

const REMOTE_INSTRUCTIONS =
  "ReelForge is a video editor running on the user's own computer. Typical flow: projects_list or projects_create → add media → " +
  "media_analyze → timeline_get (read the context) → timeline_propose_edit (your operations) → timeline_apply_proposal (gives an approval link; " +
  "the user opens it and presses Apply) → render_start → jobs_get until completed, then give the user the download link.\n" +
  "Adding media: if the user attached a file in this chat and media_add_file is available, pass it there. Otherwise call media_upload_link and " +
  "give the user the link to upload from their browser (or, if you can run code with internet access and hold the file, PUT it to the link), " +
  "then media_upload_status. media_add_from_url takes a public https link.\n" +
  "Timeline changes always need the user's approval on that page; never claim they approved, and never open or submit the approval page yourself.";

export function createMcpServer(db: Database, opts: McpOptions) {
  const remote = opts.remote;
  const server = new McpServer(SERVER_INFO, { instructions: remote ? REMOTE_INSTRUCTIONS : LOCAL_INSTRUCTIONS });
  const projects = new ProjectStore(db);
  const timeline = new TimelineStore(db);
  const proposals = new ProposalStore(db);
  const analyses = new AnalysisStore(db);
  const jobs = new JobStore(db);
  const renderRunner = opts.runners?.render ?? new RenderRunner(db, { cacheDir: opts.cacheDir });
  const analysisRunner = opts.runners?.analysis ?? new AnalysisRunner(db, { cacheDir: opts.cacheDir });
  if (!opts.runners) {
    renderRunner.start();
    analysisRunner.start();
  }
  const clientName = () => server.server.getClientVersion()?.name ?? "client";
  // Render jobs this session queued: the only ones it may cancel, and the queued ones are dropped on close.
  const ownJobs = new Set<string>();

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
      project: projects.create({ name, settings: { ...(width ? { width } : {}), ...(height ? { height } : {}), ...(fps ? { fps: fpsOf(fps) } : {}) } }, "mcp"),
    })),
  );
  server.registerTool("projects_get", { title: "Get project", inputSchema: { projectId: Id }, annotations: READ }, tool(({ projectId }: { projectId: string }) => ({ project: projects.get(projectId) })));

  // ---- media ------------------------------------------------------------------
  if (!remote) {
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
  } else {
    // A remote client can't name files on this machine (and must not read them): media arrives as uploads.
    server.registerTool(
      "media_add_file",
      {
        title: "Add an attached file",
        description: "Add a file the user attached in this chat (video MP4/MOV, image JPEG/PNG, audio WAV/MP3) to a project. It is downloaded to the user's computer and imported.",
        inputSchema: {
          projectId: Id,
          file: z
            .object({ download_url: z.string(), file_id: z.string(), mime_type: z.string().optional(), file_name: z.string().optional() })
            .describe("The attached file"),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
        // ChatGPT fills this field with the attachment (a temporary download URL).
        _meta: { "openai/fileParams": ["file"] },
      },
      tool(({ projectId, file }: { projectId: string; file: { download_url: string; mime_type?: string; file_name?: string } }) => {
        projects.get(projectId);
        return remote.importFromUrl(projectId, file.download_url, file.file_name ?? nameFromMime(file.mime_type));
      }),
    );
    server.registerTool(
      "media_add_from_url",
      {
        title: "Add media from a link",
        description: "Download a public https link to a media file (MP4, MOV, JPEG, PNG, WAV, MP3) to the user's computer and import it into a project.",
        inputSchema: { projectId: Id, url: z.string().describe("https:// link to the file itself"), fileName: z.string().optional().describe("Name with extension, if the link doesn't show one") },
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      },
      tool(({ projectId, url, fileName }: { projectId: string; url: string; fileName?: string }) => {
        projects.get(projectId);
        return remote.importFromUrl(projectId, url, fileName);
      }),
    );
    server.registerTool(
      "media_upload_link",
      {
        title: "Get an upload link",
        description:
          "A one-time link (valid 1 hour) for uploading one media file into a project. Give it to the user to open in their browser; " +
          "or, if you can run code with internet access, PUT the file bytes to it with the file name in an X-File-Name header. Then call media_upload_status.",
        inputSchema: { projectId: Id },
        annotations: WRITE,
      },
      tool(({ projectId }: { projectId: string }) => {
        projects.get(projectId);
        return remote.createUploadLink(projectId);
      }),
    );
    server.registerTool(
      "media_upload_status",
      { title: "Upload status", description: "Whether the file for an upload link has arrived, and the imported asset.", inputSchema: { uploadId: z.string() }, annotations: READ },
      tool(({ uploadId }: { uploadId: string }) => remote.uploadStatus(uploadId)),
    );
  }
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
      if (done.state === "queued" || done.state === "running") return { status: "in_progress", jobId: done.id, next: "another ReelForge process is detecting beats; call jobs_get with this id" };
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
      if (a.operations && a.instruction) throw new ReelForgeError("VALIDATION_ERROR", "give either operations or an instruction for the AI Director, not both");
      if (a.operations && a.director) throw new ReelForgeError("VALIDATION_ERROR", "director only applies with an instruction; operations you planned don't go to the AI Director");
      if (a.selection?.length) {
        const clips = new Set(timeline.get(a.projectId).clips.map((c) => c.id));
        const unknown = a.selection.filter((id) => !clips.has(id));
        if (unknown.length) throw new ReelForgeError("VALIDATION_ERROR", "selected clips are not on the timeline", { unknown });
      }
      if (a.operations) {
        const parsed = parseModelOutput(JSON.stringify({ summary: a.summary, warnings: [], operations: a.operations }));
        if (parsed.errors.length) throw new ReelForgeError("VALIDATION_ERROR", parsed.errors.join("; "));
        if (!parsed.operations.length) throw new ReelForgeError("VALIDATION_ERROR", "operations is empty: nothing to propose");
        const preview = timeline.preview(a.projectId, parsed.operations);
        if (!preview.diff.clips.length && !preview.diff.tracks.length && !preview.diff.captions?.length) {
          throw new ReelForgeError("VALIDATION_ERROR", "these operations don't change anything on the timeline (it already looks like that); nothing to propose");
        }
        const proposal = proposals.create(a.projectId, {
          instruction: "", // the summary is the client's words, never shown as the user's instruction
          requestedBy: "mcp",
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
      const model = a.director?.model ?? (provider.id === "anthropic" ? ANTHROPIC_DEFAULT_MODEL : await defaultOllamaModel());
      return describe(await propose(db, a.projectId, provider, { instruction: a.instruction, model, selection: a.selection ?? [], requestedBy: "mcp" }));
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
      // get() records a proposal whose timeline moved on as stale, so the user is never asked to approve one that can't apply.
      const p = proposals.get(proposalId);
      if (p.status === "stale") return { status: "stale", proposal: describe(p), next: "the timeline changed since this proposal was made; propose the edit again" };
      if (p.status !== "pending") return { status: p.status, proposal: describe(p) };
      if (!p.operations.length) return { status: "nothing_to_apply", warnings: p.warnings };
      const human = remote
        ? {
            approvalUrl: remote.approvalLink(p.id),
            next: "Give the user this link. They review the changes there and press Apply (or open ReelForge → AI Director). Call timeline_get_proposal afterwards to see if it was applied.",
          }
        : { approve_in_reelforge: `Open ReelForge → AI Director and press Apply, or run: reelforge ai apply ${p.id} --yes` };
      if (!server.server.getClientCapabilities()?.elicitation) return { status: "approval_required", ...human };
      // A prompt can't show every change of a big proposal, and approval must cover only what was shown.
      if (p.changes.length > ELICIT_MAX_CHANGES) return { status: "approval_required", reason: `${p.changes.length} changes are too many to review in a prompt`, ...human };
      // Change lines are generated by the engine from the dry run; the summary and warnings may come from the client: quote them.
      const redo = timeline.get(p.projectId).history.canRedo;
      const lines = p.changes.map((c) => `• ${c.kind} ${quoteUntrusted(c.label, 60)}${c.after ? `: ${quoteUntrusted(c.after, 120)}` : ""}`);
      const answer = await server.server.elicitInput({
        message:
          `Apply ${p.changes.length} change${p.changes.length === 1 ? "" : "s"} to ${quoteUntrusted(projects.get(p.projectId).name)}?\n\n${lines.join("\n")}` +
          `\n\n` +
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
      description: "Caption the speech on the timeline (default: every unmuted track with sound, including videos' own sound; pass labels like [\"A2\"] or [\"V1\"]). If transcripts are missing it starts them and returns their job ids; call again when done. The result is a proposal for the user to approve.",
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
        requestedBy: "mcp",
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
      // One preview per revision (as over REST): repeated calls reuse it instead of rendering again.
      const revision = projects.get(projectId).revision;
      const existing = jobs.list(projectId, { kind: "preview", limit: 10 }).find((j) => j.revision === revision && !["failed", "cancelled"].includes(j.state));
      if (existing) return { jobId: existing.id, state: existing.state, reused: true };
      const job = createRenderJob(db, projectId, "preview");
      ownJobs.add(job.id);
      renderRunner.enqueue(job.id);
      return { jobId: job.id, state: job.state };
    }),
  );
  if (!remote) {
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
        ownJobs.add(job.id);
        renderRunner.enqueue(job.id);
        return { jobId: job.id, state: job.state, outputPath: job.outputPath };
      }),
    );
  } else {
    server.registerTool(
      "render_start",
      {
        title: "Render MP4",
        description: "Export the project as H.264/AAC MP4 at full size, saved in ReelForge's exports folder on the user's computer. Poll jobs_get; when completed it has a download link.",
        inputSchema: { projectId: Id },
        annotations: WRITE,
      },
      tool(({ projectId }: { projectId: string }) => {
        const job = createRenderJob(db, projectId, "export", remote.exportPath(projectId));
        ownJobs.add(job.id);
        renderRunner.enqueue(job.id);
        return { jobId: job.id, state: job.state };
      }),
    );
  }
  const jobView = (j: RenderJob) => {
    if (!remote) return { type: j.kind, state: j.state, progress: j.progress, outputPath: j.outputPath, error: j.error };
    const downloadUrl = j.state === "completed" ? remote.downloadLink(j) : undefined;
    return { type: j.kind, state: j.state, progress: j.progress, error: j.error, ...(downloadUrl ? { downloadUrl, downloadExpires: "in 24 hours; call jobs_get again for a fresh link" } : {}) };
  };
  server.registerTool(
    "jobs_get",
    { title: "Get job", description: "Status of a render/preview job or an analysis job.", inputSchema: { jobId: Id }, annotations: READ },
    tool(({ jobId }: { jobId: string }) => {
      try {
        return jobView(jobs.get(jobId));
      } catch (e) {
        if (!isReelForgeError(e) || e.code !== "NOT_FOUND") throw e;
      }
      let a;
      try {
        a = analyses.get(jobId);
      } catch (e) {
        if (isReelForgeError(e) && e.code === "NOT_FOUND") throw new ReelForgeError("NOT_FOUND", `job ${jobId} not found (no render, preview or analysis job has this id)`, { jobId });
        throw e;
      }
      return { type: `analysis:${a.kind}`, state: a.state, progress: a.progress, error: a.error };
    }),
  );
  server.registerTool(
    "jobs_cancel",
    { title: "Cancel job", description: "Cancel a render or preview this session started (the user's own renders are cancelled in ReelForge).", inputSchema: { jobId: Id }, annotations: WRITE },
    tool(({ jobId }: { jobId: string }) => {
      if (!ownJobs.has(jobId)) throw new ReelForgeError("UNAUTHORIZED", "only jobs started in this MCP session can be cancelled here; the user can cancel others in ReelForge");
      const j = renderRunner.cancel(jobId);
      return { state: j.state };
    }),
  );
  server.registerTool(
    "outputs_get",
    { title: "List outputs", description: remote ? "Finished exports of a project made through this connector, with download links." : "Finished exports of a project (paths, sizes, frame counts).", inputSchema: { projectId: Id }, annotations: READ },
    tool(({ projectId }: { projectId: string }) => {
      if (!remote) return { outputs: jobs.artifacts(projectId) };
      // Only exports this connector made: the user's own exports live in folders a remote client has no business seeing.
      const done = jobs.list(projectId, { kind: "export", limit: 50 }).filter((j) => j.state === "completed");
      return { outputs: done.flatMap((j) => (remote.downloadLink(j) ? [{ jobId: j.id, finishedAt: j.finishedAt, downloadUrl: remote.downloadLink(j) }] : [])) };
    }),
  );

  // ---- automation -------------------------------------------------------------
  // Workflows read local files and folders, so they stay with local clients.
  if (!remote) server.registerTool(
    "workflows_run",
    {
      title: "Run a workflow",
      description:
        "Run a ReelForge workflow JSON (version 1: name, project {id}|{name}, steps of import/analyze/append/edit/captions/director/preview/render). " +
        "Runs to completion and returns the run record. Steps that change the timeline (append, edit, captions) and imports with glob patterns need the user's approval, which this tool asks for. " +
        "A render step's folder must already exist; " +
        "an AI Director step stops the run with waiting_approval: the steps after it don't run (the user applies the proposal and runs the rest).",
      inputSchema: { workflow: z.record(z.string(), z.unknown()), baseDir: z.string().optional().describe("Folder relative paths resolve from") },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    tool(async ({ workflow, baseDir }: { workflow: Record<string, unknown>; baseDir?: string }) => {
      // The client wrote this workflow, so running it is not the user's approval. Steps that change the
      // timeline need the user to say yes (elicitation); approveAi is never taken from the client.
      const spec = parseWorkflow(workflow);
      const editing = timelineSteps(spec);
      // A glob reads directory listings, so it needs the same yes (literal paths are media_import's authority).
      const resolvedBase = baseDir ?? process.cwd();
      const globs = globImportSteps(spec, resolvedBase);
      if (editing.length || globs.length) {
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
          baseDir: resolvedBase,
          source: `mcp:${clientName()}`,
          // Each approval covers only what the prompt showed. createOutputDirs stays off: the client chose baseDir.
          timelineEditsApproved: editing.length > 0,
          globsApproved: globs.length > 0,
        }),
      };
    }),
  );
  server.registerTool(
    "workflows_runs",
    { title: "List workflow runs", inputSchema: { projectId: Id.optional() }, annotations: READ },
    tool(({ projectId }: { projectId?: string }) => ({ runs: new WorkflowRunStore(db).list(projectId ? { projectId } : {}) })),
  );

  const close = async () => {
    // Queued work this session asked for shouldn't be picked up later by the desktop engine.
    for (const id of ownJobs) {
      try {
        if (jobs.get(id).state === "queued") renderRunner.cancel(id);
      } catch {
        // already gone
      }
    }
    if (opts.runners) return; // shared: the owner stops them
    analysisRunner.stop();
    await renderRunner.stop();
  };
  return { server, close };
}

/** A frame rate from a client: an unusable one is the client's mistake (VALIDATION_ERROR), not an internal error. */
function fpsOf(fps: string) {
  try {
    return parseFps(fps);
  } catch (e) {
    if (isReelForgeError(e)) throw e;
    throw new ReelForgeError("VALIDATION_ERROR", e instanceof Error ? e.message : `unsupported frame rate "${fps}"`);
  }
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

/** A file name for an attachment that came without one, so the import can tell its type. */
function nameFromMime(mime: string | undefined): string | undefined {
  const ext: Record<string, string> = {
    "video/mp4": "mp4",
    "video/quicktime": "mov",
    "image/jpeg": "jpg",
    "image/png": "png",
    "audio/wav": "wav",
    "audio/x-wav": "wav",
    "audio/wave": "wav",
    "audio/mpeg": "mp3",
  };
  const e = mime ? ext[mime.split(";")[0]!.trim().toLowerCase()] : undefined;
  return e ? `attachment.${e}` : undefined;
}
