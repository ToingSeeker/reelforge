import { useEffect, useState } from "react";
import type { Clip, ClipProps, ClipPropsPatch, Timeline } from "@reelforge/core/schema";
import { DEFAULT_CLIP_PROPS, resolveClipProps } from "@reelforge/core/schema";
import { buildRenderPlan } from "@reelforge/core/render-plan";
import { Icon } from "../icons.tsx";

interface Props {
  timeline: Timeline;
  clip: Clip;
  /** Live, uncommitted values while a control is being dragged (drives the live preview). */
  onDraft: (patch: ClipPropsPatch | null) => void;
  /** One undo step per finished adjustment. */
  onCommit: (patch: ClipPropsPatch, label: string) => void;
}

interface FieldSpec {
  key: keyof ClipProps;
  label: string;
  min: number;
  max: number;
  step: number;
  unit: string;
  /** props value → shown value, and back */
  to: (v: number) => number;
  from: (v: number) => number;
}

export function Inspector({ timeline, clip, onDraft, onCommit }: Props) {
  const track = timeline.tracks.find((t) => t.id === clip.trackId)!;
  const asset = timeline.assets.find((a) => a.id === clip.assetId);
  const fps = timeline.project.settings.fps.num / timeline.project.settings.fps.den;
  const audio = track.kind === "audio";
  const committed = resolveClipProps(clip.props);
  const [draft, setDraft] = useState<ClipPropsPatch>({});
  useEffect(() => {
    setDraft({});
  }, [clip.id, clip.props]);
  const value = { ...committed, ...draft };

  const prev = timeline.clips.find((c) => c.trackId === clip.trackId && c.start + c.duration === clip.start);
  let effectiveTransition = 0;
  try {
    const plan = buildRenderPlan(timeline);
    const seg = [...plan.layers.flat(), ...plan.audio].find((s) => s.clipId === clip.id);
    effectiveTransition = (seg?.inH ?? 0) * 2;
  } catch {
    /* empty or offline timeline: no plan, nothing to show */
  }

  const pct = (lo: number, hi: number, key: keyof ClipProps, label: string, step = 1): FieldSpec => ({
    key, label, min: lo, max: hi, step, unit: "%", to: (v) => Math.round(v * 1000) / 10, from: (v) => v / 100,
  });
  const secs = (key: keyof ClipProps, label: string, max: number): FieldSpec => ({
    key, label, min: 0, max: Math.max(0.05, max / fps), step: 1 / fps, unit: "s", to: (v) => v / fps, from: (v) => Math.round(v * fps),
  });
  const same = (key: keyof ClipProps, label: string, min: number, max: number, step: number, unit: string): FieldSpec => ({
    key, label, min, max, step, unit, to: (v) => v, from: (v) => v,
  });

  const set = (patch: ClipPropsPatch) => {
    const next = { ...draft, ...patch };
    setDraft(next);
    onDraft(next);
  };
  const commit = (label: string) => {
    const changed = Object.fromEntries(Object.entries(draft).filter(([k, v]) => committed[k as keyof ClipProps] !== v)) as ClipPropsPatch;
    onDraft(null);
    if (Object.keys(changed).length) onCommit(changed, label);
    else setDraft({});
  };

  const field = (f: FieldSpec) => {
    const raw = value[f.key] as number;
    const shown = f.to(raw);
    const decimals = f.unit === "s" ? 2 : f.step < 1 ? 1 : 0;
    return (
      <label key={f.key} className="rf-field-row">
        <span>{f.label}</span>
        <input
          type="range"
          min={f.min}
          max={f.max}
          step={f.step}
          value={shown}
          disabled={track.locked}
          onChange={(e) => set({ [f.key]: f.from(Number(e.target.value)) } as ClipPropsPatch)}
          onPointerUp={() => commit(f.label)}
          onKeyUp={(e) => e.key.startsWith("Arrow") && commit(f.label)}
        />
        <input
          className="rf-num"
          type="number"
          min={f.min}
          max={f.max}
          step={f.step}
          value={Number(shown.toFixed(decimals))}
          disabled={track.locked}
          onChange={(e) => e.target.value !== "" && set({ [f.key]: f.from(Math.min(f.max, Math.max(f.min, Number(e.target.value)))) } as ClipPropsPatch)}
          onBlur={() => commit(f.label)}
          onKeyDown={(e) => e.key === "Enter" && commit(f.label)}
          aria-label={`${f.label} (${f.unit})`}
        />
        <span className="rf-unit">{f.unit}</span>
      </label>
    );
  };

  const zoomOn = value.scaleEnd !== null;
  const reset = () => {
    onDraft(null);
    const patch = Object.fromEntries(Object.keys(clip.props).map((k) => [k, DEFAULT_CLIP_PROPS[k as keyof ClipProps]])) as ClipPropsPatch;
    if (Object.keys(patch).length) onCommit(patch, "Reset clip");
  };

  return (
    <div className="rf-inspector">
      <div className="rf-inspector-head">
        <div>
          <div className="rf-inspector-title">{asset?.filename ?? "Clip"}</div>
          <div className="rf-inspector-sub">
            {track.name} · {(clip.duration / fps).toFixed(2)}s{track.locked ? " · locked" : ""}
          </div>
        </div>
        <button className="rf-btn rf-btn-ghost" onClick={reset} disabled={!Object.keys(clip.props).length || track.locked}>
          Reset
        </button>
      </div>

      {!audio && (
        <section className="rf-inspector-group">
          <h3>Transform</h3>
          <div className="rf-field-row">
            <span>Fit</span>
            <div className="rf-segmented rf-segmented-inline" role="radiogroup" aria-label="Fit">
              {(["cover", "contain"] as const).map((fit) => (
                <button key={fit} role="radio" aria-checked={value.fit === fit} disabled={track.locked} onClick={() => onCommit({ fit }, "Fit")}>
                  {fit === "cover" ? "Fill" : "Fit"}
                </button>
              ))}
            </div>
          </div>
          {field(pct(5, 400, "scale", "Scale"))}
          <label className="rf-field-row rf-field-check">
            <span>Zoom</span>
            <input
              type="checkbox"
              checked={zoomOn}
              disabled={track.locked}
              onChange={(e) => onCommit({ scaleEnd: e.target.checked ? Math.min(10, value.scale * 1.2) : null }, "Zoom")}
            />
            <span className="rf-hint">animate scale across the clip</span>
          </label>
          {zoomOn && field({ ...pct(5, 400, "scaleEnd", "Zoom to"), to: (v) => Math.round((v ?? value.scale) * 1000) / 10 })}
          {field(pct(-100, 100, "x", "Position X"))}
          {field(pct(-100, 100, "y", "Position Y"))}
          {field(same("rotation", "Rotation", -180, 180, 1, "°"))}
          {field(pct(0, 100, "opacity", "Opacity"))}
          <h3>Crop</h3>
          {field(pct(0, 45, "cropLeft", "Left"))}
          {field(pct(0, 45, "cropRight", "Right"))}
          {field(pct(0, 45, "cropTop", "Top"))}
          {field(pct(0, 45, "cropBottom", "Bottom"))}
        </section>
      )}

      {audio && (
        <section className="rf-inspector-group">
          <h3>Audio</h3>
          {field(same("gainDb", "Gain", -60, 12, 0.5, "dB"))}
        </section>
      )}

      <section className="rf-inspector-group">
        <h3>Fades &amp; transition</h3>
        {field(secs("fadeIn", audio ? "Fade in" : "Fade in", clip.duration))}
        {field(secs("fadeOut", "Fade out", clip.duration))}
        {field(secs("transitionIn", audio ? "Crossfade in" : "Dissolve in", Math.min(clip.duration, prev?.duration ?? 0) * 2))}
        <p className="rf-hint rf-inspector-note">
          {!prev
            ? `${audio ? "Crossfade" : "Dissolve"} needs a clip ending exactly where this one starts on the same track.`
            : value.transitionIn > 0 && effectiveTransition < value.transitionIn && !Object.keys(draft).length
              ? `Only ${(effectiveTransition / fps).toFixed(2)}s plays: the media has no more frames beyond the cut (handles).`
              : `${audio ? "Crossfades" : "Dissolves"} from “${timeline.assets.find((a) => a.id === prev.assetId)?.filename ?? "previous clip"}”, centred on the cut.`}
        </p>
      </section>
    </div>
  );
}

export function RightPanelTabs({ tab, onTab, hasClip }: { tab: "inspector" | "director"; onTab: (t: "inspector" | "director") => void; hasClip: boolean }) {
  return (
    <div className="rf-right-tabs" role="tablist" aria-label="Right panel">
      <button role="tab" aria-selected={tab === "inspector"} onClick={() => onTab("inspector")}>
        <Icon name="settings" size={14} /> Inspector{hasClip ? "" : ""}
      </button>
      <button role="tab" aria-selected={tab === "director"} onClick={() => onTab("director")}>
        <Icon name="sparkle" size={14} /> AI Director
      </button>
    </div>
  );
}
