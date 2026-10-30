import { useMemo, useRef, useState, type PointerEvent as RPointerEvent } from "react";
import type { AnalysisKind, Asset } from "@reelforge/core/schema";
import { analysisOf, type AnalysisMap } from "../analyses.ts";
import { formatClock, type Rational } from "@reelforge/core/timebase";
import type { Client } from "../api.ts";
import { useThumbnail } from "../editor.ts";
import { Icon, type IconName } from "../icons.tsx";

const FILTERS = ["All", "Video", "Audio", "Image"] as const;
type Filter = (typeof FILTERS)[number];

interface Props {
  client: Client | null;
  projectId: string | null;
  fps: Rational;
  assets: Asset[];
  importing: boolean;
  dropHover: boolean;
  onImport: () => void;
  onAppend: (asset: Asset) => void;
  onRelink: (asset: Asset) => void;
  onDragStart: (asset: Asset, e: PointerEvent) => void;
  analyses: AnalysisMap;
  onAnalyze: (asset: Asset, kinds: AnalysisKind[]) => void;
}

function kindsFor(a: Asset): AnalysisKind[] {
  if (a.kind === "image") return [];
  return [...(a.kind === "video" ? (["scenes"] as const) : []), ...(a.hasAudio ? (["beats", "transcript"] as const) : [])];
}

/** One-line summary of what analysis found (or how far it got). */
function AnalysisLine({ asset, analyses, onAnalyze }: { asset: Asset; analyses: AnalysisMap; onAnalyze: Props["onAnalyze"] }) {
  const kinds = kindsFor(asset);
  if (!kinds.length || asset.status === "missing") return null;
  const items = kinds.map((k) => analysisOf(analyses, asset.id, k)).filter(Boolean);
  const running = items.find((a) => a!.state === "queued" || a!.state === "running");
  if (running) {
    return (
      <div className="rf-asset-analysis is-running" role="status">
        <span className="rf-spinner" aria-hidden="true" /> {running.kind === "transcript" ? "Transcribing" : `Analysing ${running.kind}`}{" "}
        {running.state === "running" ? `${Math.round(running.progress * 100)}%` : "(queued)"}
      </div>
    );
  }
  const parts: string[] = [];
  const scenes = analysisOf(analyses, asset.id, "scenes");
  const beats = analysisOf(analyses, asset.id, "beats");
  const tr = analysisOf(analyses, asset.id, "transcript");
  if (scenes?.result) parts.push(`${scenes.result.cuts.length + 1} scene${scenes.result.cuts.length ? "s" : ""}`);
  if (beats?.result) parts.push(beats.result.confidence >= 0.3 ? `${Math.round(beats.result.bpm)} BPM` : "no clear beat");
  if (tr?.result) parts.push(tr.result.segments.length ? `speech · ${tr.result.language}` : "no speech");
  const failed = items.find((a) => a!.state === "failed");
  const stale = items.some((a) => a!.stale);
  return (
    <div className="rf-asset-analysis">
      <span title={failed?.error ?? undefined}>{failed ? "Analysis failed" : parts.join(" · ") || "Not analysed"}{stale ? " · outdated" : ""}</span>
      <button className="rf-link-btn" onClick={() => onAnalyze(asset, kinds)} title={`Detect ${kinds.join(", ")} (runs locally)`}>
        <Icon name="sparkle" size={12} /> {parts.length || failed ? "Re-run" : "Analyse"}
      </button>
    </div>
  );
}

