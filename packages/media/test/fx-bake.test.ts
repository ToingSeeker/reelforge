import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bakeFx } from "../src/fx/bake.ts";
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
