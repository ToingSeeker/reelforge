// Slash commands: typed shortcuts such as "/bw" or "/zoom in" that edit the selected clips
// directly, with no AI model involved. Parsing and targeting live here so the desktop app and the
// phone remote resolve a command to exactly the same timeline operations.

import type { Clip, ClipPropsPatch, Timeline, TimelineOp } from "./schema.ts";
import { secondsToFrames } from "./timebase.ts";
import { MOTION_PRESETS, motionPatch, PICTURE_EFFECTS, type MotionPreset, type PictureEffect } from "./effects.ts";

/** What a command can be applied to: "picture" = clips on video / overlay tracks, "any" = every clip. */
type Scope = "picture" | "any";

export interface SlashCommandInfo {
  /** Command word without the slash, e.g. "zoom". */
  name: string;
  /** How to type it, e.g. "/zoom in|out". */
  usage: string;
  hint: string;
}

export interface SlashCommand {
  /** Undo label, e.g. "Black & white". */
  label: string;
  scope: Scope;
  /** The props to set on each target clip (fades are clamped per clip). */
  build: (clip: Clip, fps: Timeline["project"]["settings"]["fps"]) => ClipPropsPatch;
}

export type SlashParse = { ok: true; command: SlashCommand } | { ok: false; error: string };

const PICTURE_ALIASES: Record<string, PictureEffect> = {
  blur: "blur",
  sharpen: "sharpen",
  vignette: "vignette",
  bw: "grayscale",
  grayscale: "grayscale",
  sepia: "sepia",
  grain: "grain",
};

const MOTION_WORDS: Record<string, MotionPreset> = {
  "zoom in": "zoomIn",
  "zoom out": "zoomOut",
  push: "pushIn",
  "pan left": "panLeft",
  "pan right": "panRight",
  kenburns: "kenBurns",
  still: "none",
};

const DEFAULT_FADE_SECONDS = 0.5;

/** Every command, in the order the autocomplete lists them. */
export const SLASH_COMMANDS: SlashCommandInfo[] = [
  ...PICTURE_EFFECTS.map((e) => {
    const name = e.key === "grayscale" ? "bw" : e.key;
    return { name, usage: `/${name} [0-100|off]`, hint: `${e.label} · ${e.hint}` };
  }),
  { name: "zoom", usage: "/zoom in|out", hint: "Zoom across the clip" },
  { name: "push", usage: "/push", hint: "Slow push in, 100 → 108 %" },
  { name: "pan", usage: "/pan left|right", hint: "Drift sideways" },
  { name: "kenburns", usage: "/kenburns", hint: "Zoom and drift" },
  { name: "still", usage: "/still", hint: "Remove the camera move" },
  { name: "fade", usage: "/fade [in|out] [seconds]", hint: `Fade in and/or out (default ${DEFAULT_FADE_SECONDS} s, off = none)` },
  { name: "clear", usage: "/clear", hint: "Remove all looks and the camera move" },
];

/** Commands whose name starts with what is typed after the slash (only while the word is being typed). */
export function slashSuggestions(input: string): SlashCommandInfo[] {
  const m = /^\/(\S*)$/.exec(input.trimStart());
  if (!m) return [];
  const word = m[1]!.toLowerCase();
  return SLASH_COMMANDS.filter((c) => c.name.startsWith(word));
}

export function isSlashCommand(input: string): boolean {
  return input.trimStart().startsWith("/");
}

/** "30", "30%", "0.3" → 0.3; "off" → 0. Values above 1 are read as percentages. */
function amount(raw: string): number | null {
  if (raw === "off" || raw === "0") return 0;
  const m = /^(\d+(?:[.,]\d+)?)(%?)$/.exec(raw);
  if (!m) return null;
  const n = Number(m[1]!.replace(",", "."));
  const v = m[2] || n > 1 ? n / 100 : n;
  return v >= 0 && v <= 1 ? Math.round(v * 1000) / 1000 : null;
}

/** "0.5", "0,5", "0.5s", "500ms" → seconds; "off" → 0. */
function seconds(raw: string): number | null {
  if (raw === "off") return 0;
  const m = /^(\d+(?:[.,]\d+)?)(s|ms)?$/.exec(raw);
  if (!m) return null;
  const n = Number(m[1]!.replace(",", "."));
  const v = m[2] === "ms" ? n / 1000 : n;
  return v <= 60 ? v : null;
}

