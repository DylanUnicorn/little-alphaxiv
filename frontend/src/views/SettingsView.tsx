// Settings: theme picker + OpenAI-compatible providers (name, base_url,
// api_key, model). Stored in localStorage. One provider can be default.

import { useState } from "react";
import { useSettings } from "../store/settings";
import { THEMES } from "../themes";
import type { Provider } from "../types";

const EMPTY: Omit<Provider, "id"> = {
  name: "",
  base_url: "",
  api_key: "",
  model: "",
};

export function SettingsView() {
  const providers = useSettings((s) => s.providers);
  const defaultProviderId = useSettings((s) => s.defaultProviderId);
  const addProvider = useSettings((s) => s.addProvider);
  const removeProvider = useSettings((s) => s.removeProvider);
  const setDefault = useSettings((s) => s.setDefault);
  const theme = useSettings((s) => s.theme);
  const setTheme = useSettings((s) => s.setTheme);

  const [draft, setDraft] = useState<Omit<Provider, "id">>(EMPTY);

  function add() {
    if (!draft.base_url || !draft.api_key || !draft.model) return;
    addProvider({ ...draft, name: draft.name || draft.model });
    setDraft(EMPTY);
  }

  return (
    <main className="main-pane">
      <div className="settings-shell">
        <h2>Appearance</h2>
        <p className="settings-hint">Choose an interface theme. Each is a complete palette — the PDF viewer, code blocks, and scrollbars all follow it.</p>
        <div className="theme-grid">
          {THEMES.map((t) => (
            <button
              key={t.id}
              className={`theme-card ${theme === t.id ? "active" : ""}`}
              onClick={() => setTheme(t.id)}
              title={t.label}
            >
              <div className="theme-swatches">
                {t.swatch.map((c, i) => (
                  <span key={i} className="theme-swatch" style={{ background: c }} />
                ))}
              </div>
              <div className="theme-card-foot">
                <span className="theme-card-label">{t.label}</span>
                <span className="theme-mode-chip">{t.mode === "dark" ? "🌙" : "☀"}</span>
              </div>
            </button>
          ))}
        </div>

        <h2>Providers</h2>
        <p className="settings-hint">
          Add any OpenAI-compatible endpoint (OpenAI, Anthropic via a compatible
          gateway, local Ollama/OpenAI servers, etc.). Keys are stored only in
          your browser (localStorage) and sent to the backend proxy per request.
        </p>

        <div className="provider-list">
          {providers.length === 0 && <div className="conv-empty">No providers yet — add one below to start chatting.</div>}
          {providers.map((p) => (
            <div key={p.id} className={`provider-item ${p.id === defaultProviderId ? "default" : ""}`}>
              <div className="provider-row">
                <strong>{p.name}</strong>
                {p.id === defaultProviderId && <span className="badge">default</span>}
                {p.id !== defaultProviderId && (
                  <button className="link-btn" onClick={() => setDefault(p.id)}>set default</button>
                )}
                <button className="link-btn danger" onClick={() => removeProvider(p.id)}>remove</button>
              </div>
              <div className="provider-detail">{p.base_url} · model: {p.model}</div>
              <div className="provider-detail">key: {p.api_key.slice(0, 6)}…{p.api_key.slice(-4)}</div>
            </div>
          ))}
        </div>

        <h3>Add provider</h3>
        <div className="provider-form">
          <input placeholder="Name (e.g. OpenAI, My Gateway)" value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          <input placeholder="Base URL (e.g. https://api.openai.com/v1)" value={draft.base_url}
            onChange={(e) => setDraft({ ...draft, base_url: e.target.value })} />
          <input placeholder="API key" type="password" value={draft.api_key}
            onChange={(e) => setDraft({ ...draft, api_key: e.target.value })} />
          <input placeholder="Model (e.g. gpt-4o-mini)" value={draft.model}
            onChange={(e) => setDraft({ ...draft, model: e.target.value })} />
          <button onClick={add} disabled={!draft.base_url || !draft.api_key || !draft.model}>
            Add
          </button>
        </div>
      </div>
    </main>
  );
}
