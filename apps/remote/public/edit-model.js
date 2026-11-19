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

/** core effects.ts MOTION_PRESETS: one-tap camera moves (scale and position only). */
export const MOTION_PRESETS = Object.freeze([
  { key: 'none', label: 'None', hint: 'Still frame', motion: { scale: 1, scaleEnd: null, x: 0, xEnd: null, y: 0, yEnd: null } },
  { key: 'zoomIn', label: 'Zoom in', hint: '100 → 125 %', motion: { scale: 1, scaleEnd: 1.25, x: 0, xEnd: null, y: 0, yEnd: null } },
  { key: 'zoomOut', label: 'Zoom out', hint: '125 → 100 %', motion: { scale: 1.25, scaleEnd: 1, x: 0, xEnd: null, y: 0, yEnd: null } },
  { key: 'pushIn', label: 'Slow push', hint: '100 → 108 %', motion: { scale: 1, scaleEnd: 1.08, x: 0, xEnd: null, y: 0, yEnd: null } },
  { key: 'panLeft', label: 'Pan left', hint: 'Drift to the left', motion: { scale: 1.2, scaleEnd: null, x: 0.08, xEnd: -0.08, y: 0, yEnd: null } },
  { key: 'panRight', label: 'Pan right', hint: 'Drift to the right', motion: { scale: 1.2, scaleEnd: null, x: -0.08, xEnd: 0.08, y: 0, yEnd: null } },
  { key: 'kenBurns', label: 'Ken Burns', hint: 'Zoom and drift', motion: { scale: 1.1, scaleEnd: 1.25, x: 0.04, xEnd: -0.04, y: 0.02, yEnd: -0.02 } },
]);
/** core motionPresetOf: the preset a clip's motion matches exactly, or null for a hand-made one. */
export function motionPresetOf(p) {
  return MOTION_PRESETS.find((m) => Object.keys(m.motion).every((k) => p[k] === m.motion[k]))?.key ?? null;
}

/** core timeline-ops.ts DEFAULT_STILL_SECONDS: how long a photo lands on the timeline. */
export const DEFAULT_STILL_SECONDS = 3;
/** core schema.ts MAX_FRAME: the longest a timeline may run (24 h at 240 fps). */
export const MAX_FRAME = 24 * 60 * 60 * 240;
/** Engine limits (schema.ts): what the controls clamp to. */
export const LIMITS = Object.freeze({ scale: [0.05, 10], pos: [-2, 2], gainDb: [-60, 12], captionY: [0.05, 0.95], captionSize: [0.015, 0.2], captionText: 300 });

// ── time ────────────────────────────────────────────────────────────────────
/** Frames are integers in the project's timebase; seconds only ever for display. */
export const fpsValue = (fps) => fps.num / fps.den;
export const framesToSeconds = (f, fps) => (f * fps.den) / fps.num;
/** Nearest frame to a time; never float-accumulated (core timebase.ts rounds the same way). */
export const secondsToFrames = (s, fps) => Math.round((s * fps.num) / fps.den);

/**
 * 00:03.20 (minutes:seconds.hundredths) from an exact frame; hours appear past 59:59. Above 100 fps
 * hundredths can't name every frame, so it shows thousandths. Rounded to the nearest, so typing back
 * what's shown always lands on the same frame (parseTimecode).
 */
