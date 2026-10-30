import { useEffect, useMemo, useRef, useState } from "react";
import type { AIProposal, Timeline } from "@reelforge/core/schema";
import type { ProjectContext } from "@reelforge/core/context";
import { formatClock } from "@reelforge/core/timebase";
import { ApiError, type AIProviderInfo, type Client } from "../api.ts";
import type { Notify } from "../editor.ts";
import { Icon } from "../icons.tsx";

interface Props {
  client: Client | null;
  timeline: Timeline | null;
  selection: string[];
  notify: Notify;
  /** Show a proposal's result in the live preview before it's applied (null = stop). */
  onPreview: (proposal: AIProposal | null) => void;
  previewing: string | null;
  onApplied: (timeline: Timeline) => void;
  onOpenSettings: () => void;
}

const MODEL_KEY = "rf.aiModel";
const SUGGESTIONS = [
  "Tambahkan fade in 0,5 detik di awal dan fade out di akhir",
  "Potong klip video mengikuti beat musik",
  "Buat caption dari voiceover dengan gaya Bold",
  "Zoom pelan (Ken Burns) di klip terakhir",
];

function readModel(): { provider: string; model: string } | null {
  try {
    return JSON.parse(localStorage.getItem(MODEL_KEY) ?? "null");
  } catch {
    return null;
  }
}

