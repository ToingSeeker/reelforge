import { useEffect, useMemo, useState } from "react";
import type { AiFx, Clip, Timeline } from "@reelforge/core/schema";
import { FX_CATALOG, fxInfo, type FxInfo } from "@reelforge/core/fx-catalog";

interface Props {
  timeline: Timeline;
  clip: Clip;
  playhead: number;
  locked: boolean;
  /** One undo step: the clip's whole new effect list. */
  onCommit: (effects: AiFx[], label: string) => void;
}

const FILTERS = [
  { id: "all", label: "All" },
  { id: "graphics", label: "Graphics" },
  { id: "camera", label: "Camera" },
  { id: "cards", label: "Pictures" },
] as const;

/**
 * Face-tracked AI effects (packages/fx-engine) on one video clip. Times are stored in source frames
 * (so they stay on their words when the clip moves); here they are shown on the timeline clock.
 */
export function AiEffects({ timeline, clip, playhead, locked, onCommit }: Props) {
  const fps = timeline.project.settings.fps.num / timeline.project.settings.fps.den;
  const effects = clip.props.aiEffects ?? [];
  const [filter, setFilter] = useState<(typeof FILTERS)[number]["id"]>("all");
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<number | null>(null);
  useEffect(() => {
    setOpen(null);
  }, [clip.id]);

  // source frame ↔ timeline frame, through the clip
  const toTl = (src: number) => clip.start + (src - clip.sourceIn);
  const toSrc = (tl: number) => clip.sourceIn + (tl - clip.start);
  const clipEnd = clip.start + clip.duration;

  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    return FX_CATALOG.filter(
      (f) =>
        (filter === "all" || (filter === "camera" ? f.camera : filter === "cards" ? f.images : !f.camera && !f.images)) &&
        (!q || f.label.toLowerCase().includes(q) || f.fx.includes(q) || f.about.toLowerCase().includes(q)),
    );
  }, [filter, query]);

  const add = (f: FxInfo) => {
    // At the playhead when it is over the clip, else at the clip's start; 3 s reads best.
    const at = playhead >= clip.start && playhead < clipEnd - 1 ? playhead : clip.start;
    const end = Math.min(clipEnd, at + Math.round(3 * fps));
    const next = [...effects, { fx: f.fx, start: toSrc(at), end: toSrc(Math.max(at + 1, end)) }];
    onCommit(next, `AI effect: ${f.label}`);
    setOpen(next.length - 1);
  };
  const update = (i: number, patch: Partial<AiFx>, label: string) => {
    const next = effects.map((e, k) => (k === i ? { ...e, ...patch } : e));
    onCommit(next, label);
  };
  const remove = (i: number) => {
    onCommit(effects.filter((_, k) => k !== i), `Remove AI effect`);
    setOpen(null);
  };

  return (
    <section className="rf-cap-group">
      <h3>AI effects</h3>
      <p>Graphics that follow the speaker&apos;s face, rendered by the effects engine on this Mac. Best on talking-head clips.</p>

      {effects.length > 0 && (
        <ul className="rf-aifx-list">
          {effects.map((e, i) => {
            const info = fxInfo(e.fx);
            const shown = Math.max(clip.start, toTl(e.start)) < Math.min(clipEnd, toTl(e.end));
            return (
              <li key={`${i}-${e.fx}`} className={`rf-aifx-item${open === i ? " is-open" : ""}`}>
                <button className="rf-aifx-row" onClick={() => setOpen(open === i ? null : i)} aria-expanded={open === i}>
                  <span className="rf-aifx-name">{info?.label ?? e.fx}</span>
                  <span className="rf-aifx-time">
                    {shown ? `${(toTl(e.start) / fps).toFixed(1)}–${(toTl(e.end) / fps).toFixed(1)}s` : "outside the clip"}
                  </span>
                </button>
                {open === i && info && <EffectEditor fx={e} info={info} fps={fps} toTl={toTl} toSrc={toSrc} locked={locked} timeline={timeline} onChange={(p, l) => update(i, p, l)} onRemove={() => remove(i)} />}
              </li>
            );
          })}
        </ul>
      )}

      <div className="rf-aifx-browse">
        <input className="rf-input rf-input-sm" type="search" placeholder="Search 45 effects…" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search AI effects" />
        <div className="rf-segmented rf-aifx-filter" role="radiogroup" aria-label="Effect type">
          {FILTERS.map((f) => (
            <button key={f.id} role="radio" aria-checked={filter === f.id} onClick={() => setFilter(f.id)}>
              {f.label}
            </button>
          ))}
        </div>
        <ul className="rf-aifx-catalog" aria-label="AI effects catalogue">
          {list.map((f) => (
            <li key={f.fx}>
              <button className="rf-aifx-add" disabled={locked || effects.length >= 20} onClick={() => add(f)} title={`Add at the playhead: ${f.about}`}>
                <span className="rf-aifx-name">{f.label}</span>
                <span className="rf-aifx-about">{f.about}</span>
              </button>
            </li>
          ))}
          {list.length === 0 && <li className="rf-hint">No effect matches “{query}”.</li>}
        </ul>
      </div>
    </section>
  );
}

