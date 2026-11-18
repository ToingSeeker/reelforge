// The Mac side of the phone remote's transport. Only outgoing connections: it keeps GET /agent/stream open
// to the relay (commands, queued instructions, pairing requests arrive there) and posts sealed events to
// /agent/events. Nothing listens on this machine.
//
// This file knows how to talk to the relay and how to seal and open messages; what a command *does* is the
// manager's business (manager.ts): the daemon hands it already-opened, de-duplicated commands.

import { createReadStream, type WriteStream } from "node:fs";
import { randomBytes } from "node:crypto";
import { seal, sealBytes, unseal, unsealBytes } from "./keys.ts";

/** A command older or newer than this (by the Mac's clock) is refused, as is any id seen before. */
export const COMMAND_MAX_AGE_MS = 5 * 60 * 1000;
/** Raw bytes per file piece (sealed and base64'd it stays well under the relay's 4 MB body limit). */
export const PIECE_BYTES = 1024 * 1024;
const OUTBOX_MAX = 500;
const BATCH = 50;
const STUCK_MS = 120_000;

/** Ids of commands and queued instructions already handled, kept across restarts (manager.ts stores it). */
export interface HandledIds {
  has(id: string): boolean;
  add(id: string, keepUntil: number): void;
}

export interface KeyRing {
  /** This Mac's relay token. */
  agentToken: string;
  /** Seals events every paired phone may read. */
  broadcastKey(): Buffer;
  /** Null for a device that isn't paired (or was revoked). */
  deviceKey(deviceId: string): Buffer | null;
  /** What the relay may let in. */
  devices(): { id: string; tokenHash: string }[];
}

/** A command as the phone sent it, opened and checked. */
export interface RemoteCommand {
  id: string;
  at: number;
  type: string;
  [field: string]: unknown;
}

/** A queued instruction, opened and checked. */
export interface QueuedInstruction {
  id: string;
  deviceId: string;
  projectId: string;
  createdAt: number;
  expiresAt: number;
  body: Record<string, unknown>;
}

export interface DaemonStatus {
  /** The command stream to the relay is open. */
  online: boolean;
  /** Why it isn't (last failure), or null. */
  error: string | null;
  /** True when retrying won't help (wrong auth value). */
  fatal: boolean;
  /** When the stream was last open (ms), or null. */
  lastConnected: number | null;
}

export interface RemoteDaemonOptions {
  url: string;
  keys: KeyRing;
  handled: HandledIds;
  /** The snapshot body (projects, jobs, …): compared every watchMs, sent again when it changes. */
  state: () => Record<string, unknown>;
  /** Fields of the snapshot that change often and small (job progress): sent as `{t:"jobs"}` alone. */
  liveKey?: string;
  onCommand(deviceId: string, cmd: RemoteCommand): Promise<void>;
  onQueued(item: QueuedInstruction): Promise<void>;
  onPair(lookup: string, hello: unknown): Promise<void>;
  /** Called after each (re)connection, once the stream is open. */
  onConnected?(): void;
  log?: (line: string) => void;
  onStatus?: (s: DaemonStatus) => void;
  watchMs?: number;
}

interface Outgoing {
  c: string;
  snapshot: boolean;
  to?: string;
}

export class RemoteDaemon {
  readonly #opts: RemoteDaemonOptions;
  readonly #url: string;
  #outbox: Outgoing[] = [];
  #sending = false;
  #running = false;
  #stream: AbortController | undefined;
  /** Aborted by stop(), so waits end at once. */
  #stopper = new AbortController();
  #loop: Promise<void> | undefined;
  #watch: ReturnType<typeof setInterval> | undefined;
  #lastState = "";
  #lastLive = "";
  #status: DaemonStatus = { online: false, error: null, fatal: false, lastConnected: null };
  /** Queued instructions being looked at, so a repeated `queue` event doesn't start one twice. */
  #taking = new Set<string>();
  /** Running file transfers (to the phone), by transfer id: false once cancelled. */
  #transfers = new Map<string, { cancelled: boolean }>();

  constructor(opts: RemoteDaemonOptions) {
    this.#opts = opts;
    this.#url = opts.url.replace(/\/+$/, "");
  }

  get status(): DaemonStatus {
    return this.#status;
  }

