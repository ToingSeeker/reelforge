// The phone's own words for itself and for the Mac's engine (public/core.js), checked without a browser.
import { test } from "node:test";
import assert from "node:assert/strict";

const core = (await import(new URL("../public/core.js", import.meta.url).href)) as {
  guessDeviceName(ua: string, touchPoints?: number): string;
  engineMode(engine: { background?: boolean; mode?: string } | null): string | null;
};

const UA = {
  iphoneSafari: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1",
  iphoneChrome: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/131.0.6778.73 Mobile/15E148 Safari/604.1",
  ipadDesktop: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15",
  pixelChrome: "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36",
  samsung: "Mozilla/5.0 (Linux; Android 14; SM-S921B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/26.0 Chrome/122.0.0.0 Mobile Safari/537.36",
  tabletFirefox: "Mozilla/5.0 (Android 14; Tablet; rv:132.0) Gecko/132.0 Firefox/132.0",
};

test("device name: the kind of device and the browser, so the Mac's list tells phones apart", () => {
  assert.equal(core.guessDeviceName(UA.iphoneSafari, 5), "iPhone · Safari");
  assert.equal(core.guessDeviceName(UA.iphoneChrome, 5), "iPhone · Chrome");
  assert.equal(core.guessDeviceName(UA.ipadDesktop, 5), "iPad · Safari", "iPadOS says Macintosh; the touch screen gives it away");
  assert.equal(core.guessDeviceName(UA.ipadDesktop, 0), "Mac · Safari");
  assert.equal(core.guessDeviceName(UA.pixelChrome, 5), "Android phone · Chrome");
  assert.equal(core.guessDeviceName(UA.samsung, 5), "Android phone · Samsung Internet");
  assert.equal(core.guessDeviceName(UA.tabletFirefox, 5), "Android tablet · Firefox");
  assert.equal(core.guessDeviceName("SomethingElse/1.0", 0), "Phone");
});

test("engine mode: a headless `reelforge serve` is not called the editor app", () => {
  assert.equal(core.engineMode({ background: true, mode: "background" }), "In the background (no window needed)");
  assert.equal(core.engineMode({ background: false, mode: "editor" }), "Inside the editor app (stops when it quits)");
  assert.equal(core.engineMode({ background: false, mode: "standalone" }), "Started by hand (reelforge serve)");
  assert.equal(core.engineMode({ background: true }), "In the background (no window needed)", "older Macs: background still known");
  assert.equal(core.engineMode({ background: false }), "In the foreground (editor app or terminal)", "older Macs: don't guess which");
  assert.equal(core.engineMode(null), null);
});
