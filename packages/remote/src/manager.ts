// Runs the phone remote inside the engine process (`reelforge serve`), the way ConnectorManager runs
// the Claude/ChatGPT connector. Settings → Phone remote drives it over the local API. The secret and
// relay URL live in <home>/remote/settings.json (0600); the secret never leaves this Mac except inside
// the pairing link/QR shown to the owner.

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { ACTIVE_JOB_STATES, JobStore, ProjectStore, ProposalStore, ReelForgeError, TimelineStore, type Asset, type Database } from "@reelforge/core";
import {
  RemoteDaemon,
  type DaemonStatus,
  type PushPrefs,
  type PushSubscribeInput,
  type RemoteFinishedJob,
  type RemoteJob,
  type RemotePoster,
  type RemoteProject,
  type RemoteProjectDetail,
  type RemoteState,
} from "./daemon.ts";
import { deriveKeys, newSecret } from "./keys.ts";
import { checkEndpoint, newVapidKeys, sendPush, type PushSubscription, type VapidKeys } from "./push.ts";

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
  /** Phones that asked for notifications. */
  notifications: number;
}

export interface RemoteManagerOptions {
  db: Database;
  /** State directory (settings.json). */
  dir: string;
  version: string;
  log?: (line: string) => void;
  /** Makes (or finds cached) a still for an asset; the project's poster. Without it, projects have no poster. */
  thumbnail?: (asset: Asset) => Promise<{ path: string; contentType: "image/jpeg" | "image/png" }>;
  /** Overrides for tests. */
  deviceName?: string;
  watchMs?: number;
  /** How often finished exports and new proposals are looked for (notifications). Default 2 s. */
  notifyMs?: number;
  pushFetch?: typeof fetch;
  /** Accept http://127.0.0.1 push endpoints (tests only). */
  allowLocalPush?: boolean;
}

interface Stored {
  url: string | null;
  autoStart: boolean;
  secret: string;
}

interface StoredSubscription extends PushSubscription {
  prefs: PushPrefs;
  createdAt: string;
}

interface PushFile {
  vapid: VapidKeys | null;
  subscriptions: StoredSubscription[];
}

/** Most recent projects shown on the phone. */
const MAX_PROJECTS = 50;
const MAX_PHONES = 10;
/** A finished export stays on Home (and counts for notifications) this long. */
const RECENT_MS = 24 * 3600 * 1000;
const MAX_TRACK_CLIPS = 200;
const MAX_POSTER_BYTES = 400 * 1024;
const DEFAULT_PREFS: PushPrefs = { exports: true, proposals: true, failures: true };

export class RemoteManager {
  readonly #opts: RemoteManagerOptions;
  readonly #file: string;
  readonly #pushFile: string;
  #daemon: RemoteDaemon | undefined;
  #error: string | null = null;
  #notifier: ReturnType<typeof setInterval> | undefined;
  /** What the notifier saw last time; null until its first look (nothing is announced from before). */
  #seen: { finished: Set<string>; proposals: Set<string> } | null = null;

