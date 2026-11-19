import { test } from "node:test";
import assert from "node:assert/strict";
import { ClipPropsPatchSchema, motionPatch, type Timeline } from "../src/index.ts";
import { parseSlash, planSlash, slashSuggestions, isSlashCommand, completeSlash, slashWord, SLASH_COMMANDS, SLASH_LOOKS } from "../src/slash.ts";
import { AiFxSchema } from "../src/schema.ts";
import { FX_CATALOG } from "../src/fx-catalog.ts";

// Just the parts planSlash reads.
function timeline(opts: { lockV1?: boolean; fxCount?: number } = {}): Timeline {
  return {
    project: { settings: { width: 1080, height: 1920, fps: { num: 30, den: 1 } } },
    assets: [
      { id: "vid", kind: "video" },
      { id: "img", kind: "image" },
      { id: "aud", kind: "audio" },
    ],
    tracks: [
      { id: "v1", kind: "video", name: "V1", locked: !!opts.lockV1 },
      { id: "o1", kind: "overlay", name: "Overlays", locked: false },
      { id: "a1", kind: "audio", name: "Music", locked: false },
    ],
    clips: [
      { id: "c1", trackId: "v1", assetId: "vid", start: 0, duration: 90, sourceIn: 0, props: {} },
      { id: "c2", trackId: "o1", assetId: "img", start: 0, duration: 20, sourceIn: 0, props: {} },
      { id: "c3", trackId: "a1", assetId: "aud", start: 0, duration: 300, sourceIn: 0, props: {} },
      {
        id: "c4",
        trackId: "v1",
        assetId: "vid",
        start: 100,
        duration: 200,
        sourceIn: 60,
        props: { aiEffects: Array.from({ length: opts.fxCount ?? 1 }, () => ({ fx: "moody", start: 60, end: 90 })) },
      },
    ],
  } as unknown as Timeline;
}

function plan(input: string, selection: string[], t = timeline(), playhead = 0) {
  const p = parseSlash(input);
  assert.ok(p.ok, p.ok ? "" : p.error);
  return planSlash(t, selection, p.command, { playhead });
}

function props(input: string, selection = ["c1"], playhead = 0) {
  const r = plan(input, selection, timeline(), playhead);
  assert.ok(r.ok, r.ok ? "" : r.error);
  return r.ops.map((o) => (o.type === "clip.update" ? o.props : null));
}

test("picture effects: preset default, amounts as 0-1 / 0-100 / percent, off", () => {
  assert.deepEqual(props("/bw"), [{ grayscale: 1 }]);
  assert.deepEqual(props("/grayscale"), [{ grayscale: 1 }]);
  assert.deepEqual(props("/blur"), [{ blur: 0.3 }]);
  assert.deepEqual(props("/blur 40"), [{ blur: 0.4 }]);
  assert.deepEqual(props("/vignette 0.6"), [{ vignette: 0.6 }]);
  assert.deepEqual(props("/grain 25%"), [{ grain: 0.25 }]);
  assert.deepEqual(props("/SEPIA 100"), [{ sepia: 1 }]);
  assert.deepEqual(props("  /sharpen off "), [{ sharpen: 0 }]);
  const off = parseSlash("/blur off");
  assert.ok(off.ok && off.command.label === "Remove blur");
});

test("bad amounts are rejected with a reason", () => {
  for (const bad of ["/blur 150", "/blur lots", "/blur 1 2", "/blur -5"]) {
    const p = parseSlash(bad);
    assert.equal(p.ok, false, bad);
  }
});

test("motion presets map to the same patches as the Effects panel", () => {
  assert.deepEqual(props("/zoom in"), [motionPatch("zoomIn")]);
  assert.deepEqual(props("/zoom out"), [motionPatch("zoomOut")]);
  assert.deepEqual(props("/push"), [motionPatch("pushIn")]);
  assert.deepEqual(props("/pan left"), [motionPatch("panLeft")]);
  assert.deepEqual(props("/pan right"), [motionPatch("panRight")]);
  assert.deepEqual(props("/kenburns"), [motionPatch("kenBurns")]);
  assert.deepEqual(props("/still"), [motionPatch("none")]);
  assert.match((parseSlash("/zoom") as { error: string }).error, /zoom in/);
  assert.match((parseSlash("/pan up") as { error: string }).error, /pan left/);
});

