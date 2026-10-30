import { useEffect, useState } from "react";
import type { Client } from "../api.ts";
import type { Notify } from "../editor.ts";
import { keychain } from "../native.ts";
import { Icon } from "../icons.tsx";

/** AI provider keys: saved to the macOS Keychain by the desktop shell, never shown again. */
export function SettingsDialog({ client, projectId, notify, onClose }: { client: Client | null; projectId: string | null; notify: Notify; onClose: () => void }) {
  const [has, setHas] = useState<boolean | null>(null);
  const [source, setSource] = useState<string>("none");
  const [key, setKey] = useState("");
  const [consent, setConsent] = useState<boolean | null>(null);

  const refresh = async () => {
    setHas(await keychain.has("anthropic").catch(() => false));
    const providers = await client?.aiProviders().catch(() => []);
    setSource(providers?.find((p) => p.id === "anthropic")?.credential ?? "none");
    if (client && projectId) setConsent(!!(await client.consent(projectId).catch(() => null)));
  };
  useEffect(() => {
    void refresh();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const save = async () => {
    try {
      await keychain.save("anthropic", key);
      setKey("");
      notify("info", "Anthropic API key saved to the Keychain.");
      await refresh();
    } catch (e) {
      notify("error", String(e));
    }
  };

  return (
    <div className="rf-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="rf-dialog" role="dialog" aria-modal="true" aria-labelledby="rf-settings-title">
        <div className="rf-dialog-head">
          <h2 id="rf-settings-title">Settings</h2>
          <button type="button" className="rf-icon-btn" onClick={onClose} aria-label="Close">
            <Icon name="x" size={16} />
          </button>
        </div>
        <section className="rf-settings-group">
          <h3>Claude (Anthropic)</h3>
          <p className="rf-hint">
            Status:{" "}
            {source === "keychain" ? "key saved in the Keychain" : source === "environment" ? "using ANTHROPIC_API_KEY from the environment" : "no key"}
          </p>
          {keychain.supported() ? (
            <form
              className="rf-key-row"
              onSubmit={(e) => {
                e.preventDefault();
                if (key.trim()) void save();
              }}
            >
              <input className="rf-input" type="password" autoComplete="off" placeholder={has ? "Replace the saved key…" : "sk-ant-…"} value={key} onChange={(e) => setKey(e.target.value)} aria-label="Anthropic API key" />
              <button className="rf-btn rf-btn-primary" disabled={!key.trim()}>
                Save
              </button>
              {has && (
                <button type="button" className="rf-btn" onClick={() => void keychain.remove("anthropic").then(refresh)}>
                  Remove
                </button>
              )}
            </form>
          ) : (
            <p className="rf-hint">In browser dev mode, start the engine with ANTHROPIC_API_KEY set; the desktop app stores keys in the Keychain.</p>
          )}
        </section>
        {projectId && (
          <section className="rf-settings-group">
            <h3>This project</h3>
            <label className="rf-check">
              <input
                type="checkbox"
                checked={!!consent}
                onChange={async (e) => {
                  await client?.setConsent(projectId, e.target.checked);
                  setConsent(e.target.checked);
                }}
              />
              Allow sending this project's context (names, timeline, transcripts; never media) to external AI providers
            </label>
          </section>
        )}
      </div>
    </div>
  );
}
