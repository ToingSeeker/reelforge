// The phone editor's view of the timeline, and the few pure functions it needs to show an edit before the
// Mac confirms it. These mirror packages/core (timeline-ops.ts, render-plan.ts, caption-layout.ts,
// schema.ts presets); apps/remote/test/edit-model.test.ts runs both side by side so they can't drift.
// The Mac stays the authority: every edit is re-validated there and its answer replaces this guess.

/** Per-clip look and sound defaults (core schema.ts DEFAULT_CLIP_PROPS, without aiEffects). */
export const DEFAULT_CLIP_PROPS = Object.freeze({
  fit: 'cover', scale: 1, scaleEnd: null, x: 0, y: 0, xEnd: null, yEnd: null, rotation: 0, opacity: 1,
  cropLeft: 0, cropTop: 0, cropRight: 0, cropBottom: 0, fadeIn: 0, fadeOut: 0, transitionIn: 0, gainDb: 0,
  blur: 0, sharpen: 0, vignette: 0, grayscale: 0, sepia: 0, grain: 0,
});

/** core schema.ts CAPTION_PRESETS. */
export const CAPTION_PRESETS = Object.freeze({
  bold: { font: 'Anton', size: 0.058, color: '#ffffff', highlight: '#00d5ed', strokeColor: '#000000', stroke: 0.12, shadow: true, box: null, y: 0.7, maxWidth: 0.82, uppercase: true },
  clean: { font: 'Poppins SemiBold', size: 0.038, color: '#ffffff', highlight: '#ffd84a', strokeColor: '#000000', stroke: 0.06, shadow: true, box: null, y: 0.74, maxWidth: 0.8, uppercase: false },
  boxed: { font: 'Poppins Bold', size: 0.036, color: '#ffffff', highlight: '#00d5ed', strokeColor: '#000000', stroke: 0, shadow: false, box: '#000000b3', y: 0.74, maxWidth: 0.78, uppercase: false },
});
export const CAPTION_FONTS = Object.freeze({ Anton: 'Anton-Regular.ttf', 'Poppins Bold': 'Poppins-Bold.ttf', 'Poppins SemiBold': 'Poppins-SemiBold.ttf' });
export const resolveCaptionStyle = (patch) => ({ ...CAPTION_PRESETS.bold, ...(patch ?? {}) });

/** Engine limits (schema.ts): what the controls clamp to. */
export const LIMITS = Object.freeze({ scale: [0.05, 10], pos: [-2, 2], gainDb: [-60, 12], captionY: [0.05, 0.95], captionSize: [0.015, 0.2], captionText: 300 });

// ── time ────────────────────────────────────────────────────────────────────
/** Frames are integers in the project's timebase; seconds only ever for display. */
export const fpsValue = (fps) => fps.num / fps.den;
export const framesToSeconds = (f, fps) => (f * fps.den) / fps.num;
/** Nearest frame to a time; never float-accumulated (core timebase.ts rounds the same way). */
export const secondsToFrames = (s, fps) => Math.round((s * fps.num) / fps.den);

/** 00:03.20 (minutes:seconds.hundredths) from an exact frame; hours appear past 59:59. */
export function timecode(frames, fps) {
  const total = Math.max(0, framesToSeconds(frames, fps));
  let cs = Math.floor(total * 100 + 1e-6);
  const h = Math.floor(cs / 360000);
  cs -= h * 360000;
  const m = Math.floor(cs / 6000);
  cs -= m * 6000;
  const s = Math.floor(cs / 100);
  cs -= s * 100;
  const mmss = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
  return h ? `${h}:${mmss}` : mmss;
}

/** Parses "1:02.5", "62.5", "00:03.20" into the nearest frame; null if it isn't a time. */
export function parseTimecode(text, fps) {
  const t = String(text ?? '').trim();
  const m = /^(?:(\d+):)?(?:(\d+):)?(\d+(?:[.,]\d+)?)$/.exec(t);
  if (!m) return null;
  const parts = [m[1], m[2], m[3]].filter((x) => x !== undefined);
  const sec = Number(parts.pop().replace(',', '.'));
  const min = parts.length ? Number(parts.pop()) : 0;
  const hr = parts.length ? Number(parts.pop()) : 0;
  const total = hr * 3600 + min * 60 + sec;
  return Number.isFinite(total) ? secondsToFrames(total, fps) : null;
}

// ── reading the model ───────────────────────────────────────────────────────
export const trackOf = (model, id) => model.tracks.find((t) => t.id === id) ?? null;
export const clipById = (model, id) => model.clips.find((c) => c.id === id) ?? null;
export const captionById = (model, id) => model.captions.find((c) => c.id === id) ?? null;
export const assetOf = (model, id) => model.assets.find((a) => a.id === id) ?? null;
export const clipEnd = (c) => c.start + c.duration;
export const byStart = (a, b) => a.start - b.start || (a.id < b.id ? -1 : 1);

