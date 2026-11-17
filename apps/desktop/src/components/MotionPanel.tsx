import { useEffect, useMemo, useRef, useState } from "react";
import { Player } from "@remotion/player";
import { MOTION_MAX_SECONDS, MOTION_TEMPLATE_IDS, MOTION_TEMPLATES, type MotionTemplateId } from "@reelforge/core/motion-catalog";
import type { Asset, Timeline } from "@reelforge/core/schema";
import { COMPOSITIONS } from "@reelforge/motion/compositions";
import { ApiError, type Client, type MotionGraphicInfo } from "../api.ts";

interface Props {
  client: Client;
  timeline: Timeline;
  notify: (tone: "info" | "error", text: string) => void;
  /** Put a finished graphic on the timeline at the playhead (App picks the track). */
  onPlace: (asset: Asset, durationFrames: number) => void | Promise<void>;
  /** Reports a render in progress (null when none) so the agent card can show it. */
  onRender?: (r: { template: string; progress: number } | null) => void;
}

type Field = { key: string; label: string } & ({ kind: "text"; max: number } | { kind: "color" } | { kind: "choice"; options: readonly string[] });

const LABELS: Record<string, string> = { accent: "Accent", color: "Text colour", panel: "Panel", align: "Alignment", side: "Side", corner: "Corner" };
const label = (k: string) => LABELS[k] ?? k.charAt(0).toUpperCase() + k.slice(1);

