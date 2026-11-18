export { propose, type ProposeInput } from "./planner.ts";
export { MODEL_OUTPUT_SCHEMA, parseModelOutput } from "./output-schema.ts";
export { SYSTEM_PROMPT, OPERATIONS_GUIDE } from "./prompt.ts";
export { AnthropicProvider, ANTHROPIC_DEFAULT_MODEL } from "./providers/anthropic.ts";
export { OllamaProvider, listOllamaModels, ollamaUrl } from "./providers/ollama.ts";
export { ClaudeCodeProvider, CodexProvider, CLAUDE_CODE_MODELS, claudeBinary, codexBinary, listCodexModels, strictSchema, stripNulls } from "./providers/agents.ts";
export { setCredential, getCredential, credentialSource } from "./credentials.ts";
export type { PlannerProvider, CompletionRequest, CompletionResult, ChatTurn } from "./providers/types.ts";

import { AnthropicProvider } from "./providers/anthropic.ts";
import { OllamaProvider, listOllamaModels } from "./providers/ollama.ts";
import { ClaudeCodeProvider, CodexProvider, CLAUDE_CODE_MODELS, claudeBinary, codexBinary, listCodexModels } from "./providers/agents.ts";
import { credentialSource } from "./credentials.ts";
import { ANTHROPIC_DEFAULT_MODEL } from "./providers/anthropic.ts";
import { getCredential } from "./credentials.ts";
import type { PlannerProvider } from "./providers/types.ts";
import { ReelForgeError } from "@reelforge/core";

export function providerFor(id: string): PlannerProvider {
  if (id === "anthropic") return new AnthropicProvider(() => getCredential("anthropic"));
  if (id === "ollama") return new OllamaProvider();
  if (id === "claude-code") return new ClaudeCodeProvider();
  if (id === "codex") return new CodexProvider();
  throw new ReelForgeError("VALIDATION_ERROR", `unknown AI provider "${id}" (use anthropic, ollama, claude-code or codex)`);
}

/** Who a provider sends project context to, for per-recipient consent. */
export function consentRecipient(providerId: string): string {
  return providerFor(providerId).recipient ?? providerId;
}

export interface AIProviderInfo {
  id: "anthropic" | "claude-code" | "codex" | "ollama";
  label: string;
  external: boolean;
  credential?: "keychain" | "environment" | "none";
  available?: boolean;
  defaultModel: string | null;
  models: string[];
}

/** Every provider and what it can run on this Mac (GET /v1/ai/providers, the phone's model picker). */
export async function listAIProviders(): Promise<AIProviderInfo[]> {
  const ollama = await listOllamaModels();
  return [
    { id: "anthropic", label: "Claude API", external: true, credential: credentialSource("anthropic"), defaultModel: ANTHROPIC_DEFAULT_MODEL, models: [ANTHROPIC_DEFAULT_MODEL, "claude-sonnet-5-5"] },
    { id: "claude-code", label: "Claude Code", external: true, available: !!claudeBinary(), defaultModel: CLAUDE_CODE_MODELS[0] ?? null, models: [...CLAUDE_CODE_MODELS] },
    { id: "codex", label: "Codex", external: true, available: !!codexBinary(), defaultModel: listCodexModels()[0] ?? null, models: listCodexModels() },
    { id: "ollama", label: "Local (Ollama)", external: new OllamaProvider().external, available: ollama.available, defaultModel: ollama.models[0] ?? null, models: ollama.models },
  ];
}

/** Can run now: Claude needs a key; the others need their program or models installed. */
export function providerReady(p: AIProviderInfo): boolean {
  return p.models.length > 0 && (p.id === "anthropic" ? p.credential !== "none" : p.available !== false);
}

/** A provider's model when the request names none ("" when nothing is available). */
export async function defaultModelFor(id: string): Promise<string> {
  if (id === "anthropic" || id === "claude-code") return ANTHROPIC_DEFAULT_MODEL;
  if (id === "codex") return listCodexModels()[0] ?? "";
  return (await listOllamaModels()).models[0] ?? "";
}
