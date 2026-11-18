// The Mac side of the phone remote. Only outgoing connections: it keeps GET /agent/stream open to the
// relay for commands from the phone, and posts encrypted events to /agent/events. Nothing listens on
// this machine.
//
// Commands are a whitelist (`switch` below), never a proxy: the phone names projects and jobs by id
// and never sends a path.

import { randomBytes } from "node:crypto";
import { deriveKeys, seal, unseal, type RemoteKeys } from "./keys.ts";

/** A command older or newer than this (by the Mac's clock) is refused, as is any id seen before. */
export const COMMAND_MAX_AGE_MS = 5 * 60 * 1000;
const OUTBOX_MAX = 500;
const BATCH = 50;
/** Project ids are UUIDs; anything else from the phone is refused before it reaches a store. */
const PROJECT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface RemoteProject {
  id: string;
  name: string;
  revision: number;
  width: number;
  height: number;
  fps: number;
  updatedAt: string;
  /** AI proposals waiting for a decision. */
  pendingProposals: number;
}

export interface RemoteJob {
  id: string;
  projectId: string;
  kind: "export" | "preview";
  state: string;
  progress: number;
  createdAt: string;
}

/** An export that ended recently (Home shows it; it also drives notifications). */
export interface RemoteFinishedJob {
  id: string;
  projectId: string;
  kind: "export" | "preview";
  state: "completed" | "failed" | "cancelled";
  error: string | null;
  finishedAt: string;
  sizeBytes: number | null;
}

/** What the phone is shown; built fresh from the engine's stores each time. */
export interface RemoteState {
  projects: RemoteProject[];
  /** Jobs still running or waiting. */
  jobs: RemoteJob[];
  /** Exports that finished in the last day, newest first. */
  recent: RemoteFinishedJob[];
}

/** One project opened on the phone: enough to draw the poster and a compact, read-only timeline. */
export interface RemoteProjectDetail {
  id: string;
  name: string;
  revision: number;
  width: number;
  height: number;
  fps: number;
  updatedAt: string;
  durationFrames: number;
  canUndo: boolean;
  canRedo: boolean;
  /** Top track first. Clip positions in project frames. */
  tracks: { kind: string; name: string; muted: boolean; hidden: boolean; clips: { start: number; duration: number }[] }[];
  clips: number;
  captions: number;
  assets: { video: number; audio: number; image: number; offline: number };
  proposals: { id: string; status: string; instruction: string; summary: string; changes: number; provider: string; model: string; createdAt: string }[];
  jobs: { id: string; kind: string; state: string; progress: number; error: string | null; createdAt: string; finishedAt: string | null; sizeBytes: number | null }[];
}

export interface RemotePoster {
  /** Changes when the picture does; the phone keeps the image under it. */
  key: string;
  type: "image/jpeg" | "image/png";
  data: Buffer;
}

/** Notification choices for one phone. */
export interface PushPrefs {
  exports: boolean;
  proposals: boolean;
  failures: boolean;
}

export interface PushSubscribeInput {
  endpoint: unknown;
  keys: unknown;
  prefs: unknown;
}

/** What the daemon may do for the phone beyond reading state. Each one is a named command, never a passthrough. */
export interface RemoteHandlers {
  project?(projectId: string): RemoteProjectDetail;
  poster?(projectId: string): Promise<RemotePoster | null>;
  push?: {
    publicKey(): string;
    subscribe(input: PushSubscribeInput): PushPrefs;
    unsubscribe(endpoint: unknown): void;
    test(endpoint: unknown): Promise<void>;
  };
}

export interface RemoteDevice {
  name: string;
  version: string;
}

export interface DaemonStatus {
  /** The command stream to the relay is open. */
  online: boolean;
  /** Why it isn't (last failure), or null. */
  error: string | null;
  /** True when retrying won't help (wrong auth value, locked out). */
  fatal: boolean;
}

export interface RemoteDaemonOptions {
  url: string;
  secret: string;
  device: RemoteDevice;
  state: () => RemoteState;
  handlers?: RemoteHandlers;
  log?: (line: string) => void;
  onStatus?: (s: DaemonStatus) => void;
  /** How often the state is compared with what the phone last got. Default 2 s. */
  watchMs?: number;
}

interface Sealed {
  c: string;
  snapshot: boolean;
}

export class RemoteDaemon {
  readonly #opts: RemoteDaemonOptions;
  readonly #url: string;
  readonly #keys: RemoteKeys;
  #outbox: Sealed[] = [];
  #sending = false;
  #running = false;
  #stream: AbortController | undefined;
  /** Aborted by stop(), so a reconnect wait ends at once. */
  #stopper = new AbortController();
  #loop: Promise<void> | undefined;
  #watch: ReturnType<typeof setInterval> | undefined;
  #seen = new Set<string>();
  /** What the phone last got: everything but the running jobs, and the running jobs. */
  #lastState = "";
  #lastJobs = "";
  #status: DaemonStatus = { online: false, error: null, fatal: false };