export function AIDirector(p: Props) {
  const [providers, setProviders] = useState<AIProviderInfo[]>([]);
  const [choice, setChoice] = useState<{ provider: string; model: string } | null>(readModel);
  const [thread, setThread] = useState<AIProposal[]>([]);
  const [text, setText] = useState("");
  const [pending, setPending] = useState<{ instruction: string; started: number; abort: AbortController } | null>(null);
  const [, setTick] = useState(0);
  const [consent, setConsent] = useState<{ instruction: string; context: ProjectContext | null } | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const projectId = p.timeline?.project.id ?? null;

  useEffect(() => {
    if (!p.client) return;
    void p.client.aiProviders().then(setProviders, () => setProviders([]));
  }, [p.client]);

  // Default model: a configured Claude if there is one, else the first local model.
  useEffect(() => {
    if (!providers.length) return;
    const valid = choice && providers.some((x) => x.id === choice.provider && x.models.includes(choice.model));
    if (valid) return;
    const claude = providers.find((x) => x.id === "anthropic");
    const local = providers.find((x) => x.id === "ollama" && x.available && x.models.length);
    const pick = claude && claude.credential !== "none" ? { provider: "anthropic", model: claude.defaultModel! } : local ? { provider: "ollama", model: local.models[0]! } : claude ? { provider: "anthropic", model: claude.defaultModel! } : null;
    if (pick) setChoice(pick);
  }, [providers]);

  useEffect(() => {
    if (!p.client || !projectId) {
      setThread([]);
      return;
    }
    void p.client.proposals(projectId).then((list) => setThread(list.reverse()), () => {});
  }, [p.client, projectId]);

  useEffect(() => {
    if (!pending) return;
    const id = window.setInterval(() => setTick((n) => n + 1), 1000);
    return () => window.clearInterval(id);
  }, [pending]);

  // Braces matter: scrollIntoView returns a Promise in current Chromium, and React treats a returned value as a cleanup.
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [thread.length, pending]);

  const provider = providers.find((x) => x.id === choice?.provider);

  const send = async (instruction: string) => {
    if (!p.client || !projectId || !choice || pending) return;
    const abort = new AbortController();
    setPending({ instruction, started: Date.now(), abort });
    try {
      const proposal = await p.client.propose(projectId, { instruction, provider: choice.provider, model: choice.model, selection: p.selection }, abort.signal);
      setThread((t) => [...t, proposal]);
      setText("");
    } catch (e) {
      if (abort.signal.aborted) p.notify("info", "Request cancelled.");
      else if (e instanceof ApiError && e.code === "CONSENT_REQUIRED") {
        setConsent({ instruction, context: null });
        void p.client.context(projectId).then((context) => setConsent((c) => (c ? { ...c, context } : c)));
      } else p.notify("error", e instanceof Error ? e.message : String(e));
    } finally {
      setPending(null);
    }
  };

  const decide = async (proposal: AIProposal, action: "apply" | "reject") => {
    if (!p.client) return;
    try {
      if (action === "apply") {
        const r = await p.client.applyProposal(proposal.id);
        setThread((t) => t.map((x) => (x.id === r.proposal.id ? r.proposal : x)));
        p.onPreview(null);
        p.onApplied(r.timeline);
        p.notify("info", "Applied to the timeline. Undo with ⌘Z.");
      } else {
        const r = await p.client.rejectProposal(proposal.id);
        setThread((t) => t.map((x) => (x.id === r.id ? r : x)));
        if (p.previewing === proposal.id) p.onPreview(null);
      }
    } catch (e) {
      if (e instanceof ApiError && e.code === "REVISION_CONFLICT") {
        setThread((t) => t.map((x) => (x.id === proposal.id ? { ...x, status: "stale" } : x)));
        p.notify("error", "The timeline changed since this proposal was made, so it wasn't applied. Regenerate it.");
      } else p.notify("error", e instanceof Error ? e.message : String(e));
    }
  };

  const grant = async () => {
    if (!p.client || !projectId || !consent) return;
    await p.client.setConsent(projectId, true);
    const instruction = consent.instruction;
    setConsent(null);
    void send(instruction);
  };

  const options = useMemo(
    () =>
      providers.flatMap((x) =>
        x.models.map((m) => ({ value: `${x.id}|${m}`, label: `${x.id === "anthropic" ? "Claude" : "Local"} · ${m}${x.id === "anthropic" && x.credential === "none" ? " (no key)" : ""}`, disabled: x.id === "ollama" && !x.available })),
      ),
    [providers],
  );

  return (
    <div className="rf-director">
      <div className="rf-director-head">
        <span className="rf-director-mark">
          <Icon name="sparkle" size={22} />
        </span>
        <div>
          <h2>AI Director</h2>
          <p>Your creative copilot for video editing</p>
        </div>
        <select
          className="rf-input rf-input-sm rf-model-select"
          aria-label="AI model"
          value={choice ? `${choice.provider}|${choice.model}` : ""}
          onChange={(e) => {
            const [provider, model] = e.target.value.split("|") as [string, string];
            setChoice({ provider, model });
            try {
              localStorage.setItem(MODEL_KEY, JSON.stringify({ provider, model }));
            } catch {
              /* best effort */
            }
          }}
        >
          {!options.length && <option value="">No models</option>}
          {options.map((o) => (
            <option key={o.value} value={o.value} disabled={o.disabled}>
              {o.label}
            </option>
          ))}
        </select>
      </div>

      <div className="rf-director-body">
        {thread.length === 0 && !pending && (
          <div className="rf-director-intro">
            <p className="rf-empty-title">Describe it. Edit it. Ship it.</p>
            <p className="rf-empty-body">
              Tell the AI Director what you want. It proposes concrete timeline changes you can preview, then apply or reject. Nothing changes until you press
              Apply, and every applied proposal can be undone.
            </p>
            <div className="rf-suggestions">
              {SUGGESTIONS.map((s) => (
                <button key={s} className="rf-chip-btn" onClick={() => setText(s)}>
                  {s}
                </button>
              ))}
            </div>
            {provider?.id === "anthropic" && provider.credential === "none" && (
              <p className="rf-hint">
                Claude needs an API key. <button className="rf-link-btn" onClick={p.onOpenSettings}>Add it in Settings</button>, or pick a local model.
              </p>
            )}
          </div>
        )}

        {thread.map((x) => (
          <ProposalCard
            key={x.id}
            proposal={x}
            timeline={p.timeline}
            previewing={p.previewing === x.id}
            onPreview={() => p.onPreview(p.previewing === x.id ? null : x)}
            onApply={() => void decide(x, "apply")}
            onReject={() => void decide(x, "reject")}
            onRegenerate={() => void send(x.instruction)}
          />
        ))}

        {pending && (
          <>
            <div className="rf-msg rf-msg-user">{pending.instruction}</div>
            <div className="rf-msg rf-msg-ai is-loading" role="status">
              <span className="rf-spinner" aria-hidden="true" /> Planning with {choice?.model} · {Math.round((Date.now() - pending.started) / 1000)}s
              <button className="rf-link-btn" onClick={() => pending.abort.abort()}>
                Cancel
              </button>
            </div>
          </>
        )}
        <div ref={bottom} />
      </div>

      <form
        className="rf-director-input"
        onSubmit={(e) => {
          e.preventDefault();
          if (text.trim()) void send(text.trim());
        }}
      >
        {p.selection.length > 0 && <span className="rf-sel-chip" title="The AI Director will focus on the selected clips">{p.selection.length} selected</span>}
        <input
          placeholder="Tell me what to edit, add, or change…"
          aria-label="Instruction for the AI Director"
          value={text}
          maxLength={4000}
          disabled={!!pending || !choice || !projectId}
          onChange={(e) => setText(e.target.value)}
        />
        <button className="rf-send" disabled={!text.trim() || !!pending || !choice} aria-label="Send">
          <Icon name="send" size={17} />
        </button>
      </form>

      {consent && <ConsentDialog provider={provider?.label ?? "Claude"} context={consent.context} onAllow={() => void grant()} onCancel={() => setConsent(null)} />}
    </div>
  );
}