/** Picture tracks bottom-first (the base video under overlays), like the render plan. */
export function pictureTracks(model) {
  return [...model.tracks].filter((t) => t.kind === 'video' || t.kind === 'overlay').sort((a, b) => b.position - a.position);
}
export const captionTracks = (model) => [...model.tracks].filter((t) => t.kind === 'caption').sort((a, b) => b.position - a.position);
export const audioTracks = (model) => [...model.tracks].filter((t) => t.kind === 'audio').sort((a, b) => a.position - b.position);
export const clipsOn = (model, trackId) => model.clips.filter((c) => c.trackId === trackId).sort(byStart);
export const captionsOn = (model, trackId) => model.captions.filter((c) => c.trackId === trackId).sort(byStart);

/** The main picture track: the lowest visible one that has clips (V1 in a normal reel). */
export function mainTrack(model) {
  const tracks = pictureTracks(model);
  return tracks.find((t) => !t.hidden && model.clips.some((c) => c.trackId === t.id)) ?? tracks[0] ?? null;
}

export function durationFrames(model) {
  return Math.max(0, ...model.clips.map(clipEnd), ...model.captions.map((c) => c.start + c.duration));
}

// ── edits (core timeline-ops.ts semantics) ─────────────────────────────────
export class EditRejected extends Error {}
const fail = (message) => {
  throw new EditRejected(message);
};

function fitProps(p, duration) {
  const out = { ...p };
  if (out.fadeIn !== undefined) out.fadeIn = Math.min(out.fadeIn, duration);
  if (out.fadeOut !== undefined) out.fadeOut = Math.min(out.fadeOut, duration - (out.fadeIn ?? 0));
  if (out.transitionIn !== undefined) out.transitionIn = Math.min(out.transitionIn, duration);
  return out;
}

function evenWords(text, duration) {
  const parts = text.split(/\s+/).filter(Boolean);
  return parts.map((w, i) => ({ text: w, start: Math.floor((i * duration) / parts.length), end: Math.floor(((i + 1) * duration) / parts.length) }));
}

function checkClip(m, c) {
  const track = trackOf(m, c.trackId) ?? fail('track not found');
  const asset = assetOf(m, c.assetId) ?? fail('media not found');
  if (!Number.isInteger(c.start) || c.start < 0) fail('The clip would start before 00:00.');
  if (!Number.isInteger(c.duration) || c.duration < 1) fail('A clip must be at least one frame long.');
  if (c.sourceIn < 0) fail('That trims past the start of the source media.');
  if (asset.durationFrames !== null && c.sourceIn + c.duration > asset.durationFrames) fail('That trims past the end of the source media.');
  for (const o of m.clips) if (o.id !== c.id && o.trackId === c.trackId && o.start < clipEnd(c) && c.start < clipEnd(o)) fail(`It would overlap another clip on ${track.label}.`);
}

function unlocked(m, trackId) {
  const t = trackOf(m, trackId) ?? fail('track not found');
  if (t.locked) fail(`${t.label} is locked on the Mac.`);
  return t;
}

/**
 * Applies operations to a copy of the model the way the engine will; throws EditRejected with a readable
 * reason where the engine would refuse. Ids for new clips come from the operation (newClipId), so the
 * guess and the engine's answer name the same clips.
 */
