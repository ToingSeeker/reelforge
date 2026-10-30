import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realpathSync, statSync } from "node:fs";
import type { AssetFile, AssetProbe } from "../src/index.ts";

export function tempDir(t: { after: (fn: () => void) => void }, prefix = "reelforge-test-"): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A stand-in media file plus a probe result, so core tests don't need FFmpeg. */
export function fakeMedia(dir: string, name: string, probe: Partial<AssetProbe> = {}): { file: AssetFile; probe: AssetProbe } {
  const path = join(dir, name);
  writeFileSync(path, `fake media ${name}`);
  const st = statSync(path);
  return {
    file: { path, sizeBytes: st.size, mtimeMs: st.mtimeMs },
    probe: {
      kind: "video",
      durationUs: 10_000_000,
      width: 1080,
      height: 1920,
      fps: { num: 30, den: 1 },
      vfr: false,
      hasVideo: true,
      hasAudio: true,
      videoCodec: "h264",
      audioCodec: "aac",
      sampleRate: 48000,
      channels: 2,
      rotation: 0,
      ...probe,
    },
  };
}
