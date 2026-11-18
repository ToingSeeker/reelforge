import { useEffect, useMemo, useRef, useState } from "react";
import qrcode from "qrcode-generator";
import type { Client, RemoteStatus } from "../api.ts";
import type { Notify } from "../editor.ts";
import { Icon } from "../icons.tsx";

/**
 * Settings → Phone remote: connect this Mac to the owner's relay (Railway project `forge-remote`) and
 * pair a phone by QR. The relay gets only REELFORGE_REMOTE_AUTH (a hash); the pairing secret is in
 * the QR/link fragment and never reaches it.
 */
export function PhoneRemoteSettings({ client, notify }: { client: Client | null; notify: Notify }) {
  const [st, setSt] = useState<RemoteStatus | null>(null);
  const [unavailable, setUnavailable] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [url, setUrl] = useState("");
  const [copied, setCopied] = useState<string | null>(null);
  const loaded = useRef(false);

  const load = async () => {
    if (!client) return;
    try {
      const s = await client.remote();
      setSt(s);
      setUnavailable(null);
      if (!loaded.current) {
        loaded.current = true;
        setUrl(s.settings.url ?? "");
      }
    } catch (e) {
      setUnavailable(e instanceof Error ? e.message : String(e));
    }
  };

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 3000);
    return () => clearInterval(t);
  }, [client]);

  const act = async (fn: () => Promise<RemoteStatus>, done?: string) => {
    setBusy(true);
    try {
      setSt(await fn());
      if (done) notify("info", done);
    } catch (e) {
      notify("error", e instanceof Error ? e.message : String(e));
      await load();
    } finally {
      setBusy(false);
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
        <h3>Phone remote</h3>
        <p className="rf-hint">The phone remote isn't available in this engine ({unavailable}). Restart ReelForge to update the engine.</p>
      </section>
    );
  }
  if (!st) return null;

  const on = st.state === "online" || st.state === "connecting";
  const trimmed = url.trim().replace(/\/+$/, "");
  const urlOk = /^https:\/\/[^/\s]+$/.test(trimmed) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(trimmed);
  const changed = trimmed !== (st.settings.url ?? "");
  const label =
    st.state === "online" ? "On: connected to your relay" : st.state === "connecting" ? "Connecting to the relay…" : st.state === "error" ? "Stopped: the relay refused this Mac" : "Off";

  return (
    <section className="rf-settings-group rf-connector rf-remote">
      <h3>Phone remote</h3>
      <p className="rf-hint">Follow projects and exports from your phone, through your own relay, and get notified when an export is ready. Everything is encrypted on this Mac; the relay can't read it.</p>

      <div className="rf-connector-status">
        <span className={`rf-dot ${st.state === "online" ? "is-on" : st.state === "connecting" ? "is-busy" : st.state === "error" ? "is-warn" : ""}`} aria-hidden />
        <span>{label}</span>
        {on && !changed ? (
          <button type="button" className="rf-btn rf-connector-toggle" disabled={busy} onClick={() => void act(() => client.stopRemote(), "Phone remote stopped.")}>
            Stop
          </button>
        ) : (
          <button
            type="button"
            className="rf-btn rf-btn-primary rf-connector-toggle"
            disabled={busy || !urlOk}
            onClick={() =>
              void act(async () => {
                const s = await client.startRemote({ url: trimmed });
                setUrl(s.settings.url ?? trimmed); // the address as the engine saved it
                return s;
              })
            }
          >
            {on ? "Reconnect" : "Start"}
          </button>
        )}
      </div>
      {st.error && <p className="rf-hint rf-connector-error">{st.error}</p>}

      <label className="rf-connector-field">
        <span>1. Relay address</span>
        <div className="rf-key-row">
          <input
            className="rf-input rf-mono"
            placeholder="https://forge-remote-production.up.railway.app"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            aria-label="Relay address"
            spellCheck={false}
          />
        </div>
      </label>
      <p className="rf-hint">
        Deploy <code>apps/remote</code> to Railway as its own project (<code>forge-remote</code>), then paste its address here.
      </p>

      <label className="rf-connector-field">
        <span>2. Relay access value (set it on the relay as REELFORGE_REMOTE_AUTH)</span>
        <div className="rf-key-row">
          <input className="rf-input rf-mono" readOnly value={st.relayAuth} onFocus={(e) => e.currentTarget.select()} aria-label="REELFORGE_REMOTE_AUTH value" />
          <button type="button" className="rf-btn" onClick={() => void copy("auth", st.relayAuth)}>
            <Icon name={copied === "auth" ? "check" : "copy"} size={14} /> {copied === "auth" ? "Copied" : "Copy"}
          </button>
        </div>
      </label>

      {st.pairingLink && (
        <div className="rf-connector-field">
          <span>3. Pair your phone: scan with its camera</span>
          <div className="rf-remote-pair">
            <PairingQr text={st.pairingLink} />
            <div className="rf-remote-pair-side">
              <p className="rf-hint">The code holds this Mac's key. Anyone who scans it can follow your projects, so don't share or screenshot it.</p>
              <p className="rf-hint">
                {st.notifications > 0
                  ? `Notifications on for ${st.notifications} ${st.notifications === 1 ? "phone" : "phones"}. They stop with a new pairing.`
                  : "Notifications: turn them on in the phone app's Settings."}
              </p>
              <button type="button" className="rf-btn" onClick={() => void copy("link", st.pairingLink!)}>
                <Icon name={copied === "link" ? "check" : "copy"} size={14} /> {copied === "link" ? "Copied" : "Copy link"}
              </button>
              <button
                type="button"
                className="rf-link-btn"
                disabled={busy}
                onClick={() => {
                  if (window.confirm("Make a new pairing? Every paired phone stops working, and the relay needs the new REELFORGE_REMOTE_AUTH value before this Mac can connect again."))
                    void act(() => client.rotateRemote(), "New pairing made. Update REELFORGE_REMOTE_AUTH on the relay.");
                }}
              >
                New pairing (unpairs every phone)
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
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
