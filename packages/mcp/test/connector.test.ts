import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { openDatabase } from "@reelforge/core";
import { startRemoteConnector } from "@reelforge/mcp";
import { isPrivateAddress } from "../src/remote/fetch.ts";
import { ConnectorAuth, OAuthError } from "../src/remote/auth.ts";
import { fixtures } from "../../media/test/fixtures.ts";

const PAIRING = "ABCD2345";
const json = (r: Response): Promise<any> => r.json();
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";

async function start(t: { after: (fn: () => unknown) => void }) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "reelforge-conn-")));
  const db = openDatabase(join(home, "reelforge.db"));
  const conn = await startRemoteConnector({ db, dir: join(home, "connector"), cacheDir: join(home, "cache"), port: 0, pairingCode: PAIRING });
  t.after(async () => {
    await conn.close();
    db.close();
    rmSync(home, { recursive: true, force: true });
  });
  return { conn, home, base: conn.localUrl };
}

/** The OAuth dance a connector client does: register, authorize (the user types the pairing code), exchange. */
async function authorize(base: string, code = PAIRING) {
  const reg = await json(await fetch(`${base}/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "Claude", redirect_uris: [REDIRECT] }) }));
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const q = new URLSearchParams({ response_type: "code", client_id: reg.client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: "S256", state: "xyz" });
  const pageRes = await fetch(`${base}/authorize?${q}`);
  assert.equal(pageRes.status, 200);
  const html = await pageRes.text();
  assert.match(html, /access key/);
  const formToken = /name="form_token" value="([^"]+)"/.exec(html)![1]!;
  const post = await fetch(`${base}/authorize`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ...Object.fromEntries(q), form_token: formToken, pairing_code: code, decision: "allow" }),
    redirect: "manual",
  });
  if (post.status !== 302) return { status: post.status, clientId: reg.client_id as string };
  const loc = new URL(post.headers.get("location")!);
  assert.equal(loc.origin + loc.pathname, REDIRECT);
  assert.equal(loc.searchParams.get("state"), "xyz");
  const cookie = post.headers.get("set-cookie")!.split(";")[0]!;
  const tok = await json(await fetch(`${base}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code: loc.searchParams.get("code")!, code_verifier: verifier, client_id: reg.client_id, redirect_uri: REDIRECT }),
    }));
  return { status: 302, clientId: reg.client_id as string, token: tok.access_token as string, refresh: tok.refresh_token as string, cookie, code: loc.searchParams.get("code")!, verifier };
}

async function mcpClient(t: { after: (fn: () => unknown) => void }, base: string, token: string) {
  const client = new Client({ name: "claude-ai", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  t.after(() => client.close());
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
    return { data: JSON.parse(r.content[0]!.text), isError: !!r.isError };
  };
  return { client, call };
}

async function until<T>(fn: () => Promise<T>, done: (v: T) => boolean, ms = 90_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (done(v) || Date.now() > end) return v;
    await new Promise((r) => setTimeout(r, 200));
  }
}

test("connector: OAuth discovery, PKCE, and no MCP without a token", async (t) => {
  const { base } = await start(t);
  const unauth = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(unauth.status, 401);
  assert.match(unauth.headers.get("www-authenticate")!, /resource_metadata="http:\/\/127\.0\.0\.1:\d+\/\.well-known\/oauth-protected-resource\/mcp"/);
  const prm = await json(await fetch(`${base}/.well-known/oauth-protected-resource/mcp`));
  assert.equal(prm.resource, `${base}/mcp`);
  const meta = await json(await fetch(`${base}/.well-known/oauth-authorization-server`));
  assert.deepEqual(meta.code_challenge_methods_supported, ["S256"]);

  // A wrong pairing code doesn't authorize.
  const wrong = await authorize(base, "ZZZZ9999");
  assert.equal(wrong.status, 400);

  const ok = await authorize(base);
  assert.ok(ok.token);
  // Codes are single use; a wrong verifier fails.
  const replay = await fetch(`${base}/token`, { method: "POST", body: new URLSearchParams({ grant_type: "authorization_code", code: ok.code!, code_verifier: ok.verifier!, client_id: ok.clientId }) });
  assert.equal(replay.status, 400);
  // Refresh rotates: the old refresh token stops working.
  const r1 = await json(await fetch(`${base}/token`, { method: "POST", body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: ok.refresh!, client_id: ok.clientId }) }));
  assert.ok(r1.access_token);
  const r2 = await fetch(`${base}/token`, { method: "POST", body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: ok.refresh!, client_id: ok.clientId }) });
  assert.equal(r2.status, 400);

  // An unregistered redirect is refused without redirecting.
  const evil = await fetch(`${base}/authorize?${new URLSearchParams({ response_type: "code", client_id: ok.clientId, redirect_uri: "https://evil.example/cb", code_challenge: "x".repeat(43), code_challenge_method: "S256" })}`, { redirect: "manual" });
  assert.equal(evil.status, 400);

  // DNS rebinding: a foreign Host is refused.
  const { request } = await import("node:http");
  const status = await new Promise<number>((resolve) => request(`${base}/.well-known/oauth-authorization-server`, { headers: { host: "evil.example" } }, (res) => resolve(res.statusCode!)).end());
  assert.equal(status, 421);
});