test("fades: seconds to frames, sides, clamped to the clip", () => {
  assert.deepEqual(props("/fade"), [{ fadeIn: 15, fadeOut: 15 }]);
  assert.deepEqual(props("/fade in 1"), [{ fadeIn: 30 }]);
  assert.deepEqual(props("/fade out 0,5"), [{ fadeOut: 15 }]);
  assert.deepEqual(props("/fade in 250ms"), [{ fadeIn: 8 }]);
  assert.deepEqual(props("/fade off"), [{ fadeIn: 0, fadeOut: 0 }]);
  // c1 is 90 frames: one side can take all of it, two sides half each.
  assert.deepEqual(props("/fade in 10"), [{ fadeIn: 90 }]);
  assert.deepEqual(props("/fade 10"), [{ fadeIn: 45, fadeOut: 45 }]);
  assert.equal(parseSlash("/fade in soon").ok, false);
});

test("every patch passes the engine's props schema", () => {
  for (const input of ["/bw", "/blur 40", "/zoom in", "/kenburns", "/fade 2", "/clear", "/fade in 10"]) {
    for (const patch of props(input)) assert.ok(ClipPropsPatchSchema.safeParse(patch).success, input);
  }
});

test("/clear removes every look and the camera move", () => {
  assert.deepEqual(props("/clear"), [{ ...motionPatch("none"), blur: 0, sharpen: 0, vignette: 0, grayscale: 0, sepia: 0, grain: 0 }]);
});

test("targets: picture commands skip audio clips and locked tracks; fades reach audio", () => {
  const pic = plan("/bw", ["c1", "c2", "c3"]);
  assert.ok(pic.ok);
  assert.deepEqual(pic.ops.map((o) => (o.type === "clip.update" ? o.clipId : "")), ["c1", "c2"]);
  assert.equal(pic.skipped, 1);

  const fade = plan("/fade in 1", ["c1", "c3"]);
  assert.ok(fade.ok);
  assert.equal(fade.ops.length, 2);

  const locked = plan("/bw", ["c1", "c2"], timeline({ lockV1: true }));
  assert.ok(locked.ok);
  assert.deepEqual(locked.ops.map((o) => (o.type === "clip.update" ? o.clipId : "")), ["c2"]);
});

test("targets: nothing selected, or nothing that fits, is an error", () => {
  const none = plan("/bw", []);
  assert.ok(!none.ok && /Select a clip/.test(none.error));
  const audio = plan("/bw", ["c3"]);
  assert.ok(!audio.ok && /video and image/.test(audio.error));
  const locked = plan("/bw", ["c1"], timeline({ lockV1: true }));
  assert.ok(!locked.ok && /locked/.test(locked.error));
});

test("unknown commands suggest a near one", () => {
  const p = parseSlash("/blr");
  assert.ok(!p.ok && /Unknown command \/blr/.test(p.error) && /\/blur/.test(p.error));
  assert.equal(parseSlash("/").ok, false);
});

test("suggestions filter by the typed word and stop once arguments start", () => {
  assert.equal(slashSuggestions("/").length, SLASH_COMMANDS.length);
  assert.deepEqual(slashSuggestions("/s").map((c) => c.name), ["sharpen", "sepia", "still"]);
  assert.deepEqual(slashSuggestions("/zo").map((c) => c.name), ["zoom"]);
  assert.deepEqual(slashSuggestions("/zoom "), []);
  assert.deepEqual(slashSuggestions("hello"), []);
  assert.ok(isSlashCommand(" /bw") && !isSlashCommand("make it b/w"));
});

const NO_LOOKS = { blur: 0, sharpen: 0, vignette: 0, grayscale: 0, sepia: 0, grain: 0 };

test("looks set every picture effect, so one look replaces another", () => {
  assert.deepEqual(props("/noir"), [{ ...NO_LOOKS, grayscale: 1, vignette: 0.6, sharpen: 0.3 }]);
  assert.deepEqual(props("/vintage"), [{ ...NO_LOOKS, sepia: 0.8, grain: 0.4, vignette: 0.4 }]);
  assert.deepEqual(props("/cinematic"), [{ ...NO_LOOKS, vignette: 0.5, grain: 0.3, sharpen: 0.2, ...motionPatch("pushIn") }]);
  // dreamy's fade in is clamped like /fade: c2 is 20 frames, 0.5 s = 15.
  assert.deepEqual(props("/dreamy", ["c2"]), [{ ...NO_LOOKS, blur: 0.15, fadeIn: 15 }]);
  assert.equal(parseSlash("/noir 50").ok, false);
  for (const l of SLASH_LOOKS) for (const patch of props(`/${l.name}`)) assert.ok(ClipPropsPatchSchema.safeParse(patch).success, l.name);
});

