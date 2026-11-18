// The phone editor's local guess (public/edit-model.js) against the engine's own code: same presets, same
// edit results, same placement and caption layout. If core changes, these fail before the phone lies.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyOperations,
  CAPTION_FONTS as CORE_FONTS,
  CAPTION_PRESETS as CORE_PRESETS,
  DEFAULT_CLIP_PROPS as CORE_DEFAULTS,
  layoutCaption as coreLayout,
  placement as corePlacement,
  resolveClipProps,
  type EditState,
  type PlanSegment,
  type TimelineOp,
} from "../../../packages/core/src/index.ts";

const m = (await import(new URL("../public/edit-model.js", import.meta.url).href)) as typeof import("../public/edit-model.js");

const fps = { num: 30, den: 1 };
const V1 = "00000000-0000-4000-8000-000000000001";
const C1 = "00000000-0000-4000-8000-000000000002";
const A = "00000000-0000-4000-8000-0000000000a1";
const clip = (id: string, start: number, duration: number, sourceIn = 0, props = {}) => ({ id, trackId: V1, assetId: A, start, duration, sourceIn, props });
const ids = (n: number) => `00000000-0000-4000-8000-00000000010${n}`;

function core(clips: ReturnType<typeof clip>[], ops: TimelineOp[]) {
  const state: EditState = {
    fps,
    tracks: new Map([
      [V1, { id: V1, kind: "video", name: "Video 1", position: 1, muted: false, locked: false, hidden: false }],
      [C1, { id: C1, kind: "caption", name: "Captions", position: 0, muted: false, locked: false, hidden: false }],
    ]),
    clips: new Map(clips.map((c) => [c.id, c])),
    captions: new Map([[ids(9), { id: ids(9), trackId: C1, start: 0, duration: 30, text: "one two", words: [] }]]),
    assets: new Map([[A, { id: A, kind: "video", durationFrames: 300, hasVideo: true, hasAudio: true }]]),
  };
  return applyOperations(state, ops);
}

function phone(clips: ReturnType<typeof clip>[], ops: TimelineOp[]) {
  const model = {
    tracks: [
      { id: V1, kind: "video", label: "V1", position: 1, muted: false, locked: false, hidden: false },
      { id: C1, kind: "caption", label: "C1", position: 0, muted: false, locked: false, hidden: false, stylePatch: {}, captionStyle: m.resolveCaptionStyle({}) },
    ],
    clips: clips.map((c) => ({ ...c, props: { ...m.DEFAULT_CLIP_PROPS, ...c.props } })),
    captions: [{ id: ids(9), trackId: C1, start: 0, duration: 30, text: "one two", words: [] }],
    assets: [{ id: A, kind: "video", durationFrames: 300, hasVideo: true, hasAudio: true }],
  };
  return m.applyOps(model as never, ops as never);
}

/** Clips as the engine would show them to the phone: positions plus resolved props. */
const norm = (list: Iterable<{ id: string; start: number; duration: number; sourceIn: number; props: object }>) =>
  [...list].map((c) => ({ id: c.id, start: c.start, duration: c.duration, sourceIn: c.sourceIn, props: Object.fromEntries(Object.entries(resolveClipProps(c.props)).filter(([k]) => k !== "aiEffects")) })).sort((a, b) => a.start - b.start);

test("edit-model: presets and defaults are the engine's", () => {
  assert.deepEqual({ ...m.CAPTION_PRESETS }, CORE_PRESETS);
  assert.deepEqual({ ...m.CAPTION_FONTS }, CORE_FONTS);
  const { aiEffects: _ai, ...defaults } = CORE_DEFAULTS;
  assert.deepEqual({ ...m.DEFAULT_CLIP_PROPS }, defaults);
});

