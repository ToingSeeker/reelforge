// The phone's half of the remote's encryption, with WebCrypto. Must match packages/remote/src/keys.ts
// (labels, HMAC derivation, AES-256-GCM layout iv ‖ ciphertext ‖ tag in base64);
// packages/remote/test/keys.test.ts runs this file under Node to prove both sides agree.

export const AUTH_LABEL = 'reelforge-remote-auth-v1';
export const ENC_LABEL = 'reelforge-remote-enc-v1';

const enc = new TextEncoder();
const dec = new TextDecoder();

/** From the pairing secret: the relay token (hex) and the AES-GCM key. */
export async function deriveKeys(secret) {
  const base = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sign = async (label) => new Uint8Array(await crypto.subtle.sign('HMAC', base, enc.encode(label)));
  const token = [...(await sign(AUTH_LABEL))].map((b) => b.toString(16).padStart(2, '0')).join('');
  const key = await crypto.subtle.importKey('raw', await sign(ENC_LABEL), 'AES-GCM', false, ['encrypt', 'decrypt']);
  return { token, key };
}

export const fromBase64 = (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

export function toBase64(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(out);
}

export async function seal(key, value) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const body = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(value))));
  const out = new Uint8Array(12 + body.length);
  out.set(iv);
  out.set(body, 12);
  return toBase64(out);
}

/** Rejects unless sealed with this key and unaltered. */
export async function unseal(key, text) {
  const raw = fromBase64(text);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: raw.subarray(0, 12) }, key, raw.subarray(12));
  return JSON.parse(dec.decode(plain));
}
