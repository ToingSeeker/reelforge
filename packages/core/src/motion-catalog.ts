// Motion-graphics templates (packages/motion, rendered with Remotion). This module is the
// contract only: ids, editable props and their limits. The React compositions live in
// packages/motion; the engine, the desktop panel and the renderer all validate against this.

import { z } from "zod";
import { MAX_FRAME } from "./schema.ts";
import { stableHash } from "./fx-bake.ts";
import { ReelForgeError } from "./errors.ts";

/** Bump when a template's look or how we render changes: same props then make a new file. */
export const MOTION_VERSION = "motion@1";

/** Longest graphic we render (seconds). They're overlays; long ones are better as real video. */
export const MOTION_MAX_SECONDS = 60;

/** The most frames a graphic may have at a frame rate (MOTION_MAX_SECONDS of it). */
export function motionMaxFrames(fps: { num: number; den: number }): number {
  return Math.floor((MOTION_MAX_SECONDS * fps.num) / fps.den);
}

/** Why a length can't be rendered at this frame rate, or null. Every caller (engine, renderer, panel) uses it. */
export function motionLengthIssue(durationFrames: number, fps: { num: number; den: number }): string | null {
  const max = motionMaxFrames(fps);
  return durationFrames > max ? `a motion graphic can be at most ${MOTION_MAX_SECONDS} seconds (${max} frames at this frame rate)` : null;
}

const Hex = z.string().regex(/^#[0-9a-fA-F]{6}$/, "colour must be #rrggbb");
const line = (max: number) => z.string().trim().max(max);

export const TitleCardPropsSchema = z.strictObject({
  title: line(80).min(1, "title is required"),
  subtitle: line(120),
  accent: Hex,
  color: Hex,
  align: z.enum(["center", "left"]),
});

export const LowerThirdPropsSchema = z.strictObject({
  name: line(60).min(1, "name is required"),
  role: line(80),
  accent: Hex,
  color: Hex,
  panel: Hex,
  side: z.enum(["left", "right"]),
});

export const BadgePropsSchema = z.strictObject({
  text: line(40).min(1, "text is required"),
  accent: Hex,
  color: Hex,
  corner: z.enum(["top-left", "top-right", "bottom-left", "bottom-right"]),
});

export type TitleCardProps = z.infer<typeof TitleCardPropsSchema>;
export type LowerThirdProps = z.infer<typeof LowerThirdPropsSchema>;
export type BadgeProps = z.infer<typeof BadgePropsSchema>;

interface TemplateDef<S extends z.ZodType> {
  label: string;
  description: string;
  defaultSeconds: number;
  schema: S;
  defaults: z.infer<S>;
}

export const MOTION_TEMPLATES = {
  "title-card": {
    label: "Title card",
    description: "Big headline with a subtitle, for openers and chapter breaks.",
    defaultSeconds: 4,
    schema: TitleCardPropsSchema,
    defaults: { title: "Your headline", subtitle: "A short line that sets it up", accent: "#ff5a36", color: "#ffffff", align: "center" },
  } satisfies TemplateDef<typeof TitleCardPropsSchema>,
  "lower-third": {
    label: "Lower third",
    description: "Name and role in a bar near the bottom of the frame.",
    defaultSeconds: 5,
    schema: LowerThirdPropsSchema,
    defaults: { name: "Alex Rivera", role: "Host", accent: "#ff5a36", color: "#ffffff", panel: "#111318", side: "left" },
  } satisfies TemplateDef<typeof LowerThirdPropsSchema>,
  badge: {
    label: "Badge",
    description: "A small label that pops in a corner: NEW, LIVE, a handle.",
    defaultSeconds: 3,
    schema: BadgePropsSchema,
    defaults: { text: "NEW", accent: "#ff5a36", color: "#ffffff", corner: "top-right" },
  } satisfies TemplateDef<typeof BadgePropsSchema>,
} as const;

export type MotionTemplateId = keyof typeof MOTION_TEMPLATES;
export const MOTION_TEMPLATE_IDS = Object.keys(MOTION_TEMPLATES) as MotionTemplateId[];
export const MotionTemplateIdSchema = z.enum(MOTION_TEMPLATE_IDS as [MotionTemplateId, ...MotionTemplateId[]]);

export type MotionProps = TitleCardProps | LowerThirdProps | BadgeProps;

export const CreateMotionInputSchema = z
  .strictObject({
    template: MotionTemplateIdSchema,
    props: z.record(z.string(), z.unknown()),
    /** Length in project frames. */
    durationFrames: z.number().int().min(1).max(MAX_FRAME),
  })
  .transform((v, ctx) => {
    const parsed = MOTION_TEMPLATES[v.template].schema.safeParse(v.props);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) ctx.addIssue({ ...issue, path: ["props", ...issue.path] } as never);
      return z.NEVER;
    }
    return { template: v.template, props: parsed.data as MotionProps, durationFrames: v.durationFrames };
  });
export type CreateMotionInput = z.input<typeof CreateMotionInputSchema>;

/** Everything the renderer needs for one file; `key` names the output so equal specs share it. */
export interface MotionRenderSpec {
  key: string;
  template: MotionTemplateId;
  props: MotionProps;
  width: number;
  height: number;
  fps: { num: number; den: number };
  /** Frames rendered: the requested length plus one, so flooring the probed duration never loses the last frame. */
  frames: number;
}

export function motionRenderSpec(
  input: { template: MotionTemplateId; props: MotionProps; durationFrames: number },
  settings: { width: number; height: number; fps: { num: number; den: number } },
): MotionRenderSpec {
  const issue = motionLengthIssue(input.durationFrames, settings.fps);
  if (issue) throw new ReelForgeError("VALIDATION_ERROR", issue, { issues: [{ path: "durationFrames", message: issue }] });
  const body = { template: input.template, props: input.props, width: settings.width, height: settings.height, fps: settings.fps, frames: input.durationFrames + 1 };
  return { key: stableHash(JSON.stringify({ v: MOTION_VERSION, ...body })), ...body };
}

/**
 * A readable file name for a rendered graphic ("Title card - Your headline"): the asset is named after
 * its file, and the render key means nothing to people. Safe as one path segment on every platform.
 */
export function motionFileName(template: MotionTemplateId, props: MotionProps): string {
  const p = props as Partial<Record<"title" | "name" | "text", string>>;
  const words = (p.title ?? p.name ?? p.text ?? "")
    .replace(/[\u0000-\u001f\u007f/\\:*?"<>|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60)
    .replace(/^[.\s]+|[.\s]+$/g, "");
  return words ? `${MOTION_TEMPLATES[template].label} - ${words}` : MOTION_TEMPLATES[template].label;
}