function ProposalCard(p: {
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
  const [open, setOpen] = useState(false);
  const time = new Date(x.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return (
    <>
      <div className="rf-msg rf-msg-user">
        {x.instruction}
        <span className="rf-msg-time">{time}</span>
      </div>
      <div className={`rf-msg rf-msg-ai rf-proposal is-${x.status}`}>
        <div className="rf-proposal-head">
          <strong>{x.operations.length ? "Edit plan ready" : "No changes"}</strong>
          <span className="rf-msg-time">{x.model}</span>
        </div>
        <p>{x.summary}</p>
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
              <button className="rf-btn" onClick={p.onRegenerate}>
                Regenerate
              </button>
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
            Out of date (the timeline changed). <button className="rf-link-btn" onClick={p.onRegenerate}>Regenerate</button>
          </p>
        )}
      </div>
    </>
  );
}

function ConsentDialog(p: { provider: string; context: ProjectContext | null; onAllow: () => void; onCancel: () => void }) {
  const [show, setShow] = useState(false);
  const c = p.context;
  const transcripts = c?.assets.filter((a) => a.analysis.transcript?.text).length ?? 0;
  return (
    <div className="rf-scrim" onMouseDown={(e) => e.target === e.currentTarget && p.onCancel()}>
      <div className="rf-dialog" role="dialog" aria-modal="true" aria-labelledby="rf-consent-title">
        <div className="rf-dialog-head">
          <h2 id="rf-consent-title">Send this project to {p.provider}?</h2>
        </div>
        <p className="rf-empty-body">
          To plan edits, {p.provider} needs to read this project's description. Your video and audio files never leave this Mac. This is what is sent with each
          request:
        </p>
        <ul className="rf-consent-list">
          <li>Project settings and the timeline ({c ? `${c.timeline.clips.length} clips, ${c.timeline.captions.length} captions` : "…"})</li>
          <li>File names and technical details of {c ? c.assets.length : "…"} media files</li>
          <li>Analysis results: scenes, beats{transcripts ? `, and transcripts of ${transcripts} file(s)` : ""}</li>
        </ul>
        <button className="rf-link-btn" onClick={() => setShow((s) => !s)} aria-expanded={show}>
          {show ? "Hide" : "Show"} the exact data
        </button>
        {show && <pre className="rf-consent-json">{c ? JSON.stringify(c, null, 2) : "Loading…"}</pre>}
        <p className="rf-hint">You can revoke this at any time. Local models (Ollama) never need this.</p>
        <div className="rf-dialog-actions">
          <button className="rf-btn" onClick={p.onCancel}>
            Cancel
          </button>
          <button className="rf-btn rf-btn-primary" onClick={p.onAllow} autoFocus>
            Allow for this project
          </button>
        </div>
      </div>
    </div>
  );
}
