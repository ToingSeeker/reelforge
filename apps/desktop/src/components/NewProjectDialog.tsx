import { useEffect, useRef, useState } from "react";
import type { CreateProjectInput } from "@reelforge/core/schema";
import { parseFps } from "@reelforge/core/timebase";
import { ApiError } from "../api.ts";
import { Icon } from "../icons.tsx";

const FORMATS = [
  { id: "9:16", label: "9:16 · Reels / TikTok / Shorts", width: 1080, height: 1920 },
  { id: "16:9", label: "16:9 · YouTube", width: 1920, height: 1080 },
  { id: "1:1", label: "1:1 · Square", width: 1080, height: 1080 },
  { id: "4:5", label: "4:5 · Feed portrait", width: 1080, height: 1350 },
];
const RATES = ["24", "25", "29.97", "30", "60"];

export function NewProjectDialog({
  onCancel,
  onCreate,
}: {
  onCancel: () => void;
  onCreate: (input: CreateProjectInput) => Promise<void>;
}) {
  const [name, setName] = useState("Untitled Reel");
  const [format, setFormat] = useState("9:16");
  const [fps, setFps] = useState("30");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  // Select the default name once, on open. (Tied to onCancel, which the parent recreates on every render,
  // this re-ran on every 2 s project poll and selected the text being typed, so the next key replaced it.)
  useEffect(() => {
    nameRef.current?.select();
  }, []);
  const cancel = useRef(onCancel);
  cancel.current = onCancel;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && cancel.current();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const f = FORMATS.find((x) => x.id === format)!;
    setBusy(true);
    setError(null);
    try {
      await onCreate({ name, settings: { width: f.width, height: f.height, fps: parseFps(fps) } });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <div className="rf-scrim" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <form className="rf-dialog" role="dialog" aria-modal="true" aria-labelledby="rf-new-title" onSubmit={submit}>
        <div className="rf-dialog-head">
          <h2 id="rf-new-title">New project</h2>
          <button type="button" className="rf-icon-btn" onClick={onCancel} aria-label="Close">
            <Icon name="x" size={16} />
          </button>
        </div>
        <label className="rf-field">
          <span>Name</span>
          <input ref={nameRef} className="rf-input" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} required />
        </label>
        <fieldset className="rf-field">
          <legend>Format</legend>
          <div className="rf-format-grid">
            {FORMATS.map((f) => (
              <label key={f.id} className="rf-format" data-checked={format === f.id}>
                <input type="radio" name="format" value={f.id} checked={format === f.id} onChange={() => setFormat(f.id)} />
                <span className="rf-format-shape" style={{ aspectRatio: `${f.width} / ${f.height}` }} />
                <span className="rf-format-label">{f.label}</span>
                <span className="rf-format-res">
                  {f.width} × {f.height}
                </span>
              </label>
            ))}
          </div>
        </fieldset>
        <label className="rf-field">
          <span>Frame rate</span>
          <select className="rf-input" value={fps} onChange={(e) => setFps(e.target.value)}>
            {RATES.map((r) => (
              <option key={r} value={r}>
                {r} fps
              </option>
            ))}
          </select>
        </label>
        {error && (
          <p className="rf-form-error" role="alert">
            {error}
          </p>
        )}
        <div className="rf-dialog-actions">
          <button type="button" className="rf-btn" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="rf-btn rf-btn-primary" disabled={busy}>
            {busy ? "Creating…" : "Create project"}
          </button>
        </div>
      </form>
    </div>
  );
}
