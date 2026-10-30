import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import type { AddressInfo } from "node:net";
import {
  ActorSchema,
  AssetStore,
  isReelForgeError,
  ProjectStore,
  ReelForgeError,
  TimelineStore,
  type Actor,
  type Database,
  type ErrorCode,
} from "@reelforge/core";
import { ensureThumbnail, importMedia, relinkMedia } from "@reelforge/media";

// Local REST API (PRD §15). Loopback only, bearer token always required,
// Host/Origin checked so a web page can't reach it via DNS rebinding.

export interface ApiServerOptions {
  db: Database;
  token: string;
  /** 0 picks a free port. */
  port?: number;
  /** Browser origins allowed to call the API (the desktop webview). */
  allowedOrigins?: readonly string[];
  /** Where derived files (thumbnails) are cached. */
  cacheDir: string;
  /** Optional access log (method, path, status, origin). Never logs headers or bodies. */
  log?: (line: string) => void;
}

export interface RunningServer {
  url: string;
  port: number;
  server: Server;
  close(): Promise<void>;
}

const MAX_BODY_BYTES = 64 * 1024;

const STATUS: Record<ErrorCode, number> = {
  VALIDATION_ERROR: 400,
  UNAUTHORIZED: 401,
  UNAVAILABLE: 503,
  NOT_FOUND: 404,
  REVISION_CONFLICT: 409,
  INTERNAL: 500,
};

function send(res: ServerResponse, status: number, body: unknown) {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(json);
}

function sendError(res: ServerResponse, err: ReelForgeError) {
  send(res, STATUS[err.code], { error: err.toJSON() });
}

function tokenMatches(header: string | undefined, token: string): boolean {
  const m = /^Bearer (.+)$/.exec(header ?? "");
  if (!m?.[1]) return false;
  const a = Buffer.from(m[1]);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const type = req.headers["content-type"] ?? "";
  if (!type.startsWith("application/json")) {
    throw new ReelForgeError("VALIDATION_ERROR", "content-type must be application/json");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new ReelForgeError("VALIDATION_ERROR", "request body too large");
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw new ReelForgeError("VALIDATION_ERROR", "request body is not valid JSON");
  }
}

interface RouteContext {
  req: IncomingMessage;
  res: ServerResponse;
  params: string[];
  actor: Actor;
}

interface Route {
  method: string;
  pattern: RegExp;
  handle: (ctx: RouteContext) => unknown;
}

const re = (path: string) => new RegExp(`^${path}$`);

function actorOf(req: IncomingMessage): Actor {
  const parsed = ActorSchema.safeParse(req.headers["x-reelforge-actor"] ?? "api");
  return parsed.success ? parsed.data : "api";
}