  constructor(opts: RemoteDaemonOptions) {
    this.#opts = opts;
    this.#url = opts.url.replace(/\/+$/, "");
    this.#keys = deriveKeys(opts.secret);
  }

  get status(): DaemonStatus {
    return this.#status;
  }

  #setStatus(s: Partial<DaemonStatus>): void {
    this.#status = { ...this.#status, ...s };
    this.#opts.onStatus?.(this.#status);
  }

  #headers(): Record<string, string> {
    return { authorization: `Bearer ${this.#keys.token}`, "content-type": "application/json" };
  }

  snapshot(): Record<string, unknown> {
    const state = this.#opts.state();
    this.#remember(state);
    const pushKey = this.#opts.handlers?.push?.publicKey() ?? null;
    return { t: "snapshot", device: { ...this.#opts.device, at: Date.now() }, pushKey, ...state };
  }

  #remember(state: RemoteState): void {
    const { jobs, ...rest } = state;
    this.#lastState = JSON.stringify(rest);
    this.#lastJobs = JSON.stringify(jobs);
  }

  /** Called on a timer: a full snapshot when projects change, a small `jobs` event when only progress moved. */
  #watchTick(): void {
    const state = this.#opts.state();
    const { jobs, ...rest } = state;
    if (JSON.stringify(rest) !== this.#lastState) return this.#sendSnapshot();
    const j = JSON.stringify(jobs);
    if (j === this.#lastJobs) return;
    this.#lastJobs = j;
    this.send({ t: "jobs", jobs });
  }

  /** Puts one sealed file on the relay for the phone to fetch once; returns its id. */
  async #putBlob(value: Record<string, unknown>): Promise<string> {
    const id = randomBytes(18).toString("base64url");
    const res = await fetch(`${this.#url}/agent/blob`, {
      method: "POST",
      headers: this.#headers(),
      body: JSON.stringify({ id, c: seal(this.#keys.key, value) }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`the relay refused the file (HTTP ${res.status})`);
    return id;
  }

  /** Queue one event for the phone. A snapshot replaces everything still waiting (it contains it). */
  send(event: Record<string, unknown>, { snapshot = false } = {}): void {
    if (snapshot) this.#outbox = [];
    this.#outbox.push({ c: seal(this.#keys.key, event), snapshot });
    void this.#drain();
  }

  #sendSnapshot(): void {
    this.send(this.snapshot(), { snapshot: true });
  }

  async #drain(): Promise<void> {
    if (this.#sending) return;
    this.#sending = true;
    let failing = false;
    try {
      while (this.#outbox.length && this.#running) {
        const batch = this.#outbox.slice(0, BATCH);
        try {
          const res = await fetch(`${this.#url}/agent/events`, {
            method: "POST",
            headers: this.#headers(),
            body: JSON.stringify({ events: batch }),
            signal: AbortSignal.timeout(20_000),
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          // Exactly what was sent: a snapshot may have replaced the queue meanwhile.
          const sent = new Set(batch);
          this.#outbox = this.#outbox.filter((e) => !sent.has(e));
          failing = false;
        } catch (e) {
          if (!failing) this.#opts.log?.(`relay: couldn't send (${errText(e)}), retrying`);
          failing = true;
          if (this.#outbox.length > OUTBOX_MAX) this.#outbox = [];
          await sleep(3000, this.#stopper.signal);
          // Whatever piled up is replaced by one snapshot once the relay answers again.
          if (this.#running && !this.#outbox.some((e) => e.snapshot)) this.#outbox = [{ c: seal(this.#keys.key, this.snapshot()), snapshot: true }];
        }
      }
    } finally {
      this.#sending = false;
    }
  }

  async #command(sealed: unknown): Promise<void> {
    if (typeof sealed !== "string") return;
    let cmd: { id?: unknown; at?: unknown; type?: unknown; [field: string]: unknown };
    try {
      cmd = unseal(this.#keys.key, sealed) as typeof cmd;
    } catch {
      this.#opts.log?.("ignored a command not sealed with this Mac's key");
      return;
    }
    // A captured command must not work again later, or twice.
    if (typeof cmd?.id !== "string" || this.#seen.has(cmd.id) || !(Math.abs(Date.now() - Number(cmd.at)) <= COMMAND_MAX_AGE_MS)) {
      this.#opts.log?.("ignored a stale or repeated command");
      return;
    }
    this.#seen.add(cmd.id);
    if (this.#seen.size > 2000) this.#seen = new Set([...this.#seen].slice(-1000));
    const h = this.#opts.handlers ?? {};
    const id = cmd.id;
    try {
      switch (cmd.type) {
        case "sync":
          return this.#sendSnapshot();
        case "ping":
          return this.send({ t: "pong", id, at: Date.now() });
        case "project.open": {
          if (!h.project) break;
          return this.send({ t: "project", id, project: h.project(projectIdOf(cmd)) });
        }
        case "poster": {
          if (!h.poster) break;
          const projectId = projectIdOf(cmd);
          const poster = await h.poster(projectId);
          if (!poster) return this.send({ t: "poster", id, projectId, key: null, blob: null });
          const blob = await this.#putBlob({ type: poster.type, data: poster.data.toString("base64") });
          return this.send({ t: "poster", id, projectId, key: poster.key, blob });
        }
        case "push.subscribe": {
          if (!h.push) break;
          const prefs = h.push.subscribe({ endpoint: cmd.endpoint, keys: cmd.keys, prefs: cmd.prefs });
          return this.send({ t: "push", id, subscribed: true, prefs });
        }
        case "push.unsubscribe": {
          if (!h.push) break;
          h.push.unsubscribe(cmd.endpoint);
          return this.send({ t: "push", id, subscribed: false });
        }
        case "push.test": {
          if (!h.push) break;
          await h.push.test(cmd.endpoint);
          return this.send({ t: "push", id, tested: true });
        }
      }
      return this.send({ t: "error", id, message: `Unknown command: ${String(cmd.type).slice(0, 40)}` });
    } catch (e) {
      this.send({ t: "error", id, message: errText(e) });
    }
  }

  /** Starts the connection loop; resolves once the loop is running (not once connected). */
  start(): void {
    if (this.#running) return;
    this.#running = true;
    this.#stopper = new AbortController();
    // Changes made on the Mac (or by another client) reach the phone without it asking.
    this.#watch = setInterval(() => {
      if (!this.#status.online) return;
      try {
        this.#watchTick();
      } catch (e) {
        this.#opts.log?.(`couldn't read the engine state: ${errText(e)}`);
      }
    }, this.#opts.watchMs ?? 2000);
    this.#loop = this.#run();
  }

  async #run(): Promise<void> {
    let wait = 1000;
    while (this.#running) {
      this.#stream = new AbortController();
      try {
        const res = await fetch(`${this.#url}/agent/stream`, { headers: this.#headers(), signal: this.#stream.signal });
        if (res.status === 401) throw new FatalError("The relay refused this Mac. Set REELFORGE_REMOTE_AUTH on the relay to the value shown in Settings → Phone remote.");
        if (res.status === 429) throw new FatalError("The relay locked this address out after wrong attempts. Wait 15 minutes, then start again.");
        if (!res.ok || !res.body) throw new Error(`relay answered HTTP ${res.status}`);
        wait = 1000;
        this.#setStatus({ online: true, error: null, fatal: false });
        this.#opts.log?.("connected to the relay");
        this.#sendSnapshot();
        let buffer = "";
        const decoder = new TextDecoder();
        for await (const chunk of res.body as AsyncIterable<Uint8Array>) {
          buffer += decoder.decode(chunk, { stream: true });
          let end: number;
          while ((end = buffer.indexOf("\n\n")) >= 0) {
            const block = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            const data = /^data: (.*)$/m.exec(block)?.[1];
            if (/^event: command$/m.test(block) && data) {
              try {
                await this.#command((JSON.parse(data) as { c?: unknown }).c);
              } catch {
                // not JSON: ignore
              }
            }
          }
        }
        throw new Error("the connection closed");
      } catch (e) {
        if (!this.#running) break;
        this.#setStatus({ online: false, error: errText(e), fatal: e instanceof FatalError });
        if (e instanceof FatalError) {
          this.#opts.log?.(e.message);
          this.#running = false;
          break;
        }
        this.#opts.log?.(`relay: ${errText(e)}, reconnecting in ${Math.round(wait / 1000)}s`);
        await sleep(wait, this.#stopper.signal);
        wait = Math.min(wait * 2, 30_000);
      }
    }
    clearInterval(this.#watch);
  }

  async stop(): Promise<void> {
    this.#running = false;
    clearInterval(this.#watch);
    this.#stopper.abort();
    this.#stream?.abort();
    await this.#loop;
    this.#loop = undefined;
    this.#setStatus({ online: false });
  }
}

class FatalError extends Error {}

function projectIdOf(cmd: Record<string, unknown>): string {
  if (typeof cmd.projectId !== "string" || !PROJECT_ID.test(cmd.projectId)) throw new Error("That project id isn't valid.");
  return cmd.projectId;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done);
  });
}

function errText(e: unknown): string {
  if (e instanceof Error) {
    const code = (e.cause as { code?: string } | undefined)?.code;
    return code ?? e.message;
  }
  return String(e);
}
