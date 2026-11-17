import { useEffect, useRef, useState } from "react";
import type { Client, ConnectorStatus } from "../api.ts";
import type { Notify } from "../editor.ts";
import { Icon } from "../icons.tsx";

/**
 * Settings → Claude & ChatGPT: run the remote MCP connector from the app. Shows the link to paste
 * into Claude / ChatGPT and the access key to type when they ask you to sign in.
 */
export function ConnectorSettings({ client, notify }: { client: Client | null; notify: Notify }) {
  const [st, setSt] = useState<ConnectorStatus | null>(null);
  const [unavailable, setUnavailable] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tunnel, setTunnel] = useState<"ngrok" | "none">("ngrok");
  const [domain, setDomain] = useState("");
  const [publicUrl, setPublicUrl] = useState("");
  const [advanced, setAdvanced] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const loaded = useRef(false);

  const load = async () => {
    if (!client) return;
    try {
      const s = await client.connector();
      setSt(s);
      setUnavailable(null);
      if (!loaded.current) {
        loaded.current = true;
        setTunnel(s.settings.tunnel);
        setDomain(s.settings.domain ?? "");
        setPublicUrl(s.settings.publicUrl ?? "");
        setAdvanced(!!s.settings.domain || s.settings.tunnel === "none");
      }
    } catch (e) {
      setUnavailable(e instanceof Error ? e.message : String(e));
    }
  };

  useEffect(() => {
    void load();
    // Apps connect, tunnels drop: keep the panel current while Settings is open.
    const t = setInterval(() => void load(), 3000);
    return () => clearInterval(t);
  }, [client]);

  const act = async (fn: () => Promise<ConnectorStatus>, done?: string) => {
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
        <h3>Claude &amp; ChatGPT</h3>
        <p className="rf-hint">The connector isn't available in this engine ({unavailable}). Restart ReelForge to update the engine.</p>
      </section>
    );
  }
  if (!st) return null;

  const running = st.state === "running";
  const starting = st.state === "starting" || (busy && !running);
  const canStart = tunnel === "ngrok" ? st.ngrokAvailable : /^https:\/\/[^/\s]+\/?$/.test(publicUrl.trim());

  return (
    <section className="rf-settings-group rf-connector">
      <h3>Claude &amp; ChatGPT</h3>
      <p className="rf-hint">Edit videos from a chat: send a file to Claude or ChatGPT and ask for the edit. ReelForge does the work on this Mac.</p>

      <div className="rf-connector-status">
        <span className={`rf-dot ${running ? (st.public ? "is-on" : "is-warn") : starting ? "is-busy" : ""}`} aria-hidden />
        <span>{running ? (st.public ? "On: reachable from Claude and ChatGPT" : "On, but only on this Mac (no https tunnel)") : starting ? "Starting…" : "Off"}</span>
        {running ? (
          <button type="button" className="rf-btn rf-connector-toggle" disabled={busy} onClick={() => void act(() => client.stopConnector(), "Connector stopped.")}>
            Stop
          </button>
        ) : (
          <button
            type="button"
            className="rf-btn rf-btn-primary rf-connector-toggle"
            disabled={busy || starting || !canStart}
            onClick={() =>
              void act(() =>
                client.startConnector({
                  tunnel,
                  domain: tunnel === "ngrok" ? domain.trim() || null : null,
                  publicUrl: tunnel === "none" ? publicUrl.trim().replace(/\/+$/, "") || null : null,
                }),
              )
            }
          >
            {starting ? "Starting…" : "Start"}
          </button>
        )}
      </div>

      {st.error && !running && <p className="rf-hint rf-connector-error">{st.error}</p>}

      {!running && (
        <>
          {tunnel === "ngrok" && !st.ngrokAvailable && (
            <p className="rf-hint">
              Needs ngrok (free) to reach this Mac from the internet: <code>brew install ngrok</code>, then <code>ngrok config add-authtoken &lt;token&gt;</code> from
              ngrok.com.
            </p>
          )}
          <button type="button" className="rf-link-btn" onClick={() => setAdvanced((a) => !a)} aria-expanded={advanced}>
            {advanced ? "Hide tunnel options" : "Tunnel options"}
          </button>
          {advanced && (
            <div className="rf-connector-advanced">
              <label className="rf-check">
                <input type="radio" name="rf-tunnel" checked={tunnel === "ngrok"} onChange={() => setTunnel("ngrok")} />
                ngrok (started for you)
              </label>
              {tunnel === "ngrok" && (
                <input
                  className="rf-input"
                  placeholder="Your ngrok domain, optional (keeps the link the same): name.ngrok-free.app"
                  value={domain}
                  onChange={(e) => setDomain(e.target.value)}
                  aria-label="ngrok domain"
                />
              )}
              <label className="rf-check">
                <input type="radio" name="rf-tunnel" checked={tunnel === "none"} onChange={() => setTunnel("none")} />
                My own tunnel (forward an https address to this Mac yourself)
              </label>
              {tunnel === "none" && (
                <input className="rf-input" placeholder="https://reelforge.example.com" value={publicUrl} onChange={(e) => setPublicUrl(e.target.value)} aria-label="Public https URL" />
              )}
            </div>
          )}
        </>
      )}

      {running && st.mcpUrl && (
        <>
          <label className="rf-connector-field">
            <span>1. Connector link</span>
            <div className="rf-key-row">
              <input className="rf-input rf-mono" readOnly value={st.mcpUrl} onFocus={(e) => e.currentTarget.select()} aria-label="Connector link" />
              <button type="button" className="rf-btn" onClick={() => void copy("url", st.mcpUrl!)}>
                <Icon name={copied === "url" ? "check" : "copy"} size={14} /> {copied === "url" ? "Copied" : "Copy"}
              </button>
            </div>
          </label>
          <p className="rf-hint">
            Claude: Settings → Connectors → Add custom connector. ChatGPT: Settings → Apps &amp; Connectors → Advanced → Developer mode, then Create. Paste the link.
            {!st.settings.domain && st.settings.tunnel === "ngrok" && " Without an ngrok domain the link changes each time the connector starts."}
          </p>
          <label className="rf-connector-field">
            <span>2. Access key (type it when ReelForge asks you to sign in)</span>
            <div className="rf-key-row">
              <input className="rf-input rf-mono rf-connector-key" readOnly value={st.accessKey} onFocus={(e) => e.currentTarget.select()} aria-label="Access key" />
              <button type="button" className="rf-btn" onClick={() => void copy("key", st.accessKey)}>
                <Icon name={copied === "key" ? "check" : "copy"} size={14} /> {copied === "key" ? "Copied" : "Copy"}
              </button>
              <button type="button" className="rf-btn" disabled={busy} title="Apps already connected keep working" onClick={() => void act(() => client.rotateConnectorKey(), "New access key generated.")}>
                <Icon name="refresh" size={14} /> New key
              </button>
            </div>
          </label>
        </>
      )}

      {st.connections.length > 0 && (
        <div className="rf-connector-apps">
          <span className="rf-hint">Connected apps</span>
          <ul>
            {st.connections.map((c, i) => (
              <li key={i}>
                <span className={`rf-dot ${c.active ? "is-on" : ""}`} aria-hidden /> {c.clientName}
                <span className="rf-hint"> · since {new Date(c.createdAt).toLocaleDateString()}</span>
              </li>
            ))}
          </ul>
          <button
            type="button"
            className="rf-link-btn"
            disabled={busy}
            onClick={() => {
              if (window.confirm("Disconnect every app? They'll need to connect again, with a new access key.")) void act(() => client.revokeConnector(), "All apps disconnected.");
            }}
          >
            Disconnect all
          </button>
        </div>
      )}
    </section>
  );
}
