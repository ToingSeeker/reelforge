import { useEffect, useMemo, useRef, useState } from "react";
import qrcode from "qrcode-generator";
import type { Client, EngineInfo, RemoteStatus } from "../api.ts";
import type { Notify } from "../editor.ts";
import { Icon } from "../icons.tsx";
import { backgroundEngine, type BackgroundEngineStatus } from "../native.ts";

/**
 * Settings → Remote Access: let the ReelForge Remote phone app reach this Mac through the owner's relay.
 *
 * With Remote Access on, the engine runs as a background service (a launchd agent the desktop shell
 * installs), so it keeps working with the editor window closed or the editor quit. Phones pair with a
 * one-time code; each gets its own credential, which can be revoked here. Everything that passes through
 * the relay is encrypted on this Mac or the phone.
 */
export function RemoteAccessSettings({ client, notify, onLoaded }: { client: Client | null; notify: Notify; onLoaded?: () => void }) {
  const [st, setSt] = useState<RemoteStatus | null>(null);
  const [engine, setEngine] = useState<EngineInfo | null>(null);
  const [bg, setBg] = useState<BackgroundEngineStatus | null>(null);
  const [unavailable, setUnavailable] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [url, setUrl] = useState("");
  const [copied, setCopied] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const loaded = useRef(false);
  const shell = backgroundEngine.supported();

  const load = async () => {
    if (!client) return;
    try {
      const [s, e, b] = await Promise.all([client.remote(), client.engine().catch(() => null), backgroundEngine.status().catch(() => null)]);
      setSt(s);
      setEngine(e);
      setBg(b);
      setUnavailable(null);
      if (!loaded.current) {
        loaded.current = true;
        setUrl(s.settings.url ?? "");
        onLoaded?.();
      }
    } catch (e) {
      setUnavailable(e instanceof Error ? e.message : String(e));
    }
  };

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 2000);
    return () => clearInterval(t);
  }, [client]);

  // The pairing countdown ticks every second while a code is open.
  const pairingOpen = st?.pairing?.state === "open" || st?.pairing?.state === "answered";
  useEffect(() => {
    if (!pairingOpen) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [pairingOpen]);

  const act = async (fn: () => Promise<unknown>, done?: string) => {
    setBusy(true);
    try {
      const r = await fn();
      if (r && typeof r === "object" && "state" in r && "relayAuth" in r) setSt(r as RemoteStatus);
      if (done) notify("info", done);
    } catch (e) {
      notify("error", e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      await load();
    }
  };

  const copy = async (what: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(what);
      setTimeout(() => setCopied((c) => (c === what ? null : c)), 1500);
    } catch {
      notify("error", "Couldn't copy; select the text and copy it yourself.");
    }
  };

  if (!client) return null;
  if (unavailable) {
    return (
      <section className="rf-settings-group">
        <h3>Remote Access</h3>
        <p className="rf-hint">Remote Access isn't available from this engine ({unavailable}). Restart ReelForge to update the engine.</p>
      </section>
    );
  }
  if (!st) return null;

  const trimmed = url.trim().replace(/\/+$/, "");
  const urlOk = /^https:\/\/[^/\s]+$/.test(trimmed) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(trimmed);
  // On = the remote connects (and, in the app, the engine runs as a background service).
  const enabled = st.settings.autoStart && (!shell || !!bg?.installed);
  const remoteLabel =
    st.state === "online" ? "Connected to your relay" : st.state === "connecting" ? "Connecting to the relay…" : st.state === "error" ? "The relay refused this Mac" : "Off";

  const enable = () =>
    act(async () => {
      // The remote's settings (relay, auto-start) live in the shared state folder, so the background
      // engine picks them up when it starts. Then the editor moves onto it and reloads.
      const s = await client.startRemote({ url: trimmed });
      if (shell) {
        await backgroundEngine.setEnabled(true, bg?.startAtLogin ?? true);
        window.location.reload();
      }
      return s;
    }, shell ? undefined : "Remote Access is on.");

  const disable = () =>
    act(async () => {
      const s = await client.stopRemote();
      if (shell && bg?.installed) {
        await backgroundEngine.setEnabled(false, false);
        window.location.reload();
      }
      return s;
    }, shell ? undefined : "Remote Access is off.");

  const p = st.pairing;
  const secondsLeft = p ? Math.max(0, Math.round((Date.parse(p.expiresAt) - now) / 1000)) : 0;
  const ready = st.remoteReady;

  return (
    <section className="rf-settings-group rf-connector rf-remote" id="rf-remote-access" aria-labelledby="rf-remote-access-title">
      <h3 id="rf-remote-access-title">Remote Access</h3>
      <p className="rf-hint">
        Send editing instructions, follow jobs, review versions and download exports from the ReelForge Remote app on your phone, over the internet through your own relay. Everything
        is encrypted on this Mac or the phone; the relay can't read it.
      </p>

      <div className="rf-connector-status">
        <span className={`rf-dot ${st.state === "online" ? "is-on" : st.state === "connecting" ? "is-busy" : st.state === "error" ? "is-warn" : ""}`} aria-hidden />
        <span>
          {remoteLabel}
          {st.state === "connecting" && st.lastConnected ? ` · last connected ${ago(st.lastConnected, now)}` : ""}
        </span>
      </div>
      {st.error && st.state !== "online" && <p className="rf-hint rf-connector-error">{st.error}</p>}

      <label className="rf-connector-field">
        <span>Relay address</span>
        <div className="rf-key-row">
          <input
            className="rf-input rf-mono"
            placeholder="https://your-relay.up.railway.app"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            aria-label="Relay address"
            spellCheck={false}
          />
          {enabled && trimmed !== (st.settings.url ?? "") && (
            <button type="button" className="rf-btn" disabled={busy || !urlOk} onClick={() => void act(() => client.startRemote({ url: trimmed }), "Relay address saved.")}>
              Save
            </button>
          )}
        </div>
      </label>

      <label className="rf-switch-row">
        <input
          type="checkbox"
          className="rf-switch"
          checked={enabled}
          disabled={busy || (!enabled && !urlOk)}
          onChange={(e) => void (e.target.checked ? enable() : disable())}
        />
        Enable Remote Access
      </label>
      {shell ? (
        <p className="rf-hint">
          {enabled
            ? "The ReelForge Engine runs in the background: closing this window or quitting the editor doesn't stop it. Use Stop Engine & Disconnect below to stop it."
            : "Turning this on moves the engine to a background service so the phone can reach this Mac with the editor closed."}
        </p>
      ) : (
        <p className="rf-hint">Browser dev mode: only the relay connection is controlled here. The background service, Start at Login and Stop Engine are in the desktop app.</p>
      )}

      {shell && (
        <label className="rf-switch-row">
          <input
            type="checkbox"
            className="rf-switch"
            checked={!!bg?.startAtLogin}
            disabled={busy || !bg?.installed}
            onChange={(e) => void act(() => backgroundEngine.setStartAtLogin(e.target.checked), e.target.checked ? "The engine will start when you log in." : "The engine won't start at login.")}
          />
          Start Engine at Login
        </label>
      )}

      <label className="rf-switch-row">
        <input type="checkbox" className="rf-switch" checked={ready.enabled} disabled={busy} onChange={(e) => void act(() => client.setRemoteReady(e.target.checked))} />
        Remote Ready
      </label>
      <p className="rf-hint">
        {!ready.enabled
          ? "Off: this Mac sleeps as usual, and the phone sees it as unavailable while it does."
          : !enabled
            ? "On, but it applies only while Remote Access is on."
            : ready.power === "battery"
              ? "On battery: macOS will still sleep. Remote Ready works on power."
              : ready.active
                ? "Keeping this Mac awake while on power."
                : "Not active yet."}{" "}
        The display may still sleep. A closed laptop lid still sleeps the Mac unless it's in clamshell mode with an external display.
      </p>

      <div className="rf-connector-field">
        <span>Paired devices</span>
        {st.devices.length === 0 ? (
          <p className="rf-hint">No phones yet.</p>
        ) : (
          <ul className="rf-remote-devices">
            {st.devices.map((d) => (
              <li key={d.id}>
                <Icon name="phone" size={14} />
                <span className="rf-remote-device-name">{d.name}</span>
                <span className="rf-hint">
                  {d.confirmed ? (d.lastSeenAt ? `seen ${ago(d.lastSeenAt, now)}` : "paired") : "waiting for the phone to confirm"}
                  {d.notifications ? " · notifications on" : ""}
                </span>
                <button
                  type="button"
                  className="rf-link-btn"
                  disabled={busy}
                  onClick={() => {
                    if (window.confirm(`Revoke ${d.name}? It stops reaching this Mac at once; pair it again to use it.`)) void act(() => client.revokeDevice(d.id), `${d.name} can no longer reach this Mac.`);
                  }}
                >
                  Revoke
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="rf-connector-field">
        <span>Pair a phone</span>
        {p && (p.state === "open" || p.state === "answered") ? (
          <div className="rf-remote-pair">
            <PairingQr text={p.link} />
            <div className="rf-remote-pair-side">
              <p className="rf-hint">On your phone, open the relay address (or the ReelForge Remote app), tap Scan QR code and point it here, or type the code:</p>
              <code className="rf-remote-code" aria-label={`Pairing code ${p.code}`}>
                {p.code}
              </code>
              <p className="rf-hint" aria-live="polite">
                {p.state === "answered" ? `Confirm on your phone${p.deviceName ? ` (${p.deviceName})` : ""}.` : `Works once, for ${formatCountdown(secondsLeft)}.`}
              </p>
              <button type="button" className="rf-btn" disabled={busy} onClick={() => void act(() => client.cancelPairing())}>
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <>
            {p?.state === "paired" && <p className="rf-hint">Paired with {p.deviceName ?? "your phone"}.</p>}
            {p?.state === "expired" && <p className="rf-hint">That code expired.</p>}
            {p?.state === "failed" && <p className="rf-hint rf-connector-error">Pairing failed: {p.error ?? "the code didn't match"}. Make a new code.</p>}
            <div className="rf-key-row">
              <button type="button" className="rf-btn rf-btn-primary" disabled={busy || st.state !== "online"} onClick={() => void act(() => client.startPairing())}>
                {st.devices.length ? "Pair another phone" : "Pair a phone"}
              </button>
            </div>
            {st.state !== "online" && <p className="rf-hint">Pairing goes through the relay: turn Remote Access on and wait until it's connected.</p>}
          </>
        )}
      </div>

      <div className="rf-connector-field">
        <span>Engine</span>
        <p className="rf-hint">
          {engine?.background || st.engine.background
            ? "Running in the background"
            : st.engine.mode === "standalone"
              ? "Started by hand (reelforge serve)"
              : "Running inside the editor (stops when the editor quits)"}
          {engine ? ` · pid ${engine.pid}` : ""} · version {st.engine.version} · started {ago(st.engine.startedAt, now)} · editor {st.editor}
        </p>
      </div>

      <details className="rf-connector-advanced">
        <summary>Open connection diagnostics</summary>
        <p className="rf-hint">
          Relay: {st.settings.url ?? "not set"} · state {st.state}
          {st.lastConnected ? ` · last connected ${ago(st.lastConnected, now)}` : ""}
        </p>
        {st.error && <p className="rf-hint">Last error: {st.error}</p>}
        {bg && (
          <p className="rf-hint">
            Background service: {bg.installed ? "installed" : "not installed"} · {bg.running ? `running (pid ${bg.pid})` : "not running"} · editor {bg.attached ? "uses it" : "uses its own engine"} · log{" "}
            <code>{bg.logPath}</code>
          </p>
        )}
        <label className="rf-connector-field">
          <span>Relay access value: set it on the relay as REELFORGE_REMOTE_AUTH (e.g. the Railway service's variables)</span>
          <div className="rf-key-row">
            <input className="rf-input rf-mono" readOnly value={st.relayAuth} onFocus={(e) => e.currentTarget.select()} aria-label="REELFORGE_REMOTE_AUTH value" />
            <button type="button" className="rf-btn" onClick={() => void copy("auth", st.relayAuth)}>
              <Icon name={copied === "auth" ? "check" : "copy"} size={14} /> {copied === "auth" ? "Copied" : "Copy"}
            </button>
          </div>
        </label>
        <p className="rf-hint">It's a hash: it lets this Mac in, and reveals nothing the relay could read your projects with.</p>
      </details>

      {shell && (
        <div className="rf-key-row">
          <button
            type="button"
            className="rf-btn"
            disabled={busy || !bg?.attached}
            onClick={() => {
              if (window.confirm("Stop the ReelForge Engine and disconnect? Phones can't reach this Mac until you turn Remote Access on again. The editor keeps working with its own engine."))
                void act(() => backgroundEngine.stop());
            }}
          >
            <Icon name="stop" size={14} /> Stop Engine & Disconnect
          </button>
        </div>
      )}
    </section>
  );
}

function ago(iso: string, now: number): string {
  const s = Math.max(0, (now - Date.parse(iso)) / 1000);
  if (!Number.isFinite(s)) return "—";
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString();
}

function formatCountdown(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** The pairing link as a QR code: one SVG path, dark on light so every phone camera reads it. */
function PairingQr({ text }: { text: string }) {
  const { size, d } = useMemo(() => {
    const qr = qrcode(0, "M");
    qr.addData(text);
    qr.make();
    const n = qr.getModuleCount();
    let path = "";
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) path += `M${c + 4} ${r + 4}h1v1h-1z`;
    return { size: n + 8, d: path };
  }, [text]);
  return (
    <svg className="rf-remote-qr" viewBox={`0 0 ${size} ${size}`} role="img" aria-label="Pairing QR code" shapeRendering="crispEdges">
      <rect width={size} height={size} fill="#fff" />
      <path d={d} fill="#0b1a15" />
    </svg>
  );
}
