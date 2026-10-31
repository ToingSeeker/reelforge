// Compile a RenderPlan into one FFmpeg invocation. Every time value is derived
// from integer frames (video) or integer samples (audio), so the output has
// exactly plan.totalFrames frames and segment boundaries land on frame edges.

import { blurSigma, colorMatrix, grainNoise, sharpenAmount, vignetteAngle, type ClipProps, type RenderPlan, type RenderSettings } from "@reelforge/core";
import { sourceInputArgs } from "./probe.ts";

export const AUDIO_RATE = 48_000;

/** Container/stream colour tags matching the BT.709 limited-range conversion we perform. */
export const BT709_TAGS = ["-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv"];

/** Exact frame → seconds as a decimal string FFmpeg accepts. */
export function frameSeconds(frames: number, fps: { num: number; den: number }): string {
  return ((frames * fps.den) / fps.num).toFixed(6);
}

function frameSamples(frames: number, fps: { num: number; den: number }): number {
  return Math.round((frames * fps.den * AUDIO_RATE) / fps.num);
}

export interface CompileOptions {
  plan: RenderPlan;
  settings: RenderSettings;
  /** Path to read for each asset (original or proxy). */
  inputs: Record<string, string>;
  output: string;
  /** Pre-rendered caption tracks (PNG sequences we generated), composited on top. */
  overlays?: { pattern: string; startFrame: number; frames: number; y: number }[];
}

