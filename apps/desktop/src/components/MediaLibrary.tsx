import { useMemo, useRef, useState, type MouseEvent as RMouseEvent, type PointerEvent as RPointerEvent } from "react";
import type { AnalysisKind, Asset } from "@reelforge/core/schema";
import { analysisOf, type AnalysisMap } from "../analyses.ts";
import { formatClock, type Rational } from "@reelforge/core/timebase";
import type { Client } from "../api.ts";
import { useThumbnail } from "../editor.ts";
import { Icon, type IconName } from "../icons.tsx";
import { PopupMenu, type MenuItem } from "./ui.tsx";

const FILTERS = [
  { value: "all", label: "All media" },
  { value: "video", label: "Video" },
  { value: "audio", label: "Audio" },
  { value: "image", label: "Images" },
] as const;
type Filter = (typeof FILTERS)[number]["value"];
const GROUPS: { kind: Asset["kind"]; label: string }[] = [
  { kind: "video", label: "Video" },
  { kind: "image", label: "Images" },
  { kind: "audio", label: "Audio" },
];

interface Props {
  client: Client | null;
  projectId: string | null;
  fps: Rational;
  assets: Asset[];
  importing: boolean;
  dropHover: boolean;
  onImport: () => void;
  onAppend: (assets: Asset[]) => void;
  onRelink: (asset: Asset) => void;
  onDragStart: (asset: Asset, e: PointerEvent) => void;
  analyses: AnalysisMap;
  onAnalyze: (asset: Asset, kinds: AnalysisKind[]) => void;
  onCollapse: () => void;
}

function kindsFor(a: Asset): AnalysisKind[] {
  if (a.kind === "image") return [];
  return [...(a.kind === "video" ? (["scenes"] as const) : []), ...(a.hasAudio ? (["beats", "transcript"] as const) : [])];
}

function ratio(w: number, h: number): string {
  const g = (a: number, b: number): number => (b ? g(b, a % b) : a);
  const d = g(w, h);
  const r = `${w / d}:${h / d}`;
  return r.length > 6 ? (w / h).toFixed(2) : r;
}

function metaLine(a: Asset): string {
  const kind = a.kind === "video" ? "Video" : a.kind === "audio" ? "Audio" : "Image";
  if (a.width && a.height) return `${kind} · ${a.width}×${a.height} · ${ratio(a.width, a.height)}`;
  if (a.kind === "audio" && a.sampleRate) return `${kind} · ${(a.sampleRate / 1000).toFixed(1)} kHz${a.channels === 1 ? " · mono" : a.channels === 2 ? " · stereo" : ""}`;
  return kind;
}

