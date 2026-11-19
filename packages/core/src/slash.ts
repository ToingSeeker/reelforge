// Slash commands: typed shortcuts such as "/bw" or "/zoom in" that edit the selected clips
// directly, with no AI model involved. Parsing and targeting live here so the desktop app and the
// phone remote resolve a command to exactly the same timeline operations.

import type { AiFx, Clip, ClipPropsPatch, Timeline, TimelineOp } from "./schema.ts";
import { secondsToFrames } from "./timebase.ts";
import { MOTION_PRESETS, motionPatch, PICTURE_EFFECTS, type MotionPreset, type PictureEffect } from "./effects.ts";
import { FX_CATALOG, fxInfo } from "./fx-catalog.ts";

/**
 * What a step can be applied to: "picture" = clips on video / overlay tracks, "video" = picture
 * clips whose media is a video (AI effects need moving frames), "any" = every clip.
 */
type Scope = "picture" | "video" | "any";

export interface SlashCommandInfo {
  /** What follows the slash when picked, e.g. "zoom" or "fx moody". */
  name: string;
  /** How to type it, e.g. "/zoom in|out". */
  usage: string;
  hint: string;
}

export interface SlashContext {
  fps: Timeline["project"]["settings"]["fps"];
  /** Timeline frame of the playhead; AI effects start here when it is over the clip. */
  playhead: number;
}

/** One part of a command. `build` sees the clip with the earlier parts of a chain already applied. */
export interface SlashStep {
  label: string;
  scope: Scope;
  /** The props to set on the clip, or null to leave this clip alone (with the reason). */
  build: (clip: Clip, ctx: SlashContext) => ClipPropsPatch | { skip: string };
}

export interface SlashCommand {
  /** Undo label, e.g. "Black & white" or "Noir + Zoom in". */
  label: string;
  steps: SlashStep[];
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
/** How long an AI effect added by /fx lasts, like the Effects panel's Add. */
const FX_SECONDS = 3;
/** The schema's cap on AI effects per clip. */
const MAX_AI_EFFECTS = 20;

const NO_LOOKS = Object.fromEntries(PICTURE_EFFECTS.map((e) => [e.key, 0])) as Record<PictureEffect, number>;

export interface SlashLook {
  name: string;
  label: string;
  hint: string;
  /** Picture effects; any not listed are switched off, so looks replace each other cleanly. */
  picture: Partial<Record<PictureEffect, number>>;
  motion?: MotionPreset;
  fadeInSeconds?: number;
}

/** One-word looks: several picture effects (and sometimes a move) in one command. */
export const SLASH_LOOKS: readonly SlashLook[] = [
  { name: "cinematic", label: "Cinematic look", hint: "Vignette, light grain and sharpening, slow push in", picture: { vignette: 0.5, grain: 0.3, sharpen: 0.2 }, motion: "pushIn" },
  { name: "vintage", label: "Vintage look", hint: "Sepia, grain and a soft vignette", picture: { sepia: 0.8, grain: 0.4, vignette: 0.4 } },
  { name: "noir", label: "Noir look", hint: "Black and white, heavy vignette, crisp", picture: { grayscale: 1, vignette: 0.6, sharpen: 0.3 } },
  { name: "dreamy", label: "Dreamy look", hint: `Soft blur and a ${DEFAULT_FADE_SECONDS} s fade in`, picture: { blur: 0.15 }, fadeInSeconds: DEFAULT_FADE_SECONDS },
];

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
  ...SLASH_LOOKS.map((l) => ({ name: l.name, usage: `/${l.name}`, hint: `${l.label} · ${l.hint}` })),
  { name: "fx", usage: "/fx <effect> [text]", hint: `Add an AI effect at the playhead (${FX_SECONDS} s)` },
  { name: "clear", usage: "/clear", hint: "Remove all looks and the camera move" },
];

const FX_COMMANDS: SlashCommandInfo[] = FX_CATALOG.map((f) => ({
  name: `fx ${f.fx}`,
  usage: `/fx ${f.fx}${f.keys.includes("text") ? " [text]" : ""}`,
  hint: `${f.label} · ${f.about}`,
}));

/** The chain splits on ";"; the part being typed is the last one. */
function lastPart(input: string): { before: string; part: string } {
  const i = input.lastIndexOf(";");
  return i < 0 ? { before: "", part: input } : { before: input.slice(0, i + 1), part: input.slice(i + 1) };
}

/**
 * Suggestions for the part being typed: command names while the first word is typed, then effect
 * names after "/fx ". Later parts of a chain may leave out the slash.
 */