test("edit-model: trims, splits, deletes and reorders land where the engine puts them", () => {
  const base = [clip(ids(1), 0, 90, 10, { fadeIn: 6, fadeOut: 9 }), clip(ids(2), 90, 60), clip(ids(3), 150, 30, 100)];
  const cases: TimelineOp[][] = [
    [{ type: "clip.trim", clipId: ids(1), edge: "start", frame: 12 }],
    [{ type: "clip.trim", clipId: ids(2), edge: "end", frame: 120 }],
    [{ type: "clip.split", clipId: ids(1), frame: 40, newClipId: ids(5) }],
    [{ type: "clip.delete", clipIds: [ids(2)] }],
    [{ type: "clip.delete", clipIds: [ids(2)], ripple: true }],
    [{ type: "clip.update", clipId: ids(3), props: { fit: "contain", scale: 1.15, x: 0.12, y: -0.05 } }],
    [{ type: "clip.update", clipId: ids(1), props: { gainDb: -6, fadeIn: 200 } }],
    m.reorderOps({ clips: base.map((c) => ({ ...c, props: { ...m.DEFAULT_CLIP_PROPS, ...c.props } })) } as never, V1, [ids(3), ids(1), ids(2)]) as TimelineOp[],
  ];
  for (const ops of cases) assert.deepEqual(norm(phone(base, ops).clips), norm(core(base, ops).clips.values()), JSON.stringify(ops));

  // Where the engine refuses, the phone refuses too (and says why).
  const refused: TimelineOp[][] = [
    [{ type: "clip.trim", clipId: ids(2), edge: "end", frame: 400 }],
    [{ type: "clip.trim", clipId: ids(2), edge: "start", frame: 85 }],
    [{ type: "clip.split", clipId: ids(1), frame: 90, newClipId: ids(5) }],
    [{ type: "clip.move", clipId: ids(3), start: 100 }],
  ];
  for (const ops of refused) {
    assert.throws(() => core(base, ops), JSON.stringify(ops));
    assert.throws(() => phone(base, ops), m.EditRejected, JSON.stringify(ops));
  }
});

test("edit-model: caption edits keep the engine's overlap rule", () => {
  const base = [clip(ids(1), 0, 90)];
  const ok: TimelineOp[] = [{ type: "caption.update", captionId: ids(9), text: "The spider trade strategy, explained.", start: 3, duration: 40 }];
  const c = core(base, ok).captions.get(ids(9))!;
  const p = phone(base, ok).captions.find((x: { id: string }) => x.id === ids(9));
  assert.deepEqual({ text: p.text, start: p.start, duration: p.duration, words: p.words }, { text: c.text, start: c.start, duration: c.duration, words: c.words });
});

test("edit-model: framing and caption layout match the render plan to the pixel", () => {
  const seg = (props: object) => ({ clipId: "c", assetId: A, trackId: V1, start: 0, duration: 90, sourceIn: 0, props: resolveClipProps(props), renderStart: 0, renderEnd: 90, renderSourceIn: 0, inH: 0, outH: 0 }) as PlanSegment;
  for (const props of [{}, { fit: "contain" }, { scale: 1.15, x: 0.12 }, { scale: 1, scaleEnd: 1.4, x: 0, xEnd: 0.2 }, { cropLeft: 0.1, cropTop: 0.05, fit: "contain", y: -0.3 }]) {
    for (const frame of [0, 45, 89]) {
      assert.deepEqual(m.placement(seg(props) as never, frame, 1920, 1080, 1080, 1920), corePlacement(seg(props), frame, 1920, 1080, 1080, 1920), JSON.stringify(props));
    }
  }
  // A fake font with fixed advances: both layouts must break and place words identically.
  const font = { unitsPerEm: 1000, ascender: 900, descender: -250, getAdvanceWidth: (t: string, size: number) => t.length * size * 0.55 };
  const cap = { text: "The spider trade strategy, explained.", words: [] };
  for (const style of Object.values(CORE_PRESETS)) {
    assert.deepEqual(m.layoutCaption(cap, style, 1080, 1920, font), coreLayout(cap, style, 1080, 1920, font));
  }
});

test("edit-model: timecodes are frame-exact both ways", () => {
  for (const f of [0, 1, 29, 30, 96, 559, 1979, 3600 * 30 + 15]) {
    const tc = m.timecode(f, fps);
    assert.equal(m.parseTimecode(tc, fps), f, `${f} → ${tc}`);
  }
  const ntsc = { num: 30000, den: 1001 };
  for (const f of [0, 1, 299, 1798, 17982]) assert.equal(m.parseTimecode(m.timecode(f, ntsc), ntsc), f);
  assert.equal(m.timecode(96, fps), "00:03.20");
  assert.equal(m.parseTimecode("3.2", fps), 96);
  assert.equal(m.parseTimecode("0:03,20", fps), 96);
  assert.equal(m.parseTimecode("abc", fps), null);
});
