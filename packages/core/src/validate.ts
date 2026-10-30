import type { z } from "zod";
import { ReelForgeError } from "./errors.ts";

/** Validate untrusted input, turning zod issues into a VALIDATION_ERROR with field paths. */
export function parse<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new ReelForgeError("VALIDATION_ERROR", "invalid input", {
      issues: result.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  }
  return result.data;
}
