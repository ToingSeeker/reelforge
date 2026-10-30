import { Icon, type IconName } from "../icons.tsx";

export type RailItem = "media" | "templates" | "text" | "audio" | "effects" | "transitions" | "color";

const ITEMS: { id: RailItem; label: string; icon: IconName }[] = [
  { id: "media", label: "Media", icon: "media" },
  { id: "templates", label: "Templates", icon: "templates" },
  { id: "text", label: "Text", icon: "text" },
  { id: "audio", label: "Audio", icon: "audio" },
  { id: "effects", label: "Effects", icon: "effects" },
  { id: "transitions", label: "Transitions", icon: "transitions" },
  { id: "color", label: "Color", icon: "color" },
];

export function LeftRail({ active, onChange, onSettings }: { active: RailItem; onChange: (r: RailItem) => void; onSettings: () => void }) {
  return (
    <nav className="rf-rail" aria-label="Tools">
      {ITEMS.map((i) => (
        <button
          key={i.id}
          className="rf-rail-item"
          aria-current={active === i.id ? "true" : undefined}
          onClick={() => onChange(i.id)}
        >
          <Icon name={i.icon} size={20} />
          <span>{i.label}</span>
        </button>
      ))}
      <button className="rf-rail-item rf-rail-settings" onClick={onSettings} title="Settings: AI providers and keys">
        <Icon name="settings" size={18} />
        <span>Settings</span>
      </button>
    </nav>
  );
}
