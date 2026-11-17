import { useEffect, useMemo, useState } from "react";
import type { Clip, ClipProps, ClipPropsPatch, Timeline } from "@reelforge/core/schema";
import { DEFAULT_CLIP_PROPS, resolveClipProps, trackLabels } from "@reelforge/core/schema";
import { buildRenderPlan } from "@reelforge/core/render-plan";
import { MOTION_PRESETS, motionPatch, motionPresetOf, PICTURE_EFFECTS } from "@reelforge/core/effects";
import { Icon } from "../icons.tsx";
import { Accordion, NumberField, Row, Segmented, Slider } from "./ui.tsx";

export type InspectorTab = "transform" | "style" | "audio";

interface Props {
  timeline: Timeline;
  clip: Clip;
  tab: InspectorTab;
  onTab: (t: InspectorTab) => void;
  /** Live, uncommitted values while a control is being adjusted (drives the live preview). */
  onDraft: (patch: ClipPropsPatch | null) => void;
  /** One undo step per finished adjustment. */
  onCommit: (patch: ClipPropsPatch, label: string) => void;
  onHide: () => void;
}

const pctTo = (v: number) => Math.round(v * 1000) / 10;
const pctFrom = (v: number) => v / 100;

export function Inspector({ timeline, clip, tab, onTab, onDraft, onCommit, onHide }: Props) {
  const track = timeline.tracks.find((t) => t.id === clip.trackId)!;
  const asset = timeline.assets.find((a) => a.id === clip.assetId);
  const fps = timeline.project.settings.fps.num / timeline.project.settings.fps.den;
  const audio = track.kind === "audio";
  const visual = !audio;
  // A video with sound is heard on its own track too, so it gets the gain control (fades apply to both).
  const heard = audio || !!asset?.hasAudio;
  const locked = track.locked;
  const committed = resolveClipProps(clip.props);
  const [draft, setDraft] = useState<ClipPropsPatch>({});
  useEffect(() => {
    setDraft({});
  }, [clip.id, clip.props]);
  const value: ClipProps = { ...committed, ...draft };

  const tabs = [
    ...(visual ? [{ value: "transform" as const, label: "Transform" }] : []),
    { value: "style" as const, label: visual ? "Style" : "Fades" },
    ...(heard ? [{ value: "audio" as const, label: "Audio" }] : []),
  ];
  const current = tabs.some((t) => t.value === tab) ? tab : tabs[0]!.value;

  // The same media sounding at the same moment on another unmuted track plays twice.
  const labels = useMemo(() => trackLabels(timeline.tracks), [timeline.tracks]);
  const twinClip = heard
    ? timeline.clips.find(
        (c) =>
          c.id !== clip.id &&
          c.assetId === clip.assetId &&
          c.trackId !== clip.trackId &&
          c.start < clip.start + clip.duration &&
          clip.start < c.start + c.duration &&
          !timeline.tracks.find((t) => t.id === c.trackId)?.muted &&
          !track.muted,
      )
    : undefined;
  const twin = twinClip ? (labels.get(twinClip.trackId) ?? "another track") : null;

  const prev = timeline.clips.find((c) => c.trackId === clip.trackId && c.start + c.duration === clip.start);
  // Building the plan is not free and the app re-renders during playback: only redo it when the timeline changes.
  const effectiveTransition = useMemo(() => {
    try {
      const plan = buildRenderPlan(timeline);
      const seg = [...plan.layers.flat(), ...plan.audio].find((s) => s.clipId === clip.id);
      return (seg?.inH ?? 0) * 2;
    } catch {
      return 0; // empty or offline timeline: no plan, nothing to show
    }
  }, [timeline, clip.id]);

  const live = (patch: ClipPropsPatch) => {
    const next = { ...draft, ...patch };
    setDraft(next);
    onDraft(next);
  };
  const commit = (patch: ClipPropsPatch, label: string) => {
    onDraft(null);
    setDraft({});
    const changed = Object.fromEntries(Object.entries(patch).filter(([k, v]) => committed[k as keyof ClipProps] !== v)) as ClipPropsPatch;
    if (Object.keys(changed).length) onCommit(changed, label);
  };

  /** A numeric clip property shown in display units (%, s, °, dB). */
  const num = (
    key: keyof ClipProps,
    label: string,
    o: { min: number; max: number; step: number; unit: string; to?: (v: number) => number; from?: (v: number) => number; prefix?: string; reset?: boolean },
  ) => {
    const to = o.to ?? ((v: number) => v);
    const from = o.from ?? ((v: number) => v);
    const raw = value[key] as number;
    const def = DEFAULT_CLIP_PROPS[key] as number;
    return (
      <NumberField
        label={label}
        prefix={o.prefix}
        value={to(raw)}
        min={o.min}
        max={o.max}
        step={o.step}
        unit={o.unit}
        disabled={locked}
        resetTo={o.reset === false ? undefined : to(def)}
        onChange={(v) => live({ [key]: from(v) } as ClipPropsPatch)}
        onCommit={(v) => commit({ [key]: from(v) } as ClipPropsPatch, label)}
      />
    );
  };
  const pct = (key: keyof ClipProps, label: string, min: number, max: number, extra: { prefix?: string } = {}) =>
    num(key, label, { min, max, step: 1, unit: "%", to: pctTo, from: pctFrom, ...extra });
  const secs = (key: keyof ClipProps, label: string, maxFrames: number) =>
    num(key, label, { min: 0, max: Math.max(0.05, maxFrames / fps), step: Math.round((1 / fps) * 1000) / 1000, unit: "s", to: (v) => v / fps, from: (v) => Math.round(v * fps) });

  const reset = () => {
    onDraft(null);
    const patch = Object.fromEntries(Object.keys(clip.props).map((k) => [k, DEFAULT_CLIP_PROPS[k as keyof ClipProps]])) as ClipPropsPatch;
    if (Object.keys(patch).length) onCommit(patch, "Reset clip");
  };

  const motion = motionPresetOf(value);
  const zoomOn = value.scaleEnd !== null;
  const cropCount = (["cropLeft", "cropRight", "cropTop", "cropBottom"] as const).filter((k) => value[k] > 0).length;
  const looks = PICTURE_EFFECTS.filter((e) => value[e.key] > 0).length;

  return (
    <div className="rf-inspector">
      <div className="rf-inspector-head">
        <Segmented label="Inspector section" role="tabs" value={current} options={tabs} onChange={onTab} className="rf-inspector-tabs" />
        <HideButton onHide={onHide} />
      </div>

      <div className="rf-inspector-clip">
        <div className="rf-inspector-clip-text">
          <div className="rf-inspector-title" title={asset?.filename}>{asset?.filename ?? "Clip"}</div>
          <div className="rf-inspector-sub">
            {labels.get(track.id) ?? track.name} · {(clip.duration / fps).toFixed(2)} s{locked ? " · locked" : ""}
          </div>
        </div>
        <button className="rf-btn rf-btn-quiet rf-btn-sm" onClick={reset} disabled={!Object.keys(clip.props).length || locked} title="Reset every property of this clip">
          <Icon name="reset" size={14} /> Reset
        </button>
      </div>
      {locked && <p className="rf-inline-note"><Icon name="lock" size={13} /> Track is locked. Unlock it on the timeline to edit.</p>}

      <div className="rf-inspector-body" role="tabpanel" aria-label={tabs.find((t) => t.value === current)?.label}>
        {current === "transform" && (
          <>
            <Segmented
              label="Fit"
              value={value.fit}
              disabled={locked}
              options={[
                { value: "contain", label: "Fit", title: "Whole picture visible (letterbox if needed)" },
                { value: "cover", label: "Fill", title: "Fill the frame (crops the overflow)" },
              ]}
              onChange={(fit) => commit({ fit }, "Fit")}
              className="rf-seg-fit"
            />
            <Row label="Position">
              <div className="rf-pair">
                {pct("x", "Position X", -100, 100, { prefix: "X" })}
                {pct("y", "Position Y", -100, 100, { prefix: "Y" })}
              </div>
            </Row>
            <Row label="Scale" className="rf-row-slider">
              <Slider
                label="Scale"
                min={5}
                max={400}
                step={1}
                value={pctTo(value.scale)}
                disabled={locked}
                onChange={(v) => live({ scale: pctFrom(v) })}
                onCommit={(v) => commit({ scale: pctFrom(v) }, "Scale")}
              />
              {pct("scale", "Scale", 5, 400)}
            </Row>
            <div className="rf-pair rf-pair-labeled">
              <label className="rf-mini">
                <span>Rotation</span>
                {num("rotation", "Rotation", { min: -180, max: 180, step: 1, unit: "°" })}
              </label>
              <label className="rf-mini">
                <span>Opacity</span>
                {pct("opacity", "Opacity", 0, 100)}
              </label>
            </div>

            <Accordion title="Crop" icon="crop" persistKey="crop" summary={cropCount ? `${cropCount} edge${cropCount === 1 ? "" : "s"}` : null}>
              <div className="rf-grid2">
                <label className="rf-mini"><span>Left</span>{pct("cropLeft", "Crop left", 0, 45)}</label>
                <label className="rf-mini"><span>Right</span>{pct("cropRight", "Crop right", 0, 45)}</label>
                <label className="rf-mini"><span>Top</span>{pct("cropTop", "Crop top", 0, 45)}</label>
                <label className="rf-mini"><span>Bottom</span>{pct("cropBottom", "Crop bottom", 0, 45)}</label>
              </div>
            </Accordion>

            <Accordion title="Motion" icon="motion" persistKey="motion" summary={motion && motion !== "none" ? MOTION_PRESETS.find((m) => m.key === motion)?.label : motion === null ? "Custom" : null}>
              <Row label="Preset">
                <select
                  className="rf-input rf-input-sm"
                  aria-label="Motion preset"
                  disabled={locked}
                  value={motion ?? ""}
                  onChange={(e) => e.target.value && commit(motionPatch(e.target.value as Parameters<typeof motionPatch>[0]), "Motion")}
                >
                  {motion === null && <option value="">Custom</option>}
                  {MOTION_PRESETS.map((m) => (
                    <option key={m.key} value={m.key}>
                      {m.label} · {m.hint}
                    </option>
                  ))}
                </select>
              </Row>
              <label className="rf-switch-row">
                <input
                  type="checkbox"
                  className="rf-switch"
                  checked={zoomOn}
                  disabled={locked}
                  onChange={(e) => commit({ scaleEnd: e.target.checked ? Math.min(10, value.scale * 1.2) : null }, "Zoom")}
                />
                <span>Animate scale across the clip</span>
              </label>
              {zoomOn && <Row label="Zoom to">{num("scaleEnd", "Zoom to", { min: 5, max: 400, step: 1, unit: "%", to: (v) => pctTo(v ?? value.scale), from: pctFrom, reset: false })}</Row>}
              {(value.xEnd !== null || value.yEnd !== null) && (
                <Row label="Pan to">
                  <div className="rf-pair">
                    {value.xEnd !== null ? num("xEnd", "Pan to X", { min: -100, max: 100, step: 1, unit: "%", to: (v) => pctTo(v ?? value.x), from: pctFrom, prefix: "X", reset: false }) : <span />}
                    {value.yEnd !== null ? num("yEnd", "Pan to Y", { min: -100, max: 100, step: 1, unit: "%", to: (v) => pctTo(v ?? value.y), from: pctFrom, prefix: "Y", reset: false }) : <span />}
                  </div>
                </Row>
              )}
            </Accordion>
          </>
        )}

        {current === "style" && (
          <>
            <Accordion title={audio ? "Fades & crossfade" : "Fades & transition"} icon="transitions" defaultOpen persistKey="fades">
              <Row label="Fade in">{secs("fadeIn", "Fade in", clip.duration)}</Row>
              <Row label="Fade out">{secs("fadeOut", "Fade out", clip.duration)}</Row>
              <Row label={audio ? "Crossfade" : "Dissolve"}>{secs("transitionIn", audio ? "Crossfade in" : "Dissolve in", Math.min(clip.duration, prev?.duration ?? 0) * 2)}</Row>
              <p className="rf-hint">
                {!prev
                  ? `${audio ? "Crossfade" : "Dissolve"} needs a clip ending exactly where this one starts on the same track.`
                  : value.transitionIn > 0 && effectiveTransition < value.transitionIn && !Object.keys(draft).length
                    ? `Only ${(effectiveTransition / fps).toFixed(2)} s plays: the media has no more frames beyond the cut (handles).`
                    : `${audio ? "Crossfades" : "Dissolves"} from “${timeline.assets.find((a) => a.id === prev.assetId)?.filename ?? "previous clip"}”, centred on the cut.`}
              </p>
            </Accordion>
            {visual && (
              <Accordion title="Look" icon="color" persistKey="look" summary={looks ? `${looks} on` : null}>
                {PICTURE_EFFECTS.map((e) => (
                  <Row key={e.key} label={e.label}>
                    {num(e.key, e.label, { min: 0, max: 100, step: 1, unit: "%", to: (v) => Math.round(v * 100), from: (v) => v / 100 })}
                  </Row>
                ))}
                <p className="rf-hint">Camera moves, presets and AI effects live in the Effects panel.</p>
              </Accordion>
            )}
          </>
        )}

        {current === "audio" && (
          <>
            <Row label="Gain" className="rf-row-slider">
              <Slider
                label="Gain"
                min={-60}
                max={12}
                step={0.5}
                value={value.gainDb}
                disabled={locked}
                onChange={(v) => live({ gainDb: v })}
                onCommit={(v) => commit({ gainDb: v }, "Gain")}
              />
              {num("gainDb", "Gain", { min: -60, max: 12, step: 0.5, unit: "dB" })}
            </Row>
            {!audio && track.muted && <p className="rf-inline-note">This track is muted, so the clip is silent. Unmute it with the speaker on the track header.</p>}
            {twin && (
              <p className="rf-inline-note is-warning">
                <Icon name="alert" size={13} /> Heard twice: the same media also plays on {twin} at the same time. Delete the copy or mute one of the tracks.
              </p>
            )}
            <p className="rf-hint">Fades in the {visual ? "Style" : "Fades"} tab shape the sound too.</p>
          </>
        )}
      </div>
    </div>
  );
}

