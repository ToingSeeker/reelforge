// The AI effects engine's catalogue (packages/fx-engine/fx.py, "claude-video-effects" by Vibha
// Ramprakash, MIT). Face-tracked motion graphics baked into the picture: they need the speaker's
// face and body, so they suit talking-head clips. A test keeps this list in step with fx.py.

export interface FxInfo {
  fx: string;
  label: string;
  /** What it does, for people and for the AI Director. */
  about: string;
  /** Its options as the engine documents them ("text (lines joined with |)", …). */
  options: string;
  /** Option keys the engine reads. */
  keys: string[];
  /** Takes pictures (`images`): project media, or frames of the clip itself when none are given. */
  images: boolean;
  /** Moves or regrades the whole frame rather than adding graphics. */
  camera: boolean;
}

export const FX_CATALOG: readonly FxInfo[] = [
  { fx: "noise", label: "Noise", about: "Reels pile up behind your head, one every quarter second", options: "`images` (folder of screenshots or clips), `size`", keys: ["images", "size"], images: true, camera: false },
  { fx: "lineup", label: "Lineup", about: "Numbered tiles fan out in an arc above your head", options: "`text` (tile names joined with `|`)", keys: ["text"], images: false, camera: false },
  { fx: "locked-on", label: "Locked on", about: "Corner brackets snap onto your face, the camera follows you", options: "`zoom` (default 1.35), `text` (tag)", keys: ["text", "zoom"], images: false, camera: true },
  { fx: "orbit", label: "Orbit", about: "Your reels circle your head: in front at the bottom, behind at the top", options: "`images`, `count`, `speed`, `size`", keys: ["count", "images", "size", "speed"], images: true, camera: false },
  { fx: "lean-in", label: "Lean in", about: "A fast punch-in on one word", options: "`zoom` (default 1.45, max 2), `speed`", keys: ["speed", "zoom"], images: false, camera: true },
  { fx: "backdrop-word", label: "Backdrop word", about: "A giant word drops in behind you", options: "`text`, `color` (hex), `font` (`bold` or `serif`)", keys: ["color", "font", "text"], images: false, camera: false },
  { fx: "spotlight", label: "Spotlight", about: "Kills the lights, keeps you lit", options: "`text` (glowing word behind you), `color`, `push`", keys: ["color", "push", "text"], images: false, camera: true },
  { fx: "the-bill", label: "The bill", about: "Prints your instructions like a receipt into the wall above your head", options: "`text` (lines joined with `|`)", keys: ["text"], images: false, camera: false },
  { fx: "moody", label: "Moody", about: "A moody colour grade", options: "`grade` (`moody`, `bw`, `warm`, `cool`, `pop`)", keys: ["grade"], images: false, camera: true },
  { fx: "swipe", label: "Swipe", about: "A before and after slider sweeps across you", options: "`grade` (the \"after\" look)", keys: ["grade"], images: false, camera: true },
  { fx: "todo", label: "To-do", about: "A checklist card beside your head ticks off as you talk", options: "`text` (items with `|`), `ticks` (video seconds with `|`), `title`", keys: ["text", "ticks", "title"], images: false, camera: false },
  { fx: "comment-box", label: "Comment box", about: "An Instagram comment bar types a word and posts it", options: "`text` (default EFFECTS)", keys: ["text"], images: false, camera: false },
  { fx: "tap", label: "Tap", about: "A Follow button pops up and flips to Following", options: "`at` (video second of the flip), `x`, `y` (0 to 1), `color`", keys: ["at", "color", "x", "y"], images: false, camera: false },
  { fx: "pause-point", label: "Pause point", about: "Freezes the frame and points at you with a hand-drawn arrow", options: "`text` (label), `color`, `label_x`", keys: ["color", "label_x", "text"], images: false, camera: true },
  { fx: "uninstall", label: "Uninstall", about: "A glitchy uninstall bar breaks the frame apart", options: "`text`", keys: ["text"], images: false, camera: true },
  { fx: "reel-frame", label: "Reel frame", about: "Your video shrinks into an Instagram reel card", options: "`text` (handle)", keys: ["text"], images: false, camera: true },
  { fx: "shortcut-rain", label: "Shortcut rain", about: "Keyboard keys rain down behind you", options: "`text` (keys with `|`), `count`", keys: ["count", "text"], images: false, camera: false },
  { fx: "reject-stamp", label: "Reject stamp", about: "A big red stamp slams onto the screen", options: "`text`, `color`, `angle`, `y`", keys: ["angle", "color", "text", "y"], images: false, camera: false },
  { fx: "countdown-flip", label: "Countdown flip", about: "A 3, 2, 1 flip clock above your head", options: "`from`", keys: ["from"], images: false, camera: false },
  { fx: "rabbit-hole", label: "Rabbit hole", about: "The frame tunnels into itself, spinning", options: "`ratio`, `speed`, `spin`", keys: ["ratio", "speed", "spin"], images: false, camera: true },
  { fx: "cover-star", label: "Cover star", about: "You become a magazine cover, title behind your head", options: "`text` (title), `lines` (with `|`), `issue`, `color`", keys: ["color", "issue", "lines", "text"], images: false, camera: false },
  { fx: "scribble", label: "Scribble", about: "Marker doodles draw themselves around you", options: "`text` (label), `color`", keys: ["color", "text"], images: false, camera: false },
  { fx: "glass-widgets", label: "Glass widgets", about: "Frosted glass widgets and mini artifacts float around your head, plus an Edited by Claude pill", options: "`text` (big number), `name`, `handle`, `look` (`simple` for the 3-widget version)", keys: ["handle", "look", "name", "text"], images: false, camera: false },
  { fx: "red-collage", label: "Red collage", about: "Black and white you, a giant red word behind, three lines slam in", options: "`text` (red word), `lines` (with `|`), `tag`", keys: ["lines", "tag", "text"], images: false, camera: false },
  { fx: "split-headline", label: "Split headline", about: "A headline card slides down and pushes you to the bottom half", options: "`text` (lines with `|`), `hl` (highlighted word), `pill`", keys: ["hl", "pill", "text"], images: false, camera: false },
  { fx: "pastel-word", label: "Pastel word", about: "Lavender room, giant word behind you, a profile card gets followed", options: "`text`, `name`, `handle`", keys: ["handle", "name", "text"], images: false, camera: false },
  { fx: "check-pills", label: "Check pills", about: "Grid-paper room, reel boards behind you, a cursor clicks blue pills", options: "`text` (pills with `|`), `images`", keys: ["images", "text"], images: true, camera: false },
  { fx: "timeline", label: "Timeline", about: "A dark red film grade with an editing timeline, a REC timecode and a glowing playhead", options: "`text` (title), `sub`, `tc`", keys: ["sub", "tc", "text"], images: true, camera: true },
  { fx: "headline-box", label: "Headline box", about: "A punch-in with a two-line headline, the second line in a white box", options: "`text` (lines with `|`), `zoom`", keys: ["text", "zoom"], images: false, camera: false },
  { fx: "profile-wall", label: "Profile wall", about: "Your reels grid fills the wall behind you while a counter ticks up", options: "`images`, `count`, `label`", keys: ["count", "images", "label"], images: true, camera: false },
  { fx: "tier-list", label: "Tier list", about: "A tier list drops in and Claude flies into S tier", options: "`title`, `item`, `others`", keys: ["item", "others", "title"], images: false, camera: false },
  { fx: "broll-split", label: "B-roll split", about: "B-roll on top with a price-tag sticker, you below", options: "`images`, `text` (tag)", keys: ["images", "text"], images: true, camera: false },
  { fx: "phone-fan", label: "Phone fan", about: "Your reels fan out like a hand of phones under a headline", options: "`images`, `text` (lines with `|`)", keys: ["images", "text"], images: true, camera: false },
  { fx: "dot-reveal", label: "Dot reveal", about: "Your shot builds out of glowing dots, then snaps to the full picture", options: "`color`, `cell`", keys: ["cell", "color"], images: false, camera: true },
  { fx: "headline-wall", label: "Headline wall", about: "Your own headlines pile up behind your head, then a total pops in front", options: "`text` (`headline::meta|...`), `total`, `label`", keys: ["label", "text", "total"], images: false, camera: false },
  { fx: "checklist", label: "Checklist", about: "A Claude task list under your chin: each step spins, then ticks green", options: "`text` (`step::meta|...`), `title`", keys: ["text", "title"], images: false, camera: false },
  { fx: "liquid-glass-graph", label: "Liquid glass graph", about: "A liquid glass card under your chin: a green graph climbs while the number counts up", options: "`text` (label), `from`, `to` (e.g. `197K`, `59%`), `color`", keys: ["color", "from", "text", "to"], images: false, camera: false },
  { fx: "carousel-spin", label: "Carousel spin", about: "Your reels spin around you in a 3D carousel, then slow to a stop", options: "`images`, `count`, `size`, `turns`", keys: ["count", "images", "size", "turns"], images: true, camera: false },
  { fx: "match-cut", label: "Match cut", about: "News pages cut on one word, locked in a red box behind your head", options: "`text` (the word, default Claude), `color`", keys: ["color", "text"], images: false, camera: false },
  { fx: "apple-toggles", label: "iPhone toggles", about: "An iPhone settings card under your chin flips its switches on, one line at a time", options: "`text` (rows with `|`), `ticks` (seconds with `|`), `color`", keys: ["color", "text", "ticks"], images: false, camera: false },
  { fx: "led-sign", label: "LED sign", about: "The lights drop and a glowing LED sign types itself out behind you", options: "`text` (lines with `|`), `color`, `push`", keys: ["color", "push", "text"], images: false, camera: false },
  { fx: "slow-push", label: "Slow push", about: "A slow cinematic push-in to your face while the room melts out of focus", options: "`zoom` (default 1.6), `blur`", keys: ["blur", "zoom"], images: false, camera: true },
  { fx: "over-the-shoulder-zoom", label: "Over-the-shoulder zoom", about: "The camera pushes into one top corner and a see-through liquid glass graph pops beside your head (line climbs, number counts up), pulls back, then the other corner with a second, related bar graph. Your head stays in front", options: "`text` (two labels with `|`), `to` (two numbers with `|`, e.g. `197K|672K`), `zoom` (default 2.0)", keys: ["text", "to", "zoom"], images: false, camera: true },
  { fx: "messages", label: "Messages", about: "iMessage notifications pop in one after another, creamy glass with a soft glow, stacking up above the bottom of the frame", options: "`text` (messages with `|`), `title` (default Messages), `y`", keys: ["text", "title", "y"], images: false, camera: false },
  { fx: "place-in-grid", label: "Place in grid", about: "You shrink into the centre tile of your 3x3 profile grid on frosted glass, then 8 reels pop in around you, one per frame, with Instagram view counts on every tile", options: "`images` (folder of your reels or covers), `views` (9 counts with `|`, the 9th is yours)", keys: ["images", "views"], images: true, camera: false },
];

