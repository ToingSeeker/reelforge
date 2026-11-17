import { useId } from "react";

/**
 * The kinetic editing mark: three film-strip modules (top, left, bottom) around an orange play core,
 * reading as an abstract R and a play arrow. State comes from the agent lifecycle (see activity.ts);
 * motion is CSS transform/opacity only, in app.css under "Logo".
 */
export type LogoState = "idle" | "analyze" | "edit" | "render" | "success" | "error";

interface Props {
  state?: LogoState;
  /** Height of the mark in px. */
  size?: number;
  wordmark?: boolean;
  /** "mono" draws everything in currentColor (one-colour print, embossing, menus). */
  tone?: "color" | "mono";
  /** Film perforations; dropped automatically below 28px where they turn into noise. */
  detail?: "auto" | "full" | "simple";
  className?: string;
  /** Accessible name; omit when a visible label already names the product. */
  title?: string;
}

/** Rounded rectangle as a path, so a module and its perforations can share one evenodd fill. */
function rr(x: number, y: number, w: number, h: number, r: number): string {
  r = Math.min(r, w / 2, h / 2);
  return `M${x + r} ${y}H${x + w - r}A${r} ${r} 0 0 1 ${x + w} ${y + r}V${y + h - r}A${r} ${r} 0 0 1 ${x + w - r} ${y + h}H${x + r}A${r} ${r} 0 0 1 ${x} ${y + h - r}V${y + r}A${r} ${r} 0 0 1 ${x + r} ${y}Z`;
}

interface Module {
  id: "module-top" | "module-left" | "module-bottom";
  cx: number;
  cy: number;
  w: number;
  h: number;
  angle: number;
  holes: [number, number][]; // hole top-left corners, in the module's unrotated frame
}

const HW = 3.4; // perforation size
const HH = 3.2;
const T = 14; // module thickness
const R = 5.2; // corner radius: squarer than a pill, so the modules read as film

const MODULES: Module[] = [
  // Top stroke of the R, sloping down into the bowl.
  { id: "module-top", cx: 34, cy: 16.5, w: 43, h: T, angle: 21, holes: [18.5, 24.9, 31.3, 37.7, 44.1].map((x) => [x, 11.9]) },
  // The stem.
  { id: "module-left", cx: 11.8, cy: 40, w: T, h: 33, angle: 6, holes: [27.9, 34.9, 41.9, 48.9].map((y) => [7.2, y]) },
  // The leg, rising to the right.
  { id: "module-bottom", cx: 37.5, cy: 48.2, w: 37, h: T, angle: -27, holes: [29.2, 35.6, 42, 48.4].map((x) => [x, 49.6]) },
];

const CORE = "M24.6 24.2L42.6 34.2L24.6 44.2Z";

export function ReelForgeLogo({ state = "idle", size = 32, wordmark = false, tone = "color", detail = "auto", className, title }: Props) {
  const uid = useId().replace(/:/g, "");
  const full = detail === "full" || (detail === "auto" && size >= 28);
  const mono = tone === "mono";
  const mint = mono ? "currentColor" : `url(#${uid}-mint)`;
  const core = mono ? "currentColor" : "var(--accent-orange)";

  const mark = (
    <svg
      className={`rf-logo is-${state}${mono ? " is-mono" : ""}`}
      width={size}
      height={size}
      viewBox="0 0 64 64"
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      focusable="false"
    >
      {!mono && (
        <defs>
          <linearGradient id={`${uid}-mint`} x1="0" y1="0" x2="0.4" y2="1">
            <stop offset="0" stopColor="#c3ebda" />
            <stop offset="1" stopColor="#93cdb6" />
          </linearGradient>
          <linearGradient id={`${uid}-sheen`} x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stopColor="#fff" stopOpacity="0" />
            <stop offset="0.5" stopColor="#fff" stopOpacity="0.55" />
            <stop offset="1" stopColor="#fff" stopOpacity="0" />
          </linearGradient>
          <clipPath id={`${uid}-clip`}>
            {MODULES.map((m) => (
              <path key={m.id} d={rr(m.cx - m.w / 2, m.cy - m.h / 2, m.w, m.h, R)} transform={`rotate(${m.angle} ${m.cx} ${m.cy})`} />
            ))}
          </clipPath>
        </defs>
      )}
      <g className="rf-logo-modules">
        {MODULES.map((m) => (
          <g key={m.id} className={`rf-logo-module rf-${m.id}`} data-part={m.id}>
            <path
              d={rr(m.cx - m.w / 2, m.cy - m.h / 2, m.w, m.h, R) + (full ? m.holes.map(([x, y]) => rr(x, y, HW, HH, 0.9)).join("") : "")}
              transform={`rotate(${m.angle} ${m.cx} ${m.cy})`}
              fill={mint}
              fillRule="evenodd"
            />
          </g>
        ))}
      </g>
      {!mono && (
        <g clipPath={`url(#${uid}-clip)`} className="rf-logo-sheen-wrap" aria-hidden="true">
          <rect className="rf-logo-sheen" x="-24" y="0" width="20" height="64" fill={`url(#${uid}-sheen)`} transform="skewX(-18)" />
        </g>
      )}
      <path className="rf-logo-core" data-part="play-core" d={CORE} fill={core} stroke={core} strokeWidth="2.4" strokeLinejoin="round" />
      <circle className="rf-logo-flag" cx="56" cy="8" r="6" />
    </svg>
  );

  if (!wordmark) return className ? <span className={className}>{mark}</span> : mark;
  return (
    <span className={`rf-lockup${className ? ` ${className}` : ""}`} style={{ "--rf-lockup-size": `${size}px` } as React.CSSProperties}>
      {mark}
      <span className="rf-wordmark">ReelForge</span>
    </span>
  );
}
