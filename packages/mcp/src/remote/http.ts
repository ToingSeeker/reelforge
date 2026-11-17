// The remote connector: ReelForge's MCP tools over Streamable HTTP for Claude and ChatGPT, which
// reach this machine through an HTTPS tunnel. Listens on loopback only; the tunnel forwards to it.
//
//   /mcp                         MCP (bearer token from the OAuth flow below)
//   /.well-known/…, /register, /authorize, /token   OAuth 2.1 (see auth.ts)
//   /upload/:id?e&s              one-time upload page / PUT target           (signed, 1 h)
//   /download/:jobId?e&s         a finished render                           (signed, 24 h)
//   /approve/:proposalId?e&s     the user reviews and applies an AI edit     (signed + access key)
//
// Signed links are capabilities a model can hold. Approval needs more than the link: the browser
// that entered the access key (owner cookie), or the access key itself, which only the person at
// this machine can see. So a model that fetches the approval page still can't apply its own edit.

import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { createReadStream, createWriteStream, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { basename, extname, join, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isReelForgeError, JobStore, ProjectStore, ProposalStore, ReelForgeError, type Database, type RenderJob } from "@reelforge/core";
import { AnalysisRunner, importMedia, RenderRunner, SUPPORTED_EXTENSIONS, type ImportResult } from "@reelforge/media";
import { createMcpServer, type RemoteHooks } from "../server.ts";
import { ConnectorAuth, OAuthError } from "./auth.ts";
import { downloadToFile } from "./fetch.ts";

export interface RemoteConnectorOptions {
  db: Database;
  /** Connector state: OAuth clients/tokens, uploads, exports. */
  dir: string;
  cacheDir: string;
  /** Where renders started by a remote client are written. Default: <dir>/exports. */
  exportsDir?: string;
  /** 0 picks a free port. */
  port?: number;
  /** The public https origin the tunnel gives (can be set later with setPublicUrl). */
  publicUrl?: string;
  maxUploadBytes?: number;
  /** Tests pass a fixed code. */
  pairingCode?: string;
  log?: (line: string) => void;
}

export interface RunningConnector {
  /** Local loopback URL. */
  localUrl: string;
  port: number;
  /** The current access key (it changes when the user generates a new one). */
  readonly pairingCode: string;
  auth: ConnectorAuth;
  publicUrl(): string;
  setPublicUrl(url: string): void;
  close(): Promise<void>;
}

const UPLOAD_TTL = 60 * 60 * 1000;
const DOWNLOAD_TTL = 24 * 60 * 60 * 1000;
const APPROVAL_TTL = 24 * 60 * 60 * 1000;
const SESSION_IDLE = 60 * 60 * 1000;
const MAX_FORM_BYTES = 64 * 1024;
const DEFAULT_MAX_UPLOAD = 4 * 2 ** 30;

interface Upload {
  id: string;
  projectId: string;
  exp: number;
  state: "waiting" | "receiving" | "imported" | "failed";
  fileName?: string;
  result?: ImportResult;
  error?: string;
}

interface Session {
  transport: StreamableHTTPServerTransport;
  close: () => Promise<void>;
  clientId: string;
  lastSeen: number;
}

export async function startRemoteConnector(opts: RemoteConnectorOptions): Promise<RunningConnector> {
  const { db } = opts;
  mkdirSync(opts.dir, { recursive: true, mode: 0o700 });
  const auth = new ConnectorAuth(join(opts.dir, "auth.json"), opts.pairingCode);
  const exportsDir = opts.exportsDir ?? join(opts.dir, "exports");
  const uploadsDir = join(opts.dir, "uploads");
  const maxUpload = opts.maxUploadBytes ?? DEFAULT_MAX_UPLOAD;
  const log = opts.log ?? (() => {});
  const projects = new ProjectStore(db);
  const proposals = new ProposalStore(db);
  const jobs = new JobStore(db);
  const render = new RenderRunner(db, { cacheDir: opts.cacheDir });
  const analysis = new AnalysisRunner(db, { cacheDir: opts.cacheDir });
  render.start();
  analysis.start();

  let port = opts.port ?? 0;
  let publicBase = opts.publicUrl?.replace(/\/+$/, "") ?? "";
  const base = () => publicBase || `http://127.0.0.1:${port}`;

  // ---- signed links -----------------------------------------------------------
  const sig = (kind: string, id: string, exp: number) => createHmac("sha256", auth.secret).update(`${kind}:${id}:${exp}`).digest("base64url");
  const signed = (kind: string, id: string, ttl: number) => {
    const exp = Date.now() + ttl;
    return { url: `${base()}/${kind}/${id}?e=${exp}&s=${sig(kind, id, exp)}`, exp };
  };
  const verifySigned = (kind: string, id: string, q: URLSearchParams): boolean => {
    const exp = Number(q.get("e"));
    const s = q.get("s") ?? "";
    if (!Number.isFinite(exp) || exp < Date.now()) return false;
    const want = Buffer.from(sig(kind, id, exp));
    const got = Buffer.from(s);
    return want.length === got.length && timingSafeEqual(want, got);
  };

  // ---- media in ----------------------------------------------------------------
  const uploads = new Map<string, Upload>();
  const pruneUploads = () => {
    for (const [id, u] of uploads) if (u.exp + UPLOAD_TTL < Date.now()) uploads.delete(id);
  };

  /** A name the import accepts: a supported extension, no path parts, nothing odd. */
  const cleanName = (name: string | undefined): string | undefined => {
    if (!name) return undefined;
    const b = basename(name.replace(/\\/g, "/"))
      .replace(/[^\w.\- ()]+/g, "_")
      .replace(/^\.+/, "")
      .slice(-120);
    return b && extname(b).toLowerCase() in SUPPORTED_EXTENSIONS ? b : undefined;
  };
  const unsupported = (name: string | undefined) =>
    new ReelForgeError("VALIDATION_ERROR", `unsupported or missing file type${name ? ` for "${name.slice(0, 80)}"` : ""} (supported: ${Object.keys(SUPPORTED_EXTENSIONS).join(", ")})`);

  /** Files a remote client sends live here for good: projects reference media by path. */
  const landingDir = (projectId: string) => {
    const dir = join(uploadsDir, projectId, randomUUID());
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
  };

  const importFromUrl = async (projectId: string, url: string, fileName?: string): Promise<ImportResult> => {
    const dir = landingDir(projectId);
    const part = join(dir, "download.part");
    try {
      const got = await downloadToFile(url, part, { maxBytes: maxUpload });
      let fromUrl: string | undefined;
      try {
        fromUrl = decodeURIComponent(basename(new URL(url).pathname));
      } catch {
        fromUrl = undefined;
      }
      const name = cleanName(fileName) ?? cleanName(got.fileName) ?? cleanName(fromUrl);
      if (!name) throw unsupported(fileName ?? got.fileName ?? fromUrl);
      const final = join(dir, name);
      renameSync(part, final);
      log(`imported a download (${got.bytes} bytes) into project ${projectId}`);
      return await importMedia(db, projectId, [final], "mcp");
    } catch (e) {
      rmSync(dir, { recursive: true, force: true });
      throw e;
    }
  };

  const exportPath = (projectId: string): string => {
    mkdirSync(exportsDir, { recursive: true });
    const name = projects.get(projectId).name.replace(/[^\w\- ]+/g, "").trim().slice(0, 60) || "ReelForge";
    const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19);
    return join(exportsDir, `${name} ${stamp} ${randomUUID().slice(0, 4)}.mp4`);
  };

  /** The file behind a job, if this connector may hand it out: its own exports, and previews. */
  const servedFile = (job: RenderJob): string | undefined => {
    if (job.state !== "completed") return undefined;
    if (job.kind === "preview") return join(opts.cacheDir, "previews", job.projectId, `${job.id}.mp4`);
    if (job.kind === "export" && job.outputPath?.startsWith(exportsDir + sep)) return job.outputPath;
    return undefined;
  };

  const hooks: RemoteHooks = {
    createUploadLink(projectId) {
      pruneUploads();
      const id = randomUUID();
      const { url, exp } = signed("upload", id, UPLOAD_TTL);
      uploads.set(id, { id, projectId, exp, state: "waiting" });
      return { uploadId: id, url, expiresAt: new Date(exp).toISOString() };
    },
    uploadStatus(uploadId) {
      const u = uploads.get(uploadId);
      if (!u) throw new ReelForgeError("NOT_FOUND", "no such upload (links expire after an hour)");
      return {
        state: u.state,
        ...(u.fileName ? { fileName: u.fileName } : {}),
        ...(u.result ? { imported: u.result.imported.map(brief), existing: u.result.existing.map(brief), failed: u.result.failed } : {}),
        ...(u.error ? { error: u.error } : {}),
        ...(u.state === "waiting" ? { next: "the user hasn't uploaded yet; ask them to open the link" } : {}),
      };
    },
    importFromUrl,
    downloadLink: (job) => (servedFile(job) ? signed("download", job.id, DOWNLOAD_TTL).url : undefined),
    approvalLink: (proposalId) => signed("approve", proposalId, APPROVAL_TTL).url,
    exportPath,
  };

  // ---- MCP sessions --------------------------------------------------------------
  const sessions = new Map<string, Session>();
  const sweep = setInterval(() => {
    for (const [id, s] of sessions) {
      if (Date.now() - s.lastSeen > SESSION_IDLE) {
        sessions.delete(id);
        void s.transport.close().catch(() => {});
        void s.close();
      }
    }
  }, 5 * 60 * 1000);
  sweep.unref();

  const handleMcp = async (req: IncomingMessage, res: ServerResponse) => {
    const bearer = /^Bearer (.+)$/i.exec(req.headers.authorization ?? "")?.[1];
    const client = auth.verifyAccessToken(bearer);
    if (!client) {
      res.writeHead(401, {
        "content-type": "application/json",
        "www-authenticate": `Bearer error="invalid_token", resource_metadata="${base()}/.well-known/oauth-protected-resource/mcp"`,
      });
      res.end(JSON.stringify({ error: "invalid_token", error_description: "Connect ReelForge again in your AI app." }));
      return;
    }
    const sid = req.headers["mcp-session-id"];
    const existing = typeof sid === "string" ? sessions.get(sid) : undefined;
    if (existing && existing.clientId === client.clientId) {
      existing.lastSeen = Date.now();
      await existing.transport.handleRequest(req, res);
      return;
    }
    if (sid !== undefined || req.method !== "POST") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message: "Session not found" }, id: null }));
      return;
    }
    const { server, close } = createMcpServer(db, { cacheDir: opts.cacheDir, runners: { render, analysis }, remote: hooks });
    const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        sessions.set(id, { transport, close, clientId: client.clientId, lastSeen: Date.now() });
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) sessions.delete(transport.sessionId);
      void close();
    };
    await server.connect(transport);
    await transport.handleRequest(req, res);
  };

  // ---- HTTP ------------------------------------------------------------------------
  const allowedHost = (host: string | undefined) => {
    if (!host) return false;
    if (host === `127.0.0.1:${port}` || host === `localhost:${port}`) return true;
    try {
      return !!publicBase && host === new URL(publicBase).host;
    } catch {
      return false;
    }
  };

  const server = createServer((req, res) => {
    const started = Date.now();
    res.on("finish", () => log(`${req.method} ${(req.url ?? "").split("?")[0]} ${res.statusCode} ${Date.now() - started}ms`));
    route(req, res).catch((e) => {
      log(`error: ${e instanceof Error ? e.message : String(e)}`);
      if (!res.headersSent) sendJson(res, 500, { error: "server_error" });
      else res.destroy();
    });
  });

  const route = async (req: IncomingMessage, res: ServerResponse) => {
    // DNS rebinding: only our own names.
    if (!allowedHost(req.headers.host)) return sendJson(res, 421, { error: "misdirected_request" });
    const url = new URL(req.url ?? "/", "http://x");
    const path = url.pathname;
    const method = req.method ?? "GET";

    // CORS for the machine endpoints (browser-based MCP clients). Bearer tokens are never ambient, so * is safe here.
    if (path === "/mcp" || path.startsWith("/.well-known/") || path === "/token" || path === "/register") {
      res.setHeader("access-control-allow-origin", "*");
      res.setHeader("access-control-allow-headers", "authorization, content-type, mcp-session-id, mcp-protocol-version, last-event-id");
      res.setHeader("access-control-allow-methods", "GET, POST, DELETE, OPTIONS");
      res.setHeader("access-control-expose-headers", "mcp-session-id, www-authenticate");
      if (method === "OPTIONS") {
        res.writeHead(204).end();
        return;
      }
    }

    if (path === "/mcp") return handleMcp(req, res);

    if (path === "/.well-known/oauth-protected-resource" || path === "/.well-known/oauth-protected-resource/mcp") {
      return sendJson(res, 200, { resource: `${base()}/mcp`, authorization_servers: [base()], bearer_methods_supported: ["header"], scopes_supported: ["reelforge"], resource_name: "ReelForge" });
    }
    if (path === "/.well-known/oauth-authorization-server" || path === "/.well-known/oauth-authorization-server/mcp" || path === "/.well-known/openid-configuration") {
      return sendJson(res, 200, {
        issuer: base(),
        authorization_endpoint: `${base()}/authorize`,
        token_endpoint: `${base()}/token`,
        registration_endpoint: `${base()}/register`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
        scopes_supported: ["reelforge"],
      });
    }
    if (path === "/register" && method === "POST") {
      try {
        const c = auth.register(JSON.parse((await readBody(req)) || "{}"));
        log(`registered client "${c.clientName}"`);
        return sendJson(res, 201, {
          client_id: c.clientId,
          client_id_issued_at: Math.floor(c.createdAt / 1000),
          client_name: c.clientName,
          redirect_uris: c.redirectUris,
          token_endpoint_auth_method: "none",
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
        });
      } catch (e) {
        return oauthError(res, e);
      }
    }
    if (path === "/token" && method === "POST") {
      try {
        const body = await readBody(req);
        const params = (req.headers["content-type"] ?? "").includes("application/json") ? new URLSearchParams(JSON.parse(body) as Record<string, string>) : new URLSearchParams(body);
        res.setHeader("cache-control", "no-store");
        return sendJson(res, 200, auth.exchange(params));
      } catch (e) {
        return oauthError(res, e);
      }
    }
    if (path === "/authorize" && (method === "GET" || method === "POST")) return authorize(req, res, method === "GET" ? url.searchParams : new URLSearchParams(await readBody(req)));

    const m = /^\/(upload|download|approve)\/([0-9a-f-]{36})$/.exec(path);
    if (m) {
      const [, kind, id] = m as unknown as [string, "upload" | "download" | "approve", string];
      if (!verifySigned(kind, id, url.searchParams)) return sendHtml(res, 403, page("Link expired", "<p>This link is invalid or has expired. Ask the AI for a new one.</p>"));
      if (kind === "upload") return upload(req, res, id, url);
      if (kind === "download") return download(req, res, id);
      return approve(req, res, id, url);
    }
    if (path === "/" && method === "GET") return sendHtml(res, 200, page("ReelForge connector", "<p>This is the ReelForge connector. Add <code>" + esc(`${base()}/mcp`) + "</code> as a custom connector in Claude or ChatGPT.</p>"));
    sendJson(res, 404, { error: "not_found" });
  };

  // ---- /authorize ----------------------------------------------------------------------
  const authorize = async (req: IncomingMessage, res: ServerResponse, p: URLSearchParams) => {
    let client, redirectUri: string;
    try {
      ({ client, redirectUri } = auth.checkAuthorizeRequest(p));
    } catch (e) {
      // Never redirect to a URI we couldn't verify.
      return sendHtml(res, 400, page("Can't connect", `<p>${esc(e instanceof Error ? e.message : String(e))}</p>`));
    }
    const back = (params: Record<string, string>) => {
      const u = new URL(redirectUri);
      for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
      if (p.get("state")) u.searchParams.set("state", p.get("state")!);
      u.searchParams.set("iss", base());
      res.writeHead(302, { location: u.toString(), "cache-control": "no-store" }).end();
    };
    let error = "";
    if (req.method === "POST") {
      if (!auth.checkFormToken(`authorize:${client.clientId}`, p.get("form_token") ?? undefined)) return sendHtml(res, 400, page("Can't connect", "<p>The form expired. Start connecting again from your AI app.</p>"));
      if (p.get("decision") !== "allow") return back({ error: "access_denied", error_description: "The user declined" });
      try {
        if (auth.checkPairingCode(p.get("pairing_code") ?? "")) {
          const owner = auth.newOwnerCookie();
          res.setHeader("set-cookie", ownerCookie(owner.value, owner.maxAgeSeconds, publicBase.startsWith("https:")));
          log(`authorized "${client.clientName}"`);
          return back({ code: auth.issueCode(client.clientId, redirectUri, p.get("code_challenge")!) });
        }
        error = "That access key is not right. Find it in ReelForge: Settings → Claude & ChatGPT.";
      } catch (e) {
        return sendHtml(res, e instanceof OAuthError ? e.status : 400, page("Can't connect", `<p>${esc(e instanceof Error ? e.message : String(e))}</p>`));
      }
    }
    const hidden = ["response_type", "client_id", "redirect_uri", "code_challenge", "code_challenge_method", "state", "scope", "resource"]
      .filter((k) => p.has(k))
      .map((k) => `<input type="hidden" name="${k}" value="${esc(p.get(k)!)}">`)
      .join("");
    const destination = new URL(redirectUri).host;
    const body = `
      <p><strong>${esc(client.clientName)}</strong> wants to use ReelForge on this computer. You'll be sent back to <strong>${esc(destination)}</strong>.</p>
      <p>Once connected it can:</p>
      <ul>
        <li>see your ReelForge projects: names, timelines, captions and transcripts</li>
        <li>add media you send it to a project (stored on this computer)</li>
        <li>analyse media, propose edits, and render videos you can download</li>
      </ul>
      <p>It can't change a timeline by itself: every edit waits for you to press Apply on a ReelForge page or in the app.</p>
      ${error ? `<p class="err">${esc(error)}</p>` : ""}
      <form method="post" action="/authorize">
        ${hidden}
        <input type="hidden" name="form_token" value="${esc(auth.formToken(`authorize:${client.clientId}`))}">
        <label>ReelForge access key<input name="pairing_code" autocomplete="off" autocapitalize="characters" placeholder="XXXX-XXXX" required autofocus></label>
        <div class="row"><button name="decision" value="allow" class="primary">Allow</button><button name="decision" value="deny" formnovalidate>Deny</button></div>
      </form>`;
    sendHtml(res, error ? 400 : 200, page("Connect to ReelForge", body), { formAction: `'self' ${new URL(redirectUri).origin}` });
  };

  // ---- /upload/:id -----------------------------------------------------------------------
  const upload = async (req: IncomingMessage, res: ServerResponse, id: string, url: URL) => {
    const u = uploads.get(id);
    if (!u) return sendHtml(res, 404, page("Link expired", "<p>This upload link is no longer valid. Ask the AI for a new one.</p>"));
    if (req.method === "GET") {
      const project = projects.get(u.projectId).name;
      if (u.state !== "waiting") return sendHtml(res, 200, page("Upload", `<p>This link was already used (${esc(u.state)}${u.fileName ? `: ${esc(u.fileName)}` : ""}).</p>`));
      const nonce = randomUUID();
      const body = `
        <p>Upload one file into <strong>${esc(project)}</strong>. It's saved on the computer running ReelForge.</p>
        <p class="hint">Video MP4/MOV, image JPEG/PNG, audio WAV/MP3 · up to ${Math.round(maxUpload / 2 ** 30)} GB</p>
        <input type="file" id="f" accept="${Object.keys(SUPPORTED_EXTENSIONS).join(",")}">
        <div class="row"><button id="go" class="primary" disabled>Upload</button></div>
        <progress id="p" max="1" value="0" hidden></progress>
        <p id="msg"></p>
        <script nonce="${nonce}">
          const f = document.getElementById("f"), go = document.getElementById("go"), p = document.getElementById("p"), msg = document.getElementById("msg");
          f.onchange = () => { go.disabled = !f.files.length; };
          go.onclick = () => {
            const file = f.files[0]; if (!file) return;
            go.disabled = true; f.disabled = true; p.hidden = false; msg.textContent = "Uploading…";
            const x = new XMLHttpRequest();
            x.open("PUT", location.href);
            x.setRequestHeader("X-File-Name", encodeURIComponent(file.name));
            x.upload.onprogress = (e) => { if (e.lengthComputable) p.value = e.loaded / e.total; };
            x.onload = () => {
              let r = {}; try { r = JSON.parse(x.responseText); } catch {}
              msg.textContent = x.status === 200 ? "Done. Go back to the chat and tell the AI it's uploaded." : "Upload failed: " + ((r.error && r.error.message) || x.status);
              msg.className = x.status === 200 ? "ok" : "err";
            };
            x.onerror = () => { msg.textContent = "Upload failed: the connection dropped."; msg.className = "err"; };
            x.send(file);
          };
        </script>`;
      return sendHtml(res, 200, page("Upload to ReelForge", body), { nonce });
    }
    if (req.method !== "PUT" && req.method !== "POST") return sendJson(res, 405, { error: { code: "METHOD_NOT_ALLOWED", message: "use PUT" } });
    if (u.state !== "waiting") return sendJson(res, 409, { error: { code: "VALIDATION_ERROR", message: `this link was already used (${u.state})` } });
    const header = req.headers["x-file-name"];
    let raw = url.searchParams.get("name") ?? (typeof header === "string" ? header : undefined);
    try {
      raw = raw ? decodeURIComponent(raw) : raw;
    } catch {
      // keep it as sent
    }
    const name = cleanName(raw);
    if (!name) {
      req.resume();
      return sendJson(res, 400, { error: unsupported(raw).toJSON() });
    }
    if (Number(req.headers["content-length"] ?? 0) > maxUpload) {
      req.resume();
      return sendJson(res, 413, { error: { code: "VALIDATION_ERROR", message: `the file is larger than ${Math.round(maxUpload / 2 ** 20)} MB` } });
    }
    u.state = "receiving";
    u.fileName = name;
    const dir = landingDir(u.projectId);
    const final = join(dir, name);
    let bytes = 0;
    try {
      const cap = new Transform({
        transform(chunk: Buffer, _e, cb) {
          bytes += chunk.length;
          cb(bytes > maxUpload ? new ReelForgeError("VALIDATION_ERROR", `the file is larger than ${Math.round(maxUpload / 2 ** 20)} MB`) : null, chunk);
        },
      });
      await pipeline(req, cap, createWriteStream(final, { flags: "wx", mode: 0o600 }));
      if (!bytes) throw new ReelForgeError("VALIDATION_ERROR", "the upload was empty");
      u.result = await importMedia(db, u.projectId, [final], "mcp");
      if (u.result.failed.length) throw new ReelForgeError(u.result.failed[0]!.error.code, u.result.failed[0]!.error.message);
      u.state = "imported";
      log(`upload ${id}: ${bytes} bytes imported`);
      sendJson(res, 200, { state: u.state, imported: u.result.imported.map(brief), existing: u.result.existing.map(brief) });
    } catch (e) {
      rmSync(dir, { recursive: true, force: true });
      u.state = "failed";
      u.error = e instanceof Error ? e.message : String(e);
      sendJson(res, isReelForgeError(e) && e.code === "VALIDATION_ERROR" ? 400 : 500, { error: { code: isReelForgeError(e) ? e.code : "INTERNAL", message: u.error } });
    }
  };

  // ---- /download/:jobId --------------------------------------------------------------------
  const download = (req: IncomingMessage, res: ServerResponse, jobId: string) => {
    let file: string | undefined;
    let job: RenderJob | undefined;
    try {
      job = jobs.get(jobId);
      file = servedFile(job);
    } catch {
      file = undefined;
    }
    let size = 0;
    try {
      if (file) size = statSync(file).size;
    } catch {
      file = undefined;
    }
    if (!file || !job) return sendHtml(res, 404, page("Not available", "<p>This video is no longer available (previews are replaced as new ones are made).</p>"));
    const name = `${projects.get(job.projectId).name.replace(/[^\w\- ]+/g, "").trim() || "ReelForge"}${job.kind === "preview" ? " (preview)" : ""}.mp4`;
    const headers: Record<string, string | number> = {
      "content-type": "video/mp4",
      "accept-ranges": "bytes",
      "content-disposition": `inline; filename="${name}"; filename*=UTF-8''${encodeURIComponent(name)}`,
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    };
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "");
    if (range && (range[1] || range[2])) {
      let start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
      let end = range[1] && range[2] ? Number(range[2]) : size - 1;
      end = Math.min(end, size - 1);
      if (start > end || start >= size) {
        res.writeHead(416, { "content-range": `bytes */${size}` }).end();
        return;
      }
      res.writeHead(206, { ...headers, "content-range": `bytes ${start}-${end}/${size}`, "content-length": end - start + 1 });
      if (req.method === "HEAD") return void res.end();
      createReadStream(file, { start, end }).pipe(res);
      return;
    }
    res.writeHead(200, { ...headers, "content-length": size });
    if (req.method === "HEAD") return void res.end();
    createReadStream(file).pipe(res);
  };

  // ---- /approve/:proposalId -----------------------------------------------------------------
  const approve = async (req: IncomingMessage, res: ServerResponse, proposalId: string, url: URL) => {
    let p;
    try {
      p = proposals.get(proposalId);
    } catch {
      return sendHtml(res, 404, page("Not found", "<p>This edit no longer exists.</p>"));
    }
    const owner = auth.isOwner(cookies(req).rf_owner);
    let notice = "";
    if (req.method === "POST") {
      const form = new URLSearchParams(await readBody(req));
      if (!auth.checkFormToken(`approve:${proposalId}`, form.get("form_token") ?? undefined)) return sendHtml(res, 400, page("Form expired", "<p>Reload the page and try again.</p>"));
      let trusted = owner;
      if (!trusted) {
        try {
          trusted = auth.checkPairingCode(form.get("pairing_code") ?? "");
        } catch (e) {
          return sendHtml(res, 429, page("Locked", `<p>${esc(e instanceof Error ? e.message : String(e))}</p>`));
        }
        if (trusted) {
          const c = auth.newOwnerCookie();
          res.setHeader("set-cookie", ownerCookie(c.value, c.maxAgeSeconds, publicBase.startsWith("https:")));
        }
      }
      if (!trusted) notice = `<p class="err">That access key is not right. Find it in ReelForge: Settings → Claude &amp; ChatGPT.</p>`;
      else {
        try {
          if (form.get("decision") === "apply") {
            proposals.apply(proposalId, { by: "mcp", channel: "connector:approval-page" });
            notice = `<p class="ok">Applied. You can undo it in ReelForge (⌘Z). Go back to the chat and tell the AI.</p>`;
          } else if (form.get("decision") === "reject") {
            proposals.reject(proposalId, "mcp");
            notice = `<p class="ok">Rejected. Nothing changed.</p>`;
          }
        } catch (e) {
          const msg = isReelForgeError(e) && e.code === "REVISION_CONFLICT" ? "The project changed since this edit was proposed, so it wasn't applied. Ask the AI to propose it again." : e instanceof Error ? e.message : String(e);
          notice = `<p class="err">${esc(msg)}</p>`;
        }
        p = proposals.get(proposalId);
      }
    }
    const project = projects.get(p.projectId).name;
    const changes = p.changes
      .slice(0, 60)
      .map((c) => `<li><span class="k">${esc(c.kind)}</span> ${esc(c.label)}${c.before ? `<div class="b">− ${esc(c.before)}</div>` : ""}${c.after ? `<div class="a">+ ${esc(c.after)}</div>` : ""}</li>`)
      .join("");
    const more = p.changes.length > 60 ? `<li>…and ${p.changes.length - 60} more</li>` : "";
    const actions =
      p.status === "pending" && p.operations.length
        ? `<form method="post" action="${esc(url.pathname + url.search)}">
            <input type="hidden" name="form_token" value="${esc(auth.formToken(`approve:${proposalId}`))}">
            ${owner ? "" : `<label>ReelForge access key<input name="pairing_code" autocomplete="off" autocapitalize="characters" placeholder="XXXX-XXXX" required></label>`}
            <div class="row"><button name="decision" value="apply" class="primary">Apply to timeline</button><button name="decision" value="reject" formnovalidate>Reject</button></div>
          </form>`
        : `<p>Status: <strong>${esc(p.status)}</strong></p>`;
    const body = `
      <p>Project <strong>${esc(project)}</strong></p>
      <p class="sum">${esc(p.summary)} <span class="hint">(written by the AI)</span></p>
      ${p.warnings.length ? `<ul class="warn">${p.warnings.map((w) => `<li>${esc(w)}</li>`).join("")}</ul>` : ""}
      <ul class="changes">${changes}${more}</ul>
      ${notice}
      ${actions}`;
    sendHtml(res, 200, page("Review edit", body));
  };

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });
  port = (server.address() as AddressInfo).port;

  return {
    localUrl: `http://127.0.0.1:${port}`,
    port,
    get pairingCode() {
      return auth.pairingCode;
    },
    auth,
    publicUrl: base,
    setPublicUrl(u) {
      publicBase = u.replace(/\/+$/, "");
    },
    async close() {
      clearInterval(sweep);
      for (const s of sessions.values()) {
        await s.transport.close().catch(() => {});
        await s.close();
      }
      sessions.clear();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      analysis.stop();
      await render.stop();
    },
  };
}