function HideButton({ onHide }: { onHide: () => void }) {
  return (
    <button className="rf-icon-btn rf-icon-btn-sm" onClick={onHide} aria-label="Hide inspector" data-tip="Hide inspector">
      <Icon name="panelRight" size={16} />
    </button>
  );
}

/** What the inspector shows when it has nothing to edit. */
export function InspectorEmpty(p: { selectedCount: number; captionSelected: boolean; hasClips: boolean; onOpenText: () => void; onHide: () => void }) {
  return (
    <>
    <div className="rf-inspector-head">
      <h2>Inspector</h2>
      <HideButton onHide={p.onHide} />
    </div>
    <div className="rf-empty rf-inspector-empty">
      {p.selectedCount > 1 ? (
        <>
          <p className="rf-empty-title">{p.selectedCount} clips selected</p>
          <p className="rf-empty-body">The inspector edits one clip at a time. Split, delete or move them together on the timeline.</p>
        </>
      ) : p.captionSelected ? (
        <>
          <p className="rf-empty-title">Caption selected</p>
          <p className="rf-empty-body">Caption text, timing and style are edited in the Text panel.</p>
          <button className="rf-btn rf-btn-sm" onClick={p.onOpenText}>
            <Icon name="text" size={14} /> Open Text panel
          </button>
        </>
      ) : (
        <>
          <p className="rf-empty-title">Nothing selected</p>
          <p className="rf-empty-body">{p.hasClips ? "Click a clip on the timeline to adjust its transform, style and sound." : "Add media to the timeline, then select a clip to adjust it here."}</p>
        </>
      )}
    </div>
    </>
  );
}
