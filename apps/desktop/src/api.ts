import type { Asset, CreateProjectInput, EditOperation, Project, Timeline, TimelineOp } from "@reelforge/core/schema";

// The desktop UI never touches SQLite: it talks to the same core through the
// local REST sidecar that the Rust shell starts (or, in a plain browser during
// development, one you start yourself with `reelforge serve`).

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
  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(info.url + path, {
      method,
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

  return {
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
      request<{ imported: Asset[]; existing: Asset[]; failed: { path: string; error: { code: string; message: string } }[] }>(
        "POST",
        `/v1/projects/${encodeURIComponent(id)}/assets`,
        { paths },
      ),
    relink: (id: string, assetId: string, path: string) =>
      request<{ asset: Asset }>("POST", `/v1/projects/${encodeURIComponent(id)}/assets/${encodeURIComponent(assetId)}/relink`, { path }).then((r) => r.asset),
    /** Thumbnails need the bearer token, so they're fetched and handed to <img> as blob URLs. */
    thumbnail: async (id: string, assetId: string): Promise<Blob> => {
      const res = await fetch(`${info.url}/v1/projects/${encodeURIComponent(id)}/assets/${encodeURIComponent(assetId)}/thumbnail`, {
        headers: { authorization: `Bearer ${info.token}` },
      });
      if (!res.ok) throw new ApiError(res.status, "THUMBNAIL", `thumbnail unavailable (${res.status})`);
      return res.blob();
    },
  };
}

export type Client = ReturnType<typeof createClient>;
