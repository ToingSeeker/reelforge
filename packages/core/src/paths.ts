import { homedir, platform } from "node:os";
import { join, resolve } from "node:path";
import { mkdirSync } from "node:fs";

export const DB_FILENAME = "reelforge.db";

/**
 * Where local state lives. REELFORGE_HOME wins so tests, CI and the desktop
 * sidecar can all point at one explicit workspace.
 */
export function resolveHome(env: NodeJS.ProcessEnv = process.env): string {
  if (env.REELFORGE_HOME) return resolve(env.REELFORGE_HOME);
  const home = homedir();
  switch (platform()) {
    case "darwin":
      return join(home, "Library", "Application Support", "ReelForge");
    case "win32":
      return join(env.APPDATA ?? join(home, "AppData", "Roaming"), "ReelForge");
    default:
      return join(env.XDG_DATA_HOME ?? join(home, ".local", "share"), "reelforge");
  }
}

export function ensureHome(dir: string): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export function resolveDbPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(ensureHome(resolveHome(env)), DB_FILENAME);
}

/** Derived, disposable data (thumbnails, later proxies). Safe to delete. */
export function resolveCacheDir(env: NodeJS.ProcessEnv = process.env): string {
  return ensureHome(join(resolveHome(env), "cache"));
}