  #setStatus(s: Partial<DaemonStatus>): void {
    this.#status = { ...this.#status, ...s };
    this.#opts.onStatus?.(this.#status);
  }

  #headers(): Record<string, string> {
    return { authorization: `Bearer ${this.#opts.keys.agentToken}`, "content-type": "application/json" };
  }

  async #post(path: string, body: unknown, method = "POST"): Promise<Response> {
    return fetch(`${this.#url}${path}`, { method, headers: this.#headers(), body: method === "DELETE" ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
  }

  // ── events to the phones ─────────────────────────────────────────────────

  /** Queue one event for every paired phone. A snapshot replaces broadcasts still waiting (it contains them). */
  broadcast(event: Record<string, unknown>, { snapshot = false } = {}): void {
    if (snapshot) this.#outbox = this.#outbox.filter((e) => e.to);
    this.#outbox.push({ c: seal(this.#opts.keys.broadcastKey(), event, "evt"), snapshot });
    void this.#drain();
  }

  /** Queue one event only `deviceId` can open (answers to its commands, its new broadcast key, …). */
  sendTo(deviceId: string, event: Record<string, unknown>): void {
    const key = this.#opts.keys.deviceKey(deviceId);
    if (!key) return;
    this.#outbox.push({ c: seal(key, event, `evt:${deviceId}`), snapshot: false, to: deviceId });
    void this.#drain();
  }

  /** Waits (up to `ms`) until everything queued has reached the relay. */
  async flush(ms = 3000): Promise<void> {
    const end = Date.now() + ms;
    while ((this.#outbox.length || this.#sending) && Date.now() < end && this.#running) await sleep(50, this.#stopper.signal);
  }

  snapshotEvent(): Record<string, unknown> {
    const state = this.#opts.state();
    this.#remember(state);
    return { t: "snapshot", at: Date.now(), ...state };
  }

  sendSnapshot(): void {
    this.broadcast(this.snapshotEvent(), { snapshot: true });
  }

  #remember(state: Record<string, unknown>): void {
    const live = this.#opts.liveKey;
    const { [live ?? ""]: liveValue, ...rest } = state;
    this.#lastState = JSON.stringify(rest);
    this.#lastLive = JSON.stringify(liveValue ?? null);
  }

  /** On a timer: a full snapshot when anything but the live part changed, a small event when only it moved. */
  #watchTick(): void {
    const state = this.#opts.state();
    const live = this.#opts.liveKey;
    const { [live ?? ""]: liveValue, ...rest } = state;
    if (JSON.stringify(rest) !== this.#lastState) return this.sendSnapshot();
    const l = JSON.stringify(liveValue ?? null);
    if (!live || l === this.#lastLive) return;
    this.#lastLive = l;
    this.broadcast({ t: "live", at: Date.now(), [live]: liveValue });
  }

  async #drain(): Promise<void> {
    if (this.#sending) return;
    this.#sending = true;
    let failing = false;
    try {
      while (this.#outbox.length && this.#running) {
        const batch = this.#outbox.slice(0, BATCH);
        try {
          const res = await this.#post("/agent/events", { events: batch });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          // Exactly what was sent: a snapshot may have replaced the queue meanwhile.
          const sent = new Set(batch);
          this.#outbox = this.#outbox.filter((e) => !sent.has(e));
          failing = false;
        } catch (e) {
          if (!failing) this.#opts.log?.(`relay: couldn't send (${errText(e)}), retrying`);
          failing = true;
          if (this.#outbox.length > OUTBOX_MAX) this.#outbox = this.#outbox.filter((e) => e.to).slice(-OUTBOX_MAX);
          await sleep(3000, this.#stopper.signal);
          // Piled-up broadcasts are replaced by one snapshot once the relay answers again.
          if (this.#running && !this.#outbox.some((e) => e.snapshot)) {
            this.#outbox = [...this.#outbox.filter((e) => e.to), { c: seal(this.#opts.keys.broadcastKey(), this.snapshotEvent(), "evt"), snapshot: true }];
          }
        }
      }
    } finally {
      this.#sending = false;
    }
  }

  // ── devices and pairing ──────────────────────────────────────────────────

  /** Tells the relay which phones may come in. Revoking a phone = publishing the list without it. */
  async publishDevices(): Promise<void> {
    if (!this.#status.online) return;
    const res = await this.#post("/agent/devices", { devices: this.#opts.keys.devices() });
    if (!res.ok) throw new Error(`the relay refused the device list (HTTP ${res.status})`);
  }

  async openPairing(lookup: string, expiresAt: number): Promise<void> {
    const res = await this.#post("/agent/pairing", { lookup, expiresAt });
    if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `the relay refused the pairing code (HTTP ${res.status})`);
  }

  async closePairing(lookup: string): Promise<void> {
    await this.#post(`/agent/pairing?lookup=${encodeURIComponent(lookup)}`, null, "DELETE").catch(() => {});
  }

  async answerPairing(lookup: string, msg: unknown): Promise<void> {
    const res = await this.#post("/agent/pairing/answer", { lookup, msg });
    if (!res.ok) throw new Error(`the relay refused the pairing answer (HTTP ${res.status})`);
  }

  // ── files ────────────────────────────────────────────────────────────────

  /** Puts one small sealed value on the relay for `deviceId` to fetch once; returns its id. */
  async putBlob(deviceId: string, value: Record<string, unknown>): Promise<string> {
    const key = this.#opts.keys.deviceKey(deviceId);
    if (!key) throw new Error("that phone isn't paired");
    const id = randomBytes(18).toString("base64url");
    const res = await this.#post("/agent/blob", { id, c: seal(key, value, `blob:${id}`) });
    if (!res.ok) throw new Error(`the relay refused the file (HTTP ${res.status})`);
    return id;
  }

  /**
   * Sends a file to one phone in sealed pieces through the relay (which holds only a few at a time, so a
   * phone that stops reading stalls this; it gives up after two minutes without progress).
   */
  async sendFile(deviceId: string, transferId: string, path: string, size: number): Promise<void> {
    const key = this.#opts.keys.deviceKey(deviceId);
    if (!key) throw new Error("that phone isn't paired");
    const state = { cancelled: false };
    this.#transfers.set(transferId, state);
    try {
      let n = 0;
      for await (const piece of createReadStream(path, { highWaterMark: PIECE_BYTES })) {
        const c = sealBytes(key, piece as Buffer, `down:${transferId}:${n}`);
        let since = Date.now();
        for (;;) {
          if (state.cancelled || !this.#running) throw new Error("cancelled");
          const res = await this.#post("/agent/chunk", { id: transferId, n, c }).catch(() => null);
          if (res?.ok) break;
          if (res && res.status !== 507) throw new Error(`the relay refused a piece (HTTP ${res.status})`);
          if (Date.now() - since > STUCK_MS) throw new Error("the phone stopped downloading");
          await sleep(res ? 700 : 3000, this.#stopper.signal);
          if (!res) since = Math.max(since, Date.now() - STUCK_MS / 2); // relay unreachable: give it a while
        }
        n += 1;
      }
      if (n !== Math.max(1, Math.ceil(size / PIECE_BYTES)) && size > 0) throw new Error("the file changed while it was being sent");
    } finally {
      this.#transfers.delete(transferId);
    }
  }

  cancelTransfer(transferId: string): boolean {
    const t = this.#transfers.get(transferId);
    if (t) t.cancelled = true;
    return !!t;
  }

  /** Receives a file a phone is uploading, piece by piece, into `out`. */
  async receiveFile(deviceId: string, uploadId: string, pieces: number, out: WriteStream, signal?: AbortSignal): Promise<number> {
    const key = this.#opts.keys.deviceKey(deviceId);
    if (!key) throw new Error("that phone isn't paired");
    let bytes = 0;
    for (let n = 0; n < pieces; n++) {
      let waited = 0;
      for (;;) {
        if (signal?.aborted || !this.#running) throw new Error("cancelled");
        const res = await fetch(`${this.#url}/agent/chunk?id=${encodeURIComponent(uploadId)}&n=${n}`, { headers: this.#headers(), signal: AbortSignal.timeout(40_000) }).catch(() => null);
        if (res?.status === 200) {
          const piece = unsealBytes(key, ((await res.json()) as { c: string }).c, `up:${uploadId}:${n}`);
          bytes += piece.length;
          if (!out.write(piece)) await new Promise((r) => out.once("drain", r));
          break;
        }
        waited += res?.status === 204 ? 25_000 : 3000;
        if (waited > STUCK_MS) throw new Error("the phone stopped uploading");
        if (!res || res.status !== 204) await sleep(3000, this.#stopper.signal);
      }
    }
    await new Promise<void>((resolve, reject) => out.end((e?: Error | null) => (e ? reject(e) : resolve())));
    return bytes;
  }

  // ── commands and the queue ───────────────────────────────────────────────

  async #command(raw: unknown): Promise<void> {
    const { c, deviceId } = (raw ?? {}) as { c?: unknown; deviceId?: unknown };
    if (typeof c !== "string" || typeof deviceId !== "string") return;
    const key = this.#opts.keys.deviceKey(deviceId);
    if (!key) return this.#opts.log?.("ignored a command from a phone that isn't paired");
    let cmd: Partial<RemoteCommand>;
    try {
      cmd = unseal(key, c, `cmd:${deviceId}`) as Partial<RemoteCommand>;
    } catch {
      return this.#opts.log?.("ignored a command not sealed with that phone's key");
    }
    // A captured command must not work again later, or twice, even after this Mac restarts.
    const at = Number(cmd?.at);
    if (typeof cmd?.id !== "string" || typeof cmd.type !== "string" || this.#opts.handled.has(cmd.id) || !(Math.abs(Date.now() - at) <= COMMAND_MAX_AGE_MS)) {
      return this.#opts.log?.("ignored a stale or repeated command");
    }
    this.#opts.handled.add(cmd.id, at + COMMAND_MAX_AGE_MS * 2);
    await this.#opts.onCommand(deviceId, cmd as RemoteCommand);
  }

  /** Takes one waiting instruction: claim it on the relay (so only one Mac process ever runs it), open, run. */
  async #take(item: { id?: unknown; deviceId?: unknown; projectId?: unknown; createdAt?: unknown; expiresAt?: unknown; c?: unknown }): Promise<void> {
    const id = typeof item.id === "string" ? item.id : "";
    if (!id || this.#taking.has(id)) return;
    this.#taking.add(id);
    try {
      if (this.#opts.handled.has(id)) {
        await this.#post("/agent/queue/done", { id }).catch(() => {});
        return;
      }
      const res = await this.#post("/agent/queue/claim", { id });
      if (!res.ok) return; // someone else took it, or the phone cancelled it just now
      const deviceId = String(item.deviceId);
      const key = this.#opts.keys.deviceKey(deviceId);
      const expiresAt = Number(item.expiresAt);
      let body: Record<string, unknown> | null = null;
      try {
        if (key && typeof item.c === "string") body = unseal(key, item.c, `queue:${id}`) as Record<string, unknown>;
      } catch {
        body = null;
      }
      // Recorded before it runs: at most once, even if this process dies halfway.
      this.#opts.handled.add(id, Math.max(expiresAt, Date.now()) + 24 * 3600 * 1000);
      if (!body || body.id !== id || body.projectId !== item.projectId) {
        this.#opts.log?.("dropped a queued instruction that didn't open with its phone's key");
      } else {
        await this.#opts.onQueued({ id, deviceId, projectId: String(item.projectId), createdAt: Number(item.createdAt), expiresAt, body });
      }
      await this.#post("/agent/queue/done", { id }).catch(() => {});
    } catch (e) {
      this.#opts.log?.(`queue: ${errText(e)}`);
    } finally {
      this.#taking.delete(id);
    }
  }

  async #takeWaiting(): Promise<void> {
    const res = await fetch(`${this.#url}/agent/queue`, { headers: this.#headers(), signal: AbortSignal.timeout(20_000) });
    if (!res.ok) return;
    const { items } = (await res.json()) as { items: { createdAt: number }[] };
    for (const item of items.sort((a, b) => a.createdAt - b.createdAt)) await this.#take(item);
  }

  // ── connection ───────────────────────────────────────────────────────────

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
        if (res.status === 401) throw new FatalError("The relay refused this Mac. Set REELFORGE_REMOTE_AUTH on the relay to the value shown in Settings → Remote Access.");
        // 429/5xx: the relay is busy or restarting. Keep trying (with backoff): it won't fix itself faster if we stop.
        if (!res.ok || !res.body) throw new Error(`relay answered HTTP ${res.status}`);
        wait = 1000;
        this.#setStatus({ online: true, error: null, fatal: false, lastConnected: Date.now() });
        this.#opts.log?.("connected to the relay");
        await this.publishDevices().catch((e) => this.#opts.log?.(errText(e)));
        this.sendSnapshot();
        this.#opts.onConnected?.();
        void this.#takeWaiting().catch((e) => this.#opts.log?.(`queue: ${errText(e)}`));
        let buffer = "";
        const decoder = new TextDecoder();
        for await (const chunk of res.body as AsyncIterable<Uint8Array>) {
          buffer += decoder.decode(chunk, { stream: true });
          let end: number;
          while ((end = buffer.indexOf("\n\n")) >= 0) {
            const block = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            const event = /^event: (.+)$/m.exec(block)?.[1];
            const data = /^data: (.*)$/m.exec(block)?.[1];
            if (!event || !data) continue;
            let parsed: unknown;
            try {
              parsed = JSON.parse(data);
            } catch {
              continue;
            }
            // Not awaited: a model can take minutes, and other commands (cancel, ping) must still get through.
            if (event === "command") void this.#command(parsed).catch((e) => this.#opts.log?.(`command: ${errText(e)}`));
            else if (event === "queue") void this.#take(parsed as Record<string, unknown>);
            else if (event === "pair") {
              const p = parsed as { lookup?: unknown; hello?: unknown };
              if (typeof p.lookup === "string") void this.#opts.onPair(p.lookup, p.hello).catch((e) => this.#opts.log?.(`pairing: ${errText(e)}`));
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
    for (const t of this.#transfers.values()) t.cancelled = true;
    await this.#loop;
    this.#loop = undefined;
    this.#setStatus({ online: false });
  }
}

class FatalError extends Error {}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done);
  });
}

export function errText(e: unknown): string {
  if (e instanceof Error) {
    const code = (e.cause as { code?: string } | undefined)?.code;
    return code ?? e.message;
  }
  return String(e);
}
