import { useEffect, useState } from "react";
import type { RenderJob } from "@reelforge/core/schema";
import type { Client } from "../api.ts";
import type { Notify } from "../editor.ts";
import { Icon } from "../icons.tsx";

const ACTIVE = new Set(["queued", "analyzing", "rendering", "muxing"]);

/** Review & Export workspace: every render of this project, newest first. */
export function RenderQueue({ client, projectId, notify, onExport }: { client: Client | null; projectId: string; notify: Notify; onExport: () => void }) {
  const [jobs, setJobs] = useState<RenderJob[] | null>(null);
  const [showPreviews, setShowPreviews] = useState(false);

  useEffect(() => {
    if (!client) return;
    let alive = true;
    const load = () => client.jobs(projectId).then((j) => alive && setJobs(j), () => {});
    void load();
    const id = setInterval(() => document.visibilityState === "visible" && void load(), 1000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [client, projectId]);

  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (e) {
      notify("error", e instanceof Error ? e.message : String(e));
    }
  };

  const shown = (jobs ?? []).filter((j) => showPreviews || j.kind === "export");

  return (
    <main className="rf-queue">
      <div className="rf-queue-head">
        <div>
          <h1>Review &amp; Export</h1>
          <p>Exports render the same graph as the preview, at full size from the original media: MP4 · H.264 · AAC.</p>
        </div>
        <label className="rf-check">
          <input type="checkbox" checked={showPreviews} onChange={(e) => setShowPreviews(e.target.checked)} /> Show preview renders
        </label>
        <button className="rf-btn rf-btn-primary" onClick={onExport}>
          <Icon name="export" size={16} /> New export
        </button>
      </div>
      {jobs === null ? (
        <p className="rf-queue-empty">Loading…</p>
      ) : shown.length === 0 ? (
        <p className="rf-queue-empty">No exports yet.</p>
      ) : (
        <ul className="rf-queue-list">
          {shown.map((j) => (
            <li key={j.id} className={`rf-job rf-job-${j.state}`}>
              <div className="rf-job-main">
                <span className="rf-job-kind">{j.kind === "export" ? "Export" : "Preview"}</span>
                <span className="rf-job-path" title={j.outputPath ?? undefined}>
                  {j.outputPath ?? "—"}
                </span>
                <span className="rf-job-meta">
                  {j.settings.width}×{j.settings.height} · rev {j.revision} · {new Date(j.createdAt).toLocaleTimeString()}
                </span>
              </div>
              <div className="rf-job-progress" aria-label={`${j.state} ${Math.round(j.progress * 100)}%`}>
                <div style={{ width: `${Math.round(j.progress * 100)}%` }} />
              </div>
              <span className="rf-job-state">
                {j.state}
                {ACTIVE.has(j.state) && j.state !== "queued" ? ` ${Math.round(j.progress * 100)}%` : ""}
              </span>
              {j.error && (
                <span className="rf-job-error" title={j.error.message}>
                  {j.error.message}
                </span>
              )}
              <div className="rf-job-actions">
                {ACTIVE.has(j.state) && (
                  <button className="rf-btn" onClick={() => act(() => client!.cancelJob(j.id))}>
                    Cancel
                  </button>
                )}
                {(j.state === "failed" || j.state === "cancelled") && (
                  <button className="rf-btn" onClick={() => act(() => client!.retryJob(j.id))}>
                    Retry
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
