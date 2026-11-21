// Web Push from this Mac straight to the phone's push service (Apple, Google, Mozilla). The relay is
// not involved. The payload is encrypted for the phone's browser (RFC 8291, aes128gcm), so the push
// service carries a notification it cannot read; this Mac proves who it is with VAPID (RFC 8292).
// Only node:crypto, no web-push dependency.

import { createCipheriv, createECDH, createHmac, createPrivateKey, generateKeyPairSync, randomBytes, sign, type webcrypto } from "node:crypto";
import { request } from "node:https";
import { publicOnlyLookup } from "@reelforge/core";

type JsonWebKey = webcrypto.JsonWebKey;

export interface PushSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface VapidKeys {
  /** Uncompressed P-256 point, base64url: the phone's `applicationServerKey`. */
  publicKey: string;
  /** Private key as JWK. */
  privateJwk: JsonWebKey;
}

const b64u = (b: Buffer) => b.toString("base64url");
const fromB64u = (s: string) => Buffer.from(s, "base64url");

export function newVapidKeys(): VapidKeys {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = privateKey.export({ format: "jwk" });
  return { publicKey: b64u(Buffer.concat([Buffer.from([4]), fromB64u(jwk.x!), fromB64u(jwk.y!)])), privateJwk: jwk };
}

/** The Authorization header for one push service (its origin is the JWT audience). */
export function vapidAuthorization(endpoint: string, vapid: VapidKeys, subject: string, now = Date.now()): string {
  const header = b64u(Buffer.from(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64u(Buffer.from(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject })));
  const key = createPrivateKey({ key: vapid.privateJwk, format: "jwk" });
  const signature = sign("sha256", Buffer.from(`${header}.${claims}`), { key, dsaEncoding: "ieee-p1363" });
  return `vapid t=${header}.${claims}.${b64u(signature)}, k=${vapid.publicKey}`;
}

const hmac = (key: Buffer, data: Buffer) => createHmac("sha256", key).update(data).digest();

/** RFC 8291: one aes128gcm record holding `payload`, readable only by the subscribed browser. */
export function encryptPayload(sub: PushSubscription, payload: Buffer): Buffer {
  const uaPublic = fromB64u(sub.keys.p256dh);
  const authSecret = fromB64u(sub.keys.auth);
  if (uaPublic.length !== 65 || uaPublic[0] !== 4 || authSecret.length !== 16) throw new Error("the subscription's keys are malformed");
  const ecdh = createECDH("prime256v1");
  const asPublic = ecdh.generateKeys();
  const shared = ecdh.computeSecret(uaPublic);
  const ikm = hmac(hmac(authSecret, shared), Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic, Buffer.from([1])]));
  const salt = randomBytes(16);
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from("Content-Encoding: aes128gcm\0\x01")).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from("Content-Encoding: nonce\0\x01")).subarray(0, 12);
  const cipher = createCipheriv("aes-128-gcm", cek, nonce);
  // 0x02 marks the last (only) record; no padding.
  const body = Buffer.concat([cipher.update(Buffer.concat([payload, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const rs = Buffer.alloc(4);
  rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, body]);
}

/** Largest notification we send; push services accept 4 KB of ciphertext. */
export const MAX_PUSH_PAYLOAD = 3000;

export interface PushResult {
  status: number;
  /** The subscription is gone for good (unsubscribed, app removed): forget it. */
  gone: boolean;
}

const publicPushHost = publicOnlyLookup((hostname) => new Error(`${hostname} is not a public push service`));

/**
 * POSTs to the push service over https. The phone chose the endpoint, so the address is checked
 * when the connection is made: a name that resolves to this Mac or its network is refused.
 */
function postPublic(url: string, headers: Record<string, string>, body: Buffer): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(url, { method: "POST", headers: { ...headers, "content-length": String(body.length) }, lookup: publicPushHost, timeout: 15_000 }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("timeout", () => req.destroy(new Error("the push service timed out")));
    req.on("error", reject);
    req.end(body);
  });
}

/** `fetchImpl` is for tests (a stand-in push service); without it the address check above applies. */
export async function sendPush(sub: PushSubscription, message: unknown, vapid: VapidKeys, subject: string, fetchImpl?: typeof fetch): Promise<PushResult> {
  const payload = Buffer.from(JSON.stringify(message));
  if (payload.length > MAX_PUSH_PAYLOAD) throw new Error("notification too large");
  const headers = {
    authorization: vapidAuthorization(sub.endpoint, vapid, subject),
    "content-encoding": "aes128gcm",
    "content-type": "application/octet-stream",
    ttl: String(24 * 3600),
    urgency: "normal",
  };
  const body = encryptPayload(sub, payload);
  let status: number;
  if (fetchImpl) {
    const res = await fetchImpl(sub.endpoint, { method: "POST", headers, body, redirect: "error", signal: AbortSignal.timeout(15_000) });
    await res.body?.cancel();
    status = res.status;
  } else status = await postPublic(checkEndpoint(sub.endpoint), headers, body);
  return { status, gone: status === 404 || status === 410 };
}

/**
 * A phone hands us its push endpoint and this Mac then POSTs to it, so only https URLs on public
 * hostnames and the standard port are accepted: never this machine, the LAN, or a bare IP address.
 * The name's resolved address is checked again when sendPush connects.
 */
export function checkEndpoint(endpoint: unknown, allowHttpLocal = false): string {
  if (typeof endpoint !== "string" || endpoint.length > 2048) throw new Error("bad push endpoint");
  let u: URL;
  try {
    u = new URL(endpoint);
  } catch {
    throw new Error("bad push endpoint");
  }
  if (allowHttpLocal && u.protocol === "http:" && u.hostname === "127.0.0.1") return u.href;
  // 'localhost.' is 'localhost': drop the root dot before looking at the name.
  const host = u.hostname.replace(/\.+$/, "");
  const ipLiteral = /^[\d.]+$/.test(host) || host.startsWith("[");
  // Push services listen on 443; any other port is a way to knock on something else.
  if (u.protocol !== "https:" || u.port !== "" || u.username || u.password || ipLiteral || !host.includes(".") || /(^|\.)(localhost|local|internal|lan|home)$/i.test(host)) {
    throw new Error("push endpoints must be https addresses of a push service");
  }
  return u.href;
}
