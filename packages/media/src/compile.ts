// Compile a RenderPlan into one FFmpeg invocation. Every time value is derived
// from integer frames (video) or integer samples (audio), so the output has
// exactly plan.totalFrames frames and segment boundaries land on frame edges.

import type { RenderPlan, RenderSettings } from "@reelforge/core";
import { sourceInputArgs } from "./probe.ts";

export const AUDIO_RATE = 48_000;

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
}

export function compileRender({ plan, settings, inputs, output }: CompileOptions): string[] {
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

  filters.push(`color=c=black:s=${W}x${H}:r=${fps}:d=${sec(plan.totalFrames + 1)},format=yuv420p,setsar=1,settb=${plan.fps.den}/${plan.fps.num}[base]`);
  let composite = "base";
  let v = 0;
  for (const layer of plan.layers) {
    for (const seg of layer) {
      const still = plan.sources[seg.assetId]?.kind === "image";
      const i = input(seg.assetId, still ? [] : ["-ss", sec(seg.sourceIn), "-t", sec(seg.duration + 1)]);
      // Fill the frame (crop to cover), conform to the project rate, take exactly `duration` frames,
      // then shift to the clip's timeline position.
      filters.push(
        `[${i}:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1,fps=${fps},format=yuva420p,` +
          `tpad=stop_mode=clone:stop_duration=${still ? sec(seg.duration) : "0.5"},trim=end_frame=${seg.duration},` +
          // One tick = one project frame, so the offset is an exact integer. Seconds would be
          // rounded (1/30 s × 30 = 0.99999 → frame 0) and land cuts a frame early.
          `settb=${plan.fps.den}/${plan.fps.num},setpts=PTS-STARTPTS+${seg.start}[v${v}]`,
      );
      filters.push(`[${composite}][v${v}]overlay=eof_action=pass:repeatlast=0:format=auto[c${v}]`);
      composite = `c${v}`;
      v++;
    }
  }
  filters.push(`[${composite}]format=yuv420p[vout]`);

  const total = frameSamples(plan.totalFrames, plan.fps);
  const mix: string[] = [];
  plan.audio.forEach((seg, k) => {
    const i = input(seg.assetId, ["-ss", sec(seg.sourceIn), "-t", sec(seg.duration + 1)]);
    filters.push(
      `[${i}:a]aresample=${AUDIO_RATE},aformat=sample_fmts=fltp:channel_layouts=stereo,apad,` +
        `atrim=end_sample=${frameSamples(seg.duration, plan.fps)},asetpts=PTS-STARTPTS,adelay=delays=${frameSamples(seg.start, plan.fps)}S:all=1[a${k}]`,
    );
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
