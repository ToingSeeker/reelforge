import { test } from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { deriveDeviceKeys, deriveKeys, newPairingCode, newSecret, normalisePairingCode, pairAnswer, seal, sealBytes, unseal, unsealBytes, verifyPairHello } from "@reelforge/remote";

type Key = webcrypto.CryptoKey;
// The phone's WebCrypto half, the very file the relay serves.
interface PhoneCrypto {
  deriveDeviceKeys(secret: string): Promise<{ token: string; key: Key }>;
  importBroadcastKey(b64: string): Promise<Key>;
  seal(key: Key, value: unknown, aad?: string): Promise<string>;
  unseal(key: Key, text: string, aad?: string): Promise<unknown>;
  sealBytes(key: Key, bytes: Uint8Array, aad: string): Promise<string>;
  unsealBytes(key: Key, text: string, aad: string): Promise<Uint8Array>;
  normalisePairingCode(input: string): string | null;
  pairPhone(code: string, name: string): Promise<{ lookup: string; hello: { pub: string; name: string; proof: string }; open(answer: unknown): Promise<Record<string, unknown>> }>;
}
const phone = (await import(new URL("../../../apps/remote/public/crypto.js", import.meta.url).href)) as PhoneCrypto;

test("the Mac and the phone derive the same device token and open what the other sealed, only with the same additional data", async () => {
  const secret = newSecret();
  assert.match(secret, /^[A-Za-z0-9_-]{43}$/);
  const mac = deriveDeviceKeys(secret);
  const ph = await phone.deriveDeviceKeys(secret);
  assert.equal(ph.token, mac.token);
  assert.match(mac.tokenHash, /^[0-9a-f]{64}$/);
  assert.notEqual(mac.tokenHash, mac.token, "the relay gets a hash, not the token");
  assert.notEqual(deriveKeys(secret).token, mac.token, "a device token is never a Mac token");

  const value = { t: "snapshot", projects: [{ name: "Café ✨ \u0000 \"quoted\"" }], n: 1.5 };
  assert.deepEqual(await phone.unseal(ph.key, seal(mac.key, value, "evt:d1"), "evt:d1"), value);
  assert.deepEqual(unseal(mac.key, await phone.seal(ph.key, value, "cmd:d1"), "cmd:d1"), value);
  // A command can't be replayed as an event, or as another phone's command.
  const cmd = await phone.seal(ph.key, value, "cmd:d1");
  assert.throws(() => unseal(mac.key, cmd, "evt:d1"));
  assert.throws(() => unseal(mac.key, cmd, "cmd:d2"));

  const bytes = new Uint8Array([0, 1, 2, 250, 255]);
  assert.deepEqual([...(await phone.unsealBytes(ph.key, sealBytes(mac.key, Buffer.from(bytes), "down:t:0"), "down:t:0"))], [...bytes]);
  assert.deepEqual([...unsealBytes(mac.key, await phone.sealBytes(ph.key, bytes, "up:u:3"), "up:u:3")], [...bytes]);
  await assert.rejects(phone.unsealBytes(ph.key, sealBytes(mac.key, Buffer.from(bytes), "down:t:0"), "down:t:1"), Error, "pieces can't be reordered");

  const broadcast = Buffer.alloc(32, 9);
  const bk = await phone.importBroadcastKey(broadcast.toString("base64"));
  assert.deepEqual(await phone.unseal(bk, seal(broadcast, { hi: 1 }, "evt"), "evt"), { hi: 1 });
});

test("a different secret, or one changed byte, can't be opened", async () => {
  const a = deriveDeviceKeys(newSecret());
  const b = deriveDeviceKeys(newSecret());
  const sealed = seal(a.key, { hello: 1 }, "evt");
  assert.throws(() => unseal(b.key, sealed, "evt"));
  const raw = Buffer.from(sealed, "base64");
  raw[14]! ^= 1;
  assert.throws(() => unseal(a.key, raw.toString("base64"), "evt"));
  assert.throws(() => unseal(a.key, "c2hvcnQ=", "evt"), /too short/);
});

test("pairing: the phone's WebCrypto exchange and the Mac's agree; a wrong code is refused on both sides", async () => {
  const { code, lookup, secret } = newPairingCode();
  assert.equal(normalisePairingCode(`${code.slice(0, 4).toLowerCase()} ${code.slice(4, 8)}-${code.slice(8)}`), code);
  assert.equal(phone.normalisePairingCode(code.match(/.{4}/g)!.join("-")), code);
  assert.equal(normalisePairingCode("0OIL0OIL0OIL0OIL"), null, "ambiguous characters are not in the alphabet");

  const ph = await phone.pairPhone(code, "iPhone");
  assert.equal(ph.lookup, lookup);
  const hello = verifyPairHello(secret, ph.hello);
  const payload = { macId: "m1", macName: "Studio Mac", deviceId: "d1", deviceSecret: newSecret(), broadcastKey: Buffer.alloc(32, 1).toString("base64") };
  const answer = pairAnswer(secret, hello, payload);
  assert.deepEqual(await ph.open(answer), payload);
  assert.ok(!JSON.stringify(answer).includes(payload.deviceSecret), "the device secret travels only inside the ECDH box");

  const other = newPairingCode();
  assert.throws(() => verifyPairHello(other.secret, ph.hello), /didn't match/);
  const forged = pairAnswer(other.secret, verifyPairHello(other.secret, (await phone.pairPhone(other.code, "x")).hello), payload);
  await assert.rejects(ph.open({ ...forged }), /didn’t match/);
});
