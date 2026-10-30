import { test } from "node:test";
import assert from "node:assert/strict";
import {
  formatClock,
  formatTimecode,
  fpsToString,
  framesToSeconds,
  parseFps,
  rational,
  rescaleFrames,
  secondsToFrames,
} from "../src/timebase.ts";

test("parseFps accepts integers, fractions and NTSC decimals", () => {
  assert.deepEqual(parseFps("30"), { num: 30, den: 1 });
  assert.deepEqual(parseFps("30000/1001"), { num: 30000, den: 1001 });
  assert.deepEqual(parseFps("29.97"), { num: 30000, den: 1001 });
  assert.deepEqual(parseFps("60/2"), { num: 30, den: 1 });
  assert.throws(() => parseFps("29.5"), RangeError);
  assert.throws(() => parseFps("0"), RangeError);
});

test("rational normalises and rejects non-integers", () => {
  assert.deepEqual(rational(48, 2), { num: 24, den: 1 });
  assert.throws(() => rational(29.97));
  assert.equal(fpsToString(rational(30000, 1001)), "30000/1001");
});

test("seconds ↔ frames round-trip at 30 fps", () => {
  const fps = rational(30);
  assert.equal(secondsToFrames(30, fps), 900);
  assert.equal(framesToSeconds(900, fps), 30);
  assert.equal(secondsToFrames(0.0499, fps, "floor"), 1);
  assert.equal(secondsToFrames(0.0499, fps, "ceil"), 2);
});

test("NTSC conversion stays exact over an hour", () => {
  const ntsc = rational(30000, 1001);
  // One hour of 29.97 is 107892.107… frames.
  assert.equal(secondsToFrames(3600, ntsc, "floor"), 107892);
  // 30 fps → 29.97 over 1,000,000 frames must not drift (BigInt path).
  assert.equal(rescaleFrames(1_000_000, rational(30), ntsc, "floor"), 999000);
});

test("rescaleFrames between common rates", () => {
  assert.equal(rescaleFrames(48, rational(24), rational(30)), 60);
  assert.equal(rescaleFrames(25, rational(25), rational(30)), 30);
  assert.equal(rescaleFrames(-48, rational(24), rational(30)), -60);
});

test("timecode formatting", () => {
  const fps = rational(30);
  assert.equal(formatTimecode(0, fps), "00:00:00:00");
  assert.equal(formatTimecode(368, fps), "00:00:12:08");
  assert.equal(formatTimecode(30 * 3661 + 5, fps), "01:01:01:05");
  assert.equal(formatClock(368, fps), "00:12.08");
  assert.equal(formatClock(900, fps), "00:30.00");
});
