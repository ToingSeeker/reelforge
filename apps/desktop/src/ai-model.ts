// Which AI Director model is picked when the user hasn't chosen one.

import type { AIProviderInfo } from "./api.ts";

export interface ModelChoice {
  provider: string;
  model: string;
}

/**
 * The user's saved choice while it's still offered; otherwise a local Ollama model when one is
 * installed and running. Paid providers (Claude API, Claude Code, Codex) are never picked silently:
 * without Ollama this returns null and the panel asks the user to choose.
 */
export function defaultModel(providers: readonly AIProviderInfo[], saved: ModelChoice | null): ModelChoice | null {
  if (saved && providers.some((x) => x.id === saved.provider && x.available !== false && x.models.includes(saved.model))) return saved;
  const local = providers.find((x) => x.id === "ollama" && x.models.length > 0 && x.available !== false);
  return local ? { provider: local.id, model: local.defaultModel && local.models.includes(local.defaultModel) ? local.defaultModel : local.models[0]! } : null;
}
