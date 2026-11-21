// Coding-agent CLIs as planners: Claude Code (`claude -p`) and Codex (`codex exec`).
// Each uses the sign-in the user already has in that CLI (no API key in ReelForge),
// runs with no tools in an empty scratch folder, and returns the same JSON a
// direct API provider would. Context still leaves the machine, so both need consent.
// "No tools" is enforced by CLI flags, never by asking the model: the prompt carries
// text from filenames, transcripts and phone instructions.

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { ReelForgeError } from "@reelforge/core";
import type { CompletionRequest, CompletionResult, PlannerProvider } from "./types.ts";

export const CLAUDE_CODE_MODELS = ["claude-opus-5-5", "claude-sonnet-5-5"];
const CODEX_FALLBACK_MODELS = ["gpt-6.1-sol", "gpt-6.1-terra"];
const TIMEOUT_MS = 10 * 60_000;

/** A GUI app's sidecar gets a minimal PATH, so also look where these CLIs are usually installed. */
function findBinary(name: string, envVar: string, extra: string[]): string | null {
  const fromEnv = process.env[envVar];
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  const home = homedir();
  const dirs = [...(process.env.PATH ?? "").split(delimiter), join(home, ".local/bin"), "/opt/homebrew/bin", "/usr/local/bin", join(home, ".npm-global/bin"), join(home, ".bun/bin")];
  for (const d of dirs) if (d && existsSync(join(d, name))) return join(d, name);
  return extra.find((p) => existsSync(p)) ?? null;
}

export const claudeBinary = () => findBinary("claude", "REELFORGE_CLAUDE_BIN", [join(homedir(), ".claude/local/claude")]);
export const codexBinary = () =>
  findBinary("codex", "REELFORGE_CODEX_BIN", [
    "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex",
    "/Applications/Codex.app/Contents/Resources/codex-cli/bin/codex",
  ]);

/** Codex's own model list (written by the Codex CLI), newest first; a fixed list if it isn't there. */
export function listCodexModels(): string[] {
  try {
    const cache = JSON.parse(readFileSync(join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "models_cache.json"), "utf8")) as {
      models?: { slug?: string; visibility?: string; priority?: number }[];
    };
    const models = (cache.models ?? []).filter((m) => m.slug && m.visibility === "list").map((m) => m.slug!);
    return models.length ? models : CODEX_FALLBACK_MODELS;
  } catch {
    return CODEX_FALLBACK_MODELS;
  }
}

/** The whole conversation as one prompt: these CLIs take a single message per run. */
function flatten(req: CompletionRequest): string {
  if (req.turns.length === 1) return req.turns[0]!.content;
  return req.turns.map((t) => `<${t.role}>\n${t.content}\n</${t.role}>`).join("\n\n") + "\n\nReply to the last <user> message.";
}

/**
 * Codex settings that take away every tool the agent would otherwise get in `codex exec`. `-s read-only` only
 * stops writes: without these the model is offered exec_command (shell, which can read any file the user can),
 * view_image, web_search and more. Checked against codex-cli 0.171.0 by capturing the request it sends: with
 * these the only tool left is request_user_input, which reads nothing. Settings an older or newer Codex does not
 * know are ignored with a warning, so the list can name every tool feature.
 */
export const CODEX_NO_TOOLS: readonly string[] = [
  "features.shell_tool=false",
  "features.unified_exec=false",
  "features.view_image=false",
  "features.multi_agent=false",
  "features.goals=false",
  "features.apps=false",
  "features.plugins=false",
  "features.browser_use=false",
  "features.computer_use=false",
  "features.image_generation=false",
  'web_search="disabled"',
].flatMap((kv) => ["-c", kv]);

/** What Codex needs from the environment: where it lives, its sign-in, proxies. Nothing else of the engine's. */
const CODEX_ENV = /^(PATH|HOME|USER|LOGNAME|SHELL|TMPDIR|LANG|LC_[A-Z_]+|TERM|CODEX_HOME|OPENAI_API_KEY|OPENAI_BASE_URL|OPENAI_ORG_ID|OPENAI_PROJECT_ID|HTTPS?_PROXY|https?_proxy|ALL_PROXY|NO_PROXY|no_proxy|SSL_CERT_FILE|SSL_CERT_DIR|NODE_EXTRA_CA_CERTS)$/;