test("connector: upload → propose → the user approves on the page → render → download", { timeout: 240_000 }, async (t) => {
  const { base } = await start(t);
  const auth = await authorize(base);
  const { client, call } = await mcpClient(t, base, auth.token!);
  const f = fixtures();

  const tools = (await client.listTools()).tools;
  const names = tools.map((x) => x.name);
  for (const n of ["media_add_file", "media_add_from_url", "media_upload_link", "media_upload_status", "render_start", "timeline_apply_proposal"]) assert.ok(names.includes(n), `missing ${n}`);
  for (const n of ["media_import", "workflows_run"]) assert.ok(!names.includes(n), `${n} must not be offered remotely`);
  assert.deepEqual(tools.find((x) => x.name === "media_add_file")!._meta?.["openai/fileParams"], ["file"]);

  const project = (await call("projects_create", { name: "Remote reel", width: 270, height: 480 })).data.project;

  // Local and private URLs are refused before anything is fetched.
  for (const url of ["https://127.0.0.1/x.mp4", "http://example.com/x.mp4", "https://localhost/x.mp4", "https://[::1]/x.mp4", "https://10.1.2.3/a.mp4"]) {
    const r = await call("media_add_from_url", { projectId: project.id, url });
    assert.equal(r.isError, true, url);
  }

  const link = (await call("media_upload_link", { projectId: project.id })).data;
  assert.match(link.url, /\/upload\/[0-9a-f-]{36}\?e=\d+&s=/);
  assert.equal((await call("media_upload_status", { uploadId: link.uploadId })).data.state, "waiting");
  const page = await fetch(link.url);
  assert.match(await page.text(), /Remote reel/);
  // A tampered signature is refused.
  assert.equal((await fetch(link.url.replace(/s=./, "s=A"), { method: "PUT", body: "x" })).status, 403);
  const put = await fetch(link.url, { method: "PUT", headers: { "x-file-name": "../../evil/clip.mp4" }, body: readFileSync(f.portrait) });
  assert.equal(put.status, 200, await put.clone().text());
  const status = (await call("media_upload_status", { uploadId: link.uploadId })).data;
  assert.equal(status.state, "imported");
  assert.equal(status.imported[0].name, "clip.mp4", "path parts are stripped");
  assert.equal((await fetch(link.url, { method: "PUT", headers: { "x-file-name": "b.mp4" }, body: "x" })).status, 409, "one upload per link");

  const ctx = (await call("timeline_get", { projectId: project.id })).data.context;
  const v1 = ctx.timeline.tracks.find((x: any) => x.label === "V1").id;
  const proposed = (await call("timeline_propose_edit", { projectId: project.id, summary: "Open on the uploaded clip", operations: [{ type: "clip.add", trackId: v1, assetId: status.imported[0].assetId, start: 0, duration: 30 }] })).data;
  const ask = (await call("timeline_apply_proposal", { proposalId: proposed.proposalId })).data;
  assert.equal(ask.status, "approval_required");
  assert.match(ask.approvalUrl, /\/approve\//);

  // The model has the link, but not the pairing code or the user's browser: it can't apply its own edit.
  const html = await (await fetch(ask.approvalUrl)).text();
  assert.match(html, /Open on the uploaded clip/);
  const formToken = /name="form_token" value="([^"]+)"/.exec(html)![1]!;
  const sneaky = await fetch(ask.approvalUrl, { method: "POST", body: new URLSearchParams({ form_token: formToken, decision: "apply" }) });
  assert.match(await sneaky.text(), /access key is not right/);
  assert.equal((await call("timeline_get_proposal", { proposalId: proposed.proposalId })).data.status, "pending");

  // The user's browser (it entered the pairing code when connecting) applies it.
  const applied = await fetch(ask.approvalUrl, { method: "POST", headers: { cookie: auth.cookie! }, body: new URLSearchParams({ form_token: formToken, decision: "apply" }) });
  assert.match(await applied.text(), /Applied/);
  assert.equal((await call("timeline_get_proposal", { proposalId: proposed.proposalId })).data.status, "applied");

  const job = (await call("render_start", { projectId: project.id })).data;
  const done = await until(() => call("jobs_get", { jobId: job.jobId }), (r) => ["completed", "failed", "cancelled"].includes(r.data.state));
  assert.equal(done.data.state, "completed", JSON.stringify(done.data));
  assert.equal(done.data.outputPath, undefined, "no local paths for remote clients");
  const dl = await fetch(done.data.downloadUrl);
  assert.equal(dl.status, 200);
  assert.equal(dl.headers.get("content-type"), "video/mp4");
  const bytes = Buffer.from(await dl.arrayBuffer());
  assert.equal(bytes.subarray(4, 8).toString(), "ftyp");
  const part = await fetch(done.data.downloadUrl, { headers: { range: "bytes=0-99" } });
  assert.equal(part.status, 206);
  assert.equal((await part.arrayBuffer()).byteLength, 100);
  const outs = (await call("outputs_get", { projectId: project.id })).data.outputs;
  assert.equal(outs.length, 1);
  assert.ok(outs[0].downloadUrl);
});

