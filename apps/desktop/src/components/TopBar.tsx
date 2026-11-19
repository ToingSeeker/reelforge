import { useEffect, useRef, useState } from "react";
import type { Project, RenderJob } from "@reelforge/core/schema";
import { aspectRatioLabel } from "@reelforge/core/schema";
import { Icon } from "../icons.tsx";
import { ReelForgeLogo, type LogoState } from "./ReelForgeLogo.tsx";

export type Workspace = "edit" | "automate" | "review";

const WORKSPACES: { id: Workspace; label: string }[] = [
  { id: "edit", label: "Edit" },
  { id: "automate", label: "Automate" },
  { id: "review", label: "Review" },
];

interface Props {
  projects: Project[];
  current: Project | null;
  offline: boolean;
  loading: boolean;
  busy: boolean;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  exporting: RenderJob | null;
  onExport: () => void;
  onCancelExport: () => void;
  workspace: Workspace;
  onWorkspace: (w: Workspace) => void;
  onSelectProject: (id: string) => void;
  onNewProject: () => void;
  onRename: (name: string) => Promise<void>;
  /** Asks first (DeleteProjectDialog), then deletes the current project. */
  onDelete: () => void;
  /** Agent lifecycle, mapped in activity.ts. */
  logoState: LogoState;
  /** Short text for the agent state (also what reduced-motion users get instead of the animation). */
  agentLabel: string | null;
}

export function TopBar(p: Props) {
  return (
    <header className="rf-topbar">
      <div className="rf-topbar-left">
        <div className="rf-brand" tabIndex={-1}>
          <ReelForgeLogo state={p.logoState} size={34} wordmark title={`ReelForge${p.agentLabel ? `: ${p.agentLabel}` : ""}`} />
          {p.agentLabel && (
            <span className={`rf-brand-state is-${p.logoState}`} role="status">
              {p.agentLabel}
            </span>
          )}
        </div>
        <span className="rf-topbar-sep" aria-hidden="true" />
        <ProjectSwitcher {...p} />
      </div>

      <nav className="rf-seg rf-seg-glass rf-workspaces" aria-label="Workspace">
        {WORKSPACES.map((w) => (
          <button key={w.id} type="button" aria-current={p.workspace === w.id ? "page" : undefined} onClick={() => p.onWorkspace(w.id)}>
            {w.label}
          </button>
        ))}
      </nav>

      <div className="rf-topbar-right">
        <SaveStatus current={p.current} offline={p.offline} loading={p.loading} busy={p.busy} />
        <div className="rf-btn-group">
          <button className="rf-icon-btn" disabled={!p.canUndo} onClick={p.onUndo} data-tip="Undo  ⌘Z" aria-label="Undo">
            <Icon name="undo" />
          </button>
          <button className="rf-icon-btn" disabled={!p.canRedo} onClick={p.onRedo} data-tip="Redo  ⇧⌘Z" aria-label="Redo">
            <Icon name="redo" />
          </button>
        </div>
        {p.exporting ? (
          <div className="rf-export-progress" role="status" title={p.exporting.outputPath ?? undefined}>
            <span className="rf-num-tab">Exporting {p.exporting.state === "queued" ? "· queued" : `${Math.round(p.exporting.progress * 100)}%`}</span>
            <div className="rf-meter rf-meter-orange">
              <div style={{ width: `${Math.round(p.exporting.progress * 100)}%` }} />
            </div>
            <button className="rf-icon-btn rf-icon-btn-sm" onClick={p.onCancelExport} aria-label="Cancel export" data-tip="Cancel export">
              <Icon name="x" size={14} />
            </button>
          </div>
        ) : (
          <button className="rf-btn rf-btn-export" onClick={p.onExport} disabled={!p.current} title="Export MP4 (H.264 / AAC)">
            Export <Icon name="export" size={16} strokeWidth={2} />
          </button>
        )}
      </div>
    </header>
  );
}

