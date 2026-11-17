import { Icon, type IconName } from "../icons.tsx";

export type RailItem = "media" | "templates" | "text" | "audio" | "effects" | "transitions" | "color" | "director";

const ITEMS: { id: RailItem; label: string; icon: IconName }[] = [
  { id: "media", label: "Media", icon: "media" },
  { id: "templates", label: "Templates", icon: "templates" },
  { id: "text", label: "Text & captions", icon: "text" },
  { id: "audio", label: "Audio", icon: "audio" },
  { id: "effects", label: "Effects", icon: "effects" },
  { id: "transitions", label: "Transitions", icon: "transitions" },
  { id: "color", label: "Color", icon: "color" },
  { id: "director", label: "AI Director", icon: "director" },
];

/** Tool rail. Clicking the open tool again folds its panel away (more room for the preview). */
export function LeftRail({ active, open, onChange, onSettings }: { active: RailItem; open: boolean; onChange: (r: RailItem) => void; onSettings: () => void }) {
  return (
    <nav className="rf-rail" aria-label="Tools">
      {ITEMS.map((i) => (
        <button
          key={i.id}
          className={`rf-rail-item${i.id === "director" ? " rf-rail-director" : ""}`}
          aria-current={active === i.id && open ? "true" : undefined}
          aria-label={i.label}
          data-tip={active === i.id && open ? `${i.label} · click to hide` : i.label}
          data-tip-side="right"
          onClick={() => onChange(i.id)}
        >
          <Icon name={i.icon} size={20} />
        </button>
      ))}
      <button className="rf-rail-item rf-rail-settings" onClick={onSettings} aria-label="Settings" data-tip="Settings · AI providers and keys" data-tip-side="right">
        <Icon name="settings" size={20} />
      </button>
    </nav>
  );
}