test("/fx adds an AI effect at the playhead, in source frames, 3 s long and clamped to the clip", () => {
  // c4: timeline 100–300, source starts at 60. Playhead 150 → source 110, ends 90 frames later.
  const [p] = props("/fx spotlight", ["c4"], 150);
  assert.deepEqual(p!.aiEffects, [
    { fx: "moody", start: 60, end: 90 },
    { fx: "spotlight", start: 110, end: 200 },
  ]);
  // Playhead off the clip → its start; near the end → clamped to the clip end (timeline 300 = source 260).
  assert.deepEqual(props("/fx moody", ["c4"], 0)[0]!.aiEffects!.at(-1), { fx: "moody", start: 60, end: 150 });
  assert.deepEqual(props("/fx moody", ["c4"], 280)[0]!.aiEffects!.at(-1), { fx: "moody", start: 240, end: 260 });
  // Aliases and text (case kept).
  assert.deepEqual(props("/FX led Big Idea", ["c1"])[0]!.aiEffects, [{ fx: "led-sign", start: 0, end: 90, text: "Big Idea" }]);
  for (const fx of props("/fx backdrop-word Hello", ["c1"])[0]!.aiEffects!) assert.ok(AiFxSchema.safeParse(fx).success);
});

test("/fx errors: no name, unknown name, text on an effect without text, wrong clip kinds, full list", () => {
  assert.match((parseSlash("/fx") as { error: string }).error, /Name the effect/);
  assert.match((parseSlash("/fx spotlite") as { error: string }).error, /Unknown AI effect.*\/fx spotlight/);
  assert.match((parseSlash("/fx moody dark") as { error: string }).error, /takes no text/);
  const still = plan("/fx moody", ["c2", "c3"]);
  assert.ok(!still.ok && /video clips only/.test(still.error));
  const full = planSlash(timeline({ fxCount: 20 }), ["c4"], (parseSlash("/fx moody") as { ok: true; command: never }).command);
  assert.ok(!full.ok && /20 AI effects/.test(full.error));
});

test("chains: one op per clip, later parts win, each part only where it fits", () => {
  assert.deepEqual(props("/noir; /vignette 20; /zoom in"), [{ ...NO_LOOKS, grayscale: 1, vignette: 0.2, sharpen: 0.3, ...motionPatch("zoomIn") }]);
  // Later parts may drop the slash; a trailing ";" is fine.
  assert.deepEqual(props("/bw; fade in 1;"), [{ grayscale: 1, fadeIn: 30 }]);
  // Two /fx in a row both land (the second sees the first).
  assert.deepEqual(props("/fx moody; /fx spotlight", ["c1"])[0]!.aiEffects!.map((e) => e.fx), ["moody", "spotlight"]);
  // The picture part skips the audio clip, the fade reaches it: still one op each, nothing skipped.
  const mixed = plan("/bw; /fade out 1", ["c1", "c3"]);
  assert.ok(mixed.ok);
  assert.deepEqual(mixed.ops, [
    { type: "clip.update", clipId: "c1", props: { grayscale: 1, fadeOut: 30 } },
    { type: "clip.update", clipId: "c3", props: { fadeOut: 30 } },
  ]);
  assert.equal(mixed.skipped, 0);
  const ok = parseSlash("/bw; /vignette 20; /zoom in; /fade");
  assert.ok(ok.ok && ok.command.label === "Black & white + Vignette + 2 more", ok.ok ? ok.command.label : "");
  const bad = parseSlash("/bw; /blr");
  assert.ok(!bad.ok && /^Command 2 \(\/blr\)/.test(bad.error));
  assert.equal(parseSlash("/bw;; /sepia").ok, false);
});

test("suggestions and completion follow the part being typed, including effect names after /fx", () => {
  assert.deepEqual(slashSuggestions("/bw; /vig").map((c) => c.name), ["vignette"]);
  assert.deepEqual(slashSuggestions("/bw; vi").map((c) => c.name), ["vignette", "vintage"]);
  assert.equal(slashSuggestions("/fx ").length, FX_CATALOG.length);
  assert.deepEqual(slashSuggestions("/fx spot").map((c) => c.name), ["fx spotlight"]);
  assert.deepEqual(slashSuggestions("/fx led").map((c) => c.name), ["fx led-sign"]);
  assert.deepEqual(slashSuggestions("/fx spotlight "), []);
  assert.deepEqual(slashSuggestions("/no").map((c) => c.name), ["noir"]);

  const vig = slashSuggestions("/bw; /vig")[0]!;
  assert.equal(completeSlash("/bw; /vig", vig), "/bw; /vignette ");
  assert.equal(completeSlash("/pu", slashSuggestions("/pu")[0]!), "/push");
  assert.equal(completeSlash("/fx spot", slashSuggestions("/fx spot")[0]!), "/fx spotlight ");
  assert.equal(completeSlash("/fx moo", slashSuggestions("/fx moo")[0]!), "/fx moody");
  assert.equal(slashWord("/bw; /FX  Moody"), "fx moody");
});