export function compileRender({ plan, settings, inputs, output, overlays = [] }: CompileOptions): string[] {
  const fps = `${plan.fps.num}/${plan.fps.den}`;
  const W = settings.width;
  const H = settings.height;
  const sec = (f: number) => frameSeconds(f, plan.fps);
  const args: string[] = ["-hide_banner", "-nostdin", "-loglevel", "error"];
  const filters: string[] = [];
  let n = 0;
  const input = (assetId: string, opts: string[]) => {
    const path = inputs[assetId];
    if (!path) throw new Error(`no input path for asset ${assetId}`);
    args.push(...sourceInputArgs(path, opts));
    return n++;
  };

  // Composite in RGB: each source is converted with its own colour matrix (scale reads the tags),
  // and the result is encoded once as BT.709 and tagged so, which is what browsers and players assume
  // for HD. Untagged BT.601 output shifts reds and greens in every player.
  filters.push(`color=c=black:s=${W}x${H}:r=${fps}:d=${sec(plan.totalFrames + 1)},format=rgba,setsar=1,settb=${plan.fps.den}/${plan.fps.num}[base]`);
  let composite = "base";
  let v = 0;
  for (const layer of plan.layers) {
    for (const seg of layer) {
      const p = seg.props;
      const still = plan.sources[seg.assetId]?.kind === "image";
      const len = seg.renderEnd - seg.renderStart;
      const i = input(seg.assetId, still ? [] : ["-ss", sec(seg.renderSourceIn), "-t", sec(len + 1)]);
      const f: string[] = [];
      if (p.cropLeft || p.cropTop || p.cropRight || p.cropBottom) {
        f.push(`crop=w=iw*${1 - p.cropLeft - p.cropRight}:h=ih*${1 - p.cropTop - p.cropBottom}:x=iw*${p.cropLeft}:y=ih*${p.cropTop}`);
      }
      f.push(
        p.fit === "cover"
          ? `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H}`
          : `scale=${W}:${H}:force_original_aspect_ratio=decrease`,
      );
      f.push("setsar=1", `fps=${fps}`, "format=rgba");
      // Exactly `len` frames (clip + dissolve handles), padding with the last frame if the source runs short.
      f.push(`tpad=stop_mode=clone:stop_duration=${still ? sec(len) : "0.5"}`, `trim=end_frame=${len}`);
      // After tpad/trim so a still gets fresh grain every frame.
      f.push(...effectFilters(p, W));
      const animated = p.scaleEnd !== null && p.scaleEnd !== p.scale;
      if (animated) {
        // n counts frames from renderStart; the zoom runs across the clip itself (same as scaleAt()).
        const off = seg.renderStart - seg.start;
        const span = Math.max(1, seg.duration - 1);
        f.push(`scale=w='max(2,trunc(iw*(${p.scale}+(${p.scaleEnd! - p.scale})*clip((n+${off})/${span},0,1))/2)*2)':h=-2:eval=frame`);
      } else if (p.scale !== 1) {
        f.push(`scale=w='max(2,trunc(iw*${p.scale}/2)*2)':h=-2`);
      }
      if (p.rotation) {
        const a = `${p.rotation}*PI/180`;
        f.push(`rotate=a=${a}:c=none:ow=rotw(${a}):oh=roth(${a})`);
      }
      if (p.opacity < 1) f.push(`colorchannelmixer=aa=${p.opacity}`);
      // Frame-based alpha ramps; these are the formulas pictureAlpha() mirrors for the live preview.
      if (seg.inH > 0) f.push(`fade=t=in:s=0:n=${2 * seg.inH}:alpha=1`);
      if (p.fadeIn > 0) f.push(`fade=t=in:s=${seg.start - seg.renderStart}:n=${p.fadeIn}:alpha=1`);
      if (p.fadeOut > 0) f.push(`fade=t=out:s=${seg.start + seg.duration - p.fadeOut - seg.renderStart}:n=${p.fadeOut}:alpha=1`);
      // One tick = one project frame, so the offset is an exact integer. Seconds would be
      // rounded (1/30 s × 30 = 0.99999 → frame 0) and land cuts a frame early.
      f.push(`settb=${plan.fps.den}/${plan.fps.num}`, `setpts=PTS-STARTPTS+${seg.renderStart}`);
      filters.push(`[${i}:v]${f.join(",")}[v${v}]`);
      // Overlay's n counts output frames from 0 (the base starts at frame 0): the pan runs like positionAt().
      const span = Math.max(1, seg.duration - 1);
      const along = (from: number, to: number | null) => (to === null || to === from ? `${from}` : `(${from}+(${to - from})*clip((n-${seg.start})/${span},0,1))`);
      const panned = (p.xEnd !== null && p.xEnd !== p.x) || (p.yEnd !== null && p.yEnd !== p.y);
      const x = `(main_w-overlay_w)/2+${along(p.x, p.xEnd)}*main_w`;
      const y = `(main_h-overlay_h)/2+${along(p.y, p.yEnd)}*main_h`;
      filters.push(`[${composite}][v${v}]overlay=x='${x}':y='${y}':eval=${animated || panned || p.rotation ? "frame" : "init"}:eof_action=pass:repeatlast=0:format=rgb[c${v}]`);
      composite = `c${v}`;
      v++;
    }
  }
  overlays.forEach((o, k) => {
    // Our own temp-dir PNG sequence: image2 is safe here (no user-controlled names), one file per frame.
    args.push("-protocol_whitelist", "file", "-framerate", fps, "-start_number", "0", "-f", "image2", "-i", `file:${o.pattern}`);
    const i = n++;
    filters.push(`[${i}:v]format=rgba,trim=end_frame=${o.frames},settb=${plan.fps.den}/${plan.fps.num},setpts=PTS-STARTPTS+${o.startFrame}[cap${k}]`);
    filters.push(`[${composite}][cap${k}]overlay=x=0:y=${o.y}:eof_action=pass:repeatlast=0:format=rgb[cc${k}]`);
    composite = `cc${k}`;
  });
  filters.push(
    `[${composite}]scale=out_color_matrix=bt709:out_range=tv,format=yuv420p,` +
      // Frame colour properties win over encoder flags in current FFmpeg, so set all four here.
      `setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv[vout]`,
  );

  const total = frameSamples(plan.totalFrames, plan.fps);
  const smp = (frames: number) => frameSamples(frames, plan.fps);
  const mix: string[] = [];
  plan.audio.forEach((seg, k) => {
    const p = seg.props;
    const len = seg.renderEnd - seg.renderStart;
    const end = seg.start + seg.duration;
    const i = input(seg.assetId, ["-ss", sec(seg.renderSourceIn), "-t", sec(len + 1)]);
    const f = [
      `aresample=${AUDIO_RATE}`,
      "aformat=sample_fmts=fltp:channel_layouts=stereo",
      "apad",
      `atrim=end_sample=${smp(len)}`,
      "asetpts=PTS-STARTPTS",
    ];
    if (p.gainDb !== 0) f.push(`volume=${p.gainDb}dB`);
    // Sample-exact linear ramps; audioGain() is the same function for the live preview.
    if (seg.inH > 0) f.push(`afade=t=in:ss=0:ns=${smp(2 * seg.inH)}`);
    if (seg.outH > 0) f.push(`afade=t=out:ss=${smp(end - seg.outH - seg.renderStart)}:ns=${smp(2 * seg.outH)}`);
    if (p.fadeIn > 0) f.push(`afade=t=in:ss=${smp(seg.start - seg.renderStart)}:ns=${smp(p.fadeIn)}`);
    if (p.fadeOut > 0) f.push(`afade=t=out:ss=${smp(end - p.fadeOut - seg.renderStart)}:ns=${smp(p.fadeOut)}`);
    f.push(`adelay=delays=${smp(seg.renderStart)}S:all=1`);
    filters.push(`[${i}:a]${f.join(",")}[a${k}]`);
    mix.push(`[a${k}]`);
  });
  if (mix.length) {
    // Sum without normalising (levels stay as edited), then a -1 dBFS limiter as clipping protection.
    filters.push(
      `${mix.join("")}amix=inputs=${mix.length}:duration=longest:normalize=0,alimiter=limit=0.891:level=false:latency=true,` +
        `apad,atrim=end_sample=${total}[aout]`,
    );
  } else {
    filters.push(`anullsrc=r=${AUDIO_RATE}:cl=stereo,atrim=end_sample=${total}[aout]`);
  }

  args.push(
    "-filter_complex",
    filters.join(";"),
    "-map",
    "[vout]",
    "-map",
    "[aout]",
    "-c:v",
    "libx264",
    "-preset",
    settings.preset,
    "-crf",
    String(settings.crf),
    "-pix_fmt",
    "yuv420p",
    ...BT709_TAGS,
    "-profile:v",
    "high",
    "-r",
    fps,
    "-fps_mode",
    "cfr",
    "-frames:v",
    String(plan.totalFrames),
    "-c:a",
    "aac",
    "-b:a",
    `${settings.audioBitrateK}k`,
    "-ar",
    String(AUDIO_RATE),
    "-movflags",
    "+faststart",
    "-f",
    "mp4",
    "-progress",
    "pipe:1",
    "-nostats",
    "-y",
    output,
  );
  return args;
}

