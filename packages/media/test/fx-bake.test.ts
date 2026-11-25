import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bakeFx, FxBaker, trackingWarning } from "../src/fx/bake.ts";
import { fixtures } from "./fixtures.ts";

test("fx bake: card pictures reach the engine only as PNG stills made by our FFmpeg, never as the user's file", async () => {
  const f = fixtures();
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "reelforge-fxbake-")));
  process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
  // A stand-in engine: records what each images folder holds (name + first bytes), then passes the clip through.
  const engine = join(dir, "engine");
  mkdirSync(join(engine, "scripts"), { recursive: true });
  writeFileSync(join(engine, "scripts/fx.py"), "");
  const report = join(dir, "report.txt");
  const python = join(dir, "python");
  writeFileSync(
    python,
    `#!/bin/sh\nfor p in images-*/*; do [ -e "$p" ] || continue; printf '%s ' "$p"; head -c 8 "$p" | od -An -tx1 | tr -d ' \\n'; echo; done > "${report}"\ncp "$5" "$6"\n`,
  );
  chmodSync(python, 0o755);
  // Content that a sniffing parser would read as a playlist pointing at another local file.
  const playlist = join(dir, "playlist.mp4");
  writeFileSync(playlist, `#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\nfile:${f.portrait}\n#EXT-X-ENDLIST\n`);
  const saved = { dir: process.env.REELFORGE_FX_DIR, py: process.env.REELFORGE_FX_PYTHON };
  process.env.REELFORGE_FX_DIR = engine;
  process.env.REELFORGE_FX_PYTHON = python;
  try {
    const cacheDir = join(dir, "cache");
    await bakeFx(
      {
        key: "0123456789abcdef",
        assetId: "a",
        sourcePath: f.portrait,
        sourceFrom: 0,
        sourceTo: 30,
        fps: { num: 30, den: 1 },
        shortSide: 216,
        width: 216,
        height: 384,
        effects: [{ fx: "orbit", start: 0, end: 1, images: [f.jpg, f.png, f.silent, playlist, f.landscape] }],
      },
      { cacheDir },
    );
    const lines = readFileSync(report, "utf8").trim().split("\n");
    const PNG = "89504e470d0a1a0a";
    // jpg, png, a 1 s clip (first frame, no frame at 1 s), and the .mov: all PNG. The playlist is left out.
    assert.deepEqual(lines, ["images-0/000.png", "images-0/001.png", "images-0/002.png", "images-0/004.png"].map((n) => `${n} ${PNG}`));
  } finally {
    if (saved.dir === undefined) delete process.env.REELFORGE_FX_DIR;
    else process.env.REELFORGE_FX_DIR = saved.dir;
    if (saved.py === undefined) delete process.env.REELFORGE_FX_PYTHON;
    else process.env.REELFORGE_FX_PYTHON = saved.py;
  }
});

test("fx bake: a clip with no face still bakes, and the bake says so (kept across restarts)", async () => {
  const f = fixtures();
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "reelforge-fxwarn-")));
  process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
  const engine = join(dir, "engine");
  mkdirSync(join(engine, "scripts"), { recursive: true });
  writeFileSync(join(engine, "scripts/fx.py"), "");
  // A stand-in engine that reports what tracking found (FACES env), then passes the clip through.
  const python = join(dir, "python");
  writeFileSync(python, `#!/bin/sh\necho "Pass 1: tracking you (1 effect)..."\necho "Tracked: face in $FACES of 30 frames, body only in $BODIES"\ncp "$5" "$6"\n`);
  chmodSync(python, 0o755);
  const saved = { dir: process.env.REELFORGE_FX_DIR, py: process.env.REELFORGE_FX_PYTHON };
  process.env.REELFORGE_FX_DIR = engine;
  process.env.REELFORGE_FX_PYTHON = python;
  const spec = (key: string) => ({ key, assetId: "a", sourcePath: f.portrait, sourceFrom: 0, sourceTo: 30, fps: { num: 30, den: 1 }, shortSide: 216, width: 216, height: 384, effects: [{ fx: "tap", start: 0, end: 1 }] });
  try {
    const cacheDir = join(dir, "cache");
    const baker = new FxBaker(cacheDir);
    const cases = [
      ["00000000000000a0", "0", "0", /No face found.*middle of the frame/],
      ["00000000000000a1", "0", "25", /No face found.*guessed body outline/],
      ["00000000000000a2", "28", "2", undefined],
    ] as const;
    for (const [key, faces, bodies, want] of cases) {
      process.env.FACES = faces;
      process.env.BODIES = bodies;
      await baker.ensure(spec(key));
      const st = baker.state(key);
      assert.equal(st?.state, "done");
      const warning = st?.state === "done" ? st.warning : "?";
      if (want) assert.match(warning ?? "", want, key);
      else assert.equal(warning, undefined, key);
      // A restarted engine finds the bake and its warning on disk.
      const again = new FxBaker(cacheDir).state(key);
      assert.deepEqual(again, st);
    }
    baker.stop();
    assert.equal(trackingWarning("Pass 1\nDone"), undefined, "an engine without the report never warns");
  } finally {
    delete process.env.FACES;
    delete process.env.BODIES;
    if (saved.dir === undefined) delete process.env.REELFORGE_FX_DIR;
    else process.env.REELFORGE_FX_DIR = saved.dir;
    if (saved.py === undefined) delete process.env.REELFORGE_FX_PYTHON;
    else process.env.REELFORGE_FX_PYTHON = saved.py;
  }
});
