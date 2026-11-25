import { useEffect, useRef, useState } from "react";
import type { Caption, CaptionStyle, CaptionStylePatch, Timeline, TimelineOp } from "@reelforge/core/schema";
import { CAPTION_FONTS, CAPTION_PRESETS, resolveCaptionStyle, trackLabels } from "@reelforge/core/schema";
import { formatClock } from "@reelforge/core/timebase";
import type { Client } from "../api.ts";
import type { Notify } from "../editor.ts";
import { analysisOf, type AnalysisMap } from "../analyses.ts";
import { pickSrtPath } from "../native.ts";
import { Icon } from "../icons.tsx";

const LANGUAGES = [
  ["auto", "Detect automatically"],
  ["id", "Indonesian"],
  ["en", "English"],
  ["ms", "Malay"],
  ["ja", "Japanese"],
  ["ko", "Korean"],
  ["zh", "Chinese"],
  ["es", "Spanish"],
] as const;

interface Props {
  client: Client | null;
  timeline: Timeline;
  analyses: AnalysisMap;
  notify: Notify;
  selectedCaption: string | null;
  onSelectCaption: (id: string | null) => void;
  onSeek: (frame: number) => void;
  onApply: (label: string, ops: TimelineOp[]) => void;
  /** Live style while dragging a control (drives the live preview). */
  onStyleDraft: (trackId: string, style: CaptionStylePatch | null) => void;
  onTimelineReplaced: () => void;
}

