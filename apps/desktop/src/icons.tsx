// One stroke icon family (24px grid, 1.6 stroke, round caps, currentColor), so the shell has no icon dependency.
import type { SVGProps } from "react";

const PATHS = {
  // Tool rail
  media: "M3.5 7.5a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z",
  templates: "M12 3.5l8.5 4.5-8.5 4.5L3.5 8zM3.5 12l8.5 4.5 8.5-4.5M3.5 16l8.5 4.5 8.5-4.5",
  text: "M5 7V5h14v2M12 5v14M9 19h6",
  audio: "M9 18V5.5l11-2V16M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0zM20 16a3 3 0 1 1-6 0 3 3 0 0 1 6 0z",
  effects: "M4 20L14.5 9.5M13 6l1-2.5L15 6l2.5 1L15 8l-1 2.5L13 8l-2.5-1zM18.5 12.5l.6 1.4 1.4.6-1.4.6-.6 1.4-.6-1.4-1.4-.6 1.4-.6z",
  transitions: "M4 7.5h12.5l-3-3M20 16.5H7.5l3 3",
  color: "M12 3.5s6 6.2 6 10.5a6 6 0 0 1-12 0c0-4.3 6-10.5 6-10.5z",
  director: "M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9zM18.5 15.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z",
  settings:
    "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z",

  // Generic
  plus: "M12 5v14M5 12h14",
  minus: "M5 12h14",
  search: "M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-4-4",
  chevronDown: "M6 9l6 6 6-6",
  chevronUp: "M6 15l6-6 6 6",
  chevronRight: "M9 6l6 6-6 6",
  undo: "M9 14L4 9l5-5M4 9h11a5 5 0 0 1 0 10h-3",
  redo: "M15 14l5-5-5-5M20 9H9a5 5 0 0 0 0 10h3",
  export: "M7 17L17 7M8.5 7H17v8.5",
  upload: "M12 15V4M7.5 8.5L12 4l4.5 4.5M4.5 15v3.5a1.5 1.5 0 0 0 1.5 1.5h12a1.5 1.5 0 0 0 1.5-1.5V15",
  check: "M20 6L9 17l-5-5",
  copy: "M9 9.5a1.5 1.5 0 0 1 1.5-1.5h8a1.5 1.5 0 0 1 1.5 1.5v9a1.5 1.5 0 0 1-1.5 1.5h-8A1.5 1.5 0 0 1 9 18.5zM15 8V5.5A1.5 1.5 0 0 0 13.5 4h-8A1.5 1.5 0 0 0 4 5.5v9A1.5 1.5 0 0 0 5.5 16H9",
  checkCircle: "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0zM8 12.2l2.7 2.7L16 9.6",
  pencil: "M4 20h4L19 9l-4-4L4 16zM14 6l4 4",
  alert: "M12 9v4M12 17h.01M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z",
  info: "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0zM12 11v5M12 8h.01",
  x: "M18 6L6 18M6 6l12 12",
  more: "M5 12h.01M12 12h.01M19 12h.01",
  link: "M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1",
  refresh: "M20 11a8 8 0 0 0-14.6-4.5L4 8M4 4v4h4M4 13a8 8 0 0 0 14.6 4.5L20 16M20 20v-4h-4",
  reset: "M4 12a8 8 0 1 0 2.3-5.7L4 8.5M4 4v4.5h4.5",
  folder: "M3.5 7.5a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z",
  panelLeft: "M4 5h16v14H4zM9.5 5v14",
  panelRight: "M4 5h16v14H4zM14.5 5v14",
  stop: "M7 7h10v10H7z",

  // Media kinds
  film: "M4 5h16v14H4zM8 5v14M16 5v14M4 9h4M4 15h4M16 9h4M16 15h4",
  video: "M3.5 7h11v10h-11zM14.5 10.5l6-3.5v10l-6-3.5",
  image: "M4 5h16v14H4zM4 15.5l4.5-4.5 4 4 3-3 4.5 4.5M15 9.5a1.5 1.5 0 1 0 0-.01",
  layers: "M12 3.5l8.5 4.5-8.5 4.5L3.5 8zM3.5 12l8.5 4.5 8.5-4.5M3.5 16l8.5 4.5 8.5-4.5",
  captions: "M3.5 6h17v12h-17zM10.5 10.3a2 2 0 1 0 0 3.4M16.5 10.3a2 2 0 1 0 0 3.4",
  waveform: "M3 12h1.5M6.5 9v6M10 6v12M13.5 9v6M17 7.5v9M20.5 11v2",
  phone: "M8 3h8a1.5 1.5 0 0 1 1.5 1.5v15A1.5 1.5 0 0 1 16 21H8a1.5 1.5 0 0 1-1.5-1.5v-15A1.5 1.5 0 0 1 8 3zM11 18h2",
  monitor: "M3.5 5h17v11h-17zM9 20h6M12 16v4",
  square: "M5 5h14v14H5z",

  // Playback
  play: "M7 4.5l12 7.5-12 7.5z",
  pause: "M7 4.5h3.2v15H7zM13.8 4.5H17v15h-3.2z",
  skipBack: "M18 19l-9-7 9-7zM6 5v14",
  skipForward: "M6 5l9 7-9 7zM18 5v14",
  loop: "M17 3.5l3 3-3 3M4 11V9.5a3 3 0 0 1 3-3h13M7 20.5l-3-3 3-3M20 13v1.5a3 3 0 0 1-3 3H4",
  volume: "M11 5L6 9H3v6h3l5 4zM15.5 9a4.5 4.5 0 0 1 0 6M18.5 6a8.5 8.5 0 0 1 0 12",
  volumeOff: "M11 5L6 9H3v6h3l5 4zM22 9l-6 6M16 9l6 6",
  maximize: "M8 3.5H3.5V8M20.5 8V3.5H16M16 20.5h4.5V16M3.5 16v4.5H8",
  guides: "M4 8V4h4M16 4h4v4M20 16v4h-4M8 20H4v-4M9 9h6v6H9z",

  // Editing
  split: "M12 3v18M8 7l-3 5 3 5M16 7l3 5-3 5",
  cut: "M6 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM20 4L8.1 15.9M14.5 14.5L20 20M8.1 8.1L12 12",
  trash: "M4 7h16M10 11v6M14 11v6M5.5 7l1 13h11l1-13M9 7V4h6v3",
  ripple: "M4 6h7M4 12h16M4 18h10M15 4l3 2-3 2",
  magnet: "M6 3.5v7.5a6 6 0 0 0 12 0V3.5M6 3.5h4V11a2 2 0 0 0 4 0V3.5h4M6 7.5h4M14 7.5h4",
  beat: "M3 12h3l2-6 4 12 2.5-7 1.5 3H21",
  zoomIn: "M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-4-4M11 8v6M8 11h6",
  zoomOut: "M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-4-4M8 11h6",
  fit: "M3.5 8V5h3M17.5 5h3v3M20.5 16v3h-3M6.5 19h-3v-3M7.5 12h9M9.5 9.5L7 12l2.5 2.5M14.5 9.5L17 12l-2.5 2.5",
  eye: "M2.5 12s3.5-6.5 9.5-6.5 9.5 6.5 9.5 6.5-3.5 6.5-9.5 6.5S2.5 12 2.5 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
  eyeOff: "M3 3l18 18M10.6 5.6A9.6 9.6 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a16 16 0 0 1-3.1 3.9M6.6 6.6A16 16 0 0 0 2.5 12s3.5 6.5 9.5 6.5a9.4 9.4 0 0 0 4.4-1.1M9.9 9.9a3 3 0 0 0 4.2 4.2",
  lock: "M6 11h12v9.5H6zM8.5 11V7.5a3.5 3.5 0 0 1 7 0V11",
  unlock: "M6 11h12v9.5H6zM8.5 11V7.5a3.5 3.5 0 0 1 6.8-1.2",
  crop: "M6.5 2.5v14h14M2.5 6.5h14v14",
  motion: "M3.5 18.5c5 0 5-13 10-13 2.5 0 4 1.5 7 1.5M17.5 4l3 3-3 3",
  send: "M12 19V5M5 12l7-7 7 7",
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 18, ...rest }: { name: IconName; size?: number } & SVGProps<SVGSVGElement>) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