export function timecode(frames, fps) {
  const total = Math.max(0, framesToSeconds(frames, fps));
  const fine = fpsValue(fps) > 100;
  const per = fine ? 1000 : 100;
  let u = Math.round(total * per);
  const h = Math.floor(u / (3600 * per));
  u -= h * 3600 * per;
  const m = Math.floor(u / (60 * per));
  u -= m * 60 * per;
  const s = Math.floor(u / per);
  u -= s * per;
  const mmss = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(u).padStart(fine ? 3 : 2, '0')}`;
  return h ? `${h}:${mmss}` : mmss;
}

/** A typed time ("3.2", "0:03,20", "1:02:03.5") to the nearest frame; null if it isn't a time. */
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

/** core timeline-ops.ts canPlace: which media a track kind takes. */
export function canPlace(asset, kind) {
  if (kind === 'video' || kind === 'overlay') return asset.kind === 'image' || (asset.kind === 'video' && asset.hasVideo);
  if (kind === 'audio') return asset.kind === 'audio' || (asset.kind === 'video' && asset.hasAudio);
  return false;
}

/** core putCaption: word timings are clamped into the caption and kept in order, never rejected. */
function fitWords(words, duration) {
  return words
    .map((w) => ({ text: w.text, start: Math.min(Math.max(0, w.start), duration), end: Math.min(Math.max(0, w.end), duration) }))
    .map((w) => ({ ...w, end: Math.max(w.start, w.end) }))
    .sort((a, b) => a.start - b.start);
}

function checkClip(m, c) {
  const track = trackOf(m, c.trackId) ?? fail('track not found');
  const asset = assetOf(m, c.assetId) ?? fail('media not found');
  if (!canPlace(asset, track.kind)) fail(`That media can't go on ${track.label}.`);
  if (!Number.isInteger(c.start) || c.start < 0) fail('The clip would start before 00:00.');
  if (!Number.isInteger(c.duration) || c.duration < 1) fail('A clip must be at least one frame long.');
  if (c.sourceIn < 0) fail('That trims past the start of the source media.');
  if (clipEnd(c) > MAX_FRAME) fail('That runs past the longest a timeline can be.');
  if (asset.durationFrames !== null && c.sourceIn + c.duration > asset.durationFrames) fail('That trims past the end of the source media.');
  for (const o of m.clips) if (o.id !== c.id && o.trackId === c.trackId && o.start < clipEnd(c) && c.start < clipEnd(o)) fail(`It would overlap another clip on ${track.label}.`);
}

