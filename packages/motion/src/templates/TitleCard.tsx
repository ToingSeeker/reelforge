import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import type { TitleCardProps } from "@reelforge/core/motion-catalog";
import { BODY, DISPLAY, ensureFonts } from "../fonts.ts";
import { enter, leave, sec } from "./anim.ts";

export function TitleCard({ title, subtitle, accent, color, align }: TitleCardProps) {
  ensureFonts();
  const frame = useCurrentFrame();
  const { width, height, fps, durationInFrames } = useVideoConfig();
  const unit = Math.min(width, height);
  const out = leave(frame, durationInFrames, sec(fps, 0.4));
  const bar = enter(frame, 0, sec(fps, 0.5));
  const head = enter(frame, sec(fps, 0.15), sec(fps, 0.6));
  const sub = enter(frame, sec(fps, 0.4), sec(fps, 0.6));
  const left = align === "left";
  return (
    <AbsoluteFill
      style={{
        justifyContent: "center",
        alignItems: left ? "flex-start" : "center",
        padding: `0 ${unit * 0.08}px`,
        opacity: out,
        transform: `translateY(${(1 - out) * unit * 0.04}px)`,
      }}
    >
      <div style={{ display: "flex", flexDirection: "column", alignItems: left ? "flex-start" : "center", gap: unit * 0.025, maxWidth: "100%" }}>
        <div style={{ width: unit * 0.14 * bar, height: unit * 0.012, background: accent, borderRadius: unit * 0.006 }} />
        <div style={{ overflow: "hidden", paddingBottom: unit * 0.01 }}>
          <div
            style={{
              fontFamily: DISPLAY,
              fontSize: unit * 0.13,
              lineHeight: 1.02,
              color,
              textTransform: "uppercase",
              textAlign: left ? "left" : "center",
              letterSpacing: unit * 0.001,
              textShadow: `0 ${unit * 0.006}px ${unit * 0.03}px rgba(0,0,0,0.45)`,
              transform: `translateY(${(1 - head) * 105}%)`,
              overflowWrap: "anywhere",
            }}
          >
            {title}
          </div>
        </div>
        {subtitle ? (
          <div
            style={{
              fontFamily: BODY,
              fontWeight: 600,
              fontSize: unit * 0.04,
              color,
              opacity: sub * 0.92,
              textAlign: left ? "left" : "center",
              textShadow: `0 ${unit * 0.004}px ${unit * 0.02}px rgba(0,0,0,0.5)`,
              transform: `translateY(${(1 - sub) * unit * 0.02}px)`,
              overflowWrap: "anywhere",
            }}
          >
            {subtitle}
          </div>
        ) : null}
      </div>
    </AbsoluteFill>
  );
}
