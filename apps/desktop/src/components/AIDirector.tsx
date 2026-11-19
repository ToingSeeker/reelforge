import { useEffect, useMemo, useRef, useState } from "react";
import type { AIProposal, Timeline, TimelineOp } from "@reelforge/core/schema";
import { isSlashCommand, parseSlash, planSlash, slashSuggestions, type SlashCommandInfo } from "@reelforge/core/slash";
import type { ProjectContext } from "@reelforge/core/context";
import { ApiError, type AIProviderInfo, type Client } from "../api.ts";
import type { Notify } from "../editor.ts";
import { Icon } from "../icons.tsx";
import { ProposalCard } from "./ProposalCard.tsx";
import { captionRequest } from "../caption-intent.ts";
import type { AiRun } from "../activity.ts";

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
  /** Lifecycle of the latest request, for the activity card and the logo. */
  onRun: (run: AiRun | null) => void;
  /** Bring this panel into view (from the activity card). */
  onOpen: () => void;
  /** Apply a slash command's edits directly, as one undo step. */
  onCommand: (label: string, ops: TimelineOp[]) => void;
}

const MODEL_KEY = "rf.aiModel";
const SUGGESTIONS = [
  "Tambahkan fade in 0,5 detik di awal dan fade out di akhir",
  "Potong klip video mengikuti beat musik",
  "Buat caption dari voiceover dengan gaya Bold",
  "Zoom pelan (Ken Burns) di klip terakhir",
];

