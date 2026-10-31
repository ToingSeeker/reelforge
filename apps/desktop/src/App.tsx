import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AIProposal, Asset, CaptionStylePatch, ClipPropsPatch, Project, Timeline as TimelineData, TimelineOp } from "@reelforge/core/schema";
import { applyOperations, canPlace, clipEnd } from "@reelforge/core/timeline-ops";
import { SettingsDialog } from "./components/SettingsDialog.tsx";
import { AutomationLab } from "./components/AutomationLab.tsx";
import { formatClock } from "@reelforge/core/timebase";
import { createClient, resolveApiInfo, type Client } from "./api.ts";
import { useEditor } from "./editor.ts";
import { onFileDrop, pickExportPath, pickMediaFiles } from "./native.ts";
import { useExports, usePreview } from "./render.ts";
import { RenderQueue } from "./components/RenderQueue.tsx";
import { CaptionsPanel } from "./components/CaptionsPanel.tsx";
import { AudioPanel } from "./components/AudioPanel.tsx";
import { analysisOf, useAnalyses } from "./analyses.ts";
import { beatsOnTimeline } from "@reelforge/core/context";
import { microsToFrames } from "@reelforge/core/timebase";
import { TopBar, type Workspace } from "./components/TopBar.tsx";
import { LeftRail, type RailItem } from "./components/LeftRail.tsx";
import { MediaLibrary } from "./components/MediaLibrary.tsx";
import { Preview } from "./components/Preview.tsx";
import { AIDirector } from "./components/AIDirector.tsx";
import { Inspector, RightPanelTabs } from "./components/Inspector.tsx";
import type { PreviewMode } from "./components/Preview.tsx";
import { Timeline, type AssetDropHandler } from "./components/Timeline.tsx";
import { NewProjectDialog } from "./components/NewProjectDialog.tsx";
import { Welcome } from "./components/Welcome.tsx";
import { RailPlaceholder } from "./components/Placeholder.tsx";
import { EffectsPanel } from "./components/EffectsPanel.tsx";
import { Icon } from "./icons.tsx";

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

const isTyping = (t: EventTarget | null) =>
  t instanceof HTMLElement && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName));

