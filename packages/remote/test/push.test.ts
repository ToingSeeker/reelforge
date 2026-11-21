import { test } from "node:test";
import assert from "node:assert/strict";
import { publicOnlyLookup } from "@reelforge/core";
import { checkEndpoint, encryptPayload, newVapidKeys, vapidAuthorization } from "@reelforge/remote";
import { browser, checkVapid } from "./webpush-browser.ts";

test("web push: only the subscribed browser can read the payload, and the VAPID token verifies", () => {
  const phone = browser();
  const vapid = newVapidKeys();
  assert.equal(Buffer.from(vapid.publicKey, "base64url").length, 65);

  const message = { title: "Export ready", body: "“Café Opening” · 38.2 MB", url: "/#/p/x" };
  const body = encryptPayload({ endpoint: "https://push.example.com/abc", keys: phone.keys }, Buffer.from(JSON.stringify(message)));
  assert.ok(!body.includes(Buffer.from("Café")), "the push service sees ciphertext only");
  assert.deepEqual(phone.decrypt(body), message);
  assert.throws(() => browser().decrypt(body), "another browser's keys can't open it");

  const now = Date.now();
  const claims = checkVapid(vapidAuthorization("https://web.push.apple.com/QGuQyavXutnMH", vapid, "https://relay.example.com", now), vapid.publicKey);
  assert.equal(claims.aud, "https://web.push.apple.com");
  assert.equal(claims.sub, "https://relay.example.com");
  assert.equal(claims.exp, Math.floor(now / 1000) + 12 * 3600);

  assert.throws(() => encryptPayload({ endpoint: "https://x.example.com", keys: { p256dh: "short", auth: phone.keys.auth } }, Buffer.from("{}")), /malformed/);
});

test("push endpoints: https on a public host only", () => {
  assert.equal(checkEndpoint("https://fcm.googleapis.com/fcm/send/abc"), "https://fcm.googleapis.com/fcm/send/abc");
  assert.equal(checkEndpoint("https://web.push.apple.com/QGuQ"), "https://web.push.apple.com/QGuQ");
  for (const bad of ["http://fcm.googleapis.com/x", "https://127.0.0.1/x", "https://localhost/x", "https://[::1]/x", "https://10.0.0.2/x", "https://router.local/x", "https://intranet/x", "https://u:p@push.example.com/x", "file:///etc/passwd", 42, "https://localhost./x", "https://printer.local./x", "https://push.example.com:8443/x", "https://push.example.com:22/x"]) {
    assert.throws(() => checkEndpoint(bad), /endpoint/, String(bad));
  }
  assert.throws(() => checkEndpoint("http://127.0.0.1:9/x"), /endpoint/);
  assert.equal(checkEndpoint("http://127.0.0.1:9/x", true), "http://127.0.0.1:9/x");
});

test("push delivery: a name that resolves to this Mac is refused when connecting, whatever the text check said", async () => {
  const lookup = publicOnlyLookup((host) => new Error(`${host} refused`));
  const resolve = (host: string) => new Promise<unknown>((res) => lookup(host, {}, (err, address) => res(err ?? address)));
  const r = await resolve("localhost");
  assert.ok(r instanceof Error && /refused/.test(r.message), String(r));
});
