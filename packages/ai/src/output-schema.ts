// The JSON a planner model must return. Loose on purpose (no numeric ranges or
// formats, which structured-output engines handle unevenly); the engine then
// validates every operation against the real schema and by a dry run.

import { CAPTION_FONTS, TimelineOpSchema, type TimelineOp } from "@reelforge/core";
import { z } from "zod";

const str = { type: "string" };
const int = { type: "integer" };
const num = { type: "number" };
const bool = { type: "boolean" };
const obj = (properties: Record<string, unknown>, required: string[]) => ({ type: "object", additionalProperties: false, properties, required });
const op = (type: string, properties: Record<string, unknown>, required: string[]) =>
  obj({ type: { type: "string", enum: [type] }, why: str, ...properties }, ["type", "why", ...required]);

const PROPS = obj(
  {
    fit: { type: "string", enum: ["cover", "contain"] },
    scale: num, scaleEnd: num, x: num, y: num, rotation: num, opacity: num,
    cropLeft: num, cropTop: num, cropRight: num, cropBottom: num,
    fadeIn: int, fadeOut: int, transitionIn: int, gainDb: num,
  },
  [],
);
const STYLE = obj(
  {
    font: { type: "string", enum: Object.keys(CAPTION_FONTS) },
    size: num, color: str, highlight: str, strokeColor: str, stroke: num, shadow: bool, box: str, y: num, maxWidth: num, uppercase: bool,
  },
  [],
);

export const MODEL_OUTPUT_SCHEMA = obj(
  {
    summary: str,
    warnings: { type: "array", items: str },
    operations: {
      type: "array",
      items: {
        anyOf: [
          op("clip.add", { clipId: str, trackId: str, assetId: str, start: int, sourceIn: int, duration: int, props: PROPS }, ["trackId", "assetId", "start"]),
          op("clip.update", { clipId: str, props: PROPS }, ["clipId", "props"]),
          op("clip.move", { clipId: str, start: int, trackId: str }, ["clipId", "start"]),
          op("clip.trim", { clipId: str, edge: { type: "string", enum: ["start", "end"] }, frame: int }, ["clipId", "edge", "frame"]),
          op("clip.split", { clipId: str, frame: int, newClipId: str }, ["clipId", "frame"]),
          op("clip.delete", { clipIds: { type: "array", items: str }, ripple: bool }, ["clipIds"]),
          op("track.update", { trackId: str, name: str, muted: bool, locked: bool, hidden: bool, captionStyle: STYLE }, ["trackId"]),
          op("caption.add", { trackId: str, captionId: str, start: int, duration: int, text: str }, ["trackId", "start", "duration", "text"]),
          op("caption.update", { captionId: str, text: str, start: int, duration: int }, ["captionId"]),
          op("caption.delete", { captionIds: { type: "array", items: str } }, ["captionIds"]),
          op("captions.replace", { trackId: str, captions: { type: "array", items: obj({ start: int, duration: int, text: str }, ["start", "duration", "text"]) } }, ["trackId", "captions"]),
        ],
      },
    },
  },
  ["summary", "warnings", "operations"],
);

const Loose = z.object({
  summary: z.string().default(""),
  warnings: z.array(z.string()).default([]),
  operations: z.array(z.record(z.string(), z.unknown())).default([]),
});

export interface ParsedPlan {
  summary: string;
  warnings: string[];
  operations: TimelineOp[];
  explanations: string[];
  /** Problems to send back to the model for one repair round. */
  errors: string[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Parse model output. New ids may be written as placeholders ("new-1") so a
 * plan can add a clip and refer to it later; each placeholder becomes one UUID.
 */
export function parseModelOutput(text: string, newId: () => string = () => crypto.randomUUID()): ParsedPlan {
  let raw: unknown;
  const json = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  try {
    raw = JSON.parse(json);
  } catch {
    return { summary: "", warnings: [], operations: [], explanations: [], errors: ["The reply was not valid JSON. Reply with only the JSON object."] };
  }
  const loose = Loose.safeParse(raw);
  if (!loose.success) return { summary: "", warnings: [], operations: [], explanations: [], errors: ["The JSON must have summary, warnings and operations."] };

  const placeholders = new Map<string, string>();
  const idFields = new Set(["clipId", "newClipId", "captionId"]);
  const listFields = new Set(["clipIds", "captionIds"]);
  const mapId = (v: unknown) => {
    if (typeof v !== "string" || UUID.test(v)) return v;
    if (!/^new[-_]?[\w-]*$/i.test(v)) return v; // leave it for validation to reject
    if (!placeholders.has(v)) placeholders.set(v, newId());
    return placeholders.get(v);
  };

  const operations: TimelineOp[] = [];
  const explanations: string[] = [];
  const errors: string[] = [];
  loose.data.operations.forEach((o, i) => {
    const { why, ...rest } = o as Record<string, unknown> & { why?: unknown };
    const mapped: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(rest)) {
      mapped[k] = idFields.has(k) ? mapId(v) : listFields.has(k) && Array.isArray(v) ? v.map(mapId) : v;
    }
    const r = TimelineOpSchema.safeParse(mapped);
    if (!r.success) {
      errors.push(`operation ${i + 1} (${String(rest.type)}): ${r.error.issues.map((x) => `${x.path.join(".") || "op"}: ${x.message}`).join("; ")}`);
      return;
    }
    operations.push(r.data);
    explanations.push(typeof why === "string" ? why : "");
  });
  return { summary: loose.data.summary, warnings: loose.data.warnings, operations, explanations, errors };
}