// ---- helpers ------------------------------------------------------------------------------------

function brief(a: { id: string; kind: string; sourcePath: string; durationFrames?: number | null }) {
  return { assetId: a.id, kind: a.kind, name: basename(a.sourcePath) };
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_FORM_BYTES) {
        reject(new OAuthError("invalid_request", "request too large", 413));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function cookies(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

function ownerCookie(value: string, maxAge: number, secure: boolean): string {
  return `rf_owner=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "x-content-type-options": "nosniff" });
  res.end(JSON.stringify(body));
}

function oauthError(res: ServerResponse, e: unknown) {
  if (e instanceof OAuthError) return sendJson(res, e.status, { error: e.error, error_description: e.description });
  if (e instanceof SyntaxError) return sendJson(res, 400, { error: "invalid_request", error_description: "malformed JSON" });
  throw e;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function sendHtml(res: ServerResponse, status: number, html: string, csp: { nonce?: string; formAction?: string } = {}) {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "content-security-policy":
      `default-src 'none'; style-src 'unsafe-inline'; img-src data:; connect-src 'self'; ` +
      `${csp.nonce ? `script-src 'nonce-${csp.nonce}'; ` : ""}form-action ${csp.formAction ?? "'self'"}; frame-ancestors 'none'; base-uri 'none'`,
  });
  res.end(html);
}

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · ReelForge</title><style>
:root{color-scheme:dark}body{margin:0;min-height:100vh;display:grid;place-items:center;background:radial-gradient(1200px 600px at 50% -10%,#123a30,#08110f 60%);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Inter",system-ui,sans-serif;color:#e6f2ee}
main{width:min(560px,92vw);margin:40px 0;padding:28px;border-radius:20px;background:rgba(16,34,29,.78);border:1px solid rgba(160,230,205,.14);box-shadow:inset 0 1px 0 rgba(255,255,255,.06),0 20px 60px rgba(0,0,0,.4)}
h1{margin:0 0 14px;font-size:20px}h1 span{color:#7fe0bd}code{background:rgba(0,0,0,.3);padding:2px 6px;border-radius:6px;word-break:break-all}
label{display:block;margin:16px 0 6px;font-size:13px;color:#a9c7bd}input:not([type=file]):not([type=hidden]){display:block;width:100%;box-sizing:border-box;margin-top:6px;padding:10px 14px;border-radius:999px;border:1px solid rgba(160,230,205,.2);background:rgba(0,0,0,.25);color:inherit;font:inherit;letter-spacing:.08em}
.row{display:flex;gap:10px;margin-top:18px}button{padding:9px 20px;border-radius:999px;border:1px solid rgba(160,230,205,.2);background:rgba(255,255,255,.06);color:inherit;font:inherit;cursor:pointer}
button.primary{background:linear-gradient(#8de8c6,#5fcfa6);color:#062019;border-color:transparent;font-weight:600}button:disabled{opacity:.5;cursor:default}
.err{color:#ff9d8a}.ok{color:#7fe0bd}.hint{color:#86a69b;font-size:13px}progress{width:100%;margin-top:14px;accent-color:#7fe0bd}
.changes{padding-left:18px;max-height:46vh;overflow:auto;font:12.5px/1.45 ui-monospace,Menlo,monospace}.changes li{margin:6px 0}.k{color:#7fe0bd}.b{color:#ff9d8a}.a{color:#9be8b0}.warn{color:#f5c26b}.sum{font-size:16px}
</style></head><body><main><h1><span>ReelForge</span> · ${esc(title)}</h1>${body}</main></body></html>`;
}
