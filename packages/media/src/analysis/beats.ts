// Beat tracking without dependencies: spectral-flux onsets, tempo from the
// onset autocorrelation with a log-normal prior around 120 BPM, then dynamic
// programming beat placement (Ellis 2007, as in librosa).

import { spawn } from "node:child_process";
import type { BeatsResult } from "@reelforge/core";
import { ffmpegBin, ffmpegReason } from "../ffmpeg.ts";
import { sourceInputArgs } from "../probe.ts";

export const BEATS_ENGINE = "reelforge-beats/1";
const SR = 22_050;
const N = 1024;
const HOP = 256;
const MAX_SECONDS = 20 * 60;

function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j]!, re[i]!];
      [im[i], im[j]] = [im[j]!, im[i]!];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const tr = re[b]! * cr - im[b]! * ci;
        const ti = re[b]! * ci + im[b]! * cr;
        re[b] = re[a]! - tr;
        im[b] = im[a]! - ti;
        re[a] = re[a]! + tr;
        im[a] = im[a]! + ti;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

/** Onset strength per hop: half-wave rectified change in log-magnitude spectrum. */
export function onsetEnvelope(samples: Float32Array): Float64Array {
  const frames = Math.max(0, Math.floor((samples.length - N) / HOP) + 1);
  const env = new Float64Array(frames);
  const win = new Float64Array(N).map((_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N));
  let prev = new Float64Array(N / 2);
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  for (let f = 0; f < frames; f++) {
    for (let i = 0; i < N; i++) {
      re[i] = samples[f * HOP + i]! * win[i]!;
      im[i] = 0;
    }
    fft(re, im);
    const mag = new Float64Array(N / 2);
    let flux = 0;
    for (let k = 0; k < N / 2; k++) {
      mag[k] = Math.log1p(100 * Math.hypot(re[k]!, im[k]!));
      flux += Math.max(0, mag[k]! - prev[k]!);
    }
    env[f] = f === 0 ? 0 : flux;
    prev = mag;
  }
  // Remove the slow trend (~0.5 s) and normalise.
  const w = Math.round((0.5 * SR) / HOP);
  const out = new Float64Array(frames);
  let sum = 0;
  for (let i = 0; i < frames; i++) {
    sum += env[i]!;
    if (i >= w) sum -= env[i - w]!;
    out[i] = Math.max(0, env[i]! - sum / Math.min(i + 1, w));
  }
  const sd = Math.sqrt(out.reduce((s, x) => s + x * x, 0) / Math.max(1, frames)) || 1;
  return out.map((x) => x / sd);
}

export function estimateTempo(env: Float64Array): { period: number; bpm: number; confidence: number } {
  const fpsEnv = SR / HOP;
  const minLag = Math.floor((60 / 200) * fpsEnv);
  const maxLag = Math.ceil((60 / 55) * fpsEnv);
  // Autocorrelate the mean-removed envelope: otherwise its DC level makes any
  // signal (noise included) look periodic and inflates the confidence.
  const mean = env.reduce((s, x) => s + x, 0) / Math.max(1, env.length);
  const c = env.map((x) => x - mean);
  const acf = (lag: number) => {
    let s = 0;
    for (let i = lag; i < c.length; i++) s += c[i]! * c[i - lag]!;
    return s / (c.length - lag);
  };
  const zero = acf(0) || 1;
  let best = minLag;
  let bestScore = -Infinity;
  const scores: number[] = [];
  for (let lag = minLag; lag <= maxLag && lag < env.length; lag++) {
    const bpm = (60 * fpsEnv) / lag;
    const prior = Math.exp(-0.5 * (Math.log2(bpm / 120) / 1.0) ** 2);
    const s = acf(lag) * prior;
    scores[lag] = s;
    if (s > bestScore) {
      bestScore = s;
      best = lag;
    }
  }
  // Parabolic refinement of the peak.
  const left = scores[best - 1] ?? bestScore;
  const right = scores[best + 1] ?? bestScore;
  const denom = left - 2 * bestScore + right;
  const period = denom ? best + (0.5 * (left - right)) / denom : best;
  return { period, bpm: Math.round(((60 * fpsEnv) / period) * 10) / 10, confidence: Math.max(0, Math.min(1, acf(best) / zero)) };
}

export function trackBeats(env: Float64Array, period: number, tightness = 100): number[] {
  const n = env.length;
  if (!n) return [];
  const score = new Float64Array(n);
  const back = new Int32Array(n).fill(-1);
  for (let t = 0; t < n; t++) {
    let bestPrev = -1;
    let bestVal = -Infinity;
    const lo = Math.max(0, Math.floor(t - 2 * period));
    const hi = Math.floor(t - period / 2);
    for (let p = lo; p <= hi; p++) {
      const v = score[p]! - tightness * Math.log((t - p) / period) ** 2;
      if (v > bestVal) {
        bestVal = v;
        bestPrev = p;
      }
    }
    score[t] = env[t]! + (bestPrev >= 0 ? bestVal : 0);
    back[t] = bestPrev;
  }
  // Start from the best-scoring frame within the last period.
  let t = n - 1;
  for (let i = Math.max(0, Math.floor(n - period)); i < n; i++) if (score[i]! > score[t]!) t = i;
  const beats: number[] = [];
  while (t >= 0) {
    beats.push(t);
    t = back[t]!;
  }
  beats.reverse();
  // Trim weak beats at the edges (silence before/after the music).
  const strong = 0.2 * (env.reduce((s, x) => s + x, 0) / n);
  while (beats.length && env[beats[0]!]! < strong) beats.shift();
  while (beats.length && env[beats[beats.length - 1]!]! < strong) beats.pop();
  return beats;
}

export function beatsFromSamples(samples: Float32Array): BeatsResult {
  const env = onsetEnvelope(samples);
  if (env.length < 8 || env.every((x) => x === 0)) return { bpm: 0, confidence: 0, beatsUs: [] };
  const { period, bpm, confidence } = estimateTempo(env);
  // The onset frame is centred N/2 samples into the window.
  const frameUs = (f: number) => Math.round(((f * HOP + N / 2) / SR) * 1_000_000);
  return { bpm, confidence: Math.round(confidence * 1000) / 1000, beatsUs: trackBeats(env, period).map(frameUs) };
}

export async function detectBeats(path: string): Promise<BeatsResult> {
  let stdout: Buffer;
  try {
    stdout = await decodePcm(path);
  } catch (e) {
    throw new Error(`beat detection failed: ${ffmpegReason(e, path)}`);
  }
  const samples = new Float32Array(stdout.buffer, stdout.byteOffset, Math.floor(stdout.byteLength / 4));
  return beatsFromSamples(samples);
}

/** Mono float PCM at 22.05 kHz (first 20 minutes). */
function decodePcm(path: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegBin(), ["-hide_banner", "-nostdin", "-loglevel", "error", ...sourceInputArgs(path), "-vn", "-t", String(MAX_SECONDS), "-ac", "1", "-ar", String(SR), "-f", "f32le", "-"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    let err = "";
    child.stdout.on("data", (c: Buffer) => chunks.push(c));
    child.stderr.on("data", (c: Buffer) => (err += c.toString()));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(Buffer.concat(chunks)) : reject(Object.assign(new Error(`ffmpeg exit ${code}`), { stderr: err }))));
  });
}
