import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent } from "react";
import type { Asset, Caption, Clip, Timeline as TimelineData, TimelineOp, Track } from "@reelforge/core/schema";
import { canPlace } from "@reelforge/core/timeline-ops";
import { trackLabels } from "@reelforge/core/schema";
import { formatClock, type Rational } from "@reelforge/core/timebase";
import type { Client } from "../api.ts";
import { useThumbnail } from "../editor.ts";
import { Icon, type IconName } from "../icons.tsx";

const HEADER_W = 150;
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
  const ticks: number[] = [];
  for (let s = 0; s * fpsNum <= contentFrames; s += step) ticks.push(s);
  const hasSelection = p.selection.size > 0;

  const tools: { label: string; icon: IconName; onClick: () => void; disabled: boolean; title: string }[] = [
    { label: "Split", icon: "split", onClick: p.onSplit, disabled: !tl, title: "Split at playhead (S)" },
    { label: "Delete", icon: "trash", onClick: () => p.onDelete(false), disabled: !hasSelection, title: "Delete selected (⌫)" },
    { label: "Ripple", icon: "ripple", onClick: () => p.onDelete(true), disabled: !hasSelection, title: "Ripple delete: close the gap (⇧⌫)" },
  ];

  return (
    <section className="rf-timeline" aria-label="Timeline">
      <div className="rf-timeline-toolbar">
        {tools.map((t) => (
          <button key={t.label} className="rf-tool" onClick={t.onClick} disabled={t.disabled} title={t.title}>
            <Icon name={t.icon} size={16} /> {t.label}
          </button>
        ))}
        <span className="rf-toolbar-divider" />
        <button className="rf-tool" aria-pressed={snap} onClick={() => setSnap((s) => !s)} title="Snap to clip edges and playhead">
          <Icon name="magnet" size={16} /> Snap
        </button>
        <span className="rf-toolbar-spacer" />
        <span className="rf-timecode rf-toolbar-tc">
          <strong>{formatClock(p.playhead, fps)}</strong> / {formatClock(tl?.durationFrames ?? 0, fps)}
        </span>
        <button className="rf-icon-btn" onClick={() => zoomBy(1 / 1.4)} aria-label="Zoom out" title="Zoom out (⌘ + scroll)">
          <Icon name="zoomOut" size={16} />
        </button>
        <input
          className="rf-zoom"
          type="range"
          min={Math.log(MIN_PX_PER_FRAME)}
          max={Math.log(MAX_PX_PER_FRAME)}
          step={0.01}
          value={Math.log(px)}
          onChange={(e) => setPx(Math.exp(Number(e.target.value)))}
          aria-label="Timeline zoom"
        />
        <button className="rf-icon-btn" onClick={() => zoomBy(1.4)} aria-label="Zoom in">
          <Icon name="zoomIn" size={16} />
        </button>
        <button className="rf-tool" onClick={() => setPx(fitPx())} title="Fit the whole timeline">
          Fit
        </button>
      </div>

      <div className="rf-timeline-scroll" ref={scroller} onWheel={onWheel}>
        <div className="rf-timeline-content" style={{ width: HEADER_W + contentW }}>
          <div className="rf-ruler-row">
            <div className="rf-track-head rf-ruler-head" />
            <div
              className="rf-ruler"
              style={{ width: contentW }}
              onPointerDown={(e) => {
                p.onPlayhead(frameAtClientX(e.clientX));
                setDrag({ kind: "playhead" });
              }}
            >
              {ticks.map((s) => (
                <span key={s} className="rf-tick" style={{ left: s * fpsNum * px }}>
                  {formatClock(Math.round(s * fpsNum), fps).replace(/\.00$/, "")}
                </span>
              ))}
            </div>
          </div>

          {(tl?.tracks ?? []).map((track) => (
            <div key={track.id} className="rf-track-row" data-kind={track.kind}>
              <TrackHeader track={track} label={labels.get(track.id) ?? ""} onToggle={(patch, label) => p.onApply(label, [{ type: "track.update", trackId: track.id, ...patch }])} />
              <div
                className={`rf-lane rf-lane-${track.kind}${track.locked ? " is-locked" : ""}${track.hidden || track.muted ? " is-dimmed" : ""}`}
                data-track-id={track.id}
                style={{ width: contentW }}
                onPointerDown={(e) => {
                  if (e.target !== e.currentTarget) return;
                  p.onSelect(new Set());
                  p.onPlayhead(frameAtClientX(e.clientX));
                }}
              >
                {track.kind === "caption" &&
                  tl!.captions
                    .filter((c) => c.trackId === track.id)
                    .map((c) => {
                      const start = c.start + (drag?.kind === "caption" && drag.caption.id === c.id ? drag.delta : 0);
                      return (
                        <div
                          key={c.id}
                          className={`rf-caption-block${p.selectedCaption === c.id ? " is-selected" : ""}`}
                          style={{ left: start * px, width: Math.max(2, c.duration * px) }}
                          title={c.text}
                          role="button"
                          aria-pressed={p.selectedCaption === c.id}
                          aria-label={`Caption: ${c.text}`}
                          onPointerDown={(e) => {
                            if (e.button !== 0) return;
                            e.stopPropagation();
                            p.onSelect(new Set());
                            p.onSelectCaption(c.id);
                            if (!track.locked) setDrag({ kind: "caption", caption: c, originX: e.clientX, delta: 0, moved: false });
                          }}
                        >
                          <span className="rf-clip-label">{c.text}</span>
                        </div>
                      );
                    })}
                {tl!.clips
                  .filter((c) => (drag?.kind === "move" && drag.clip.id === c.id ? drag.trackId : c.trackId) === track.id)
                  .map((c) => {
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
                        asset={assets.get(c.assetId)}
                        left={start * px}
                        width={Math.max(2, duration * px)}
                        sourceIn={sourceIn}
                        pxPerFrame={px}
                        selected={p.selection.has(c.id)}
                        markers={p.markers.get(c.id)}
                        clipStart={start}
                        dragging={drag !== null && (drag.kind === "move" || drag.kind === "trim-start" || drag.kind === "trim-end") && drag.clip.id === c.id && drag.moved}
                        onPointerDown={(e) => startClipDrag(e, c, track)}
                      />
                    );
                  })}
                {dropHover?.trackId === track.id && (
                  <div className={`rf-drop-marker${dropHover.ok ? "" : " is-invalid"}`} style={{ left: dropHover.frame * px }} />
                )}
              </div>
            </div>
          ))}

          <div className="rf-playhead" style={{ left: HEADER_W + p.playhead * px }} aria-hidden="true">
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