export function CaptionsPanel(p: Props) {
  const tl = p.timeline;
  const fps = tl.project.settings.fps;
  const captionTracks = tl.tracks.filter((t) => t.kind === "caption");
  // Anything heard can be captioned: audio tracks, and picture tracks holding videos with sound.
  const voiced = new Set(tl.assets.filter((a) => a.hasAudio).map((a) => a.id));
  const audioTracks = tl.tracks.filter((t) => t.kind === "audio" || (t.kind !== "caption" && tl.clips.some((c) => c.trackId === t.id && voiced.has(c.assetId))));
  const labels = trackLabels(tl.tracks);
  const track = captionTracks[0];
  const [sources, setSources] = useState<string[]>(() => audioTracks.filter((t) => t.name === "Voice").map((t) => t.id));
  const [maxWords, setMaxWords] = useState(3);
  const [language, setLanguage] = useState("auto");
  const [pending, setPending] = useState(false);
  // Set only when the engine answered "transcribing": the retry below waits for those transcripts.
  // A request in flight is not waiting, so finished transcripts never trigger a second request.
  const [waiting, setWaiting] = useState(false);
  const inFlight = useRef(false);
  const style: CaptionStyle = resolveCaptionStyle(track?.captionStyle);
  const captions = tl.captions.filter((c) => c.trackId === track?.id);

  // Default source: the Voice track if it has clips, else every track with something heard on it.
  useEffect(() => {
    if (sources.length) return;
    const withClips = audioTracks.filter((t) => tl.clips.some((c) => c.trackId === t.id && voiced.has(c.assetId))).map((t) => t.id);
    if (withClips.length) setSources(withClips);
  }, [tl.clips.length]);

  // Transcripts this generation is waiting for.
  const sourceAssets = [...new Set(tl.clips.filter((c) => sources.includes(c.trackId) && voiced.has(c.assetId)).map((c) => c.assetId))];
  const transcripts = sourceAssets.map((id) => analysisOf(p.analyses, id, "transcript"));
  const running = transcripts.filter((a) => a && (a.state === "queued" || a.state === "running"));
  const progress = running.length ? running.reduce((s, a) => s + (a!.progress ?? 0), 0) / running.length : 0;

  const generate = async () => {
    if (!p.client || !track || inFlight.current) return;
    inFlight.current = true;
    setWaiting(false);
    setPending(true);
    try {
      const r = await p.client.generateCaptions(tl.project.id, { trackId: track.id, sourceTrackIds: sources, maxWords, language, baseRevision: tl.project.revision });
      if (r.status === "applied") {
        p.notify("info", `${r.count} captions created.`);
        setPending(false);
        p.onTimelineReplaced();
      } else {
        // "transcribing": keep pending; the effect below retries once the transcripts finish.
        setWaiting(true);
      }
    } catch (e) {
      setPending(false);
      p.notify("error", e instanceof Error ? e.message : String(e));
    } finally {
      inFlight.current = false;
    }
  };

  useEffect(() => {
    if (!waiting || running.length) return;
    const failed = transcripts.find((a) => a?.state === "failed");
    if (failed) {
      setWaiting(false);
      setPending(false);
      p.notify("error", `Transcription failed: ${failed.error}`);
      return;
    }
    if (transcripts.every((a) => a?.state === "completed")) void generate();
  }, [waiting, running.length, transcripts.map((a) => a?.state).join()]);

  const setStyle = (patch: CaptionStylePatch, label = "Caption style") => track && p.onApply(label, [{ type: "track.update", trackId: track.id, captionStyle: patch }]);

  const exportSrt = async () => {
    if (!p.client || !track || !captions.length) return;
    const path = await pickSrtPath(tl.project.name);
    if (!path) return;
    try {
      await p.client.exportSrt(tl.project.id, path, track.id);
      p.notify("info", `Saved ${path}`);
    } catch (e) {
      p.notify("error", e instanceof Error ? e.message : String(e));
    }
  };

  if (!track) return <section className="rf-panel rf-library"><div className="rf-empty"><p>No caption track.</p></div></section>;

  return (
    <section className="rf-panel rf-library rf-captions" aria-label="Captions">
      <div className="rf-panel-head">
        <h2>Captions</h2>
        <button className="rf-btn" onClick={() => void exportSrt()} disabled={!captions.length} title="Export the captions as a SubRip (.srt) file">
          SRT
        </button>
      </div>

      <div className="rf-captions-scroll">
        <section className="rf-cap-group">
          <h3>Generate from speech</h3>
          <div className="rf-cap-sources" role="group" aria-label="Speech comes from">
            {audioTracks.map((t) => (
              <label key={t.id} className="rf-check">
                <input
                  type="checkbox"
                  checked={sources.includes(t.id)}
                  onChange={(e) => setSources((s) => (e.target.checked ? [...s, t.id] : s.filter((x) => x !== t.id)))}
                />
                {labels.get(t.id)} {t.name}
              </label>
            ))}
          </div>
          <label className="rf-field-row rf-cap-row">
            <span>Words each</span>
            <input type="range" min={1} max={6} value={maxWords} onChange={(e) => setMaxWords(Number(e.target.value))} />
            <span className="rf-num rf-num-static">{maxWords}</span>
          </label>
          <label className="rf-field-row rf-cap-row">
            <span>Language</span>
            <select className="rf-input rf-input-sm" value={language} onChange={(e) => setLanguage(e.target.value)}>
              {LANGUAGES.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          </label>
          <button className="rf-btn rf-btn-primary rf-btn-block" onClick={() => void generate()} disabled={pending || !sources.length || !sourceAssets.length}>
            <Icon name="director" size={15} />{" "}
            {pending ? (running.length ? `Transcribing… ${Math.round(progress * 100)}%` : "Working…") : captions.length ? "Regenerate captions" : "Generate captions"}
          </button>
          <p className="rf-hint">Speech is transcribed on this Mac (whisper.cpp). Regenerating replaces the captions as one undoable step.</p>
        </section>

        <section className="rf-cap-group">
          <h3>Style</h3>
          <div className="rf-segmented rf-preset-row" role="radiogroup" aria-label="Preset">
            {(Object.keys(CAPTION_PRESETS) as (keyof typeof CAPTION_PRESETS)[]).map((k) => (
              <button key={k} role="radio" aria-checked={JSON.stringify(CAPTION_PRESETS[k]) === JSON.stringify(style)} onClick={() => setStyle(CAPTION_PRESETS[k], "Caption preset")}>
                {k[0]!.toUpperCase() + k.slice(1)}
              </button>
            ))}
          </div>
          <label className="rf-field-row rf-cap-row">
            <span>Font</span>
            <select className="rf-input rf-input-sm" value={style.font} onChange={(e) => setStyle({ font: e.target.value as CaptionStyle["font"] })}>
              {Object.keys(CAPTION_FONTS).map((f) => (
                <option key={f}>{f}</option>
              ))}
            </select>
          </label>
          <StyleSlider label="Size" value={style.size * 100} min={1.5} max={12} step={0.1} unit="%" onDraft={(v) => p.onStyleDraft(track.id, { size: v / 100 })} onCommit={(v) => (p.onStyleDraft(track.id, null), setStyle({ size: v / 100 }))} />
          <StyleSlider label="Position" value={style.y * 100} min={5} max={95} step={1} unit="%" onDraft={(v) => p.onStyleDraft(track.id, { y: v / 100 })} onCommit={(v) => (p.onStyleDraft(track.id, null), setStyle({ y: v / 100 }))} />
          <StyleSlider label="Width" value={style.maxWidth * 100} min={30} max={100} step={1} unit="%" onDraft={(v) => p.onStyleDraft(track.id, { maxWidth: v / 100 })} onCommit={(v) => (p.onStyleDraft(track.id, null), setStyle({ maxWidth: v / 100 }))} />
          <StyleSlider label="Outline" value={style.stroke * 100} min={0} max={30} step={1} unit="%" onDraft={(v) => p.onStyleDraft(track.id, { stroke: v / 100 })} onCommit={(v) => (p.onStyleDraft(track.id, null), setStyle({ stroke: v / 100 }))} />
          <div className="rf-color-row">
            <ColorField label="Text" value={style.color} onChange={(v) => v && setStyle({ color: v })} />
            <ColorField label="Highlight" value={style.highlight} onChange={(v) => setStyle({ highlight: v })} optional />
            <ColorField label="Outline" value={style.strokeColor} onChange={(v) => v && setStyle({ strokeColor: v })} />
            <ColorField label="Box" value={style.box?.slice(0, 7) ?? null} onChange={(v) => setStyle({ box: v ? `${v}b3` : null })} optional />
          </div>
          <div className="rf-cap-toggles">
            <label className="rf-check">
              <input type="checkbox" checked={style.uppercase} onChange={(e) => setStyle({ uppercase: e.target.checked })} /> Uppercase
            </label>
            <label className="rf-check">
              <input type="checkbox" checked={style.shadow} onChange={(e) => setStyle({ shadow: e.target.checked })} /> Shadow
            </label>
          </div>
        </section>

        <section className="rf-cap-group">
          <h3>
            Captions <span className="rf-hint">({captions.length})</span>
          </h3>
          {captions.length === 0 ? (
            <p className="rf-hint">None yet. Generate them from speech, or add one at the playhead.</p>
          ) : (
            <ol className="rf-cap-list">
              {captions.map((c) => (
                <CaptionRow
                  key={c.id}
                  caption={c}
                  time={formatClock(c.start, fps)}
                  selected={p.selectedCaption === c.id}
                  onFocus={() => {
                    p.onSelectCaption(c.id);
                    p.onSeek(c.start);
                  }}
                  onText={(text) => p.onApply("Edit caption", [{ type: "caption.update", captionId: c.id, text }])}
                  onDelete={() => p.onApply("Delete caption", [{ type: "caption.delete", captionIds: [c.id] }])}
                />
              ))}
            </ol>
          )}
        </section>
      </div>
    </section>
  );
}

function CaptionRow(p: { caption: Caption; time: string; selected: boolean; onFocus: () => void; onText: (t: string) => void; onDelete: () => void }) {
  const [text, setText] = useState(p.caption.text);
  useEffect(() => {
    setText(p.caption.text);
  }, [p.caption.text]);
  const commit = () => {
    const t = text.trim();
    if (t && t !== p.caption.text) p.onText(t);
    else setText(p.caption.text);
  };
  return (
    <li className={`rf-cap-item${p.selected ? " is-selected" : ""}`}>
      <button className="rf-cap-time" onClick={p.onFocus} title="Go to this caption">
        {p.time}
      </button>
      <input
        className="rf-cap-text"
        value={text}
        maxLength={300}
        aria-label={`Caption at ${p.time}`}
        onFocus={p.onFocus}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          if (e.key === "Escape") {
            setText(p.caption.text);
            (e.target as HTMLInputElement).blur();
          }
        }}
      />
      <button className="rf-icon-btn" onClick={p.onDelete} aria-label={`Delete caption at ${p.time}`}>
        <Icon name="x" size={13} />
      </button>
    </li>
  );
}

