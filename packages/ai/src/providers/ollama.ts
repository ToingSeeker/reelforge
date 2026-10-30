import { ReelForgeError } from "@reelforge/core";
import type { CompletionRequest, CompletionResult, PlannerProvider } from "./types.ts";

export const ollamaUrl = () => (process.env.REELFORGE_OLLAMA_URL ?? "http://127.0.0.1:11434").replace(/\/+$/, "");

/** Local models through Ollama: nothing leaves the machine, so no consent is needed. */
export class OllamaProvider implements PlannerProvider {
  readonly id = "ollama";
  readonly external = false;

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    let res: Response;
    try {
      res = await fetch(`${ollamaUrl()}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: req.model,
          stream: false,
          think: false,
          format: req.schema,
          options: { temperature: 0.2, num_ctx: 32768 },
          messages: [{ role: "system", content: req.system }, ...req.turns],
        }),
        signal: req.signal ?? AbortSignal.timeout(15 * 60_000),
      });
    } catch {
      throw new ReelForgeError("UNAVAILABLE", `Ollama is not reachable at ${ollamaUrl()} (is it running?)`);
    }
    const body = (await res.json().catch(() => ({}))) as { message?: { content?: string }; error?: string; model?: string; prompt_eval_count?: number; eval_count?: number; total_duration?: number };
    if (!res.ok) throw new ReelForgeError("UNAVAILABLE", `Ollama: ${body.error ?? `HTTP ${res.status}`}`);
    return {
      text: body.message?.content ?? "",
      model: body.model ?? req.model,
      usage: { input_tokens: body.prompt_eval_count ?? 0, output_tokens: body.eval_count ?? 0, total_ms: Math.round((body.total_duration ?? 0) / 1e6) },
    };
  }
}

export async function listOllamaModels(): Promise<{ available: boolean; models: string[] }> {
  try {
    const r = await fetch(`${ollamaUrl()}/api/tags`, { signal: AbortSignal.timeout(1500) });
    const j = (await r.json()) as { models?: { name: string }[] };
    return { available: true, models: (j.models ?? []).map((m) => m.name) };
  } catch {
    return { available: false, models: [] };
  }
}