function SaveStatus({ current, offline, loading, busy }: { current: Project | null; offline: boolean; loading: boolean; busy: boolean }) {
  if (offline) {
    return (
      <span className="rf-save rf-save-offline" role="status">
        <Icon name="alert" size={15} /> Engine offline
      </span>
    );
  }
  if (loading) return <span className="rf-save">Connecting…</span>;
  if (!current) return <span className="rf-save" />;
  if (busy) {
    return (
      <span className="rf-save" role="status">
        <span className="rf-spinner" aria-hidden="true" /> Saving…
      </span>
    );
  }
  return (
    <span className="rf-save" role="status" title={`Saved by the engine · revision ${current.revision} · ${new Date(current.updatedAt).toLocaleString()}`}>
      <Icon name="checkCircle" size={17} />
      Saved {ago(current.updatedAt)}
    </span>
  );
}

function ProjectSwitcher({ projects, current, onSelectProject, onNewProject, onRename, onDelete }: Props) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);

  if (!current) {
    return (
      <div className="rf-switcher">
        <button className="rf-switcher-btn" onClick={onNewProject}>
          <Icon name="plus" size={16} /> New project
        </button>
      </div>
    );
  }

  if (editing) {
    const commit = async () => {
      setEditing(false);
      const name = draft.trim();
      if (name && name !== current.name) await onRename(name);
    };
    return (
      <form
        className="rf-switcher"
        onSubmit={(e) => {
          e.preventDefault();
          void commit();
        }}
      >
        <input
          className="rf-input rf-rename-input"
          aria-label="Project name"
          autoFocus
          maxLength={120}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => void commit()}
          onKeyDown={(e) => e.key === "Escape" && setEditing(false)}
        />
      </form>
    );
  }

  return (
    <div className="rf-switcher" ref={root}>
      <button
        className="rf-switcher-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        onDoubleClick={() => {
          setDraft(current.name);
          setEditing(true);
        }}
        title="Switch project (double-click to rename)"
      >
        <Icon name="folder" size={17} />
        <span className="rf-switcher-name">{current.name}</span>
        <Icon name="chevronDown" size={15} />
      </button>
      {open && (
        <div className="rf-menu" role="menu">
          <div className="rf-menu-label">Projects</div>
          {projects.map((p) => (
            <button
              key={p.id}
              role="menuitemradio"
              aria-checked={p.id === current.id}
              className="rf-menu-item"
              onClick={() => {
                onSelectProject(p.id);
                setOpen(false);
              }}
            >
              <span className="rf-menu-check">{p.id === current.id && <Icon name="check" size={14} />}</span>
              <span className="rf-menu-text">{p.name}</span>
              <span className="rf-menu-meta">{aspectRatioLabel(p.settings).split(" ")[0]}</span>
            </button>
          ))}
          <div className="rf-menu-divider" />
          <button
            role="menuitem"
            className="rf-menu-item"
            onClick={() => {
              setOpen(false);
              setDraft(current.name);
              setEditing(true);
            }}
          >
            <span className="rf-menu-check">
              <Icon name="pencil" size={14} />
            </span>
            Rename “{current.name}”
          </button>
          <button
            role="menuitem"
            className="rf-menu-item is-danger"
            onClick={() => {
              setOpen(false);
              onDelete();
            }}
          >
            <span className="rf-menu-check">
              <Icon name="trash" size={14} />
            </span>
            Delete “{current.name}”…
          </button>
          <button
            role="menuitem"
            className="rf-menu-item"
            onClick={() => {
              setOpen(false);
              onNewProject();
            }}
          >
            <span className="rf-menu-check">
              <Icon name="plus" size={14} />
            </span>
            New project…
          </button>
        </div>
      )}
    </div>
  );
}

/** "just now", "2 min ago", "3 h ago", then the date. Re-evaluated on the app's 2 s poll. */
function ago(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString();
}