export function applyOps(model, ops) {
  const m = { ...model, clips: model.clips.map((c) => ({ ...c, props: { ...c.props } })), captions: model.captions.map((c) => ({ ...c })), tracks: model.tracks.map((t) => ({ ...t })) };
  const put = (c) => {
    const fixed = { ...c, props: fitProps(c.props, c.duration) };
    const i = m.clips.findIndex((x) => x.id === c.id);
    if (i >= 0) m.clips[i] = fixed;
    else m.clips.push(fixed);
    checkClip(m, fixed);
  };
  const clip = (id) => clipById(m, id) ?? fail('That clip is gone (changed on the Mac?).');
  for (const op of ops) {
    switch (op.type) {
      case 'clip.update': {
        const c = clip(op.clipId);
        unlocked(m, c.trackId);
        put({ ...c, props: { ...c.props, ...op.props } });
        break;
      }
      case 'clip.move': {
        const c = clip(op.clipId);
        unlocked(m, c.trackId);
        put({ ...c, start: op.start, trackId: op.trackId ?? c.trackId });
        break;
      }
      case 'clip.trim': {
        const c = clip(op.clipId);
        unlocked(m, c.trackId);
        if (op.edge === 'start') {
          if (op.frame >= clipEnd(c)) fail('The start must stay before the end.');
          const d = op.frame - c.start;
          put({ ...c, start: op.frame, sourceIn: c.sourceIn + d, duration: c.duration - d });
        } else {
          if (op.frame <= c.start) fail('The end must stay after the start.');
          put({ ...c, duration: op.frame - c.start });
        }
        break;
      }
      case 'clip.split': {
        const c = clip(op.clipId);
        unlocked(m, c.trackId);
        if (op.frame <= c.start || op.frame >= clipEnd(c)) fail('Move the playhead inside the clip to split it.');
        const left = op.frame - c.start;
        const { fadeOut, ...leftProps } = c.props;
        const { fadeIn: _fi, transitionIn: _ti, ...rightProps } = c.props;
        put({ ...c, duration: left, props: { ...leftProps, fadeOut: 0 } });
        put({ ...c, id: op.newClipId, start: op.frame, sourceIn: c.sourceIn + left, duration: c.duration - left, props: { ...rightProps, fadeIn: 0, transitionIn: 0, fadeOut: fadeOut ?? 0 } });
        break;
      }
      case 'clip.delete': {
        const targets = [...new Set(op.clipIds)].map(clip);
        for (const c of targets) unlocked(m, c.trackId);
        m.clips = m.clips.filter((c) => !targets.includes(c) && !targets.some((t) => t.id === c.id));
        if (op.ripple) {
          for (const gone of [...targets].sort((a, b) => b.start - a.start)) {
            m.clips = m.clips.map((c) => (c.trackId === gone.trackId && c.start >= clipEnd(gone) ? { ...c, start: c.start - gone.duration } : c));
          }
        }
        break;
      }
      case 'track.update': {
        const i = m.tracks.findIndex((t) => t.id === op.trackId);
        if (i < 0) fail('track not found');
        const t = { ...m.tracks[i] };
        if (op.muted !== undefined) t.muted = op.muted;
        if (op.hidden !== undefined) t.hidden = op.hidden;
        if (op.captionStyle) {
          t.stylePatch = { ...(t.stylePatch ?? {}), ...op.captionStyle };
          t.captionStyle = resolveCaptionStyle(t.stylePatch);
        }
        m.tracks[i] = t;
        break;
      }
      case 'caption.update': {
        const i = m.captions.findIndex((c) => c.id === op.captionId);
        if (i < 0) fail('That caption is gone (changed on the Mac?).');
        const c = m.captions[i];
        unlocked(m, c.trackId);
        const text = op.text ?? c.text;
        const duration = op.duration ?? c.duration;
        const start = op.start ?? c.start;
        if (!text.trim()) fail('A caption needs some text.');
        if (duration < 1) fail('A caption must be at least one frame long.');
        for (const o of m.captions) if (o.id !== c.id && o.trackId === c.trackId && o.start < start + duration && start < o.start + o.duration) fail('It would overlap the next or previous caption.');
        const words = op.text !== undefined && op.text !== c.text ? evenWords(text, duration) : c.words.map((w) => ({ ...w, start: Math.min(w.start, duration), end: Math.min(w.end, duration) }));
        m.captions[i] = { ...c, text, start, duration, words };
        break;
      }
      default:
        fail(`The phone can't preview ${op.type}.`);
    }
  }
  m.durationFrames = durationFrames(m);
  return m;
}

/** Repacks a track's clips in a new order, back to back from the first one's start (one undo step). */
export function reorderOps(model, trackId, orderedIds) {
  const clips = clipsOn(model, trackId);
  const at0 = clips[0]?.start ?? 0;
  const far = Math.max(...clips.map(clipEnd)) + 1;
  const ops = [];
  // Out of the way first, so no intermediate state overlaps; then into place.
  let cursor = far;
  for (const id of orderedIds) {
    const c = clipById(model, id);
    ops.push({ type: 'clip.move', clipId: id, start: cursor });
    cursor += c.duration;
  }
  cursor = at0;
  for (const id of orderedIds) {
    ops.push({ type: 'clip.move', clipId: id, start: cursor });
    cursor += clipById(model, id).duration;
  }
  return ops;
}

/** A track's clips are back to back (reorder keeps them so; with gaps it would change timing). */
export function contiguous(model, trackId) {
  const clips = clipsOn(model, trackId);
  return clips.every((c, i) => i === 0 || clips[i - 1].start + clips[i - 1].duration === c.start);
}

