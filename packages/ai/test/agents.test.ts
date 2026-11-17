import { test } from "node:test";
import assert from "node:assert/strict";
import { MODEL_OUTPUT_SCHEMA, parseModelOutput, providerFor, strictSchema, stripNulls } from "../src/index.ts";

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