export function parseSlash(input: string): SlashParse {
  const words = input.trim().replace(/^\//, "").toLowerCase().split(/\s+/).filter(Boolean);
  const [name, ...args] = words;
  if (!name) return { ok: false, error: "Type a command after the slash, e.g. /bw or /zoom in." };

  const effect = PICTURE_ALIASES[name];
  if (effect) {
    const info = PICTURE_EFFECTS.find((e) => e.key === effect)!;
    if (args.length > 1) return { ok: false, error: `/${name} takes one amount, e.g. /${name} 40.` };
    const v = args[0] === undefined ? info.preset : amount(args[0]);
    if (v === null) return { ok: false, error: `“${args[0]}” isn't an amount. Use 0–100, a percentage, or off.` };
    return { ok: true, command: { label: v === 0 ? `Remove ${info.label.toLowerCase()}` : info.label, scope: "picture", build: () => ({ [effect]: v }) } };
  }

  const motion = MOTION_WORDS[[name, ...args].join(" ")];
  if (motion) {
    const info = MOTION_PRESETS.find((m) => m.key === motion)!;
    return { ok: true, command: { label: motion === "none" ? "Remove motion" : info.label, scope: "picture", build: () => motionPatch(motion) } };
  }
  if (name === "zoom") return { ok: false, error: "Say which way: /zoom in or /zoom out." };
  if (name === "pan") return { ok: false, error: "Say which way: /pan left or /pan right." };

  if (name === "fade") {
    let side: "in" | "out" | "both" = "both";
    let rest = args;
    if (rest[0] === "in" || rest[0] === "out") {
      side = rest[0];
      rest = rest.slice(1);
    }
    if (rest.length > 1) return { ok: false, error: "Use /fade [in|out] [seconds], e.g. /fade in 0.5." };
    const s = rest[0] === undefined ? DEFAULT_FADE_SECONDS : seconds(rest[0]);
    if (s === null) return { ok: false, error: `“${rest[0]}” isn't a length. Use seconds, e.g. 0.5 or 1s.` };
    const what = side === "both" ? "Fade in and out" : side === "in" ? "Fade in" : "Fade out";
    return {
      ok: true,
      command: {
        label: s === 0 ? `Remove ${what.toLowerCase()}` : what,
        scope: "any",
        build: (clip, fps) => {
          // Clamp so the fades never run past the clip (and two fades share it).
          const limit = side === "both" ? Math.floor(clip.duration / 2) : clip.duration;
          const frames = Math.min(secondsToFrames(s, fps), limit);
          return side === "both" ? { fadeIn: frames, fadeOut: frames } : side === "in" ? { fadeIn: frames } : { fadeOut: frames };
        },
      },
    };
  }

  if (name === "clear" && !args.length) {
    return {
      ok: true,
      command: { label: "Remove effects", scope: "picture", build: () => ({ ...motionPatch("none"), ...Object.fromEntries(PICTURE_EFFECTS.map((e) => [e.key, 0])) }) },
    };
  }

  const near = slashSuggestions(`/${name.slice(0, 2)}`)[0];
  return { ok: false, error: `Unknown command /${name}.${near ? ` Did you mean ${near.usage}?` : ""} Type / to see them all.` };
}

export type SlashPlan = { ok: true; label: string; ops: TimelineOp[]; skipped: number } | { ok: false; error: string };

/**
 * Turn a parsed command into one `clip.update` per selected clip it can apply to. Clips on locked
 * tracks, and non-picture clips for a picture command, are skipped and counted.
 */
export function planSlash(timeline: Timeline, selection: readonly string[], command: SlashCommand): SlashPlan {
  if (!selection.length) return { ok: false, error: "Select a clip on the timeline first." };
  const tracks = new Map(timeline.tracks.map((t) => [t.id, t]));
  const chosen = timeline.clips.filter((c) => selection.includes(c.id));
  const targets = chosen.filter((c) => {
    const t = tracks.get(c.trackId);
    if (!t || t.locked) return false;
    return command.scope === "any" || t.kind === "video" || t.kind === "overlay";
  });
  if (!targets.length) {
    const why = chosen.every((c) => tracks.get(c.trackId)?.locked) ? "the selected clips are on locked tracks" : "this works on video and image clips only";
    return { ok: false, error: `Nothing to change: ${why}.` };
  }
  const fps = timeline.project.settings.fps;
  return {
    ok: true,
    label: command.label,
    ops: targets.map((c) => ({ type: "clip.update", clipId: c.id, props: command.build(c, fps) })),
    skipped: chosen.length - targets.length,
  };
}