export function slashSuggestions(input: string): SlashCommandInfo[] {
  if (!isSlashCommand(input)) return [];
  const { before, part } = lastPart(input);
  const p = part.trimStart();
  if (!before && !p.startsWith("/")) return [];
  const fx = /^\/?fx\s+(\S*)$/i.exec(p);
  if (fx) {
    const q = fx[1]!.toLowerCase();
    const alias = fxInfo(q);
    return FX_COMMANDS.filter((c, i) => c.name.slice(3).startsWith(q) || (alias && FX_CATALOG[i]!.fx === alias.fx));
  }
  const m = /^\/?(\S*)$/.exec(p);
  if (!m) return [];
  const word = m[1]!.toLowerCase();
  return SLASH_COMMANDS.filter((c) => c.name.startsWith(word));
}

/** The input with the part being typed replaced by the picked suggestion (and a space if it takes arguments). */
export function completeSlash(input: string, c: SlashCommandInfo): string {
  const { before } = lastPart(input);
  const takesArgs = c.usage.length > c.name.length + 1;
  return `${before}${before ? " " : ""}/${c.name}${takesArgs ? " " : ""}`;
}

/** The part being typed, without its slash and lowercased: "fx moody" for "/bw; /fx Moody". */
export function slashWord(input: string): string {
  return lastPart(input).part.trim().replace(/^\//, "").replace(/\s+/g, " ").toLowerCase();
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

type StepParse = { ok: true; step: SlashStep } | { ok: false; error: string };

function fadeStep(side: "in" | "out" | "both", s: number, label: string): SlashStep {
  return {
    label,
    scope: "any",
    build: (clip, { fps }) => {
      // Clamp so the fades never run past the clip (and two fades share it).
      const limit = side === "both" ? Math.floor(clip.duration / 2) : clip.duration;
      const frames = Math.min(secondsToFrames(s, fps), limit);
      return side === "both" ? { fadeIn: frames, fadeOut: frames } : side === "in" ? { fadeIn: frames } : { fadeOut: frames };
    },
  };
}

/** One command, e.g. "/zoom in" or "fx backdrop-word Big idea" (the slash is optional here). */
function parseStep(raw: string): StepParse {
  const rawWords = raw.trim().replace(/^\//, "").split(/\s+/).filter(Boolean);
  const words = rawWords.map((w) => w.toLowerCase());
  const [name, ...args] = words;
  if (!name) return { ok: false, error: "Type a command after the slash, e.g. /bw or /zoom in." };

  const effect = PICTURE_ALIASES[name];
  if (effect) {
    const info = PICTURE_EFFECTS.find((e) => e.key === effect)!;
    if (args.length > 1) return { ok: false, error: `/${name} takes one amount, e.g. /${name} 40.` };
    const v = args[0] === undefined ? info.preset : amount(args[0]);
    if (v === null) return { ok: false, error: `“${args[0]}” isn't an amount. Use 0–100, a percentage, or off.` };
    return { ok: true, step: { label: v === 0 ? `Remove ${info.label.toLowerCase()}` : info.label, scope: "picture", build: () => ({ [effect]: v }) } };
  }

  const motion = MOTION_WORDS[words.join(" ")];
  if (motion) {
    const info = MOTION_PRESETS.find((m) => m.key === motion)!;
    return { ok: true, step: { label: motion === "none" ? "Remove motion" : info.label, scope: "picture", build: () => motionPatch(motion) } };
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
    return { ok: true, step: fadeStep(side, s, s === 0 ? `Remove ${what.toLowerCase()}` : what) };
  }

  const look = SLASH_LOOKS.find((l) => l.name === name);
  if (look) {
    if (args.length) return { ok: false, error: `/${name} takes no amount; adjust a part afterwards, e.g. /${name}; /vignette 30.` };
    const fade = look.fadeInSeconds ? fadeStep("in", look.fadeInSeconds, "") : null;
    return {
      ok: true,
      step: {
        label: look.label,
        scope: "picture",
        build: (clip, ctx) => ({
          ...NO_LOOKS,
          ...look.picture,
          ...(look.motion ? motionPatch(look.motion) : {}),
          ...(fade ? (fade.build(clip, ctx) as ClipPropsPatch) : {}),
        }),
      },
    };
  }

  if (name === "fx") {
    if (!args[0]) return { ok: false, error: "Name the effect: /fx <effect>, e.g. /fx spotlight. Type /fx and a space to see them." };
    const info = fxInfo(args[0]);
    if (!info) {
      const near = FX_COMMANDS.find((c) => c.name.slice(3).startsWith(args[0]!.slice(0, 2)));
      return { ok: false, error: `Unknown AI effect “${args[0]}”.${near ? ` Did you mean ${near.usage}?` : ""}` };
    }
    const text = rawWords.slice(2).join(" ");
    if (text && !info.keys.includes("text")) return { ok: false, error: `/fx ${info.fx} takes no text.` };
    if (text.length > 400) return { ok: false, error: "That text is too long for an AI effect (400 characters at most)." };
    return {
      ok: true,
      step: {
        label: `AI effect: ${info.label}`,
        scope: "video",
        build: (clip, { fps, playhead }) => {
          const list = clip.props.aiEffects ?? [];
          if (list.length >= MAX_AI_EFFECTS) return { skip: `already has ${MAX_AI_EFFECTS} AI effects` };
          // Like the Effects panel: at the playhead when it is over the clip, else at its start.
          const clipEnd = clip.start + clip.duration;
          const at = playhead >= clip.start && playhead < clipEnd - 1 ? playhead : clip.start;
          const end = Math.max(at + 1, Math.min(clipEnd, at + Math.round((FX_SECONDS * fps.num) / fps.den)));
          const toSrc = (tl: number) => clip.sourceIn + (tl - clip.start);
          const fx: AiFx = { fx: info.fx, start: toSrc(at), end: toSrc(end), ...(text ? { text } : {}) };
          return { aiEffects: [...list, fx] };
        },
      },
    };
  }

  if (name === "clear" && !args.length) {
    return { ok: true, step: { label: "Remove effects", scope: "picture", build: () => ({ ...motionPatch("none"), ...NO_LOOKS }) } };
  }

  const near = SLASH_COMMANDS.find((c) => c.name.startsWith(name.slice(0, 2)));
  return { ok: false, error: `Unknown command /${name}.${near ? ` Did you mean ${near.usage}?` : ""} Type / to see them all.` };
}

/** Parse a command, or a chain of them separated by ";" (e.g. "/bw; /vignette 60; /zoom in"). */
export function parseSlash(input: string): SlashParse {
  const parts = input.split(";").map((s) => s.trim());
  // A trailing ";" is harmless; an empty part in the middle is a typo.
  if (parts.length > 1 && parts[parts.length - 1] === "") parts.pop();
  const steps: SlashStep[] = [];
  for (const [i, part] of parts.entries()) {
    const r = parseStep(part);
    if (!r.ok) return { ok: false, error: parts.length > 1 ? `Command ${i + 1} (${part || "empty"}): ${r.error}` : r.error };
    steps.push(r.step);
  }
  const labels = steps.map((s) => s.label);
  const label = labels.length <= 3 ? labels.join(" + ") : `${labels.slice(0, 2).join(" + ")} + ${labels.length - 2} more`;
  return { ok: true, command: { label, steps } };
}

export type SlashPlan = { ok: true; label: string; ops: TimelineOp[]; skipped: number } | { ok: false; error: string };

/**
 * Turn a parsed command into one `clip.update` per selected clip it changes (so a chain is still
 * one undo step). Each step only touches the clips its scope fits; clips on locked tracks, and
 * clips no step fits, are skipped and counted.
 */
export function planSlash(timeline: Timeline, selection: readonly string[], command: SlashCommand, opts: { playhead?: number } = {}): SlashPlan {
  if (!selection.length) return { ok: false, error: "Select a clip on the timeline first." };
  const tracks = new Map(timeline.tracks.map((t) => [t.id, t]));
  const assets = new Map((timeline.assets ?? []).map((a) => [a.id, a]));
  const chosen = timeline.clips.filter((c) => selection.includes(c.id));
  const ctx: SlashContext = { fps: timeline.project.settings.fps, playhead: opts.playhead ?? 0 };
  const fits = (scope: Scope, c: Clip) => {
    const kind = tracks.get(c.trackId)?.kind;
    const picture = kind === "video" || kind === "overlay";
    if (scope === "any") return true;
    if (scope === "picture") return picture;
    return picture && assets.get(c.assetId)?.kind === "video";
  };

  const ops: TimelineOp[] = [];
  const reasons = new Set<string>();
  for (const clip of chosen) {
    if (tracks.get(clip.trackId)?.locked) {
      reasons.add("the selected clips are on locked tracks");
      continue;
    }
    let current = clip;
    let patch: ClipPropsPatch = {};
    for (const step of command.steps) {
      if (!fits(step.scope, current)) {
        reasons.add(step.scope === "video" ? "AI effects work on video clips only" : "this works on video and image clips only");
        continue;
      }
      const p = step.build(current, ctx);
      if ("skip" in p) {
        reasons.add(`a clip ${p.skip}`);
        continue;
      }
      patch = { ...patch, ...p };
      current = { ...current, props: { ...current.props, ...p } };
    }
    if (Object.keys(patch).length) ops.push({ type: "clip.update", clipId: clip.id, props: patch });
  }
  if (!ops.length) return { ok: false, error: `Nothing to change: ${[...reasons].join("; ") || "no clip fits"}.` };
  return { ok: true, label: command.label, ops, skipped: chosen.length - ops.length };
}