// ── picture placement (core render-plan.ts) ─────────────────────────────────
const clamp01 = (x) => Math.min(1, Math.max(0, x));
export function scaleAt(seg, frame) {
  const p = seg.props;
  if (p.scaleEnd === null || p.scaleEnd === undefined || p.scaleEnd === p.scale) return p.scale;
  const t = seg.duration <= 1 ? 0 : clamp01((frame - seg.start) / (seg.duration - 1));
  return p.scale + (p.scaleEnd - p.scale) * t;
}
export function positionAt(seg, frame) {
  const p = seg.props;
  const t = seg.duration <= 1 ? 0 : clamp01((frame - seg.start) / (seg.duration - 1));
  return { x: p.xEnd === null || p.xEnd === undefined ? p.x : p.x + (p.xEnd - p.x) * t, y: p.yEnd === null || p.yEnd === undefined ? p.y : p.y + (p.yEnd - p.y) * t };
}
export function pictureAlpha(seg, frame) {
  if (frame < seg.start || frame >= seg.start + seg.duration) return 0;
  const p = seg.props;
  let a = p.opacity;
  if (p.fadeIn > 0) a *= clamp01((frame - seg.start) / p.fadeIn);
  if (p.fadeOut > 0) a *= clamp01(1 - (frame - (seg.start + seg.duration - p.fadeOut)) / p.fadeOut);
  return a;
}
export function placement(seg, frame, srcW, srcH, W, H) {
  const p = seg.props;
  let sx = srcW * p.cropLeft;
  let sy = srcH * p.cropTop;
  let sw = srcW * (1 - p.cropLeft - p.cropRight);
  let sh = srcH * (1 - p.cropTop - p.cropBottom);
  let dw;
  let dh;
  if (p.fit === 'cover') {
    const k = Math.max(W / sw, H / sh);
    const vw = W / k;
    const vh = H / k;
    sx += (sw - vw) / 2;
    sy += (sh - vh) / 2;
    sw = vw;
    sh = vh;
    dw = W;
    dh = H;
  } else {
    const k = Math.min(W / sw, H / sh);
    dw = sw * k;
    dh = sh * k;
  }
  const s = scaleAt(seg, frame);
  const pos = positionAt(seg, frame);
  return { sx, sy, sw, sh, fw: dw, fh: dh, dw: dw * s, dh: dh * s, cx: W / 2 + pos.x * W, cy: H / 2 + pos.y * H, rotation: (p.rotation * Math.PI) / 180 };
}

// ── captions (core caption-layout.ts) ───────────────────────────────────────
export function captionTokens(c) {
  return c.words?.length ? c.words.map((w) => w.text) : c.text.split(/\s+/).filter(Boolean);
}
/** font: { unitsPerEm, ascender, descender, getAdvanceWidth(text, size) }. */
export function layoutCaption(c, style, W, H, font) {
  const fontSize = style.size * H;
  const lineHeight = fontSize * 1.18;
  const maxW = style.maxWidth * W;
  const tokens = captionTokens(c).map((t) => (style.uppercase ? t.toUpperCase() : t));
  const space = font.getAdvanceWidth(' ', fontSize);
  const widths = tokens.map((t) => font.getAdvanceWidth(t, fontSize));
  const lines = [];
  let line = [];
  let lineW = 0;
  tokens.forEach((_, i) => {
    const w = widths[i];
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
  const words = [];
  const boxes = [];
  lines.forEach((ids, li) => {
    const width = ids.reduce((s, i, k) => s + widths[i] + (k ? space : 0), 0);
    const y = top + li * lineHeight;
    const baseline = y + (lineHeight - (ascent + descent)) / 2 + ascent;
    let x = (W - width) / 2;
    for (const i of ids) {
      words.push({ index: i, text: tokens[i], x, baseline, width: widths[i] });
      x += widths[i] + space;
    }
    const padX = fontSize * 0.25;
    boxes.push({ x: (W - width) / 2 - padX, y, width: width + 2 * padX, height: lineHeight });
  });
  const ink = fontSize * (style.stroke + 0.12) + (style.shadow ? fontSize * 0.06 : 0);
  const minX = boxes.length ? Math.min(...boxes.map((b) => b.x)) - ink : W / 2;
  const maxX = boxes.length ? Math.max(...boxes.map((b) => b.x + b.width)) + ink : W / 2;
  return { fontSize, lineHeight, words, lines: boxes, bounds: { x: Math.max(0, minX), y: Math.max(0, top - ink), width: Math.min(W, maxX) - Math.max(0, minX), height: blockH + 2 * ink } };
}
export function activeWordAt(c, rel) {
  let active = -1;
  (c.words ?? []).forEach((w, i) => {
    if (w.start <= rel) active = i;
  });
  return active;
}

/** Caption positions offered on the phone (vertical centre of the block), all inside the safe area. */
export const CAPTION_POSITIONS = Object.freeze([
  { id: 'top', label: 'Top center', y: 0.2 },
  { id: 'middle', label: 'Middle', y: 0.5 },
  { id: 'lower', label: 'Lower third', y: 0.7 },
  { id: 'bottom', label: 'Bottom center', y: 0.8 },
]);
export function positionOf(y) {
  return CAPTION_POSITIONS.reduce((best, p) => (Math.abs(p.y - y) < Math.abs(best.y - y) ? p : best), CAPTION_POSITIONS[0]);
}
