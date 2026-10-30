// Burned-in captions without libass: words are laid out with the shared
// layout (core/caption-layout.ts), rasterised here from the bundled fonts, and
// fed to FFmpeg as a frame-exact PNG sequence (hard links, one per frame).

import { linkSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import opentype, { type Font, type PathCommand } from "opentype.js";
import { CAPTION_FONTS, captionStates, layoutCaption, type Caption, type CaptionFont, type CaptionStyle, type RenderPlan } from "@reelforge/core";

export const fontsDir = () => process.env.REELFORGE_FONTS ?? fileURLToPath(new URL("../../../assets/fonts/", import.meta.url));

const fonts = new Map<CaptionFont, Font>();
export function loadFont(name: CaptionFont): Font {
  let f = fonts.get(name);
  if (!f) {
    const buf = readFileSync(join(fontsDir(), CAPTION_FONTS[name]));
    f = opentype.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer);
    fonts.set(name, f);
  }
  return f;
}

// ---- rasteriser -------------------------------------------------------------

type Pt = [number, number];

function flatten(cmds: PathCommand[], dx: number, dy: number): Pt[][] {
  const polys: Pt[][] = [];
  let cur: Pt[] = [];
  let x = 0;
  let y = 0;
  const steps = (len: number) => Math.max(2, Math.min(24, Math.ceil(len / 3)));
  for (const c of cmds) {
    if (c.type === "M") {
      if (cur.length) polys.push(cur);
      cur = [[c.x + dx, c.y + dy]];
      [x, y] = [c.x, c.y];
    } else if (c.type === "L") {
      cur.push([c.x + dx, c.y + dy]);
      [x, y] = [c.x, c.y];
    } else if (c.type === "Q") {
      const n = steps(Math.hypot(c.x1 - x, c.y1 - y) + Math.hypot(c.x - c.x1, c.y - c.y1));
      for (let i = 1; i <= n; i++) {
        const t = i / n;
        const u = 1 - t;
        cur.push([u * u * x + 2 * u * t * c.x1 + t * t * c.x + dx, u * u * y + 2 * u * t * c.y1 + t * t * c.y + dy]);
      }
      [x, y] = [c.x, c.y];
    } else if (c.type === "C") {
      const n = steps(Math.hypot(c.x1 - x, c.y1 - y) + Math.hypot(c.x2 - c.x1, c.y2 - c.y1) + Math.hypot(c.x - c.x2, c.y - c.y2));
      for (let i = 1; i <= n; i++) {
        const t = i / n;
        const u = 1 - t;
        cur.push([
          u * u * u * x + 3 * u * u * t * c.x1 + 3 * u * t * t * c.x2 + t * t * t * c.x + dx,
          u * u * u * y + 3 * u * u * t * c.y1 + 3 * u * t * t * c.y2 + t * t * t * c.y + dy,
        ]);
      }
      [x, y] = [c.x, c.y];
    } else if (c.type === "Z") {
      if (cur.length) polys.push(cur);
      cur = [];
    }
  }
  if (cur.length) polys.push(cur);
  return polys;
}

/** Anti-aliased coverage (0..1) of closed polygons, by signed-area accumulation (font-rs). */
export function rasterize(polys: Pt[][], w: number, h: number): Float32Array {
  const stride = w + 2;
  const acc = new Float32Array(stride * h);
  const line = (ax: number, ay: number, bx: number, by: number) => {
    if (ay === by) return;
    let dir = 1;
    let x0 = ax, y0 = ay, x1 = bx, y1 = by;
    if (ay > by) {
      dir = -1;
      [x0, y0, x1, y1] = [bx, by, ax, ay];
    }
    x0 = Math.min(Math.max(x0, 0), w);
    x1 = Math.min(Math.max(x1, 0), w);
    const dxdy = (x1 - x0) / (y1 - y0);
    let x = x0;
    if (y0 < 0) x -= y0 * dxdy;
    for (let yi = Math.max(0, Math.floor(y0)); yi < Math.min(h, Math.ceil(y1)); yi++) {
      const row = yi * stride;
      const dy = Math.min(yi + 1, y1) - Math.max(yi, y0);
      const xnext = x + dxdy * dy;
      const d = dy * dir;
      const xa = Math.min(x, xnext);
      const xb = Math.max(x, xnext);
      const x0f = Math.floor(xa);
      const x0i = x0f | 0;
      const x1i = Math.ceil(xb) | 0;
      if (x1i <= x0i + 1) {
        const xm = 0.5 * (x + xnext) - x0f;
        acc[row + x0i] = acc[row + x0i]! + d - d * xm;
        acc[row + x0i + 1] = acc[row + x0i + 1]! + d * xm;
      } else {
        const s = 1 / (xb - xa);
        const xf0 = xa - x0f;
        const a0 = 0.5 * s * (1 - xf0) * (1 - xf0);
        const xf1 = xb - x1i + 1;
        const am = 0.5 * s * xf1 * xf1;
        acc[row + x0i] = acc[row + x0i]! + d * a0;
        if (x1i === x0i + 2) {
          acc[row + x0i + 1] = acc[row + x0i + 1]! + d * (1 - a0 - am);
        } else {
          const a1 = s * (1.5 - xf0);
          acc[row + x0i + 1] = acc[row + x0i + 1]! + d * (a1 - a0);
          for (let xi = x0i + 2; xi < x1i - 1; xi++) acc[row + xi] = acc[row + xi]! + d * s;
          const a2 = a1 + (x1i - x0i - 3) * s;
          acc[row + x1i - 1] = acc[row + x1i - 1]! + d * (1 - a2 - am);
        }
        acc[row + x1i] = acc[row + x1i]! + d * am;
      }
      x = xnext;
    }
  };
  for (const poly of polys) {
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i]!;
      const b = poly[(i + 1) % poly.length]!;
      line(a[0], a[1], b[0], b[1]);
    }
  }
  const out = new Float32Array(w * h);
  for (let yi = 0; yi < h; yi++) {
    let sum = 0;
    for (let xi = 0; xi < w; xi++) {
      sum += acc[yi * stride + xi]!;
      out[yi * w + xi] = Math.min(1, Math.abs(sum));
    }
  }
  return out;
}

