import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ff = (args: string[]) => execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args]);

export interface Fixtures {
  dir: string;
  portrait: string; // 216x384 @30, 2s, h264 + aac stereo
  landscape: string; // 320x180 @25, 2s, .mov, h264 + aac
  silent: string; // video only
  audioOnlyMp4: string;
  /** Stored landscape, display-rotated 90°. null when this FFmpeg cannot write a display matrix. */
  rotated: string | null;
  png: string;
  jpg: string;
  wav: string; // mono
  mp3: string; // stereo
  corrupt: string;
  hostileName: string;
  symlink: string;
  avi: string;
}

let cached: Fixtures | undefined;

/** Generated once per test process; removed at exit. */
export function fixtures(): Fixtures {
  if (cached) return cached;
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "reelforge-media-")));
  process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
  const p = (n: string) => join(dir, n);
  const tone = (ch: string) => ["-f", "lavfi", "-i", `sine=frequency=440:duration=2:sample_rate=48000,aformat=channel_layouts=${ch}`];

  ff(["-f", "lavfi", "-i", "testsrc2=size=216x384:rate=30:duration=2", ...tone("stereo"), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", p("portrait.mp4")]);
  ff(["-f", "lavfi", "-i", "testsrc2=size=320x180:rate=25:duration=2", ...tone("stereo"), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", p("landscape.mov")]);
  ff(["-f", "lavfi", "-i", "testsrc2=size=160x90:rate=30:duration=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", p("silent.mp4")]);
  ff([...tone("stereo"), "-c:a", "aac", p("audio-only.mp4")]);
  let rotated: string | null = p("rotated.mp4");
  try {
    ff(["-display_rotation", "90", "-i", p("landscape.mov"), "-c", "copy", rotated]); // FFmpeg ≥ 7
  } catch {
    try {
      ff(["-i", p("landscape.mov"), "-c", "copy", "-metadata:s:v:0", "rotate=90", rotated]); // older FFmpeg
    } catch {
      /* checked below */
    }
  }
  try {
    const probe = execFileSync("ffprobe", ["-v", "error", "-show_streams", "-print_format", "json", rotated]).toString();
    if (!/"rotat(ion|e)"/.test(probe)) rotated = null;
  } catch {
    rotated = null;
  }
  ff(["-f", "lavfi", "-i", "testsrc2=size=300x200", "-frames:v", "1", p("still.png")]);
  ff(["-f", "lavfi", "-i", "testsrc2=size=300x200", "-frames:v", "1", p("photo.jpg")]);
  ff([...tone("mono"), p("tone.wav")]);
  ff([...tone("stereo"), "-c:a", "libmp3lame", p("tone.mp3")]);
  writeFileSync(p("corrupt.mp4"), Buffer.from("this is not an mp4 at all".repeat(40)));
  const hostile = p(`a b'c"; touch PWNED $(touch PWNED2) concat:x.mp4`);
  copyFileSync(p("portrait.mp4"), hostile);
  symlinkSync(p("portrait.mp4"), p("link.mp4"));
  writeFileSync(p("movie.avi"), "x");

  cached = {
    dir,
    portrait: p("portrait.mp4"),
    landscape: p("landscape.mov"),
    silent: p("silent.mp4"),
    audioOnlyMp4: p("audio-only.mp4"),
    rotated,
    png: p("still.png"),
    jpg: p("photo.jpg"),
    wav: p("tone.wav"),
    mp3: p("tone.mp3"),
    corrupt: p("corrupt.mp4"),
    hostileName: hostile,
    symlink: p("link.mp4"),
    avi: p("movie.avi"),
  };
  return cached;
}
