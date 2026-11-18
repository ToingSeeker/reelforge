// The phone's half of the remote's encryption, with WebCrypto. Must match packages/remote/src/keys.ts
// (labels, HMAC derivation, AES-256-GCM layout iv ‖ ciphertext ‖ tag in base64, additional data, the
// pairing exchange); packages/remote/test/keys.test.ts runs this file under Node to prove both sides agree.

export const DEVICE_AUTH_LABEL = 'reelforge-remote-device-auth-v1';
export const DEVICE_ENC_LABEL = 'reelforge-remote-device-enc-v1';
export const PAIR_LABEL = 'reelforge-remote-pair-v1';
export const PAIR_BOX_LABEL = 'reelforge-remote-pair-box-v1';
export const PAIR_ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';

const enc = new TextEncoder();
const dec = new TextDecoder();

export const fromBase64 = (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

export function toBase64(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(out);
}

const hex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) (out.set(p, at), (at += p.length));
  return out;
};

async function hmac(keyBytes, data) {
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, data));
}

const aesKey = (raw) => crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);

/** From a device secret: the relay token (hex) and the AES-GCM key for this phone. */
export async function deriveDeviceKeys(secret) {
  const s = enc.encode(secret);
  const token = hex(await hmac(s, enc.encode(DEVICE_AUTH_LABEL)));
  const key = await aesKey(await hmac(s, enc.encode(DEVICE_ENC_LABEL)));
  return { token, key };
}

/** A broadcast key handed over at pairing (base64). */
export const importBroadcastKey = (b64) => aesKey(fromBase64(b64));

export async function seal(key, value, aad) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const params = { name: 'AES-GCM', iv, ...(aad === undefined ? {} : { additionalData: enc.encode(aad) }) };
  const body = new Uint8Array(await crypto.subtle.encrypt(params, key, enc.encode(JSON.stringify(value))));
  return toBase64(concat(iv, body));
}

/** Rejects unless sealed with this key and this additional data, and unaltered. */
export async function unseal(key, text, aad) {
  const plain = await unsealBytes(key, text, aad);
  return JSON.parse(dec.decode(plain));
}

/** Same as unseal, for raw bytes (file pieces). */
export async function sealBytes(key, bytes, aad) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const body = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(aad) }, key, bytes));
  return toBase64(concat(iv, body));
}

export async function unsealBytes(key, text, aad) {
  const raw = fromBase64(text);
  const params = { name: 'AES-GCM', iv: raw.subarray(0, 12), ...(aad === undefined ? {} : { additionalData: enc.encode(aad) }) };
  return new Uint8Array(await crypto.subtle.decrypt(params, key, raw.subarray(12)));
}

// ── pairing ───────────────────────────────────────────────────────────────

/** "abcd efgh-…" → 16 upper-case characters, or null. */
export function normalisePairingCode(input) {
  const code = String(input ?? '').toUpperCase().replace(/[\s-]/g, '');
  if (code.length !== 16) return null;
  for (const ch of code) if (!PAIR_ALPHABET.includes(ch)) return null;
  return code;
}

/**
 * Starts pairing with a code. Returns the lookup, the hello to send, and open(answer), which checks the
 * Mac's proof and returns what the Mac sent (device id and secret, broadcast key, Mac name).
 */
export async function pairPhone(code, name) {
  const lookup = code.slice(0, 4);
  const k = await hmac(enc.encode(code.slice(4)), enc.encode(PAIR_LABEL));
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  const pub = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  const hello = { pub: toBase64(pub), name, proof: toBase64(await hmac(k, concat(enc.encode('hello'), pub))) };
  return {
    lookup,
    hello,
    async open(answer) {
      const macPub = fromBase64(answer.pub);
      const want = await hmac(k, concat(enc.encode('answer'), macPub, pub));
      const got = fromBase64(answer.proof);
      if (got.length !== want.length || got.some((b, i) => b !== want[i])) throw new Error('The Mac’s answer didn’t match the code.');
      const theirs = await crypto.subtle.importKey('raw', macPub, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
      const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: theirs }, pair.privateKey, 256));
      const base = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveBits']);
      const boxRaw = new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: k, info: enc.encode(PAIR_BOX_LABEL) }, base, 256));
      return unseal(await aesKey(boxRaw), answer.box, 'pair');
    },
  };
}
