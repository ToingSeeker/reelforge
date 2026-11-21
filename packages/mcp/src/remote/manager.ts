// Runs the remote connector inside a long-lived process (the desktop engine, or `reelforge connector`)
// and owns its tunnel. The desktop Settings screen drives it over the local API: start/stop, show the
// MCP link and access key, generate a new key, disconnect apps. Choices persist in settings.json so
// the connector comes back when the app restarts.

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { ReelForgeError, type Database } from "@reelforge/core";
import { ConnectorAuth } from "./auth.ts";
import { startRemoteConnector, type RunningConnector } from "./http.ts";

export type TunnelKind = "ngrok" | "none";

export interface ConnectorSettings {
  tunnel: TunnelKind;
  /** A reserved ngrok domain, so the link stays the same across restarts. */
  domain?: string;
  /** An https origin for a tunnel the user runs themselves (tunnel "none"). */
  publicUrl?: string;
  /** Start with the engine. Set by start(), cleared by stop(). */
  autoStart: boolean;
}

export interface ConnectorStatus {
  state: "stopped" | "starting" | "running";
  /** What to paste into Claude / ChatGPT. Only public (https) once a tunnel is up. */
  mcpUrl: string | null;
  localUrl: string | null;
  /** True when Claude/ChatGPT can reach mcpUrl (an https tunnel). */
  public: boolean;
  accessKey: string;
  settings: ConnectorSettings;
  ngrokAvailable: boolean;
  /** Why the last start failed, or why it stopped. */
  error: string | null;
  connections: { clientName: string; createdAt: string; active: boolean }[];
}

export interface ConnectorManagerOptions {
  db: Database;
  /** Connector state directory (auth.json, settings.json, uploads, exports). */
  dir: string;
  cacheDir: string;
  exportsDir?: string;
  /** Local port for the connector; 0 picks one. Default 4410, falling back to a free port. */
  port?: number;
  log?: (line: string) => void;
}

const DEFAULT_SETTINGS: ConnectorSettings = { tunnel: "ngrok", autoStart: false };

export class ConnectorManager {
  readonly #opts: ConnectorManagerOptions;
  readonly #settingsFile: string;
  #conn: RunningConnector | undefined;
  #tunnel: ChildProcess | undefined;
  #starting: Promise<void> | undefined;
  #error: string | null = null;

  constructor(opts: ConnectorManagerOptions) {
    this.#opts = opts;
    this.#settingsFile = join(opts.dir, "settings.json");
  }

  get #authFile() {
    return join(this.#opts.dir, "auth.json");
  }

