// Provider + settings store. Persisted server-side (per-user, encrypted at
// rest for keys). Hydrated from /api/settings + /api/providers on login; every
// mutation updates local state optimistically and fires a backend write. The
// plaintext API key lives only briefly in the form that submits it — after
// save, Provider.api_key holds the MASK (first4…last4) returned by the server.

import { create } from "zustand";
import type { Provider, ModelInfo } from "../types";
import { coerceTheme, DEFAULT_THEME } from "../themes";
import * as api from "../lib/api";

/** A theme id from `THEMES` (see themes.ts). Typed as string so the catalog
 *  can grow without churn; validity is enforced at runtime via coerceTheme. */
export type Theme = string;

/** Optional search sources beyond the always-on arXiv. Keys are stored
 *  server-side (encrypted at rest) per user. All three also work without a
 *  key (anysearch anonymous is rate-limited; OpenAlex/S2 share a pool), so the
 *  key is an optional enhancement. anysearch (web_search) is the 2nd source
 *  after arXiv — on by default so non-arXiv papers (IEEE/ACM/Springer, DOI-only)
 *  are findable out of the box. */
export interface SearchSources {
  anysearch: { enabled: boolean; apiKey: string };
  openalex: { enabled: boolean; apiKey: string; email: string };
  semanticScholar: { enabled: boolean; apiKey: string };
}

export const DEFAULT_SEARCH_SOURCES: SearchSources = {
  anysearch: { enabled: true, apiKey: "" },
  openalex: { enabled: false, apiKey: "", email: "" },
  semanticScholar: { enabled: false, apiKey: "" },
};

/** Zotero connection config. Two ways to reach a Zotero library:
 *  - `local`: talks to the Zotero desktop app's local API on 127.0.0.1:23119
 *    (no key; needs Zotero running with "Allow other applications to
 *    communicate with Zotero" enabled). Read + add item (+ optional PDF) only.
 *  - `web`: the Zotero Web API (api.zotero.org), needs userID + API key and a
 *    library synced to zotero.org. Full CRUD incl. organizing collections.
 *  - `auto`: try local first, fall back to web if credentials are set. */
export interface ZoteroConfig {
  mode: "auto" | "local" | "web";
  userId: string; // Zotero userID (web mode only)
  apiKey: string; // Zotero API key (web mode only)
}

export const DEFAULT_ZOTERO: ZoteroConfig = {
  mode: "auto",
  userId: "",
  apiKey: "",
};

interface SettingsState {
  providers: Provider[];
  defaultProviderId: string | null;
  theme: Theme;
  /** Cached model lists per provider id (persisted server-side, avoids re-fetching). */
  providerModels: Record<string, ModelInfo[]>;
  loaded: boolean;
  /** Hydrate from the backend. Call once on login/boot. */
  load: () => Promise<void>;
  /** Reset to empty (on logout). */
  reset: () => void;
  addProvider: (p: Omit<Provider, "id">) => Provider;
  updateProvider: (id: string, patch: Partial<Provider>) => void;
  removeProvider: (id: string) => void;
  setDefault: (id: string) => void;
  setTheme: (t: Theme) => void;
  getProvider: (id?: string | null) => Provider | undefined;
  /** Fetch models for a provider (server resolves creds by provider_id) and
   *  cache the result. Returns the model list. */
  fetchAndCacheModels: (providerId: string) => Promise<ModelInfo[]>;
  /** Get cached models for a provider (empty array if not yet fetched). */
  getCachedModels: (providerId: string) => ModelInfo[];
  /** Clear cached models for a provider (e.g. after changing base_url/key). */
  clearCachedModels: (providerId: string) => void;
  searchSources: SearchSources;
  setSearchSources: (patch: Partial<SearchSources>) => void;
  zotero: ZoteroConfig;
  setZotero: (patch: Partial<ZoteroConfig>) => void;
}

