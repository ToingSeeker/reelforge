// OAuth 2.1 for the remote connector (what Claude and ChatGPT expect from a remote MCP server):
// dynamic client registration, authorization code + PKCE (S256 only), refresh token rotation.
// The authorize page is on the public internet, so it asks for an access key that only the
// person at this machine can see (in ReelForge Settings, or printed by `reelforge connector`).
// The key persists across restarts until the user generates a new one. Tokens are stored hashed.

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const ACCESS_TTL = 60 * 60 * 1000;
const REFRESH_TTL = 60 * 24 * 60 * 60 * 1000;
const CODE_TTL = 5 * 60 * 1000;
const OWNER_TTL = 180 * 24 * 60 * 60 * 1000;
const MAX_CLIENTS = 50;
/** Wrong access keys before the key stops working until a new one is generated (or the connector restarts). */
const MAX_PAIRING_FAILURES = 10;

interface ClientRecord {
  clientId: string;
  clientName: string;
  redirectUris: string[];
  createdAt: number;
}

interface TokenRecord {
  hash: string;
  kind: "access" | "refresh";
  clientId: string;
  exp: number;
}

interface State {
  version: 1;
  /** HMAC key for signed links and form tokens. */
  secret: string;
  clients: ClientRecord[];
  tokens: TokenRecord[];
  /** Browsers that entered the access key (hashed cookie values). */
  owners: { hash: string; exp: number }[];
  /** The access key the user types when connecting an app (XXXX-XXXX). Older files lack it. */
  pairingCode?: string;
}

interface PendingCode {
  clientId: string;
  redirectUri: string;
  challenge: string;
  exp: number;
}

// Unambiguous characters, grouped for reading aloud: XXXX-XXXX.
const KEY_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const formatKey = (raw: string) => (raw.length === 8 ? `${raw.slice(0, 4)}-${raw.slice(4)}` : raw);
const newKey = () => formatKey(Array.from(randomBytes(8), (b) => KEY_ALPHABET[b % KEY_ALPHABET.length]).join(""));

const sha = (s: string) => createHash("sha256").update(s).digest("base64url");
const token = (bytes = 32) => randomBytes(bytes).toString("base64url");

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export class OAuthError extends Error {
  readonly error: string;
  readonly description: string;
  readonly status: number;
  constructor(error: string, description: string, status = 400) {
    super(description);
    this.error = error;
    this.description = description;
    this.status = status;
  }
}

export class ConnectorAuth {
  readonly #file: string;
  #state: State;
  readonly #codes = new Map<string, PendingCode>();
  #pairingFailures = 0;

