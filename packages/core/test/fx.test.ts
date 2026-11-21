import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AiFxSchema, ClipPropsPatchSchema, FX_CATALOG, FX_NUMERIC_OPTIONS, FX_ENGINE_VERSION, clampFxOpts, fxBakeSize, fxInfo, fxOptionRange, planClipFx, sparseClipProps, stableHash } from "../src/index.ts";

const fps = { num: 30, den: 1 };
const asset = { id: "a1", sourcePath: "/m/talk.mp4", sizeBytes: 1000, durationFrames: 900, width: 1080, height: 1920 };

test("the catalogue lists exactly the effects fx.py defines", () => {
  const src = readFileSync(join(import.meta.dirname, "../../fx-engine/scripts/fx.py"), "utf8");
  const defined = [...src.matchAll(/@effect\('([^']+)'/g)].map((m) => m[1]);
  assert.equal(FX_CATALOG.length, 45);
  assert.deepEqual([...FX_CATALOG.map((f) => f.fx)].sort(), [...defined].sort());
  // Numeric options, read the same way the engine reads them.
  const parts = src.split(/\n@effect\('([^']+)'/);
  const numeric: Record<string, string[]> = {};
  for (let i = 1; i < parts.length; i += 2) {
    const keys = [...new Set([...parts[i + 1]!.matchAll(/(?:float|int)\(\s*e\.o\.get\('([a-z_]+)'/g)].map((m) => m[1]!))].sort();
    if (keys.length) numeric[parts[i]!] = keys;
  }
  assert.deepEqual(FX_NUMERIC_OPTIONS, numeric);
  assert.equal(fxInfo("glitter")?.fx, "spotlight");
  assert.equal(fxInfo("/stamp")?.fx, "reject-stamp");
  assert.match(FX_ENGINE_VERSION, /c97d01b/);
});

test("every numeric option has a range, and fx.py's own default sits inside it", () => {
  const src = readFileSync(new URL("../../fx-engine/scripts/fx.py", import.meta.url), "utf8");
  const parts = src.split(/\n@effect\('([^']+)'/);
  for (let i = 1; i < parts.length; i += 2) {
    const fx = parts[i]!;
    for (const k of FX_NUMERIC_OPTIONS[fx] ?? []) {
      const r = fxOptionRange(fx, k);
      assert.ok(r && r[0] < r[1], `${fx}.${k} has a range`);
      const d = parts[i + 1]!.match(new RegExp(`e\\.o\\.get\\('${k}',\\s*'?(-?[0-9.]+)`));
      if (d) assert.ok(Number(d[1]) >= r![0] && Number(d[1]) <= r![1], `${fx}.${k} default ${d[1]} inside ${r}`);
    }
  }
});

test("out-of-range numeric options are refused on save and clamped in the bake plan", () => {
  for (const opts of [{ size: 30 }, { count: 1e15 }, { count: 0 }, { speed: 100 }]) {
    assert.equal(AiFxSchema.safeParse({ fx: "orbit", start: 0, end: 30, opts }).success, false, JSON.stringify(opts));
  }
  assert.equal(AiFxSchema.safeParse({ fx: "headline-wall", start: 0, end: 30, opts: { count: 1e12 } }).success, false);
  assert.equal(AiFxSchema.safeParse({ fx: "lean-in", start: 0, end: 30, opts: { speed: 0 } }).success, false);
  assert.ok(AiFxSchema.safeParse({ fx: "orbit", start: 0, end: 30, opts: { size: 0.3, count: 8 } }).success);
  assert.ok(AiFxSchema.safeParse({ fx: "profile-wall", start: 0, end: 30, opts: { count: 197000 } }).success);
  // a text option is not touched by the range check
  assert.deepEqual(clampFxOpts("orbit", { size: 30, count: 1e15, speed: 1.9, label: "x" }), { size: 1, count: 60, speed: 1.9, label: "x" });
});

test("AI effects validate: known effect, end after start, no reserved or unbounded options", () => {
  const ok = { fx: "spotlight", start: 30, end: 120, text: "ANGKA", color: "#ff8800", opts: { push: 1.2 } };
  assert.ok(AiFxSchema.safeParse(ok).success);
  assert.ok(!AiFxSchema.safeParse({ ...ok, fx: "explode" }).success);
  assert.ok(!AiFxSchema.safeParse({ ...ok, end: 30 }).success);
  assert.ok(!AiFxSchema.safeParse({ ...ok, opts: { images: "/etc" } }).success, "images only as asset ids");
  assert.ok(!AiFxSchema.safeParse({ ...ok, images: ["/Users/me/Pictures"] }).success);
  assert.ok(!AiFxSchema.safeParse({ ...ok, text: "a\u0000b" }).success);
  assert.ok(!AiFxSchema.safeParse({ fx: "lean-in", start: 0, end: 60, opts: { speed: "fast" } }).success, "numeric options must be numbers");
  assert.ok(AiFxSchema.safeParse({ fx: "lean-in", start: 0, end: 60, opts: { speed: 0.3 } }).success);
  assert.ok(ClipPropsPatchSchema.safeParse({ aiEffects: [ok] }).success);
  assert.deepEqual(sparseClipProps({ aiEffects: [] }), {}, "no effects is the default and isn't stored");
});

test("bakes: source-time effects land on the clip, merge when close, keep a lead, drop what doesn't play", () => {
  // clip shows source frames 300.. at timeline 60..; effects at source 360–450 and 474–540 (0.8 s apart → one bake)
  const clip = { start: 60, sourceIn: 300, renderStart: 60, renderEnd: 660, effects: [
    { fx: "spotlight", start: 360, end: 450, text: "A" },
    { fx: "lean-in", start: 474, end: 540 },
    { fx: "moody", start: 0, end: 200 }, // before the in point: never plays
  ] };
  const { specs, pieces } = planClipFx(clip, asset, fps, 1080);
  assert.equal(specs.length, 1);
  assert.deepEqual(pieces, [{ key: specs[0]!.key, from: 120, to: 300, bakeOffset: 15 }]);
  const s = specs[0]!;
  assert.deepEqual([s.sourceFrom, s.sourceTo], [345, 555]); // 0.5 s lead on both sides
  assert.deepEqual(s.effects.map((e) => [e.fx, e.start, e.end]), [["spotlight", 0.5, 3.5], ["lean-in", 4.3, 6.5]]);
  assert.deepEqual([s.width, s.height], [1080, 1920]);
  // Moving the clip on the timeline doesn't change what gets baked (same key), trimming the effect does.
  assert.equal(planClipFx({ ...clip, start: 0, renderStart: 0, renderEnd: 600 }, asset, fps, 1080).specs[0]!.key, s.key);
  assert.notEqual(planClipFx({ ...clip, effects: [{ ...clip.effects[0]!, end: 449 }] }, asset, fps, 1080).specs[0]!.key, s.key);
  // Far apart → two bakes.
  const two = planClipFx({ ...clip, effects: [{ fx: "spotlight", start: 330, end: 360 }, { fx: "spotlight", start: 600, end: 630 }] }, asset, fps, 1080);
  assert.equal(two.specs.length, 2);
  assert.deepEqual(fxBakeSize(1920, 1080, 720), { width: 1280, height: 720 });
  assert.equal(stableHash("x"), stableHash("x"));
  for (let i = 0; i < 2000; i++) assert.match(stableHash(`clip-${i}`), /^[0-9a-f]{16}$/);
  assert.notEqual(stableHash("x"), stableHash("y"));
});