/**
 * The clip's picture effects as filters on the fitted RGBA picture, in the order the preview shader
 * applies them: colour, blur, sharpen, vignette, grain. W is the output frame width in pixels.
 */
export function effectFilters(p: ClipProps, W: number): string[] {
  const f: string[] = [];
  const m = colorMatrix(p);
  if (m) {
    const ch = ["r", "g", "b"];
    f.push(`colorchannelmixer=${m.map((x, i) => `${ch[Math.floor(i / 3)]}${ch[i % 3]}=${x}`).join(":")}`);
  }
  const sigma = blurSigma(p, W);
  // Alpha stays as is: blurring it would fade the picture's own edges.
  if (sigma >= 0.1) f.push(`gblur=sigma=${sigma.toFixed(3)}:steps=6:planes=7`);
  const a = Math.round(sharpenAmount(p) * 100);
  if (a > 0) {
    const k = `0 -${a} 0 -${a} ${100 + 4 * a} -${a} 0 -${a} 0`;
    f.push("format=gbrap", `convolution=${[0, 1, 2].map((i) => `${i}m='${k}':${i}rdiv=0.01`).join(":")}`, "format=rgba");
  }
  const angle = vignetteAngle(p);
  if (angle > 0) f.push("format=gbrap", `vignette=angle=${angle}:dither=0`, "format=rgba");
  const g = grainNoise(p);
  if (g.strength > 0) f.push("format=yuva444p", `noise=c0s=${g.strength}:c0f=t+u`, "format=rgba");
  return f;
}

/** Export defaults (PRD §13): H.264 / AAC MP4 at the project size and rate. */
export function exportSettings(plan: Pick<RenderPlan, "width" | "height">): RenderSettings {
  return { width: plan.width, height: plan.height, useProxies: false, crf: 18, preset: "medium", audioBitrateK: 192 };
}

/** Previews: same graph, at most 960 px tall, proxies, fast encode. */
export function previewSettings(plan: Pick<RenderPlan, "width" | "height">): RenderSettings {
  const scale = Math.min(1, 960 / Math.max(plan.width, plan.height));
  const even = (x: number) => Math.max(2, Math.round((x * scale) / 2) * 2);
  return { width: even(plan.width), height: even(plan.height), useProxies: true, crf: 28, preset: "veryfast", audioBitrateK: 96 };
}
