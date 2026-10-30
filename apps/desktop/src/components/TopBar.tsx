import { useEffect, useRef, useState } from "react";
import type { Project } from "@reelforge/core/schema";
import { aspectRatioLabel } from "@reelforge/core/schema";
import { Icon, LogoMark } from "../icons.tsx";

export type Workspace = "edit" | "automate" | "review";

const WORKSPACES: { id: Workspace; label: string }[] = [
  { id: "edit", label: "Edit" },
  { id: "automate", label: "Automate" },
  { id: "review", label: "Review & Export" },
];

interface Props {
  projects: Project[];
  current: Project | null;
  offline: boolean;
  loading: boolean;
  workspace: Workspace;
  onWorkspace: (w: Workspace) => void;
  onSelectProject: (id: string) => void;
  onNewProject: () => void;
  onRename: (name: string) => Promise<void>;
}

export function TopBar(p: Props) {
  return (
    <header className="rf-topbar">
      <div className="rf-brand">
        <LogoMark />
        <div>
          <div className="rf-brand-name">ReelForge</div>
          <div className="rf-brand-sub">AI VIDEO EDITOR</div>
        </div>
      </div>

      <ProjectSwitcher {...p} />

      <nav className="rf-workspaces" aria-label="Workspace">
        {WORKSPACES.map((w) => (
          <button
            key={w.id}
            className="rf-workspace-tab"
            aria-current={p.workspace === w.id ? "page" : undefined}
            onClick={() => p.onWorkspace(w.id)}
          >
            {w.label}
          </button>
        ))}
      </nav>

      <div className="rf-topbar-right">
        <SaveStatus current={p.current} offline={p.offline} loading={p.loading} />
        <div className="rf-btn-group">
          <button className="rf-icon-btn" disabled title="Undo — arrives with the editing core (M1)" aria-label="Undo">
            <Icon name="undo" />
          </button>
          <button className="rf-icon-btn" disabled title="Redo — arrives with the editing core (M1)" aria-label="Redo">
            <Icon name="redo" />
          </button>
        </div>
        <button className="rf-btn rf-btn-primary" disabled title="Export — arrives with the render engine (M2)">
          <Icon name="export" size={16} /> Export
        </button>
      </div>
    </header>
  );
}

function SaveStatus({ current, offline, loading }: { current: Project | null; offline: boolean; loading: boolean }) {
  if (offline) {
    return (
      <span className="rf-save rf-save-offline" role="status">
        <Icon name="alert" size={15} /> Engine offline
      </span>
    );
  }
  if (loading || !current) return <span className="rf-save" />;
  return (
    <span className="rf-save" role="status" title={`Last committed ${new Date(current.updatedAt).toLocaleString()}`}>
      <span className="rf-save-dot">
        <Icon name="check" size={11} strokeWidth={3} />
      </span>
      Saved · rev {current.revision}
    </span>
  );
}

function ProjectSwitcher({ projects, current, onSelectProject, onNewProject, onRename }: Props) {
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
        <span className="rf-switcher-name">{current.name}</span>
        <Icon name="chevronDown" size={16} />
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