/** Form fields straight from the template's schema, so the panel can't drift from what the engine accepts. */
function fieldsOf(id: MotionTemplateId): Field[] {
  const t = MOTION_TEMPLATES[id];
  return Object.entries(t.schema.shape).map(([key, s]): Field => {
    const options = (s as { options?: unknown }).options;
    if (Array.isArray(options)) return { key, label: label(key), kind: "choice", options: options as string[] };
    const def = (t.defaults as Record<string, unknown>)[key];
    if (typeof def === "string" && /^#[0-9a-f]{6}$/i.test(def)) return { key, label: label(key), kind: "color" };
    return { key, label: label(key), kind: "text", max: (s as { maxLength?: number | null }).maxLength ?? 200 };
  });
}

type Progress = { state: "rendering"; progress: number; label: string } | { state: "idle" };

/** Motion graphics: Remotion templates, previewed live and rendered by the engine into a transparent clip. */
export function MotionPanel({ client, timeline, notify, onPlace, onRender }: Props) {
  const { width, height, fps: rate } = timeline.project.settings;
  const fps = rate.num / rate.den;
  const [template, setTemplate] = useState<MotionTemplateId>("title-card");
  const [values, setValues] = useState<Record<MotionTemplateId, Record<string, unknown>>>(
    () => Object.fromEntries(MOTION_TEMPLATE_IDS.map((id) => [id, { ...MOTION_TEMPLATES[id].defaults }])) as never,
  );
  const [seconds, setSeconds] = useState<number>(MOTION_TEMPLATES["title-card"].defaultSeconds);
  const [progress, setProgress] = useState<Progress>({ state: "idle" });
  // Mirror the render into the agent card; clear it when this panel goes away (the poll stops with it).
  useEffect(() => {
    onRender?.(progress.state === "rendering" ? { template: progress.label, progress: progress.progress } : null);
  }, [progress, onRender]);
  useEffect(() => () => onRender?.(null), [onRender]);
  const [engine, setEngine] = useState<{ ok: true } | { ok: false; reason: string } | null>(null);
  const [graphics, setGraphics] = useState<MotionGraphicInfo[]>([]);
  const projectId = timeline.project.id;
  // The poll outlives renders of this component (the app re-renders every 2 s); keep the latest callbacks in refs.
  const latest = useRef({ onPlace, notify });
  latest.current = { onPlace, notify };
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const loadGraphics = useMemo(
    () => () =>
      client
        .motionGraphics(projectId)
        .then((r) => {
          if (!alive.current) return;
          setEngine(r.engine);
          setGraphics(r.graphics);
        })
        .catch(() => {}),
    [client, projectId],
  );
  useEffect(() => {
    void loadGraphics();
  }, [loadGraphics]);

  const props = values[template];
  const fields = useMemo(() => fieldsOf(template), [template]);
  const check = MOTION_TEMPLATES[template].schema.safeParse(props);
  const durationFrames = Math.max(1, Math.round(seconds * fps));
  const secondsOk = seconds > 0 && seconds <= MOTION_MAX_SECONDS;
  const busy = progress.state === "rendering";

  const pick = (id: MotionTemplateId) => {
    setTemplate(id);
    setSeconds(MOTION_TEMPLATES[id].defaultSeconds);
  };
  const set = (key: string, v: unknown) => setValues((all) => ({ ...all, [template]: { ...all[template], [key]: v } }));

  const create = async () => {
    if (!check.success || !secondsOk) return;
    const label = MOTION_TEMPLATES[template].label;
    setProgress({ state: "rendering", progress: 0, label });
    try {
      let st = await client.createMotion(projectId, { template, props: check.data as Record<string, unknown>, durationFrames });
      while (st.state !== "done" && st.state !== "failed") {
        if (!alive.current) return;
        setProgress({ state: "rendering", progress: st.state === "running" ? st.progress : 0, label });
        await new Promise((r) => setTimeout(r, 400));
        st = await client.motionStatus(projectId, st.key);
      }
      if (st.state === "failed") throw new Error(st.error);
      await latest.current.onPlace(st.asset, durationFrames);
      void loadGraphics();
    } catch (e) {
      latest.current.notify("error", e instanceof ApiError || e instanceof Error ? e.message : String(e));
    } finally {
      if (alive.current) setProgress({ state: "idle" });
    }
  };

  const reuse = (g: MotionGraphicInfo) => {
    setTemplate(g.template);
    setValues((all) => ({ ...all, [g.template]: { ...MOTION_TEMPLATES[g.template].defaults, ...g.props } }));
    setSeconds(Math.round((g.durationFrames / fps) * 10) / 10);
  };

  const aspect = width / height;
  return (
    <section className="rf-panel rf-library" aria-label="Templates">
      <div className="rf-panel-head">
        <h2>Templates</h2>
        <span className="rf-chip" title="Motion graphics are made with Remotion (remotion.dev)">Remotion</span>
      </div>
      <div className="rf-captions-scroll">
        {engine && !engine.ok && <p className="rf-hint rf-pad rf-motion-warn">{engine.reason}</p>}
        <section className="rf-cap-group">
          <h3>Motion graphics</h3>
          <div className="rf-fx-grid" role="radiogroup" aria-label="Template">
            {MOTION_TEMPLATE_IDS.map((id) => (
              <button key={id} className="rf-fx-card" role="radio" aria-checked={template === id} onClick={() => pick(id)} disabled={busy}>
                <span className="rf-fx-label">{MOTION_TEMPLATES[id].label}</span>
                <span className="rf-fx-hint">{MOTION_TEMPLATES[id].description}</span>
              </button>
            ))}
          </div>
        </section>

        <section className="rf-cap-group">
          <div className="rf-motion-stage" style={{ aspectRatio: `${width} / ${height}`, maxWidth: aspect < 1 ? 200 : "100%" }}>
            <Player
              key={`${template}-${durationFrames}`}
              component={COMPOSITIONS[template]}
              inputProps={(check.success ? check.data : MOTION_TEMPLATES[template].defaults) as never}
              durationInFrames={durationFrames + 1}
              compositionWidth={width}
              compositionHeight={height}
              fps={fps}
              style={{ width: "100%", height: "100%" }}
              loop
              autoPlay
              controls
            />
          </div>
          <p className="rf-hint">The checkerboard is transparent: your footage shows there.</p>
        </section>

        <section className="rf-cap-group rf-motion-form">
          {fields.map((f) => (
            <label key={f.key} className="rf-field">
              <span>{f.label}</span>
              {f.kind === "text" ? (
                <input className="rf-input" value={String(props[f.key] ?? "")} maxLength={f.max} onChange={(e) => set(f.key, e.target.value)} disabled={busy} />
              ) : f.kind === "color" ? (
                <input className="rf-motion-color" type="color" value={String(props[f.key])} onChange={(e) => set(f.key, e.target.value)} disabled={busy} />
              ) : (
                <select className="rf-input" value={String(props[f.key])} onChange={(e) => set(f.key, e.target.value)} disabled={busy}>
                  {f.options.map((o) => (
                    <option key={o} value={o}>
                      {o.replace("-", " ")}
                    </option>
                  ))}
                </select>
              )}
            </label>
          ))}
          <label className="rf-field">
            <span>Length (seconds)</span>
            <input
              className="rf-input"
              type="number"
              min={0.5}
              max={MOTION_MAX_SECONDS}
              step={0.5}
              value={seconds}
              onChange={(e) => setSeconds(Number(e.target.value))}
              disabled={busy}
            />
          </label>
          {!check.success && <p className="rf-hint rf-motion-warn">{check.error.issues[0]?.message}</p>}
          {!secondsOk && <p className="rf-hint rf-motion-warn">Length must be between 0.5 and {MOTION_MAX_SECONDS} seconds.</p>}
          <button className="rf-btn rf-btn-primary" onClick={() => void create()} disabled={busy || !check.success || !secondsOk || (engine !== null && !engine.ok)}>
            {busy ? `Rendering… ${Math.round((progress as { progress: number }).progress * 100)}%` : "Add at playhead"}
          </button>
          {busy && (
            <div className="rf-motion-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round((progress as { progress: number }).progress * 100)}>
              <div style={{ width: `${(progress as { progress: number }).progress * 100}%` }} />
            </div>
          )}
          <p className="rf-hint">Rendered once on this Mac as a transparent clip and placed on the overlay track. It also appears in Media.</p>
        </section>

        <p className="rf-hint rf-pad">
          Made with Remotion. Free for individuals and companies of up to 3 people. Larger companies need a Remotion company
          license (remotion.dev/license).
        </p>

        {graphics.length > 0 && (
          <section className="rf-cap-group">
            <h3>In this project</h3>
            <ul className="rf-motion-list">
              {graphics.map((g) => {
                const asset = timeline.assets.find((a) => a.id === g.assetId);
                const title = String(g.props.title ?? g.props.name ?? g.props.text ?? "");
                return (
                  <li key={g.assetId}>
                    <button className="rf-btn rf-btn-ghost" onClick={() => reuse(g)} disabled={busy} title="Load these settings to make a variation">
                      <strong>{MOTION_TEMPLATES[g.template]?.label ?? g.template}</strong> {title}
                    </button>
                    {asset && (
                      <button className="rf-btn" onClick={() => void onPlace(asset, g.durationFrames)} disabled={busy}>
                        Add again
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        )}
      </div>
    </section>
  );
}