/** core putCaption + the operation schema: some text, at least a frame, no overlap on its track. */
function checkCaption(m, c) {
  if (!c.text) fail('A caption needs some text.');
  if (c.text.length > LIMITS.captionText) fail(`A caption holds up to ${LIMITS.captionText} characters.`);
  if (!Number.isInteger(c.start) || c.start < 0) fail('A caption can’t start before 00:00.');
  if (!Number.isInteger(c.duration) || c.duration < 1) fail('A caption must be at least one frame long.');
  if (c.start + c.duration > MAX_FRAME) fail('That runs past the longest a timeline can be.');
  for (const o of m.captions) if (o.id !== c.id && o.trackId === c.trackId && o.start < c.start + c.duration && c.start < o.start + o.duration) fail('It would overlap another caption.');
  return { ...c, words: fitWords(c.words ?? evenWords(c.text, c.duration), c.duration) };
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
        // AI effects ride in props on the Mac; the phone keeps the list beside them (edit.ts model()).
        const { aiEffects, ...props } = op.props ?? {};
        put({ ...c, ...(aiEffects !== undefined ? { aiEffects: aiEffects.map((e) => ({ ...e })) } : {}), props: { ...c.props, ...props } });
        break;
      }
      case 'clip.add': {
        unlocked(m, op.trackId);
        const asset = assetOf(m, op.assetId) ?? fail('That media isn’t in this project (removed on the Mac?).');
        const sourceIn = op.sourceIn ?? 0;
        const duration = op.duration ?? (asset.durationFrames === null ? secondsToFrames(DEFAULT_STILL_SECONDS, m.fps) : asset.durationFrames - sourceIn);
        if (!op.clipId) fail('A new clip needs its id.');
        if (clipById(m, op.clipId)) fail('That clip already exists.');
        const { aiEffects = [], ...props } = op.props ?? {};
        put({ id: op.clipId, trackId: op.trackId, assetId: op.assetId, start: op.start, duration, sourceIn, props: { ...DEFAULT_CLIP_PROPS, ...props }, aiEffects });
        break;
      }
      case 'clip.move': {
        const c = clip(op.clipId);
        unlocked(m, c.trackId);
        const trackId = op.trackId ?? c.trackId;
        unlocked(m, trackId);
        put({ ...c, start: op.start, trackId });
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
        if (op.locked !== undefined) t.locked = op.locked;
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
        // The engine's schema trims the text and wants at least a character and a frame (schema.ts).
        const text = op.text !== undefined ? String(op.text).trim() : c.text;
        const duration = op.duration ?? c.duration;
        const start = op.start ?? c.start;
        if (!text) fail('A caption needs some text.');
        if (!Number.isInteger(duration) || duration < 1) fail('A caption must be at least one frame long.');
        if (!Number.isInteger(start) || start < 0) fail('A caption can’t start before 00:00.');
        if (start + duration > MAX_FRAME) fail('That runs past the longest a timeline can be.');
        for (const o of m.captions) if (o.id !== c.id && o.trackId === c.trackId && o.start < start + duration && start < o.start + o.duration) fail('It would overlap the next or previous caption.');
        const words = op.words ?? (op.text !== undefined && text !== c.text ? evenWords(text, duration) : c.words);
        m.captions[i] = { ...c, text, start, duration, words: fitWords(words, duration) };
        break;
      }
      case 'caption.add': {
        const t = unlocked(m, op.trackId);
        if (t.kind !== 'caption') fail('Captions go on a caption track.');
        if (!op.captionId) fail('A new caption needs its id.');
        if (captionById(m, op.captionId)) fail('That caption already exists.');
        m.captions.push(checkCaption(m, { id: op.captionId, trackId: op.trackId, start: op.start, duration: op.duration, text: String(op.text ?? '').trim(), words: op.words ?? null }));
        break;
      }
      case 'caption.delete': {
        const targets = [...new Set(op.captionIds)].map((id) => captionById(m, id) ?? fail('That caption is gone (changed on the Mac?).'));
        for (const c of targets) unlocked(m, c.trackId);
        const gone = new Set(targets.map((c) => c.id));
        m.captions = m.captions.filter((c) => !gone.has(c.id));
        break;
      }
      case 'captions.replace': {
        const t = unlocked(m, op.trackId);
        if (t.kind !== 'caption') fail('Captions go on a caption track.');
        m.captions = m.captions.filter((c) => c.trackId !== op.trackId);
        for (const c of op.captions) {
          if (!c.captionId) fail('Each new caption needs its id.');
          m.captions.push(checkCaption(m, { id: c.captionId, trackId: op.trackId, start: c.start, duration: c.duration, text: String(c.text ?? '').trim(), words: c.words ?? null }));
        }
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
/**
 * A track's clips as the render plan plays them (core render-plan.ts segmentsFor): a dissolve into a
 * clip (transitionIn ≥ 2, butted against the clip before) overlaps both by `inH` frames each side,
 * as far as the media's handles allow.
 */
export function planSegments(model, trackId) {
  const segs = clipsOn(model, trackId).map((c) => ({ ...c, clipId: c.id, renderStart: c.start, renderEnd: c.start + c.duration, renderSourceIn: c.sourceIn, inH: 0, outH: 0 }));
  for (let i = 1; i < segs.length; i++) {
    const a = segs[i - 1];
    const b = segs[i];
    if (b.props.transitionIn < 2 || a.start + a.duration !== b.start) continue;
    const aFrames = assetOf(model, a.assetId)?.durationFrames ?? null;
    const bFrames = assetOf(model, b.assetId)?.durationFrames ?? null;
    const handleA = aFrames === null ? Infinity : aFrames - (a.sourceIn + a.duration);
    const handleB = bFrames === null ? Infinity : b.sourceIn;
    const hh = Math.max(0, Math.min(Math.floor(b.props.transitionIn / 2), handleA, handleB, a.duration, b.duration));
    if (hh === 0) continue;
    a.outH = hh;
    a.renderEnd += hh;
    b.inH = hh;
    b.renderStart -= hh;
    b.renderSourceIn -= hh;
  }
  return segs;
}

/** core render-plan.ts pictureAlpha; takes a planSegments segment (a bare clip works too: no dissolve). */
export function pictureAlpha(seg, frame) {
  const from = seg.renderStart ?? seg.start;
  const to = seg.renderEnd ?? seg.start + seg.duration;
  if (frame < from || frame >= to) return 0;
  const p = seg.props;
  let a = p.opacity;
  if (seg.inH > 0) a *= clamp01((frame - (seg.start - seg.inH)) / (2 * seg.inH));
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