function EffectEditor(props: {
  fx: AiFx;
  info: FxInfo;
  fps: number;
  toTl: (src: number) => number;
  toSrc: (tl: number) => number;
  locked: boolean;
  timeline: Timeline;
  onChange: (patch: Partial<AiFx>, label: string) => void;
  onRemove: () => void;
}) {
  const { fx, info, fps, toTl, toSrc, locked, timeline, onChange } = props;
  const others = info.keys.filter((k) => !["text", "color", "images"].includes(k));
  const media = timeline.assets.filter((a) => (a.kind === "image" || a.kind === "video") && a.status !== "missing");
  const secs = (src: number) => Number((toTl(src) / fps).toFixed(2));
  const setTime = (key: "start" | "end", v: string) => {
    const tl = Math.round(Number(v) * fps);
    if (!Number.isFinite(tl)) return;
    const src = Math.max(0, toSrc(tl));
    const next = { start: fx.start, end: fx.end, [key]: src };
    if (next.end > next.start) onChange({ [key]: src }, "AI effect timing");
  };
  return (
    <div className="rf-aifx-edit">
      <p className="rf-hint">{info.about}</p>
      <label className="rf-field-row rf-aifx-field">
        <span>From</span>
        <input className="rf-input rf-input-sm" type="number" step={0.1} defaultValue={secs(fx.start)} key={`s${fx.start}`} disabled={locked} onBlur={(e) => setTime("start", e.target.value)} onKeyDown={(e) => e.key === "Enter" && setTime("start", e.currentTarget.value)} />
        <span className="rf-unit">s</span>
      </label>
      <label className="rf-field-row rf-aifx-field">
        <span>To</span>
        <input className="rf-input rf-input-sm" type="number" step={0.1} defaultValue={secs(fx.end)} key={`e${fx.end}`} disabled={locked} onBlur={(e) => setTime("end", e.target.value)} onKeyDown={(e) => e.key === "Enter" && setTime("end", e.currentTarget.value)} />
        <span className="rf-unit">s</span>
      </label>
      {info.keys.includes("text") && (
        <TextField label="Text" value={fx.text ?? ""} placeholder="Lines with |" disabled={locked} onCommit={(v) => onChange({ text: v || undefined }, "AI effect text")} />
      )}
      {info.keys.includes("color") && (
        <label className="rf-field-row rf-aifx-field">
          <span>Colour</span>
          <input type="color" value={fx.color ?? "#ffffff"} disabled={locked} onChange={(e) => onChange({ color: e.target.value }, "AI effect colour")} />
          {fx.color && (
            <button className="rf-btn rf-btn-ghost rf-btn-xs" disabled={locked} onClick={() => onChange({ color: undefined }, "AI effect colour")}>
              Default
            </button>
          )}
        </label>
      )}
      {others.map((k) => (
        <TextField
          key={k}
          label={k}
          value={fx.opts?.[k] === undefined ? "" : String(fx.opts[k])}
          placeholder="default"
          disabled={locked}
          onCommit={(v) => {
            const opts = { ...(fx.opts ?? {}) };
            if (v === "") delete opts[k];
            else opts[k] = /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v;
            onChange({ opts: Object.keys(opts).length ? opts : undefined }, `AI effect ${k}`);
          }}
        />
      ))}
      {info.images && (
        <fieldset className="rf-aifx-images" disabled={locked}>
          <legend>Pictures</legend>
          {media.length === 0 ? (
            <p className="rf-hint">Frames of this clip are used. Import screenshots or reels to use them instead.</p>
          ) : (
            media.map((a) => (
              <label key={a.id} className="rf-check">
                <input
                  type="checkbox"
                  checked={fx.images?.includes(a.id) ?? false}
                  onChange={(e) => {
                    const set = new Set(fx.images ?? []);
                    if (e.target.checked) set.add(a.id);
                    else set.delete(a.id);
                    onChange({ images: set.size ? [...set].slice(0, 24) : undefined }, "AI effect pictures");
                  }}
                />{" "}
                {a.filename}
              </label>
            ))
          )}
        </fieldset>
      )}
      <p className="rf-hint">Options: {info.options}</p>
      <button className="rf-btn rf-btn-ghost rf-aifx-remove" disabled={locked} onClick={props.onRemove}>
        Remove effect
      </button>
    </div>
  );
}

function TextField({ label, value, placeholder, disabled, onCommit }: { label: string; value: string; placeholder: string; disabled: boolean; onCommit: (v: string) => void }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => {
    setDraft(value);
  }, [value]);
  const done = () => draft.trim() !== value && onCommit(draft.trim());
  return (
    <label className="rf-field-row rf-aifx-field">
      <span>{label}</span>
      <input className="rf-input rf-input-sm" value={draft} placeholder={placeholder} maxLength={400} disabled={disabled} onChange={(e) => setDraft(e.target.value)} onBlur={done} onKeyDown={(e) => e.key === "Enter" && done()} />
    </label>
  );
}
