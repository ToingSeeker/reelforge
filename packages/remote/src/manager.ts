// Runs the phone remote inside the engine process (`reelforge serve`), the way ConnectorManager runs
// the Claude/ChatGPT connector. Settings → Phone remote drives it over the local API. The secret and
// relay URL live in <home>/remote/settings.json (0600); the secret never leaves this Mac except inside
// the pairing link/QR shown to the owner.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { ACTIVE_JOB_STATES, JobStore, ProjectStore, ProposalStore, ReelForgeError, type Database } from "@reelforge/core";
import { RemoteDaemon, type DaemonStatus, type RemoteJob, type RemoteProject, type RemoteState } from "./daemon.ts";
import { deriveKeys, newSecret } from "./keys.ts";

export interface RemoteSettings {
  /** The relay's origin, e.g. https://forge-remote-production.up.railway.app */
  url: string | null;
  /** Connect when the engine starts. Set by start(), cleared by stop(). */
  autoStart: boolean;
}

export interface RemoteStatus {
  state: "stopped" | "connecting" | "online" | "error";
  settings: RemoteSettings;
  /** The value to set as REELFORGE_REMOTE_AUTH on the relay. Reveals nothing about the secret. */
  relayAuth: string;
  /** Open on the phone (or scan as QR) to pair. Contains the secret after `#`, which browsers never send. Null until a URL is set. */
  pairingLink: string | null;
  error: string | null;
}

export interface RemoteManagerOptions {
  db: Database;
  /** State directory (settings.json). */
  dir: string;
  version: string;
  log?: (line: string) => void;
  /** Overrides for tests. */
  deviceName?: string;
  watchMs?: number;
}

interface Stored {
  url: string | null;
  autoStart: boolean;
  secret: string;
}

/** Most recent projects shown on the phone. */
const MAX_PROJECTS = 50;

export class RemoteManager {
  readonly #opts: RemoteManagerOptions;
  readonly #file: string;
  #daemon: RemoteDaemon | undefined;
  #error: string | null = null;

  constructor(opts: RemoteManagerOptions) {
    this.#opts = opts;
    this.#file = join(opts.dir, "settings.json");
  }

