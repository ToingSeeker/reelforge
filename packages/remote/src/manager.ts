// Runs the phone remote inside the engine process (`reelforge serve`, foreground or background), the way
// ConnectorManager runs the Claude/ChatGPT connector. Settings → Remote Access drives it over the local API.
//
// State lives in <home>/remote/ (all 0600):
//   settings.json  relay URL, auto-start, Remote Ready, this Mac's secret (its relay token comes from it)
//   devices.json   the phones paired with this Mac (each with its own secret) and the broadcast key
//   handled.json   ids of commands and queued instructions already handled, so none ever runs twice
//   push.json      VAPID keys and the phones' notification subscriptions

import { spawn, execFile, execFileSync, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { basename, dirname, extname, join } from "node:path";
import {
  ACTIVE_JOB_STATES,
  consentCovers,
  JobStore,
  ProjectStore,
  ProposalStore,
  ReelForgeError,
  TimelineStore,
  type AIProposal,
  type Asset,
  type Database,
  type RenderJob,
} from "@reelforge/core";
import { RemoteDaemon, PIECE_BYTES, errText, type DaemonStatus, type QueuedInstruction, type RemoteCommand } from "./daemon.ts";
import { EditError, EditSessions, type EditLease, type ManualEditSummary } from "./edit.ts";
import { deriveDeviceKeys, deriveKeys, formatPairingCode, macIdOf, newPairingCode, newSecret, pairAnswer, verifyPairHello, type PairingCode } from "./keys.ts";
import { checkEndpoint, newVapidKeys, sendPush, type PushSubscription, type VapidKeys } from "./push.ts";

// ── what the phone is shown ────────────────────────────────────────────────

export interface RemoteProject {
  id: string;
  name: string;
  revision: number;
  width: number;
  height: number;
  fps: number;
  durationFrames: number;
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
  revision: number;
  createdAt: string;
}

export interface RemoteExport {
  id: string;
  projectId: string;
  projectName: string;
  state: string;
  revision: number;
  /** The proposal ("version") the exported revision came from, if one did. */
  version: number | null;
  fileName: string | null;
  folder: string | null;
  sizeBytes: number | null;
  width: number;
  height: number;
  fps: number;
  format: "MP4";
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
  /** The finished file is still where it was written. */
  onMac: boolean;
}

export interface RemoteAsk {
  projectId: string;
  queueId: string | null;
  instruction: string;
  provider: string;
  model: string;
  startedAt: string;
}

export interface RemoteEngineInfo {
  /** Running under launchd, independent of the editor window. */
  background: boolean;
  startedAt: string;
  version: string;
}

export type EditorState = "open" | "closed" | "unknown";

export interface RemoteReadyStatus {
  enabled: boolean;
  /** The keep-awake assertion is held right now. */
  active: boolean;
  power: "ac" | "battery" | "unknown";
}

export interface RemoteVersion {
  id: string;
  /** 1 for the project's first proposal, 2 for the next, … */
  version: number;
  status: string;
  /** Pending, but the timeline moved on since it was made: it can't be applied any more. */
  stale: boolean;
  requestedBy: "user" | "mcp";
  instruction: string;
  summary: string;
  changes: number;
  list: { kind: string; target: string; label: string; before: string | null; after: string | null }[];
  warnings: string[];
  provider: string;
  model: string;
  baseRevision: number;
  appliedRevision: number | null;
  approval: { channel: string; at: string } | null;
  createdAt: string;
}

export interface RemotePreview {
  jobId: string;
  revision: number;
  state: string;
  progress: number;
  sizeBytes: number | null;
  width: number;
  height: number;
  finishedAt: string | null;
  /** Rendered from the timeline as it is now. */
  current: boolean;
}

export interface RemoteProjectDetail extends RemoteProject {
  canUndo: boolean;
  canRedo: boolean;
  tracks: { kind: string; name: string; muted: boolean; hidden: boolean; clips: { start: number; duration: number }[] }[];
  clips: number;
  captions: number;
  assets: { video: number; audio: number; image: number; offline: number };
  versions: RemoteVersion[];
  asking: RemoteAsk | null;
  preview: RemotePreview | null;
  jobs: { id: string; kind: string; state: string; progress: number; revision: number; error: string | null; createdAt: string; finishedAt: string | null; sizeBytes: number | null }[];
  /** Manual edit sessions from phones, newest first (Review of a manual revision reads these). */
  manual: ManualEditSummary[];
  /** Who is editing this project by hand right now. */
  editing: RemoteEditing | null;
}

export interface RemoteEditing {
  projectId: string;
  deviceId: string;
  deviceName: string;
  /** Only in answers to the phone that holds the lease; never broadcast (it names that phone's session). */
  sessionId?: string;
  startedAt: string;
  expiresAt: string;
}

/** Source pictures for the phone's editor (from @reelforge/media). */
export interface RemoteFrames {
  /** The source at `timeUs`, ≤ 720 px. `wanted` false when its turn comes: skipped (the phone moved on). */
  still(asset: Asset, timeUs: number, wanted?: () => boolean): Promise<string>;
  /** Evenly spaced pictures of the whole source in one strip. */
  filmstrip(asset: Asset): Promise<{ path: string; count: number; stepUs: number }>;
}

export interface RemoteAiOptions {
  providers: { id: string; label: string; models: string[]; defaultModel: string | null; ready: boolean; external: boolean; consented: boolean }[];
  last: { provider: string; model: string } | null;
}

export interface PushPrefs {
  exports: boolean;
  proposals: boolean;
  failures: boolean;
}

// ── what Settings sees ─────────────────────────────────────────────────────

export interface RemoteSettings {
  /** The relay's origin, e.g. https://forge-remote-production.up.railway.app */
  url: string | null;
  /** Connect when the engine starts. Set by start(), cleared by stop(). */
  autoStart: boolean;
  remoteReady: boolean;
}

export interface RemoteDeviceInfo {
  id: string;
  name: string;
  createdAt: string;
  lastSeenAt: string | null;
  /** The phone confirmed the pairing (sent its first command). */
  confirmed: boolean;
  notifications: boolean;
}

export interface RemotePairingInfo {
  /** XXXX-XXXX-XXXX-XXXX */
  code: string;
  /** Opens the phone app with the code filled in (QR). Holds only the one-time code. */
  link: string;
  expiresAt: string;
  state: "open" | "answered" | "paired" | "expired" | "cancelled" | "failed";
  deviceName: string | null;
  error: string | null;
}

export interface RemoteStatus {
  state: "stopped" | "connecting" | "online" | "error";
  settings: RemoteSettings;
  /** The value to set as REELFORGE_REMOTE_AUTH on the relay. Reveals nothing about the secret. */
  relayAuth: string;
  macId: string;
  macName: string;
  error: string | null;
  lastConnected: string | null;
  devices: RemoteDeviceInfo[];
  pairing: RemotePairingInfo | null;
  remoteReady: RemoteReadyStatus;
  engine: RemoteEngineInfo;
  editor: EditorState;
  /** Phones that asked for notifications. */
  notifications: number;
}

// ── what the CLI hands in ──────────────────────────────────────────────────

/** From @reelforge/ai (this package doesn't depend on it). */
export interface RemoteAi {
  providers(): Promise<{ id: string; label: string; external: boolean; models: string[]; defaultModel: string | null; ready: boolean; recipient: string }[]>;
  propose(projectId: string, input: { instruction: string; provider: string; model: string }, signal: AbortSignal): Promise<AIProposal>;
}

/** From @reelforge/media and the engine's RenderRunner. */
export interface RemoteRender {
  /** Queues an export of the current timeline to `outputPath` at `scale` (1 = project size) and `quality`. */
  exportJob(projectId: string, outputPath: string, opts: { scale: number; quality: "standard" | "small" }): RenderJob;
  /** A preview of the current timeline (proxies, ≤ 960 px), reusing one already made for this revision. */
  previewJob(projectId: string): RenderJob;
  cancel(jobId: string): RenderJob;
  retry(jobId: string): RenderJob;
}

export interface RemoteMedia {
  /** Imports a file the phone uploaded into the project's library. */
  importFile(projectId: string, path: string): Promise<{ assetId: string; filename: string }>;
}

export interface RemoteManagerOptions {
  db: Database;
  /** State directory. */
  dir: string;
  version: string;
  log?: (line: string) => void;
  /** Makes (or finds cached) a still for an asset; the project's poster. */
  thumbnail?: (asset: Asset) => Promise<{ path: string; contentType: "image/jpeg" | "image/png" }>;
  ai?: RemoteAi;
  render?: RemoteRender;
  media?: RemoteMedia;
  frames?: RemoteFrames;
  /** How this engine runs, and whether the editor window is open (both for the phone's status line). */
  engine?: () => RemoteEngineInfo;
  editor?: () => EditorState;
  /** Where exports started from the phone are written. Default ~/Movies/ReelForge. */
  exportDir?: string;
  /** Overrides for tests. */
  deviceName?: string;
  watchMs?: number;
  notifyMs?: number;
  pushFetch?: typeof fetch;
  allowLocalPush?: boolean;
  /** Tests: don't spawn caffeinate / pmset. */
  noPower?: boolean;
}

/** How the phone's decisions are recorded: the engine's actor list has no "phone", the channel says it. */
const PHONE_ACTOR = "api";
const PHONE_CHANNEL = "phone-remote:apply";
const MAX_LISTED_CHANGES = 20;
const MAX_PROJECTS = 50;
const MAX_PHONES = 10;
const MAX_DEVICES = 20;
const RECENT_MS = 24 * 3600 * 1000;
const MAX_TRACK_CLIPS = 200;
const MAX_POSTER_BYTES = 400 * 1024;
const MAX_UPLOAD_BYTES = 4 * 1024 * 1024 * 1024;
const PAIRING_TTL_MS = 10 * 60 * 1000;
const DEFAULT_PREFS: PushPrefs = { exports: true, proposals: true, failures: true };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TRANSFER_ID = /^[A-Za-z0-9_-]{16,64}$/;

interface Stored {
  url: string | null;
  autoStart: boolean;
  remoteReady: boolean;
  secret: string;
}

interface StoredDevice {
  id: string;
  name: string;
  secret: string;
  createdAt: string;
  lastSeenAt: string | null;
  confirmed: boolean;
}

interface DeviceFile {
  broadcastKey: string;
  devices: StoredDevice[];
}

interface StoredSubscription extends PushSubscription {
  prefs: PushPrefs;
  createdAt: string;
  deviceId?: string;
}

interface PushFile {
  vapid: VapidKeys | null;
  subscriptions: StoredSubscription[];
}

interface Pairing extends PairingCode {
  expiresAt: number;
  state: RemotePairingInfo["state"];
  deviceId: string | null;
  deviceName: string | null;
  error: string | null;
}

export class RemoteManager {
  readonly #opts: RemoteManagerOptions;

  /** Hands in what exists only once the API server runs (its render runner) or comes from elsewhere. */
  attach(extra: Pick<RemoteManagerOptions, "render" | "media">): void {
    if (extra.render) this.#opts.render = extra.render;
    if (extra.media) this.#opts.media = extra.media;
  }
  readonly #file: string;
  readonly #devicesFile: string;
  readonly #handledFile: string;
  readonly #pushFile: string;
  #daemon: RemoteDaemon | undefined;
  #error: string | null = null;
  #notifier: ReturnType<typeof setInterval> | undefined;
  #seen: { finished: Set<string>; proposals: Set<string> } | null = null;
  /** Requests the AI Director is working on, one per project. */
  #asks = new Map<string, RemoteAsk & { abort: AbortController; deviceId: string | null }>();
  #pairing: Pairing | null = null;
  #pairingTimer: ReturnType<typeof setTimeout> | undefined;
  #handled: Map<string, number> | null = null;
  #handledSave: ReturnType<typeof setTimeout> | undefined;
  #durations = new Map<string, { revision: number; frames: number }>();
  #macName: string | null = null;
  #caffeinate: ChildProcess | null = null;
  #power: RemoteReadyStatus["power"] = "unknown";
  #powerTimer: ReturnType<typeof setInterval> | undefined;
  #uploads = new Map<string, AbortController>();
  readonly #startedAt = new Date().toISOString();
  /** Manual editing from phones: one lease per project. */
  readonly #edits: EditSessions;
  /** The still each phone asked for last; older ones still queued are skipped. */
  readonly #wantStill = new Map<string, string>();

  constructor(opts: RemoteManagerOptions) {
    this.#opts = { ...opts };
    this.#file = join(opts.dir, "settings.json");
    this.#devicesFile = join(opts.dir, "devices.json");
    this.#handledFile = join(opts.dir, "handled.json");
    this.#pushFile = join(opts.dir, "push.json");
    // A lease that lapses by itself is announced, so other phones stop showing "X is editing".
    this.#edits = new EditSessions(opts.db, { onExpire: () => this.#daemon?.sendSnapshot() });
  }

  // ── files ────────────────────────────────────────────────────────────────

  #writeJson(file: string, value: unknown): void {
    mkdirSync(this.#opts.dir, { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
    renameSync(tmp, file);
  }

  #readJson<T>(file: string): Partial<T> {
    try {
      return JSON.parse(readFileSync(file, "utf8")) as Partial<T>;
    } catch {
      return {};
    }
  }

  #read(): Stored {
    const raw = this.#readJson<Stored>(this.#file);
    const stored: Stored = {
      url: typeof raw.url === "string" && raw.url ? raw.url : null,
      autoStart: raw.autoStart === true,
      remoteReady: raw.remoteReady === true,
      secret: typeof raw.secret === "string" && raw.secret.length >= 32 ? raw.secret : "",
    };
    if (!stored.secret) {
      stored.secret = newSecret();
      this.#writeJson(this.#file, stored);
    }
    return stored;
  }

  #write(s: Stored): void {
    this.#writeJson(this.#file, s);
  }

  #readDevices(): DeviceFile {
    const raw = this.#readJson<DeviceFile>(this.#devicesFile);
    const devices = Array.isArray(raw.devices) ? raw.devices.filter((d) => typeof d?.id === "string" && typeof d.secret === "string") : [];
    if (typeof raw.broadcastKey === "string" && Buffer.from(raw.broadcastKey, "base64").length === 32) return { broadcastKey: raw.broadcastKey, devices };
    const file = { broadcastKey: randomBytes(32).toString("base64"), devices };
    this.#writeJson(this.#devicesFile, file);
    return file;
  }

  #writeDevices(f: DeviceFile): void {
    this.#writeJson(this.#devicesFile, f);
  }

  #handledMap(): Map<string, number> {
    if (!this.#handled) {
      const raw = this.#readJson<Record<string, number>>(this.#handledFile);
      const now = Date.now();
      this.#handled = new Map(Object.entries(raw).filter(([, until]) => typeof until === "number" && until > now) as [string, number][]);
    }
    return this.#handled;
  }

  #saveHandledSoon(): void {
    clearTimeout(this.#handledSave);
    this.#handledSave = setTimeout(() => this.#saveHandled(), 200);
  }

  #saveHandled(): void {
    clearTimeout(this.#handledSave);
    if (!this.#handled) return;
    const now = Date.now();
    for (const [id, until] of this.#handled) if (until <= now) this.#handled.delete(id);
    this.#writeJson(this.#handledFile, Object.fromEntries(this.#handled));
  }

  // ── identity ─────────────────────────────────────────────────────────────

  /** "Studio Mac": the name the user gave this Mac, as Finder shows it. */
  macName(): string {
    if (this.#opts.deviceName) return this.#opts.deviceName;
    if (this.#macName) return this.#macName;
    try {
      this.#macName = execFileSync("/usr/sbin/scutil", ["--get", "ComputerName"], { encoding: "utf8", timeout: 2000 }).trim() || null;
    } catch {
      this.#macName = null;
    }
    this.#macName ??= hostname().replace(/\.local$/, "");
    return this.#macName;
  }

  #engine(): RemoteEngineInfo {
    return this.#opts.engine?.() ?? { background: false, startedAt: this.#startedAt, version: this.#opts.version };
  }

  #editor(): EditorState {
    return this.#opts.editor?.() ?? "unknown";
  }

  // ── status and control (Settings) ────────────────────────────────────────

  status(): RemoteStatus {
    const s = this.#read();
    const keys = deriveKeys(s.secret);
    const d = this.#daemon?.status;
    const state: RemoteStatus["state"] = this.#daemon ? (d?.online ? "online" : "connecting") : this.#error ? "error" : "stopped";
    const push = this.#readPush().subscriptions;
    const pairing = this.#pairingInfo(s.url);
    return {
      state,
      settings: { url: s.url, autoStart: s.autoStart, remoteReady: s.remoteReady },
      relayAuth: keys.authHash,
      macId: macIdOf(keys.authHash),
      macName: this.macName(),
      error: this.#daemon ? (d?.error ?? null) : this.#error,
      lastConnected: d?.lastConnected ? new Date(d.lastConnected).toISOString() : null,
      devices: this.#readDevices().devices.map((x) => ({
        id: x.id,
        name: x.name,
        createdAt: x.createdAt,
        lastSeenAt: x.lastSeenAt,
        confirmed: x.confirmed,
        notifications: push.some((p) => p.deviceId === x.id),
      })),
      pairing,
      remoteReady: this.#remoteReadyStatus(s),
      engine: this.#engine(),
      editor: this.#editor(),
      notifications: push.length,
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
    this.#applyRemoteReady();
    return this.status();
  }

  /** Start if the user left it on. Never throws. */
  async autoStart(): Promise<void> {
    const s = this.#read();
    if (!s.autoStart || !s.url) return;
    await this.start().catch((e) => this.#opts.log?.(`auto-start failed: ${e instanceof Error ? e.message : e}`));
  }

  /** Disconnect and stay off (also next time the engine starts). Phones are told it stopped on purpose. */
  async stop(): Promise<RemoteStatus> {
    const d = this.#daemon;
    if (d?.status.online) {
      d.broadcast({ t: "engine", state: "stopped", at: Date.now() });
      await d.flush();
    }
    await this.#teardown();
    this.#error = null;
    this.#write({ ...this.#read(), autoStart: false });
    this.#applyRemoteReady();
    return this.status();
  }

  /**
   * New Mac secret: the relay needs the new REELFORGE_REMOTE_AUTH before this Mac can connect again, and
   * every paired phone is removed (they were paired with this Mac's identity).
   */
  async rotate(): Promise<RemoteStatus> {
    const s = this.#read();
    const wasRunning = !!this.#daemon;
    await this.#teardown();
    const next = { ...s, secret: newSecret() };
    this.#write(next);
    this.#writeDevices({ broadcastKey: randomBytes(32).toString("base64"), devices: [] });
    this.#writePush({ ...this.#readPush(), subscriptions: [] });
    if (wasRunning && next.url) this.#launch(next.url, next.secret);
    return this.status();
  }

  /** For process shutdown: disconnect without touching auto-start. */
  async close(): Promise<void> {
    this.#edits.close();
    await this.#teardown();
    this.#stopCaffeinate();
    clearInterval(this.#powerTimer);
    this.#saveHandled();
  }

  // ── pairing ──────────────────────────────────────────────────────────────

  #pairingInfo(url: string | null): RemotePairingInfo | null {
    const p = this.#pairing;
    if (!p) return null;
    if (p.state === "open" && p.expiresAt <= Date.now()) p.state = "expired";
    return {
      code: formatPairingCode(p.code),
      link: url ? `${url}/#pair=${formatPairingCode(p.code)}` : "",
      expiresAt: new Date(p.expiresAt).toISOString(),
      state: p.state,
      deviceName: p.deviceName,
      error: p.error,
    };
  }

  /** A one-time code (10 minutes) for one phone. Needs the relay connection. Replaces any open one. */
  async startPairing(): Promise<RemoteStatus> {
    const d = this.#daemon;
    if (!d?.status.online) throw new ReelForgeError("UNAVAILABLE", "Connect to the relay first: pairing goes through it.");
    if (this.#readDevices().devices.length >= MAX_DEVICES) throw new ReelForgeError("VALIDATION_ERROR", `${MAX_DEVICES} phones are paired already. Remove one first.`);
    await this.cancelPairing();
    for (let attempt = 0; ; attempt++) {
      const code = newPairingCode();
      const expiresAt = Date.now() + PAIRING_TTL_MS;
      try {
        await d.openPairing(code.lookup, expiresAt);
      } catch (e) {
        if (attempt < 3 && /in use/.test(errText(e))) continue;
        throw new ReelForgeError("UNAVAILABLE", errText(e));
      }
      this.#pairing = { ...code, expiresAt, state: "open", deviceId: null, deviceName: null, error: null };
      clearTimeout(this.#pairingTimer);
      this.#pairingTimer = setTimeout(() => this.#expirePairing(), PAIRING_TTL_MS + 1000);
      this.#pairingTimer.unref?.();
      return this.status();
    }
  }

  async cancelPairing(): Promise<RemoteStatus> {
    const p = this.#pairing;
    if (p && (p.state === "open" || p.state === "answered")) {
      p.state = "cancelled";
      await this.#daemon?.closePairing(p.lookup);
      // A phone that got its credentials but never confirmed is not paired.
      if (p.deviceId) this.#removeDevice(p.deviceId, { onlyUnconfirmed: true });
    }
    clearTimeout(this.#pairingTimer);
    return this.status();
  }

  #expirePairing(): void {
    const p = this.#pairing;
    if (!p || (p.state !== "open" && p.state !== "answered")) return;
    p.state = "expired";
    void this.#daemon?.closePairing(p.lookup);
    if (p.deviceId) this.#removeDevice(p.deviceId, { onlyUnconfirmed: true });
  }

  async #onPair(lookup: string, hello: unknown): Promise<void> {
    const p = this.#pairing;
    if (!p || p.lookup !== lookup || p.state !== "open" || p.expiresAt <= Date.now()) return;
    let verified;
    try {
      verified = verifyPairHello(p.secret, hello);
    } catch (e) {
      // A wrong code burns the slot: the relay lets one hello through per code.
      p.state = "failed";
      p.error = errText(e);
      await this.#daemon?.closePairing(lookup);
      return;
    }
    const devices = this.#readDevices();
    const device: StoredDevice = {
      id: randomBytes(12).toString("base64url"),
      name: cleanName(verified.name) || "Phone",
      secret: newSecret(),
      createdAt: new Date().toISOString(),
      lastSeenAt: null,
      confirmed: false,
    };
    this.#writeDevices({ ...devices, devices: [...devices.devices, device] });
    await this.#daemon?.publishDevices();
    const s = this.#read();
    const answer = pairAnswer(p.secret, verified, {
      macId: macIdOf(deriveKeys(s.secret).authHash),
      macName: this.macName(),
      deviceId: device.id,
      deviceSecret: device.secret,
      broadcastKey: devices.broadcastKey,
    });
    p.state = "answered";
    p.deviceId = device.id;
    p.deviceName = device.name;
    await this.#daemon?.answerPairing(lookup, answer);
  }

  /** Removes a paired phone: the relay stops letting it in, and it can no longer read new events. */
  async revokeDevice(deviceId: string): Promise<RemoteStatus> {
    if (!this.#readDevices().devices.some((d) => d.id === deviceId)) throw new ReelForgeError("NOT_FOUND", "that phone isn't paired");
    this.#removeDevice(deviceId);
    return this.status();
  }

  #removeDevice(deviceId: string, { onlyUnconfirmed = false } = {}): void {
    const f = this.#readDevices();
    const gone = f.devices.find((d) => d.id === deviceId);
    if (!gone || (onlyUnconfirmed && gone.confirmed)) return;
    const rest = f.devices.filter((d) => d.id !== deviceId);
    this.#edits.releaseDevice(deviceId);
    this.#wantStill.delete(deviceId);
    // New broadcast key, so the removed phone can't read what is said from now on; the others get it sealed
    // with their own keys before anything is sealed with it.
    const next = { broadcastKey: randomBytes(32).toString("base64"), devices: rest };
    for (const d of rest) this.#daemon?.sendTo(d.id, { t: "rekey", broadcastKey: next.broadcastKey });
    this.#writeDevices(next);
    this.#writePush({ ...this.#readPush(), subscriptions: this.#readPush().subscriptions.filter((s) => s.deviceId !== deviceId) });
    void this.#daemon?.publishDevices().catch((e) => this.#opts.log?.(errText(e)));
    this.#daemon?.sendSnapshot();
  }

  #touchDevice(deviceId: string, confirm = false): void {
    const f = this.#readDevices();
    const d = f.devices.find((x) => x.id === deviceId);
    if (!d) return;
    const now = new Date().toISOString();
    // Written at most once a minute: every ping would otherwise rewrite the file.
    if (!confirm && d.confirmed && d.lastSeenAt && Date.now() - Date.parse(d.lastSeenAt) < 60_000) return;
    d.lastSeenAt = now;
    if (confirm && !d.confirmed) {
      d.confirmed = true;
      if (this.#pairing?.deviceId === deviceId) {
        this.#pairing.state = "paired";
        clearTimeout(this.#pairingTimer);
      }
    }
    this.#writeDevices(f);
  }

  // ── Remote Ready (keep the Mac awake on power) ───────────────────────────

  async setRemoteReady(enabled: boolean): Promise<RemoteStatus> {
    this.#write({ ...this.#read(), remoteReady: enabled });
    this.#applyRemoteReady();
    return this.status();
  }

  #remoteReadyStatus(s: Stored): RemoteReadyStatus {
    return { enabled: s.remoteReady, active: !!this.#caffeinate && this.#caffeinate.exitCode === null, power: this.#power };
  }

  /**
   * Remote Ready holds a "prevent system sleep" assertion (`caffeinate -s`) while the remote is on. macOS
   * honours it only on AC power; the display may still sleep, and closing a laptop's lid still sleeps it
   * unless it's in clamshell mode with an external display. The status says which of these applies.
   */
  #applyRemoteReady(): void {
    if (this.#opts.noPower) return;
    const s = this.#read();
    const want = s.remoteReady && s.autoStart;
    if (want && !this.#caffeinate) {
      const child = spawn("/usr/bin/caffeinate", ["-s", "-w", String(process.pid)], { stdio: "ignore" });
      child.on("error", (e) => this.#opts.log?.(`Remote Ready: ${e.message}`));
      child.on("exit", () => {
        if (this.#caffeinate === child) this.#caffeinate = null;
      });
      this.#caffeinate = child;
    } else if (!want) this.#stopCaffeinate();
    clearInterval(this.#powerTimer);
    if (want) {
      this.#checkPower();
      this.#powerTimer = setInterval(() => this.#checkPower(), 30_000);
      this.#powerTimer.unref?.();
    }
  }

  #stopCaffeinate(): void {
    this.#caffeinate?.kill();
    this.#caffeinate = null;
  }

  #checkPower(): void {
    execFile("/usr/bin/pmset", ["-g", "ps"], { timeout: 3000 }, (err, out) => {
      this.#power = err ? "unknown" : /AC Power/.test(out) ? "ac" : /Battery Power/.test(out) ? "battery" : "unknown";
    });
  }

  // ── state for the phone ──────────────────────────────────────────────────

  #duration(projectId: string, revision: number): number {
    const hit = this.#durations.get(projectId);
    if (hit?.revision === revision) return hit.frames;
    let frames = 0;
    try {
      frames = new TimelineStore(this.#opts.db).get(projectId).durationFrames;
    } catch {
      frames = 0;
    }
    this.#durations.set(projectId, { revision, frames });
    return frames;
  }

  /** The snapshot body. `jobs` is the part that changes every second (progress). */
  state(): Record<string, unknown> {
    const projectStore = new ProjectStore(this.#opts.db);
    const jobStore = new JobStore(this.#opts.db);
    const proposalStore = new ProposalStore(this.#opts.db);
    const projects: RemoteProject[] = [];
    const jobs: RemoteJob[] = [];
    const exports: RemoteExport[] = [];
    for (const p of projectStore.list().slice(0, MAX_PROJECTS)) {
      const fps = Math.round((p.settings.fps.num / p.settings.fps.den) * 100) / 100;
      const proposals = proposalStore.list(p.id, 50);
      projects.push({
        id: p.id,
        name: p.name,
        revision: p.revision,
        width: p.settings.width,
        height: p.settings.height,
        fps,
        durationFrames: this.#duration(p.id, p.revision),
        updatedAt: p.updatedAt,
        pendingProposals: proposals.filter((x) => x.status === "pending").length,
      });
      let sizes: Map<string, { size: number; path: string }> | undefined;
      const versionOf = versionLookup(proposals);
      for (const j of jobStore.list(p.id, { limit: 20 })) {
        const active = ACTIVE_JOB_STATES.includes(j.state);
        if (active) jobs.push({ id: j.id, projectId: j.projectId, kind: j.kind, state: j.state, progress: Math.round(j.progress * 1000) / 1000, revision: j.revision, createdAt: j.createdAt });
        if (j.kind !== "export") continue;
        sizes ??= new Map(jobStore.artifacts(p.id).map((a) => [a.jobId, { size: a.sizeBytes, path: a.path }]));
        const art = sizes.get(j.id);
        const path = art?.path ?? j.outputPath;
        exports.push({
          id: j.id,
          projectId: p.id,
          projectName: p.name,
          state: j.state,
          revision: j.revision,
          version: versionOf(j.revision),
          fileName: path ? basename(path) : null,
          folder: path ? prettyFolder(dirname(path)) : null,
          sizeBytes: art?.size ?? null,
          width: j.settings.width,
          height: j.settings.height,
          fps,
          format: "MP4",
          error: j.error?.message ?? null,
          createdAt: j.createdAt,
          finishedAt: j.finishedAt,
          onMac: j.state === "completed" && !!art && existsSync(art.path),
        });
      }
    }
    exports.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const s = this.#read();
    const asks = [...this.#asks.values()].map(({ abort: _a, deviceId: _d, ...ask }) => ask);
    return {
      mac: { id: macIdOf(deriveKeys(s.secret).authHash), name: this.macName() },
      engine: { ...this.#engine(), state: jobs.length || asks.length ? "busy" : "ready", editor: this.#editor(), remoteReady: this.#remoteReadyStatus(s) },
      pushKey: this.#vapid().publicKey,
      projects,
      exports: exports.slice(0, 30),
      asks,
      jobs,
      editing: this.#edits.leases().map((l) => editingOf(l)),
    };
  }

  /** One project for the phone's Session and Review screens. */
  project(projectId: string): RemoteProjectDetail {
    const tl = new TimelineStore(this.#opts.db).get(projectId);
    const p = tl.project;
    const jobStore = new JobStore(this.#opts.db);
    const sizes = new Map(jobStore.artifacts(projectId).map((a) => [a.jobId, a.sizeBytes]));
    const assets = { video: 0, audio: 0, image: 0, offline: 0 };
    for (const a of tl.assets) {
      assets[a.kind] += 1;
      if (a.status !== "online") assets.offline += 1;
    }
    const tracks = [...tl.tracks]
      .sort((a, b) => a.position - b.position)
      .map((t) => {
        const items = t.kind === "caption" ? tl.captions.filter((c) => c.trackId === t.id) : tl.clips.filter((c) => c.trackId === t.id);
        return {
          kind: t.kind,
          name: t.name,
          muted: t.muted,
          hidden: t.hidden,
          clips: items.map((c) => ({ start: c.start, duration: c.duration })).sort((a, b) => a.start - b.start).slice(0, MAX_TRACK_CLIPS),
        };
      });
    const all = new ProposalStore(this.#opts.db).list(projectId, 200);
    const numbers = new Map([...all].reverse().map((x, i) => [x.id, i + 1]));
    const versions: RemoteVersion[] = all.slice(0, 20).map((x) => ({
      id: x.id,
      version: numbers.get(x.id)!,
      status: x.status,
      stale: x.status === "pending" && x.baseRevision !== p.revision,
      requestedBy: x.requestedBy,
      instruction: x.instruction,
      summary: x.summary,
      changes: x.changes.length,
      list: x.changes.slice(0, MAX_LISTED_CHANGES).map((c) => ({ kind: c.kind, target: c.target, label: c.label, before: c.before, after: c.after })),
      warnings: [...new Set(x.warnings)],
      provider: x.provider,
      model: x.model,
      baseRevision: x.baseRevision,
      appliedRevision: x.appliedRevision,
      approval: x.approval ? { channel: x.approval.channel, at: x.approval.at } : null,
      createdAt: x.createdAt,
    }));
    const ask = this.#asks.get(projectId);
    const lease = this.#edits.lease(projectId);
    const jobs = jobStore.list(projectId, { limit: 10 });
    const preview = jobs.find((j) => j.kind === "preview" && j.state !== "failed" && j.state !== "cancelled") ?? null;
    const fps = Math.round((p.settings.fps.num / p.settings.fps.den) * 100) / 100;
    return {
      id: p.id,
      name: p.name,
      revision: p.revision,
      width: p.settings.width,
      height: p.settings.height,
      fps,
      durationFrames: tl.durationFrames,
      updatedAt: p.updatedAt,
      pendingProposals: all.filter((x) => x.status === "pending").length,
      canUndo: tl.history.canUndo,
      canRedo: tl.history.canRedo,
      tracks,
      clips: tl.clips.length,
      captions: tl.captions.length,
      assets,
      versions,
      asking: ask ? { projectId, queueId: ask.queueId, instruction: ask.instruction, provider: ask.provider, model: ask.model, startedAt: ask.startedAt } : null,
      preview: preview
        ? {
            jobId: preview.id,
            revision: preview.revision,
            state: preview.state,
            progress: Math.round(preview.progress * 1000) / 1000,
            sizeBytes: sizes.get(preview.id) ?? fileSize(preview.outputPath),
            width: preview.settings.width,
            height: preview.settings.height,
            finishedAt: preview.finishedAt,
            current: preview.revision === p.revision,
          }
        : null,
      jobs: jobs.slice(0, 6).map((j) => ({
        id: j.id,
        kind: j.kind,
        state: j.state,
        progress: Math.round(j.progress * 1000) / 1000,
        revision: j.revision,
        error: j.error?.message ?? null,
        createdAt: j.createdAt,
        finishedAt: j.finishedAt,
        sizeBytes: sizes.get(j.id) ?? null,
      })),
      manual: this.#edits.summaries(projectId),
      editing: lease ? editingOf(lease) : null,
    };
  }

  // ── AI Director ──────────────────────────────────────────────────────────

  #ai(): RemoteAi {
    if (!this.#opts.ai) throw new ReelForgeError("UNAVAILABLE", "This Mac's ReelForge can't run the AI Director for the phone.");
    return this.#opts.ai;
  }

  async aiOptions(projectId: string): Promise<RemoteAiOptions> {
    const consent = new ProposalStore(this.#opts.db).consent(projectId);
    const providers = (await this.#ai().providers()).map((p) => ({
      id: p.id,
      label: p.label,
      models: p.models,
      defaultModel: p.defaultModel,
      ready: p.ready,
      external: p.external,
      consented: !p.external || consentCovers(consent, p.recipient),
    }));
    const byModel = (list: AIProposal[]) => list.find((x) => providers.some((p) => p.id === x.provider && p.models.includes(x.model)));
    const store = new ProposalStore(this.#opts.db);
    let last = byModel(store.list(projectId, 20));
    if (!last) for (const p of new ProjectStore(this.#opts.db).list().slice(0, 10)) if ((last = byModel(store.list(p.id, 5)))) break;
    return { providers, last: last ? { provider: last.provider, model: last.model } : null };
  }

  /** Claims the project at once (so a second request is refused), then plans in the background. */
  ask(projectId: string, input: { instruction: unknown; provider: unknown; model: unknown }, meta: { queueId?: string | null; deviceId?: string | null } = {}): Promise<AIProposal> {
    const ai = this.#ai();
    const instruction = typeof input.instruction === "string" ? input.instruction.trim() : "";
    if (!instruction || instruction.length > 4000) throw new ReelForgeError("VALIDATION_ERROR", "Write what to change (up to 4000 characters).");
    if (typeof input.provider !== "string" || typeof input.model !== "string") throw new ReelForgeError("VALIDATION_ERROR", "Pick a model first.");
    if (this.#asks.has(projectId)) throw new ReelForgeError("VALIDATION_ERROR", "The AI Director is still working on this project. Wait for it, or cancel it.");
    // The agent never edits under a hand: a phone editing this project by hand finishes (Done) first.
    const editing = this.#edits.lease(projectId);
    if (editing) throw new ReelForgeError("VALIDATION_ERROR", `${editing.deviceName} is editing this project by hand. Tap Done there, then ask again.`);
    new ProjectStore(this.#opts.db).get(projectId); // NOT_FOUND before anything starts
    const provider = input.provider;
    const model = input.model;
    const abort = new AbortController();
    this.#asks.set(projectId, { projectId, queueId: meta.queueId ?? null, instruction, provider, model, startedAt: new Date().toISOString(), abort, deviceId: meta.deviceId ?? null });
    return (async () => {
      try {
        // The phone may only pick what this Mac offers; its strings never reach a model CLI unchecked.
        const offered = (await ai.providers()).find((p) => p.id === provider);
        if (!offered || !offered.models.includes(model)) throw new ReelForgeError("VALIDATION_ERROR", "That model isn't available on your Mac any more. Pick another one.");
        if (!offered.ready) throw new ReelForgeError("UNAVAILABLE", `${offered.label} isn't set up on your Mac.`);
        return await ai.propose(projectId, { instruction, provider, model }, abort.signal);
      } catch (e) {
        if (abort.signal.aborted) throw new ReelForgeError("VALIDATION_ERROR", "Cancelled.");
        throw e;
      } finally {
        if (this.#asks.get(projectId)?.abort === abort) this.#asks.delete(projectId);
      }
    })();
  }

  cancelAsk(projectId: string): boolean {
    const ask = this.#asks.get(projectId);
    ask?.abort.abort();
    return !!ask;
  }

  applyProposal(proposalId: string): { projectId: string; revision: number } {
    this.#notEditing(new ProposalStore(this.#opts.db).get(proposalId).projectId);
    const r = new ProposalStore(this.#opts.db).apply(proposalId, { by: PHONE_ACTOR, channel: PHONE_CHANNEL });
    return { projectId: r.proposal.projectId, revision: r.timeline.project.revision };
  }

  /** Timeline changes from outside a manual edit session wait until it ends (Done), so nothing lands under a hand. */
  #notEditing(projectId: string): void {
    const l = this.#edits.lease(projectId);
    if (l) throw new ReelForgeError("VALIDATION_ERROR", `${l.deviceName} is editing this project by hand. Tap Done there first.`);
  }

  rejectProposal(proposalId: string): { projectId: string } {
    return { projectId: new ProposalStore(this.#opts.db).reject(proposalId, PHONE_ACTOR).projectId };
  }

  history(action: "undo" | "redo", projectId: string, baseRevision: unknown): { revision: number } {
    if (typeof baseRevision !== "number") throw new ReelForgeError("VALIDATION_ERROR", "baseRevision is required");
    this.#notEditing(projectId);
    const store = new TimelineStore(this.#opts.db);
    const tl = action === "undo" ? store.undo(projectId, { baseRevision }, PHONE_ACTOR) : store.redo(projectId, { baseRevision }, PHONE_ACTOR);
    return { revision: tl.project.revision };
  }

  // ── exports ──────────────────────────────────────────────────────────────

  #render(): RemoteRender {
    if (!this.#opts.render) throw new ReelForgeError("UNAVAILABLE", "This Mac's ReelForge can't render for the phone.");
    return this.#opts.render;
  }

  exportDir(): string {
    return this.#opts.exportDir ?? join(homedir(), "Movies", "ReelForge");
  }

  exportOptions(projectId: string) {
    const p = new ProjectStore(this.#opts.db).get(projectId);
    const even = (x: number) => Math.max(2, Math.round(x / 2) * 2);
    return {
      projectId,
      revision: p.revision,
      format: "MP4" as const,
      codec: "H.264 / AAC",
      fps: Math.round((p.settings.fps.num / p.settings.fps.den) * 100) / 100,
      resolutions: [
        { id: "full", scale: 1, width: p.settings.width, height: p.settings.height },
        { id: "half", scale: 0.5, width: even(p.settings.width / 2), height: even(p.settings.height / 2) },
      ],
      qualities: [
        { id: "standard", label: "Standard" },
        { id: "small", label: "Smaller file" },
      ],
      folder: prettyFolder(this.exportDir()),
    };
  }

  /**
   * An export of the timeline exactly at `revision` (an approval names what it approves). If a pending
   * proposal is named, it is applied first and the export is of the revision that produced.
   */
  startExport(input: { projectId: unknown; revision: unknown; proposalId?: unknown; resolution?: unknown; quality?: unknown }): { job: RenderJob; applied: { revision: number } | null } {
    const projectId = uuidOf(input.projectId, "project");
    const scale = input.resolution === "half" ? 0.5 : 1;
    const quality = input.quality === "small" ? "small" : "standard";
    const render = this.#render();
    const projects = new ProjectStore(this.#opts.db);
    let applied: { revision: number } | null = null;
    if (input.proposalId !== undefined && input.proposalId !== null) {
      const proposalId = uuidOf(input.proposalId, "proposal");
      const proposal = new ProposalStore(this.#opts.db).get(proposalId);
      if (proposal.projectId !== projectId) throw new ReelForgeError("VALIDATION_ERROR", "That version belongs to another project.");
      if (proposal.status === "pending") {
        if (proposal.baseRevision !== input.revision) throw new ReelForgeError("REVISION_CONFLICT", "This version changed since you opened it. Review it again.");
        applied = { revision: this.applyProposal(proposalId).revision };
      } else if (proposal.status !== "applied" || proposal.appliedRevision !== input.revision) {
        throw new ReelForgeError("VALIDATION_ERROR", `This version is ${proposal.status}; it can't be exported.`);
      }
    }
    const current = projects.get(projectId);
    const want = applied?.revision ?? input.revision;
    if (current.revision !== want) throw new ReelForgeError("REVISION_CONFLICT", "The timeline changed on your Mac since you reviewed it. Review the latest version first.");
    mkdirSync(this.exportDir(), { recursive: true });
    const outputPath = uniquePath(this.exportDir(), `${safeFileName(current.name)} r${current.revision}${scale === 1 ? "" : " half"}.mp4`);
    return { job: render.exportJob(projectId, outputPath, { scale, quality }), applied };
  }

  // ── commands from the phone ──────────────────────────────────────────────

  async #onCommand(deviceId: string, cmd: RemoteCommand): Promise<void> {
    const d = this.#daemon;
    if (!d) return;
    const id = cmd.id;
    const reply = (event: Record<string, unknown>) => d.sendTo(deviceId, { id, ...event });
    this.#touchDevice(deviceId, cmd.type === "device.hello");
    try {
      switch (cmd.type) {
        case "device.hello":
          return reply({ t: "device", state: "paired", mac: { id: macIdOf(deriveKeys(this.#read().secret).authHash), name: this.macName() } });
        case "device.forget":
          reply({ t: "device", state: "forgotten" });
          return this.#removeDevice(deviceId);
        case "sync":
          return d.sendSnapshot();
        case "ping":
          return reply({ t: "pong", at: Date.now() });
        case "project.open":
          return reply({ t: "project", project: this.project(uuidOf(cmd.projectId, "project")) });
        case "poster": {
          const projectId = uuidOf(cmd.projectId, "project");
          const poster = await this.poster(projectId);
          if (!poster) return reply({ t: "poster", projectId, key: null, blob: null });
          const blob = await d.putBlob(deviceId, { type: poster.type, data: poster.data.toString("base64") });
          return reply({ t: "poster", projectId, key: poster.key, blob });
        }
        case "ai.options": {
          const projectId = uuidOf(cmd.projectId, "project");
          return reply({ t: "ai.options", projectId, ...(await this.aiOptions(projectId)) });
        }
        case "ai.cancel": {
          const projectId = uuidOf(cmd.projectId, "project");
          return reply({ t: "ai", projectId, state: this.cancelAsk(projectId) ? "cancelling" : "idle" });
        }
        case "proposal.reject":
          return reply({ t: "proposal", action: "rejected", ...this.rejectProposal(uuidOf(cmd.proposalId, "proposal")) });
        case "proposal.apply":
          return reply({ t: "proposal", action: "applied", ...this.applyProposal(uuidOf(cmd.proposalId, "proposal")) });
        case "undo":
        case "redo": {
          const projectId = uuidOf(cmd.projectId, "project");
          return reply({ t: "history", action: cmd.type, projectId, ...this.history(cmd.type, projectId, cmd.baseRevision) });
        }
        case "edit.open":
        case "edit.begin":
        case "edit.heartbeat":
        case "edit.apply":
        case "edit.undo":
        case "edit.redo":
        case "edit.end":
          return reply(await this.#edit(deviceId, cmd));
        case "edit.still":
        case "edit.strip":
          return reply(await this.#frame(deviceId, cmd));
        case "export.options":
          return reply({ t: "export.options", ...this.exportOptions(uuidOf(cmd.projectId, "project")) });
        case "export.start": {
          const { job, applied } = this.startExport({ ...cmd, projectId: cmd.projectId, revision: cmd.revision });
          d.sendSnapshot();
          return reply({ t: "export", state: "queued", jobId: job.id, projectId: job.projectId, revision: job.revision, applied });
        }
        case "preview.start": {
          const job = this.#render().previewJob(uuidOf(cmd.projectId, "project"));
          return reply({ t: "preview", state: job.state, jobId: job.id, projectId: job.projectId, revision: job.revision });
        }
        case "job.cancel": {
          const job = this.#render().cancel(uuidOf(cmd.jobId, "job"));
          return reply({ t: "job", action: "cancelled", jobId: job.id, state: job.state });
        }
        case "job.retry": {
          const job = this.#render().retry(uuidOf(cmd.jobId, "job"));
          return reply({ t: "job", action: "retried", jobId: job.id, state: job.state });
        }
        case "file.get":
          return await this.#sendFile(deviceId, cmd, reply);
        case "file.cancel":
          return reply({ t: "file", transferId: cmd.transferId, state: d.cancelTransfer(String(cmd.transferId)) ? "cancelled" : "gone" });
        case "upload.start":
          return await this.#receiveUpload(deviceId, cmd, reply);
        case "upload.cancel":
          this.#uploads.get(String(cmd.uploadId))?.abort();
          return reply({ t: "upload", uploadId: cmd.uploadId, state: "cancelled" });
        case "push.subscribe": {
          const prefs = this.#subscribe(deviceId, { endpoint: cmd.endpoint, keys: cmd.keys, prefs: cmd.prefs });
          return reply({ t: "push", subscribed: true, prefs });
        }
        case "push.unsubscribe":
          this.#unsubscribe(cmd.endpoint);
          return reply({ t: "push", subscribed: false });
        case "push.test":
          await this.#testPush(cmd.endpoint);
          return reply({ t: "push", tested: true });
      }
      return reply({ t: "error", message: `Unknown command: ${String(cmd.type).slice(0, 40)}` });
    } catch (e) {
      const details = String(cmd.type).startsWith("edit.") ? detailsOf(e) : null;
      reply({ t: "error", type: String(cmd.type).slice(0, 40), code: codeOf(e), message: errText(e), ...(details ? { details } : {}) });
    }
  }

  // ── manual editing ───────────────────────────────────────────────────────

  /** The edit-session commands. Every answer carries the timeline as it is after the command. */
  async #edit(deviceId: string, cmd: RemoteCommand): Promise<Record<string, unknown>> {
    const projectId = uuidOf(cmd.projectId, "project");
    const edits = this.#edits;
    const sessionId = typeof cmd.sessionId === "string" ? cmd.sessionId : null;
    const answer = (extra: Record<string, unknown>, sid: string | null = sessionId) => {
      const lease = edits.lease(projectId);
      const ask = this.#asks.get(projectId);
      return {
        t: "edit",
        projectId,
        ...extra,
        lease: lease ? { ...editingOf(lease, deviceId), mine: lease.deviceId === deviceId && lease.sessionId === sid } : null,
        agent: ask ? { instruction: ask.instruction, startedAt: ask.startedAt } : null,
        model: edits.model(projectId, sid ? { sessionId: sid, deviceId } : null),
      };
    };
    switch (cmd.type) {
      case "edit.open":
        // Read-only look before editing: the timeline, who holds the lease, whether the agent is busy.
        return answer({ action: "open" }, null);
      case "edit.begin": {
        // "Stop agent & edit": the agent only proposes (it never writes the timeline), so stopping it
        // mid-plan leaves nothing half-done; the request is cancelled and editing starts.
        if (cmd.stopAgent === true && this.#asks.has(projectId)) {
          this.cancelAsk(projectId);
          const end = Date.now() + 5000;
          while (this.#asks.has(projectId) && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
        }
        const { lease, resumed } = edits.begin({ projectId, sessionId: cmd.sessionId, deviceId, deviceName: this.#deviceName(deviceId), agentBusy: this.#asks.has(projectId) });
        this.#daemon?.sendSnapshot();
        return answer({ action: "begin", resumed }, lease.sessionId);
      }
      case "edit.heartbeat": {
        const lease = edits.heartbeat(deviceId, projectId, cmd.sessionId);
        return { t: "edit", projectId, action: "heartbeat", expiresAt: new Date(lease.expiresAt).toISOString(), revision: new ProjectStore(this.#opts.db).get(projectId).revision };
      }
      case "edit.apply": {
        const r = edits.apply(deviceId, { projectId, sessionId: cmd.sessionId, commandId: cmd.commandId, baseRevision: cmd.baseRevision, operations: cmd.operations, label: cmd.label });
        this.#daemon?.sendSnapshot();
        return answer({ action: "apply", commandId: cmd.commandId, ...r });
      }
      case "edit.undo":
      case "edit.redo": {
        const r = edits.travel(deviceId, cmd.type === "edit.undo" ? "undo" : "redo", { projectId, sessionId: cmd.sessionId, commandId: cmd.commandId, baseRevision: cmd.baseRevision });
        this.#daemon?.sendSnapshot();
        return answer({ action: cmd.type.slice(5), commandId: cmd.commandId, ...r });
      }
      case "edit.end": {
        const r = edits.end(deviceId, projectId, cmd.sessionId);
        this.#daemon?.sendSnapshot();
        return answer({ action: "end", ...r });
      }
    }
    throw new ReelForgeError("VALIDATION_ERROR", "unknown edit command");
  }

  /** A source still or filmstrip for the editor, as a sealed blob for the phone that asked. */
  async #frame(deviceId: string, cmd: RemoteCommand): Promise<Record<string, unknown>> {
    const frames = this.#opts.frames;
    if (!frames) throw new ReelForgeError("UNAVAILABLE", "This Mac's ReelForge can't send pictures to the editor.");
    const projectId = uuidOf(cmd.projectId, "project");
    const assetId = uuidOf(cmd.assetId, "asset");
    const tl = new TimelineStore(this.#opts.db).get(projectId);
    const asset = tl.assets.find((a) => a.id === assetId);
    if (!asset) throw new ReelForgeError("NOT_FOUND", "That media isn't in this project.");
    if (cmd.type === "edit.strip") {
      const strip = await frames.filmstrip(asset);
      const blob = await this.#connected().putBlob(deviceId, { type: "image/jpeg", data: readFileSync(strip.path).toString("base64") });
      return { t: "strip", projectId, assetId, blob, count: strip.count, stepUs: strip.stepUs };
    }
    const frame = Number(cmd.sourceFrame);
    if (!Number.isInteger(frame) || frame < 0) throw new ReelForgeError("VALIDATION_ERROR", "bad frame");
    const fps = tl.project.settings.fps;
    const want = `${projectId}:${assetId}:${frame}`;
    this.#wantStill.set(deviceId, want);
    const path = await frames.still(asset, (frame * fps.den * 1_000_000) / fps.num, () => this.#wantStill.get(deviceId) === want);
    const blob = await this.#connected().putBlob(deviceId, { type: "image/jpeg", data: readFileSync(path).toString("base64") });
    return { t: "still", projectId, assetId, sourceFrame: frame, blob };
  }

  /** The relay connection, or a clean error if the remote was stopped while a command ran. */
  #connected(): RemoteDaemon {
    if (!this.#daemon) throw new ReelForgeError("UNAVAILABLE", "The phone remote is off on this Mac.");
    return this.#daemon;
  }

  #deviceName(deviceId: string): string {
    return this.#readDevices().devices.find((d) => d.id === deviceId)?.name ?? "A phone";
  }

  /** A finished export or preview, to the phone that asked, in pieces. */
  async #sendFile(deviceId: string, cmd: RemoteCommand, reply: (e: Record<string, unknown>) => void): Promise<void> {
    const jobId = uuidOf(cmd.jobId, "job");
    const transferId = typeof cmd.transferId === "string" && TRANSFER_ID.test(cmd.transferId) ? cmd.transferId : null;
    if (!transferId) throw new ReelForgeError("VALIDATION_ERROR", "bad transfer id");
    const jobStore = new JobStore(this.#opts.db);
    const job = jobStore.get(jobId);
    if (job.state !== "completed") throw new ReelForgeError("VALIDATION_ERROR", "That render hasn't finished.");
    // Exports are recorded as artifacts; previews only have the job's output file.
    const path = jobStore.artifacts(job.projectId).find((a) => a.jobId === jobId)?.path ?? job.outputPath;
    if (!path || !existsSync(path)) throw new ReelForgeError("NOT_FOUND", "The file is no longer on your Mac (moved or deleted).");
    const size = statSync(path).size;
    reply({ t: "file", state: "sending", transferId, jobId, name: basename(path), type: "video/mp4", size, pieces: Math.max(1, Math.ceil(size / PIECE_BYTES)) });
    try {
      await this.#connected().sendFile(deviceId, transferId, path, size);
      reply({ t: "file", state: "sent", transferId, jobId });
    } catch (e) {
      reply({ t: "file", state: errText(e) === "cancelled" ? "cancelled" : "failed", transferId, jobId, message: errText(e) });
    }
  }

  /** A file the phone attaches (a clip, a photo): received into <dir>/uploads, then imported into the project. */
  async #receiveUpload(deviceId: string, cmd: RemoteCommand, reply: (e: Record<string, unknown>) => void): Promise<void> {
    const projectId = uuidOf(cmd.projectId, "project");
    const uploadId = typeof cmd.uploadId === "string" && TRANSFER_ID.test(cmd.uploadId) ? cmd.uploadId : null;
    const size = Number(cmd.size);
    if (!uploadId || !Number.isInteger(size) || size <= 0 || size > MAX_UPLOAD_BYTES) throw new ReelForgeError("VALIDATION_ERROR", "That file can't be sent (up to 4 GB).");
    if (!this.#opts.media) throw new ReelForgeError("UNAVAILABLE", "This Mac's ReelForge can't import files from the phone.");
    new ProjectStore(this.#opts.db).get(projectId);
    const name = safeFileName(typeof cmd.name === "string" ? cmd.name : "upload") || "upload";
    const dir = join(this.#opts.dir, "uploads", projectId);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const path = uniquePath(dir, name);
    const abort = new AbortController();
    this.#uploads.set(uploadId, abort);
    reply({ t: "upload", uploadId, state: "receiving" });
    try {
      const got = await this.#connected().receiveFile(deviceId, uploadId, Math.ceil(size / PIECE_BYTES), createWriteStream(path, { mode: 0o600 }), abort.signal);
      if (got !== size) throw new Error("the file arrived incomplete");
      const asset = await this.#opts.media.importFile(projectId, path);
      reply({ t: "upload", uploadId, state: "imported", projectId, assetId: asset.assetId, filename: asset.filename });
      this.#daemon?.sendSnapshot();
    } catch (e) {
      rmSync(path, { force: true });
      reply({ t: "upload", uploadId, state: abort.signal.aborted ? "cancelled" : "failed", message: errText(e) });
    } finally {
      this.#uploads.delete(uploadId);
    }
  }

  /** A queued instruction the relay held until this Mac took it. Runs at most once (the daemon saw to that). */
  async #onQueued(item: QueuedInstruction): Promise<void> {
    const d = this.#daemon;
    if (!d) return;
    const tell = (event: Record<string, unknown>) => d.sendTo(item.deviceId, { t: "queue", id: item.id, projectId: item.projectId, ...event });
    this.#touchDevice(item.deviceId);
    const b = item.body;
    if (item.expiresAt <= Date.now()) return tell({ state: "expired" });
    if (b.type !== "ai.ask") return tell({ state: "failed", message: "This kind of instruction can't be queued." });
    let project;
    try {
      project = new ProjectStore(this.#opts.db).get(item.projectId);
    } catch {
      return tell({ state: "failed", message: "That project is no longer on your Mac." });
    }
    // Someone is editing by hand: the instruction waits for the user's say-so instead of running underneath.
    if (this.#edits.lease(item.projectId)) {
      return tell({ state: "needs_review", reason: "editing", baseRevision: b.baseRevision, currentRevision: project.revision, instruction: b.instruction });
    }
    // Written against an older timeline: the user decides whether it still makes sense, not this Mac.
    if (typeof b.baseRevision === "number" && b.baseRevision !== project.revision) {
      return tell({ state: "needs_review", baseRevision: b.baseRevision, currentRevision: project.revision, instruction: b.instruction });
    }
    tell({ state: "accepted" });
    let run: Promise<AIProposal>;
    try {
      // Queued without a model (the phone never saw this Mac's list): the one this project used last, else
      // the first local model that is ready.
      let { provider, model } = b as { provider?: unknown; model?: unknown };
      if (typeof provider !== "string" || typeof model !== "string") {
        const o = await this.aiOptions(item.projectId);
        const local = o.providers.find((x) => x.ready && !x.external && x.models.length);
        const pick = o.last ?? (local ? { provider: local.id, model: local.defaultModel ?? local.models[0]! } : null);
        if (!pick) throw new ReelForgeError("UNAVAILABLE", "No model is set up on your Mac. Open AI Director there once.");
        ({ provider, model } = pick);
      }
      let instruction = typeof b.instruction === "string" ? b.instruction : "";
      // "Request a change" from Review: the model is told which version the request is about.
      if (typeof b.about === "string" && UUID.test(b.about)) {
        try {
          const v = new ProposalStore(this.#opts.db).get(b.about);
          if (v.projectId === item.projectId) instruction = `${instruction}\n\n(About the earlier proposal "${clip(v.summary, 200)}", which was ${v.status}.)`;
        } catch {
          // gone: the instruction stands alone
        }
      }
      run = this.ask(item.projectId, { instruction, provider, model }, { queueId: item.id, deviceId: item.deviceId });
    } catch (e) {
      return tell({ state: "failed", code: codeOf(e), message: errText(e) });
    }
    tell({ state: "running" });
    d.sendSnapshot();
    try {
      const proposal = await run;
      tell({ state: "done", proposalId: proposal.id });
    } catch (e) {
      tell({ state: errText(e) === "Cancelled." ? "cancelled" : "failed", code: codeOf(e), message: errText(e) });
    }
    d.sendSnapshot();
  }

  // ── poster ───────────────────────────────────────────────────────────────

  async poster(projectId: string): Promise<{ key: string; type: "image/jpeg" | "image/png"; data: Buffer } | null> {
    if (!this.#opts.thumbnail) return null;
    const tl = new TimelineStore(this.#opts.db).get(projectId);
    const position = new Map(tl.tracks.map((t) => [t.id, t]));
    const byId = new Map(tl.assets.map((a) => [a.id, a]));
    const visual = (a: Asset | undefined): a is Asset => !!a && a.kind !== "audio" && a.status !== "missing";
    const onTimeline = tl.clips
      .filter((c) => {
        const t = position.get(c.trackId);
        return t && !t.hidden && (t.kind === "video" || t.kind === "overlay") && visual(byId.get(c.assetId));
      })
      .sort((a, b) => a.start - b.start || position.get(a.trackId)!.position - position.get(b.trackId)!.position)
      .map((c) => byId.get(c.assetId)!);
    const candidates = [...onTimeline, ...tl.assets.filter(visual)];
    for (const asset of candidates.slice(0, 3)) {
      try {
        const thumb = await this.#opts.thumbnail(asset);
        if (statSync(thumb.path).size > MAX_POSTER_BYTES) continue;
        const data = readFileSync(thumb.path);
        return { key: createHash("sha256").update(`${asset.id}:${asset.sizeBytes}`).digest("base64url").slice(0, 16), type: thumb.contentType, data };
      } catch (e) {
        this.#opts.log?.(`no poster from ${asset.filename}: ${e instanceof Error ? e.message : e}`);
      }
    }
    return null;
  }

  // ── notifications ────────────────────────────────────────────────────────

  #readPush(): PushFile {
    const raw = this.#readJson<PushFile>(this.#pushFile);
    return { vapid: raw.vapid ?? null, subscriptions: Array.isArray(raw.subscriptions) ? raw.subscriptions : [] };
  }

  #writePush(p: PushFile): void {
    this.#writeJson(this.#pushFile, p);
  }

  #vapid(): VapidKeys {
    const p = this.#readPush();
    if (p.vapid) return p.vapid;
    const vapid = newVapidKeys();
    this.#writePush({ ...p, vapid });
    return vapid;
  }

  #subscribe(deviceId: string, input: { endpoint: unknown; keys: unknown; prefs: unknown }): PushPrefs {
    const endpoint = checkEndpoint(input.endpoint, this.#opts.allowLocalPush);
    const keys = input.keys as { p256dh?: unknown; auth?: unknown } | null;
    const p256dh = typeof keys?.p256dh === "string" ? keys.p256dh : "";
    const auth = typeof keys?.auth === "string" ? keys.auth : "";
    if (Buffer.from(p256dh, "base64url").length !== 65 || Buffer.from(auth, "base64url").length !== 16) throw new Error("the browser's push keys are malformed");
    const raw = (input.prefs ?? {}) as Partial<Record<keyof PushPrefs, unknown>>;
    const prefs: PushPrefs = {
      exports: typeof raw.exports === "boolean" ? raw.exports : DEFAULT_PREFS.exports,
      proposals: typeof raw.proposals === "boolean" ? raw.proposals : DEFAULT_PREFS.proposals,
      failures: typeof raw.failures === "boolean" ? raw.failures : DEFAULT_PREFS.failures,
    };
    this.#vapid();
    const p = this.#readPush();
    const others = p.subscriptions.filter((s) => s.endpoint !== endpoint);
    if (others.length >= MAX_PHONES) throw new Error(`Notifications are on for ${MAX_PHONES} phones already. Turn them off on one first.`);
    this.#writePush({ ...p, subscriptions: [...others, { endpoint, keys: { p256dh, auth }, prefs, createdAt: new Date().toISOString(), deviceId }] });
    if (!this.#seen) this.#seen = this.#look().seen;
    return prefs;
  }

  #unsubscribe(endpoint: unknown): void {
    const p = this.#readPush();
    this.#writePush({ ...p, subscriptions: p.subscriptions.filter((s) => s.endpoint !== endpoint) });
  }

  async #notify(kind: keyof PushPrefs, message: { title: string; body: string; tag: string; url: string }, only?: string): Promise<void> {
    const p = this.#readPush();
    if (!p.vapid) return;
    const subject = this.#read().url ?? "https://github.com/ToingSeeker/reelforge";
    const gone: string[] = [];
    for (const sub of p.subscriptions) {
      if (only ? sub.endpoint !== only : !sub.prefs[kind]) continue;
      try {
        const r = await sendPush(sub, message, p.vapid, subject, this.#opts.pushFetch);
        if (r.gone) gone.push(sub.endpoint);
        else if (r.status >= 400) this.#opts.log?.(`push service answered HTTP ${r.status}`);
      } catch (e) {
        if (only) throw e;
        this.#opts.log?.(`couldn't send a notification: ${e instanceof Error ? e.message : e}`);
      }
    }
    if (gone.length) {
      const now = this.#readPush();
      this.#writePush({ ...now, subscriptions: now.subscriptions.filter((s) => !gone.includes(s.endpoint)) });
    }
  }

  async #testPush(endpoint: unknown): Promise<void> {
    if (!this.#readPush().subscriptions.some((s) => s.endpoint === endpoint)) throw new Error("Notifications aren't on for this phone.");
    await this.#notify("exports", { title: "ReelForge", body: "Notifications from your Mac are working.", tag: "test", url: "/" }, endpoint as string);
  }

  #look() {
    const projectStore = new ProjectStore(this.#opts.db);
    const jobStore = new JobStore(this.#opts.db);
    const proposalStore = new ProposalStore(this.#opts.db);
    const since = Date.now() - RECENT_MS;
    const names = new Map<string, string>();
    const finished: { id: string; projectId: string; state: string; error: string | null; sizeBytes: number | null }[] = [];
    const pending: { id: string; projectId: string; summary: string }[] = [];
    for (const p of projectStore.list().slice(0, MAX_PROJECTS)) {
      names.set(p.id, p.name);
      let sizes: Map<string, number> | undefined;
      for (const j of jobStore.list(p.id, { limit: 20, kind: "export" })) {
        if (!j.finishedAt || Date.parse(j.finishedAt) < since || ACTIVE_JOB_STATES.includes(j.state)) continue;
        sizes ??= new Map(jobStore.artifacts(p.id).map((a) => [a.jobId, a.sizeBytes]));
        finished.push({ id: j.id, projectId: p.id, state: j.state, error: j.error?.message ?? null, sizeBytes: sizes.get(j.id) ?? null });
      }
      for (const x of proposalStore.list(p.id, 20)) if (x.status === "pending") pending.push({ id: x.id, projectId: p.id, summary: x.summary });
    }
    return { names, finished, pending, seen: { finished: new Set(finished.map((j) => j.id)), proposals: new Set(pending.map((x) => x.id)) } };
  }

  async #scan(): Promise<void> {
    if (this.#readPush().subscriptions.length === 0) {
      this.#seen = null;
      return;
    }
    const { names, finished, pending, seen: now } = this.#look();
    const seen = this.#seen;
    this.#seen = now;
    if (!seen) return;
    for (const j of finished) {
      if (seen.finished.has(j.id) || j.state === "cancelled") continue;
      const name = names.get(j.projectId) ?? "A project";
      if (j.state === "completed") {
        const size = j.sizeBytes ? ` · ${formatSize(j.sizeBytes)}` : "";
        await this.#notify("exports", { title: "Export completed", body: `“${clip(name)}”${size}`, tag: `job-${j.id}`, url: "/#/exports" });
      } else {
        await this.#notify("failures", { title: "Export failed", body: `“${clip(name)}”: ${clip(j.error ?? "unknown error", 160)}`, tag: `job-${j.id}`, url: "/#/exports" });
      }
    }
    for (const x of pending) {
      if (seen.proposals.has(x.id)) continue;
      await this.#notify("proposals", { title: "Review ready", body: `“${clip(names.get(x.projectId) ?? "A project")}”: ${clip(x.summary, 160)}`, tag: `proposal-${x.id}`, url: `/#/review/${x.projectId}/${x.id}` });
    }
  }

  #startNotifier(): void {
    clearInterval(this.#notifier);
    this.#seen = null;
    let busy = false;
    const tick = () => {
      if (busy) return;
      busy = true;
      this.#scan()
        .catch((e) => this.#opts.log?.(`notifications: ${e instanceof Error ? e.message : e}`))
        .finally(() => (busy = false));
    };
    tick();
    this.#notifier = setInterval(tick, this.#opts.notifyMs ?? 2000);
  }

  // ── connection ───────────────────────────────────────────────────────────

  #launch(url: string, secret: string): void {
    const agent = deriveKeys(secret);
    const handled = this.#handledMap();
    const daemon = new RemoteDaemon({
      url,
      keys: {
        agentToken: agent.token,
        broadcastKey: () => Buffer.from(this.#readDevices().broadcastKey, "base64"),
        deviceKey: (id) => {
          const d = this.#readDevices().devices.find((x) => x.id === id);
          return d ? deriveDeviceKeys(d.secret).key : null;
        },
        devices: () => this.#readDevices().devices.map((d) => ({ id: d.id, tokenHash: deriveDeviceKeys(d.secret).tokenHash })),
      },
      handled: {
        has: (id) => (handled.get(id) ?? 0) > Date.now(),
        add: (id, until) => {
          handled.set(id, until);
          this.#saveHandledSoon();
        },
      },
      state: () => this.state(),
      liveKey: "jobs",
      onCommand: (deviceId, cmd) => this.#onCommand(deviceId, cmd),
      onQueued: (item) => this.#onQueued(item),
      onPair: (lookup, hello) => this.#onPair(lookup, hello),
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
    this.#startNotifier();
  }

  async #teardown(): Promise<void> {
    for (const ask of this.#asks.values()) ask.abort.abort();
    for (const u of this.#uploads.values()) u.abort();
    clearInterval(this.#notifier);
    this.#notifier = undefined;
    const p = this.#pairing;
    if (p && (p.state === "open" || p.state === "answered")) {
      p.state = "cancelled";
      if (p.deviceId) this.#removeDevice(p.deviceId, { onlyUnconfirmed: true });
    }
    const d = this.#daemon;
    this.#daemon = undefined;
    await d?.stop();
  }
}

// ── helpers ────────────────────────────────────────────────────────────────

/** Version number of the proposal whose application produced `revision` (or null). */
function versionLookup(proposals: AIProposal[]): (revision: number) => number | null {
  const ordered = [...proposals].reverse();
  const byRevision = new Map<number, number>();
  ordered.forEach((x, i) => {
    if (x.appliedRevision !== null) byRevision.set(x.appliedRevision, i + 1);
  });
  return (revision) => byRevision.get(revision) ?? null;
}

function uuidOf(value: unknown, what: string): string {
  if (typeof value !== "string" || !UUID.test(value)) throw new ReelForgeError("VALIDATION_ERROR", `That ${what} id isn't valid.`);
  return value;
}

/** Who is editing what. The session id is only told to the phone that holds the lease (`viewer`). */
function editingOf(l: EditLease, viewer?: string): RemoteEditing {
  return { projectId: l.projectId, deviceId: l.deviceId, deviceName: l.deviceName, ...(viewer === l.deviceId ? { sessionId: l.sessionId } : {}), startedAt: l.startedAt, expiresAt: new Date(l.expiresAt).toISOString() };
}

/** What an edit failure says beyond its message: revisions, who holds the lease, which operation failed. */
function detailsOf(e: unknown): Record<string, unknown> | null {
  const d = e instanceof EditError || e instanceof ReelForgeError ? e.details : null;
  if (!d) return null;
  const keep: Record<string, unknown> = {};
  for (const k of ["currentRevision", "baseRevision", "deviceName", "expiresAt", "opIndex", "clipId", "captionId", "overlaps"]) if (k in d) keep[k] = d[k];
  return keep;
}

/** ReelForgeError's code (CONSENT_REQUIRED, REVISION_CONFLICT, …), so the phone can say what to do. */
function codeOf(e: unknown): string | null {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^[A-Z_]{2,40}$/.test(code) ? code : null;
}

function fileSize(path: string | null): number | null {
  try {
    return path ? statSync(path).size : null;
  } catch {
    return null;
  }
}

function clip(text: string, max = 60): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function cleanName(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 40);
}

function formatSize(bytes: number): string {
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${(bytes / 1e6).toFixed(1)} MB`;
}

/** A file name from user text: no path separators, no control characters, no leading dot. */
export function safeFileName(name: string): string {
  const ext = extname(name).slice(0, 10);
  const stem = basename(name, extname(name))
    .replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .slice(0, 80);
  return `${stem || "ReelForge"}${ext.replace(/[^.A-Za-z0-9]/g, "")}`;
}

function uniquePath(dir: string, name: string): string {
  const ext = extname(name);
  const stem = basename(name, ext);
  for (let i = 1; ; i++) {
    const candidate = join(dir, i === 1 ? name : `${stem} (${i})${ext}`);
    if (!existsSync(candidate)) return candidate;
  }
}

/** ~/Movies/ReelForge → "Movies › ReelForge" (the phone has no use for the full path). */
function prettyFolder(dir: string): string {
  const home = homedir();
  const rel = dir.startsWith(home + "/") ? dir.slice(home.length + 1) : dir;
  return rel.split("/").filter(Boolean).slice(-3).join(" › ");
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