  constructor(stateFile: string, pairingCode?: string) {
    this.#file = stateFile;
    this.#state = existsSync(stateFile) ? (JSON.parse(readFileSync(stateFile, "utf8")) as State) : { version: 1, secret: token(32), clients: [], tokens: [], owners: [] };
    if (pairingCode) this.#state.pairingCode = formatKey(pairingCode);
    else if (!this.#state.pairingCode) this.#state.pairingCode = newKey();
    this.#save();
  }

  /** The access key; shown to the user (Settings, terminal), never sent to a client. */
  get pairingCode(): string {
    return this.#state.pairingCode!;
  }

  /** Replace the access key. Apps already connected keep working; new ones need the new key. */
  rotatePairingCode(): string {
    this.#state.pairingCode = newKey();
    this.#pairingFailures = 0;
    this.#save();
    return this.pairingCode;
  }

  get secret(): Buffer {
    return Buffer.from(this.#state.secret, "base64url");
  }

  #save(): void {
    const now = Date.now();
    this.#state.tokens = this.#state.tokens.filter((t) => t.exp > now);
    this.#state.owners = this.#state.owners.filter((o) => o.exp > now);
    mkdirSync(dirname(this.#file), { recursive: true, mode: 0o700 });
    const tmp = `${this.#file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.#state, null, 2), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.#file);
  }

  /** Forget every client, token and paired browser, and issue a new access key (`reelforge connector revoke`). */
  revokeAll(): void {
    this.#state = { version: 1, secret: token(32), clients: [], tokens: [], owners: [], pairingCode: newKey() };
    this.#codes.clear();
    this.#pairingFailures = 0;
    this.#save();
  }

  connections(): { clientName: string; createdAt: string; active: boolean }[] {
    const now = Date.now();
    return this.#state.clients.map((c) => ({
      clientName: c.clientName,
      createdAt: new Date(c.createdAt).toISOString(),
      active: this.#state.tokens.some((t) => t.clientId === c.clientId && t.exp > now),
    }));
  }

  // ---- access key -----------------------------------------------------------

  /** Check an access key typed into one of our pages. Locks after repeated failures. */
  checkPairingCode(input: string): boolean {
    if (this.#pairingFailures >= MAX_PAIRING_FAILURES) throw new OAuthError("access_denied", "Too many wrong access keys. Generate a new key in ReelForge Settings → Claude & ChatGPT.", 429);
    const normalized = input.toUpperCase().replace(/[^A-Z0-9]/g, "");
    const ok = safeEqual(normalized, this.pairingCode.replace(/-/g, ""));
    if (!ok) this.#pairingFailures++;
    return ok;
  }

  /** A browser that entered the access key may approve edits without typing it again. */
  newOwnerCookie(): { value: string; maxAgeSeconds: number } {
    const value = token(32);
    this.#state.owners.push({ hash: sha(value), exp: Date.now() + OWNER_TTL });
    this.#save();
    return { value, maxAgeSeconds: OWNER_TTL / 1000 };
  }

  isOwner(cookieValue: string | undefined): boolean {
    if (!cookieValue) return false;
    const h = sha(cookieValue);
    return this.#state.owners.some((o) => o.exp > Date.now() && safeEqual(o.hash, h));
  }

  // ---- form tokens (CSRF) -------------------------------------------------------

  formToken(purpose: string): string {
    return createHmac("sha256", this.secret).update(`form:${purpose}`).digest("base64url");
  }

  checkFormToken(purpose: string, value: string | undefined): boolean {
    return !!value && safeEqual(value, this.formToken(purpose));
  }

  // ---- registration (RFC 7591) ------------------------------------------------------

  register(body: unknown): ClientRecord & { tokenEndpointAuthMethod: "none" } {
    const b = (body ?? {}) as { redirect_uris?: unknown; client_name?: unknown };
    if (!Array.isArray(b.redirect_uris) || !b.redirect_uris.length || b.redirect_uris.length > 10) throw new OAuthError("invalid_redirect_uri", "redirect_uris must list 1–10 URIs");
    const uris = b.redirect_uris.map((u) => {
      if (typeof u !== "string") throw new OAuthError("invalid_redirect_uri", "redirect URIs must be strings");
      let url: URL;
      try {
        url = new URL(u);
      } catch {
        throw new OAuthError("invalid_redirect_uri", `not a URL: ${u.slice(0, 100)}`);
      }
      const local = url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1");
      if (url.protocol !== "https:" && !local) throw new OAuthError("invalid_redirect_uri", "redirect URIs must be https (or http://localhost)");
      if (url.hash) throw new OAuthError("invalid_redirect_uri", "redirect URIs must not have a fragment");
      return u;
    });
    const name = typeof b.client_name === "string" && b.client_name.trim() ? b.client_name.trim().slice(0, 80) : "An MCP client";
    const client: ClientRecord = { clientId: `rf_${token(16)}`, clientName: name, redirectUris: uris, createdAt: Date.now() };
    this.#state.clients.push(client);
    // Keep the newest clients; one that never finished authorizing doesn't hold a slot forever.
    if (this.#state.clients.length > MAX_CLIENTS) {
      const drop = this.#state.clients.splice(0, this.#state.clients.length - MAX_CLIENTS).map((c) => c.clientId);
      this.#state.tokens = this.#state.tokens.filter((t) => !drop.includes(t.clientId));
    }
    this.#save();
    return { ...client, tokenEndpointAuthMethod: "none" };
  }

  client(clientId: string | null | undefined): ClientRecord | undefined {
    return clientId ? this.#state.clients.find((c) => c.clientId === clientId) : undefined;
  }

  // ---- authorize & token ----------------------------------------------------------------

  /** Validate an authorization request before showing the consent page. Throws for a bad client/redirect (never redirect to an unregistered URI). */
  checkAuthorizeRequest(p: URLSearchParams): { client: ClientRecord; redirectUri: string } {
    const client = this.client(p.get("client_id"));
    if (!client) throw new OAuthError("invalid_client", "Unknown client. Remove the connector in your AI app and add it again.");
    const redirectUri = p.get("redirect_uri") ?? (client.redirectUris.length === 1 ? client.redirectUris[0]! : "");
    if (!client.redirectUris.includes(redirectUri)) throw new OAuthError("invalid_request", "The redirect URI is not registered for this client.");
    if (p.get("response_type") !== "code") throw new OAuthError("unsupported_response_type", "Only response_type=code is supported.");
    if (p.get("code_challenge_method") !== "S256" || !/^[A-Za-z0-9_-]{43,128}$/.test(p.get("code_challenge") ?? "")) {
      throw new OAuthError("invalid_request", "PKCE with code_challenge_method=S256 is required.");
    }
    return { client, redirectUri };
  }

  issueCode(clientId: string, redirectUri: string, challenge: string): string {
    const code = token(32);
    this.#codes.set(sha(code), { clientId, redirectUri, challenge, exp: Date.now() + CODE_TTL });
    return code;
  }

  exchange(params: URLSearchParams): { access_token: string; token_type: "Bearer"; expires_in: number; refresh_token: string; scope: string } {
    const grant = params.get("grant_type");
    const clientId = params.get("client_id") ?? "";
    if (!this.client(clientId)) throw new OAuthError("invalid_client", "unknown client", 401);
    if (grant === "authorization_code") {
      const key = sha(params.get("code") ?? "");
      const pending = this.#codes.get(key);
      this.#codes.delete(key); // single use, even when the exchange fails
      if (!pending || pending.exp < Date.now() || pending.clientId !== clientId) throw new OAuthError("invalid_grant", "the authorization code is invalid or expired");
      if (params.has("redirect_uri") && params.get("redirect_uri") !== pending.redirectUri) throw new OAuthError("invalid_grant", "redirect_uri does not match");
      const verifier = params.get("code_verifier") ?? "";
      if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || !safeEqual(createHash("sha256").update(verifier).digest("base64url"), pending.challenge)) {
        throw new OAuthError("invalid_grant", "PKCE verification failed");
      }
      return this.#issueTokens(clientId);
    }
    if (grant === "refresh_token") {
      const h = sha(params.get("refresh_token") ?? "");
      const rec = this.#state.tokens.find((t) => t.kind === "refresh" && t.clientId === clientId && t.exp > Date.now() && safeEqual(t.hash, h));
      if (!rec) throw new OAuthError("invalid_grant", "the refresh token is invalid or expired");
      this.#state.tokens = this.#state.tokens.filter((t) => t !== rec); // rotate
      return this.#issueTokens(clientId);
    }
    throw new OAuthError("unsupported_grant_type", "use authorization_code or refresh_token");
  }

  #issueTokens(clientId: string) {
    const access = token(32);
    const refresh = token(32);
    const now = Date.now();
    this.#state.tokens.push({ hash: sha(access), kind: "access", clientId, exp: now + ACCESS_TTL }, { hash: sha(refresh), kind: "refresh", clientId, exp: now + REFRESH_TTL });
    this.#save();
    return { access_token: access, token_type: "Bearer" as const, expires_in: ACCESS_TTL / 1000, refresh_token: refresh, scope: "reelforge" };
  }

  /** The client behind a bearer token, or undefined. */
  verifyAccessToken(bearer: string | undefined): ClientRecord | undefined {
    if (!bearer) return undefined;
    const h = sha(bearer);
    const rec = this.#state.tokens.find((t) => t.kind === "access" && t.exp > Date.now() && safeEqual(t.hash, h));
    return rec ? this.client(rec.clientId) : undefined;
  }
}
