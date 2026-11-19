import { useEffect, useRef, useState } from "react";
import type { Project } from "@reelforge/core/schema";
import { ApiError } from "../api.ts";
import { Icon } from "../icons.tsx";

/** Asks before a project is deleted for good, and says what stays: the media files and exported videos. */
export function DeleteProjectDialog({ project, onCancel, onDelete }: { project: Project; onCancel: () => void; onDelete: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  // Cancel has the focus: Return on an open dialog never deletes by accident.
  useEffect(() => cancelRef.current?.focus(), []);
  const cancel = useRef(onCancel);
  cancel.current = onCancel;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && cancel.current();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      await onDelete();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <div className="rf-scrim" onMouseDown={(e) => e.target === e.currentTarget && !busy && onCancel()}>
      <div className="rf-dialog" role="alertdialog" aria-modal="true" aria-labelledby="rf-delete-title" aria-describedby="rf-delete-body">
        <div className="rf-dialog-head">
          <h2 id="rf-delete-title">Delete “{project.name}”?</h2>
          <button type="button" className="rf-icon-btn" onClick={onCancel} aria-label="Close" disabled={busy}>
            <Icon name="x" size={16} />
          </button>
        </div>
        <div id="rf-delete-body" className="rf-delete-body">
          <p>The project's timeline, captions, AI versions and history are removed. This can't be undone.</p>
          <p className="rf-delete-note">Your media files and exported videos stay where they are on this Mac.</p>
        </div>
        {error && (
          <p className="rf-form-error" role="alert">
            {error}
          </p>
        )}
        <div className="rf-dialog-actions">
          <button ref={cancelRef} type="button" className="rf-btn" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="rf-btn rf-btn-danger" onClick={() => void confirm()} disabled={busy}>
            <Icon name="trash" size={15} /> {busy ? "Deleting…" : "Delete project"}
          </button>
        </div>
      </div>
    </div>
  );
}
