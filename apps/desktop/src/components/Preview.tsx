import { useEffect, useMemo, useRef, useState } from "react";
import type { ClipPropsPatch, Timeline } from "@reelforge/core/schema";
import { aspectRatioLabel } from "@reelforge/core/schema";
import { buildRenderPlan, type RenderPlan } from "@reelforge/core/render-plan";
import { Compositor } from "../compositor.ts";
import { formatClock } from "@reelforge/core/timebase";
import type { Client, FxStatus } from "../api.ts";
import { useThumbnail } from "../editor.ts";
import type { PreviewState } from "../render.ts";
import { Icon, type IconName } from "../icons.tsx";
import { PopupMenu, Segmented, Slider, type MenuItem } from "./ui.tsx";
import { FORMATS } from "./NewProjectDialog.tsx";
import { TransformBox } from "./TransformBox.tsx";

export type PreviewMode = "live" | "rendered";

interface Props {
  client: Client | null;
  timeline: Timeline | null;
  preview: PreviewState;
  mode: PreviewMode;
  onMode: (m: PreviewMode) => void;
  playhead: number;
  onPlayhead: (frame: number) => void;
  playing: boolean;
  onPlaying: (playing: boolean) => void;
  /** A notice over the picture (e.g. an AI plan being previewed). */
  badge?: string | null;
  inspectorOpen: boolean;
  onShowInspector: () => void;
  /** Change the frame size; absent while a format change isn't allowed (e.g. previewing an AI plan). */
  onFormat?: (width: number, height: number) => void;
  /** Reports AI-effect bakes in progress so the agent card can show them. */
  onFxBaking?: (b: FxBaking | null) => void;
  /** The single selected clip: shows move/scale handles over it in the live preview. */
  selectedClipId?: string | null;
  onClipDraft?: (props: ClipPropsPatch | null) => void;
  onClipCommit?: (props: ClipPropsPatch, label: string) => void;
}

const VOLUME_KEY = "rf.monitorVolume";
function readVolume(): { level: number; muted: boolean } {
  try {
    const v = JSON.parse(localStorage.getItem(VOLUME_KEY) ?? "null") as { level?: unknown; muted?: unknown } | null;
    return { level: typeof v?.level === "number" ? Math.max(0, Math.min(1, v.level)) : 1, muted: v?.muted === true };
  } catch {
    return { level: 1, muted: false };
  }
}

