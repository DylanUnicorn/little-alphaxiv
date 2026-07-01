// Settings: theme picker + OpenAI-compatible providers (name, base_url,
// api_key, model). Stored in localStorage. One provider can be default.
// Model lists are fetched from the provider /v1/models endpoint and cached.

import { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import { useSettings } from "../store/settings";
import { THEMES } from "../themes";
import type { Provider, ModelInfo } from "../types";
import * as api from "../lib/api";

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
  const searchSources = useSettings((s) => s.searchSources);
  const setSearchSources = useSettings((s) => s.setSearchSources);
  const zotero = useSettings((s) => s.zotero);
  const setZotero = useSettings((s) => s.setZotero);
  const [zoteroTesting, setZoteroTesting] = useState(false);
  const [zoteroTestResult, setZoteroTestResult] = useState<{ ok: boolean; msg: string } | null>(null);
  const location = useLocation();

  // Account (recovery email). Hydrated from /api/auth/me; the email is the
  // only thing a user can edit here (username is read-only). For pre-migration
  // accounts (no email on file) this is how they enable password recovery.
  const [accountName, setAccountName] = useState("");
  const [emailDraft, setEmailDraft] = useState("");
  const [emailSaved, setEmailSaved] = useState<string | null>(null);
  const [emailMsg, setEmailMsg] = useState<string | null>(null);
  const [emailBusy, setEmailBusy] = useState(false);
  useEffect(() => {
    api.getMe().then((me) => {
      if (!me) return;
      setAccountName(me.username);
      setEmailDraft(me.email ?? "");
      setEmailSaved(me.email ?? "");
    });
  }, []);

  async function saveEmail() {
    setEmailBusy(true);
    setEmailMsg(null);
    try {
      const r = await api.setAccountEmail(emailDraft.trim() || null);
      setEmailSaved(r.email ?? "");
      setEmailDraft(r.email ?? "");
      setEmailMsg("Saved.");
    } catch (e) {
      setEmailMsg((e as Error).message);
    } finally {
      setEmailBusy(false);
    }
  }

  // Auto-scroll to a settings section when arriving via /settings#<id> (e.g.
  // "#providers" from the sidebar's "No provider" warning, or "#zotero" from
  // the Zotero panel's "Switch in Settings" link). .settings-shell is the
  // scroll container; scrollIntoView lands the heading at its top. Each section
  // heading carries the matching id + scrollMarginTop (see the h2 elements).
  useEffect(() => {
    if (!location.hash) return;
    const id = location.hash.slice(1);
    const el = document.getElementById(id);
    if (!el) return;
    const raf = requestAnimationFrame(() =>
      el.scrollIntoView({ behavior: "smooth", block: "start" })
    );
    return () => cancelAnimationFrame(raf);
  }, [location.hash]);

  async function testZotero() {
    setZoteroTesting(true);
    setZoteroTestResult(null);
    try {
      const { zoteroStatus } = await import("../lib/api");
      const res = await zoteroStatus(zotero);
      setZoteroTestResult(res.ok
        ? { ok: true, msg: `Connected via ${res.mode}${res.library ? ` — ${res.library}` : ""}` }
        : { ok: false, msg: res.error || `Not reachable (${res.mode})` });
    } catch (e) {
      setZoteroTestResult({ ok: false, msg: String((e as Error).message || e) });
    } finally {
      setZoteroTesting(false);
    }
  }

  const [draft, setDraft] = useState<Omit<Provider, "id">>(EMPTY);
  // Per-provider fetch state for the "Add provider" form
  const [draftModels, setDraftModels] = useState<ModelInfo[]>([]);
  const [draftFetching, setDraftFetching] = useState(false);

  async function fetchForDraft() {
    if (!draft.base_url || !draft.api_key) return;
    setDraftFetching(true);
    // We use a temporary key to avoid polluting the real cache
    try {
      const { testModels } = await import("../lib/api");
      const models = await testModels(draft.base_url, draft.api_key);
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
      fetchAndCacheModels(provider.id).then(() => {
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
        <h2 id="account">Account</h2>
        <p className="settings-hint">
          Your username is read-only. The email is used only for password
          recovery — add one so a forgotten password doesn't lock you out.
        </p>
        <div className="login-field">
          <span>Username</span>
          <input type="text" value={accountName} readOnly disabled />
        </div>
        <div className="login-field">
          <span>Email (for password recovery)</span>
          <input
            type="email"
            value={emailDraft}
            onChange={(e) => setEmailDraft(e.target.value)}
            disabled={emailBusy}
          />
        </div>
        {emailMsg && <div className="login-error">{emailMsg}</div>}
        <button className="login-submit" onClick={saveEmail} disabled={emailBusy || emailDraft.trim() === (emailSaved ?? "").trim()}>
          {emailBusy ? "…" : "Save email"}
        </button>
        {!emailSaved && (
          <p className="settings-hint">No email on file — add one to enable password recovery.</p>
        )}

        <h2>Appearance</h2>
        <p className="settings-hint">Choose an interface theme. Each is a complete palette — the PDF viewer, code blocks, and scrollbars all follow it.</p>
        <div className="theme-grid">
          {THEMES.map((t) => (
            <button
              key={t.id}
              className={`theme-card ${theme === t.id ? "active" : ""}`}
              onClick={() => setTheme(t.id)}
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

        <h2>Search sources</h2>
        <p className="settings-hint">
          arXiv is always on. Web search (anysearch) is on by default as the 2nd
          source — it finds papers arXiv misses (IEEE/ACM/Springer, paywalled,
          DOI-only) and answers non-academic questions. Optionally enable OpenAlex
          and Semantic Scholar for broader published literature. All work without a
          key (anysearch anonymous is rate-limited); an API key raises your limits.
          Keys are stored server-side, encrypted at rest.
        </p>
        <div className="search-sources-list">
          <div className="search-source-item">
            <div className="search-source-row">
              <strong>arXiv</strong>
              <span className="badge">always on</span>
            </div>
            <div className="provider-detail">Preprints — the default source.</div>
          </div>

          <div className={`search-source-item ${searchSources.anysearch.enabled ? "enabled" : ""}`}>
            <div className="search-source-row">
              <strong>Web search (anysearch)</strong>
              <label className="toggle">
                <input
                  type="checkbox"
                  checked={searchSources.anysearch.enabled}
                  onChange={(e) => setSearchSources({ anysearch: { ...searchSources.anysearch, enabled: e.target.checked } })}
                />
                <span>{searchSources.anysearch.enabled ? "on" : "off"}</span>
              </label>
            </div>
            <div className="provider-detail">
              API key (optional):{" "}
              <input
                className="search-source-key"
                type="password"
                placeholder="optional — anonymous works, just slower"
                value={searchSources.anysearch.apiKey}
                onChange={(e) => setSearchSources({ anysearch: { ...searchSources.anysearch, apiKey: e.target.value } })}
              />
            </div>
            <div className="provider-detail">
              General web search — a fallback for papers not in arXiv/OpenAlex/Semantic
              Scholar (IEEE, ACM, Springer, paywalled, or DOI-only) and for non-academic
              questions. Works anonymously (rate-limited); a key raises your limits.
            </div>
          </div>

          <div className={`search-source-item ${searchSources.openalex.enabled ? "enabled" : ""}`}>
            <div className="search-source-row">
              <strong>OpenAlex</strong>
              <label className="toggle">
                <input
                  type="checkbox"
                  checked={searchSources.openalex.enabled}
                  onChange={(e) => setSearchSources({ openalex: { ...searchSources.openalex, enabled: e.target.checked } })}
                />
                <span>{searchSources.openalex.enabled ? "on" : "off"}</span>
              </label>
            </div>
            <div className="provider-detail">
              API key (optional):{" "}
              <input
                className="search-source-key"
                type="password"
                placeholder="optional"
                value={searchSources.openalex.apiKey}
                onChange={(e) => setSearchSources({ openalex: { ...searchSources.openalex, apiKey: e.target.value } })}
              />
              {" · "}email (polite pool, optional):{" "}
              <input
                className="search-source-key"
                type="text"
                placeholder="optional"
                value={searchSources.openalex.email}
                onChange={(e) => setSearchSources({ openalex: { ...searchSources.openalex, email: e.target.value } })}
              />
            </div>
            <div className="provider-detail">
              Get a free key at{" "}
              <a href="https://openalex.org/settings/api" target="_blank" rel="noopener noreferrer">openalex.org/settings/api</a>
              {" "}($1/day free usage without one).
            </div>
          </div>

          <div className={`search-source-item ${searchSources.semanticScholar.enabled ? "enabled" : ""}`}>
            <div className="search-source-row">
              <strong>Semantic Scholar</strong>
              <label className="toggle">
                <input
                  type="checkbox"
                  checked={searchSources.semanticScholar.enabled}
                  onChange={(e) => setSearchSources({ semanticScholar: { ...searchSources.semanticScholar, enabled: e.target.checked } })}
                />
                <span>{searchSources.semanticScholar.enabled ? "on" : "off"}</span>
              </label>
            </div>
            <div className="provider-detail">
              API key (optional):{" "}
              <input
                className="search-source-key"
                type="password"
                placeholder="optional"
                value={searchSources.semanticScholar.apiKey}
                onChange={(e) => setSearchSources({ semanticScholar: { ...searchSources.semanticScholar, apiKey: e.target.value } })}
              />
            </div>
            <div className="provider-detail">
              Request a free key at{" "}
              <a href="https://www.semanticscholar.org/product/api#api-key" target="_blank" rel="noopener noreferrer">semanticscholar.org/product/api</a>
              {" "}(1 req/sec with a key; shared pool without).
            </div>
          </div>
        </div>

        <h2 id="zotero" style={{ scrollMarginTop: "1rem" }}>Zotero</h2>
        <p className="settings-hint">
          Connect to your Zotero library to find the current paper, add papers,
          and organize collections straight from the PDF toolbar.{" "}
          <strong>Local</strong> talks to the Zotero desktop app (no key —
          start Zotero and enable “Allow other applications to communicate with
          Zotero” in Preferences → Advanced). <strong>Web</strong> uses the
          Zotero Web API (needs your userID + API key, library synced to
          zotero.org) and is required for organizing collections.
        </p>
        <div className="search-sources-list">
          <div className={`search-source-item ${zotero.mode !== "web" || zotero.userId ? "enabled" : ""}`}>
            <div className="search-source-row">
              <strong>Connection mode</strong>
              <select
                className="zotero-mode-select"
                value={zotero.mode}
                onChange={(e) => setZotero({ mode: e.target.value as "auto" | "local" | "web" })}
              >
                <option value="auto">Auto (local → web)</option>
                <option value="local">Local (desktop)</option>
                <option value="web">Web API</option>
              </select>
            </div>
            <div className="provider-detail">
              User ID (web):{" "}
              <input
                className="search-source-key"
                type="text"
                placeholder="web mode only"
                value={zotero.userId}
                onChange={(e) => setZotero({ userId: e.target.value })}
              />
              {" · "}API key (web):{" "}
              <input
                className="search-source-key"
                type="password"
                placeholder="web mode only"
                value={zotero.apiKey}
                onChange={(e) => setZotero({ apiKey: e.target.value })}
              />
              <button
                className="link-btn"
                onClick={testZotero}
                disabled={zoteroTesting}
                style={{ marginLeft: 8 }}
              >
                {zoteroTesting ? "Testing…" : "Test connection"}
              </button>
            </div>
            {zoteroTestResult && (
              <div className={`provider-detail ${zoteroTestResult.ok ? "zotero-ok" : "zotero-err"}`}>
                {zoteroTestResult.ok ? "✓ " : "✗ "}{zoteroTestResult.msg}
              </div>
            )}
            <div className="provider-detail">
              Get a web API key at{" "}
              <a href="https://www.zotero.org/settings/keys" target="_blank" rel="noopener noreferrer">zotero.org/settings/keys</a>
              {" "}(enable library + write access). Your userID is on the{" "}
              <a href="https://www.zotero.org/settings/keys" target="_blank" rel="noopener noreferrer">same settings page</a>.
            </div>
          </div>
        </div>

        <h2 id="providers" style={{ scrollMarginTop: "1rem" }}>Providers</h2>
        <p className="settings-hint">
          Add any OpenAI-compatible endpoint (OpenAI, Anthropic via a compatible
          gateway, local Ollama/OpenAI servers, etc.). Keys are stored
          server-side, encrypted at rest — the plaintext key never leaves your
          browser except when you first save it. Only a masked preview is shown
          here afterward.
        </p>
        <p className="settings-hint">
          <strong>Vision model:</strong> used automatically when you send an
          image and your main model can't handle vision. Same base URL &amp; key
          — just a different model id on the same provider.
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
                <div className="provider-detail">key: {p.api_key || "(not set)"}</div>
                <div className="provider-models-row">
                  <span className="provider-models-label">
                    {hasModels ? `${cached.length} models cached` : "No models cached"}
                  </span>
                  <button
                    className="link-btn fetch-models-btn"
                    onClick={() => fetchAndCacheModels(p.id)}
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
                <div className="provider-vision-row">
                  <span className="provider-vision-label">Vision model</span>
                  {hasModels ? (
                    <select
                      className="provider-model-select"
                      value={p.vision_model ?? ""}
                      onChange={(e) =>
                        useSettings
                          .getState()
                          .updateProvider(p.id, { vision_model: e.target.value || undefined })
                      }
                      title="Model used automatically when you send an image and your main model can't handle vision"
                    >
                      <option value="">(not set)</option>
                      {cached.map((m) => (
                        <option key={m.id} value={m.id}>{m.id}</option>
                      ))}
                    </select>
                  ) : (
                    <input
                      className="provider-model-input"
                      value={p.vision_model ?? ""}
                      onChange={(e) =>
                        useSettings
                          .getState()
                          .updateProvider(p.id, { vision_model: e.target.value || undefined })
                      }
                      placeholder="vision model id (optional)"
                      title="Model used automatically when you send an image and your main model can't handle vision"
                    />
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
