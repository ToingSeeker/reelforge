import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error plain .mjs release script, no types
import { chromeTreeDigest } from "../../../scripts/release/build-motion.mjs";

test("the Chrome pin covers every shipped file, not just the executable", () => {
  const dir = mkdtempSync(join(tmpdir(), "rf-chrome-"));
  try {
    mkdirSync(join(dir, "Helpers"));
    writeFileSync(join(dir, "chrome-headless-shell"), "exe");
    chmodSync(join(dir, "chrome-headless-shell"), 0o755);
    writeFileSync(join(dir, "libEGL.dylib"), "egl");
    writeFileSync(join(dir, "Helpers/chrome_crashpad_handler"), "crashpad");
    const base = chromeTreeDigest(dir).sha256;
    writeFileSync(join(dir, ".DS_Store"), "finder");
    assert.equal(chromeTreeDigest(dir).sha256, base, "Finder litter is ignored");
    appendFileSync(join(dir, "libEGL.dylib"), "!");
    assert.notEqual(chromeTreeDigest(dir).sha256, base, "a changed sibling dylib fails the pin");
    writeFileSync(join(dir, "libEGL.dylib"), "egl");
    assert.equal(chromeTreeDigest(dir).sha256, base);
    writeFileSync(join(dir, "Helpers/extra.dylib"), "x");
    assert.notEqual(chromeTreeDigest(dir).sha256, base, "an added file fails the pin");
    rmSync(join(dir, "Helpers/extra.dylib"));
    chmodSync(join(dir, "libEGL.dylib"), 0o755);
    assert.notEqual(chromeTreeDigest(dir).sha256, base, "a changed executable bit fails the pin");
    chmodSync(join(dir, "libEGL.dylib"), 0o644);
    symlinkSync("libEGL.dylib", join(dir, "libGLESv2.dylib"));
    assert.throws(() => chromeTreeDigest(dir), /unexpected symlink/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