function uid(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// Debounced settings PATCH (theme/searchSources/zotero/providerModels) so rapid
// field edits don't spam the backend.
let settingsPatchTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleSettingsPatch(getState: () => SettingsState): void {
  if (settingsPatchTimer) clearTimeout(settingsPatchTimer);
  settingsPatchTimer = setTimeout(() => {
    const s = getState();
    void api.patchSettings({
      theme: s.theme,
      searchSources: s.searchSources,
      zotero: s.zotero,
      providerModels: s.providerModels,
    }).catch(() => { /* non-fatal */ });
  }, 400);
}

export const useSettings = create<SettingsState>((set, get) => ({
  providers: [],
  defaultProviderId: null,
  theme: DEFAULT_THEME,
  searchSources: DEFAULT_SEARCH_SOURCES,
  zotero: DEFAULT_ZOTERO,
  providerModels: {},
  loaded: false,

  load: async () => {
    const [settings, providers] = await Promise.all([
      api.getSettings(),
      api.listProviders(),
    ]);
    // Deep-merge against defaults so a fresh user (server returns {} slices)
    // gets the full shaped searchSources/zotero — callers read .openalex.enabled
    // etc. and would crash on a bare {}.
    const ss = settings.searchSources ?? {};
    const zt = settings.zotero ?? {};
    set({
      theme: coerceTheme(settings.theme),
      searchSources: {
        anysearch: { ...DEFAULT_SEARCH_SOURCES.anysearch, ...(ss.anysearch ?? {}) },
        openalex: { ...DEFAULT_SEARCH_SOURCES.openalex, ...(ss.openalex ?? {}) },
        semanticScholar: { ...DEFAULT_SEARCH_SOURCES.semanticScholar, ...(ss.semanticScholar ?? {}) },
      },
      zotero: { ...DEFAULT_ZOTERO, ...zt },
      providerModels: settings.providerModels ?? {},
      providers: providers.map((p) => ({
        id: p.id,
        name: p.name,
        base_url: p.base_url,
        api_key: p.api_key, // MASKED — never the plaintext
        model: p.model,
        is_default: p.is_default,
        ...(p.vision_model ? { vision_model: p.vision_model } : {}),
      })),
      defaultProviderId: providers.find((p) => p.is_default)?.id ?? providers[0]?.id ?? null,
      loaded: true,
    });
    // Cache theme to localStorage purely for FOUC avoidance before load() resolves.
    try { localStorage.setItem("lax-theme", get().theme); } catch { /* ignore */ }
  },

  reset: () =>
    set({
      providers: [],
      defaultProviderId: null,
      theme: DEFAULT_THEME,
      searchSources: DEFAULT_SEARCH_SOURCES,
      zotero: DEFAULT_ZOTERO,
      providerModels: {},
      loaded: false,
    }),

  addProvider: (p) => {
    const provider: Provider = { ...p, id: uid() };
    set((s) => {
      const providers = [...s.providers, provider];
      const defaultProviderId =
        s.defaultProviderId ?? (providers.length === 1 ? provider.id : null);
      return { providers, defaultProviderId };
    });
    // Fire-and-forget; server stores the real (plaintext) key + returns masked.
    void api.addProvider({
      id: provider.id,
      name: provider.name,
      base_url: provider.base_url,
      api_key: provider.api_key, // plaintext — sent once over the wire
      model: provider.model,
      vision_model: provider.vision_model ?? null,
      is_default: get().defaultProviderId === provider.id,
    }).then((saved) => {
      // Replace the local row with the server's masked version.
      set((s) => ({
        providers: s.providers.map((p) => (p.id === saved.id ? {
          ...p, api_key: saved.api_key, name: saved.name, base_url: saved.base_url,
          model: saved.model, vision_model: saved.vision_model ?? undefined,
        } : p)),
      }));
    }).catch(() => { /* keep optimistic local row */ });
    return provider;
  },

  updateProvider: (id, patch) => {
    set((s) => ({
      providers: s.providers.map((p) => (p.id === id ? { ...p, ...patch } : p)),
      // If base_url or api_key changed, stale the model cache.
      ...(patch.base_url || patch.api_key
        ? { providerModels: { ...s.providerModels, [id]: [] } }
        : {}),
    }));
    // Persist: send only the fields the backend cares about. api_key is only
    // sent when the user typed a new one (patch.api_key is the masked display
    // otherwise — sending it would overwrite the real key with the mask).
    void api.updateProvider(id, {
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.base_url !== undefined ? { base_url: patch.base_url } : {}),
      ...(patch.model !== undefined ? { model: patch.model } : {}),
      ...(patch.vision_model !== undefined ? { vision_model: patch.vision_model ?? null } : {}),
    }).catch(() => { /* non-fatal */ });
  },

  removeProvider: (id) => {
    set((s) => {
      const providers = s.providers.filter((p) => p.id !== id);
      let defaultProviderId = s.defaultProviderId;
      if (defaultProviderId === id) defaultProviderId = providers[0]?.id ?? null;
      const { [id]: _, ...rest } = s.providerModels;
      return { providers, defaultProviderId, providerModels: rest };
    });
    void api.removeProvider(id).catch(() => { /* non-fatal */ });
  },

  setDefault: (id) => {
    set({ defaultProviderId: id });
    void api.setDefaultProvider(id).catch(() => { /* non-fatal */ });
  },

  setTheme: (theme) => {
    set({ theme: coerceTheme(theme) });
    try { localStorage.setItem("lax-theme", coerceTheme(theme)); } catch { /* ignore */ }
    scheduleSettingsPatch(() => get() as SettingsState);
  },

  getProvider: (id) => {
    const s = get();
    const targetId = id ?? s.defaultProviderId;
    return s.providers.find((p) => p.id === targetId);
  },

  fetchAndCacheModels: async (providerId) => {
    try {
      const models = await api.fetchModels(providerId);
      set((s) => ({
        providerModels: { ...s.providerModels, [providerId]: models },
      }));
      scheduleSettingsPatch(() => get() as SettingsState);
      return models;
    } catch {
      set((s) => ({
        providerModels: { ...s.providerModels, [providerId]: [] },
      }));
      return [];
    }
  },

  getCachedModels: (providerId) => get().providerModels[providerId] ?? [],

  clearCachedModels: (providerId) =>
    set((s) => ({
      providerModels: { ...s.providerModels, [providerId]: [] },
    })),

  setSearchSources: (patch) => {
    set((s) => ({
      searchSources: {
        anysearch: { ...s.searchSources.anysearch, ...(patch.anysearch ?? {}) },
        openalex: { ...s.searchSources.openalex, ...(patch.openalex ?? {}) },
        semanticScholar: {
          ...s.searchSources.semanticScholar,
          ...(patch.semanticScholar ?? {}),
        },
      },
    }));
    scheduleSettingsPatch(() => get() as SettingsState);
  },

  setZotero: (patch) => {
    set((s) => ({ zotero: { ...s.zotero, ...patch } }));
    scheduleSettingsPatch(() => get() as SettingsState);
  },
}));
