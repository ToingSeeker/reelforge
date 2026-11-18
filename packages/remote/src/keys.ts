// Keys for the phone remote.
//
// - The Mac has one long-lived secret. From it come the Mac's relay token (the relay is given only its
//   SHA-256, as REELFORGE_REMOTE_AUTH) and the Mac's id.
// - Every paired phone has its own device secret, made by the Mac at pairing time. From it come the
//   phone's relay token (the Mac publishes its hash to the relay, and withdraws it to revoke the phone)
//   and the key that seals what passes between that phone and the Mac.
// - Events the Mac broadcasts to all its phones are sealed with a broadcast key that the Mac hands to
//   each phone when it pairs, and replaces (re-sending it to the phones still paired) when one is revoked.
//
// Every sealed message carries "additional data" naming its direction and purpose (`evt`, `cmd:<device>`,
// …), so a message can never be replayed as a different kind of message, or the other way round.
//
// Pairing uses a one-time code (shown as QR or typed): 4 characters to find the Mac's pairing slot on the
// relay, 12 secret characters (60 bits) that prove each side knew the code. The phone and the Mac agree on a
// fresh key by ECDH (P-256) and the device's credentials travel inside it, so the code itself is never a
// credential and is useless once used or expired.
//
// The phone does the same with WebCrypto (apps/remote/public/crypto.js); test/keys.test.ts checks that
// each side opens what the other sealed. Change one, change both.

