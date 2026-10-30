import { useMemo } from "react";
import type { Timeline } from "@reelforge/core/schema";
import { aspectRatioLabel } from "@reelforge/core/schema";
import { formatClock } from "@reelforge/core/timebase";
import type { Client } from "../api.ts";
import { useThumbnail } from "../editor.ts";
import { Icon } from "../icons.tsx";

interface Props {
  client: Client | null;
  timeline: Timeline | null;
  playhead: number;
  onPlayhead: (frame: number) => void;
}

export function Preview({ client, timeline, playhead, onPlayhead }: Props) {
  const s = timeline?.project.settings ?? { width: 1080, height: 1920, fps: { num: 30, den: 1 } };
  const duration = timeline?.durationFrames ?? 0;

  // Topmost visible picture clip under the playhead (tracks are ordered top → bottom).
  const top = useMemo(() => {
    if (!timeline) return null;
    for (const t of timeline.tracks) {
      if (t.hidden || (t.kind !== "video" && t.kind !== "overlay")) continue;
      const c = timeline.clips.find((c) => c.trackId === t.id && c.start <= playhead && playhead < c.start + c.duration);
      if (c) return timeline.assets.find((a) => a.id === c.assetId) ?? null;
    }
    return null;
  }, [timeline, playhead]);
  const poster = useThumbnail(client, timeline?.project.id ?? "", top ?? undefined);

  const jump = (f: number) => onPlayhead(Math.max(0, Math.min(duration, f)));
  const fpsNum = s.fps.num / s.fps.den;

  return (
    <section className="rf-panel rf-preview" aria-label="Preview">
      <div className="rf-panel-head">
        <h2>Preview</h2>
        <span className="rf-pill">{aspectRatioLabel(s)}</span>
        <span className="rf-pill">Full Quality</span>
      </div>
      <div className="rf-monitor">
        <div className="rf-frame" style={{ aspectRatio: `${s.width} / ${s.height}` }}>
          {poster ? <img className="rf-frame-poster" src={poster} alt="" /> : null}
          <div className="rf-safe-area" aria-hidden="true" />
          {!top && (
            <div className="rf-frame-empty">
              <Icon name="play" size={28} />
              <span>{timeline?.clips.length ? "No picture at the playhead" : "Timeline is empty"}</span>
            </div>
          )}
          {top && <span className="rf-frame-note">Poster frame · live playback in M2</span>}
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
          <button className="rf-icon-btn" disabled aria-label="Play" title="Playback arrives with the preview engine (M2)">
            <Icon name="play" size={20} />
          </button>
          <button className="rf-icon-btn" aria-label="Go to end" title="Go to end (End)" onClick={() => jump(duration)}>
            <Icon name="skipForward" size={17} />
          </button>
        </div>
        <div className="rf-transport-right">
          <button className="rf-icon-btn" disabled aria-label="Volume">
            <Icon name="volume" size={17} />
          </button>
          <button className="rf-icon-btn" disabled aria-label="Fullscreen">
            <Icon name="maximize" size={17} />
          </button>
        </div>
      </div>
    </section>
  );
}
