import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CODEX_NO_TOOLS, CodexProvider, MODEL_OUTPUT_SCHEMA, parseModelOutput, providerFor, strictSchema, stripNulls } from "../src/index.ts";

type Schema = { type?: unknown; properties?: Record<string, Schema>; required?: string[]; anyOf?: Schema[]; items?: Schema; enum?: unknown[] };

/** Every object in the schema lists all of its properties as required (OpenAI strict mode). */
function assertStrict(s: Schema, path = "$"): void {
  if (s.type === "object" && s.properties) {
    assert.deepEqual([...(s.required ?? [])].sort(), Object.keys(s.properties).sort(), `${path} must require every property`);
    for (const [k, v] of Object.entries(s.properties)) assertStrict(v, `${path}.${k}`);
  }
  if (s.items) assertStrict(s.items, `${path}[]`);
  for (const [i, v] of (s.anyOf ?? []).entries()) assertStrict(v, `${path}|${i}`);
}

test("strictSchema makes every property required and optional ones nullable", () => {
  const s = strictSchema({ type: "object", additionalProperties: false, properties: { a: { type: "string" }, b: { type: "integer" }, c: { type: "string", enum: ["x"] } }, required: ["a"] }) as Schema;
  assert.deepEqual(s.required, ["a", "b", "c"]);
  assert.deepEqual(s.properties!.a, { type: "string" });
  assert.deepEqual(s.properties!.b, { type: ["integer", "null"] });
  assert.deepEqual(s.properties!.c, { anyOf: [{ type: "string", enum: ["x"] }, { type: "null" }] });
  assertStrict(strictSchema(MODEL_OUTPUT_SCHEMA) as Schema);
});

test("a strict reply with nulls parses like a normal one once nulls are stripped", () => {
  const reply = {
    summary: "Fade in",
    warnings: [],
    operations: [{ type: "clip.update", why: "soft start", clipId: "c1", props: { fadeIn: 15, scale: null, aiEffects: null, fit: null } }],
  };
  const plan = parseModelOutput(JSON.stringify(stripNulls(reply)));
  assert.deepEqual(plan.errors.filter((e) => !e.includes("clipId")), []);
  assert.deepEqual(stripNulls(reply.operations[0]), { type: "clip.update", why: "soft start", clipId: "c1", props: { fadeIn: 15 } });
});

test("providerFor knows the coding-agent providers, and both need consent", () => {
  for (const id of ["claude-code", "codex"]) {
    const p = providerFor(id);
    assert.equal(p.id, id);
    assert.equal(p.external, true);
  }
  assert.throws(() => providerFor("nope"), /claude-code or codex/);
});

test("consent is per recipient: an old Claude consent does not cover Codex (OpenAI)", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { consentCovers, openDatabase, ProjectStore, ProposalStore } = await import("@reelforge/core");
  const dir = mkdtempSync(join(tmpdir(), "reelforge-consent-"));
  try {
    const db = openDatabase(join(dir, "db.sqlite"));
    const p = new ProjectStore(db).create({ name: "C" }, "cli");
    const store = new ProposalStore(db);
    // A record written before recipients existed.
    db.prepare("UPDATE projects SET ai_consent = ? WHERE id = ?").run(JSON.stringify({ grantedAt: "2026-01-01T00:00:00Z", grantedBy: "desktop" }), p.id);
    assert.equal(consentCovers(store.consent(p.id), "anthropic"), true);
    assert.equal(consentCovers(store.consent(p.id), "openai"), false);
    store.setConsent(p.id, true, "desktop", "openai");
    assert.deepEqual(store.consent(p.id)?.recipients, ["anthropic", "ollama", "openai"]);
    store.setConsent(p.id, false, "desktop", "openai");
    assert.equal(consentCovers(store.consent(p.id), "openai"), false);
    assert.equal(consentCovers(store.consent(p.id), "anthropic"), true);
    store.setConsent(p.id, false, "desktop");
    assert.equal(store.consent(p.id), null);
    assert.equal(providerFor("codex").recipient, "openai");
    assert.equal(providerFor("claude-code").recipient, "anthropic");
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Codex runs with its tools switched off by flag and without the engine's environment", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rf-codex-stub-"));
  const saved = { bin: process.env.REELFORGE_CODEX_BIN, secret: process.env.RF_TEST_ENGINE_SECRET, anthropic: process.env.ANTHROPIC_API_KEY };
  try {
    // A stand-in `codex`: records its argv and environment, then writes a reply where -o points.
    const stub = join(dir, "codex");
    writeFileSync(
      stub,
      `#!/bin/sh\nprintf '%s\\n' "$@" > "${dir}/argv"\nenv > "${dir}/env"\nwhile [ $# -gt 0 ]; do if [ "$1" = "-o" ]; then printf '{"summary":"ok","warnings":[],"operations":[]}' > "$2"; fi; shift; done\n`,
    );
    chmodSync(stub, 0o755);
    process.env.REELFORGE_CODEX_BIN = stub;
    process.env.RF_TEST_ENGINE_SECRET = "engine-only";
    process.env.ANTHROPIC_API_KEY = "sk-not-for-openai";
    const res = await new CodexProvider().complete({ model: "gpt-x", system: "plan", turns: [{ role: "user", content: "hi" }], schema: { type: "object" } });
    assert.match(res.text, /"summary":"ok"/);
    const argv = readFileSync(join(dir, "argv"), "utf8").trim().split("\n");
    for (const kv of ["features.shell_tool=false", "features.unified_exec=false", "features.view_image=false", 'web_search="disabled"']) {
      const i = argv.indexOf(kv);
      assert.ok(i > 0 && argv[i - 1] === "-c", `missing -c ${kv}`);
    }
    assert.deepEqual(argv.filter((a, i) => argv[i - 1] === "-c"), CODEX_NO_TOOLS.filter((a) => a !== "-c"));
    assert.ok(argv.indexOf("exec") < argv.indexOf("-c"), "settings come after the subcommand");
    const env = readFileSync(join(dir, "env"), "utf8");
    assert.doesNotMatch(env, /RF_TEST_ENGINE_SECRET|ANTHROPIC_API_KEY/);
    assert.match(env, /^HOME=/m);
  } finally {
    for (const [k, v] of [["REELFORGE_CODEX_BIN", saved.bin], ["RF_TEST_ENGINE_SECRET", saved.secret], ["ANTHROPIC_API_KEY", saved.anthropic]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
