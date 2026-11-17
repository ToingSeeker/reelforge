// A browser and a push service, written from RFC 8291 / 8292 independently of src/push.ts.
import assert from "node:assert/strict";
import { createDecipheriv, createECDH, createHmac, createPublicKey, randomBytes, verify } from "node:crypto";

/** A browser's side of a push subscription, written from RFC 8291 independently of push.ts. */
export function browser() {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const auth = randomBytes(16);
  const hmac = (key: Buffer, data: Buffer) => createHmac("sha256", key).update(data).digest();
  return {
    keys: { p256dh: ecdh.getPublicKey().toString("base64url"), auth: auth.toString("base64url") },
    decrypt(body: Buffer): unknown {
      const salt = body.subarray(0, 16);
      assert.equal(body.readUInt32BE(16), 4096, "record size");
      const idlen = body[20]!;
      const asPublic = body.subarray(21, 21 + idlen);
      const ct = body.subarray(21 + idlen);
      const shared = ecdh.computeSecret(asPublic);
      const ikm = hmac(hmac(auth, shared), Buffer.concat([Buffer.from("WebPush: info\0"), ecdh.getPublicKey(), asPublic, Buffer.from([1])]));
      const prk = hmac(salt, ikm);
      const cek = hmac(prk, Buffer.from("Content-Encoding: aes128gcm\0\x01")).subarray(0, 16);
      const nonce = hmac(prk, Buffer.from("Content-Encoding: nonce\0\x01")).subarray(0, 12);
      const d = createDecipheriv("aes-128-gcm", cek, nonce);
      d.setAuthTag(ct.subarray(ct.length - 16));
      const plain = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
      assert.equal(plain.at(-1), 2, "a single, final record");
      return JSON.parse(plain.subarray(0, -1).toString("utf8"));
    },
  };
}

/** Checks a VAPID header the way a push service does; returns the JWT claims. */
export function checkVapid(header: string, publicKey: string): Record<string, unknown> {
  const m = /^vapid t=([^,]+), k=(.+)$/.exec(header);
  assert.ok(m, `vapid header shape: ${header}`);
  assert.equal(m[2], publicKey);
  const [h, c, s] = m[1]!.split(".");
  const raw = Buffer.from(publicKey, "base64url");
  const key = createPublicKey({ key: { kty: "EC", crv: "P-256", x: raw.subarray(1, 33).toString("base64url"), y: raw.subarray(33).toString("base64url") }, format: "jwk" });
  assert.ok(verify("sha256", Buffer.from(`${h}.${c}`), { key, dsaEncoding: "ieee-p1363" }, Buffer.from(s!, "base64url")), "ES256 signature verifies");
  assert.deepEqual(JSON.parse(Buffer.from(h!, "base64url").toString()), { typ: "JWT", alg: "ES256" });
  return JSON.parse(Buffer.from(c!, "base64url").toString()) as Record<string, unknown>;
}
