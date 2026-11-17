import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "@reelforge/core";
import { ConnectorManager } from "@reelforge/mcp";

function setup(t: { after: (fn: () => unknown) => void }) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "reelforge-mgr-")));
  const db = openDatabase(join(home, "reelforge.db"));
  const managers: ConnectorManager[] = [];
  const make = () => {
    const m = new ConnectorManager({ db, dir: join(home, "connector"), cacheDir: join(home, "cache"), port: 0 });
    managers.push(m);
    return m;
  };
  t.after(async () => {
    for (const m of managers) await m.close();
    db.close();
    rmSync(home, { recursive: true, force: true });
  });
  return { home, make };
}

test("the access key persists, rotates, and the connector starts behind a user's own https URL", async (t) => {
  const { home, make } = setup(t);
  const m = make();
  const first = m.status();
  assert.equal(first.state, "stopped");
  assert.match(first.accessKey, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.equal(make().status().accessKey, first.accessKey, "same key across restarts");

  await assert.rejects(m.start({ tunnel: "none", publicUrl: "http://plain.example" }), /https origin/);
  const on = await m.start({ tunnel: "none", publicUrl: "https://rf.example.test/" });
  assert.equal(on.state, "running");
  assert.equal(on.mcpUrl, "https://rf.example.test/mcp");
  assert.equal(on.public, true);
  // The connector really listens.
  const meta = await fetch(`${on.localUrl}/.well-known/oauth-authorization-server`, { headers: { host: "rf.example.test" } });
  assert.equal(meta.status, 200);

  const rotated = m.rotateKey();
  assert.notEqual(rotated.accessKey, first.accessKey);
  assert.equal(make().status().accessKey, rotated.accessKey);

  const saved = JSON.parse(readFileSync(join(home, "connector", "settings.json"), "utf8"));
  assert.deepEqual(saved, { tunnel: "none", autoStart: true, publicUrl: "https://rf.example.test" });

  // Restarting the engine brings it back.
  await m.close();
  const again = make();
  await again.autoStart();
  assert.equal(again.status().state, "running");

  const off = await again.stop();
  assert.equal(off.state, "stopped");
  assert.equal(off.settings.autoStart, false);

  const revoked = again.revokeAll();
  assert.notEqual(revoked.accessKey, rotated.accessKey);
});

test("ngrok: waits for the tunnel URL, and reports when the tunnel dies", async (t) => {
  const { home, make } = setup(t);
  const fake = join(home, "fake-ngrok");
  writeFileSync(fake, `#!/bin/sh\necho '{"lvl":"info","msg":"started tunnel","url":"https://fake-123.ngrok-free.app"}'\nsleep 1\nexit 3\n`);
  chmodSync(fake, 0o755);
  const prev = process.env.REELFORGE_NGROK_BIN;
  process.env.REELFORGE_NGROK_BIN = fake;
  t.after(() => (prev === undefined ? delete process.env.REELFORGE_NGROK_BIN : (process.env.REELFORGE_NGROK_BIN = prev)));

  const m = make();
  const on = await m.start({ tunnel: "ngrok" });
  assert.equal(on.mcpUrl, "https://fake-123.ngrok-free.app/mcp");
  assert.equal(on.ngrokAvailable, true);
  // The fake tunnel exits after 1 s; poll rather than sleep a fixed time so a loaded machine can't race it.
  const deadline = Date.now() + 10_000;
  while (m.status().state !== "stopped" && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  const after = m.status();
  assert.equal(after.state, "stopped");
  assert.match(after.error ?? "", /ngrok tunnel stopped/);

  const failing = join(home, "bad-ngrok");
  writeFileSync(failing, `#!/bin/sh\necho '{"lvl":"eror","err":"authentication failed: ERR_NGROK_4018"}'\nexit 1\n`);
  chmodSync(failing, 0o755);
  process.env.REELFORGE_NGROK_BIN = failing;
  await assert.rejects(m.start({ tunnel: "ngrok" }), /add-authtoken/);
  assert.match(m.status().error ?? "", /ERR_NGROK_4018|authentication failed/);
});
