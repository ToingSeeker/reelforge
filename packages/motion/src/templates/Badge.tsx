import { AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import type { BadgeProps } from "@reelforge/core/motion-catalog";
import { BODY, ensureFonts } from "../fonts.ts";
import { leave, pop, sec } from "./anim.ts";

export function Badge({ text, accent, color, corner }: BadgeProps) {
  ensureFonts();
  const frame = useCurrentFrame();
  const { width, height, fps, durationInFrames } = useVideoConfig();
  const unit = Math.min(width, height);
  const top = corner.startsWith("top");
  const left = corner.endsWith("left");
  const scale = pop(frame, fps) * leave(frame, durationInFrames, sec(fps, 0.3));
  // A soft ring that pulses outward once a second while the badge is up.
  const t = (frame % sec(fps, 1)) / sec(fps, 1);
  const ring = interpolate(t, [0, 1], [0, unit * 0.03]);
  const ringAlpha = interpolate(t, [0, 1], [0.55, 0]);
  const margin = unit * 0.06;
  return (
    <AbsoluteFill style={{ justifyContent: top ? "flex-start" : "flex-end", alignItems: left ? "flex-start" : "flex-end", padding: margin }}>
      <div
        style={{
          transform: `scale(${scale})`,
          transformOrigin: `${top ? "top" : "bottom"} ${left ? "left" : "right"}`,
          background: accent,
          color,
          fontFamily: BODY,
          fontWeight: 700,
          fontSize: unit * 0.042,
          lineHeight: 1,
          letterSpacing: unit * 0.002,
          textTransform: "uppercase",
          padding: `${unit * 0.018}px ${unit * 0.034}px`,
          borderRadius: unit * 0.05,
          boxShadow: `0 0 0 ${ring}px ${hexA(accent, ringAlpha)}, 0 ${unit * 0.008}px ${unit * 0.03}px rgba(0,0,0,0.35)`,
          whiteSpace: "nowrap",
        }}
      >
        {text}
      </div>
    </AbsoluteFill>
  );
}

function hexA(hex: string, a: number) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a.toFixed(3)})`;
}