export function startApiServer(opts: ApiServerOptions): Promise<RunningServer> {
  if (opts.token.length < 32) throw new Error("API token must be at least 32 characters");
  const projects = new ProjectStore(opts.db);
  const assets = new AssetStore(opts.db);
  const timeline = new TimelineStore(opts.db);
  const body = (req: IncomingMessage) => readJson(req) as Promise<never>;
  const pathsOf = (b: unknown): string[] => {
    const paths = (b as { paths?: unknown })?.paths;
    if (!Array.isArray(paths) || paths.length === 0 || !paths.every((p) => typeof p === "string")) {
      throw new ReelForgeError("VALIDATION_ERROR", "body must be {\"paths\": [\"/absolute/file.mp4\", …]}");
    }
    return paths;
  };

  const ID = "([^/]+)";
  const routes: Route[] = [
    { method: "GET", pattern: re("/v1/projects"), handle: ({ res }) => send(res, 200, { projects: projects.list() }) },
    { method: "POST", pattern: re("/v1/projects"), handle: async ({ req, res, actor }) => send(res, 201, { project: projects.create(await body(req), actor) }) },
    { method: "GET", pattern: re(`/v1/projects/${ID}`), handle: ({ res, params: [id] }) => send(res, 200, { project: projects.get(id!) }) },
    {
      method: "PATCH",
      pattern: re(`/v1/projects/${ID}`),
      handle: async ({ req, res, params: [id], actor }) => send(res, 200, { project: projects.rename(id!, await body(req), actor) }),
    },
    { method: "GET", pattern: re(`/v1/projects/${ID}/history`), handle: ({ res, params: [id] }) => send(res, 200, { operations: projects.history(id!) }) },
    { method: "GET", pattern: re(`/v1/projects/${ID}/timeline`), handle: ({ res, params: [id] }) => send(res, 200, { timeline: timeline.get(id!) }) },
    {
      method: "POST",
      pattern: re(`/v1/projects/${ID}/operations`),
      handle: async ({ req, res, params: [id], actor }) => send(res, 200, { timeline: timeline.apply(id!, await body(req), actor) }),
    },
    {
      method: "POST",
      pattern: re(`/v1/projects/${ID}/undo`),
      handle: async ({ req, res, params: [id], actor }) => send(res, 200, { timeline: timeline.undo(id!, await body(req), actor) }),
    },
    {
      method: "POST",
      pattern: re(`/v1/projects/${ID}/redo`),
      handle: async ({ req, res, params: [id], actor }) => send(res, 200, { timeline: timeline.redo(id!, await body(req), actor) }),
    },
    { method: "GET", pattern: re(`/v1/projects/${ID}/assets`), handle: ({ res, params: [id] }) => send(res, 200, { assets: assets.list(id!) }) },
    {
      method: "POST",
      pattern: re(`/v1/projects/${ID}/assets`),
      handle: async ({ req, res, params: [id], actor }) => {
        const result = await importMedia(opts.db, id!, pathsOf(await readJson(req)), actor);
        return send(res, result.imported.length ? 201 : 200, result);
      },
    },
    {
      method: "POST",
      pattern: re(`/v1/projects/${ID}/assets/${ID}/relink`),
      handle: async ({ req, res, params: [id, assetId], actor }) => {
        const b = (await readJson(req)) as { path?: unknown };
        if (typeof b?.path !== "string") throw new ReelForgeError("VALIDATION_ERROR", 'body must be {"path": "/absolute/file"}');
        return send(res, 200, { asset: await relinkMedia(opts.db, id!, assetId!, b.path, actor) });
      },
    },
    {
      method: "GET",
      pattern: re(`/v1/projects/${ID}/assets/${ID}/thumbnail`),
      handle: async ({ res, params: [id, assetId] }) => {
        const thumb = await ensureThumbnail(opts.cacheDir, assets.get(id!, assetId!));
        res.writeHead(200, { "content-type": thumb.contentType, "cache-control": "private, max-age=3600", "x-content-type-options": "nosniff" });
        createReadStream(thumb.path).pipe(res);
      },
    },
  ];

  const origins = new Set(opts.allowedOrigins ?? []);
  let boundPort = 0;

  const server = createServer(async (req, res) => {
    if (opts.log) {
      const log = opts.log;
      res.on("finish", () => log(`${req.method} ${(req.url ?? "").split("?")[0]} ${res.statusCode} origin=${req.headers.origin ?? "-"}`));
    }
    try {
      const origin = req.headers.origin;
      if (origin !== undefined) {
        if (!origins.has(origin)) return send(res, 403, { error: { code: "UNAUTHORIZED", message: "origin not allowed" } });
        res.setHeader("access-control-allow-origin", origin);
        res.setHeader("vary", "origin");
      }
      const host = req.headers.host ?? "";
      if (host !== `127.0.0.1:${boundPort}` && host !== `localhost:${boundPort}`) {
        return send(res, 403, { error: { code: "UNAUTHORIZED", message: "host not allowed" } });
      }
      if (req.method === "OPTIONS") {
        res.writeHead(204, {
          "access-control-allow-methods": "GET, POST, PATCH, OPTIONS",
          "access-control-allow-headers": "authorization, content-type, x-reelforge-actor",
          "access-control-max-age": "600",
        });
        return res.end();
      }

      const url = new URL(req.url ?? "/", `http://${host}`);
      const path = url.pathname.replace(/\/+$/, "") || "/";

      if (req.method === "GET" && path === "/v1/health") {
        return send(res, 200, { ok: true, name: "reelforge", api: "v1" });
      }
      if (!tokenMatches(req.headers.authorization, opts.token)) {
        return sendError(res, new ReelForgeError("UNAUTHORIZED", "missing or invalid bearer token"));
      }

      for (const route of routes) {
        if (route.method !== req.method) continue;
        const m = route.pattern.exec(path);
        if (!m) continue;
        const params = m.slice(1).map((p) => decodeURIComponent(p));
        return await route.handle({ req, res, params, actor: actorOf(req) });
      }

      return sendError(res, new ReelForgeError("NOT_FOUND", `no route for ${req.method} ${path}`));
    } catch (e) {
      if (isReelForgeError(e)) return sendError(res, e);
      console.error("[reelforge-server] unhandled error:", e instanceof Error ? e.message : e);
      return sendError(res, new ReelForgeError("INTERNAL", "internal error"));
    }
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 0, "127.0.0.1", () => {
      boundPort = (server.address() as AddressInfo).port;
      resolve({
        url: `http://127.0.0.1:${boundPort}`,
        port: boundPort,
        server,
        close: () =>
          new Promise((r, j) => {
            server.close((err) => (err ? j(err) : r()));
            // close() already drops idle sockets; also end in-flight ones so shutdown can't hang.
            server.closeAllConnections();
          }),
      });
    });
  });
}