export function MediaLibrary(p: Props) {
  const [filter, setFilter] = useState<Filter>("All");
  const [query, setQuery] = useState("");
  const shown = useMemo(
    () =>
      p.assets.filter(
        (a) => (filter === "All" || a.kind === filter.toLowerCase()) && a.filename.toLowerCase().includes(query.trim().toLowerCase()),
      ),
    [p.assets, filter, query],
  );

  return (
    <section className={`rf-panel rf-library${p.dropHover ? " is-drop-target" : ""}`} aria-label="Media library">
      <div className="rf-panel-head">
        <h2>Media Library</h2>
        <button className="rf-btn" onClick={p.onImport} disabled={!p.projectId || p.importing}>
          <Icon name="plus" size={15} /> {p.importing ? "Importing…" : "Import"}
        </button>
      </div>
      <label className="rf-search">
        <Icon name="search" size={15} />
        <input placeholder="Search media…" aria-label="Search media" value={query} onChange={(e) => setQuery(e.target.value)} />
      </label>
      <div className="rf-segmented" role="tablist" aria-label="Media type">
        {FILTERS.map((f) => (
          <button key={f} role="tab" aria-selected={filter === f} onClick={() => setFilter(f)}>
            {f}
          </button>
        ))}
      </div>

      {p.assets.length === 0 ? (
        <div className="rf-empty">
          <div className="rf-empty-icon">
            <Icon name="film" size={26} />
          </div>
          <p className="rf-empty-title">No media yet</p>
          <p className="rf-empty-body">
            Import or drop MP4, MOV, JPEG, PNG, WAV or MP3 files. Originals are only ever read, never modified.
          </p>
        </div>
      ) : shown.length === 0 ? (
        <p className="rf-library-none">No {filter === "All" ? "" : filter.toLowerCase() + " "}media matches “{query}”.</p>
      ) : (
        <ul className="rf-asset-grid">
          {shown.map((a) => (
            <AssetCard key={a.id} {...p} asset={a} />
          ))}
        </ul>
      )}
    </section>
  );
}

const KIND_ICON: Record<Asset["kind"], IconName> = { video: "film", audio: "audio", image: "media" };

function AssetCard({ asset, client, projectId, fps, onAppend, onRelink, onDragStart, analyses, onAnalyze }: Props & { asset: Asset }) {
  const thumb = useThumbnail(client, projectId ?? "", asset);
  const down = useRef<{ x: number; y: number } | null>(null);

  const onPointerDown = (e: RPointerEvent) => {
    if (e.button !== 0 || asset.status === "missing") return;
    down.current = { x: e.clientX, y: e.clientY };
    const move = (ev: PointerEvent) => {
      if (!down.current) return;
      if (Math.hypot(ev.clientX - down.current.x, ev.clientY - down.current.y) > 4) {
        down.current = null;
        window.removeEventListener("pointermove", move);
        onDragStart(asset, ev);
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", () => {
      down.current = null;
      window.removeEventListener("pointermove", move);
    }, { once: true });
  };

  const missing = asset.status === "missing";
  return (
    <li className={`rf-asset${missing ? " is-missing" : ""}`}>
      <button
        className="rf-asset-thumb"
        onPointerDown={onPointerDown}
        onDoubleClick={() => !missing && onAppend(asset)}
        title={missing ? `${asset.filename} — file not found at ${asset.sourcePath}` : `${asset.filename}\nDrag to the timeline or double-click to append`}
        aria-label={`${asset.filename}, ${asset.kind}${missing ? ", offline" : ""}`}
      >
        {thumb ? (
          <img src={thumb} alt="" draggable={false} className={asset.kind === "audio" ? "is-wave" : ""} />
        ) : (
          <span className="rf-asset-placeholder">
            <Icon name={missing ? "alert" : KIND_ICON[asset.kind]} size={22} />
          </span>
        )}
        <span className="rf-asset-duration">{asset.durationFrames === null ? "Still" : formatClock(asset.durationFrames, fps)}</span>
        {missing && <span className="rf-asset-badge rf-badge-danger">Offline</span>}
        {asset.status === "changed" && <span className="rf-asset-badge rf-badge-warn">Changed</span>}
        {asset.vfr && !missing && <span className="rf-asset-badge rf-badge-warn" title="Variable frame rate: mapped to the project timebase by time">VFR</span>}
      </button>
      <div className="rf-asset-meta">
        <span className="rf-asset-name">{asset.filename}</span>
        {missing && (
          <button className="rf-link-btn" onClick={() => onRelink(asset)}>
            <Icon name="link" size={13} /> Relink
          </button>
        )}
      </div>
      <AnalysisLine asset={asset} analyses={analyses} onAnalyze={onAnalyze} />
    </li>
  );
}
