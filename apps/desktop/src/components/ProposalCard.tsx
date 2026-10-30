// One proposal in the AI Director thread: who asked, what the plan changes, and Apply/Reject.

import { useState } from "react";
import type { AIProposal, Timeline } from "@reelforge/core/schema";
import { formatClock } from "@reelforge/core/timebase";
import { Icon } from "../icons.tsx";

export function ProposalCard(p: {
  proposal: AIProposal;
  timeline: Timeline | null;
  previewing: boolean;
  onPreview: () => void;
  onApply: () => void;
  onReject: () => void;
  onRegenerate: () => void;
}) {
  const x = p.proposal;
  const fps = p.timeline?.project.settings.fps ?? { num: 30, den: 1 };
  // Written by an MCP client, not typed here: say so, and lead with the engine's change list.
  const fromClient = x.provider === "mcp";
  const [open, setOpen] = useState(fromClient);
  const time = new Date(x.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return (
    <>
      {fromClient ? (
        <div className="rf-msg rf-msg-ai rf-proposal-origin">
          <Icon name="alert" size={12} /> Proposed by an external AI client “{x.model}”, not by you. Check the changes before applying.
          <span className="rf-msg-time">{time}</span>
        </div>
      ) : (
        <div className="rf-msg rf-msg-user">
          {x.instruction}
          <span className="rf-msg-time">{time}</span>
        </div>
      )}
      <div className={`rf-msg rf-msg-ai rf-proposal is-${x.status}`}>
        <div className="rf-proposal-head">
          <strong>{x.operations.length ? "Edit plan ready" : "No changes"}</strong>
          <span className="rf-msg-time">{x.model}</span>
        </div>
        <p>{fromClient ? <>The client describes it as: “{x.summary}”</> : x.summary}</p>
        {x.warnings.length > 0 && (
          <ul className="rf-proposal-warnings">
            {x.warnings.map((w, i) => (
              <li key={i}>
                <Icon name="alert" size={12} /> {w}
              </li>
            ))}
          </ul>
        )}
        {x.changes.length > 0 && (
          <>
            <button className="rf-link-btn rf-proposal-toggle" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
              {open ? "Hide" : "Show"} {x.changes.length} change{x.changes.length === 1 ? "" : "s"} · {formatClock(x.durationBefore, fps)} → {formatClock(x.durationAfter, fps)}
            </button>
            {open && (
              <ul className="rf-diff">
                {x.changes.map((c, i) => (
                  <li key={i} className={`rf-diff-${c.kind}`}>
                    <div className="rf-diff-label">
                      <span className="rf-diff-kind">{c.kind}</span> {c.label}
                    </div>
                    {c.before && <div className="rf-diff-before">− {c.before}</div>}
                    {c.after && <div className="rf-diff-after">+ {c.after}</div>}
                  </li>
                ))}
                {x.explanations.some(Boolean) && (
                  <li className="rf-diff-why">
                    {x.explanations.filter(Boolean).map((w, i) => (
                      <div key={i}>• {w}</div>
                    ))}
                  </li>
                )}
              </ul>
            )}
          </>
        )}
        {x.status === "pending" && x.operations.length > 0 && (
          <div className="rf-proposal-actions">
            <button className="rf-btn rf-btn-primary rf-btn-block" onClick={p.onApply}>
              <Icon name="sparkle" size={15} /> Apply to timeline
            </button>
            <div className="rf-proposal-row">
              <button className="rf-btn" aria-pressed={p.previewing} onClick={p.onPreview}>
                {p.previewing ? "Stop preview" : "Preview plan"}
              </button>
              {!fromClient && (
                <button className="rf-btn" onClick={p.onRegenerate}>
                  Regenerate
                </button>
              )}
              <button className="rf-btn" onClick={p.onReject}>
                Reject
              </button>
            </div>
          </div>
        )}
        {x.status === "applied" && <p className="rf-proposal-status">Applied{x.approval ? ` · approved in ${x.approval.channel.split(":")[0]}` : ""} · undo with ⌘Z</p>}
        {x.status === "rejected" && <p className="rf-proposal-status">Rejected</p>}
        {x.status === "stale" && (
          <p className="rf-proposal-status">
            Out of date (the timeline changed).{" "}
            {!fromClient && (
              <button className="rf-link-btn" onClick={p.onRegenerate}>
                Regenerate
              </button>
            )}
          </p>
        )}
      </div>
    </>
  );
}