test("private address check", () => {
  for (const a of ["127.0.0.1", "10.0.0.5", "192.168.1.1", "172.20.0.1", "169.254.169.254", "::1", "fe80::1", "fd00::1", "::ffff:127.0.0.1", "100.100.1.1", "0.0.0.0"]) assert.equal(isPrivateAddress(a), true, a);
  for (const a of ["8.8.8.8", "1.1.1.1", "2606:4700::1111"]) assert.equal(isPrivateAddress(a), false, a);
});

test("connector: open registration never evicts an app that finished authorizing", () => {
  const dir = mkdtempSync(join(tmpdir(), "rf-auth-"));
  try {
    const auth = new ConnectorAuth(join(dir, "auth.json"));
    const reg = () => auth.register({ redirect_uris: ["https://attacker.example/cb"], client_name: "x" });
    const connect = () => {
      const c = auth.register({ redirect_uris: ["https://claude.ai/cb"], client_name: "Claude" });
      const verifier = randomBytes(32).toString("base64url");
      const code = auth.issueCode(c.clientId, "https://claude.ai/cb", createHash("sha256").update(verifier).digest("base64url"));
      return { id: c.clientId, ...auth.exchange(new URLSearchParams({ grant_type: "authorization_code", client_id: c.clientId, code, code_verifier: verifier })) };
    };
    const a = connect();
    const b = connect();
    // Fill the table, then keep registering: only never-authorized clients make room.
    for (let i = 0; i < 48; i++) reg();
    for (let i = 0; i < 60; i++) reg();
    assert.ok(auth.verifyAccessToken(a.access_token), "A still connected");
    assert.ok(auth.verifyAccessToken(b.access_token), "B still connected");
    assert.ok(auth.exchange(new URLSearchParams({ grant_type: "refresh_token", client_id: b.id, refresh_token: b.refresh_token })).access_token);
    // A table full of connected apps refuses new registrations instead of dropping one.
    const full = new ConnectorAuth(join(dir, "full.json"));
    const keep: string[] = [];
    for (let i = 0; i < 50; i++) {
      const c = full.register({ redirect_uris: ["https://claude.ai/cb"] });
      const verifier = randomBytes(32).toString("base64url");
      const code = full.issueCode(c.clientId, "https://claude.ai/cb", createHash("sha256").update(verifier).digest("base64url"));
      keep.push(full.exchange(new URLSearchParams({ grant_type: "authorization_code", client_id: c.clientId, code, code_verifier: verifier })).access_token);
    }
    assert.throws(() => full.register({ redirect_uris: ["https://attacker.example/cb"] }), (e: unknown) => e instanceof OAuthError && e.status === 429);
    assert.ok(keep.every((tok) => full.verifyAccessToken(tok)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
