// Caption layout: where every word goes on the frame. Pure and shared, so the
// export rasteriser and the live canvas place words identically; only the
// final pixel rasterisation differs.

import type { Caption, CaptionStyle } from "./schema.ts";

/** The slice of an opentype.js Font this needs. */
export interface GlyphFont {
  unitsPerEm: number;
  ascender: number;
  descender: number;
  getAdvanceWidth(text: string, fontSize: number, options?: { kerning?: boolean }): number;
}

export interface LaidOutWord {
  index: number;
  text: string;
  /** Left edge and baseline, output pixels. */
  x: number;
  baseline: number;
  width: number;
}

export interface CaptionLayout {
  fontSize: number;
  lineHeight: number;
  words: LaidOutWord[];
  /** One box per line (for the background box style), output pixels. */
  lines: { x: number; y: number; width: number; height: number }[];
  /** Everything that may get ink (box, stroke and shadow included). */
  bounds: { x: number; y: number; width: number; height: number };
}

export function captionTokens(c: Pick<Caption, "text" | "words">): string[] {
  return c.words.length ? c.words.map((w) => w.text) : c.text.split(/\s+/).filter(Boolean);
}

export function layoutCaption(c: Pick<Caption, "text" | "words">, style: CaptionStyle, W: number, H: number, font: GlyphFont): CaptionLayout {
  const fontSize = style.size * H;
  const lineHeight = fontSize * 1.18;
  const maxW = style.maxWidth * W;
  const tokens = captionTokens(c).map((t) => (style.uppercase ? t.toUpperCase() : t));
  const space = font.getAdvanceWidth(" ", fontSize, { kerning: true });
  const widths = tokens.map((t) => font.getAdvanceWidth(t, fontSize, { kerning: true }));

  // Greedy wrap.
  const lines: number[][] = [];
  let line: number[] = [];
  let lineW = 0;
  tokens.forEach((_, i) => {
    const w = widths[i]!;
    const next = line.length ? lineW + space + w : w;
    if (line.length && next > maxW) {
      lines.push(line);
      line = [i];
      lineW = w;
    } else {
      line.push(i);
      lineW = next;
    }
  });
  if (line.length) lines.push(line);

  const ascent = (font.ascender / font.unitsPerEm) * fontSize;
  const descent = (-font.descender / font.unitsPerEm) * fontSize;
  const blockH = lines.length * lineHeight;
  const top = style.y * H - blockH / 2;
  const words: LaidOutWord[] = [];
  const boxes: CaptionLayout["lines"] = [];
  lines.forEach((ids, li) => {
    const width = ids.reduce((s, i, k) => s + widths[i]! + (k ? space : 0), 0);
    const y = top + li * lineHeight;
    const baseline = y + (lineHeight - (ascent + descent)) / 2 + ascent;
    let x = (W - width) / 2;
    for (const i of ids) {
      words.push({ index: i, text: tokens[i]!, x, baseline, width: widths[i]! });
      x += widths[i]! + space;
    }
    const padX = fontSize * 0.25;
    boxes.push({ x: (W - width) / 2 - padX, y, width: width + 2 * padX, height: lineHeight });
  });

  const ink = fontSize * (style.stroke + 0.12) + (style.shadow ? fontSize * 0.06 : 0);
  const minX = Math.min(...boxes.map((b) => b.x)) - ink;
  const maxX = Math.max(...boxes.map((b) => b.x + b.width)) + ink;
  return {
    fontSize,
    lineHeight,
    words,
    lines: boxes,
    bounds: { x: Math.max(0, minX), y: Math.max(0, top - ink), width: Math.min(W, maxX) - Math.max(0, minX), height: blockH + 2 * ink },
  };
}

/** Index of the word being spoken `rel` frames into the caption (-1 before the first word). */
export function activeWordAt(c: Pick<Caption, "words">, rel: number): number {
  let active = -1;
  c.words.forEach((w, i) => {
    if (w.start <= rel) active = i;
  });
  return active;
}

/**
 * Frames where a caption's picture changes (it appears, a new word lights up,
 * it disappears). Both renderers draw one image per interval.
 */
export function captionStates(c: Pick<Caption, "start" | "duration" | "words">, highlight: boolean): { from: number; to: number; active: number }[] {
  const cuts = new Set<number>([0]);
  if (highlight) for (const w of c.words) if (w.start > 0 && w.start < c.duration) cuts.add(w.start);
  const sorted = [...cuts].sort((a, b) => a - b);
  return sorted.map((from, i) => ({
    from: c.start + from,
    to: c.start + (sorted[i + 1] ?? c.duration),
    active: highlight ? activeWordAt(c, from) : -1,
  }));
}