// The closed model select shows only the option text, so each option names its provider too.
const SHORT: Record<string, string> = { anthropic: "Claude API", "claude-code": "Claude Code", codex: "Codex", ollama: "Local" };

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
  const [pending, setPending] = useState<{ instruction: string; started: number; abort: AbortController; mode: "model" | "captions"; step: 0 | 1; stage?: string } | null>(null);
  const [applying, setApplying] = useState<string | null>(null);
  const [result, setResult] = useState<{ phase: "applied"; instruction: string; summary: string } | { phase: "failed"; instruction: string; error: string } | null>(null);
  const [, setTick] = useState(0);
  const [consent, setConsent] = useState<{ instruction: string; context: ProjectContext | null } | null>(null);
  const [active, setActive] = useState(0);
  const [menuOff, setMenuOff] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);
  const projectId = p.timeline?.project.id ?? null;

  useEffect(() => {
    if (!p.client) return;
    void p.client.aiProviders().then(setProviders, () => setProviders([]));
  }, [p.client]);

  // Default model: Claude with an API key, else an installed Claude Code or Codex, else the first local model.
  useEffect(() => {
    if (!providers.length) return;
    const valid = choice && providers.some((x) => x.id === choice.provider && x.models.includes(choice.model));
    if (valid) return;
    const ready = (x: AIProviderInfo) => x.models.length > 0 && (x.id === "anthropic" ? x.credential !== "none" : x.available !== false);
    const order = ["anthropic", "claude-code", "codex", "ollama"];
    const first = order.map((id) => providers.find((x) => x.id === id && ready(x))).find(Boolean) ?? providers.find((x) => x.id === "anthropic");
    if (first) setChoice({ provider: first.id, model: first.defaultModel ?? first.models[0]! });
  }, [providers]);

  useEffect(() => {
    if (!p.client || !projectId) {
      setThread([]);
      return;
    }
    void p.client.proposals(projectId).then((list) => setThread(list.reverse()), () => {});
  }, [p.client, projectId]);

  // Proposals also come and go from elsewhere (the phone remote, MCP clients): look again every few
  // seconds, and only re-render when something actually changed.
  useEffect(() => {
    if (!p.client || !projectId) return;
    const client = p.client;
    const id = window.setInterval(() => {
      void client.proposals(projectId).then(
        (list) => setThread((t) => (JSON.stringify(t) === JSON.stringify([...list].reverse()) ? t : [...list].reverse())),
        () => {},
      );
    }, 4000);
    return () => window.clearInterval(id);
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
    const captions = captionRequest(instruction); // needs no model: whisper.cpp + the engine
    if (!p.client || !projectId || (!choice && !captions) || pending) return;
    const abort = new AbortController();
    setResult(null);
    setPending({ instruction, started: Date.now(), abort, mode: captions ? "captions" : "model", step: 0, ...(captions ? { stage: "Finding the speech on the timeline…" } : {}) });
    try {
      const proposal = captions
        ? await captionProposal(projectId, instruction, captions.style, abort.signal, (stage, step) => setPending((x) => (x ? { ...x, stage, step } : x)))
        : await p.client.propose(projectId, { instruction, provider: choice!.provider, model: choice!.model, selection: p.selection }, abort.signal);
      setThread((t) => (t.some((x) => x.id === proposal.id) ? t : [...t, proposal])); // the poll may have brought it already
      setText("");
    } catch (e) {
      if (abort.signal.aborted) p.notify("info", "Request cancelled.");
      else if (e instanceof ApiError && e.code === "CONSENT_REQUIRED") {
        setConsent({ instruction, context: null });
        void p.client.context(projectId).then((context) => setConsent((c) => (c ? { ...c, context } : c)));
      } else {
        const error = e instanceof Error ? e.message : String(e);
        setResult({ phase: "failed", instruction, error });
        p.notify("error", error);
      }
    } finally {
      setPending(null);
    }
  };

  // Captions need what the model can't do: hear the audio. Transcribe locally (whisper.cpp) where it's
  // missing, then let the engine time a caption to each word. The result is a normal proposal.
  const captionProposal = async (projectId: string, instruction: string, style: string | undefined, signal: AbortSignal, stage: (s: string, step: 0 | 1) => void) => {
    const client = p.client!;
    for (let round = 0; round < 3; round++) {
      const r = await client.proposeCaptions(projectId, { instruction, ...(style ? { style } : {}) });
      if ("proposal" in r) return r.proposal;
      const names = r.missing.map((m) => m.filename).join(", ");
      for (;;) {
        if (signal.aborted) throw new DOMException("cancelled", "AbortError");
        const all = Object.values(await client.analyses(projectId)).flat();
        const mine = all.filter((a) => a.kind === "transcript" && r.missing.some((m) => m.assetId === a.assetId)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        const latest = r.missing.map((m) => mine.find((a) => a.assetId === m.assetId));
        const failed = latest.find((a) => a?.state === "failed");
        if (failed) throw new Error(`Transcription failed: ${failed.error ?? "unknown error"}`);
        if (latest.every((a) => a?.state === "completed")) break;
        const progress = latest.reduce((n, a) => n + (a?.progress ?? 0), 0) / latest.length;
        stage(`Transcribing speech locally (${names}) · ${Math.round(progress * 100)}%`, 0);
        await new Promise((ok) => setTimeout(ok, 1000));
      }
      stage("Timing captions to each word…", 1);
    }
    throw new Error("The transcripts finished but the captions still couldn't be planned. Try again.");
  };

  const decide = async (proposal: AIProposal, action: "apply" | "reject") => {
    if (!p.client) return;
    try {
      if (action === "apply") {
        setApplying(proposal.id);
        const r = await p.client.applyProposal(proposal.id);
        setResult({ phase: "applied", instruction: proposal.instruction, summary: proposal.summary });
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
    } finally {
      setApplying(null);
    }
  };

  // Slash commands edit the selected clips right away: no model, no proposal, one undo step.
  const runSlash = (input: string) => {
    if (!p.timeline) return;
    const parsed = parseSlash(input);
    if (!parsed.ok) return p.notify("error", parsed.error);
    const plan = planSlash(p.timeline, p.selection, parsed.command);
    if (!plan.ok) return p.notify("error", plan.error);
    p.onCommand(plan.label, plan.ops);
    setText("");
    const n = plan.ops.length;
    const skipped = plan.skipped ? ` (${plan.skipped} skipped)` : "";
    p.notify("info", `${plan.label} on ${n} clip${n === 1 ? "" : "s"}${skipped}. Undo with ⌘Z.`);
  };

  const slash = isSlashCommand(text);
  const suggestions = menuOff ? [] : slashSuggestions(text);
  const pick = suggestions[Math.min(active, suggestions.length - 1)];
  const complete = (c: SlashCommandInfo) => {
    setText(`/${c.name}${c.usage.includes(" ") ? " " : ""}`);
    setActive(0);
  };
  const submit = () => {
    const value = text.trim();
    if (!value) return;
    if (slash) runSlash(value);
    else void send(value);
  };

  const grant = async () => {
    if (!p.client || !projectId || !consent) return;
    await p.client.setConsent(projectId, true, choice?.provider);
    const instruction = consent.instruction;
    setConsent(null);
    void send(instruction);
  };

  // The newest proposal that can still be applied to this exact revision is waiting for the user.
  const revision = p.timeline?.project.revision;
  const waiting = [...thread].reverse().find((x) => x.status === "pending" && x.baseRevision === revision) ?? null;
  const applyingProposal = applying ? thread.find((x) => x.id === applying) : null;
  const run = useMemo<AiRun | null>(() => {
    if (pending)
      return { phase: "planning", mode: pending.mode, instruction: pending.instruction, model: pending.mode === "model" ? (choice?.model ?? null) : null, step: pending.step, stage: pending.stage ?? null, cancel: () => pending.abort.abort() };
    if (applyingProposal) return { phase: "applying", mode: applyingProposal.provider === "reelforge" ? "captions" : "model", instruction: applyingProposal.instruction };
    if (waiting) return { phase: "review", mode: waiting.provider === "reelforge" ? "captions" : "model", instruction: waiting.instruction, summary: waiting.summary, open: p.onOpen };
    if (result?.phase === "failed") return { ...result, retry: () => void send(result.instruction) };
    return result;
  }, [pending, applyingProposal?.id, waiting?.id, result, choice?.model]);
  const onRun = p.onRun;
  useEffect(() => {
    onRun(run);
  }, [run]);

  // One group per provider; a CLI agent that isn't installed stays listed but can't be picked.
  const groups = useMemo(
    () =>
      providers
        .filter((x) => x.models.length)
        .map((x) => ({
          id: x.id,
          label: `${x.label}${x.id === "anthropic" && x.credential === "none" ? " (no key)" : x.available === false ? (x.id === "ollama" ? " (offline)" : " (not installed)") : ""}`,
          options: x.models.map((m) => ({ value: `${x.id}|${m}`, label: `${SHORT[x.id] ?? x.label} · ${m.replace(/^claude-/, "")}`, disabled: x.available === false })),
        })),
    [providers],
  );

  return (
    <div className="rf-director">
      <div className="rf-director-head">
        <span className="rf-director-mark">
          <Icon name="director" size={22} />
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
          {!groups.length && <option value="">No models</option>}
          {groups.map((g) => (
            <optgroup key={g.id} label={g.label}>
              {g.options.map((o) => (
                <option key={o.value} value={o.value} disabled={o.disabled}>
                  {o.label}
                </option>
              ))}
            </optgroup>
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
            <p className="rf-hint">
              Shortcut: type <kbd>/</kbd> to change the selected clips instantly, e.g. <code>/bw</code>, <code>/zoom in</code> or <code>/fade 0.5</code>.
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
                Claude needs an API key. <button className="rf-link-btn" onClick={p.onOpenSettings}>Add it in Settings</button>, or pick Claude Code, Codex or a local model.
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
              <span className="rf-spinner" aria-hidden="true" /> {pending.stage ?? `Planning with ${choice?.model}`} · {Math.round((Date.now() - pending.started) / 1000)}s
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
          submit();
        }}
      >
        {suggestions.length > 0 && (
          <div className="rf-menu rf-slash-menu" role="listbox" id="rf-slash-list" aria-label="Slash commands">
            {suggestions.map((c) => (
              <button
                key={c.name}
                type="button"
                role="option"
                id={`rf-slash-${c.name}`}
                aria-selected={c === pick}
                className={`rf-menu-item${c === pick ? " is-active" : ""}`}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => complete(c)}
              >
                <span className="rf-slash-usage">{c.usage}</span>
                <span className="rf-menu-text rf-menu-meta">{c.hint}</span>
              </button>
            ))}
          </div>
        )}
        {p.selection.length > 0 && <span className="rf-sel-chip" title="The AI Director will focus on the selected clips">{p.selection.length} selected</span>}
        <input
          placeholder="Tell me what to edit, or type / for shortcuts…"
          aria-label="Instruction for the AI Director"
          role="combobox"
          aria-expanded={suggestions.length > 0}
          aria-controls="rf-slash-list"
          aria-activedescendant={pick ? `rf-slash-${pick.name}` : undefined}
          value={text}
          maxLength={4000}
          disabled={!!pending || !projectId}
          onChange={(e) => {
            setText(e.target.value);
            setActive(0);
            setMenuOff(false);
          }}
          onKeyDown={(e) => {
            if (!suggestions.length || e.nativeEvent.isComposing) return;
            const word = text.trim().slice(1).toLowerCase();
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              const step = e.key === "ArrowDown" ? 1 : -1;
              setActive((i) => (Math.min(i, suggestions.length - 1) + step + suggestions.length) % suggestions.length);
            } else if (e.key === "Tab" || (e.key === "Enter" && pick && pick.name !== word)) {
              // Enter completes a half-typed name; on a full one it runs the command.
              e.preventDefault();
              if (pick) complete(pick);
            } else if (e.key === "Escape") {
              e.preventDefault();
              setMenuOff(true);
            }
          }}
        />
        <button className="rf-send" disabled={!text.trim() || !!pending || (!choice && !slash)} aria-label={slash ? "Run command" : "Send"}>
          <Icon name="send" size={17} />
        </button>
      </form>

      {consent && <ConsentDialog provider={provider?.id === "codex" ? "Codex (OpenAI)" : provider?.id === "claude-code" ? "Claude Code (Anthropic)" : (provider?.label ?? "Claude")} context={consent.context} onAllow={() => void grant()} onCancel={() => setConsent(null)} />}
    </div>
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