export function Preview(props: Props) {
  const { client, timeline, preview, playhead, onPlayhead, playing, onPlaying, mode, onMode, badge } = props;
  const [loop, setLoop] = useState(() => readPref("rf.loop") === "1");
  const [guides, setGuides] = useState(false);
  const [formatMenu, setFormatMenu] = useState<DOMRect | null>(null);
  const [frameEl, setFrameEl] = useState<HTMLDivElement | null>(null);
  const [volume, setVolume] = useState(readVolume);
  const loopRef = useRef(loop);
  loopRef.current = loop;
  useEffect(() => {
    try {
      localStorage.setItem(VOLUME_KEY, JSON.stringify(volume));
      localStorage.setItem("rf.loop", loop ? "1" : "0");
    } catch {
      /* best effort */
    }
  }, [volume, loop]);
  const level = volume.muted ? 0 : volume.level;
  const s = timeline?.project.settings ?? { width: 1080, height: 1920, fps: { num: 30, den: 1 } };
  const fpsNum = s.fps.num / s.fps.den;
  const duration = timeline?.durationFrames ?? 0;
  const video = useRef<HTMLVideoElement>(null);
  const live = mode === "live";
  const stale = !live && preview.url !== null && preview.revision !== timeline?.project.revision;

  // ---- live compositor ----
  const canvas = useRef<HTMLCanvasElement>(null);
  const comp = useRef<Compositor | null>(null);
  const projectId = timeline?.project.id ?? null;
  const plan = useMemo(() => {
    if (!timeline) return { plan: null, error: null };
    try {
      return { plan: timeline.durationFrames ? buildRenderPlan(timeline) : null, error: null };
    } catch (e) {
      return { plan: null, error: e instanceof Error ? e.message : String(e) };
    }
  }, [timeline]);
  const size = useMemo(() => {
    const k = Math.min(1, 960 / Math.max(s.width, s.height));
    return { width: Math.round((s.width * k) / 2) * 2, height: Math.round((s.height * k) / 2) * 2 };
  }, [s.width, s.height]);

  useEffect(() => {
    if (!live || !canvas.current || !client || !projectId) return;
    const c = new Compositor(canvas.current, {
      mediaUrl: (assetId) => client.mediaUrl(projectId, assetId),
      fxUrl: (key) => client.fxUrl(projectId, key),
      fontUrl: (file) => client.fontUrl(file),
    });
    comp.current = c;
    c.setVolume(level);
    return () => {
      c.dispose();
      comp.current = null;
    };
  }, [live, client, projectId]);

  useEffect(() => {
    comp.current?.setVolume(level);
    if (video.current) video.current.volume = level;
  }, [level, live, preview.url]);

  useEffect(() => {
    comp.current?.setPlan(plan.plan, size);
  }, [plan, size, live, client, projectId]);

  const fx = useFxBakes(client, projectId, plan.plan);
  const onFxBaking = props.onFxBaking;
  const bakingKey = fx.baking ? `${fx.baking.done}/${fx.baking.total}/${fx.baking.progress}` : "";
  useEffect(() => {
    onFxBaking?.(fx.baking);
  }, [bakingKey, onFxBaking]);
  useEffect(() => () => onFxBaking?.(null), [onFxBaking]);
  useEffect(() => {
    comp.current?.setFxReady(fx.ready);
  }, [fx.ready, live, plan]);

  useEffect(() => {
    const c = comp.current;
    if (!c || !live) return;
    c.onFrame = (f) => onPlayhead(f);
    // Loop: start over from the top instead of stopping (same clock, so picture and sound stay together).
    c.onEnded = () => (loopRef.current ? void c.play(0) : onPlaying(false));
    if (playing) void c.play(playhead);
    else c.pause();
  }, [playing, live]);

  useEffect(() => {
    if (live && !playing) comp.current?.seek(playhead);
  }, [playhead, playing, live, plan]);

  // Poster fallback until the first preview is ready: topmost visible picture clip under the playhead.
  const top = useMemo(() => {
    if (!timeline) return null;
    for (const t of timeline.tracks) {
      if (t.hidden || (t.kind !== "video" && t.kind !== "overlay")) continue;
      const c = timeline.clips.find((c) => c.trackId === t.id && c.start <= playhead && playhead < c.start + c.duration);
      if (c) return timeline.assets.find((a) => a.id === c.assetId) ?? null;
    }
    return null;
  }, [timeline, playhead]);
  const poster = useThumbnail(client, timeline?.project.id ?? "", live || preview.url ? undefined : (top ?? undefined));

  // Play / pause, and drive the playhead from the video clock while playing.
  useEffect(() => {
    const v = video.current;
    if (live || !v || !preview.url) return;
    if (!playing) {
      v.pause();
      return;
    }
    if (playhead >= duration) onPlayhead(0);
    v.currentTime = (playhead >= duration ? 0 : playhead) / fpsNum;
    void v.play().catch(() => onPlaying(false));
    let raf = 0;
    const tick = () => {
      onPlayhead(Math.min(duration, Math.floor(v.currentTime * fpsNum + 1e-3)));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    const ended = () => {
      if (!loopRef.current) return onPlaying(false);
      v.currentTime = 0;
      void v.play().catch(() => onPlaying(false));
    };
    v.addEventListener("ended", ended);
    return () => {
      cancelAnimationFrame(raf);
      v.removeEventListener("ended", ended);
    };
  }, [playing, preview.url, live]);

  // Scrubbing while paused: show the exact frame (seek to the middle of it).
  useEffect(() => {
    const v = video.current;
    if (live || !v || playing || !preview.url) return;
    const target = (Math.min(playhead, Math.max(0, duration - 1)) + 0.5) / fpsNum;
    if (Math.abs(v.currentTime - target) > 0.25 / fpsNum) v.currentTime = target;
  }, [playhead, playing, preview.url, duration, fpsNum]);

  const jump = (f: number) => {
    onPlaying(false);
    onPlayhead(Math.max(0, Math.min(duration, f)));
  };
  // Edit points: every clip's in and out, plus the ends of the timeline. Prev/next step between them.
  const editPoints = useMemo(() => {
    const set = new Set<number>([0, duration]);
    for (const c of timeline?.clips ?? []) {
      set.add(c.start);
      set.add(c.start + c.duration);
    }
    return [...set].filter((f) => f >= 0 && f <= duration).sort((a, b) => a - b);
  }, [timeline?.clips, duration]);
  const prevPoint = [...editPoints].reverse().find((f) => f < playhead) ?? 0;
  const nextPoint = editPoints.find((f) => f > playhead) ?? duration;

  const status = live
    ? plan.error
    : preview.pending
    ? `${preview.url ? "Updating" : "Rendering"} preview · ${Math.round(preview.pending.progress * 100)}%`
    : preview.error
      ? "Preview failed"
      : stale
        ? "Updating preview…"
        : null;

  const canPlay = live ? !!plan.plan : !!preview.url;
  const shape: IconName = s.width < s.height ? "phone" : s.width === s.height ? "square" : "monitor";
  const fpsLabel = s.fps.den === 1 ? `${s.fps.num}` : (s.fps.num / s.fps.den).toFixed(2);

  return (
    <section className="rf-panel rf-preview" aria-label="Preview">
      <div className="rf-preview-bar">
        <button
          type="button"
          className="rf-chip-info"
          title={`${s.width} × ${s.height} · ${fpsLabel} fps${props.onFormat ? " · change format" : ""}`}
          aria-haspopup="menu"
          aria-expanded={!!formatMenu}
          disabled={!props.onFormat || !timeline}
          onClick={(e) => setFormatMenu(formatMenu ? null : e.currentTarget.getBoundingClientRect())}
        >
          <Icon name={shape} size={15} />
          <span className="rf-num-tab">{aspectRatioLabel(s)}</span>
          <span className="rf-chip-meta rf-num-tab">
            {s.width}×{s.height} · {fpsLabel} fps
          </span>
          {props.onFormat && <Icon name="chevronDown" size={13} />}
        </button>
        {formatMenu && props.onFormat && (
          <PopupMenu
            anchor={formatMenu}
            label="Project format"
            onClose={() => setFormatMenu(null)}
            items={FORMATS.map<MenuItem>((f) => ({
              label: f.label,
              icon: f.width === s.width && f.height === s.height ? "check" : undefined,
              onSelect: () => props.onFormat!(f.width, f.height),
            }))}
          />
        )}
        <Segmented
          label="Preview mode"
          role="tabs"
          size="sm"
          value={mode}
          onChange={onMode}
          options={[
            { value: "live", label: "Live", title: "Live: composited instantly from proxies, follows every edit while you work" },
            { value: "rendered", label: "Rendered", title: "Rendered: the exact FFmpeg output (same graph as the export, at preview size)" },
          ]}
        />
        <span className="rf-grow" />
        <button className="rf-icon-btn" aria-pressed={guides} aria-label="Safe-area guides" data-tip="Safe-area guides" onClick={() => setGuides((g) => !g)}>
          <Icon name="guides" size={17} />
        </button>
        <button
          className="rf-icon-btn"
          aria-label="Fullscreen"
          data-tip="Fullscreen"
          disabled={!canPlay}
          onClick={() => void (live ? canvas.current : video.current)?.requestFullscreen?.()}
        >
          <Icon name="maximize" size={17} />
        </button>
        {!props.inspectorOpen && (
          <button className="rf-icon-btn" aria-label="Show inspector" data-tip="Show inspector" onClick={props.onShowInspector}>
            <Icon name="panelRight" size={17} />
          </button>
        )}
      </div>
      <div className="rf-monitor">
        <div ref={setFrameEl} className="rf-frame" style={{ "--rf-aspect": s.width / s.height } as React.CSSProperties}>
          {live ? (
            <canvas ref={canvas} className="rf-frame-poster" aria-label="Live preview" />
          ) : preview.url ? (
            <video
              ref={video}
              className="rf-frame-poster"
              src={preview.url}
              playsInline
              preload="auto"
              onLoadedMetadata={(e) => {
                e.currentTarget.currentTime = (playhead + 0.5) / fpsNum;
                e.currentTarget.volume = level;
              }}
            />
          ) : poster ? (
            <img className="rf-frame-poster" src={poster} alt="" />
          ) : null}
          {live && !playing && plan.plan && timeline && props.selectedClipId && props.onClipDraft && props.onClipCommit && (
            <TransformBox
              timeline={timeline}
              plan={plan.plan}
              frame={playhead}
              clipId={props.selectedClipId}
              frameEl={frameEl}
              onDraft={props.onClipDraft}
              onCommit={props.onClipCommit}
            />
          )}
          {guides && (
            <div className="rf-safe-area" aria-hidden="true">
              <span>Safe area</span>
            </div>
          )}
          {badge && (
            <span className="rf-frame-badge" role="status">
              {badge}
            </span>
          )}
          {live && fx.note && (
            <span className={`rf-frame-badge rf-frame-badge-fx${fx.failed ? " is-failed" : ""}`} role="status" title={fx.detail ?? undefined}>
              {fx.note}
            </span>
          )}
          {!live && !preview.url && !top && (
            <div className="rf-frame-empty">
              <Icon name="play" size={26} />
              <span>{timeline?.clips.length ? "No picture at the playhead" : "Timeline is empty"}</span>
            </div>
          )}
          {live && !plan.plan && !plan.error && (
            <div className="rf-frame-empty">
              <Icon name="play" size={26} />
              <span>Timeline is empty</span>
            </div>
          )}
          {status && (
            <span className={`rf-frame-note${(live && plan.error) || (preview.error && !preview.pending) ? " is-error" : ""}`} title={preview.error ?? undefined} role="status">
              {preview.pending && <span className="rf-spinner" aria-hidden="true" />} {status}
            </span>
          )}
        </div>
      </div>
      <div
        className="rf-scrubber"
        role="slider"
        aria-label="Playhead"
        aria-valuemin={0}
        aria-valuemax={duration}
        aria-valuenow={playhead}
        aria-valuetext={formatClock(playhead, s.fps)}
        tabIndex={0}
        onPointerDown={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          jump(Math.round(((e.clientX - r.left) / r.width) * duration));
        }}
      >
        <div className="rf-scrubber-fill" style={{ width: duration ? `${Math.min(100, (playhead / duration) * 100)}%` : 0 }} />
      </div>
      <div className="rf-transport">
        <span className="rf-timecode">
          <strong>{formatClock(playhead, s.fps)}</strong>
          <span className="rf-timecode-sep">/</span>
          {formatClock(duration, s.fps)}
        </span>
        <div className="rf-transport-buttons">
          <button className="rf-icon-btn" aria-label="Previous edit point" data-tip="Previous edit point  (Home: start)" disabled={playhead <= 0} onClick={() => jump(prevPoint)}>
            <Icon name="skipBack" size={17} />
          </button>
          <button
            className="rf-play"
            disabled={!canPlay}
            aria-label={playing ? "Pause" : "Play"}
            data-tip={canPlay ? `${playing ? "Pause" : "Play"}  Space` : "Waiting for the preview render"}
            onClick={() => onPlaying(!playing)}
          >
            <Icon name={playing ? "pause" : "play"} size={18} />
          </button>
          <button className="rf-icon-btn" aria-label="Next edit point" data-tip="Next edit point  (End: end)" disabled={playhead >= duration} onClick={() => jump(nextPoint)}>
            <Icon name="skipForward" size={17} />
          </button>
          <button className="rf-icon-btn" aria-pressed={loop} aria-label="Loop playback" data-tip={loop ? "Loop on" : "Loop off"} onClick={() => setLoop((l) => !l)}>
            <Icon name="loop" size={17} />
          </button>
        </div>
        <div className="rf-transport-right">
          <button
            className="rf-icon-btn"
            aria-pressed={volume.muted}
            aria-label={volume.muted ? "Unmute preview" : "Mute preview"}
            data-tip={volume.muted ? "Unmute" : "Mute"}
            onClick={() => setVolume((v) => ({ ...v, muted: !v.muted }))}
          >
            <Icon name={level === 0 ? "volumeOff" : "volume"} size={17} />
          </button>
          <div className="rf-volume">
            <Slider
              label="Preview volume"
              min={0}
              max={100}
              step={1}
              value={Math.round(level * 100)}
              onChange={(v) => setVolume({ level: v / 100, muted: false })}
              onCommit={() => {}}
            />
          </div>
        </div>
      </div>
    </section>
  );
}