  #read(): Stored {
    let raw: Partial<Stored> = {};
    try {
      raw = JSON.parse(readFileSync(this.#file, "utf8")) as Partial<Stored>;
    } catch {
      // first run
    }
    const stored: Stored = {
      url: typeof raw.url === "string" && raw.url ? raw.url : null,
      autoStart: raw.autoStart === true,
      secret: typeof raw.secret === "string" && raw.secret.length >= 32 ? raw.secret : "",
    };
    if (!stored.secret) {
      stored.secret = newSecret();
      this.#write(stored);
    }
    return stored;
  }

  #write(s: Stored): void {
    mkdirSync(this.#opts.dir, { recursive: true, mode: 0o700 });
    writeFileSync(this.#file, JSON.stringify(s, null, 2), { mode: 0o600 });
  }

  status(): RemoteStatus {
    const s = this.#read();
    const d = this.#daemon?.status;
    const state: RemoteStatus["state"] = this.#daemon ? (d?.online ? "online" : "connecting") : this.#error ? "error" : "stopped";
    return {
      state,
      settings: { url: s.url, autoStart: s.autoStart },
      relayAuth: deriveKeys(s.secret).authHash,
      pairingLink: s.url ? `${s.url}/#k=${s.secret}` : null,
      error: this.#daemon ? (d?.error ?? null) : this.#error,
    };
  }

  /** Connect to the relay (optionally a new one). Remembers the URL and turns on auto-start. */
  async start(input: { url?: string | null } = {}): Promise<RemoteStatus> {
    const s = this.#read();
    const url = input.url === undefined || input.url === null ? s.url : normaliseUrl(input.url);
    if (!url) throw new ReelForgeError("VALIDATION_ERROR", "enter the relay's address first, e.g. https://forge-remote-production.up.railway.app");
    await this.#teardown();
    this.#error = null;
    this.#write({ ...s, url, autoStart: true });
    this.#launch(url, s.secret);
    return this.status();
  }

  /** Start if the user left it on. Never throws. */
  async autoStart(): Promise<void> {
    const s = this.#read();
    if (!s.autoStart || !s.url) return;
    await this.start().catch((e) => this.#opts.log?.(`auto-start failed: ${e instanceof Error ? e.message : e}`));
  }

  async stop(): Promise<RemoteStatus> {
    await this.#teardown();
    this.#error = null;
    this.#write({ ...this.#read(), autoStart: false });
    return this.status();
  }

  /**
   * New secret: every paired phone stops working, and the relay needs the new REELFORGE_REMOTE_AUTH
   * before this Mac can connect again.
   */
  async rotate(): Promise<RemoteStatus> {
    const s = this.#read();
    const wasRunning = !!this.#daemon;
    await this.#teardown();
    const next = { ...s, secret: newSecret() };
    this.#write(next);
    if (wasRunning && next.url) this.#launch(next.url, next.secret);
    return this.status();
  }

  /** For process shutdown: disconnect without touching auto-start. */
  async close(): Promise<void> {
    await this.#teardown();
  }

  /** What the phone sees. Public so tests (and later stages) can check it directly. */
  state(): RemoteState {
    const projectStore = new ProjectStore(this.#opts.db);
    const jobStore = new JobStore(this.#opts.db);
    const proposalStore = new ProposalStore(this.#opts.db);
    const projects: RemoteProject[] = [];
    const jobs: RemoteJob[] = [];
    for (const p of projectStore.list().slice(0, MAX_PROJECTS)) {
      projects.push({
        id: p.id,
        name: p.name,
        revision: p.revision,
        width: p.settings.width,
        height: p.settings.height,
        fps: Math.round((p.settings.fps.num / p.settings.fps.den) * 100) / 100,
        updatedAt: p.updatedAt,
        pendingProposals: proposalStore.list(p.id, 50).filter((x) => x.status === "pending").length,
      });
      for (const j of jobStore.list(p.id, { limit: 20 })) {
        if (!ACTIVE_JOB_STATES.includes(j.state)) continue;
        jobs.push({ id: j.id, projectId: j.projectId, kind: j.kind, state: j.state, progress: Math.round(j.progress * 1000) / 1000, createdAt: j.createdAt });
      }
    }
    return { projects, jobs };
  }

  #launch(url: string, secret: string): void {
    const daemon = new RemoteDaemon({
      url,
      secret,
      device: { name: this.#opts.deviceName ?? hostname().replace(/\.local$/, ""), version: this.#opts.version },
      state: () => this.state(),
      watchMs: this.#opts.watchMs ?? 2000,
      ...(this.#opts.log ? { log: this.#opts.log } : {}),
      onStatus: (st: DaemonStatus) => {
        // A wrong auth value won't fix itself: drop the daemon and show why.
        if (st.fatal && this.#daemon === daemon) {
          this.#daemon = undefined;
          this.#error = st.error;
        }
      },
    });
    this.#daemon = daemon;
    daemon.start();
  }

  async #teardown(): Promise<void> {
    const d = this.#daemon;
    this.#daemon = undefined;
    await d?.stop();
  }
}

/** https origins only, except plain http to this machine (local testing). */
export function normaliseUrl(input: string): string {
  const raw = input.trim().replace(/\/+$/, "");
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new ReelForgeError("VALIDATION_ERROR", "the relay address must be a URL like https://forge-remote-production.up.railway.app");
  }
  const local = u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1");
  if ((u.protocol !== "https:" && !local) || u.pathname !== "/" || u.search || u.hash || u.username || u.password) {
    throw new ReelForgeError("VALIDATION_ERROR", "the relay address must be an https origin (no path), e.g. https://forge-remote-production.up.railway.app");
  }
  return u.origin;
}
