import { useEffect, useMemo, useRef } from "react";
import type { Timeline } from "@reelforge/core/schema";
import { aspectRatioLabel } from "@reelforge/core/schema";
import { buildRenderPlan } from "@reelforge/core/render-plan";
import { Compositor } from "../compositor.ts";
import { formatClock } from "@reelforge/core/timebase";
import type { Client } from "../api.ts";
import { useThumbnail } from "../editor.ts";
import type { PreviewState } from "../render.ts";
import { Icon } from "../icons.tsx";

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
}

export function Preview(props: Props) {
  const { client, timeline, preview, playhead, onPlayhead, playing, onPlaying, mode, onMode } = props;
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
    const c = new Compositor(canvas.current, { mediaUrl: (assetId) => client.mediaUrl(projectId, assetId) });
    comp.current = c;
    return () => {
      c.dispose();
      comp.current = null;
    };
  }, [live, client, projectId]);

  useEffect(() => {
    comp.current?.setPlan(plan.plan, size);
  }, [plan, size, live, client, projectId]);

  useEffect(() => {
    const c = comp.current;
    if (!c || !live) return;
    c.onFrame = (f) => onPlayhead(f);
    c.onEnded = () => onPlaying(false);
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
    const ended = () => onPlaying(false);
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

  const status = live
    ? plan.error
    : preview.pending
    ? `${preview.url ? "Updating" : "Rendering"} preview · ${Math.round(preview.pending.progress * 100)}%`
    : preview.error
      ? "Preview failed"
      : stale
        ? "Updating preview…"
        : null;

  return (
    <section className="rf-panel rf-preview" aria-label="Preview">
      <div className="rf-panel-head">
        <h2>Preview</h2>
        <span className="rf-pill">{aspectRatioLabel(s)}</span>
        <div className="rf-mode" role="tablist" aria-label="Preview mode">
          <button
            role="tab"
            aria-selected={live}
            onClick={() => onMode("live")}
            title="Live: composited instantly from proxies, follows every edit while you work"
          >
            Live
          </button>
          <button
            role="tab"
            aria-selected={!live}
            onClick={() => onMode("rendered")}
            title="Rendered: the exact FFmpeg output (same graph as the export, at preview size)"
          >
            Rendered
          </button>
        </div>
      </div>
      <div className="rf-monitor">
        <div className="rf-frame" style={{ aspectRatio: `${s.width} / ${s.height}` }}>
          {live ? (
            <canvas ref={canvas} className="rf-frame-poster" aria-label="Live preview" />
          ) : preview.url ? (
            <video
              ref={video}
              className="rf-frame-poster"
              src={preview.url}
              playsInline
              preload="auto"
              onLoadedMetadata={(e) => (e.currentTarget.currentTime = (playhead + 0.5) / fpsNum)}
            />
          ) : poster ? (
            <img className="rf-frame-poster" src={poster} alt="" />
          ) : null}
          <div className="rf-safe-area" aria-hidden="true" />
          {!live && !preview.url && !top && (
            <div className="rf-frame-empty">
              <Icon name="play" size={28} />
              <span>{timeline?.clips.length ? "No picture at the playhead" : "Timeline is empty"}</span>
            </div>
          )}
          {live && !plan.plan && !plan.error && (
            <div className="rf-frame-empty">
              <Icon name="play" size={28} />
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
          <strong>{formatClock(playhead, s.fps)}</strong> / {formatClock(duration, s.fps)}
        </span>
        <div className="rf-transport-buttons">
          <button className="rf-icon-btn" aria-label="Go to start" title="Go to start (Home)" onClick={() => jump(0)}>
            <Icon name="skipBack" size={17} />
          </button>
          <button className="rf-icon-btn" aria-label="Back one second" title="Back 1 second (⇧←)" onClick={() => jump(playhead - Math.round(fpsNum))}>
            <Icon name="stepBack" size={17} />
          </button>
          <button
            className="rf-icon-btn rf-play"
            disabled={live ? !plan.plan : !preview.url}
            aria-label={playing ? "Pause" : "Play"}
            title={live || preview.url ? `${playing ? "Pause" : "Play"} (Space)` : "Waiting for the preview render"}
            onClick={() => onPlaying(!playing)}
          >
            <Icon name={playing ? "pause" : "play"} size={20} />
          </button>
          <button className="rf-icon-btn" aria-label="Go to end" title="Go to end (End)" onClick={() => jump(duration)}>
            <Icon name="skipForward" size={17} />
          </button>
        </div>
        <div className="rf-transport-right">
          <button
            className="rf-icon-btn"
            aria-label="Fullscreen"
            disabled={live ? !plan.plan : !preview.url}
            onClick={() => void (live ? canvas.current : video.current)?.requestFullscreen?.()}
          >
            <Icon name="maximize" size={17} />
          </button>
        </div>
      </div>
    </section>
  );
}
