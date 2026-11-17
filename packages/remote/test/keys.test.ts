import { test } from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { deriveKeys, newSecret, seal, unseal } from "@reelforge/remote";

// The phone's WebCrypto half, the very file the relay serves.
interface PhoneCrypto {
  deriveKeys(secret: string): Promise<{ token: string; key: webcrypto.CryptoKey }>;
  seal(key: webcrypto.CryptoKey, value: unknown): Promise<string>;
  unseal(key: webcrypto.CryptoKey, text: string): Promise<unknown>;
}
const phone = (await import(new URL("../../../apps/remote/public/crypto.js", import.meta.url).href)) as PhoneCrypto;

test("the Mac and the phone derive the same token and open what the other sealed", async () => {
  const secret = newSecret();
  assert.match(secret, /^[A-Za-z0-9_-]{43}$/);
  const mac = deriveKeys(secret);
  const ph = await phone.deriveKeys(secret);
  assert.equal(ph.token, mac.token);
  assert.match(mac.authHash, /^[0-9a-f]{64}$/);
  assert.notEqual(mac.authHash, mac.token, "the relay gets a hash, not the token");

  const value = { t: "snapshot", projects: [{ name: "Café ✨ \u0000 \"quoted\"" }], n: 1.5 };
  assert.deepEqual(await phone.unseal(ph.key, seal(mac.key, value)), value);
  assert.deepEqual(unseal(mac.key, await phone.seal(ph.key, value)), value);
});

test("a different secret, or one changed byte, can't be opened", async () => {
  const a = deriveKeys(newSecret());
  const b = deriveKeys(newSecret());
  const sealed = seal(a.key, { hello: 1 });
  assert.throws(() => unseal(b.key, sealed));
  const raw = Buffer.from(sealed, "base64");
  raw[14]! ^= 1;
  assert.throws(() => unseal(a.key, raw.toString("base64")));
  assert.throws(() => unseal(a.key, "c2hvcnQ="), /too short/);
  const ph = await phone.deriveKeys("x".repeat(40));
  await assert.rejects(phone.unseal(ph.key, sealed));
});