function run(bin: string, args: string[], input: string, cwd: string, signal: AbortSignal | undefined, label: string, envFilter?: RegExp): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new ReelForgeError("UNAVAILABLE", `${label} request was cancelled`));
    // Drop variables that would make a nested Claude Code think it runs inside another session.
    const env = envFilter ? Object.fromEntries(Object.entries(process.env).filter(([k]) => envFilter.test(k))) : { ...process.env };
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE_ENTRYPOINT;
    const child = spawn(bin, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d: Buffer) => (out += d));
    child.stderr.on("data", (d: Buffer) => (err += d));
    const kill = () => child.kill("SIGTERM");
    const timer = setTimeout(kill, TIMEOUT_MS);
    signal?.addEventListener("abort", kill, { once: true });
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new ReelForgeError("UNAVAILABLE", `could not start ${label}: ${e.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", kill);
      if (signal?.aborted) return reject(new ReelForgeError("UNAVAILABLE", `${label} request was cancelled`));
      if (code !== 0) {
        const tail = (err || out).trim().split("\n").slice(-3).join(" ").slice(0, 400);
        return reject(new ReelForgeError("UNAVAILABLE", `${label} exited with code ${code}${tail ? `: ${tail}` : ""}`));
      }
      resolve(out);
    });
    child.stdin.end(input);
  });
}

function scratch<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "reelforge-agent-"));
  return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
}

export class ClaudeCodeProvider implements PlannerProvider {
  readonly id = "claude-code";
  readonly recipient = "anthropic";
  readonly external = true;

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    const bin = claudeBinary();
    if (!bin) throw new ReelForgeError("UNAVAILABLE", "Claude Code is not installed (the `claude` command was not found); set REELFORGE_CLAUDE_BIN if it lives elsewhere");
    const args = [
      "-p",
      "--output-format", "json",
      "--json-schema", JSON.stringify(req.schema),
      "--model", req.model,
      "--system-prompt", req.system,
      "--tools", "",
      "--no-session-persistence",
      "--setting-sources", "",
      "--strict-mcp-config",
    ];
    const raw = await scratch((dir) => run(bin, args, flatten(req), dir, req.signal, "Claude Code"));
    let result: { is_error?: boolean; result?: string; structured_output?: unknown; modelUsage?: Record<string, unknown>; usage?: Record<string, unknown>; total_cost_usd?: number };
    try {
      result = JSON.parse(raw);
    } catch {
      throw new ReelForgeError("INTERNAL", "Claude Code returned output that was not JSON");
    }
    if (result.is_error) throw new ReelForgeError("UNAVAILABLE", `Claude Code: ${result.result ?? "request failed"}`);
    const text = result.structured_output !== undefined ? JSON.stringify(result.structured_output) : (result.result ?? "");
    // Claude Code also runs a small helper model, so report the model that wrote the most output.
    const usedBy = Object.entries((result.modelUsage ?? {}) as Record<string, { outputTokens?: number }>).sort((a, b) => (b[1].outputTokens ?? 0) - (a[1].outputTokens ?? 0));
    return { text, model: usedBy[0]?.[0] ?? req.model, usage: { via: "claude-code", ...(result.usage ?? {}), costUsd: result.total_cost_usd ?? null } };
  }
}

/**
 * OpenAI structured output is strict: every property must be listed as required.
 * Optional properties become nullable instead, and the nulls are stripped from the reply.
 */
export function strictSchema(s: unknown): unknown {
  if (Array.isArray(s)) return s.map(strictSchema);
  if (!s || typeof s !== "object") return s;
  const o = Object.fromEntries(Object.entries(s).map(([k, v]) => [k, strictSchema(v)])) as Record<string, unknown>;
  if (o.type === "object" && o.properties && typeof o.properties === "object") {
    const required = new Set((o.required as string[] | undefined) ?? []);
    const props = o.properties as Record<string, unknown>;
    o.properties = Object.fromEntries(Object.entries(props).map(([k, v]) => [k, required.has(k) ? v : nullable(v)]));
    o.required = Object.keys(props);
  }
  return o;
}

function nullable(v: unknown): unknown {
  const s = v as Record<string, unknown>;
  if (typeof s.type === "string" && !s.enum) return { ...s, type: [s.type, "null"] };
  return { anyOf: [s, { type: "null" }] };
}

export function stripNulls(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stripNulls);
  if (!v || typeof v !== "object") return v;
  return Object.fromEntries(Object.entries(v).filter(([, x]) => x !== null).map(([k, x]) => [k, stripNulls(x)]));
}

export class CodexProvider implements PlannerProvider {
  readonly id = "codex";
  readonly recipient = "openai";
  readonly external = true;

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    const bin = codexBinary();
    if (!bin) throw new ReelForgeError("UNAVAILABLE", "Codex is not installed (the `codex` command was not found); set REELFORGE_CODEX_BIN if it lives elsewhere");
    const text = await scratch(async (dir) => {
      const schemaFile = join(dir, "schema.json");
      const outFile = join(dir, "reply.json");
      writeFileSync(schemaFile, JSON.stringify(strictSchema(req.schema)));
      const args = [
        "exec",
        "--ephemeral",
        "--skip-git-repo-check",
        "--ignore-user-config",
        "--ignore-rules",
        "-s", "read-only",
        ...CODEX_NO_TOOLS,
        "-m", req.model,
        "--output-schema", schemaFile,
        "-o", outFile,
        "-C", dir,
        "-",
      ];
      // Codex has no separate system prompt in exec mode, so the instructions lead the message.
      const prompt = `${req.system}\n\nDo not run commands or read files: everything you need is below. Reply with only the JSON object.\n\n${flatten(req)}`;
      await run(bin, args, prompt, dir, req.signal, "Codex", CODEX_ENV);
      if (!existsSync(outFile)) throw new ReelForgeError("INTERNAL", "Codex finished without a reply");
      return readFileSync(outFile, "utf8");
    });
    let cleaned = text;
    try {
      cleaned = JSON.stringify(stripNulls(JSON.parse(text.trim())));
    } catch {
      // Not JSON: the planner reports it and asks the model to repair.
    }
    return { text: cleaned, model: req.model, usage: { via: "codex" } };
  }
}