function readPref(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/**
 * AI effects in the plan are baked by the engine; ask for the missing ones and poll until they are
 * ready. Until then the preview shows the clip without them (the export waits for the bake itself).
 */
export interface FxBaking {
  done: number;
  total: number;
  progress: number | null;
}

function useFxBakes(client: Client | null, projectId: string | null, plan: RenderPlan | null) {
  const keys = useMemo(() => (plan?.fxBakes ?? []).map((b) => b.key).sort().join(","), [plan]);
  const [status, setStatus] = useState<FxStatus | null>(null);
  useEffect(() => {
    setStatus(null);
    if (!client || !projectId || !keys) return;
    let stop = false;
    let timer = 0;
    const poll = async (first: boolean) => {
      try {
        const st = first ? await client.bakeFx(projectId) : await client.fxStatus(projectId);
        if (stop) return;
        setStatus(st);
        if (st.engine.ok && st.bakes.some((b) => b.state === "queued" || b.state === "running" || b.state === "missing")) timer = window.setTimeout(() => void poll(false), 1500);
      } catch {
        if (!stop) timer = window.setTimeout(() => void poll(false), 4000);
      }
    };
    void poll(true);
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [client, projectId, keys]);
  return useMemo(() => {
    const wanted = new Set(keys ? keys.split(",") : []);
    const bakes = (status?.bakes ?? []).filter((b) => wanted.has(b.key));
    const ready = new Set(bakes.filter((b) => b.state === "done").map((b) => b.key));
    const idle = { ready, note: null, detail: null, failed: false, baking: null };
    if (!wanted.size || !status) return idle;
    if (!status.engine.ok) return { ...idle, note: "AI effects unavailable", detail: status.engine.reason, failed: true };
    const failed = bakes.find((b) => b.state === "failed");
    if (failed && failed.state === "failed") return { ...idle, note: "AI effect failed to bake", detail: failed.error, failed: true };
    const left = bakes.filter((b) => b.state !== "done");
    if (!left.length) {
      // Baked, but the engine had to guess where the face is (e.g. no face in the shot): say so, don't hide it.
      const warned = bakes.find((b) => b.state === "done" && b.warning);
      return warned && warned.state === "done" && warned.warning ? { ...idle, note: "AI effect placed without a face", detail: warned.warning } : idle;
    }
    const running = left.find((b) => b.state === "running");
    const pct = running && running.state === "running" ? ` ${Math.round(running.progress * 100)}%` : "";
    const done = bakes.length - left.length;
    // Overall fraction: finished bakes plus the running one's share; null until the engine reports any.
    const progress = running && running.state === "running" ? (done + running.progress) / bakes.length : done > 0 ? done / bakes.length : null;
    return { ...idle, note: `Baking AI effects${pct} · ${done}/${bakes.length}`, baking: { done, total: bakes.length, progress } as FxBaking };
  }, [status, keys]);
}
