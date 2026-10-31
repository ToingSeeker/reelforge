import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveClipProps } from "@reelforge/core";
import { effectFilters } from "../src/compile.ts";

test("effect filters: none when off; each effect maps to the parameters the preview shader uses", () => {
  assert.equal(effectFilters(resolveClipProps({}), 1080).length, 0);
  const all = effectFilters(resolveClipProps({ grayscale: 1, blur: 0.4, sharpen: 0.5, vignette: 1, grain: 0.5 }), 1080).join(",");
  assert.match(all, /^colorchannelmixer=rr=0\.2126:rg=0\.7152/);
  assert.match(all, /gblur=sigma=10\.800:steps=6:planes=7/); // 0.4 × 2.5 % × 1080
  assert.match(all, /convolution=0m='0 -75 0 -75 400 -75 0 -75 0':0rdiv=0\.01/);
  assert.match(all, /vignette=angle=1\.2566:dither=0/);
  assert.match(all, /noise=c0s=20:c0f=t\+u/);
});
