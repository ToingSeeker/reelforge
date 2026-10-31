import type { WorkflowRun, AIConsent, AIProposal, Analysis, AnalysisKind, Asset, CreateProjectInput, EditOperation, Project, RenderJob, Timeline, TimelineOp } from "@reelforge/core/schema";
import type { ProjectContext } from "@reelforge/core/context";

// The desktop UI never touches SQLite: it talks to the same core through the
// local REST sidecar that the Rust shell starts (or, in a plain browser during
// development, one you start yourself with `reelforge serve`).

/** AI-effect bakes the timeline needs (GET/POST /v1/projects/:id/fx). */
export interface FxStatus {
  engine: { ok: true } | { ok: false; reason: string };
  bakes: ({ key: string; state: "done" | "missing" | "queued" } | { key: string; state: "running"; progress: number } | { key: string; state: "failed"; error: string })[];
}

export interface ApiInfo {
  url: string;
  token: string;
}

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details: Record<string, unknown> | undefined;
  constructor(status: number, code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const isTauri = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export async function resolveApiInfo(): Promise<ApiInfo> {
  if (isTauri()) {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<ApiInfo>("api_info");
  }
  const url = import.meta.env.VITE_REELFORGE_API_URL as string | undefined;
  const token = import.meta.env.VITE_REELFORGE_API_TOKEN as string | undefined;
  if (!url || !token) {
    throw new Error(
      "Not running inside the desktop shell. For browser dev, run `reelforge serve --allow-origin http://localhost:5173` and set VITE_REELFORGE_API_URL / VITE_REELFORGE_API_TOKEN.",
    );
  }
  return { url, token };
}

export function createClient(info: ApiInfo) {
  async function request<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    const res = await fetch(info.url + path, {
      method,
      ...(signal ? { signal } : {}),
      headers: {
        authorization: `Bearer ${info.token}`,
        "x-reelforge-actor": "desktop",
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const json = (await res.json().catch(() => ({}))) as { error?: { code: string; message: string; details?: Record<string, unknown> } };
    if (!res.ok) {
      const e = json.error ?? { code: "INTERNAL", message: `HTTP ${res.status}` };
      throw new ApiError(res.status, e.code, e.message, e.details);
    }
    return json as T;
  }

  const q = `token=${encodeURIComponent(info.token)}`;
  return {
    /** Streamable URLs for media elements (which can't send an Authorization header). */
    mediaUrl: (id: string, assetId: string) => `${info.url}/v1/projects/${encodeURIComponent(id)}/assets/${encodeURIComponent(assetId)}/media?${q}`,
    fxUrl: (id: string, key: string) => `${info.url}/v1/projects/${encodeURIComponent(id)}/fx/${encodeURIComponent(key)}/media?${q}`,
    thumbnailUrl: (id: string, assetId: string) => `${info.url}/v1/projects/${encodeURIComponent(id)}/assets/${encodeURIComponent(assetId)}/thumbnail?${q}`,
    outputUrl: (jobId: string) => `${info.url}/v1/jobs/${encodeURIComponent(jobId)}/output?${q}`,
    fontUrl: (file: string) => `${info.url}/v1/fonts/${encodeURIComponent(file)}?${q}`,
    analyze: (id: string, assetId: string, kinds: AnalysisKind[], language?: string) =>
      request<{ analyses: Analysis[] }>("POST", `/v1/projects/${encodeURIComponent(id)}/assets/${encodeURIComponent(assetId)}/analyze`, { kinds, ...(language ? { language } : {}) }).then((r) => r.analyses),
    /** "Caption the speech": 202 while transcripts are missing (poll them, ask again), then an engine-planned proposal. */
    proposeCaptions: (id: string, body: { instruction: string; style?: string }) =>
      request<{ status: "transcribing"; analyses: string[]; missing: { assetId: string; filename: string }[] } | { proposal: AIProposal }>(
        "POST",
        `/v1/projects/${encodeURIComponent(id)}/captions/propose`,
        body,
      ),
    analyses: (id: string) => request<{ analyses: Record<string, Analysis[]> }>("GET", `/v1/projects/${encodeURIComponent(id)}/analyses`).then((r) => r.analyses),
    generateCaptions: (id: string, body: { trackId?: string; sourceTrackIds?: string[]; maxWords?: number; language?: string; baseRevision?: number }) =>
      request<{ status: "applied" | "transcribing"; count?: number; missing?: { assetId: string; filename: string; state: string | null }[]; timeline?: Timeline }>(
        "POST",
        `/v1/projects/${encodeURIComponent(id)}/captions/generate`,
        body,
      ),
    aiProviders: () =>
      request<{ providers: AIProviderInfo[] }>("GET", "/v1/ai/providers").then((r) => r.providers),
    propose: (id: string, body: { instruction: string; provider: string; model: string; selection: string[] }, signal?: AbortSignal) =>
      request<{ proposal: AIProposal }>("POST", `/v1/projects/${encodeURIComponent(id)}/proposals`, body, signal).then((r) => r.proposal),
    proposals: (id: string) => request<{ proposals: AIProposal[] }>("GET", `/v1/projects/${encodeURIComponent(id)}/proposals`).then((r) => r.proposals),
    applyProposal: (proposalId: string) =>
      request<{ proposal: AIProposal; timeline: Timeline }>("POST", `/v1/proposals/${encodeURIComponent(proposalId)}/apply`),
    rejectProposal: (proposalId: string) => request<{ proposal: AIProposal }>("POST", `/v1/proposals/${encodeURIComponent(proposalId)}/reject`).then((r) => r.proposal),
    consent: (id: string) => request<{ consent: AIConsent | null }>("GET", `/v1/projects/${encodeURIComponent(id)}/ai-consent`).then((r) => r.consent),
    setConsent: (id: string, granted: boolean) =>
      request<{ consent: AIConsent | null }>("POST", `/v1/projects/${encodeURIComponent(id)}/ai-consent`, { granted }).then((r) => r.consent),
    context: (id: string) => request<{ context: ProjectContext }>("GET", `/v1/projects/${encodeURIComponent(id)}/context`).then((r) => r.context),
    runWorkflow: (path: string, approveAi: boolean) => request<{ run: WorkflowRun }>("POST", "/v1/workflows/run", { path, approveAi }).then((r) => r.run),
    workflowRuns: () => request<{ runs: WorkflowRun[] }>("GET", "/v1/workflows/runs").then((r) => r.runs),
    exportSrt: (id: string, outputPath: string, trackId?: string) =>
      request<{ path: string }>("POST", `/v1/projects/${encodeURIComponent(id)}/captions/export-srt`, { outputPath, ...(trackId ? { trackId } : {}) }),
    listProjects: () => request<{ projects: Project[] }>("GET", "/v1/projects").then((r) => r.projects),
    createProject: (input: CreateProjectInput) =>
      request<{ project: Project }>("POST", "/v1/projects", input).then((r) => r.project),
    renameProject: (id: string, name: string, baseRevision: number) =>
      request<{ project: Project }>("PATCH", `/v1/projects/${encodeURIComponent(id)}`, { name, baseRevision }).then((r) => r.project),
    history: (id: string) =>
      request<{ operations: EditOperation[] }>("GET", `/v1/projects/${encodeURIComponent(id)}/history`).then((r) => r.operations),
    timeline: (id: string) => request<{ timeline: Timeline }>("GET", `/v1/projects/${encodeURIComponent(id)}/timeline`).then((r) => r.timeline),
    apply: (id: string, baseRevision: number, operations: TimelineOp[]) =>
      request<{ timeline: Timeline }>("POST", `/v1/projects/${encodeURIComponent(id)}/operations`, { baseRevision, operations }).then((r) => r.timeline),
    undo: (id: string, baseRevision: number) =>
      request<{ timeline: Timeline }>("POST", `/v1/projects/${encodeURIComponent(id)}/undo`, { baseRevision }).then((r) => r.timeline),
    redo: (id: string, baseRevision: number) =>
      request<{ timeline: Timeline }>("POST", `/v1/projects/${encodeURIComponent(id)}/redo`, { baseRevision }).then((r) => r.timeline),
    importMedia: (id: string, paths: string[]) =>
      request<{ imported: Asset[]; existing: Asset[]; failed: { path: string; error: { code: string; message: string } }[]; skipped?: number }>(
        "POST",
        `/v1/projects/${encodeURIComponent(id)}/assets`,
        { paths, folders: true },
      ),
    relink: (id: string, assetId: string, path: string) =>
      request<{ asset: Asset }>("POST", `/v1/projects/${encodeURIComponent(id)}/assets/${encodeURIComponent(assetId)}/relink`, { path }).then((r) => r.asset),
    fxStatus: (id: string) => request<FxStatus>("GET", `/v1/projects/${encodeURIComponent(id)}/fx`),
    bakeFx: (id: string) => request<FxStatus>("POST", `/v1/projects/${encodeURIComponent(id)}/fx/bake`),
    previewJob: (id: string) => request<{ job: RenderJob }>("POST", `/v1/projects/${encodeURIComponent(id)}/preview-jobs`).then((r) => r.job),
    exportJob: (id: string, outputPath: string) =>
      request<{ job: RenderJob }>("POST", `/v1/projects/${encodeURIComponent(id)}/render-jobs`, { outputPath }).then((r) => r.job),
    job: (jobId: string) => request<{ job: RenderJob }>("GET", `/v1/jobs/${encodeURIComponent(jobId)}`).then((r) => r.job),
    jobs: (id: string) => request<{ jobs: RenderJob[] }>("GET", `/v1/projects/${encodeURIComponent(id)}/jobs`).then((r) => r.jobs),
    cancelJob: (jobId: string) => request<{ job: RenderJob }>("POST", `/v1/jobs/${encodeURIComponent(jobId)}/cancel`).then((r) => r.job),
    retryJob: (jobId: string) => request<{ job: RenderJob }>("POST", `/v1/jobs/${encodeURIComponent(jobId)}/retry`).then((r) => r.job),
  };
}

export type Client = ReturnType<typeof createClient>;

export interface AIProviderInfo {
  id: "anthropic" | "ollama";
  label: string;
  external: boolean;
  credential?: "keychain" | "environment" | "none";
  available?: boolean;
  defaultModel: string | null;
  models: string[];
}
