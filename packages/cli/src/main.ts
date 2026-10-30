import { parseArgs } from "node:util";
import { randomBytes } from "node:crypto";
import {
  isReelForgeError,
  openDatabase,
  parseFps,
  ProjectStore,
  ReelForgeError,
  resolveDbPath,
  resolveHome,
  type ErrorCode,
} from "@reelforge/core";
import { startApiServer } from "@reelforge/server";

// Every command prints exactly one JSON document to stdout (errors go to
// stderr as {"error": …}) so agents and scripts can parse the result.

const VERSION = "0.0.0";

const EXIT: Record<ErrorCode, number> = {
  INTERNAL: 1,
  VALIDATION_ERROR: 2,
  NOT_FOUND: 3,
  REVISION_CONFLICT: 4,
  UNAUTHORIZED: 5,
};

const USAGE = `reelforge ${VERSION} — AI-native video editing engine

Usage:
  reelforge info
  reelforge project list
  reelforge project create --name <name> [--width 1080] [--height 1920] [--fps 30]
  reelforge project get <id>
  reelforge project rename <id> --name <name> --base-revision <n>
  reelforge project history <id>
  reelforge serve [--port 0] [--allow-origin <origin>]...

Global options:
  --home <dir>   workspace directory (default: $REELFORGE_HOME or the OS app-data dir)
  --pretty       indent JSON output (default when stdout is a terminal)
  -h, --help     show this help

Exit codes: 0 ok, 1 internal, 2 invalid input, 3 not found, 4 revision conflict.
`;

interface Io {
  out: (s: string) => void;
  err: (s: string) => void;
  isTTY: boolean;
  env: NodeJS.ProcessEnv;
}

const defaultIo: Io = {
  out: (s) => process.stdout.write(s),
  err: (s) => process.stderr.write(s),
  isTTY: Boolean(process.stdout.isTTY),
  env: process.env,
};

function int(flag: string, v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  if (!/^-?\d+$/.test(v)) throw new ReelForgeError("VALIDATION_ERROR", `--${flag} must be an integer`);
  return Number(v);
}

function need<T>(v: T | undefined, what: string): T {
  if (v === undefined || v === "") throw new ReelForgeError("VALIDATION_ERROR", `missing ${what}`);
  return v;
}

export async function main(argv: string[], io: Io = defaultIo): Promise<number> {
  let pretty = io.isTTY;
  const print = (v: unknown) => io.out(JSON.stringify(v, null, pretty ? 2 : 0) + "\n");

  try {
    const { values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        home: { type: "string" },
        pretty: { type: "boolean" },
        help: { type: "boolean", short: "h" },
        name: { type: "string" },
        width: { type: "string" },
        height: { type: "string" },
        fps: { type: "string" },
        "base-revision": { type: "string" },
        port: { type: "string" },
        "allow-origin": { type: "string", multiple: true },
      },
    });
    if (values.pretty) pretty = true;
    const [cmd, sub, arg] = positionals;

    if (values.help || !cmd) {
      io.out(USAGE);
      return values.help ? 0 : EXIT.VALIDATION_ERROR;
    }

    const env = values.home ? { ...io.env, REELFORGE_HOME: values.home } : io.env;

    if (cmd === "info") {
      print({ version: VERSION, home: resolveHome(env), database: resolveDbPath(env) });
      return 0;
    }

    if (cmd === "serve") {
      return await serve(env, values, io);
    }

    if (cmd !== "project") throw new ReelForgeError("VALIDATION_ERROR", `unknown command "${cmd}" (see --help)`);

    const db = openDatabase(resolveDbPath(env));
    try {
      const store = new ProjectStore(db);
      switch (sub) {
        case "list":
          print({ projects: store.list() });
          return 0;
        case "create": {
          const settings = {
            ...(values.width !== undefined ? { width: int("width", values.width) } : {}),
            ...(values.height !== undefined ? { height: int("height", values.height) } : {}),
            ...(values.fps !== undefined ? { fps: parseFpsFlag(values.fps) } : {}),
          };
          print({ project: store.create({ name: need(values.name, "--name"), settings }, "cli") });
          return 0;
        }
        case "get":
          print({ project: store.get(need(arg, "<id>")) });
          return 0;
        case "rename":
          print({
            project: store.rename(
              need(arg, "<id>"),
              { name: need(values.name, "--name"), baseRevision: need(int("base-revision", values["base-revision"]), "--base-revision") },
              "cli",
            ),
          });
          return 0;
        case "history":
          print({ operations: store.history(need(arg, "<id>")) });
          return 0;
        default:
          throw new ReelForgeError("VALIDATION_ERROR", `unknown subcommand "project ${sub ?? ""}" (see --help)`);
      }
    } finally {
      db.close();
    }
  } catch (e) {
    const err = isReelForgeError(e)
      ? e
      : e instanceof Error && "code" in e && String(e.code).startsWith("ERR_PARSE_ARGS")
        ? new ReelForgeError("VALIDATION_ERROR", e.message)
        : new ReelForgeError("INTERNAL", e instanceof Error ? e.message : String(e));
    io.err(JSON.stringify({ error: err.toJSON() }, null, pretty ? 2 : 0) + "\n");
    return EXIT[err.code];
  }
}

function parseFpsFlag(v: string) {
  try {
    return parseFps(v);
  } catch (e) {
    throw new ReelForgeError("VALIDATION_ERROR", e instanceof Error ? e.message : String(e));
  }
}

async function serve(
  env: NodeJS.ProcessEnv,
  values: { port?: string | undefined; "allow-origin"?: string[] | undefined },
  io: Io,
): Promise<number> {
  // The desktop shell passes its own token via env; standalone runs get a fresh one.
  const provided = env.REELFORGE_API_TOKEN;
  const token = provided ?? randomBytes(32).toString("base64url");
  const db = openDatabase(resolveDbPath(env));
  const srv = await startApiServer({
    db,
    token,
    port: int("port", values.port) ?? 0,
    allowedOrigins: values["allow-origin"] ?? [],
    ...(env.REELFORGE_DEBUG ? { log: (line: string) => io.err(`[reelforge-server] ${line}\n`) } : {}),
  });
  // One machine-readable line; the sidecar parent waits for it.
  io.out(JSON.stringify({ event: "ready", url: srv.url, ...(provided ? {} : { token }) }) + "\n");

  await new Promise<void>((resolve) => {
    const stop = () => resolve();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    // When the parent (desktop app) dies, stdin closes: exit instead of lingering.
    process.stdin.once("end", stop);
    process.stdin.resume();
  });
  // stdin was only a liveness signal; release it or it keeps the event loop alive.
  process.stdin.destroy();
  await srv.close();
  db.close();
  return 0;
}
