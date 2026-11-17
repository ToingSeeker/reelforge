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
import { ClaudeCodeProvider, CodexProvider, listCodexModels } from "./providers/agents.ts";
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

/** A provider's model when the request names none ("" when nothing is available). */
export async function defaultModelFor(id: string): Promise<string> {
  if (id === "anthropic" || id === "claude-code") return ANTHROPIC_DEFAULT_MODEL;
  if (id === "codex") return listCodexModels()[0] ?? "";
  return (await listOllamaModels()).models[0] ?? "";
}
