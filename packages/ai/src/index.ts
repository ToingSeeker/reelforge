export { propose, type ProposeInput } from "./planner.ts";
export { MODEL_OUTPUT_SCHEMA, parseModelOutput } from "./output-schema.ts";
export { SYSTEM_PROMPT } from "./prompt.ts";
export { AnthropicProvider, ANTHROPIC_DEFAULT_MODEL } from "./providers/anthropic.ts";
export { OllamaProvider, listOllamaModels, ollamaUrl } from "./providers/ollama.ts";
export { setCredential, getCredential, credentialSource } from "./credentials.ts";
export type { PlannerProvider, CompletionRequest, CompletionResult, ChatTurn } from "./providers/types.ts";

import { AnthropicProvider } from "./providers/anthropic.ts";
import { OllamaProvider } from "./providers/ollama.ts";
import { getCredential } from "./credentials.ts";
import { ReelForgeError } from "@reelforge/core";

export function providerFor(id: string) {
  if (id === "anthropic") return new AnthropicProvider(() => getCredential("anthropic"));
  if (id === "ollama") return new OllamaProvider();
  throw new ReelForgeError("VALIDATION_ERROR", `unknown AI provider "${id}" (use anthropic or ollama)`);
}