  /** The live auth when running; otherwise read from disk (only one instance writes at a time). */
  #auth(): ConnectorAuth {
    return this.#conn?.auth ?? new ConnectorAuth(this.#authFile);
  }

  settings(): ConnectorSettings {
    try {
      const raw = JSON.parse(readFileSync(this.#settingsFile, "utf8")) as Partial<ConnectorSettings>;
      return {
        tunnel: raw.tunnel === "none" ? "none" : "ngrok",
        autoStart: raw.autoStart === true,
        ...(typeof raw.domain === "string" && raw.domain ? { domain: raw.domain } : {}),
        ...(typeof raw.publicUrl === "string" && raw.publicUrl ? { publicUrl: raw.publicUrl } : {}),
      };
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  }

  #saveSettings(s: ConnectorSettings): void {
    mkdirSync(this.#opts.dir, { recursive: true, mode: 0o700 });
    writeFileSync(this.#settingsFile, JSON.stringify(s, null, 2), { mode: 0o600 });
  }

  status(): ConnectorStatus {
    const auth = this.#auth();
    const conn = this.#conn;
    const pub = conn?.publicUrl() ?? "";
    return {
      state: this.#starting ? "starting" : conn ? "running" : "stopped",
      mcpUrl: conn ? `${pub}/mcp` : null,
      localUrl: conn?.localUrl ?? null,
      public: !!conn && pub.startsWith("https://"),
      accessKey: auth.pairingCode,
      settings: this.settings(),
      ngrokAvailable: !!ngrokBinary(),
      error: this.#error,
      connections: auth.connections(),
    };
  }

  /**
   * Start (or restart with new settings). By default remembers the settings and turns on auto-start;
   * `remember: false` (the CLI) leaves the app's saved choices alone.
   */
  async start(input: { tunnel?: TunnelKind; domain?: string | null; publicUrl?: string | null; remember?: boolean } = {}): Promise<ConnectorStatus> {
    if (this.#starting) return this.#starting.then(() => this.status());
    const prev = this.settings();
    const next: ConnectorSettings = { tunnel: input.tunnel ?? prev.tunnel, autoStart: true };
    const domain = input.domain === undefined ? prev.domain : input.domain?.trim() || undefined;
    const publicUrl = input.publicUrl === undefined ? prev.publicUrl : input.publicUrl?.trim().replace(/\/+$/, "") || undefined;
    if (domain) {
      const d = domain.replace(/^https?:\/\//, "").replace(/\/+$/, "");
      if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(d)) throw new ReelForgeError("VALIDATION_ERROR", "the ngrok domain should look like name.ngrok-free.app");
      next.domain = d;
    }
    if (publicUrl) {
      if (!/^https:\/\/[^/\s]+$/.test(publicUrl)) throw new ReelForgeError("VALIDATION_ERROR", "the public URL must be an https origin, like https://reelforge.example.com");
      next.publicUrl = publicUrl;
    }
    this.#starting = (async () => {
      await this.#teardown();
      this.#error = null;
      try {
        await this.#launch(next);
        if (input.remember !== false) this.#saveSettings(next);
      } catch (e) {
        this.#error = e instanceof Error ? e.message : String(e);
        await this.#teardown();
        throw e;
      }
    })().finally(() => {
      this.#starting = undefined;
    });
    await this.#starting;
    return this.status();
  }

  /** Start if the user left it on last time. Failures are recorded in status(), not thrown. */
  async autoStart(): Promise<void> {
    if (!this.settings().autoStart) return;
    await this.start().catch((e) => this.#opts.log?.(`auto-start failed: ${e instanceof Error ? e.message : e}`));
  }

  async stop(): Promise<ConnectorStatus> {
    await this.#starting?.catch(() => {});
    await this.#teardown();
    this.#error = null;
    this.#saveSettings({ ...this.settings(), autoStart: false });
    return this.status();
  }

  rotateKey(): ConnectorStatus {
    this.#auth().rotatePairingCode();
    return this.status();
  }

  /** Disconnect every app (they must connect again with the new key). */
  revokeAll(): ConnectorStatus {
    this.#auth().revokeAll();
    return this.status();
  }

  /** For process shutdown: stop without touching auto-start. */
  async close(): Promise<void> {
    await this.#starting?.catch(() => {});
    await this.#teardown();
  }

  async #launch(s: ConnectorSettings): Promise<void> {
    const base = {
      db: this.#opts.db,
      dir: this.#opts.dir,
      cacheDir: this.#opts.cacheDir,
      ...(this.#opts.exportsDir ? { exportsDir: this.#opts.exportsDir } : {}),
      ...(s.tunnel === "none" && s.publicUrl ? { publicUrl: s.publicUrl } : {}),
      ...(this.#opts.log ? { log: this.#opts.log } : {}),
    };
    const wanted = this.#opts.port ?? 4410;
    try {
      this.#conn = await startRemoteConnector({ ...base, port: wanted });
    } catch (e) {
      // A fixed port in use (another connector, another app): any free port works; the tunnel follows it.
      if ((e as NodeJS.ErrnoException).code !== "EADDRINUSE" || wanted === 0) throw e;
      this.#conn = await startRemoteConnector({ ...base, port: 0 });
    }
    if (s.tunnel === "ngrok") {
      const { child, url } = await startNgrok(this.#conn.port, s.domain, this.#opts.log);
      this.#tunnel = child;
      this.#conn.setPublicUrl(url);
      child.once("exit", (code) => {
        if (this.#tunnel !== child) return; // stopped on purpose
        this.#tunnel = undefined;
        this.#error = `the ngrok tunnel stopped (exit ${code}); start the connector again`;
        this.#opts.log?.(this.#error);
        void this.#teardown();
      });
    }
  }

  async #teardown(): Promise<void> {
    const tunnel = this.#tunnel;
    this.#tunnel = undefined;
    tunnel?.kill();
    const conn = this.#conn;
    this.#conn = undefined;
    await conn?.close();
  }
}

/** ngrok's binary. The desktop app gets a minimal PATH, so the usual install places are searched too. */
export function ngrokBinary(): string | undefined {
  const env = process.env.REELFORGE_NGROK_BIN;
  if (env) return existsSync(env) ? env : undefined;
  const dirs = [...(process.env.PATH ?? "").split(delimiter), "/opt/homebrew/bin", "/usr/local/bin", join(process.env.HOME ?? "", ".local/bin")];
  for (const d of dirs) {
    if (!d) continue;
    const p = join(d, "ngrok");
    if (existsSync(p)) return p;
  }
  return undefined;
}

/** Start `ngrok http` to the connector and wait for its public URL. */
export function startNgrok(port: number, domain: string | undefined, log?: (line: string) => void): Promise<{ child: ChildProcess; url: string }> {
  const bin = ngrokBinary();
  if (!bin) return Promise.reject(new ReelForgeError("UNAVAILABLE", "ngrok isn't installed: `brew install ngrok`, then `ngrok config add-authtoken <token>` (free account at ngrok.com)"));
  return new Promise((done, fail) => {
    // --inspect=false: ngrok's local inspector (127.0.0.1:4040) would otherwise keep every request,
    // access key, OAuth token and owner cookie included, readable by anything on this Mac.
    const args = ["http", `127.0.0.1:${port}`, "--inspect=false", "--log", "stdout", "--log-format", "json", ...(domain ? ["--url", domain] : [])];
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let buf = "";
    let lastError = "";
    let settled = false;
    const finish = (err?: Error, url?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) {
        child.kill();
        fail(err);
      } else done({ child, url: url! });
    };
    const timer = setTimeout(() => finish(new ReelForgeError("UNAVAILABLE", `ngrok didn't report a public URL within 30 s${lastError ? `: ${lastError}` : ""}`)), 30_000);
    child.on("error", (e) => finish(new ReelForgeError("UNAVAILABLE", `couldn't start ngrok (${e.message})`)));
    // "close", not "exit": exit can fire before stdout is drained, losing the URL or the error line.
    child.on("close", (code) => {
      const id = /ERR_NGROK_\d+/.exec(buf + lastError)?.[0];
      const hint = id === "ERR_NGROK_4018" ? " — run `ngrok config add-authtoken <token>` first" : "";
      finish(new ReelForgeError("UNAVAILABLE", `ngrok exited (${code}) before the tunnel started${lastError ? `: ${lastError.slice(0, 300)}` : id ? `: ${id}` : ""}${hint}`));
    });
    child.stderr?.on("data", (c: Buffer) => (buf += c.toString()));
    child.stdout?.on("data", (c: Buffer) => {
      buf += c.toString();
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        try {
          const msg = JSON.parse(line) as { msg?: string; url?: string; lvl?: string; err?: string };
          if (msg.msg === "started tunnel" && msg.url?.startsWith("https://")) finish(undefined, msg.url);
          else if (msg.lvl === "eror" || msg.lvl === "crit") {
            lastError = (msg.err ?? msg.msg ?? "").split("\n")[0] ?? "";
            log?.(`[ngrok] ${msg.err ?? msg.msg ?? ""}`);
          }
        } catch {
          // not JSON
        }
      }
    });
  });
}