const maxInto = (dst: Float32Array, src: Float32Array) => {
  for (let i = 0; i < dst.length; i++) if (src[i]! > dst[i]!) dst[i] = src[i]!;
};

function boxBlur(m: Float32Array, w: number, h: number, r: number): Float32Array {
  if (r < 1) return m;
  const tmp = new Float32Array(m.length);
  const out = new Float32Array(m.length);
  const n = 2 * r + 1;
  for (let y = 0; y < h; y++) {
    let s = 0;
    for (let x = -r; x <= r; x++) s += m[y * w + Math.min(w - 1, Math.max(0, x))]!;
    for (let x = 0; x < w; x++) {
      tmp[y * w + x] = s / n;
      s += m[y * w + Math.min(w - 1, x + r + 1)]! - m[y * w + Math.max(0, x - r)]!;
    }
  }
  for (let x = 0; x < w; x++) {
    let s = 0;
    for (let y = -r; y <= r; y++) s += tmp[Math.min(h - 1, Math.max(0, y)) * w + x]!;
    for (let y = 0; y < h; y++) {
      out[y * w + x] = s / n;
      s += tmp[Math.min(h - 1, y + r + 1) * w + x]! - tmp[Math.max(0, y - r) * w + x]!;
    }
  }
  return out;
}

function roundedRect(x: number, y: number, w: number, h: number, r: number): Pt[] {
  const pts: Pt[] = [];
  const arc = (cx: number, cy: number, a0: number) => {
    for (let i = 0; i <= 6; i++) {
      const a = a0 + (i / 6) * (Math.PI / 2);
      pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
    }
  };
  arc(x + w - r, y + r, -Math.PI / 2);
  arc(x + w - r, y + h - r, 0);
  arc(x + r, y + h - r, Math.PI / 2);
  arc(x + r, y + r, Math.PI);
  return pts;
}

export function parseColor(hex: string): [number, number, number, number] {
  const n = hex.slice(1);
  return [parseInt(n.slice(0, 2), 16), parseInt(n.slice(2, 4), 16), parseInt(n.slice(4, 6), 16), n.length === 8 ? parseInt(n.slice(6, 8), 16) / 255 : 1];
}

/** Straight-alpha "over" of a coverage mask in one colour. */
function paint(img: Uint8Array, imgW: number, mask: Float32Array, mw: number, mh: number, ox: number, oy: number, color: [number, number, number, number], alpha = 1) {
  for (let y = 0; y < mh; y++) {
    const iy = y + oy;
    if (iy < 0) continue;
    for (let x = 0; x < mw; x++) {
      const a = mask[y * mw + x]! * color[3] * alpha;
      if (a <= 0) continue;
      const ix = x + ox;
      if (ix < 0 || ix >= imgW) continue;
      const i = (iy * imgW + ix) * 4;
      if (i + 3 >= img.length) continue;
      const da = img[i + 3]! / 255;
      const oa = a + da * (1 - a);
      for (let k = 0; k < 3; k++) img[i + k] = Math.round((color[k]! * a + img[i + k]! * da * (1 - a)) / oa);
      img[i + 3] = Math.round(oa * 255);
    }
  }
}

// ---- PNG ----------------------------------------------------------------------

const CRC = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
function crc32(buf: Uint8Array): number {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type: string, data: Uint8Array): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
export function encodePng(w: number, h: number, rgba: Uint8Array): Buffer {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 1 })), chunk("IEND", new Uint8Array())]);
}

// ---- captions → images ----------------------------------------------------------

export interface CaptionRaster {
  /** One RGBA image per state, band-sized, plus where each state is shown. */
  states: { from: number; to: number; rgba: Uint8Array }[];
}

