// Small building blocks for the phone app. Views are built with textContent, never innerHTML, so nothing
// from a project name or a model's answer can become markup. No inline style attributes (the relay's CSP
// forbids them); the few live values (progress) are set through CSSOM custom properties.

/** createElement with props: class, text, on<event>, vars (CSS custom properties), other attributes; children flattened. */
export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'value') el.value = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'vars') for (const [name, val] of Object.entries(v)) el.style.setProperty(name, String(val));
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat(Infinity)) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}

// The desktop's stroke icon family (apps/desktop/src/icons.tsx: 24 px grid, 1.6 stroke, round caps), plus
// the few the phone needs that the desktop doesn't, drawn the same way.
const PATHS = {
  projects: 'M3.5 7.5a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z',
  session: 'M4.5 7l4.5 5-4.5 5M11.5 17.5h8',
  exports: 'M12 4v11M7.5 10.5L12 15l4.5-4.5M4.5 19.5h15',
  back: 'M15 18l-6-6 6-6',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  chevronRight: 'M9 6l6 6-6 6',
  chevronDown: 'M6 9l6 6 6-6',
  chevronUp: 'M6 15l6-6 6 6',
  play: 'M7 4.5l12 7.5-12 7.5z',
  pause: 'M7 4.5h3.2v15H7zM13.8 4.5H17v15h-3.2z',
  volume: 'M11 5L6 9H3v6h3l5 4zM15.5 9a4.5 4.5 0 0 1 0 6M18.5 6a8.5 8.5 0 0 1 0 12',
  mute: 'M11 5L6 9H3v6h3l5 4zM16 9.5l5 5M21 9.5l-5 5',
  maximize: 'M8 3.5H3.5V8M20.5 8V3.5H16M16 20.5h4.5V16M3.5 16v4.5H8',
  attach: 'M20 11.5l-8.2 8.2a5 5 0 0 1-7.1-7.1l8.5-8.5a3.4 3.4 0 0 1 4.8 4.8l-8.5 8.5a1.7 1.7 0 0 1-2.4-2.4l7.8-7.8',
  send: 'M12 19V5M5 12l7-7 7 7',
  director: 'M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9zM18.5 15.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z',
  check: 'M20 6L9 17l-5-5',
  checkCircle: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0zM8 12.2l2.7 2.7L16 9.6',
  x: 'M18 6L6 18M6 6l12 12',
  alert: 'M12 9v4M12 17h.01M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z',
  info: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0zM12 11v5M12 8h.01',
  refresh: 'M20 11a8 8 0 0 0-14.6-4.5L4 8M4 4v4h4M4 13a8 8 0 0 0 14.6 4.5L20 16M20 20v-4h-4',
  clock: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0zM12 7v5l3 2',
  phone: 'M8 3h8a1.5 1.5 0 0 1 1.5 1.5v15A1.5 1.5 0 0 1 16 21H8a1.5 1.5 0 0 1-1.5-1.5v-15A1.5 1.5 0 0 1 8 3zM11 18h2',
  monitor: 'M3.5 5h17v11h-17zM9 20h6M12 16v4',
  film: 'M4 5h16v14H4zM8 5v14M16 5v14M4 9h4M4 15h4M16 9h4M16 15h4',
  layers: 'M12 3.5l8.5 4.5-8.5 4.5L3.5 8zM3.5 12l8.5 4.5 8.5-4.5M3.5 16l8.5 4.5 8.5-4.5',
  crop: 'M6.5 2.5v14h14M2.5 6.5h14v14',
  file: 'M14 3.5H7a1.5 1.5 0 0 0-1.5 1.5v14A1.5 1.5 0 0 0 7 20.5h10a1.5 1.5 0 0 0 1.5-1.5V8zM14 3.5V8h4.5',
  share: 'M12 15V4M7.5 8.5L12 4l4.5 4.5M4.5 13v5.5A1.5 1.5 0 0 0 6 20h12a1.5 1.5 0 0 0 1.5-1.5V13',
  pencil: 'M4 20h4L19 9l-4-4L4 16zM14 6l4 4',
  trash: 'M4 7h16M10 11v6M14 11v6M5.5 7l1 13h11l1-13M9 7V4h6v3',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-4-4',
  plus: 'M12 5v14M5 12h14',
  qr: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h2.5v2.5H14zM17.5 17.5H20V20h-2.5zM14 18.5v1.5h2M18.5 14H20v2',
  keyboard: 'M3.5 6.5h17v11h-17zM7 10h.01M10 10h.01M13 10h.01M16 10h.01M8 14h8',
  power: 'M12 3.5v8M7 6.5a7 7 0 1 0 10 0',
  bell: 'M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15zM10 20.5a2 2 0 0 0 4 0',
  history: 'M4 12a8 8 0 1 0 2.3-5.7L4 8.5M4 4v4.5h4.5M12 8v4l3 2',
  wifiOff: 'M3 3l18 18M8.5 16.4a5 5 0 0 1 7 0M5 12.9a10 10 0 0 1 4.2-2.4M19 12.9a10 10 0 0 0-2.5-1.7M2 9.3a15 15 0 0 1 4.6-2.8M22 9.3A15 15 0 0 0 11 5.1M12 20h.01',
  stop: 'M7 7h10v10H7z',
  queue: 'M4 6h12M4 12h12M4 18h7M17 15v6M14 18h6',
};