/** One-line summary of what analysis found, or how far it got. */
function AnalysisLine({ asset, analyses, onAnalyze }: { asset: Asset; analyses: AnalysisMap; onAnalyze: Props["onAnalyze"] }) {
  const kinds = kindsFor(asset);
  if (!kinds.length || asset.status === "missing") return null;
  const items = kinds.map((k) => analysisOf(analyses, asset.id, k)).filter(Boolean);
  const running = items.find((a) => a!.state === "queued" || a!.state === "running");
  if (running) {
    return (
      <div className="rf-asset-analysis is-running" role="status">
        <span className="rf-spinner" aria-hidden="true" />
        <span>
          {running.kind === "transcript" ? "Transcribing" : `Analysing ${running.kind}`} {running.state === "running" ? `${Math.round(running.progress * 100)}%` : "· queued"}
        </span>
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
  if (failed) {
    return (
      <div className="rf-asset-analysis is-failed">
        <span title={failed.error ?? undefined}>Analysis failed</span>
        <button className="rf-link-btn" onClick={() => onAnalyze(asset, kinds)}>
          <Icon name="refresh" size={12} /> Retry
        </button>
      </div>
    );
  }
  if (!parts.length) return null;
  return (
    <div className="rf-asset-analysis">
      <span>
        {parts.join(" · ")}
        {stale ? " · outdated" : ""}
      </span>
    </div>
  );
}

export function MediaLibrary(p: Props) {
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const anchorId = useRef<string | null>(null);
  const shown = useMemo(
    () => p.assets.filter((a) => (filter === "all" || a.kind === filter) && a.filename.toLowerCase().includes(query.trim().toLowerCase())),
    [p.assets, filter, query],
  );
  const groups = GROUPS.map((g) => ({ ...g, items: shown.filter((a) => a.kind === g.kind) })).filter((g) => g.items.length);
  const order = groups.flatMap((g) => g.items);

  const select = (a: Asset, e: RMouseEvent | RPointerEvent) => {
    if (e.shiftKey && anchorId.current) {
      const i = order.findIndex((x) => x.id === anchorId.current);
      const j = order.findIndex((x) => x.id === a.id);
      if (i >= 0 && j >= 0) {
        setSelected(new Set(order.slice(Math.min(i, j), Math.max(i, j) + 1).map((x) => x.id)));
        return;
      }
    }
    anchorId.current = a.id;
    if (e.metaKey || e.ctrlKey) {
      setSelected((s) => {
        const n = new Set(s);
        n.has(a.id) ? n.delete(a.id) : n.add(a.id);
        return n;
      });
    } else setSelected(new Set([a.id]));
  };
  /** Actions on a card act on the whole selection when the card is part of it. */
  const targetsFor = (a: Asset) => (selected.has(a.id) && selected.size > 1 ? order.filter((x) => selected.has(x.id)) : [a]);

  return (
    <section className={`rf-panel rf-library${p.dropHover ? " is-drop-target" : ""}`} aria-label="Media library">
      <div className="rf-panel-head">
        <h2>Media Library</h2>
        <button className="rf-btn rf-btn-mint rf-btn-sm" onClick={p.onImport} disabled={!p.projectId || p.importing}>
          <Icon name="upload" size={15} /> {p.importing ? "Importing…" : "Import"}
        </button>
        <button className="rf-icon-btn rf-icon-btn-sm" onClick={p.onCollapse} aria-label="Hide panel" data-tip="Hide panel">
          <Icon name="panelLeft" size={16} />
        </button>
      </div>
      <div className="rf-library-tools">
        <label className="rf-search">
          <Icon name="search" size={15} />
          <input placeholder="Search media…" aria-label="Search media" value={query} onChange={(e) => setQuery(e.target.value)} />
          {query && (
            <button className="rf-icon-btn rf-icon-btn-xs" onClick={() => setQuery("")} aria-label="Clear search">
              <Icon name="x" size={12} />
            </button>
          )}
        </label>
        <div className="rf-select">
          <select aria-label="Media type" value={filter} onChange={(e) => setFilter(e.target.value as Filter)}>
            {FILTERS.map((f) => (
              <option key={f.value} value={f.value}>
                {f.label}
              </option>
            ))}
          </select>
          <Icon name="chevronDown" size={14} />
        </div>
      </div>

      {p.assets.length === 0 && !p.importing ? (
        <div className="rf-empty">
          <div className="rf-empty-icon">
            <Icon name="film" size={24} />
          </div>
          <p className="rf-empty-title">No media yet</p>
          <p className="rf-empty-body">Import or drop MP4, MOV, JPEG, PNG, WAV or MP3 files. Originals are only read, never modified.</p>
          <button className="rf-btn rf-btn-sm" onClick={p.onImport} disabled={!p.projectId}>
            <Icon name="upload" size={14} /> Import media
          </button>
        </div>
      ) : shown.length === 0 && !p.importing ? (
        <p className="rf-library-none">
          No {filter === "all" ? "" : FILTERS.find((f) => f.value === filter)!.label.toLowerCase() + " "}media matches “{query}”.
        </p>
      ) : (
        <div className="rf-library-scroll" onPointerDown={(e) => e.target === e.currentTarget && setSelected(new Set())}>
          {p.importing && (
            <div className="rf-asset-grid">
              <div className="rf-asset is-importing" role="status">
                <div className="rf-asset-thumb">
                  <span className="rf-asset-placeholder">
                    <span className="rf-spinner" aria-hidden="true" />
                  </span>
                </div>
                <div className="rf-asset-name">Importing…</div>
                <div className="rf-asset-sub">Probing and building proxies</div>
              </div>
            </div>
          )}
          {groups.map((g) => {
            const open = !closed.has(g.kind);
            return (
              <section key={g.kind} className="rf-asset-group">
                <button
                  className="rf-group-head"
                  aria-expanded={open}
                  onClick={() =>
                    setClosed((c) => {
                      const n = new Set(c);
                      n.has(g.kind) ? n.delete(g.kind) : n.add(g.kind);
                      return n;
                    })
                  }
                >
                  <Icon name={open ? "chevronDown" : "chevronRight"} size={14} />
                  {g.label} <span className="rf-group-count">{g.items.length}</span>
                </button>
                {open && (
                  <ul className="rf-asset-grid" aria-label={g.label}>
                    {g.items.map((a) => (
                      <AssetCard
                        key={a.id}
                        {...p}
                        asset={a}
                        selected={selected.has(a.id)}
                        onSelect={select}
                        targets={() => targetsFor(a)}
                      />
                    ))}
                  </ul>
                )}
              </section>
            );
          })}
        </div>
      )}
    </section>
  );
}

const KIND_ICON: Record<Asset["kind"], IconName> = { video: "video", audio: "waveform", image: "image" };

function AssetCard({
  asset,
  client,
  projectId,
  fps,
  onAppend,
  onRelink,
  onDragStart,
  analyses,
  onAnalyze,
  selected,
  onSelect,
  targets,
}: Props & { asset: Asset; selected: boolean; onSelect: (a: Asset, e: RMouseEvent | RPointerEvent) => void; targets: () => Asset[] }) {
  const url = useThumbnail(client, projectId ?? "", asset);
  const [attempt, setAttempt] = useState(0);
  const [thumb, setThumb] = useState<{ src: string; state: "loading" | "ready" | "failed" } | null>(null);
  const src = url ? `${url}&r=${attempt}` : null;
  const state = !src ? null : thumb?.src === src ? thumb.state : "loading";
  const down = useRef<{ x: number; y: number } | null>(null);
  const [menu, setMenu] = useState<DOMRect | null>(null);
  const missing = asset.status === "missing";

  const onPointerDown = (e: RPointerEvent) => {
    if (e.button !== 0) return;
    onSelect(asset, e);
    if (missing) return;
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
    window.addEventListener(
      "pointerup",
      () => {
        down.current = null;
        window.removeEventListener("pointermove", move);
      },
      { once: true },
    );
  };

  const kinds = kindsFor(asset);
  const items: MenuItem[] = [];
  const list = targets();
  const online = list.filter((x) => x.status !== "missing");
  items.push({ label: list.length > 1 ? `Add ${online.length} to timeline` : "Add to timeline", icon: "plus", disabled: !online.length, onSelect: () => onAppend(online) });
  if (kinds.length && !missing) items.push({ label: "Analyse (scenes, beats, speech)", icon: "director", onSelect: () => list.forEach((x) => kindsFor(x).length && x.status !== "missing" && onAnalyze(x, kindsFor(x))) });
  // Changed on disk counts too: exports refuse it until it's relinked (to the same or the updated file).
  if (asset.status !== "online") items.push({ label: "Relink file…", icon: "link", onSelect: () => onRelink(asset) });

  return (
    <li className={`rf-asset${missing ? " is-missing" : ""}${selected ? " is-selected" : ""}`} aria-selected={selected}>
      <button
        className={`rf-asset-thumb${asset.hasAlpha ? " is-alpha" : ""}`}
        onPointerDown={onPointerDown}
        onDoubleClick={() => !missing && onAppend([asset])}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !missing) onAppend(targets().filter((x) => x.status !== "missing"));
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          if (!selected) onSelect(asset, e);
          setMenu(new DOMRect(e.clientX, e.clientY, 0, 0));
        }}
        title={missing ? `${asset.filename}: file not found at ${asset.sourcePath}` : `${asset.filename}\nDrag to the timeline, double-click or Enter to append`}
        aria-label={`${asset.filename}, ${asset.kind}${missing ? ", offline" : ""}${selected ? ", selected" : ""}`}
      >
        {src && state !== "failed" && (
          <img
            key={src}
            src={src}
            alt=""
            draggable={false}
            className={`${asset.kind === "audio" ? "is-wave" : ""}${state === "ready" ? " is-ready" : ""}`}
            onLoad={() => setThumb({ src, state: "ready" })}
            onError={() => setThumb({ src, state: "failed" })}
          />
        )}
        {(state !== "ready" || !src) && (
          <span className="rf-asset-placeholder">
            {missing ? (
              <Icon name="alert" size={20} />
            ) : state === "loading" ? (
              <span className="rf-spinner" aria-label="Loading thumbnail" />
            ) : state === "failed" ? (
              <span className="rf-thumb-failed">
                <Icon name={KIND_ICON[asset.kind]} size={20} />
                <span>No thumbnail</span>
              </span>
            ) : (
              <Icon name={KIND_ICON[asset.kind]} size={20} />
            )}
          </span>
        )}
        <span className="rf-asset-duration">{asset.durationFrames === null ? "Still" : formatClock(asset.durationFrames, fps)}</span>
        {missing && <span className="rf-asset-badge rf-badge-danger">Offline</span>}
        {asset.status === "changed" && <span className="rf-asset-badge rf-badge-warn">Changed</span>}
        {asset.vfr && !missing && (
          <span className="rf-asset-badge rf-badge-warn" title="Variable frame rate: mapped to the project timebase by time">
            VFR
          </span>
        )}
        {selected && (
          <span className="rf-asset-check" aria-hidden="true">
            <Icon name="check" size={11} strokeWidth={2.6} />
          </span>
        )}
      </button>
      {state === "failed" && (
        <button className="rf-link-btn rf-thumb-retry" onClick={() => setAttempt((n) => n + 1)}>
          <Icon name="refresh" size={11} /> Retry thumbnail
        </button>
      )}
      <div className="rf-asset-meta">
        <div className="rf-asset-text">
          <span className="rf-asset-name">{asset.filename}</span>
          <span className="rf-asset-sub">{metaLine(asset)}</span>
        </div>
        <button
          className="rf-icon-btn rf-icon-btn-xs rf-asset-more"
          aria-label={`Actions for ${asset.filename}`}
          aria-haspopup="menu"
          aria-expanded={!!menu}
          onClick={(e) => setMenu(e.currentTarget.getBoundingClientRect())}
        >
          <Icon name="more" size={16} strokeWidth={2.4} />
        </button>
      </div>
      {asset.status !== "online" && (
        <button className="rf-link-btn" onClick={() => onRelink(asset)}>
          <Icon name="link" size={12} /> Relink
        </button>
      )}
      <AnalysisLine asset={asset} analyses={analyses} onAnalyze={onAnalyze} />
      {menu && <PopupMenu anchor={menu} items={items} label={`Actions for ${asset.filename}`} onClose={() => setMenu(null)} />}
    </li>
  );
}
