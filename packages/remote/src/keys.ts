// Keys for the phone remote. One random secret lives on this Mac and on the paired phone; from it
// come the token that opens the relay and the key that hides everything from the relay. The relay
// only ever gets SHA-256(token), so it can neither read nor forge what passes through it.
//
// The phone does the same with WebCrypto (apps/remote/public/crypto.js); test/keys.test.ts checks
// that each side opens what the other sealed. Change one, change both.

import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from "node:crypto";

export const AUTH_LABEL = "reelforge-remote-auth-v1";
export const ENC_LABEL = "reelforge-remote-enc-v1";

export interface RemoteKeys {
  /** Bearer token for the relay (hex). */
  token: string;
  /** AES-256-GCM key for everything sent through the relay. */
  key: Buffer;
  /** What the relay is given (REELFORGE_REMOTE_AUTH): hex SHA-256 of the token. */
  authHash: string;
}

export function newSecret(): string {
  return randomBytes(32).toString("base64url");
}

export function deriveKeys(secret: string): RemoteKeys {
  const derive = (label: string) => createHmac("sha256", secret).update(label).digest();
  const token = derive(AUTH_LABEL).toString("hex");
  return { token, key: derive(ENC_LABEL), authHash: createHash("sha256").update(token).digest("hex") };
}

/** base64 of iv(12) ‖ ciphertext ‖ tag(16): the layout WebCrypto's AES-GCM produces and expects. */
export function seal(key: Buffer, value: unknown): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return Buffer.concat([iv, body, cipher.getAuthTag()]).toString("base64");
}

/** Throws unless `text` was sealed with this key and arrived unaltered. */
export function unseal(key: Buffer, text: string): unknown {
  const raw = Buffer.from(text, "base64");
  if (raw.length < 12 + 16) throw new Error("sealed text too short");
  const decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(raw.length - 16));
  return JSON.parse(Buffer.concat([decipher.update(raw.subarray(12, raw.length - 16)), decipher.final()]).toString("utf8"));
}
