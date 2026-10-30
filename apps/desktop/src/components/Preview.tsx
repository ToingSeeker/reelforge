import type { Project } from "@reelforge/core/schema";
import { aspectRatioLabel } from "@reelforge/core/schema";
import { formatClock } from "@reelforge/core/timebase";
import { Icon } from "../icons.tsx";

export function Preview({ project }: { project: Project | null }) {
  const s = project?.settings ?? { width: 1080, height: 1920, fps: { num: 30, den: 1 } };
  return (
    <section className="rf-panel rf-preview" aria-label="Preview">
      <div className="rf-panel-head">
        <h2>Preview</h2>
        <span className="rf-pill">{aspectRatioLabel(s)}</span>
        <span className="rf-pill">Full Quality</span>
      </div>
      <div className="rf-monitor">
        <div className="rf-frame" style={{ aspectRatio: `${s.width} / ${s.height}` }}>
          <div className="rf-safe-area" aria-hidden="true" />
          <div className="rf-frame-empty">
            <Icon name="play" size={28} />
            <span>Timeline is empty</span>
          </div>
        </div>
      </div>
      <div className="rf-scrubber" aria-hidden="true">
        <div className="rf-scrubber-fill" />
      </div>
      <div className="rf-transport">
        <span className="rf-timecode">
          <strong>{formatClock(0, s.fps)}</strong> / {formatClock(0, s.fps)}
        </span>
        <div className="rf-transport-buttons">
          {(["skipBack", "stepBack", "play", "skipForward"] as const).map((n) => (
            <button key={n} className="rf-icon-btn" disabled aria-label={n} title="Playback — arrives with preview (M2)">
              <Icon name={n} size={n === "play" ? 20 : 17} />
            </button>
          ))}
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
