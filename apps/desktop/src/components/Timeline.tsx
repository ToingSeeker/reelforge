import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent } from "react";
import type { Asset, Caption, Clip, Timeline as TimelineData, TimelineOp, Track } from "@reelforge/core/schema";
import { canPlace } from "@reelforge/core/timeline-ops";
import { trackLabels } from "@reelforge/core/schema";
import { formatClock, type Rational } from "@reelforge/core/timebase";
import type { Client } from "../api.ts";
import { useThumbnail } from "../editor.ts";
import { Icon, type IconName } from "../icons.tsx";

const HEADER_W = 196; // keep in step with --track-head-w in app.css
const SNAP_PX = 8;
const EDGE_PX = 7;
const MIN_PX_PER_FRAME = 0.02;
const MAX_PX_PER_FRAME = 24;

export interface AssetDropHandler {
  (asset: Asset, clientX: number, clientY: number): boolean;
}

interface Props {
  client: Client | null;
  timeline: TimelineData | null;
  selection: ReadonlySet<string>;
  onSelect: (ids: Set<string>) => void;
  playhead: number;
  onPlayhead: (frame: number) => void;
  onApply: (label: string, ops: TimelineOp[]) => void;
  onSplit: () => void;
  onDelete: (ripple: boolean) => void;
  registerDrop: (handler: AssetDropHandler | null) => void;
  assetDragging: Asset | null;
  /** Beat / scene-cut markers per clip, in timeline frames. */
  markers: ReadonlyMap<string, { beats: number[]; cuts: number[] }>;
  /** Extra snap targets (beats, scene cuts) when beat snapping is on. */
  snapExtra: readonly number[];
  selectedCaption: string | null;
  onSelectCaption: (id: string | null) => void;
}

type Drag =
  | { kind: "caption"; caption: Caption; originX: number; delta: number; moved: boolean }
  | { kind: "move"; clip: Clip; originX: number; delta: number; trackId: string; moved: boolean }
  | { kind: "trim-start" | "trim-end"; clip: Clip; originX: number; delta: number; moved: boolean }
  | { kind: "playhead" };

