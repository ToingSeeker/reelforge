import { useEffect, useMemo, useRef, useState } from "react";
import type { Asset, AnalysisKind, RenderJob } from "@reelforge/core/schema";
import type { AnalysisMap } from "./analyses.ts";
import type { LogoState } from "./components/ReelForgeLogo.tsx";

/**
 * Agent activity: one model for everything the engine or the AI is doing on the user's behalf, built only
 * from real state (AI Director requests, analysis jobs, exports, preview renders). Nothing here invents
 * progress or steps: progress is null (indeterminate) unless the backend reports a fraction.
 */

export type ActivityKind = "analyze" | "edit" | "render";
export type StepState = "done" | "active" | "pending" | "failed";

export interface ActivityStep {
  label: string;
  state: StepState;
}

export interface Activity {
  id: string;
  kind: ActivityKind;
  /** running = working; waiting = finished its part, the user has to act (review a proposal). */
  phase: "running" | "waiting";
  title: string;
  detail: string;
  /** 0..1 as reported by the engine; null = no measurable progress. */
  progress: number | null;
  steps?: ActivityStep[];
  cancel?: () => void;
  action?: { label: string; run: () => void };
}

export interface Outcome {
  id: number;
  tone: "success" | "error";
  title: string;
  detail: string;
  retry?: () => void;
}

/** What the AI Director reports about its latest request (lifted so the activity card and logo can follow it). */
export type AiRun =
  | { phase: "planning"; mode: "model" | "captions"; instruction: string; model: string | null; step: 0 | 1; stage: string | null; cancel: () => void }
  | { phase: "review"; mode: "model" | "captions"; instruction: string; summary: string; open: () => void }
  | { phase: "applying"; mode: "model" | "captions"; instruction: string }
  | { phase: "applied"; instruction: string; summary: string }
  | { phase: "failed"; instruction: string; error: string; retry: () => void };

const AI_STEPS = {
  model: ["Plan edits", "Review", "Apply changes"],
  captions: ["Transcribe speech", "Time captions", "Review & apply"],
} as const;

function steps(labels: readonly string[], active: number, failed = false): ActivityStep[] {
  return labels.map((label, i) => ({ label, state: i < active ? "done" : i === active ? (failed ? "failed" : "active") : "pending" }));
}

const ANALYSIS_LABEL: Record<AnalysisKind, string> = { scenes: "Detecting scenes", beats: "Finding the beat", transcript: "Transcribing speech" };

interface Sources {
  ai: AiRun | null;
  analyses: AnalysisMap;
  assets: readonly Asset[];
  onAnalyze: (asset: Asset, kinds: AnalysisKind[]) => void;
  exportJob: RenderJob | null;
  exportDone: RenderJob | null;
  cancelExport: () => void;
  previewJob: RenderJob | null;
  /** AI-effect bakes the preview is waiting on. */
  fxBaking: { done: number; total: number; progress: number | null } | null;
  /** A motion graphic being rendered by the engine. */
  motionRender: { template: string; progress: number } | null;
}

