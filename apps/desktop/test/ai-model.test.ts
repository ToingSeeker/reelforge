import { test } from "node:test";
import assert from "node:assert/strict";
import type { AIProviderInfo } from "../src/api.ts";
import { defaultModel } from "../src/ai-model.ts";

const p = (id: AIProviderInfo["id"], extra: Partial<AIProviderInfo> = {}): AIProviderInfo => ({
  id, label: id, external: id !== "ollama", available: true, defaultModel: null, models: [`${id}-m1`, `${id}-m2`], ...extra,
});

test("with no model chosen, a running local Ollama model wins over paid providers", () => {
  const all = [p("anthropic", { credential: "keychain", defaultModel: "anthropic-m2" }), p("claude-code"), p("codex"), p("ollama", { defaultModel: "ollama-m2" })];
  assert.deepEqual(defaultModel(all, null), { provider: "ollama", model: "ollama-m2" });
  assert.deepEqual(defaultModel([p("claude-code"), p("ollama")], null), { provider: "ollama", model: "ollama-m1" });
});

test("without Ollama nothing paid is picked silently", () => {
  assert.equal(defaultModel([p("anthropic", { credential: "keychain" }), p("claude-code"), p("codex")], null), null);
  assert.equal(defaultModel([p("claude-code"), p("ollama", { available: false })], null), null, "Ollama offline");
  assert.equal(defaultModel([p("claude-code"), p("ollama", { models: [] })], null), null, "Ollama without models");
});

test("an explicit choice stays while it's still offered", () => {
  const all = [p("claude-code"), p("ollama")];
  const saved = { provider: "claude-code", model: "claude-code-m2" };
  assert.equal(defaultModel(all, saved), saved);
  assert.deepEqual(defaultModel(all, { provider: "codex", model: "codex-m1" }), { provider: "ollama", model: "ollama-m1" }, "no longer listed");
  assert.deepEqual(defaultModel([p("claude-code", { available: false }), p("ollama")], saved), { provider: "ollama", model: "ollama-m1" }, "uninstalled");
});
