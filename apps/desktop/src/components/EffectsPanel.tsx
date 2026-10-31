import { useEffect, useState } from "react";
import type { Clip, ClipProps, ClipPropsPatch, Timeline } from "@reelforge/core/schema";
import { resolveClipProps } from "@reelforge/core/schema";
import { MOTION_PRESETS, motionPatch, motionPresetOf, PICTURE_EFFECTS, type PictureEffect } from "@reelforge/core/effects";

interface Props {
  timeline: Timeline;
  clip: Clip | null;
  /** Live, uncommitted values while a slider is dragged (drives the live preview). */
  onDraft: (patch: ClipPropsPatch | null) => void;
  /** One undo step per finished change. */
  onCommit: (patch: ClipPropsPatch, label: string) => void;
}

/** Motion presets and picture effects for the selected video or image clip. */
export function EffectsPanel({ timeline, clip, onDraft, onCommit }: Props) {
  const track = clip ? timeline.tracks.find((t) => t.id === clip.trackId) : undefined;
  const visual = !!track && (track.kind === "video" || track.kind === "overlay");
  const committed = resolveClipProps(clip?.props);
  const [draft, setDraft] = useState<ClipPropsPatch>({});
  useEffect(() => {
    setDraft({});
  }, [clip?.id, clip?.props]);
  const value: ClipProps = { ...committed, ...draft };

  if (!clip || !visual) {
    return (
      <section className="rf-panel rf-library" aria-label="Effects">
        <div className="rf-panel-head">
          <h2>Effects</h2>
        </div>
        <div className="rf-empty">
          <p className="rf-empty-title">{clip ? "Effects are for pictures" : "No clip selected"}</p>
          <p className="rf-empty-body">Select one video or image clip on V1 or V2 to add a camera move or a look.</p>
        </div>
      </section>
    );
  }

  const locked = !!track?.locked;
  const motion = motionPresetOf(value);
  const commit = (patch: ClipPropsPatch, label: string) => {
    onDraft(null);
    setDraft({});
    onCommit(patch, label);
  };
  const drag = (key: PictureEffect, v: number) => {
    const next = { ...draft, [key]: v };
    setDraft(next);
    onDraft(next);
  };
  const release = (key: PictureEffect, label: string) => {
    if (draft[key] === undefined || draft[key] === committed[key]) return;
    commit({ [key]: draft[key] }, label);
  };
  const anyOn = PICTURE_EFFECTS.some((e) => value[e.key] > 0) || motion !== "none";

  return (
    <section className="rf-panel rf-library" aria-label="Effects">
      <div className="rf-panel-head">
        <h2>Effects</h2>
        <button
          className="rf-btn rf-btn-ghost"
          disabled={!anyOn || locked}
          onClick={() => commit({ ...motionPatch("none"), ...Object.fromEntries(PICTURE_EFFECTS.map((e) => [e.key, 0])) }, "Remove effects")}
        >
          Clear
        </button>
      </div>
      <div className="rf-captions-scroll">
        {locked && <p className="rf-hint rf-pad">This track is locked. Unlock it to change effects.</p>}
        <section className="rf-cap-group">
          <h3>Motion</h3>
          <div className="rf-fx-grid" role="radiogroup" aria-label="Motion">
            {MOTION_PRESETS.map((m) => (
              <button
                key={m.key}
                role="radio"
                aria-checked={motion === m.key}
                className="rf-fx-card"
                disabled={locked}
                onClick={() => motion !== m.key && commit(motionPatch(m.key), m.key === "none" ? "Remove motion" : m.label)}
              >
                <span className={`rf-fx-swatch rf-fx-motion-${m.key}`} aria-hidden="true">
                  <span />
                </span>
                <span className="rf-fx-label">{m.label}</span>
                <span className="rf-fx-hint">{m.hint}</span>
              </button>
            ))}
          </div>
          {motion === null && <p className="rf-hint">Custom motion from the Inspector. Pick a preset to replace it.</p>}
        </section>

        <section className="rf-cap-group">
          <h3>Look</h3>
          <div className="rf-fx-grid">
            {PICTURE_EFFECTS.map((e) => {
              const on = value[e.key] > 0;
              return (
                <button
                  key={e.key}
                  aria-pressed={on}
                  className="rf-fx-card"
                  disabled={locked}
                  onClick={() => commit({ [e.key]: on ? 0 : e.preset }, on ? `Remove ${e.label.toLowerCase()}` : e.label)}
                >
                  <span className={`rf-fx-swatch rf-fx-look-${e.key}`} aria-hidden="true">
                    <span />
                  </span>
                  <span className="rf-fx-label">{e.label}</span>
                  <span className="rf-fx-hint">{e.hint}</span>
                </button>
              );
            })}
          </div>
          {PICTURE_EFFECTS.filter((e) => value[e.key] > 0 || draft[e.key] !== undefined).map((e) => (
            <label key={e.key} className="rf-field-row rf-fx-row">
              <span>{e.label}</span>
              <input
                type="range"
                min={1}
                max={100}
                step={1}
                value={Math.max(1, Math.round(value[e.key] * 100))}
                disabled={locked}
                onChange={(ev) => drag(e.key, Number(ev.target.value) / 100)}
                onPointerUp={() => release(e.key, e.label)}
                onKeyUp={(ev) => ev.key.startsWith("Arrow") && release(e.key, e.label)}
                aria-label={`${e.label} amount`}
              />
              <span className="rf-num-static">{Math.round(value[e.key] * 100)}%</span>
            </label>
          ))}
          <p className="rf-hint">Effects apply to this clip only, in the preview and in the export.</p>
        </section>
      </div>
    </section>
  );
}