function StyleSlider(p: { label: string; value: number; min: number; max: number; step: number; unit: string; onDraft: (v: number) => void; onCommit: (v: number) => void }) {
  const [v, setV] = useState(p.value);
  useEffect(() => {
    setV(p.value);
  }, [p.value]);
  return (
    <label className="rf-field-row rf-cap-row">
      <span>{p.label}</span>
      <input
        type="range"
        min={p.min}
        max={p.max}
        step={p.step}
        value={v}
        onChange={(e) => {
          setV(Number(e.target.value));
          p.onDraft(Number(e.target.value));
        }}
        onPointerUp={() => p.onCommit(v)}
        onKeyUp={(e) => e.key.startsWith("Arrow") && p.onCommit(v)}
      />
      <span className="rf-num rf-num-static">
        {Number(v.toFixed(1))}
        {p.unit}
      </span>
    </label>
  );
}

function ColorField(p: { label: string; value: string | null; onChange: (v: string | null) => void; optional?: boolean }) {
  const ref = useRef<HTMLInputElement>(null);
  const onChange = useRef(p.onChange);
  onChange.current = p.onChange;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // The native `change` event fires once, when the picker is dismissed: one undo step per colour choice
    // (React's onChange fires continuously while dragging inside the picker).
    const handler = () => onChange.current(el.value);
    el.addEventListener("change", handler);
    return () => el.removeEventListener("change", handler);
  }, []);
  useEffect(() => {
    if (ref.current && p.value) ref.current.value = p.value.slice(0, 7);
  }, [p.value]);
  return (
    <label className="rf-color">
      <span>{p.label}</span>
      <span className="rf-color-ctl">
        <input ref={ref} type="color" defaultValue={(p.value ?? "#000000").slice(0, 7)} disabled={p.value === null} aria-label={`${p.label} colour`} />
        {p.optional && (
          <input type="checkbox" checked={p.value !== null} onChange={(e) => p.onChange(e.target.checked ? "#00d5ed" : null)} aria-label={`Use ${p.label.toLowerCase()}`} />
        )}
      </span>
    </label>
  );
}
