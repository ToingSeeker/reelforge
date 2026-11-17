import Anthropic from "@anthropic-ai/sdk";
import { ReelForgeError } from "@reelforge/core";
import type { CompletionRequest, CompletionResult, PlannerProvider } from "./types.ts";

export const ANTHROPIC_DEFAULT_MODEL = "claude-opus-5-5";
const MISSING_KEY = "no Anthropic API key: add one in Settings (stored in the macOS Keychain), set ANTHROPIC_API_KEY, or run `ant auth login`";

/**
 * Claude via the official SDK. Structured output keeps the reply to the
 * proposal schema; the server-side `fallbacks: "default"` re-runs a request a
 * safety classifier declines on Anthropic's recommended fallback model.
 */
export class AnthropicProvider implements PlannerProvider {
  readonly id = "anthropic";
  readonly recipient = "anthropic";
  readonly external = true;
  readonly #apiKey: () => string | undefined;

  constructor(apiKey: () => string | undefined) {
    this.#apiKey = apiKey;
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    let client: Anthropic;
    try {
      const key = this.#apiKey();
      // Without a stored key the SDK resolves ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN / an `ant auth login` profile.
      client = key ? new Anthropic({ apiKey: key }) : new Anthropic();
    } catch {
      throw new ReelForgeError("UNAVAILABLE", MISSING_KEY);
    }
    try {
      const stream = client.beta.messages.stream(
        {
          model: req.model,
          max_tokens: 32000,
          system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }],
          messages: req.turns.map((t) => ({ role: t.role, content: t.content })),
          output_config: { effort: "high", format: { type: "json_schema", schema: req.schema } },
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
        },
        req.signal ? { signal: req.signal } : undefined,
      );
      const msg = await stream.finalMessage();
      if (msg.stop_reason === "refusal") {
        throw new ReelForgeError("VALIDATION_ERROR", "Claude declined this request", { stopDetails: msg.stop_details ?? null });
      }
      if (msg.stop_reason === "max_tokens") throw new ReelForgeError("INTERNAL", "the proposal was cut off (too long); try a narrower instruction");
      const text = msg.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
      return { text, model: msg.model, usage: { ...msg.usage } as Record<string, unknown> };
    } catch (e) {
      if (e instanceof ReelForgeError) throw e;
      if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) {
        throw new ReelForgeError("UNAVAILABLE", "the Anthropic API key was rejected; check it in Settings");
      }
      if (e instanceof Anthropic.RateLimitError) throw new ReelForgeError("UNAVAILABLE", "Anthropic rate limit reached; try again shortly");
      if (e instanceof Anthropic.BadRequestError) throw new ReelForgeError("INTERNAL", `Anthropic rejected the request: ${e.message}`);
      if (e instanceof Anthropic.APIConnectionError) throw new ReelForgeError("UNAVAILABLE", "could not reach the Anthropic API (offline?)");
      if (e instanceof Anthropic.APIError) throw new ReelForgeError("UNAVAILABLE", `Anthropic API error ${e.status ?? ""}: ${e.message}`);
      // Client-side SDK errors (no credentials resolved, bad configuration) are raised before any request.
      if (e instanceof Anthropic.AnthropicError) throw new ReelForgeError("UNAVAILABLE", MISSING_KEY);
      throw e;
    }
  }
}
