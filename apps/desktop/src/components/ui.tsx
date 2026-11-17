// Shared controls: segmented control, numeric field, compact slider, accordion. Styling in app.css ("Shared controls").
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Icon, type IconName } from "../icons.tsx";

export function Segmented<T extends string>(p: {
  value: T;
  options: readonly { value: T; label: ReactNode; icon?: IconName; disabled?: boolean; title?: string }[];
  onChange: (v: T) => void;
  label: string;
  /** "tabs" announces as a tab list (switches what is shown); "radio" picks a value. */
  role?: "tabs" | "radio";
  size?: "sm" | "md";
  disabled?: boolean;
  className?: string;
}) {
  const tabs = p.role === "tabs";
  return (
    <div
      className={`rf-seg rf-seg-${p.size ?? "md"}${p.className ? ` ${p.className}` : ""}`}
      role={tabs ? "tablist" : "radiogroup"}
      aria-label={p.label}
      style={{ "--rf-seg-n": p.options.length } as React.CSSProperties}
    >
      {p.options.map((o) => {
        const on = o.value === p.value;
        return (
          <button
            key={o.value}
            type="button"
            role={tabs ? "tab" : "radio"}
            aria-selected={tabs ? on : undefined}
            aria-checked={tabs ? undefined : on}
            disabled={p.disabled || o.disabled}
            title={o.title}
            onClick={() => !on && p.onChange(o.value)}
          >
            {o.icon && <Icon name={o.icon} size={15} />}
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * Numeric input: type a value, ↑/↓ to step (⇧ ×10), Enter or blur to commit, Esc to revert.
 * `onChange` is the live (uncommitted) value for previews, `onCommit` makes one undo step.
 */
export function NumberField(p: {
  value: number;
  onChange?: (v: number) => void;
  onCommit: (v: number) => void;
  min: number;
  max: number;
  step: number;
  unit?: string;
  decimals?: number;
  /** Short inline label inside the field, e.g. "X". */
  prefix?: string;
  label: string;
  disabled?: boolean;
  /** Shows a reset button when the value differs from it. */
  resetTo?: number;
}) {
  const decimals = p.decimals ?? (p.step < 1 ? (p.step < 0.1 ? 2 : 1) : 0);
  const fmt = (v: number) => (Number.isFinite(v) ? Number(v.toFixed(decimals)).toString() : "");
  const [text, setText] = useState<string | null>(null); // non-null while editing
  const start = useRef(p.value);
  const pending = useRef<number | null>(null);
  const cancelled = useRef(false);
  const shown = text ?? fmt(p.value);

  const live = (v: number) => {
    pending.current = v;
    p.onChange?.(v);
  };
  const commit = (v: number) => {
    pending.current = null;
    setText(null);
    if (Math.abs(v - start.current) > 1e-9) p.onCommit(v);
    else p.onChange?.(start.current);
    start.current = v;
  };
  const nudge = (dir: 1 | -1, big: boolean) => clamp(Number(((pending.current ?? p.value) + dir * p.step * (big ? 10 : 1)).toFixed(6)), p.min, p.max);

  return (
    <div className={`rf-numfield${p.disabled ? " is-disabled" : ""}`}>
      {p.prefix && <span className="rf-numfield-prefix" aria-hidden="true">{p.prefix}</span>}
      <input
        inputMode="decimal"
        aria-label={`${p.label}${p.unit ? ` (${p.unit})` : ""}`}
        value={shown}
        disabled={p.disabled}
        onFocus={(e) => {
          start.current = p.value;
          setText(fmt(p.value));
          e.currentTarget.select();
        }}
        onChange={(e) => {
          setText(e.target.value);
          const v = Number(e.target.value.replace(",", "."));
          if (e.target.value.trim() !== "" && Number.isFinite(v)) live(clamp(v, p.min, p.max));
        }}
        onBlur={() => {
          if (cancelled.current) {
            cancelled.current = false;
            pending.current = null;
            setText(null);
            return;
          }
          const v = Number((text ?? "").replace(",", "."));
          commit(text !== null && text.trim() !== "" && Number.isFinite(v) ? clamp(v, p.min, p.max) : start.current);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          else if (e.key === "Escape") {
            cancelled.current = true;
            p.onChange?.(start.current);
            e.currentTarget.blur();
          } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
            e.preventDefault();
            const v = nudge(e.key === "ArrowUp" ? 1 : -1, e.shiftKey);
            setText(fmt(v));
            live(v);
          }
        }}
      />
      {p.unit && <span className="rf-numfield-unit" aria-hidden="true">{p.unit}</span>}
      <span className="rf-numfield-step">
        <button type="button" tabIndex={-1} disabled={p.disabled || p.value >= p.max} aria-label={`Increase ${p.label}`} onClick={(e) => { start.current = p.value; commit(nudge(1, e.shiftKey)); }}>
          <Icon name="chevronUp" size={11} strokeWidth={2} />
        </button>
        <button type="button" tabIndex={-1} disabled={p.disabled || p.value <= p.min} aria-label={`Decrease ${p.label}`} onClick={(e) => { start.current = p.value; commit(nudge(-1, e.shiftKey)); }}>
          <Icon name="chevronDown" size={11} strokeWidth={2} />
        </button>
      </span>
      {p.resetTo !== undefined && Math.abs(p.value - p.resetTo) > 1e-9 && (
        <button type="button" className="rf-numfield-reset" disabled={p.disabled} aria-label={`Reset ${p.label}`} title={`Reset to ${fmt(p.resetTo)}${p.unit ?? ""}`} onClick={() => { start.current = p.value; commit(p.resetTo!); }}>
          <Icon name="reset" size={12} />
        </button>
      )}
    </div>
  );
}

/** Range slider that previews while dragging and commits once on release. */
export function Slider(p: { value: number; min: number; max: number; step: number; label: string; disabled?: boolean; onChange: (v: number) => void; onCommit: (v: number) => void }) {
  const pct = ((p.value - p.min) / (p.max - p.min)) * 100;
  return (
    <input
      className="rf-slider"
      type="range"
      min={p.min}
      max={p.max}
      step={p.step}
      value={p.value}
      disabled={p.disabled}
      aria-label={p.label}
      style={{ "--rf-fill": `${clamp(pct, 0, 100)}%` } as React.CSSProperties}
      onChange={(e) => p.onChange(Number(e.target.value))}
      onPointerUp={(e) => p.onCommit(Number(e.currentTarget.value))}
      onKeyUp={(e) => (e.key.startsWith("Arrow") || e.key === "Home" || e.key === "End" || e.key.startsWith("Page")) && p.onCommit(Number(e.currentTarget.value))}
    />
  );
}

function readOpen(key: string | undefined, fallback: boolean): boolean {
  if (!key) return fallback;
  try {
    const v = localStorage.getItem(`rf.acc.${key}`);
    return v === null ? fallback : v === "1";
  } catch {
    return fallback;
  }
}

export function Accordion(p: { title: string; icon?: IconName; defaultOpen?: boolean; persistKey?: string; summary?: ReactNode; children: ReactNode }) {
  const [open, setOpen] = useState(() => readOpen(p.persistKey, !!p.defaultOpen));
  const id = useId();
  useEffect(() => {
    if (!p.persistKey) return;
    try {
      localStorage.setItem(`rf.acc.${p.persistKey}`, open ? "1" : "0");
    } catch {
      /* best effort */
    }
  }, [open, p.persistKey]);
  return (
    <section className={`rf-acc${open ? " is-open" : ""}`}>
      <button type="button" className="rf-acc-head" aria-expanded={open} aria-controls={id} onClick={() => setOpen((o) => !o)}>
        {p.icon && <Icon name={p.icon} size={16} />}
        <span className="rf-acc-title">{p.title}</span>
        {p.summary && !open && <span className="rf-acc-summary">{p.summary}</span>}
        <Icon name="chevronDown" size={15} className="rf-acc-chevron" />
      </button>
      {open && (
        <div className="rf-acc-body" id={id}>
          {p.children}
        </div>
      )}
    </section>
  );
}

/** Label + control row used across the inspector. */
export function Row(p: { label: string; children: ReactNode; className?: string }) {
  return (
    <div className={`rf-row${p.className ? ` ${p.className}` : ""}`}>
      <span className="rf-row-label">{p.label}</span>
      <div className="rf-row-control">{p.children}</div>
    </div>
  );
}

export interface MenuItem {
  label: string;
  icon?: IconName;
  onSelect: () => void;
  disabled?: boolean;
  danger?: boolean;
}

/**
 * Popup menu anchored to a button. Positioned fixed against the viewport so no panel's overflow
 * clips it; flips up when there is no room below. Closes on outside click, Escape, scroll or resize.
 */
export function PopupMenu({ anchor, items, onClose, label }: { anchor: DOMRect; items: MenuItem[]; onClose: () => void; label: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const left = Math.max(8, Math.min(window.innerWidth - w - 8, anchor.right - w));
    const below = anchor.bottom + 6;
    const top = below + h > window.innerHeight - 8 ? Math.max(8, anchor.top - h - 6) : below;
    setPos({ left, top });
    el.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }, [anchor]);
  useEffect(() => {
    const down = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && onClose();
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const list = [...(ref.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])];
        const i = list.indexOf(document.activeElement as HTMLButtonElement);
        list[(i + (e.key === "ArrowDown" ? 1 : -1) + list.length) % list.length]?.focus();
      }
    };
    const away = () => onClose();
    document.addEventListener("mousedown", down);
    document.addEventListener("keydown", key);
    window.addEventListener("resize", away);
    document.addEventListener("scroll", away, true);
    return () => {
      document.removeEventListener("mousedown", down);
      document.removeEventListener("keydown", key);
      window.removeEventListener("resize", away);
      document.removeEventListener("scroll", away, true);
    };
  }, [onClose]);
  return (
    <div ref={ref} className="rf-menu rf-menu-fixed" role="menu" aria-label={label} style={pos ? { left: pos.left, top: pos.top } : { visibility: "hidden", left: 0, top: 0 }}>
      {items.map((it) => (
        <button
          key={it.label}
          type="button"
          role="menuitem"
          className={`rf-menu-item${it.danger ? " is-danger" : ""}`}
          disabled={it.disabled}
          onClick={() => {
            onClose();
            it.onSelect();
          }}
        >
          <span className="rf-menu-check">{it.icon && <Icon name={it.icon} size={15} />}</span>
          <span className="rf-menu-text">{it.label}</span>
        </button>
      ))}
    </div>
  );
}
