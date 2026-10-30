// Wire contracts shared by the core, the REST server, the CLI and the desktop
// UI. Browser-safe: no node: imports here.
import { z } from "zod";

export const PROJECT_SCHEMA_VERSION = 1;

export const DEFAULT_PROJECT_SETTINGS = {
  width: 1080,
  height: 1920,
  fps: { num: 30, den: 1 },
} as const;

export const ActorSchema = z.enum(["desktop", "cli", "api", "mcp"]);
export type Actor = z.infer<typeof ActorSchema>;

export const RationalSchema = z
  .object({
    num: z.number().int().positive().max(1_000_000),
    den: z.number().int().positive().max(1_000_000),
  })
  .refine((r) => r.num / r.den >= 1 && r.num / r.den <= 240, {
    message: "frame rate must be between 1 and 240 fps",
  });

const Dimension = z
  .number()
  .int()
  .min(16)
  .max(8192)
  .refine((n) => n % 2 === 0, { message: "must be even (H.264 4:2:0 requirement)" });

export const ProjectSettingsSchema = z.object({
  width: Dimension,
  height: Dimension,
  fps: RationalSchema,
});
export type ProjectSettings = z.infer<typeof ProjectSettingsSchema>;

export const ProjectNameSchema = z
  .string()
  .trim()
  .min(1, "name is required")
  .max(120, "name must be at most 120 characters")
  .refine((s) => !/[\u0000-\u001f\u007f]/.test(s), { message: "name must not contain control characters" });

export const ProjectIdSchema = z.uuid();

export const ProjectSchema = z.object({
  id: ProjectIdSchema,
  name: z.string(),
  schemaVersion: z.number().int(),
  revision: z.number().int().nonnegative(),
  settings: ProjectSettingsSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Project = z.infer<typeof ProjectSchema>;

export const CreateProjectInputSchema = z.object({
  name: ProjectNameSchema,
  settings: ProjectSettingsSchema.partial().optional(),
});
export type CreateProjectInput = z.input<typeof CreateProjectInputSchema>;

export const RenameProjectInputSchema = z.object({
  name: ProjectNameSchema,
  /** The revision the caller last saw; a mismatch is a conflict, never a silent overwrite. */
  baseRevision: z.number().int().nonnegative(),
});
export type RenameProjectInput = z.input<typeof RenameProjectInputSchema>;

export const EditOperationSchema = z.object({
  id: z.uuid(),
  projectId: ProjectIdSchema,
  revision: z.number().int().positive(),
  kind: z.string(),
  payload: z.record(z.string(), z.unknown()),
  actor: ActorSchema,
  createdAt: z.string(),
});
export type EditOperation = z.infer<typeof EditOperationSchema>;

export function aspectRatioLabel(s: Pick<ProjectSettings, "width" | "height">): string {
  const known: Record<string, string> = { "9:16": "9:16 (Reels)", "16:9": "16:9", "1:1": "1:1", "4:5": "4:5" };
  let a = s.width;
  let b = s.height;
  while (b !== 0) [a, b] = [b, a % b];
  const key = `${s.width / a}:${s.height / a}`;
  return known[key] ?? key;
}
