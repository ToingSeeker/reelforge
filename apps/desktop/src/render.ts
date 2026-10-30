import { useCallback, useEffect, useState } from "react";
import type { RenderJob, Timeline } from "@reelforge/core/schema";
import { ApiError, type Client } from "./api.ts";
import type { Notify } from "./editor.ts";

const PREVIEW_DEBOUNCE_MS = 700;
const POLL_MS = 400;
const TERMINAL = new Set(["completed", "failed", "cancelled"]);

async function until(client: Client, jobId: string, onUpdate: (j: RenderJob) => void, alive: () => boolean): Promise<RenderJob> {
  for (;;) {
    const j = await client.job(jobId);
    onUpdate(j);
    if (TERMINAL.has(j.state) || !alive()) return j;
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

export interface PreviewState {
  /** Blob URL of the newest finished preview, kept while a newer one renders. */
  url: string | null;
  /** Timeline revision that `url` shows. */
  revision: number | null;
  /** The job rendering the next preview, if any. */
  pending: RenderJob | null;
  error: string | null;
}

/**
 * Keeps a preview render in step with the timeline: every new revision (after
 * a short pause in editing) asks the engine for a preview of exactly that
 * revision, rendered through the same graph as the export.
 */
export function usePreview(client: Client | null, timeline: Timeline | null, enabled = true): PreviewState {
  const [state, setState] = useState<PreviewState>({ url: null, revision: null, pending: null, error: null });
  const projectId = timeline?.project.id ?? null;
  const revision = timeline?.project.revision ?? null;
  const empty = !timeline || timeline.durationFrames === 0;
  useEffect(() => {
    setState({ url: null, revision: null, pending: null, error: null });
  }, [projectId]);

  useEffect(() => {
    if (!client || !projectId || revision === null) return;
    if (empty || !enabled) {
      if (empty) setState({ url: null, revision, pending: null, error: null });
      return;
    }
    let alive = true;
    const timer = setTimeout(async () => {
      try {
        const job = await client.previewJob(projectId);
        const done = await until(client, job.id, (j) => alive && setState((s) => ({ ...s, pending: TERMINAL.has(j.state) ? null : j })), () => alive);
        if (!alive) return;
        if (done.state !== "completed") {
          setState((s) => ({ ...s, pending: null, error: done.error?.message ?? `preview ${done.state}` }));
          return;
        }
        // Streamed with Range from the engine; nothing is held in memory.
        setState({ url: client.outputUrl(done.id), revision: done.revision, pending: null, error: null });
      } catch (e) {
        if (alive) setState((s) => ({ ...s, pending: null, error: e instanceof ApiError ? e.message : String(e) }));
      }
    }, PREVIEW_DEBOUNCE_MS);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [client, projectId, revision, empty, enabled]);

  return state;
}

/** Export jobs started from this window, with progress and cancel. */
export function useExports(client: Client | null, notify: Notify) {
  const [active, setActive] = useState<RenderJob | null>(null);
  const start = useCallback(
    async (projectId: string, path: string) => {
      if (!client) return;
      try {
        const job = await client.exportJob(projectId, path);
        setActive(job);
        const done = await until(client, job.id, setActive, () => true);
        setActive(null);
        if (done.state === "completed") notify("info", `Exported ${done.outputPath}`);
        else if (done.state === "failed") notify("error", `Export failed: ${done.error?.message ?? "unknown error"}`);
        else notify("info", "Export cancelled.");
      } catch (e) {
        setActive(null);
        notify("error", e instanceof Error ? e.message : String(e));
      }
    },
    [client, notify],
  );
  const cancel = useCallback(async () => {
    if (client && active) await client.cancelJob(active.id).catch(() => {});
  }, [client, active]);
  return { active, start, cancel };
}
