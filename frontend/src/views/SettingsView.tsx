// Settings: theme picker + OpenAI-compatible providers (name, base_url,
// api_key, model). Stored in localStorage. One provider can be default.
// Model lists are fetched from the provider /v1/models endpoint and cached.

import { useState } from "react";
import { useSettings } from "../store/settings";
import { THEMES } from "../themes";
import type { Provider, ModelInfo } from "../types";

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
  const fetchAndCacheModels = useSettings((s) => s.fetchAndCacheModels);
  const getCachedModels = useSettings((s) => s.getCachedModels);

  const [draft, setDraft] = useState<Omit<Provider, "id">>(EMPTY);
  // Per-provider fetch state for the "Add provider" form
  const [draftModels, setDraftModels] = useState<ModelInfo[]>([]);
  const [draftFetching, setDraftFetching] = useState(false);

  async function fetchForDraft() {
    if (!draft.base_url || !draft.api_key) return;
    setDraftFetching(true);
    // We use a temporary key to avoid polluting the real cache
    try {
      const { fetchModels } = await import("../lib/api");
      const models = await fetchModels(draft.base_url, draft.api_key);
      setDraftModels(models);
    } catch {
      setDraftModels([]);
    } finally {
      setDraftFetching(false);
    }
  }

  function add() {
    if (!draft.base_url || !draft.api_key || !draft.model) return;
    const provider = addProvider({ ...draft, name: draft.name || draft.model });
    // Cache models if we fetched them for this draft
    if (draftModels.length > 0) {
      fetchAndCacheModels(provider.id, draft.base_url, draft.api_key).then(() => {
        // Replace with already-fetched list (avoid redundant network call)
        useSettings.setState((s) => ({
          providerModels: { ...s.providerModels, [provider.id]: draftModels },
        }));
      });
    }
    setDraft(EMPTY);
    setDraftModels([]);
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
          {providers.map((p) => {
            const cached = getCachedModels(p.id);
            const hasModels = cached.length > 0;
            return (
              <div key={p.id} className={`provider-item ${p.id === defaultProviderId ? "default" : ""}`}>
                <div className="provider-row">
                  <strong>{p.name}</strong>
                  {p.id === defaultProviderId && <span className="badge">default</span>}
                  {p.id !== defaultProviderId && (
                    <button className="link-btn" onClick={() => setDefault(p.id)}>set default</button>
                  )}
                  <button className="link-btn danger" onClick={() => removeProvider(p.id)}>remove</button>
                </div>
                <div className="provider-detail">{p.base_url} · model: <strong>{p.model}</strong></div>
                <div className="provider-detail">key: {p.api_key.slice(0, 6)}…{p.api_key.slice(-4)}</div>
                <div className="provider-models-row">
                  <span className="provider-models-label">
                    {hasModels ? `${cached.length} models cached` : "No models cached"}
                  </span>
                  <button
                    className="link-btn fetch-models-btn"
                    onClick={() => fetchAndCacheModels(p.id, p.base_url, p.api_key)}
                  >
                    {hasModels ? "Refresh models" : "Fetch models"}
                  </button>
                  {hasModels && (
                    <select
                      className="provider-model-select"
                      value={p.model}
                      onChange={(e) => useSettings.getState().updateProvider(p.id, { model: e.target.value })}
                      title="Switch model"
                    >
                      {cached.map((m) => (
                        <option key={m.id} value={m.id}>{m.id}</option>
                      ))}
                    </select>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        <h3>Add provider</h3>
        <div className="provider-form">
          <input placeholder="Name (e.g. OpenAI, My Gateway)" value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          <input placeholder="Base URL (e.g. https://api.openai.com/v1)" value={draft.base_url}
            onChange={(e) => setDraft({ ...draft, base_url: e.target.value })} />
          <input placeholder="API key" type="password" value={draft.api_key}
            onChange={(e) => setDraft({ ...draft, api_key: e.target.value })} />
          <div className="provider-model-input-row">
            {draftModels.length > 0 ? (
              <select
                className="provider-model-select"
                value={draft.model}
                onChange={(e) => setDraft({ ...draft, model: e.target.value })}
              >
                <option value="">Select a model…</option>
                {draftModels.map((m) => (
                  <option key={m.id} value={m.id}>{m.id}</option>
                ))}
              </select>
            ) : (
              <input placeholder="Model (e.g. gpt-4o-mini) or fetch ↓" value={draft.model}
                onChange={(e) => setDraft({ ...draft, model: e.target.value })} />
            )}
            <button
              type="button"
              className="fetch-models-btn"
              onClick={fetchForDraft}
              disabled={!draft.base_url || !draft.api_key || draftFetching}
            >
              {draftFetching ? "Fetching…" : "Fetch"}
            </button>
          </div>
          <button onClick={add} disabled={!draft.base_url || !draft.api_key || !draft.model}>
            Add
          </button>
        </div>
      </div>
    </main>
  );
}
