import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  AiFxSchema,
  ClipPropsPatchSchema,
  FX_CATALOG,
  FX_ENGINE_SOURCE_SHA256,
  FX_ENGINE_TIME_ORIGIN,
  FX_ENGINE_VERSION,
  FX_NUMBER_LIST_OPTIONS,
  FX_NUMERIC_OPTIONS,
  FX_TIME_OPTIONS,
  clampFxOpts,
  fxBakeSize,
  fxInfo,
  fxOptionRange,
  planClipFx,
  sparseClipProps,
  stableHash,
} from "../src/index.ts";

const fxPy = () => readFileSync(join(import.meta.dirname, "../../fx-engine/scripts/fx.py"), "utf8");

/**
 * How each effect's body in fx.py reads its options: as a number (the option is the direct argument of
 * float()/int(), however it's looked up: e.o.get('k') or e.o['k']), as a list of numbers ([float(t) for t
 * in …e.o['k']…split('|')]), and whether a time is then measured from the clip (`- e.start`).
 */
function engineReads(src: string) {
  const parts = src.split(/\n@effect\('([^']+)'/);
  const numeric: Record<string, string[]> = {};
  const lists: Record<string, string[]> = {};
  const clipTimes: Record<string, string[]> = {};
  const add = (m: Record<string, string[]>, fx: string, k: string) => (m[fx] = [...new Set([...(m[fx] ?? []), k])].sort());
  for (let i = 1; i < parts.length; i += 2) {
    const fx = parts[i]!;
    for (const line of parts[i + 1]!.split("\n")) {
      for (const m of line.matchAll(/e\.o(?:\.get\(|\[)'([a-z_]+)'/g)) {
        const before = line.slice(0, m.index);
        // Walk back to the calls and brackets this lookup sits inside.
        let depth = 0;
        let call: string | undefined;
        let bracket = -1;
        for (let j = before.length - 1; j >= 0 && bracket < 0; j--) {
          const ch = before[j]!;
          if (ch === ")" || ch === "]") depth++;
          else if (ch === "(" || ch === "[") {
            if (depth > 0) depth--;
            else if (ch === "[") bracket = j;
            else call ??= /(\w+)$/.exec(before.slice(0, j))?.[1] ?? "";
          }
        }
        const k = m[1]!;
        const asList = bracket >= 0 && /^\[\s*(?:float|int)\((\w+)\)[^[]*\bfor \1 in /.test(line.slice(bracket, m.index));
        if (asList) add(lists, fx, k);
        else if (call === "float" || call === "int") add(numeric, fx, k);
        else continue;
        if (/\)\s*-\s*e\.start\b/.test(line)) add(clipTimes, fx, k);
      }
    }
  }
  return { numeric, lists, clipTimes };
}

const fps = { num: 30, den: 1 };
const asset = { id: "a1", sourcePath: "/m/talk.mp4", sizeBytes: 1000, durationFrames: 900, width: 1080, height: 1920 };

test("the catalogue lists exactly the effects fx.py defines", () => {
  const src = fxPy();
  const defined = [...src.matchAll(/@effect\('([^']+)'/g)].map((m) => m[1]);
  assert.equal(FX_CATALOG.length, 45);
  assert.deepEqual([...FX_CATALOG.map((f) => f.fx)].sort(), [...defined].sort());
  // Numeric and number-list options, read the same way the engine reads them.
  const reads = engineReads(src);
  assert.deepEqual(FX_NUMERIC_OPTIONS, reads.numeric);
  assert.deepEqual(FX_NUMBER_LIST_OPTIONS, reads.lists);
  // Every time option is one the engine reads as numbers, measured from where the bake says.
  for (const [fx, keys] of Object.entries(FX_TIME_OPTIONS)) {
    for (const k of keys) {
      assert.ok(reads.numeric[fx]?.includes(k) || reads.lists[fx]?.includes(k), `${fx}.${k} is read as a number`);
      assert.equal(FX_ENGINE_TIME_ORIGIN[fx]?.[k], reads.clipTimes[fx]?.includes(k) ? "clip" : "effect", `${fx}.${k} origin`);
    }
  }
  assert.deepEqual(Object.keys(FX_ENGINE_TIME_ORIGIN).sort(), Object.keys(FX_TIME_OPTIONS).sort());
  // The documented options say these are source-video seconds.
  for (const [fx, keys] of Object.entries(FX_TIME_OPTIONS)) for (const k of keys) assert.match(fxInfo(fx)!.options, new RegExp(`\`${k}\` \\([^)]*source video`), `${fx}.${k}`);
  assert.equal(fxInfo("glitter")?.fx, "spotlight");
  assert.equal(fxInfo("/stamp")?.fx, "reject-stamp");
  assert.match(FX_ENGINE_VERSION, /c97d01b/);
});

test("changing fx.py without bumping FX_ENGINE_VERSION fails (cached bakes would keep the old look)", () => {
  const sha = createHash("sha256").update(fxPy().replace(/\r\n/g, "\n")).digest("hex");
  assert.equal(sha, FX_ENGINE_SOURCE_SHA256, "fx.py changed: bump FX_ENGINE_VERSION and set FX_ENGINE_SOURCE_SHA256 to the new hash");
  // Versions already used with another fx.py: reusing one would serve bakes made by that engine.
  const released: Record<string, string> = {
    "claude-video-effects@c97d01b+rf1": "2b578e86fbbfe37991de2c3bff86387940d9cb617e73a500dfe147707899cfb0",
  };
  assert.ok(!(FX_ENGINE_VERSION in released) || released[FX_ENGINE_VERSION] === sha, `${FX_ENGINE_VERSION} already named another fx.py`);
});

test("time options are source seconds: the bake hands fx.py the times it measures from", () => {
  // Clip shows source frames 300.. from timeline 60; tap 360–450 (source 12–15 s) flips at source 13.5 s.
  const clip = (effects: object[]) => ({ start: 60, sourceIn: 300, renderStart: 60, renderEnd: 660, effects: effects as never });
  const tap = planClipFx(clip([{ fx: "tap", start: 360, end: 450, opts: { at: 13.5, x: 0.5 } }]), asset, fps, 1080).specs[0]!;
  // The stretch starts 0.5 s before the effect (source 11.5 s): fx.py gets the effect at 0.5 s, the flip at 2.0 s.
  assert.equal(tap.sourceFrom, 345);
  assert.deepEqual([tap.effects[0]!.start, tap.effects[0]!.opts], [0.5, { at: 2, x: 0.5 }]);
  // todo: fx.py also measures ticks from the clip; apple-toggles from the effect's start.
  const todo = planClipFx(clip([{ fx: "todo", start: 360, end: 450, opts: { ticks: "12.5|13.25" } }]), asset, fps, 1080).specs[0]!;
  assert.deepEqual(todo.effects[0]!.opts, { ticks: "1|1.75" });
  const toggles = planClipFx(clip([{ fx: "apple-toggles", start: 360, end: 450, opts: { ticks: "12.5 | 13.25" } }]), asset, fps, 1080).specs[0]!;
  assert.deepEqual(toggles.effects[0]!.opts, { ticks: "0.5|1.25" });
  const one = planClipFx(clip([{ fx: "apple-toggles", start: 360, end: 450, opts: { ticks: 13 } }]), asset, fps, 1080).specs[0]!;
  assert.deepEqual(one.effects[0]!.opts, { ticks: 1 });
});

test("number options the engine parses refuse text up front (tap at/x/y, todo and toggles ticks)", () => {
  const ok = (fx: string, opts: object) => AiFxSchema.safeParse({ fx, start: 0, end: 60, opts }).success;
  assert.ok(ok("tap", { at: 1.5, x: 0.2, y: 0.8 }));
  for (const opts of [{ at: "soon" }, { x: "left" }, { y: "0.5" }, { x: 2 }, { at: -1 }]) assert.ok(!ok("tap", opts), JSON.stringify(opts));
  assert.ok(!ok("reject-stamp", { y: "top" }));
  for (const fx of ["todo", "apple-toggles"]) {
    assert.ok(ok(fx, { ticks: "1.2|2.5|4" }), fx);
    assert.ok(ok(fx, { ticks: 3 }), fx);
    for (const ticks of ["soon", "1.2|x", "1||2", "", "-1|2", Array(21).fill(1).join("|")]) assert.ok(!ok(fx, { ticks }), `${fx} ${ticks}`);
  }
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
