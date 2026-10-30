import { useCallback, useEffect, useMemo, useState } from "react";
import type { Project } from "@reelforge/core/schema";
import { ApiError, createClient, resolveApiInfo, type Client } from "./api.ts";
import { TopBar, type Workspace } from "./components/TopBar.tsx";
import { LeftRail, type RailItem } from "./components/LeftRail.tsx";
import { MediaLibrary } from "./components/MediaLibrary.tsx";
import { Preview } from "./components/Preview.tsx";
import { AIDirector } from "./components/AIDirector.tsx";
import { Timeline } from "./components/Timeline.tsx";
import { NewProjectDialog } from "./components/NewProjectDialog.tsx";
import { Welcome } from "./components/Welcome.tsx";
import { Placeholder } from "./components/Placeholder.tsx";

const CURRENT_KEY = "rf.currentProject";
const POLL_MS = 2000;

function readPref(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function writePref(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* preferences are best-effort */
  }
}

export function App() {
  const [client, setClient] = useState<Client | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [offline, setOffline] = useState(false);
  const [currentId, setCurrentId] = useState<string | null>(() => readPref(CURRENT_KEY));
  const [workspace, setWorkspace] = useState<Workspace>("edit");
  const [rail, setRail] = useState<RailItem>("media");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [toast, setToast] = useState<{ tone: "info" | "error"; text: string } | null>(null);

  useEffect(() => {
    resolveApiInfo()
      .then((info) => setClient(createClient(info)))
      .catch((e: unknown) => setBootError(e instanceof Error ? e.message : String(e)));
  }, []);

  const refresh = useCallback(async () => {
    if (!client) return;
    try {
      setProjects(await client.listProjects());
      setOffline(false);
    } catch {
      setOffline(true);
    }
  }, [client]);

  // The CLI, MCP clients and this window all write the same database, so the
  // UI re-reads it rather than trusting its own copy.
  useEffect(() => {
    if (!client) return;
    void refresh();
    const tick = () => document.visibilityState === "visible" && void refresh();
    const id = window.setInterval(tick, POLL_MS);
    window.addEventListener("focus", tick);
    return () => {
      window.clearInterval(id);
      window.removeEventListener("focus", tick);
    };
  }, [client, refresh]);

  useEffect(() => {
    if (!toast) return;
    const id = window.setTimeout(() => setToast(null), 4500);
    return () => window.clearTimeout(id);
  }, [toast]);

  const current = useMemo(() => {
    if (!projects?.length) return null;
    return projects.find((p) => p.id === currentId) ?? projects[0] ?? null;
  }, [projects, currentId]);

  const selectProject = (id: string) => {
    setCurrentId(id);
    writePref(CURRENT_KEY, id);
  };

  // Pin the fallback choice; otherwise a project created from the CLI would
  // become "most recent" and silently take over this window.
  useEffect(() => {
    if (current && current.id !== currentId) selectProject(current.id);
  }, [current, currentId]);

  const createProject = async (input: Parameters<Client["createProject"]>[0]) => {
    if (!client) return;
    const p = await client.createProject(input);
    selectProject(p.id);
    setDialogOpen(false);
    await refresh();
  };

  const renameProject = async (name: string) => {
    if (!client || !current) return;
    try {
      await client.renameProject(current.id, name, current.revision);
    } catch (e) {
      if (e instanceof ApiError && e.code === "REVISION_CONFLICT") {
        setToast({ tone: "error", text: "This project changed elsewhere, so your rename was not applied. Reloaded the latest version." });
      } else {
        setToast({ tone: "error", text: e instanceof Error ? e.message : String(e) });
      }
    }
    await refresh();
  };

  if (bootError) {
    return (
      <div className="rf-boot" role="alert">
        <h1>ReelForge engine not reachable</h1>
        <p>{bootError}</p>
      </div>
    );
  }

  return (
    <div className="rf-app">
      <TopBar
        projects={projects ?? []}
        current={current}
        offline={offline}
        loading={projects === null}
        workspace={workspace}
        onWorkspace={setWorkspace}
        onSelectProject={selectProject}
        onNewProject={() => setDialogOpen(true)}
        onRename={renameProject}
      />

      {projects !== null && !current ? (
        <Welcome onCreate={() => setDialogOpen(true)} />
      ) : workspace !== "edit" ? (
        <Placeholder workspace={workspace} />
      ) : (
        <div className="rf-studio">
          <LeftRail active={rail} onChange={setRail} />
          <MediaLibrary />
          <Preview project={current} />
          <AIDirector />
          <Timeline project={current} />
        </div>
      )}

      <footer className="rf-statusbar">
        {current ? (
          <>
            <span>{current.name}</span>
            <span className="rf-sep" />
            <span>00:00.00</span>
            <span className="rf-sep" />
            <span>0 clips</span>
            <span className="rf-sep" />
            <span>rev {current.revision}</span>
            <span className="rf-statusbar-right">
              {current.settings.width} × {current.settings.height} · {formatFpsLabel(current)} FPS
            </span>
          </>
        ) : (
          <span>{projects === null ? "Connecting to engine…" : "No project open"}</span>
        )}
      </footer>

      {dialogOpen && <NewProjectDialog onCancel={() => setDialogOpen(false)} onCreate={createProject} />}
      {toast && (
        <div className={`rf-toast rf-toast-${toast.tone}`} role="status">
          {toast.text}
        </div>
      )}
    </div>
  );
}

function formatFpsLabel(p: Project): string {
  const { num, den } = p.settings.fps;
  return den === 1 ? String(num) : (num / den).toFixed(2);
}