export function App() {
  const [client, setClient] = useState<Client | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [offline, setOffline] = useState(false);
  const [currentId, setCurrentId] = useState<string | null>(() => readPref(CURRENT_KEY));
  const [workspace, setWorkspace] = useState<Workspace>("edit");
  const [rail, setRail] = useState<RailItem>("media");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [toast, setToast] = useState<{ tone: "info" | "error"; text: string; id: number } | null>(null);
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [playhead, setPlayhead] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [previewMode, setPreviewMode] = useState<PreviewMode>(() => (readPref("rf.previewMode") === "rendered" ? "rendered" : "live"));
  const [rightTab, setRightTab] = useState<"inspector" | "director">("director");
  const [draft, setDraft] = useState<{ clipId: string; props: ClipPropsPatch } | null>(null);
  const [styleDraft, setStyleDraft] = useState<{ trackId: string; style: CaptionStylePatch } | null>(null);
  const [selectedCaption, setSelectedCaption] = useState<string | null>(null);
  const [previewProposal, setPreviewProposal] = useState<AIProposal | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [snapToBeats, setSnapToBeats] = useState(() => readPref("rf.snapBeats") !== "0");
  const [importing, setImporting] = useState(false);
  const [fileHover, setFileHover] = useState(false);
  const [assetDrag, setAssetDrag] = useState<{ asset: Asset; x: number; y: number } | null>(null);
  const dropHandler = useRef<AssetDropHandler | null>(null);

  const notify = useCallback((tone: "info" | "error", text: string) => setToast({ tone, text, id: Date.now() }), []);

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
    const id = window.setTimeout(() => setToast(null), toast.tone === "error" ? 7000 : 3500);
    return () => window.clearTimeout(id);
  }, [toast]);

  const listed = useMemo(() => {
    if (!projects?.length) return null;
    return projects.find((p) => p.id === currentId) ?? projects[0] ?? null;
  }, [projects, currentId]);

  const selectProject = (id: string) => {
    setCurrentId(id);
    writePref(CURRENT_KEY, id);
  };

  // Pin the fallback choice; otherwise a project created from the CLI would
  // become "most recent" and silently take over this window.
  const editor = useEditor(client, listed?.id ?? null, notify);
  const tl = editor.timeline;
  // The project list is polled; the timeline is updated by every edit. Whichever
  // saw the later revision wins, so a rename right after an edit doesn't
  // conflict with our own change.
  const current = useMemo(
    () => (listed && tl && tl.project.id === listed.id && tl.project.revision > listed.revision ? tl.project : listed),
    [listed, tl],
  );
  const fps = current?.settings.fps ?? { num: 30, den: 1 };

  const preview = usePreview(client, tl, previewMode === "rendered");
  const selectedClip = selection.size === 1 && tl ? (tl.clips.find((c) => selection.has(c.id)) ?? null) : null;
  // "Preview plan": run the proposal's operations locally (same reducer as the engine, nothing saved).
  const proposed = useMemo<TimelineData | null>(() => {
    if (!tl || !previewProposal || previewProposal.baseRevision !== tl.project.revision) return null;
    try {
      const next = applyOperations(
        {
          fps: tl.project.settings.fps,
          tracks: new Map(tl.tracks.map((t) => [t.id, t])),
          clips: new Map(tl.clips.map((c) => [c.id, c])),
          captions: new Map(tl.captions.map((c) => [c.id, c])),
          assets: new Map(tl.assets.map((a) => [a.id, a])),
        },
        previewProposal.operations,
      );
      const clips = [...next.clips.values()];
      const captions = [...next.captions.values()];
      return {
        ...tl,
        tracks: [...next.tracks.values()].sort((a, b) => a.position - b.position),
        clips,
        captions,
        durationFrames: Math.max(0, ...clips.map((c) => c.start + c.duration), ...captions.map((c) => c.start + c.duration)),
      };
    } catch {
      return null;
    }
  }, [tl, previewProposal]);
  useEffect(() => {
    // The timeline moved on: the preview no longer describes what Apply would do.
    if (previewProposal && tl && previewProposal.baseRevision !== tl.project.revision) setPreviewProposal(null);
  }, [tl?.project.revision]);

  // The live preview shows inspector / caption-style drags before they are committed.
  const viewTimeline = useMemo<TimelineData | null>(() => {
    const base = proposed ?? tl;
    if (!base || (!draft && !styleDraft)) return base;
    const tl2 = base;
    return {
      ...tl2,
      clips: draft ? tl2.clips.map((c) => (c.id === draft.clipId ? { ...c, props: { ...c.props, ...draft.props } } : c)) : tl2.clips,
      tracks: styleDraft ? tl2.tracks.map((t) => (t.id === styleDraft.trackId ? { ...t, captionStyle: { ...t.captionStyle, ...styleDraft.style } } : t)) : tl2.tracks,
    };
  }, [tl, proposed, draft, styleDraft]);
  const analyses = useAnalyses(client, current?.id ?? null, notify);
  // Beat and scene-cut positions on the timeline, per clip (markers + snapping).
  const markers = useMemo(() => {
    const m = new Map<string, { beats: number[]; cuts: number[] }>();
    if (!tl) return m;
    const fps = tl.project.settings.fps;
    for (const c of tl.clips) {
      const beats = analysisOf(analyses.map, c.assetId, "beats");
      const scenes = analysisOf(analyses.map, c.assetId, "scenes");
      const b = beats?.result && beats.result.confidence >= 0.3 ? beatsOnTimeline(c, beats.result, fps) : [];
      const cuts = scenes?.result
        ? scenes.result.cuts.map((x) => microsToFrames(x.timeUs, fps, "nearest")).filter((f) => f > c.sourceIn && f < c.sourceIn + c.duration).map((f) => c.start + f - c.sourceIn)
        : [];
      if (b.length || cuts.length) m.set(c.id, { beats: b, cuts });
    }
    return m;
  }, [tl, analyses.map]);
  const snapExtra = useMemo(() => (snapToBeats ? [...markers.values()].flatMap((x) => [...x.beats, ...x.cuts]) : []), [markers, snapToBeats]);
  useEffect(() => {
    if (selectedClip) setRightTab("inspector");
    setDraft(null);
  }, [selectedClip?.id]);
  const exports = useExports(client, notify);
  /** Any manual playhead move stops playback. */
  const seek = useCallback((f: number) => {
    setPlaying(false);
    setPlayhead(f);
  }, []);

  useEffect(() => {
    setSelection(new Set());
    setSelectedCaption(null);
    setPlayhead(0);
    setPlaying(false);
  }, [current?.id]);

  const doExport = async () => {
    if (!current || !tl) return;
    if (!tl.durationFrames) return notify("info", "Add clips to the timeline before exporting.");
    if (exports.active) return notify("info", "An export is already running.");
    const path = await pickExportPath(current.name);
    if (path) void exports.start(current.id, path);
  };

  useEffect(() => {
    if (listed && listed.id !== currentId) selectProject(listed.id);
  }, [listed, currentId]);

  useEffect(() => {
    if (listed) editor.syncRevision(listed.revision);
  }, [listed?.revision]);

  // Drop selections that no longer exist (undo, another client's edit).
  useEffect(() => {
    if (!tl) return;
    const ids = new Set(tl.clips.map((c) => c.id));
    setSelection((s) => (Array.from(s).every((id) => ids.has(id)) ? s : new Set(Array.from(s).filter((id) => ids.has(id)))));
  }, [tl]);

  const createProject = async (input: Parameters<Client["createProject"]>[0]) => {
    if (!client) return;
    const p = await client.createProject(input);
    // Load the list first: selecting an id the list doesn't have yet gets "corrected" back to the first project.
    await refresh();
    selectProject(p.id);
    setDialogOpen(false);
  };

  const renameProject = async (name: string) => {
    if (!client || !current) return;
    try {
      await client.renameProject(current.id, name, current.revision);
    } catch (e) {
      notify("error", e instanceof Error ? e.message : String(e));
    }
    await refresh();
  };

  const doImport = async (paths?: string[]) => {
    const files = paths ?? (await pickMediaFiles());
    if (!files.length) return;
    setImporting(true);
    await editor.importPaths(files);
    setImporting(false);
    void refresh();
  };

  const relink = async (asset: Asset) => {
    const [path] = await pickMediaFiles({ multiple: false });
    if (path) await editor.relink(asset, path);
  };

  const apply = (label: string, ops: TimelineOp[]) => void editor.apply(label, ops);

  const appendAsset = (asset: Asset) => {
    if (!tl) return;
    const track =
      tl.tracks.find((t) => !t.locked && t.kind === (asset.kind === "audio" ? "audio" : "video") && canPlace(asset, t.kind)) ??
      tl.tracks.find((t) => !t.locked && canPlace(asset, t.kind));
    if (!track) return notify("error", `No unlocked track can hold ${asset.filename}.`);
    const end = tl.clips.filter((c) => c.trackId === track.id).reduce((m, c) => Math.max(m, clipEnd(c)), 0);
    apply("Append clip", [{ type: "clip.add", trackId: track.id, assetId: asset.id, start: end }]);
  };

  const split = () => {
    if (!tl) return;
    const locked = new Set(tl.tracks.filter((t) => t.locked).map((t) => t.id));
    const under = tl.clips.filter((c) => !locked.has(c.trackId) && c.start < playhead && playhead < clipEnd(c));
    const targets = selection.size ? under.filter((c) => selection.has(c.id)) : under;
    if (!targets.length) return notify("info", "Move the playhead inside a clip to split it.");
    apply("Split", targets.map((c) => ({ type: "clip.split" as const, clipId: c.id, frame: playhead })));
  };

  const remove = (ripple: boolean) => {
    if (!selection.size && selectedCaption) {
      apply("Delete caption", [{ type: "caption.delete", captionIds: [selectedCaption] }]);
      setSelectedCaption(null);
      return;
    }
    if (!selection.size) return;
    apply(ripple ? "Ripple delete" : "Delete", [{ type: "clip.delete", clipIds: Array.from(selection), ...(ripple ? { ripple } : {}) }]);
    setSelection(new Set());
  };

  // Keyboard: ⌘Z / ⇧⌘Z, S split, ⌫ delete, ⇧⌫ ripple, ←/→ frame (⇧ = 1s), Home/End.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e.target) || dialogOpen || !tl) return;
      const mod = e.metaKey || e.ctrlKey;
      const second = Math.round(fps.num / fps.den);
      if (mod && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) tl.history.canRedo && void editor.redo();
        else tl.history.canUndo && void editor.undo();
      } else if (mod) {
        return;
      } else if (e.key === " ") {
        e.preventDefault();
        if (tl.durationFrames > 0 && (previewMode === "live" || preview.url)) setPlaying((p) => !p);
      } else if (e.key === "s" || e.key === "S") {
        e.preventDefault();
        split();
      } else if (e.key === "Backspace" || e.key === "Delete") {
        e.preventDefault();
        remove(e.shiftKey);
      } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault();
        const d = (e.shiftKey ? second : 1) * (e.key === "ArrowLeft" ? -1 : 1);
        seek(Math.max(0, playhead + d));
      } else if (e.key === "Home") {
        seek(0);
      } else if (e.key === "End") {
        seek(tl.durationFrames);
      } else if (e.key === "Escape") {
        setSelection(new Set());
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // Library → timeline drag (pointer-based so it behaves the same in every webview).
  useEffect(() => {
    if (!assetDrag) return;
    const move = (e: PointerEvent) => setAssetDrag((d) => (d ? { ...d, x: e.clientX, y: e.clientY } : d));
    const up = (e: PointerEvent) => {
      const handled = dropHandler.current?.(assetDrag.asset, e.clientX, e.clientY);
      if (handled === false && document.elementFromPoint(e.clientX, e.clientY)?.closest(".rf-timeline")) {
        notify("error", `${assetDrag.asset.filename} can't go on that track.`);
      }
      setAssetDrag(null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up, { once: true });
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  }, [assetDrag?.asset.id]);

  // Files or folders dropped from Finder import into the open project; with none open, into a new one
  // named after what was dropped (dropping footage is how most people start).
  const dropIntoNewProject = async (paths: string[]) => {
    if (!client) return;
    const first = paths[0]!.split("/").filter(Boolean).pop() ?? "Untitled";
    const name = (first.replace(/\.[^.]+$/, "") || "Untitled").slice(0, 120);
    try {
      const p = await client.createProject({ name });
      const r = await client.importMedia(p.id, paths);
      await refresh(); // before selecting, see createProject
      selectProject(p.id);
      const failed = r.failed.length ? ` · ${r.failed.length} failed: ${r.failed.map((f) => `${f.path.split("/").pop()} (${f.error.message})`).join("; ")}` : "";
      notify(r.failed.length ? "error" : "info", `New project “${name}” · ${r.imported.length} imported${r.skipped ? ` · ${r.skipped} non-media skipped` : ""}${failed}`);
    } catch (e) {
      notify("error", e instanceof Error ? e.message : String(e));
    }
  };
  const dropRef = useRef((paths: string[]) => void (current ? doImport(paths) : dropIntoNewProject(paths)));
  dropRef.current = (paths: string[]) => void (current ? doImport(paths) : dropIntoNewProject(paths));
  useEffect(() => {
    let off: (() => void) | undefined;
    let gone = false;
    onFileDrop((paths) => dropRef.current(paths), setFileHover)
      .then((f) => (gone ? f() : (off = f)))
      .catch((e) => notify("error", `Drag and drop is unavailable: ${e instanceof Error ? e.message : String(e)}`));
    return () => {
      gone = true;
      off?.();
    };
  }, [notify]);

  if (bootError) {
    return (
      <div className="rf-boot" role="alert">
        <h1>ReelForge engine not reachable</h1>
        <p>{bootError}</p>
      </div>
    );
  }

  return (
    <div className={`rf-app${assetDrag ? " is-dragging-asset" : ""}`}>
      <TopBar
        projects={projects ?? []}
        current={current}
        offline={offline}
        loading={projects === null}
        busy={editor.busy}
        workspace={workspace}
        onWorkspace={setWorkspace}
        onSelectProject={selectProject}
        onNewProject={() => setDialogOpen(true)}
        onRename={renameProject}
        canUndo={!!tl?.history.canUndo}
        canRedo={!!tl?.history.canRedo}
        onUndo={() => void editor.undo()}
        onRedo={() => void editor.redo()}
        exporting={exports.active}
        onExport={() => void doExport()}
        onCancelExport={() => void exports.cancel()}
      />

      {projects !== null && !current ? (
        <Welcome onCreate={() => setDialogOpen(true)} />
      ) : workspace === "review" && current ? (
        <RenderQueue client={client} projectId={current.id} notify={notify} onExport={() => void doExport()} />
      ) : workspace === "automate" ? (
        <AutomationLab
          client={client}
          notify={notify}
          onOpenProject={(id) => {
            selectProject(id);
            setWorkspace("edit");
            void refresh();
          }}
        />
      ) : (
        <div className="rf-studio">
          <LeftRail active={rail} onChange={setRail} onSettings={() => setSettingsOpen(true)} />
          {rail === "media" ? (
            <MediaLibrary
              client={client}
              projectId={current?.id ?? null}
              fps={fps}
              assets={tl?.assets ?? []}
              importing={importing}
              dropHover={fileHover}
              onImport={() => void doImport()}
              onAppend={appendAsset}
              onRelink={(a) => void relink(a)}
              onDragStart={(asset, e) => setAssetDrag({ asset, x: e.clientX, y: e.clientY })}
              analyses={analyses.map}
              onAnalyze={(a, kinds) => void analyses.analyze(a.id, kinds)}
            />
          ) : rail === "text" && tl ? (
            <CaptionsPanel
              client={client}
              timeline={tl}
              analyses={analyses.map}
              notify={notify}
              selectedCaption={selectedCaption}
              onSelectCaption={setSelectedCaption}
              onSeek={seek}
              onApply={apply}
              onStyleDraft={(trackId, style) => setStyleDraft(style ? { trackId, style } : null)}
              onTimelineReplaced={() => void editor.reload()}
            />
          ) : rail === "audio" && tl ? (
            <AudioPanel
              timeline={tl}
              clip={selectedClip}
              analyses={analyses.map}
              snapToBeats={snapToBeats}
              onSnapToBeats={(v) => {
                setSnapToBeats(v);
                writePref("rf.snapBeats", v ? "1" : "0");
              }}
              onAnalyze={(a, kinds) => void analyses.analyze(a.id, kinds)}
            />
          ) : rail === "effects" && tl ? (
            <EffectsPanel
              timeline={tl}
              clip={selectedClip}
              playhead={playhead}
              onDraft={(props) => setDraft(props && selectedClip ? { clipId: selectedClip.id, props } : null)}
              onCommit={(props, label) => selectedClip && apply(label, [{ type: "clip.update", clipId: selectedClip.id, props }])}
            />
          ) : (
            <RailPlaceholder item={rail} />
          )}
          <Preview
            client={client}
            timeline={viewTimeline}
            mode={previewMode}
            onMode={(m) => {
              setPlaying(false);
              setPreviewMode(m);
              writePref("rf.previewMode", m);
            }}
            preview={preview}
            playhead={playhead}
            onPlayhead={(f) => (playing ? setPlayhead(f) : seek(f))}
            playing={playing}
            onPlaying={setPlaying}
            badge={proposed ? "Previewing AI plan (not applied)" : null}
          />
          <aside className="rf-panel rf-right" aria-label={rightTab === "inspector" ? "Inspector" : "AI Director"}>
            <RightPanelTabs tab={rightTab} onTab={setRightTab} hasClip={!!selectedClip} />
            {rightTab === "director" ? (
              <AIDirector
                client={client}
                timeline={tl}
                selection={Array.from(selection)}
                notify={notify}
                previewing={proposed ? previewProposal!.id : null}
                onPreview={(proposal) => {
                  setPreviewProposal(proposal);
                  if (proposal) setPreviewMode("live");
                }}
                onApplied={() => void editor.reload()}
                onOpenSettings={() => setSettingsOpen(true)}
              />
            ) : selectedClip && tl ? (
              <Inspector
                timeline={tl}
                clip={selectedClip}
                onDraft={(props) => setDraft(props ? { clipId: selectedClip.id, props } : null)}
                onCommit={(props, label) => apply(label, [{ type: "clip.update", clipId: selectedClip.id, props }])}
              />
            ) : (
              <div className="rf-empty">
                <p className="rf-empty-title">No clip selected</p>
                <p className="rf-empty-body">Select one clip on the timeline to adjust its transform, fades, transition or gain.</p>
              </div>
            )}
          </aside>
          <Timeline
            client={client}
            timeline={tl}
            selection={selection}
            onSelect={setSelection}
            playhead={playhead}
            onPlayhead={seek}
            onApply={apply}
            onSplit={split}
            onDelete={remove}
            registerDrop={(h) => {
              dropHandler.current = h;
            }}
            assetDragging={assetDrag?.asset ?? null}
            markers={markers}
            snapExtra={snapExtra}
            selectedCaption={selectedCaption}
            onSelectCaption={(id) => {
              setSelectedCaption(id);
              if (id) setRail("text");
            }}
          />
        </div>
      )}

      <footer className="rf-statusbar">
        {current ? (
          <>
            <span>{current.name}</span>
            <span className="rf-sep" />
            <span>{formatClock(tl?.durationFrames ?? 0, fps)}</span>
            <span className="rf-sep" />
            <span>
              {tl?.clips.length ?? 0} clip{tl?.clips.length === 1 ? "" : "s"}
            </span>
            <span className="rf-sep" />
            <span>{tl?.assets.length ?? 0} media</span>
            <span className="rf-sep" />
            <span>rev {current.revision}</span>
            <span className="rf-statusbar-right">
              {current.settings.width} × {current.settings.height} · {fps.den === 1 ? fps.num : (fps.num / fps.den).toFixed(2)} FPS
            </span>
          </>
        ) : (
          <span>{projects === null ? "Connecting to engine…" : "No project open"}</span>
        )}
      </footer>

      {assetDrag && (
        <div className="rf-drag-ghost" style={{ left: assetDrag.x + 12, top: assetDrag.y + 12 }} aria-hidden="true">
          {assetDrag.asset.filename}
        </div>
      )}
      {settingsOpen && <SettingsDialog client={client} projectId={current?.id ?? null} notify={notify} onClose={() => setSettingsOpen(false)} />}
      {dialogOpen && <NewProjectDialog onCancel={() => setDialogOpen(false)} onCreate={createProject} />}
      {toast && (
        <div key={toast.id} className={`rf-toast rf-toast-${toast.tone}`} role={toast.tone === "error" ? "alert" : "status"}>
          {toast.text}
          <button className="rf-icon-btn" onClick={() => setToast(null)} aria-label="Dismiss">
            <Icon name="x" size={14} />
          </button>
        </div>
      )}
    </div>
  );
}