import { createCipheriv, createDecipheriv, createECDH, createHash, createHmac, hkdfSync, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

export const AUTH_LABEL = "reelforge-remote-auth-v1";
export const ENC_LABEL = "reelforge-remote-enc-v1";
export const DEVICE_AUTH_LABEL = "reelforge-remote-device-auth-v1";
export const DEVICE_ENC_LABEL = "reelforge-remote-device-enc-v1";
export const PAIR_LABEL = "reelforge-remote-pair-v1";
export const PAIR_BOX_LABEL = "reelforge-remote-pair-box-v1";

export interface RemoteKeys {
  /** Bearer token for the relay (hex). */
  token: string;
  /** AES-256-GCM key (legacy single-secret pairing; kept so old tests and tools still derive it). */
  key: Buffer;
  /** What the relay is given (REELFORGE_REMOTE_AUTH): hex SHA-256 of the token. */
  authHash: string;
}

export interface DeviceKeys {
  /** The phone's bearer token for the relay (hex). */
  token: string;
  /** Hex SHA-256 of the token: what the Mac publishes to the relay for this phone. */
  tokenHash: string;
  /** AES-256-GCM key for commands from this phone and events meant only for it. */
  key: Buffer;
}

export function newSecret(): string {
  return randomBytes(32).toString("base64url");
}

const hmac = (key: string | Buffer, label: string | Buffer) => createHmac("sha256", key).update(label).digest();
const sha256hex = (text: string) => createHash("sha256").update(text).digest("hex");

export function deriveKeys(secret: string): RemoteKeys {
  const token = hmac(secret, AUTH_LABEL).toString("hex");
  return { token, key: hmac(secret, ENC_LABEL), authHash: sha256hex(token) };
}

/** The Mac's id as phones and the relay see it: short, stable for one secret, reveals nothing. */
export function macIdOf(authHash: string): string {
  return authHash.slice(0, 16);
}

export function deriveDeviceKeys(deviceSecret: string): DeviceKeys {
  const token = hmac(deviceSecret, DEVICE_AUTH_LABEL).toString("hex");
  return { token, tokenHash: sha256hex(token), key: hmac(deviceSecret, DEVICE_ENC_LABEL) };
}

/** base64 of iv(12) ‖ ciphertext ‖ tag(16): the layout WebCrypto's AES-GCM produces and expects. */
export function seal(key: Buffer, value: unknown, aad?: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  if (aad !== undefined) cipher.setAAD(Buffer.from(aad, "utf8"));
  const body = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return Buffer.concat([iv, body, cipher.getAuthTag()]).toString("base64");
}

/** Throws unless `text` was sealed with this key and this additional data, and arrived unaltered. */
export function unseal(key: Buffer, text: string, aad?: string): unknown {
  const raw = Buffer.from(text, "base64");
  if (raw.length < 12 + 16) throw new Error("sealed text too short");
  const decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
  if (aad !== undefined) decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(raw.subarray(raw.length - 16));
  return JSON.parse(Buffer.concat([decipher.update(raw.subarray(12, raw.length - 16)), decipher.final()]).toString("utf8"));
}

/** Raw bytes (a piece of a file), same layout, additional data required. */
export function sealBytes(key: Buffer, bytes: Buffer, aad: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  return Buffer.concat([iv, cipher.update(bytes), cipher.final(), cipher.getAuthTag()]).toString("base64");
}

export function unsealBytes(key: Buffer, text: string, aad: string): Buffer {
  const raw = Buffer.from(text, "base64");
  if (raw.length < 12 + 16) throw new Error("sealed piece too short");
  const decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(raw.subarray(raw.length - 16));
  return Buffer.concat([decipher.update(raw.subarray(12, raw.length - 16)), decipher.final()]);
}

// ── pairing ───────────────────────────────────────────────────────────────

/** No 0/O, 1/I/L, U: easy to read off a screen and type. */
export const PAIR_ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ23456789";
export const PAIR_LOOKUP_LEN = 4;
export const PAIR_SECRET_LEN = 12;

export interface PairingCode {
  /** 16 characters, shown grouped as XXXX-XXXX-XXXX-XXXX. */
  code: string;
  /** First 4: names the slot on the relay (not secret). */
  lookup: string;
  /** Last 12: never leaves the Mac or the phone. */
  secret: string;
}

export function newPairingCode(): PairingCode {
  let code = "";
  for (let i = 0; i < PAIR_LOOKUP_LEN + PAIR_SECRET_LEN; i++) code += PAIR_ALPHABET[randomInt(PAIR_ALPHABET.length)];
  return { code, lookup: code.slice(0, PAIR_LOOKUP_LEN), secret: code.slice(PAIR_LOOKUP_LEN) };
}

/** Accepts "abcd-efgh…", spaces, lower case; null unless it is a well-formed code. */
export function normalisePairingCode(input: string): string | null {
  const code = String(input ?? "").toUpperCase().replace(/[\s-]/g, "");
  if (code.length !== PAIR_LOOKUP_LEN + PAIR_SECRET_LEN) return null;
  for (const ch of code) if (!PAIR_ALPHABET.includes(ch)) return null;
  return code;
}

export const formatPairingCode = (code: string) => code.match(/.{1,4}/g)!.join("-");

const pairKey = (secret: string) => hmac(secret, PAIR_LABEL);
const b64 = (b: Buffer) => b.toString("base64");

/** What the phone sends first (its fresh public key and proof that it knows the code). */
export interface PairHello {
  pub: string;
  name: string;
  proof: string;
}

/** The Mac's reply: its public key, its proof, and the box holding the device's credentials. */
export interface PairAnswer {
  pub: string;
  proof: string;
  box: string;
}

/** What the box holds. */
export interface PairPayload {
  macId: string;
  macName: string;
  deviceId: string;
  deviceSecret: string;
  /** Base64 broadcast key. */
  broadcastKey: string;
}

export function verifyPairHello(secret: string, hello: unknown): PairHello {
  const h = hello as Partial<PairHello> | null;
  if (typeof h?.pub !== "string" || typeof h.proof !== "string" || typeof h.name !== "string") throw new Error("malformed pairing request");
  const pub = Buffer.from(h.pub, "base64");
  if (pub.length !== 65 || pub[0] !== 4) throw new Error("malformed pairing key");
  const want = hmac(pairKey(secret), Buffer.concat([Buffer.from("hello"), pub]));
  const got = Buffer.from(h.proof, "base64");
  if (got.length !== want.length || !timingSafeEqual(got, want)) throw new Error("the pairing code didn't match");
  return { pub: h.pub, proof: h.proof, name: h.name.slice(0, 60) };
}

/** Builds the Mac's answer for a verified hello. */
export function pairAnswer(secret: string, hello: PairHello, payload: PairPayload): PairAnswer {
  const ecdh = createECDH("prime256v1");
  const macPub = ecdh.generateKeys();
  const phonePub = Buffer.from(hello.pub, "base64");
  const shared = ecdh.computeSecret(phonePub);
  const k = pairKey(secret);
  const box = Buffer.from(hkdfSync("sha256", shared, k, PAIR_BOX_LABEL, 32));
  return {
    pub: b64(macPub),
    proof: b64(hmac(k, Buffer.concat([Buffer.from("answer"), macPub, phonePub]))),
    box: seal(box, payload, "pair"),
  };
}

/**
 * The phone's side, for tests (the phone runs crypto.js). Returns the hello to send and a function that
 * opens the Mac's answer.
 */
export function pairPhone(secret: string, name: string): { hello: PairHello; open(answer: PairAnswer): PairPayload } {
  const ecdh = createECDH("prime256v1");
  const pub = ecdh.generateKeys();
  const k = pairKey(secret);
  const hello = { pub: b64(pub), name, proof: b64(hmac(k, Buffer.concat([Buffer.from("hello"), pub]))) };
  return {
    hello,
    open(answer) {
      const macPub = Buffer.from(answer.pub, "base64");
      const want = hmac(k, Buffer.concat([Buffer.from("answer"), macPub, pub]));
      const got = Buffer.from(answer.proof, "base64");
      if (got.length !== want.length || !timingSafeEqual(got, want)) throw new Error("the Mac's answer didn't match the code");
      const box = Buffer.from(hkdfSync("sha256", ecdh.computeSecret(macPub), k, PAIR_BOX_LABEL, 32));
      return unseal(box, answer.box, "pair") as PairPayload;
    },
  };
}
