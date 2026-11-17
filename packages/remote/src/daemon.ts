// The Mac side of the phone remote. Only outgoing connections: it keeps GET /agent/stream open to the
// relay for commands from the phone, and posts encrypted events to /agent/events. Nothing listens on
// this machine.
//
// Commands are a whitelist (`switch` below), never a proxy: the phone names projects and jobs by id
// and never sends a path.

import { deriveKeys, seal, unseal, type RemoteKeys } from "./keys.ts";

/** A command older or newer than this (by the Mac's clock) is refused, as is any id seen before. */
export const COMMAND_MAX_AGE_MS = 5 * 60 * 1000;
const OUTBOX_MAX = 500;
const BATCH = 50;

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

/** What the phone is shown; built fresh from the engine's stores each time. */
export interface RemoteState {
  projects: RemoteProject[];
  /** Jobs still running or waiting. */
  jobs: RemoteJob[];
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
  #lastState = "";
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
    this.#lastState = JSON.stringify(state);
    return { t: "snapshot", device: { ...this.#opts.device, at: Date.now() }, ...state };
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
    let cmd: { id?: unknown; at?: unknown; type?: unknown };
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
    try {
      switch (cmd.type) {
        case "sync":
          return this.#sendSnapshot();
        case "ping":
          return this.send({ t: "pong", id: cmd.id, at: Date.now() });
        default:
          return this.send({ t: "error", id: cmd.id, message: `Unknown command: ${String(cmd.type).slice(0, 40)}` });
      }
    } catch (e) {
      this.send({ t: "error", id: cmd.id, message: errText(e) });
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
        if (JSON.stringify(this.#opts.state()) !== this.#lastState) this.#sendSnapshot();
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
