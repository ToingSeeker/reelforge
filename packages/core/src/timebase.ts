// Timeline time is always an integer frame count in the project timebase.
// Frame rates are exact rationals (30000/1001, not 29.97) so conversions never
// drift. Rescaling between rates uses BigInt so long timelines stay exact.

export interface Rational {
  num: number;
  den: number;
}

export type Rounding = "nearest" | "floor" | "ceil";

function gcd(a: number, b: number): number {
  a = Math.abs(a);
  b = Math.abs(b);
  while (b !== 0) [a, b] = [b, a % b];
  return a;
}

export function rational(num: number, den = 1): Rational {
  if (!Number.isSafeInteger(num) || !Number.isSafeInteger(den)) {
    throw new RangeError(`rational parts must be integers, got ${num}/${den}`);
  }
  if (den <= 0 || num <= 0) {
    throw new RangeError(`frame rate must be positive, got ${num}/${den}`);
  }
  const g = gcd(num, den);
  return { num: num / g, den: den / g };
}

const NTSC_RATES: Record<string, Rational> = {
  "23.976": { num: 24000, den: 1001 },
  "29.97": { num: 30000, den: 1001 },
  "59.94": { num: 60000, den: 1001 },
};

/** Parse "30", "30000/1001" or the conventional NTSC decimals ("29.97"). */
export function parseFps(input: string): Rational {
  const s = input.trim();
  const ntsc = NTSC_RATES[s];
  if (ntsc) return ntsc;
  const frac = /^(\d+)\/(\d+)$/.exec(s);
  if (frac) return rational(Number(frac[1]), Number(frac[2]));
  if (/^\d+$/.test(s)) return rational(Number(s), 1);
  throw new RangeError(
    `unsupported frame rate "${input}" (use an integer, num/den, or 23.976/29.97/59.94)`,
  );
}

export function fpsToString(fps: Rational): string {
  return fps.den === 1 ? String(fps.num) : `${fps.num}/${fps.den}`;
}

export function fpsToNumber(fps: Rational): number {
  return fps.num / fps.den;
}

export function framesToSeconds(frames: number, fps: Rational): number {
  return (frames * fps.den) / fps.num;
}

function divRound(n: bigint, d: bigint, rounding: Rounding): bigint {
  // n and d are non-negative here; callers handle sign.
  const q = n / d;
  const r = n % d;
  if (r === 0n) return q;
  if (rounding === "floor") return q;
  if (rounding === "ceil") return q + 1n;
  return r * 2n >= d ? q + 1n : q;
}

function signedDivRound(n: bigint, d: bigint, rounding: Rounding): bigint {
  if (n >= 0n) return divRound(n, d, rounding);
  const flipped: Rounding =
    rounding === "floor" ? "ceil" : rounding === "ceil" ? "floor" : "nearest";
  return -divRound(-n, d, flipped);
}

/**
 * Convert seconds (e.g. a probed media duration) to frames. Seconds are a
 * float, so this is the one lossy edge; everything after it is integer.
 */
export function secondsToFrames(
  seconds: number,
  fps: Rational,
  rounding: Rounding = "nearest",
): number {
  // Scale to microseconds first so the float only contributes its own error.
  const micros = BigInt(Math.round(seconds * 1_000_000));
  const n = micros * BigInt(fps.num);
  const d = 1_000_000n * BigInt(fps.den);
  return Number(signedDivRound(n, d, rounding));
}

/** Re-express a frame count from one rate in another (e.g. source → project). */
export function rescaleFrames(
  frames: number,
  from: Rational,
  to: Rational,
  rounding: Rounding = "nearest",
): number {
  const n = BigInt(frames) * BigInt(to.num) * BigInt(from.den);
  const d = BigInt(from.num) * BigInt(to.den);
  return Number(signedDivRound(n, d, rounding));
}

/** Nominal (rounded-up) frames per second, used for frame-field display. */
export function nominalFps(fps: Rational): number {
  return Math.ceil(fps.num / fps.den);
}

/** Non-drop-frame SMPTE-style timecode: HH:MM:SS:FF. */
export function formatTimecode(frames: number, fps: Rational): string {
  const sign = frames < 0 ? "-" : "";
  let f = Math.abs(frames);
  const base = nominalFps(fps);
  const ff = f % base;
  f = (f - ff) / base;
  const ss = f % 60;
  f = (f - ss) / 60;
  const mm = f % 60;
  const hh = (f - mm) / 60;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${sign}${p(hh)}:${p(mm)}:${p(ss)}:${p(ff)}`;
}

/** Compact editor display: MM:SS.FF (the format in the preview transport). */
export function formatClock(frames: number, fps: Rational): string {
  const tc = formatTimecode(frames, fps);
  const sign = tc.startsWith("-") ? "-" : "";
  const [hh, mm, ss, ff] = tc.replace("-", "").split(":");
  const minutes = Number(hh) * 60 + Number(mm);
  return `${sign}${String(minutes).padStart(2, "0")}:${ss}.${ff}`;
}
