export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

export interface CompletionRequest {
  model: string;
  system: string;
  turns: ChatTurn[];
  /** JSON schema the reply must follow. */
  schema: Record<string, unknown>;
  signal?: AbortSignal;
}

export interface CompletionResult {
  text: string;
  model: string;
  usage: Record<string, unknown>;
}

export interface PlannerProvider {
  id: string;
  /** External providers need the project's consent before context leaves the machine. */
  external: boolean;
  /** Who receives the context when external ("anthropic", "openai", …); consent is granted per recipient. Defaults to the id. */
  recipient?: string;
  complete(req: CompletionRequest): Promise<CompletionResult>;
}
