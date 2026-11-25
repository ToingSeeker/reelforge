import type { z } from "zod";
import { ReelForgeError } from "./errors.ts";

/** Validate untrusted input, turning zod issues into a VALIDATION_ERROR with field paths. */
export function parse<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const result = schema.safeParse(input);
  if (!result.success) {
    const issues = result.error.issues;
    const first = issues[0] as { path: PropertyKey[]; code?: string; format?: string } | undefined;
    // A bare id that isn't one (a typo, a name pasted where the id goes): say so instead of "invalid input".
    const badId = issues.length === 1 && first?.path.length === 0 && first.code === "invalid_format" && first.format === "uuid" && typeof input === "string";
    const message = badId
      ? `"${String(input).slice(0, 80)}" is not a valid id (ids are UUIDs like 3f2b8c1e-9d4a-4c1b-8e2f-0a1b2c3d4e5f; see \`project list\` / \`media list\`)`
      : "invalid input";
    throw new ReelForgeError("VALIDATION_ERROR", message, {
      issues: issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  }
  return result.data;
}