/** Render every visual state of one caption into a W×bandH image (band starts at bandY). */
export function rasterizeCaption(c: Caption, style: CaptionStyle, W: number, H: number, bandY: number, bandH: number): CaptionRaster {
  const font = loadFont(style.font);
  const L = layoutCaption(c, style, W, H, font);
  const bx = Math.floor(L.bounds.x);
  const by = Math.floor(L.bounds.y);
  const bw = Math.ceil(L.bounds.x + L.bounds.width) - bx;
  const bh = Math.ceil(L.bounds.y + L.bounds.height) - by;
  const paths = L.words.map((w) => font.getPath(w.text, w.x - bx, w.baseline - by, L.fontSize, { kerning: true }).commands);
  const wordMasks = paths.map((cmds) => rasterize(flatten(cmds, 0, 0), bw, bh));
  const fill = new Float32Array(bw * bh);
  for (const m of wordMasks) maxInto(fill, m);

  let stroke: Float32Array | null = null;
  const r = style.stroke * L.fontSize;
  if (r > 0.3) {
    // Outline = the glyphs dilated by r (union of shifted copies around a circle).
    stroke = new Float32Array(bw * bh);
    const k = Math.max(8, Math.min(24, Math.round(r * 2)));
    for (let i = 0; i < k; i++) {
      const a = (2 * Math.PI * i) / k;
      const polys = paths.flatMap((cmds) => flatten(cmds, r * Math.cos(a), r * Math.sin(a)));
      maxInto(stroke, rasterize(polys, bw, bh));
    }
    maxInto(stroke, fill);
  }

  let shadow: Float32Array | null = null;
  const sOff = Math.round(L.fontSize * 0.05);
  if (style.shadow) shadow = boxBlur(stroke ?? fill, bw, bh, Math.max(1, Math.round(L.fontSize * 0.04)));

  const box = style.box ? rasterize(L.lines.map((ln) => roundedRect(ln.x - bx, ln.y - by, ln.width, ln.height, L.fontSize * 0.18)), bw, bh) : null;

  const color = parseColor(style.color);
  const hl = style.highlight ? parseColor(style.highlight) : null;
  const states = captionStates(c, !!hl).map((st) => {
    const img = new Uint8Array(W * bandH * 4);
    const oy = by - bandY;
    if (box) paint(img, W, box, bw, bh, bx, oy, parseColor(style.box!));
    if (shadow) paint(img, W, shadow, bw, bh, bx + sOff, oy + sOff, [0, 0, 0, 1], 0.55);
    if (stroke) paint(img, W, stroke, bw, bh, bx, oy, parseColor(style.strokeColor));
    L.words.forEach((w, i) => paint(img, W, wordMasks[i]!, bw, bh, bx, oy, hl && w.index === st.active ? hl : color));
    return { from: st.from, to: st.to, rgba: img };
  });
  return { states };
}

export interface CaptionOverlay {
  /** image2 pattern of one PNG per frame. */
  pattern: string;
  startFrame: number;
  frames: number;
  y: number;
  width: number;
  height: number;
}

/**
 * One frame-exact PNG sequence per caption track. Each distinct picture is
 * encoded once; frames are hard links to it, so a long reel stays cheap.
 */
export function prepareCaptionOverlays(plan: RenderPlan, W: number, H: number, dir: string): CaptionOverlay[] {
  const out: CaptionOverlay[] = [];
  plan.captions.forEach((track, ti) => {
    const font = loadFont(track.style.font);
    const layouts = track.captions.map((c) => layoutCaption(c, track.style, W, H, font).bounds);
    const y0 = Math.max(0, Math.floor(Math.min(...layouts.map((b) => b.y))));
    const y1 = Math.min(H, Math.ceil(Math.max(...layouts.map((b) => b.y + b.height))));
    const bandH = Math.max(2, (y1 - y0) + ((y1 - y0) % 2));
    const tdir = join(dir, `captions-${ti}`);
    mkdirSync(tdir, { recursive: true });
    const blank = join(tdir, "blank.png");
    writeFileSync(blank, encodePng(W, bandH, new Uint8Array(W * bandH * 4)));
    const first = track.captions[0]!.start;
    const last = Math.max(...track.captions.map((c) => c.start + c.duration));
    const byFrame = new Array<string>(last - first).fill(blank);
    track.captions.forEach((c, ci) => {
      rasterizeCaption(c, track.style, W, H, y0, bandH).states.forEach((st, si) => {
        const file = join(tdir, `c${ci}-${si}.png`);
        writeFileSync(file, encodePng(W, bandH, st.rgba));
        for (let f = st.from; f < st.to; f++) byFrame[f - first] = file;
      });
    });
    byFrame.forEach((file, i) => linkSync(file, join(tdir, `f_${String(i).padStart(7, "0")}.png`)));
    out.push({ pattern: join(tdir, "f_%07d.png"), startFrame: first, frames: last - first, y: y0, width: W, height: bandH });
  });
  return out;
}
