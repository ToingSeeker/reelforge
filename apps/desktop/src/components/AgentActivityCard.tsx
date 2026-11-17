import { useState } from "react";
import type { Activity, Outcome } from "../activity.ts";
import { Icon } from "../icons.tsx";

interface Props {
  active: Activity[];
  primary: Activity | null;
  outcome: Outcome | null;
  onDismiss: () => void;
  onOpenDirector: () => void;
}

const COLLAPSE_KEY = "rf.agentCardCollapsed";

/** Compact status of what the AI and the engine are doing. Everything shown comes from activity.ts (real state only). */
export function AgentActivityCard({ active, primary, outcome, onDismiss, onOpenDirector }: Props) {
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(COLLAPSE_KEY) === "1";
    } catch {
      return false;
    }
  });
  const toggle = () =>
    setCollapsed((c) => {
      try {
        localStorage.setItem(COLLAPSE_KEY, c ? "0" : "1");
      } catch {
        /* best effort */
      }
      return !c;
    });

  const others = active.filter((a) => a !== primary);
  const running = primary?.phase === "running";
  const status = running ? "Working" : primary ? "Needs you" : outcome?.tone === "error" ? "Failed" : outcome ? "Done" : "Idle";
  const tone = running ? "busy" : primary ? "waiting" : outcome?.tone === "error" ? "error" : outcome ? "success" : "idle";

  return (
    <section className={`rf-agent is-${tone}${collapsed ? " is-collapsed" : ""}`} aria-label="Agent activity">
      <button type="button" className="rf-agent-head" aria-expanded={!collapsed} onClick={toggle}>
        <Icon name="director" size={16} />
        <span className="rf-agent-heading">Agent Activity</span>
        <span className="rf-agent-status" role="status">
          <span className="rf-agent-dot" aria-hidden="true" />
          {status}
          {collapsed && primary ? ` · ${primary.title}` : ""}
        </span>
        <Icon name="chevronDown" size={15} className="rf-acc-chevron" />
      </button>

      {!collapsed && (
        <div className="rf-agent-body">
          {primary ? (
            <>
              <div className="rf-agent-main">
                <Indicator activity={primary} />
                <div className="rf-agent-text">
                  <p className="rf-agent-title">{primary.title}</p>
                  <p className="rf-agent-detail" title={primary.detail}>{primary.detail}</p>
                </div>
              </div>
              {primary.progress !== null && running && (
                <div className="rf-meter" role="progressbar" aria-label={primary.title} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(primary.progress * 100)}>
                  <div style={{ width: `${Math.round(primary.progress * 100)}%` }} />
                </div>
              )}
              {primary.progress === null && running && (
                <div className="rf-meter is-indeterminate" role="progressbar" aria-label={`${primary.title}, in progress`}>
                  <div />
                </div>
              )}
              {primary.steps && <Steps steps={primary.steps} />}
              {(primary.cancel || primary.action) && (
                <div className="rf-agent-actions">
                  {primary.action && (
                    <button className="rf-btn rf-btn-sm rf-btn-mint" onClick={primary.action.run}>
                      {primary.action.label}
                    </button>
                  )}
                  {primary.cancel && (
                    <button className="rf-btn rf-btn-sm rf-btn-quiet" onClick={primary.cancel}>
                      <Icon name="stop" size={12} /> Cancel
                    </button>
                  )}
                </div>
              )}
              {others.length > 0 && (
                <ul className="rf-agent-others">
                  {others.map((a) => (
                    <li key={a.id}>
                      <span className="rf-agent-other-title">{a.title}</span>
                      <span className="rf-agent-other-detail">{a.progress !== null ? `${Math.round(a.progress * 100)}%` : a.phase === "waiting" ? "waiting" : "…"}</span>
                    </li>
                  ))}
                </ul>
              )}
            </>
          ) : outcome ? (
            <div className="rf-agent-main">
              <span className={`rf-agent-badge is-${outcome.tone}`} aria-hidden="true">
                <Icon name={outcome.tone === "error" ? "alert" : "check"} size={14} strokeWidth={2} />
              </span>
              <div className="rf-agent-text">
                <p className="rf-agent-title">{outcome.title}</p>
                <p className="rf-agent-detail" title={outcome.detail}>{outcome.detail}</p>
                <div className="rf-agent-actions">
                  {outcome.retry && (
                    <button className="rf-btn rf-btn-sm" onClick={() => { onDismiss(); outcome.retry!(); }}>
                      <Icon name="refresh" size={13} /> Retry
                    </button>
                  )}
                  <button className="rf-btn rf-btn-sm rf-btn-quiet" onClick={onDismiss}>
                    Dismiss
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <div className="rf-agent-idle">
              <p>Nothing running. Ask the AI Director for an edit, or analyse media from the library.</p>
              <button className="rf-btn rf-btn-sm" onClick={onOpenDirector}>
                AI Director
              </button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function Indicator({ activity }: { activity: Activity }) {
  if (activity.phase === "waiting") {
    return (
      <span className="rf-agent-badge is-waiting" aria-hidden="true">
        <Icon name="info" size={15} />
      </span>
    );
  }
  if (activity.progress !== null) {
    const r = 15;
    const c = 2 * Math.PI * r;
    return (
      <svg className="rf-ring" width="36" height="36" viewBox="0 0 36 36" aria-hidden="true">
        <circle cx="18" cy="18" r={r} className="rf-ring-track" />
        <circle cx="18" cy="18" r={r} className="rf-ring-fill" strokeDasharray={c} strokeDashoffset={c * (1 - activity.progress)} />
        <text x="18" y="18" dy="0.35em" textAnchor="middle">{Math.round(activity.progress * 100)}</text>
      </svg>
    );
  }
  return (
    <svg className="rf-ring is-spinning" width="36" height="36" viewBox="0 0 36 36" aria-hidden="true">
      <circle cx="18" cy="18" r="15" className="rf-ring-track" />
      <circle cx="18" cy="18" r="15" className="rf-ring-fill" strokeDasharray="24 70" />
    </svg>
  );
}

function Steps({ steps }: { steps: NonNullable<Activity["steps"]> }) {
  return (
    <ol className="rf-steps">
      {steps.map((s, i) => (
        <li key={s.label} className={`is-${s.state}`} aria-current={s.state === "active" ? "step" : undefined}>
          <span className="rf-step-node" aria-hidden="true">
            {s.state === "done" ? <Icon name="check" size={11} strokeWidth={2.6} /> : s.state === "failed" ? <Icon name="x" size={11} strokeWidth={2.6} /> : i + 1}
          </span>
          <span className="rf-step-label">
            {s.label}
            <span className="rf-sr"> ({s.state})</span>
          </span>
        </li>
      ))}
    </ol>
  );
}
