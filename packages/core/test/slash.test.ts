import { test } from "node:test";
import assert from "node:assert/strict";
import { ClipPropsPatchSchema, motionPatch, type Timeline } from "../src/index.ts";
import { parseSlash, planSlash, slashSuggestions, isSlashCommand, SLASH_COMMANDS } from "../src/slash.ts";

// Just the parts planSlash reads.
function timeline(opts: { lockV1?: boolean } = {}): Timeline {
  return {
    project: { settings: { width: 1080, height: 1920, fps: { num: 30, den: 1 } } },
    tracks: [
      { id: "v1", kind: "video", name: "V1", locked: !!opts.lockV1 },
      { id: "o1", kind: "overlay", name: "Overlays", locked: false },
      { id: "a1", kind: "audio", name: "Music", locked: false },
    ],
    clips: [
      { id: "c1", trackId: "v1", start: 0, duration: 90, props: {} },
      { id: "c2", trackId: "o1", start: 0, duration: 20, props: {} },
      { id: "c3", trackId: "a1", start: 0, duration: 300, props: {} },
    ],
  } as unknown as Timeline;
}

function plan(input: string, selection: string[], t = timeline()) {
  const p = parseSlash(input);
  assert.ok(p.ok, p.ok ? "" : p.error);
  return planSlash(t, selection, p.command);
}

function props(input: string, selection = ["c1"]) {
  const r = plan(input, selection);
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
