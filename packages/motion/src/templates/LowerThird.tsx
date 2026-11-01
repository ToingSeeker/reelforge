import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import type { LowerThirdProps } from "@reelforge/core/motion-catalog";
import { BODY, ensureFonts } from "../fonts.ts";
import { enter, leave, sec } from "./anim.ts";

export function LowerThird({ name, role, accent, color, panel, side }: LowerThirdProps) {
  ensureFonts();
  const frame = useCurrentFrame();
  const { width, height, fps, durationInFrames } = useVideoConfig();
  const unit = Math.min(width, height);
  const right = side === "right";
  const wipe = enter(frame, 0, sec(fps, 0.45));
  const reveal = enter(frame, sec(fps, 0.2), sec(fps, 0.55));
  const roleIn = enter(frame, sec(fps, 0.4), sec(fps, 0.5));
  const out = leave(frame, durationInFrames, sec(fps, 0.35));
  // Exit: the panel closes back into the accent stripe, then the stripe goes.
  const open = Math.min(reveal, out * 1.6);
  const stripe = Math.min(wipe, Math.min(1, out * 3));
  const clip = right ? `inset(0 0 0 ${(1 - open) * 100}%)` : `inset(0 ${(1 - open) * 100}% 0 0)`;
  return (
    <AbsoluteFill style={{ justifyContent: "flex-end", alignItems: right ? "flex-end" : "flex-start", padding: `0 ${unit * 0.06}px ${height * 0.12}px` }}>
      <div style={{ display: "flex", flexDirection: right ? "row-reverse" : "row", alignItems: "stretch", maxWidth: "88%" }}>
        <div style={{ width: unit * 0.014, background: accent, transform: `scaleY(${stripe})`, transformOrigin: "bottom" }} />
        <div
          style={{
            clipPath: clip,
            background: panel,
            padding: `${unit * 0.022}px ${unit * 0.035}px`,
            display: "flex",
            flexDirection: "column",
            alignItems: right ? "flex-end" : "flex-start",
            gap: unit * 0.006,
            minWidth: 0,
          }}
        >
          <div style={{ fontFamily: BODY, fontWeight: 700, fontSize: unit * 0.05, lineHeight: 1.1, color, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: "100%" }}>
            {name}
          </div>
          {role ? (
            <div
              style={{
                fontFamily: BODY,
                fontWeight: 600,
                fontSize: unit * 0.03,
                lineHeight: 1.15,
                color: accent,
                textTransform: "uppercase",
                letterSpacing: unit * 0.002,
                opacity: roleIn,
                transform: `translateY(${(1 - roleIn) * unit * 0.012}px)`,
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
                maxWidth: "100%",
              }}
            >
              {role}
            </div>
          ) : null}
        </div>
      </div>
    </AbsoluteFill>
  );
}
