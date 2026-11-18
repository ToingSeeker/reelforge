// Pairing input for the phone app. No DOM here, so the relay tests can import it.

/**
 * The key out of whatever was pasted: the whole pairing link (from "Copy link" on the Mac) or just
 * the part after `k=`. Null when it is neither. An app added to the iOS Home Screen keeps its own
 * storage, apart from Safari's, so a QR scan (which opens Safari) never pairs it; pasting inside
 * the app does.
 */
export function secretFromText(text) {
  const t = String(text ?? '').trim();
  const m = /(?:#|&)k=([A-Za-z0-9_-]{32,})(?:&|$)/.exec(t) ?? /^([A-Za-z0-9_-]{32,})$/.exec(t);
  return m ? m[1] : null;
}
