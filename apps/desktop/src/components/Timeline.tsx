import type { Project } from "@reelforge/core/schema";
import { Icon, type IconName } from "../icons.tsx";

const TOOLS: { label: string; icon: IconName }[] = [
  { label: "Split", icon: "split" },
  { label: "Cut", icon: "cut" },
  { label: "Delete", icon: "trash" },
];

const TRACKS = [
  { id: "V2", kind: "Overlays", tone: "overlay" },
  { id: "V1", kind: "Video", tone: "video" },
  { id: "A1", kind: "Music", tone: "music" },
  { id: "A2", kind: "Voice", tone: "voice" },
  { id: "CC", kind: "Captions", tone: "caption" },
] as const;

const RULER_SECONDS = 30;

export function Timeline({ project }: { project: Project | null }) {
  const ticks = Array.from({ length: RULER_SECONDS / 5 + 1 }, (_, i) => i * 5);
  return (
    <section className="rf-timeline" aria-label="Timeline">
      <div className="rf-timeline-toolbar">
        {TOOLS.map((t) => (
          <button key={t.label} className="rf-tool" disabled title={`${t.label} — arrives with the editing core (M1)`}>
            <Icon name={t.icon} size={16} /> {t.label}
          </button>
        ))}
        <span className="rf-toolbar-spacer" />
        <button className="rf-icon-btn" disabled aria-label="Zoom out">
          <Icon name="zoomOut" size={16} />
        </button>
        <button className="rf-icon-btn" disabled aria-label="Zoom in">
          <Icon name="zoomIn" size={16} />
        </button>
      </div>

      <div className="rf-timeline-grid">
        <div className="rf-track-head rf-ruler-head" />
        <div className="rf-ruler" aria-hidden="true">
          {ticks.map((s) => (
            <span key={s} className="rf-tick" style={{ left: `${(s / RULER_SECONDS) * 100}%` }}>
              00:{String(s).padStart(2, "0")}
            </span>
          ))}
        </div>

        {TRACKS.map((t) => (
          <div key={t.id} className="rf-track-row">
            <div className="rf-track-head">
              <div>
                <div className="rf-track-id">{t.id === "CC" ? "CAPTIONS" : t.id}</div>
                {t.id !== "CC" && <div className="rf-track-kind">{t.kind.toUpperCase()}</div>}
              </div>
              <div className="rf-track-controls">
                <button className="rf-icon-btn" disabled aria-label={`Toggle ${t.kind} visibility`}>
                  <Icon name="eye" size={15} />
                </button>
                <button className="rf-icon-btn" disabled aria-label={`Lock ${t.kind}`}>
                  <Icon name="lock" size={15} />
                </button>
              </div>
            </div>
            <div className={`rf-lane rf-lane-${t.tone}`} />
          </div>
        ))}

        <div className="rf-timeline-hint">
          {project ? "Drop media here once import lands in M1 — clips, trims and splits are stored as frame-exact operations." : ""}
        </div>
      </div>
    </section>
  );
}