function TrackHeader({ track, label, onToggle }: { track: Track; label: string; onToggle: (patch: Partial<Track>, label: string) => void }) {
  const audio = track.kind === "audio";
  return (
    <div className="rf-track-head">
      <div className="rf-track-title">
        <div className="rf-track-id">{track.kind === "caption" ? "CAPTIONS" : label}</div>
        {track.kind !== "caption" && <div className="rf-track-kind">{track.name.toUpperCase()}</div>}
      </div>
      <div className="rf-track-controls">
        {audio ? (
          <button
            className="rf-icon-btn"
            aria-pressed={track.muted}
            onClick={() => onToggle({ muted: !track.muted }, track.muted ? "Unmute track" : "Mute track")}
            aria-label={`${track.muted ? "Unmute" : "Mute"} ${label}`}
            title={track.muted ? "Unmute" : "Mute"}
          >
            <Icon name={track.muted ? "volumeOff" : "volume"} size={15} />
          </button>
        ) : (
          <button
            className="rf-icon-btn"
            aria-pressed={track.hidden}
            onClick={() => onToggle({ hidden: !track.hidden }, track.hidden ? "Show track" : "Hide track")}
            aria-label={`${track.hidden ? "Show" : "Hide"} ${label || track.name}`}
            title={track.hidden ? "Show" : "Hide"}
          >
            <Icon name={track.hidden ? "eyeOff" : "eye"} size={15} />
          </button>
        )}
        <button
          className="rf-icon-btn"
          aria-pressed={track.locked}
          onClick={() => onToggle({ locked: !track.locked }, track.locked ? "Unlock track" : "Lock track")}
          aria-label={`${track.locked ? "Unlock" : "Lock"} ${label || track.name}`}
          title={track.locked ? "Unlock" : "Lock"}
        >
          <Icon name={track.locked ? "lock" : "unlock"} size={15} />
        </button>
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
  /** Where the clip is drawn (may differ from clip.start while dragging). */
  clipStart: number;
}

function ClipView(p: ClipViewProps) {
  const thumb = useThumbnail(p.client, p.projectId, p.asset);
  const waveform = p.asset?.kind === "audio";
  const missing = p.asset?.status === "missing";
  const style: React.CSSProperties = { left: p.left, width: p.width };
  if (thumb && !missing) {
    if (waveform && p.asset?.durationFrames) {
      // The waveform image spans the whole source; offset it so the visible slice matches sourceIn.
      Object.assign(style, {
        backgroundImage: `url(${thumb})`,
        backgroundSize: `${p.asset.durationFrames * p.pxPerFrame}px 100%`,
        backgroundPosition: `${-p.sourceIn * p.pxPerFrame}px center`,
      });
    } else if (!waveform && p.track.kind !== "audio") {
      Object.assign(style, { backgroundImage: `url(${thumb})` });
    }
  }
  return (
    <div
      className={`rf-clip rf-clip-${p.track.kind}${waveform ? " is-wave" : ""}${p.selected ? " is-selected" : ""}${p.dragging ? " is-dragging" : ""}${missing ? " is-missing" : ""}`}
      style={style}
      onPointerDown={p.onPointerDown}
      role="button"
      aria-pressed={p.selected}
      aria-label={`${p.asset?.filename ?? "clip"}${missing ? " (media offline)" : ""}`}
      title={`${p.asset?.filename ?? ""}${missing ? " — media offline" : ""}`}
    >
      <span className="rf-clip-label">
        {missing && <Icon name="alert" size={12} />} {p.asset?.filename.replace(/\.[^.]+$/, "") ?? "clip"}
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
      <span className="rf-clip-handle rf-clip-handle-start" />
      <span className="rf-clip-handle rf-clip-handle-end" />
    </div>
  );
}
