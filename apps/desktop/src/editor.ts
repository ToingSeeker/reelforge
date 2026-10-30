import { useCallback, useEffect, useRef, useState } from "react";
import type { Asset, Timeline, TimelineOp } from "@reelforge/core/schema";
import { ApiError, type Client } from "./api.ts";

export type Notify = (tone: "info" | "error", text: string) => void;

/**
 * Timeline state for one project. Edits run through a queue so each one is
 * sent with the revision the previous one produced; a conflict (someone else
 * edited) reloads instead of overwriting (FR-016).
 */
export function useEditor(client: Client | null, projectId: string | null, notify: Notify) {
  const [timeline, setTimeline] = useState<Timeline | null>(null);
  const [busy, setBusy] = useState(false);
  const latest = useRef<Timeline | null>(null);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const pending = useRef(0);

  const set = (t: Timeline | null) => {
    latest.current = t;
    setTimeline(t);
  };

  const reload = useCallback(async () => {
    if (!client || !projectId) return set(null);
    try {
      const t = await client.timeline(projectId);
      if (t.project.id === projectId) set(t);
    } catch (e) {
      notify("error", e instanceof Error ? e.message : String(e));
    }
  }, [client, projectId, notify]);

  useEffect(() => {
    set(null);
    void reload();
  }, [reload]);

  const run = useCallback(
    (label: string, fn: (t: Timeline) => Promise<Timeline>) => {
      if (!client) return Promise.resolve();
      pending.current++;
      setBusy(true);
      const job = queue.current.then(async () => {
        const t = latest.current;
        if (!t) return;
        try {
          set(await fn(t));
        } catch (e) {
          if (e instanceof ApiError && e.code === "REVISION_CONFLICT") {
            notify("error", `This project changed elsewhere, so “${label}” was not applied. Showing the latest version.`);
          } else {
            notify("error", e instanceof Error ? e.message.replace(/^operation 1 \([a-z.]+\): /, "") : String(e));
          }
          await reload();
        } finally {
          if (--pending.current === 0) setBusy(false);
        }
      });
      queue.current = job;
      return job;
    },
    [client, notify, reload],
  );

  const apply = useCallback(
    (label: string, ops: TimelineOp[]) => run(label, (t) => client!.apply(t.project.id, t.project.revision, ops)),
    [client, run],
  );
  const undo = useCallback(() => run("Undo", (t) => client!.undo(t.project.id, t.project.revision)), [client, run]);
  const redo = useCallback(() => run("Redo", (t) => client!.redo(t.project.id, t.project.revision)), [client, run]);

  const importPaths = useCallback(
    async (paths: string[]) => {
      if (!client || !projectId || !paths.length) return;
      try {
        const r = await client.importMedia(projectId, paths);
        const parts = [`${r.imported.length} imported`];
        if (r.existing.length) parts.push(`${r.existing.length} already in project`);
        if (r.skipped) parts.push(`${r.skipped} non-media item${r.skipped === 1 ? "" : "s"} skipped`);
        if (r.failed.length) parts.push(`${r.failed.length} failed: ${r.failed.map((f) => `${f.path.split("/").pop()} (${f.error.message})`).join("; ")}`);
        notify(r.failed.length ? "error" : "info", parts.join(" · "));
      } catch (e) {
        notify("error", e instanceof Error ? e.message : String(e));
      }
      await reload();
    },
    [client, projectId, notify, reload],
  );

  const relink = useCallback(
    async (asset: Asset, path: string) => {
      if (!client || !projectId) return;
      try {
        await client.relink(projectId, asset.id, path);
        notify("info", `Relinked ${asset.filename}`);
      } catch (e) {
        notify("error", e instanceof Error ? e.message : String(e));
      }
      await reload();
    },
    [client, projectId, notify, reload],
  );

  /** Called by the poller: pick up edits made by the CLI / MCP / another window. */
  const syncRevision = useCallback(
    (revision: number) => {
      if (pending.current === 0 && latest.current && latest.current.project.revision !== revision) void reload();
    },
    [reload],
  );

  return { timeline, busy, apply, undo, redo, importPaths, relink, reload, syncRevision };
}

export type Editor = ReturnType<typeof useEditor>;

/** Thumbnail URL for an asset (streamed directly; the token rides in the query). Null when offline. */
export function useThumbnail(client: Client | null, projectId: string, asset: Asset | undefined): string | null {
  if (!client || !asset || asset.status === "missing" || !projectId) return null;
  // sizeBytes busts the browser cache when a file is relinked or changes.
  return `${client.thumbnailUrl(projectId, asset.id)}&v=${asset.sizeBytes}`;
}