  constructor(opts: RemoteManagerOptions) {
    this.#opts = opts;
    this.#file = join(opts.dir, "settings.json");
    this.#pushFile = join(opts.dir, "push.json");
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
      notifications: this.#readPush().subscriptions.length,
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
    // Phones paired with the old secret are locked out; so are their notifications.
    this.#writePush({ ...this.#readPush(), subscriptions: [] });
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
    const recent: RemoteFinishedJob[] = [];
    const since = Date.now() - RECENT_MS;
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
      let sizes: Map<string, number> | undefined;
      for (const j of jobStore.list(p.id, { limit: 20 })) {
        if (ACTIVE_JOB_STATES.includes(j.state)) {
          jobs.push({ id: j.id, projectId: j.projectId, kind: j.kind, state: j.state, progress: Math.round(j.progress * 1000) / 1000, createdAt: j.createdAt });
        } else if (j.kind === "export" && j.finishedAt && Date.parse(j.finishedAt) >= since) {
          sizes ??= new Map(jobStore.artifacts(p.id).map((a) => [a.jobId, a.sizeBytes]));
          recent.push({
            id: j.id,
            projectId: j.projectId,
            kind: j.kind,
            state: j.state as RemoteFinishedJob["state"],
            error: j.error?.message ?? null,
            finishedAt: j.finishedAt,
            sizeBytes: sizes.get(j.id) ?? null,
          });
        }
      }
    }
    recent.sort((a, b) => b.finishedAt.localeCompare(a.finishedAt));
    return { projects, jobs, recent: recent.slice(0, 10) };
  }

  /** One project for the phone's detail screen. */
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
          clips: items
            .map((c) => ({ start: c.start, duration: c.duration }))
            .sort((a, b) => a.start - b.start)
            .slice(0, MAX_TRACK_CLIPS),
        };
      });
    const proposals = new ProposalStore(this.#opts.db)
      .list(projectId, 20)
      .sort((a, b) => Number(b.status === "pending") - Number(a.status === "pending"))
      .slice(0, 5)
      .map((x) => ({ id: x.id, status: x.status, instruction: x.instruction, summary: x.summary, changes: x.changes.length, provider: x.provider, model: x.model, createdAt: x.createdAt }));
    const jobs = jobStore.list(projectId, { limit: 5 }).map((j) => ({
      id: j.id,
      kind: j.kind,
      state: j.state,
      progress: Math.round(j.progress * 1000) / 1000,
      error: j.error?.message ?? null,
      createdAt: j.createdAt,
      finishedAt: j.finishedAt,
      sizeBytes: sizes.get(j.id) ?? null,
    }));
    return {
      id: p.id,
      name: p.name,
      revision: p.revision,
      width: p.settings.width,
      height: p.settings.height,
      fps: Math.round((p.settings.fps.num / p.settings.fps.den) * 100) / 100,
      updatedAt: p.updatedAt,
      durationFrames: tl.durationFrames,
      canUndo: tl.history.canUndo,
      canRedo: tl.history.canRedo,
      tracks,
      clips: tl.clips.length,
      captions: tl.captions.length,
      assets,
      proposals,
      jobs,
    };
  }

  /**
   * The project's poster: a still of the first picture on the timeline (the top track wins a tie),
   * or of the first picture imported when the timeline is empty.
   */
  async poster(projectId: string): Promise<RemotePoster | null> {
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
    try {
      const raw = JSON.parse(readFileSync(this.#pushFile, "utf8")) as Partial<PushFile>;
      return { vapid: raw.vapid ?? null, subscriptions: Array.isArray(raw.subscriptions) ? raw.subscriptions : [] };
    } catch {
      return { vapid: null, subscriptions: [] };
    }
  }

  #writePush(p: PushFile): void {
    mkdirSync(this.#opts.dir, { recursive: true, mode: 0o700 });
    writeFileSync(this.#pushFile, JSON.stringify(p, null, 2), { mode: 0o600 });
  }

  /** This Mac's VAPID key pair, made on first use. */
  #vapid(): VapidKeys {
    const p = this.#readPush();
    if (p.vapid) return p.vapid;
    const vapid = newVapidKeys();
    this.#writePush({ ...p, vapid });
    return vapid;
  }

  #subscribe(input: PushSubscribeInput): PushPrefs {
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
    this.#writePush({ ...p, subscriptions: [...others, { endpoint, keys: { p256dh, auth }, prefs, createdAt: new Date().toISOString() }] });
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

  /** Looks for exports that just finished and proposals that just arrived; tells the subscribed phones. */
  async #scan(): Promise<void> {
    if (this.#readPush().subscriptions.length === 0) {
      this.#seen = null; // nobody to tell; start fresh when someone subscribes
      return;
    }
    const state = this.state();
    const names = new Map(state.projects.map((p) => [p.id, p.name]));
    const proposalStore = new ProposalStore(this.#opts.db);
    const pending: { id: string; projectId: string; summary: string }[] = [];
    for (const p of state.projects) {
      if (p.pendingProposals === 0) continue;
      for (const x of proposalStore.list(p.id, 20)) if (x.status === "pending") pending.push({ id: x.id, projectId: p.id, summary: x.summary });
    }
    const seen = this.#seen;
    this.#seen = { finished: new Set(state.recent.map((j) => j.id)), proposals: new Set(pending.map((x) => x.id)) };
    if (!seen) return;
    for (const j of state.recent) {
      if (seen.finished.has(j.id) || j.state === "cancelled") continue;
      const name = names.get(j.projectId) ?? "A project";
      if (j.state === "completed") {
        const size = j.sizeBytes ? ` · ${formatSize(j.sizeBytes)}` : "";
        await this.#notify("exports", { title: "Export ready", body: `“${clip(name)}”${size}`, tag: `job-${j.id}`, url: `/#/p/${j.projectId}` });
      } else {
        await this.#notify("failures", { title: "Export failed", body: `“${clip(name)}”: ${clip(j.error ?? "unknown error", 160)}`, tag: `job-${j.id}`, url: `/#/p/${j.projectId}` });
      }
    }
    for (const x of pending) {
      if (seen.proposals.has(x.id)) continue;
      await this.#notify("proposals", {
        title: "AI Director has a proposal",
        body: `“${clip(names.get(x.projectId) ?? "A project")}”: ${clip(x.summary, 160)}`,
        tag: `proposal-${x.id}`,
        url: `/#/p/${x.projectId}`,
      });
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

  #launch(url: string, secret: string): void {
    const daemon = new RemoteDaemon({
      url,
      secret,
      device: { name: this.#opts.deviceName ?? hostname().replace(/\.local$/, ""), version: this.#opts.version },
      state: () => this.state(),
      handlers: {
        project: (id) => this.project(id),
        poster: (id) => this.poster(id),
        push: {
          publicKey: () => this.#vapid().publicKey,
          subscribe: (input) => this.#subscribe(input),
          unsubscribe: (endpoint) => this.#unsubscribe(endpoint),
          test: (endpoint) => this.#testPush(endpoint),
        },
      },
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
    clearInterval(this.#notifier);
    this.#notifier = undefined;
    const d = this.#daemon;
    this.#daemon = undefined;
    await d?.stop();
  }
}

function clip(text: string, max = 60): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function formatSize(bytes: number): string {
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${(bytes / 1e6).toFixed(1)} MB`;
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
