import { homedir, platform } from "node:os";
import { join, resolve } from "node:path";
import { chmodSync, mkdirSync } from "node:fs";

export const DB_FILENAME = "reelforge.db";

function appDataDir(env: NodeJS.ProcessEnv): string {
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

/**
 * Where local state lives. REELFORGE_HOME wins so tests, CI and the desktop
 * sidecar can all point at one explicit workspace.
 */
export function resolveHome(env: NodeJS.ProcessEnv = process.env): string {
  if (env.REELFORGE_HOME) return resolve(env.REELFORGE_HOME);
  return appDataDir(env);
}

/**
 * AI models are large and shared by every workspace, so they live in the
 * app-data folder even when REELFORGE_HOME points elsewhere (tests, CI).
 */
export function resolveModelsDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.REELFORGE_MODELS ? resolve(env.REELFORGE_MODELS) : join(appDataDir(env), "models");
}

export function ensureHome(dir: string): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export function resolveDbPath(env: NodeJS.ProcessEnv = process.env): string {
  const home = ensureHome(resolveHome(env));
  // Our own app-data folder is private even if it existed with looser permissions. A REELFORGE_HOME the
  // user chose is theirs: we don't change its mode.
  if (!env.REELFORGE_HOME) chmodSync(home, 0o700);
  return join(home, DB_FILENAME);
}

/** Derived, disposable data (thumbnails, later proxies). Safe to delete. */
export function resolveCacheDir(env: NodeJS.ProcessEnv = process.env): string {
  return ensureHome(join(resolveHome(env), "cache"));
}