export function useAgentActivity(s: Sources) {
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const push = (o: Omit<Outcome, "id">) => setOutcome({ ...o, id: Date.now() });

  // Analysis jobs that finish while this window watches them become outcomes (old failures stay quiet).
  const watching = useRef(new Map<string, { asset: Asset; kind: AnalysisKind }>());
  useEffect(() => {
    const byId = new Map(s.assets.map((a) => [a.id, a]));
    for (const list of s.analyses.values()) {
      for (const a of list) {
        const key = `${a.assetId}:${a.kind}`;
        const asset = byId.get(a.assetId);
        if (!asset) continue;
        if (a.state === "queued" || a.state === "running") watching.current.set(key, { asset, kind: a.kind });
        else if (watching.current.has(key)) {
          watching.current.delete(key);
          if (a.state === "failed") push({ tone: "error", title: `${ANALYSIS_LABEL[a.kind]} failed`, detail: `${asset.filename}: ${a.error ?? "unknown error"}`, retry: () => s.onAnalyze(asset, [a.kind]) });
          else push({ tone: "success", title: "Analysis complete", detail: asset.filename });
        }
      }
    }
  }, [s.analyses]);

  useEffect(() => {
    const j = s.exportDone;
    if (!j) return;
    if (j.state === "completed") push({ tone: "success", title: "Export finished", detail: j.outputPath ?? "" });
    else if (j.state === "failed") push({ tone: "error", title: "Export failed", detail: j.error?.message ?? "unknown error" });
  }, [s.exportDone?.id]);

  useEffect(() => {
    const ai = s.ai;
    if (ai?.phase === "applied") push({ tone: "success", title: "Changes applied", detail: ai.summary || ai.instruction });
    else if (ai?.phase === "failed") push({ tone: "error", title: "AI request failed", detail: ai.error, retry: ai.retry });
  }, [s.ai]);

  // A success is a short acknowledgement; an error stays until dismissed or replaced.
  useEffect(() => {
    if (outcome?.tone !== "success") return;
    const id = window.setTimeout(() => setOutcome((o) => (o?.id === outcome.id ? null : o)), 4000);
    return () => window.clearTimeout(id);
  }, [outcome]);

  const active = useMemo<Activity[]>(() => {
    const out: Activity[] = [];
    const j = s.exportJob;
    if (j) {
      out.push({
        id: `export:${j.id}`,
        kind: "render",
        phase: "running",
        title: j.state === "queued" ? "Export queued" : "Exporting video",
        detail: j.outputPath?.split("/").pop() ?? "MP4 · H.264 / AAC",
        progress: j.state === "queued" ? null : j.progress,
        cancel: s.cancelExport,
      });
    }
    const ai = s.ai;
    if (ai && (ai.phase === "planning" || ai.phase === "review" || ai.phase === "applying")) {
      const labels = AI_STEPS[ai.mode];
      if (ai.phase === "planning") {
        out.push({
          id: "ai",
          kind: "analyze",
          phase: "running",
          title: ai.mode === "captions" ? (ai.step === 0 ? "Transcribing speech" : "Timing captions") : "Planning edits",
          detail: ai.stage ?? (ai.model ? `${ai.model} · “${ai.instruction}”` : `“${ai.instruction}”`),
          progress: null,
          steps: steps(labels, ai.mode === "captions" ? ai.step : 0),
          cancel: ai.cancel,
        });
      } else if (ai.phase === "review") {
        out.push({
          id: "ai",
          kind: "analyze",
          phase: "waiting",
          title: "Proposal ready to review",
          detail: ai.summary || `“${ai.instruction}”`,
          progress: null,
          steps: steps(labels, ai.mode === "captions" ? 2 : 1),
          action: { label: "Review", run: ai.open },
        });
      } else {
        out.push({ id: "ai", kind: "edit", phase: "running", title: "Applying changes", detail: `“${ai.instruction}”`, progress: null, steps: steps(labels, 2) });
      }
    }
    const byId = new Map(s.assets.map((a) => [a.id, a]));
    for (const list of s.analyses.values()) {
      for (const a of list) {
        if (a.state !== "queued" && a.state !== "running") continue;
        out.push({
          id: `analysis:${a.id}`,
          kind: "analyze",
          phase: "running",
          title: a.state === "queued" ? `${ANALYSIS_LABEL[a.kind]} (queued)` : ANALYSIS_LABEL[a.kind],
          detail: byId.get(a.assetId)?.filename ?? "media",
          progress: a.state === "running" ? a.progress : null,
        });
      }
    }
    const fx = s.fxBaking;
    if (fx) {
      out.push({
        id: "fx-bake",
        kind: "render",
        phase: "running",
        title: "Baking AI effects",
        detail: `${fx.done} of ${fx.total} ready · preview shows clips without them until done`,
        progress: fx.progress,
      });
    }
    const m = s.motionRender;
    if (m) {
      out.push({ id: "motion", kind: "render", phase: "running", title: "Rendering motion graphic", detail: m.template, progress: m.progress > 0 ? m.progress : null });
    }
    const p = s.previewJob;
    if (p) {
      out.push({
        id: `preview:${p.id}`,
        kind: "render",
        phase: "running",
        title: "Rendering preview",
        detail: `Revision ${p.revision} · same graph as the export`,
        progress: p.state === "queued" ? null : p.progress,
      });
    }
    return out;
  }, [s.exportJob, s.ai, s.analyses, s.assets, s.previewJob, s.cancelExport, s.fxBaking, s.motionRender]);

  // A new run supersedes an old error.
  useEffect(() => {
    if (active.some((a) => a.phase === "running")) setOutcome((o) => (o?.tone === "error" ? null : o));
  }, [active.length]);

  const primary = active.find((a) => a.phase === "running") ?? active[0] ?? null;
  return { active, primary, outcome, dismiss: () => setOutcome(null), logo: logoStateFor(primary, outcome) };
}

/** The one place that turns agent lifecycle into the logo's motion state. */
export function logoStateFor(primary: Activity | null, outcome: Outcome | null): LogoState {
  if (primary?.phase === "running") return primary.kind;
  if (outcome) return outcome.tone;
  return "idle";
}