export const FX_NAMES = FX_CATALOG.map((f) => f.fx) as [string, ...string[]];

/** Other names the engine accepts, mapped to the catalogue name. */
export const FX_ALIASES: Readonly<Record<string, string>> = {
  "auto-edit": "timeline",
  "b-roll": "broll-split",
  "backdrop": "backdrop-word",
  "bill": "the-bill",
  "broll": "broll-split",
  "carousel": "carousel-spin",
  "collage": "red-collage",
  "comment": "comment-box",
  "corner-zoom": "over-the-shoulder-zoom",
  "countdown": "countdown-flip",
  "cover": "cover-star",
  "dots": "dot-reveal",
  "fan": "phone-fan",
  "follow": "tap",
  "glass": "glass-widgets",
  "glass-graph": "liquid-glass-graph",
  "glitter": "spotlight",
  "glitter-spotlight": "spotlight",
  "grid": "place-in-grid",
  "headline": "headline-box",
  "headlines": "headline-wall",
  "imessage": "messages",
  "led": "led-sign",
  "liquid-glass": "liquid-glass-graph",
  "match": "match-cut",
  "notifications": "messages",
  "ots": "over-the-shoulder-zoom",
  "pastel": "pastel-word",
  "pause": "pause-point",
  "pause-and-point": "pause-point",
  "pills": "check-pills",
  "profile-grid": "place-in-grid",
  "push": "slow-push",
  "push-in": "slow-push",
  "rain": "shortcut-rain",
  "shoulder-zoom": "over-the-shoulder-zoom",
  "split": "split-headline",
  "stamp": "reject-stamp",
  "tasks": "checklist",
  "texts": "messages",
  "the-lineup": "lineup",
  "the-noise": "noise",
  "the-tap": "tap",
  "the-to-do": "todo",
  "the-todo": "todo",
  "tier": "tier-list",
  "tiers": "tier-list",
  "to-do": "todo",
  "toggles": "apple-toggles",
  "wall": "profile-wall",
  "widgets": "glass-widgets"
};

export function fxInfo(name: string): FxInfo | undefined {
  const n = name.toLowerCase().replace(/^\//, "");
  return FX_CATALOG.find((f) => f.fx === (FX_ALIASES[n] ?? n));
}
