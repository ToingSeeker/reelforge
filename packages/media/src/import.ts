import { AssetStore, isReelForgeError, type Actor, type Asset, type Database, type ErrorCode } from "@reelforge/core";
import { readdirSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { probeFile, resolveSource, SUPPORTED_EXTENSIONS } from "./probe.ts";

export interface ImportFailure {
  path: string;
  error: { code: ErrorCode; message: string };
}

export interface ImportResult {
  imported: Asset[];
  /** Paths that were already in the project; their existing asset is returned. */
  existing: Asset[];
  failed: ImportFailure[];
}

export const MAX_IMPORT_BATCH = 200;

/**
 * Import files into a project. Each file is validated and probed on its own,
 * so one corrupted file doesn't sink the batch; every failure is reported with
 * a reason the user can act on (FR-013).
 */
export async function importMedia(db: Database, projectId: string, paths: string[], actor: Actor): Promise<ImportResult> {
  const store = new AssetStore(db);
  store.list(projectId); // NOT_FOUND / VALIDATION_ERROR for a bad project before touching any file
  const result: ImportResult = { imported: [], existing: [], failed: [] };
  for (const path of paths.slice(0, MAX_IMPORT_BATCH)) {
    try {
      const file = resolveSource(path);
      const probe = await probeFile(file);
      const { asset, created } = store.add(projectId, file, probe, actor);
      (created ? result.imported : result.existing).push(asset);
    } catch (e) {
      if (!isReelForgeError(e) || e.code === "UNAVAILABLE") throw e; // environment problems abort the batch
      result.failed.push({ path, error: { code: e.code, message: e.message } });
    }
  }
  for (const path of paths.slice(MAX_IMPORT_BATCH)) {
    result.failed.push({ path, error: { code: "VALIDATION_ERROR", message: `at most ${MAX_IMPORT_BATCH} files per import` } });
  }
  return result;
}

/**
 * Folders the user dropped or picked become the media files directly inside them (not subfolders,
 * not hidden files); other entries are only counted. For the person's own actions (desktop, REST):
 * MCP imports never take folders, so a client can't use import to list a directory.
 */
export function expandFolders(paths: string[]): { paths: string[]; skipped: number } {
  let skipped = 0;
  const out: string[] = [];
  for (const p of paths) {
    let dir = false;
    try {
      dir = statSync(p).isDirectory();
    } catch {
      // not there: importMedia reports it
    }
    if (!dir) {
      out.push(p);
      continue;
    }
    for (const name of readdirSync(p).sort()) {
      const full = join(p, name);
      let file = false;
      try {
        file = statSync(full).isFile();
      } catch {
        // dangling link
      }
      if (file && !name.startsWith(".") && extname(name).toLowerCase() in SUPPORTED_EXTENSIONS) out.push(full);
      else skipped++;
    }
  }
  return { paths: out, skipped };
}

export async function relinkMedia(db: Database, projectId: string, assetId: string, path: string, actor: Actor): Promise<Asset> {
  const store = new AssetStore(db);
  store.get(projectId, assetId);
  const file = resolveSource(path);
  const probe = await probeFile(file);
  return store.relink(projectId, assetId, file, probe, actor);
}
