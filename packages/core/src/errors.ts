export type ErrorCode =
  | "VALIDATION_ERROR"
  | "NOT_FOUND"
  | "REVISION_CONFLICT"
  | "UNAUTHORIZED"
  /** A required local dependency (e.g. FFmpeg) is missing or failed. */
  | "UNAVAILABLE"
  /** The user hasn't allowed sending this project's context to an external AI provider. */
  | "CONSENT_REQUIRED"
  | "INTERNAL";

/** Every failure that crosses a boundary (CLI, REST, MCP) is one of these. */
export class ReelForgeError extends Error {
  readonly code: ErrorCode;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "ReelForgeError";
    this.code = code;
    this.details = details;
  }

  toJSON() {
    return { code: this.code, message: this.message, ...(this.details ? { details: this.details } : {}) };
  }
}

export function isReelForgeError(e: unknown): e is ReelForgeError {
  return e instanceof ReelForgeError;
}