export function icon(name, { size = 20, label } = {}) {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.6');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('class', 'ic');
  if (label) {
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', label);
  } else svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', PATHS[name] ?? PATHS.info);
  svg.append(path);
  return svg;
}

/** The ReelForge mark (same file as the desktop's logo); `state` drives the gentle agent motion. */
export function logo(state = 'idle') {
  return h('span', { class: `logo is-${state}`, 'aria-hidden': 'true' }, h('img', { src: '/mark.svg', alt: '', width: 34, height: 34 }));
}

export function button(label, { kind = 'secondary', iconName, onclick, disabled, small, full, aria, type = 'button' } = {}) {
  return h(
    'button',
    { class: `btn ${kind}${small ? ' sm' : ''}${full ? ' full' : ''}`, type, onclick, disabled: disabled || null, 'aria-label': aria ?? null },
    iconName ? icon(iconName, { size: small ? 16 : 18 }) : null,
    label ? h('span', { text: label }) : null,
  );
}

export function iconButton(name, label, onclick, { disabled, cls = '' } = {}) {
  return h('button', { class: `icon-btn ${cls}`, type: 'button', 'aria-label': label, title: label, onclick, disabled: disabled || null }, icon(name));
}

/** A determinate bar when `value` is a number, an indeterminate one otherwise. */
export function progress(value, label) {
  const known = typeof value === 'number' && Number.isFinite(value);
  return h(
    'div',
    { class: `bar${known ? '' : ' indeterminate'}`, role: 'progressbar', 'aria-label': label ?? 'Progress', 'aria-valuemin': known ? 0 : null, 'aria-valuemax': known ? 100 : null, 'aria-valuenow': known ? Math.round(value * 100) : null },
    h('span', { vars: known ? { '--p': `${Math.max(0, Math.min(1, value)) * 100}%` } : {} }),
  );
}

/** Status pill: text always present (never colour alone), with a glyph. */
export function pill(text, tone = 'neutral', iconName = null) {
  return h('span', { class: `pill ${tone}` }, iconName ? icon(iconName, { size: 14 }) : h('span', { class: 'dot', 'aria-hidden': 'true' }), h('span', { text }));
}

// ── bottom sheet ────────────────────────────────────────────────────────────
let openSheet = null;
/** A modal bottom sheet. Closes on the X, the backdrop, Escape, or a downward swipe on the handle. */
export function sheet(title, body, { onClose } = {}) {
  closeSheet();
  const close = () => closeSheet();
  const panel = h(
    'div',
    { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    h('div', { class: 'sheet-handle', 'aria-hidden': 'true' }),
    h('div', { class: 'sheet-head' }, h('h2', { text: title }), iconButton('x', 'Close', close)),
    h('div', { class: 'sheet-body' }, body),
  );
  const backdrop = h('div', { class: 'sheet-backdrop', onclick: (e) => e.target === backdrop && close() }, panel);
  const onKey = (e) => e.key === 'Escape' && close();
  let startY = null;
  panel.querySelector('.sheet-handle').addEventListener('pointerdown', (e) => (startY = e.clientY));
  window.addEventListener('pointerup', (e) => {
    if (startY !== null && e.clientY - startY > 60) close();
    startY = null;
  }, { once: false });
  document.addEventListener('keydown', onKey);
  document.body.append(backdrop);
  document.body.classList.add('sheet-open');
  const prevFocus = document.activeElement;
  requestAnimationFrame(() => panel.querySelector('button, [href], input, select, textarea')?.focus({ preventScroll: true }));
  openSheet = { backdrop, onKey, onClose, prevFocus };
  return { close, panel };
}

export function closeSheet() {
  if (!openSheet) return;
  const { backdrop, onKey, onClose, prevFocus } = openSheet;
  openSheet = null;
  document.removeEventListener('keydown', onKey);
  backdrop.remove();
  document.body.classList.remove('sheet-open');
  onClose?.();
  prevFocus?.focus?.({ preventScroll: true });
}

export const sheetIsOpen = () => openSheet !== null;

// ── formatting ──────────────────────────────────────────────────────────────
export function ago(when) {
  const t = typeof when === 'number' ? when : Date.parse(when);
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (!Number.isFinite(s)) return '—';
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 172800) return 'yesterday';
  return new Date(t).toLocaleDateString();
}

export function aspect(w, hgt) {
  const g = (a, b) => (b ? g(b, a % b) : a);
  const d = g(w, hgt) || 1;
  const a = `${w / d}:${hgt / d}`;
  return ['9:16', '16:9', '1:1', '4:5', '4:3', '3:4'].includes(a) ? a : `${w}×${hgt}`;
}

export function clock(seconds) {
  const s = Math.max(0, Math.floor(seconds || 0));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

export const duration = (frames, fps) => (frames > 0 ? clock(frames / (fps || 30)) : null);

export function size(bytes) {
  if (!bytes) return null;
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${(bytes / 1e6).toFixed(1)} MB`;
}

export const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