function rulerStep(fps: Rational, pxPerFrame: number): number {
  const perSecond = (fps.num / fps.den) * pxPerFrame;
  const steps = [0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
  return steps.find((s) => s * perSecond >= 72) ?? 600;
}

export function Timeline(p: Props) {
  const tl = p.timeline;
  const fps = tl?.project.settings.fps ?? { num: 30, den: 1 };
  const fpsNum = fps.num / fps.den;
  const scroller = useRef<HTMLDivElement>(null);
  const [viewW, setViewW] = useState(800);
  const [pxPerFrame, setPx] = useState<number | null>(null);
  const [snap, setSnap] = useState(true);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [dropHover, setDropHover] = useState<{ trackId: string; frame: number; ok: boolean } | null>(null);
  const labels = useMemo(() => trackLabels(tl?.tracks ?? []), [tl?.tracks]);
  const assets = useMemo(() => new Map((tl?.assets ?? []).map((a) => [a.id, a])), [tl?.assets]);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewW(el.clientWidth - HEADER_W));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const fitPx = useCallback(() => {
    const frames = Math.max(tl?.durationFrames ?? 0, Math.round(30 * fpsNum));
    return Math.min(MAX_PX_PER_FRAME, Math.max(MIN_PX_PER_FRAME, (viewW - 40) / (frames * 1.08)));
  }, [tl?.durationFrames, fpsNum, viewW]);

  // First fit per project; afterwards zoom is the user's.
  const fittedFor = useRef<string | null>(null);
  useEffect(() => {
    if (tl && fittedFor.current !== tl.project.id && viewW > 100) {
      fittedFor.current = tl.project.id;
      setPx(fitPx());
    }
  }, [tl, viewW, fitPx]);

  const px = pxPerFrame ?? fitPx();
  const contentFrames = Math.max((tl?.durationFrames ?? 0) + Math.round(10 * fpsNum), p.playhead + Math.round(fpsNum), Math.ceil(viewW / px));
  const contentW = contentFrames * px;

  // Only clips, captions and ruler ticks near the viewport are mounted. The window moves in whole
  // viewport-sized steps (one viewport of margin each side) so scrolling re-renders the rows rarely.
  const [scrollChunk, setScrollChunk] = useState(0);
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const chunkW = Math.max(200, viewW);
    const update = () => setScrollChunk(Math.floor(el.scrollLeft / chunkW));
    update();
    el.addEventListener("scroll", update, { passive: true });
    return () => el.removeEventListener("scroll", update);
  }, [viewW]);
  const visPx = useMemo(() => {
    const chunkW = Math.max(200, viewW);
    return { from: (scrollChunk - 1) * chunkW, to: (scrollChunk + 3) * chunkW };
  }, [scrollChunk, viewW]);

  const frameAtClientX = useCallback(
    (clientX: number) => {
      const el = scroller.current!;
      const x = clientX - el.getBoundingClientRect().left - HEADER_W + el.scrollLeft;
      return Math.max(0, Math.round(x / px));
    },
    [px],
  );

  const snapPoints = useCallback(
    (exclude: string | null) => {
      const pts = [0, p.playhead, ...p.snapExtra];
      for (const c of tl?.clips ?? []) if (c.id !== exclude) pts.push(c.start, c.start + c.duration);
      for (const c of tl?.captions ?? []) if (c.id !== exclude) pts.push(c.start, c.start + c.duration);
      return pts;
    },
    [tl?.clips, tl?.captions, p.playhead, p.snapExtra],
  );

  const snapFrame = useCallback(
    (frames: number[], exclude: string | null): number => {
      // Returns the correction (in frames) that snaps the closest of `frames` to a snap point.
      if (!snap) return 0;
      const limit = SNAP_PX / px;
      let best = 0;
      let bestDist = Infinity;
      for (const f of frames) {
        for (const s of snapPoints(exclude)) {
          const d = Math.abs(s - f);
          if (d <= limit && d < bestDist) {
            best = s - f;
            bestDist = d;
          }
        }
      }
      return best;
    },
    [snap, px, snapPoints],
  );

  const trackAtClientY = (clientY: number): Track | null => {
    const el = document.elementsFromPoint(scroller.current!.getBoundingClientRect().left + HEADER_W + 4, clientY).find((n) =>
      (n as HTMLElement).dataset?.trackId,
    ) as HTMLElement | undefined;
    return tl?.tracks.find((t) => t.id === el?.dataset.trackId) ?? null;
  };

  // Library → timeline drop target
  useEffect(() => {
    if (!tl) {
      p.registerDrop(null);
      return;
    }
    p.registerDrop((asset, x, y) => {
      setDropHover(null);
      const rect = scroller.current?.getBoundingClientRect();
      if (!rect || x < rect.left + HEADER_W || x > rect.right || y < rect.top || y > rect.bottom) return false;
      const track = trackAtClientY(y);
      if (!track) return false;
      if (!canPlace(asset, track.kind)) return false;
      p.onApply("Add clip", [{ type: "clip.add", trackId: track.id, assetId: asset.id, start: frameAtClientX(x) }]);
      return true;
    });
    return () => p.registerDrop(null);
  });

  useEffect(() => {
    if (!p.assetDragging) {
      setDropHover(null);
      return;
    }
    const move = (e: PointerEvent) => {
      const rect = scroller.current?.getBoundingClientRect();
      if (!rect || e.clientX < rect.left + HEADER_W || e.clientY < rect.top || e.clientY > rect.bottom) return setDropHover(null);
      const track = trackAtClientY(e.clientY);
      setDropHover(track ? { trackId: track.id, frame: frameAtClientX(e.clientX), ok: canPlace(p.assetDragging!, track.kind) && !track.locked } : null);
    };
    window.addEventListener("pointermove", move);
    return () => window.removeEventListener("pointermove", move);
  });

  // Clip / playhead dragging
  useEffect(() => {
    if (!drag) return;
    const move = (e: PointerEvent) => {
      if (drag.kind === "playhead") return p.onPlayhead(frameAtClientX(e.clientX));
      const raw = Math.round((e.clientX - drag.originX) / px);
      if (drag.kind === "caption") {
        const c = drag.caption;
        let delta = Math.max(-c.start, raw);
        delta += snapFrame([c.start + delta, c.start + delta + c.duration], c.id);
        setDrag({ ...drag, delta: Math.max(-c.start, delta), moved: drag.moved || Math.abs(e.clientX - drag.originX) > 3 });
        return;
      }
      const moved = drag.moved || Math.abs(e.clientX - drag.originX) > 3;
      const c = drag.clip;
      if (drag.kind === "move") {
        const target = trackAtClientY(e.clientY);
        const trackId = target && !target.locked && assets.get(c.assetId) && canPlace(assets.get(c.assetId)!, target.kind) ? target.id : drag.trackId;
        let delta = Math.max(-c.start, raw);
        delta += snapFrame([c.start + delta, c.start + delta + c.duration], c.id);
        setDrag({ ...drag, delta: Math.max(-c.start, delta), trackId, moved });
      } else {
        const edge = drag.kind === "trim-start" ? c.start : c.start + c.duration;
        let delta = raw + snapFrame([edge + raw], c.id);
        if (drag.kind === "trim-start") delta = Math.min(delta, c.duration - 1);
        else delta = Math.max(delta, 1 - c.duration);
        setDrag({ ...drag, delta, moved });
      }
    };
    const up = () => {
      if (drag.kind === "caption") {
        if (drag.moved && drag.delta) p.onApply("Move caption", [{ type: "caption.update", captionId: drag.caption.id, start: drag.caption.start + drag.delta }]);
        setDrag(null);
        return;
      }
      if (drag.kind !== "playhead" && drag.moved) {
        const c = drag.clip;
        if (drag.kind === "move" && (drag.delta !== 0 || drag.trackId !== c.trackId)) {
          p.onApply("Move clip", [{ type: "clip.move", clipId: c.id, start: c.start + drag.delta, ...(drag.trackId !== c.trackId ? { trackId: drag.trackId } : {}) }]);
        } else if (drag.kind === "trim-start" && drag.delta !== 0) {
          p.onApply("Trim clip", [{ type: "clip.trim", clipId: c.id, edge: "start", frame: c.start + drag.delta }]);
        } else if (drag.kind === "trim-end" && drag.delta !== 0) {
          p.onApply("Trim clip", [{ type: "clip.trim", clipId: c.id, edge: "end", frame: c.start + c.duration + drag.delta }]);
        }
      }
      setDrag(null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up, { once: true });
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  }, [drag, px, frameAtClientX, snapFrame, assets]);

  const startClipDrag = (e: RPointerEvent, clip: Clip, track: Track) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const additive = e.shiftKey || e.metaKey;
    if (additive) {
      const next = new Set(p.selection);
      next.has(clip.id) ? next.delete(clip.id) : next.add(clip.id);
      p.onSelect(next);
    } else if (!p.selection.has(clip.id)) {
      p.onSelect(new Set([clip.id]));
    }
    if (track.locked) return;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const x = e.clientX - rect.left;
    const kind = x < EDGE_PX ? "trim-start" : x > rect.width - EDGE_PX ? "trim-end" : "move";
    setDrag(kind === "move" ? { kind, clip, originX: e.clientX, delta: 0, trackId: clip.trackId, moved: false } : { kind, clip, originX: e.clientX, delta: 0, moved: false });
  };

  const zoomBy = (factor: number) => {
    const el = scroller.current;
    const centerFrame = el ? (el.scrollLeft + viewW / 2) / px : 0;
    const next = Math.min(MAX_PX_PER_FRAME, Math.max(MIN_PX_PER_FRAME, px * factor));
    setPx(next);
    requestAnimationFrame(() => el && (el.scrollLeft = centerFrame * next - viewW / 2));
  };

  const onWheel = (e: React.WheelEvent) => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      zoomBy(e.deltaY < 0 ? 1.15 : 1 / 1.15);
    }
  };

  const step = rulerStep(fps, px);
  const ticks = useMemo(() => {
    const out: number[] = [];
    for (let t = 0; t * fpsNum <= contentFrames; t += step) {
      const x = t * fpsNum * px;
      if (x >= visPx.from - 200 && x <= visPx.to) out.push(t);
    }
    return out;
  }, [step, fpsNum, contentFrames, px, visPx]);
  const hasSelection = p.selection.size > 0;

  // Handlers for the (memoised) track rows read the latest props through a ref, so the rows only
  // re-render when the timeline, zoom, selection or a drag changes, never because the playhead moved.
  const live = useRef({ startClipDrag, p, frameAtClientX });
  live.current = { startClipDrag, p, frameAtClientX };
  const handlers = useMemo<RowHandlers>(
    () => ({
      clipDown: (e, clip, track) => live.current.startClipDrag(e, clip, track),
      laneDown: (e) => {
        live.current.p.onSelect(new Set());
        live.current.p.onPlayhead(live.current.frameAtClientX(e.clientX));
      },
      captionDown: (e, c, track) => {
        live.current.p.onSelect(new Set());
        live.current.p.onSelectCaption(c.id);
        if (!track.locked) setDrag({ kind: "caption", caption: c, originX: e.clientX, delta: 0, moved: false });
      },
      toggle: (track, patch, label) => live.current.p.onApply(label, [{ type: "track.update", trackId: track.id, ...patch }]),
    }),
    [],
  );

  const tools: { label: string; icon: IconName; onClick: () => void; disabled: boolean; tip: string }[] = [
    { label: "Split at playhead", icon: "cut", onClick: p.onSplit, disabled: !tl, tip: "Split at playhead  S" },
    { label: "Delete selected", icon: "trash", onClick: () => p.onDelete(false), disabled: !hasSelection && !p.selectedCaption, tip: "Delete  ⌫" },
    { label: "Ripple delete", icon: "ripple", onClick: () => p.onDelete(true), disabled: !hasSelection, tip: "Ripple delete: close the gap  ⇧⌫" },
  ];

  return (
    <section className="rf-panel rf-timeline" aria-label="Timeline">
      <div className="rf-timeline-toolbar">
        <div className="rf-toolgroup">
          {tools.map((t) => (
            <button key={t.label} className="rf-icon-btn" onClick={t.onClick} disabled={t.disabled} aria-label={t.label} data-tip={t.tip}>
              <Icon name={t.icon} size={17} />
            </button>
          ))}
        </div>
        <span className="rf-toolbar-divider" />
        <button className="rf-icon-btn" aria-pressed={snap} onClick={() => setSnap((v) => !v)} aria-label="Snap" data-tip={snap ? "Snapping on: clip edges, playhead" : "Snapping off"}>
          <Icon name="magnet" size={17} />
        </button>
        <span className="rf-toolbar-meta rf-num-tab">
          {tl ? `${tl.clips.length} clip${tl.clips.length === 1 ? "" : "s"} · ${formatClock(tl.durationFrames, fps)}` : ""}
          {hasSelection ? ` · ${p.selection.size} selected` : ""}
        </span>
        <span className="rf-grow" />
        <div className="rf-zoomgroup">
          <button className="rf-icon-btn rf-icon-btn-sm" onClick={() => zoomBy(1 / 1.4)} aria-label="Zoom out" data-tip="Zoom out  ⌘ scroll">
            <Icon name="minus" size={15} />
          </button>
          <input
            className="rf-slider rf-zoom"
            type="range"
            min={Math.log(MIN_PX_PER_FRAME)}
            max={Math.log(MAX_PX_PER_FRAME)}
            step={0.01}
            value={Math.log(px)}
            style={{ "--rf-fill": `${((Math.log(px) - Math.log(MIN_PX_PER_FRAME)) / (Math.log(MAX_PX_PER_FRAME) - Math.log(MIN_PX_PER_FRAME))) * 100}%` } as React.CSSProperties}
            onChange={(e) => setPx(Math.exp(Number(e.target.value)))}
            aria-label="Timeline zoom"
          />
          <button className="rf-icon-btn rf-icon-btn-sm" onClick={() => zoomBy(1.4)} aria-label="Zoom in" data-tip="Zoom in  ⌘ scroll">
            <Icon name="plus" size={15} />
          </button>
        </div>
        <button className="rf-icon-btn" onClick={() => setPx(fitPx())} aria-label="Fit timeline to window" data-tip="Fit to window">
          <Icon name="fit" size={17} />
        </button>
      </div>

      <div className="rf-timeline-scroll" ref={scroller} onWheel={onWheel}>
        <div className="rf-timeline-content" style={{ width: HEADER_W + contentW }}>
          <div className="rf-ruler-row">
            <div className="rf-track-head rf-ruler-head" />
            <div
              className="rf-ruler"
              style={{ width: contentW, "--rf-minor": `${(step * fpsNum * px) / 5}px` } as React.CSSProperties}
              onPointerDown={(e) => {
                p.onPlayhead(frameAtClientX(e.clientX));
                setDrag({ kind: "playhead" });
              }}
            >
              <RulerTicks ticks={ticks} fpsNum={fpsNum} px={px} fps={fps} />
            </div>
          </div>

          <TrackRows
            client={p.client}
            timeline={tl}
            labels={labels}
            assets={assets}
            px={px}
            contentW={contentW}
            visPx={visPx}
            drag={drag}
            dropHover={dropHover}
            selection={p.selection}
            selectedCaption={p.selectedCaption}
            markers={p.markers}
            handlers={handlers}
          />

          <div className="rf-playhead" style={{ transform: `translateX(${HEADER_W + p.playhead * px}px)` }} aria-hidden="true">
            <span />
          </div>

          {tl && tl.clips.length === 0 && (
            <div className="rf-timeline-hint" style={{ left: HEADER_W }}>
              Drag media from the library onto a track, or double-click a clip in the library to append it.
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

const RulerTicks = memo(function RulerTicks({ ticks, fpsNum, px, fps }: { ticks: number[]; fpsNum: number; px: number; fps: Rational }) {
  return (
    <>
      {ticks.map((t) => (
        <span key={t} className="rf-tick" style={{ left: t * fpsNum * px }}>
          {formatClock(Math.round(t * fpsNum), fps).replace(/\.00$/, "")}
        </span>
      ))}
    </>
  );
});

interface RowHandlers {
  clipDown: (e: RPointerEvent, clip: Clip, track: Track) => void;
  laneDown: (e: RPointerEvent) => void;
  captionDown: (e: RPointerEvent, c: Caption, track: Track) => void;
  toggle: (track: Track, patch: Partial<Track>, label: string) => void;
}

const LANE_ICON: Record<Track["kind"], IconName> = { video: "video", overlay: "layers", audio: "waveform", caption: "captions" };

const TrackRows = memo(function TrackRows(p: {
  client: Client | null;
  timeline: TimelineData | null;
  labels: ReadonlyMap<string, string>;
  assets: ReadonlyMap<string, Asset>;
  px: number;
  contentW: number;
  /** Horizontal pixel window to mount; items outside it are skipped (the dragged and selected ones never are). */
  visPx: { from: number; to: number };
  drag: Drag | null;
  dropHover: { trackId: string; frame: number; ok: boolean } | null;
  selection: ReadonlySet<string>;
  selectedCaption: string | null;
  markers: ReadonlyMap<string, { beats: number[]; cuts: number[] }>;
  handlers: RowHandlers;
}) {
  const tl = p.timeline;
  const { drag, px, handlers } = p;
  const fps = tl?.project.settings.fps ?? { num: 30, den: 1 };
  const inView = (start: number, duration: number) => (start + duration) * px >= p.visPx.from && start * px <= p.visPx.to;
  return (
    <>
      {(tl?.tracks ?? []).map((track) => {
        const allClips = tl!.clips.filter((c) => (drag?.kind === "move" && drag.clip.id === c.id ? drag.trackId : c.trackId) === track.id);
        const allCaptions = track.kind === "caption" ? tl!.captions.filter((c) => c.trackId === track.id) : [];
        const empty = !allClips.length && !allCaptions.length && p.dropHover?.trackId !== track.id && !(drag?.kind === "move");
        const clips = allClips.filter((c) => inView(c.start, c.duration) || p.selection.has(c.id) || (drag && "clip" in drag && drag.clip.id === c.id));
        const captions = allCaptions.filter((c) => inView(c.start, c.duration) || p.selectedCaption === c.id || (drag?.kind === "caption" && drag.caption.id === c.id));
        return (
          <div key={track.id} className={`rf-track-row${empty ? " is-empty" : ""}`} data-kind={track.kind}>
            <TrackHeader track={track} label={p.labels.get(track.id) ?? ""} onToggle={(patch, label) => handlers.toggle(track, patch, label)} />
            <div
              className={`rf-lane rf-lane-${track.kind}${track.locked ? " is-locked" : ""}${track.hidden || track.muted ? " is-dimmed" : ""}`}
              data-track-id={track.id}
              style={{ width: p.contentW }}
              onPointerDown={(e) => {
                if (e.target !== e.currentTarget) return;
                handlers.laneDown(e);
              }}
            >
              {captions.map((c) => {
                const start = c.start + (drag?.kind === "caption" && drag.caption.id === c.id ? drag.delta : 0);
                const sel = p.selectedCaption === c.id;
                return (
                  <div
                    key={c.id}
                    className={`rf-caption-block${sel ? " is-selected" : ""}`}
                    style={{ left: start * px, width: Math.max(2, c.duration * px) }}
                    title={c.text}
                    role="button"
                    aria-pressed={sel}
                    aria-label={`Caption: ${c.text}`}
                    onPointerDown={(e) => {
                      if (e.button !== 0) return;
                      e.stopPropagation();
                      handlers.captionDown(e, c, track);
                    }}
                  >
                    {c.duration * px > 40 && <Icon name="captions" size={13} />}
                    <span className="rf-clip-label">{c.text}</span>
                  </div>
                );
              })}
              {clips.map((c) => {
                let start = c.start;
                let duration = c.duration;
                let sourceIn = c.sourceIn;
                if (drag && (drag.kind === "move" || drag.kind === "trim-start" || drag.kind === "trim-end") && drag.clip.id === c.id) {
                  if (drag.kind === "move") start += drag.delta;
                  else if (drag.kind === "trim-start") {
                    start += drag.delta;
                    duration -= drag.delta;
                    sourceIn += drag.delta;
                  } else duration += drag.delta;
                }
                return (
                  <ClipView
                    key={c.id}
                    client={p.client}
                    projectId={tl!.project.id}
                    clip={c}
                    track={track}
                    asset={p.assets.get(c.assetId)}
                    left={start * px}
                    width={Math.max(2, duration * px)}
                    sourceIn={sourceIn}
                    pxPerFrame={px}
                    selected={p.selection.has(c.id)}
                    markers={p.markers.get(c.id)}
                    range={`${formatClock(start, fps)} – ${formatClock(start + duration, fps)}`}
                    dragging={drag !== null && (drag.kind === "move" || drag.kind === "trim-start" || drag.kind === "trim-end") && drag.clip.id === c.id && drag.moved}
                    onPointerDown={(e) => handlers.clipDown(e, c, track)}
                  />
                );
              })}
              {p.dropHover?.trackId === track.id && <div className={`rf-drop-marker${p.dropHover.ok ? "" : " is-invalid"}`} style={{ left: p.dropHover.frame * px }} />}
            </div>
          </div>
        );
      })}
    </>
  );
});

function TrackHeader({ track, label, onToggle }: { track: Track; label: string; onToggle: (patch: Partial<Track>, label: string) => void }) {
  const audio = track.kind === "audio";
  const name = track.kind === "caption" ? "Captions" : track.name;
  return (
    <div className="rf-track-head">
      <div className="rf-track-controls">
        <button
          className="rf-icon-btn rf-icon-btn-xs"
          aria-pressed={track.locked}
          onClick={() => onToggle({ locked: !track.locked }, track.locked ? "Unlock track" : "Lock track")}
          aria-label={`${track.locked ? "Unlock" : "Lock"} ${label || name}`}
          data-tip={track.locked ? "Unlock" : "Lock"}
        >
          <Icon name={track.locked ? "lock" : "unlock"} size={14} />
        </button>
        {/* Picture tracks: eye = picture, speaker = their videos' own sound. Audio tracks: speaker only. */}
        {!audio && (
          <button
            className="rf-icon-btn rf-icon-btn-xs"
            aria-pressed={track.hidden}
            onClick={() => onToggle({ hidden: !track.hidden }, track.hidden ? "Show track" : "Hide track")}
            aria-label={`${track.hidden ? "Show" : "Hide"} ${label || name}`}
            data-tip={track.hidden ? "Show" : "Hide"}
          >
            <Icon name={track.hidden ? "eyeOff" : "eye"} size={14} />
          </button>
        )}
        {track.kind !== "caption" && (
          <button
            className="rf-icon-btn rf-icon-btn-xs"
            aria-pressed={track.muted}
            onClick={() => onToggle({ muted: !track.muted }, track.muted ? "Unmute track" : "Mute track")}
            aria-label={`${track.muted ? "Unmute" : "Mute"} ${label || name}`}
            data-tip={track.muted ? "Unmute" : audio ? "Mute" : "Mute this track's video sound"}
          >
            <Icon name={track.muted ? "volumeOff" : "volume"} size={14} />
          </button>
        )}
      </div>
      <div className="rf-track-title" title={`${label ? `${label} · ` : ""}${name}`}>
        <Icon name={LANE_ICON[track.kind]} size={15} />
        <span className="rf-track-name">{name}</span>
        {label && track.kind !== "caption" && <span className="rf-track-id">{label}</span>}
      </div>
    </div>
  );
}

interface ClipViewProps {
  client: Client | null;
  projectId: string;
  clip: Clip;
  track: Track;
  asset: Asset | undefined;
  left: number;
  width: number;
  sourceIn: number;
  pxPerFrame: number;
  selected: boolean;
  dragging: boolean;
  onPointerDown: (e: RPointerEvent) => void;
  markers: { beats: number[]; cuts: number[] } | undefined;
  /** Timeline range shown under the name (follows a drag or trim). */
  range: string;
}

function ClipView(p: ClipViewProps) {
  const thumb = useThumbnail(p.client, p.projectId, p.asset);
  const waveform = p.asset?.kind === "audio";
  const missing = p.asset?.status === "missing";
  const picture = p.track.kind === "video" || p.track.kind === "overlay";
  const style: React.CSSProperties = { left: p.left, width: p.width };
  let wave: React.CSSProperties | null = null;
  if (thumb && !missing && waveform && p.asset?.durationFrames) {
    // The waveform image spans the whole source; offset it so the visible slice matches sourceIn.
    wave = {
      backgroundImage: `url(${thumb})`,
      backgroundSize: `${p.asset.durationFrames * p.pxPerFrame}px 100%`,
      backgroundPosition: `${-p.sourceIn * p.pxPerFrame}px center`,
    };
  }
  const name = p.asset?.filename ?? "clip";
  const roomy = p.width > 150;
  return (
    <div
      className={`rf-clip rf-clip-${p.track.kind}${waveform ? " is-wave" : ""}${p.selected ? " is-selected" : ""}${p.dragging ? " is-dragging" : ""}${missing ? " is-missing" : ""}${p.width < 56 ? " is-tiny" : ""}`}
      style={style}
      onPointerDown={p.onPointerDown}
      role="button"
      aria-pressed={p.selected}
      aria-label={`${name}${missing ? " (media offline)" : ""}${p.selected ? ", selected" : ""}`}
      title={`${name} · ${p.range}${missing ? " · media offline" : ""}`}
    >
      {wave && <span className="rf-clip-wave" style={wave} aria-hidden="true" />}
      {picture && thumb && !missing && !waveform && (
        <span className="rf-clip-thumbs" style={{ backgroundImage: `url(${thumb})`, width: roomy ? Math.min(160, p.width * 0.42) : "100%" }} aria-hidden="true" />
      )}
      <span className="rf-clip-text">
        <span className="rf-clip-label">
          {missing && <Icon name="alert" size={12} />}
          {waveform && <Icon name="waveform" size={13} />}
          {p.track.kind === "overlay" && !thumb && <Icon name="layers" size={13} />}
          {name}
        </span>
        {p.width > 110 && <span className="rf-clip-range rf-num-tab">{p.range}</span>}
      </span>
      {!!p.clip.props.transitionIn && <span className="rf-clip-transition" style={{ width: (p.clip.props.transitionIn / 2) * p.pxPerFrame }} title="Dissolve / crossfade in" />}
      {!!p.clip.props.fadeIn && <span className="rf-clip-fade rf-clip-fade-in" style={{ width: p.clip.props.fadeIn * p.pxPerFrame }} />}
      {!!p.clip.props.fadeOut && <span className="rf-clip-fade rf-clip-fade-out" style={{ width: p.clip.props.fadeOut * p.pxPerFrame }} />}
      {p.markers?.beats.map((f) => (
        <span key={`b${f}`} className="rf-marker rf-marker-beat" style={{ left: (f - p.clip.start) * p.pxPerFrame }} aria-hidden="true" />
      ))}
      {p.markers?.cuts.map((f) => (
        <span key={`s${f}`} className="rf-marker rf-marker-cut" style={{ left: (f - p.clip.start) * p.pxPerFrame }} aria-hidden="true" />
      ))}
      <span className="rf-clip-handle rf-clip-handle-start" aria-hidden="true" />
      <span className="rf-clip-handle rf-clip-handle-end" aria-hidden="true" />
    </div>
  );
}
