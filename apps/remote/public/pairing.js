// Pairing input for the phone app. No DOM here, so the relay tests can import it.
import { normalisePairingCode } from './crypto.js';

/**
 * The one-time pairing code out of whatever the user has: the QR's link (…/#pair=XXXX-XXXX-XXXX-XXXX),
 * a pasted link, or the code typed by hand (any case, with or without dashes/spaces). Null otherwise.
 * An app added to the iOS Home Screen keeps its own storage, apart from Safari's, so pairing happens
 * inside the app (scan or type), not by opening the link in Safari.
 */
export function codeFromText(text) {
  const t = String(text ?? '').trim();
  const m = /(?:#|&)pair=([A-Za-z0-9-]{16,19})(?:&|$)/.exec(t);
  return normalisePairingCode(m ? m[1] : t);
}

/** "ABCD-EFGH-JKMN-PQRS" for showing a code back. */
export const formatCode = (code) => code.match(/.{1,4}/g).join('-');
