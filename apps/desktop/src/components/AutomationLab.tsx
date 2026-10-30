import { useEffect, useState } from "react";
import type { WorkflowRun } from "@reelforge/core/schema";
import type { Client } from "../api.ts";
import type { Notify } from "../editor.ts";
import { pickWorkflowFile } from "../native.ts";
import { Icon } from "../icons.tsx";

const STEP_ICON: Record<string, string> = { completed: "✓", failed: "✕", running: "…", pending: "·", skipped: "–", waiting_approval: "?" };

/** Automate workspace: run workflow recipes and follow them step by step. */
export function AutomationLab({ client, notify, onOpenProject }: { client: Client | null; notify: Notify; onOpenProject: (id: string) => void }) {
  const [runs, setRuns] = useState<WorkflowRun[] | null>(null);
  const [approveAi, setApproveAi] = useState(false);

  useEffect(() => {
    if (!client) return;
    let alive = true;
    let t: number;
    const load = async () => {
      try {
        const r = await client.workflowRuns();
        if (alive) setRuns(r);
        t = window.setTimeout(load, r.some((x) => x.status === "running") ? 1000 : 4000);
      } catch {
        t = window.setTimeout(load, 4000);
      }
    };
    void load();
    return () => {
      alive = false;
      window.clearTimeout(t);
    };
  }, [client]);

  const run = async () => {
    const path = await pickWorkflowFile();
    if (!path || !client) return;
    try {
      const r = await client.runWorkflow(path, approveAi);
      setRuns((list) => [r, ...(list ?? [])]);
      notify("info", `Running “${r.name}”.`);
    } catch (e) {
      notify("error", e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <main className="rf-queue">
      <div className="rf-queue-head">
        <div>
          <h1>Automation Lab</h1>
          <p>
            Workflow recipes (JSON) import, analyse, assemble, caption and render with the same engine as the editor. The same recipes run from the CLI
            (<code>reelforge workflow run</code>) and from AI clients over MCP.
          </p>
        </div>
        <label className="rf-check" title="Without this, a run stops at AI Director steps so you can review the proposal">
          <input type="checkbox" checked={approveAi} onChange={(e) => setApproveAi(e.target.checked)} /> Apply AI Director steps
        </label>
        <button className="rf-btn rf-btn-primary" onClick={() => void run()}>
          <Icon name="play" size={14} /> Run workflow…
        </button>
      </div>
      {runs === null ? (
        <p className="rf-queue-empty">Loading…</p>
      ) : runs.length === 0 ? (
        <p className="rf-queue-empty">No runs yet. Try examples/workflows/reel-from-folder.json.</p>
      ) : (
        <ul className="rf-queue-list">
          {runs.map((r) => (
            <li key={r.id} className={`rf-run rf-run-${r.status}`}>
              <div className="rf-run-head">
                <strong>{r.name}</strong>
                <span className={`rf-run-status rf-run-status-${r.status}`}>{r.status.replace("_", " ")}</span>
                <span className="rf-job-meta">
                  {r.actor} · {new Date(r.startedAt).toLocaleString()}
                </span>
                {r.projectId && (
                  <button className="rf-link-btn" onClick={() => onOpenProject(r.projectId!)}>
                    Open project
                  </button>
                )}
              </div>
              <ol className="rf-run-steps">
                {r.steps.map((s) => (
                  <li key={s.index} className={`rf-step rf-step-${s.status}`}>
                    <span className="rf-step-icon" aria-hidden="true">
                      {STEP_ICON[s.status] ?? "·"}
                    </span>
                    <span className="rf-step-kind">{s.kind}</span>
                    <span className="rf-step-detail" title={s.detail ?? undefined}>
                      {s.detail ?? s.status}
                    </span>
                  </li>
                ))}
              </ol>
              {r.error && <p className="rf-job-error">{r.error}</p>}
              {r.status === "waiting_approval" && <p className="rf-hint">An AI Director proposal is waiting: open the project and review it in the AI Director panel.</p>}
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
