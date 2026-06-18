// Provider settings store. Persisted to localStorage. Each user keeps their
// own API keys in their own browser. Also caches fetched model lists per
// provider so we don't re-fetch on every dropdown open.

import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { Provider, ModelInfo } from "../types";
import { coerceTheme, DEFAULT_THEME } from "../themes";

/** A theme id from `THEMES` (see themes.ts). Typed as string so the catalog
 *  can grow without churn; validity is enforced at runtime via coerceTheme. */
export type Theme = string;

interface SettingsState {
  providers: Provider[];
  defaultProviderId: string | null;
  theme: Theme;
  /** Cached model lists per provider id (persisted, avoids re-fetching). */
  providerModels: Record<string, ModelInfo[]>;
  addProvider: (p: Omit<Provider, "id">) => Provider;
  updateProvider: (id: string, patch: Partial<Provider>) => void;
  removeProvider: (id: string) => void;
  setDefault: (id: string) => void;
  setTheme: (t: Theme) => void;
  getProvider: (id?: string | null) => Provider | undefined;
  /** Fetch models from a provider and cache the result. Returns the model list. */
  fetchAndCacheModels: (providerId: string, baseUrl: string, apiKey: string) => Promise<ModelInfo[]>;
  /** Get cached models for a provider (empty array if not yet fetched). */
  getCachedModels: (providerId: string) => ModelInfo[];
  /** Clear cached models for a provider (e.g. after changing base_url/key). */
  clearCachedModels: (providerId: string) => void;
}

function uid(): string {
  return (
    Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
  );
}

export const useSettings = create<SettingsState>()(
  persist(
    (set, get) => ({
      providers: [],
      defaultProviderId: null,
      theme: DEFAULT_THEME,
      providerModels: {},
      addProvider: (p) => {
        const provider: Provider = { ...p, id: uid() };
        set((s) => {
          const providers = [...s.providers, provider];
          const defaultProviderId =
            s.defaultProviderId ?? (providers.length === 1 ? provider.id : null);
          return { providers, defaultProviderId };
        });
        return provider;
      },
      updateProvider: (id, patch) =>
        set((s) => ({
          providers: s.providers.map((p) =>
            p.id === id ? { ...p, ...patch } : p
          ),
          // If base_url or api_key changed, stale the model cache.
          ...(patch.base_url || patch.api_key
            ? { providerModels: { ...s.providerModels, [id]: [] } }
            : {}),
        })),
      removeProvider: (id) =>
        set((s) => {
          const providers = s.providers.filter((p) => p.id !== id);
          let defaultProviderId = s.defaultProviderId;
          if (defaultProviderId === id)
            defaultProviderId = providers[0]?.id ?? null;
          // Also clean up cached models for removed provider
          const { [id]: _, ...rest } = s.providerModels;
          return { providers, defaultProviderId, providerModels: rest };
        }),
      setDefault: (id) => set({ defaultProviderId: id }),
      setTheme: (theme) => set({ theme }),
      getProvider: (id) => {
        const s = get();
        const targetId = id ?? s.defaultProviderId;
        return s.providers.find((p) => p.id === targetId);
      },
      fetchAndCacheModels: async (providerId, baseUrl, apiKey) => {
        try {
          const { fetchModels } = await import("../lib/api");
          const models = await fetchModels(baseUrl, apiKey);
          set((s) => ({
            providerModels: { ...s.providerModels, [providerId]: models },
          }));
          return models;
        } catch {
          // Fetch failed — cache empty so we don't retry on every re-render
          set((s) => ({
            providerModels: { ...s.providerModels, [providerId]: [] },
          }));
          return [];
        }
      },
      getCachedModels: (providerId) => {
        return get().providerModels[providerId] ?? [];
      },
      clearCachedModels: (providerId) =>
        set((s) => ({
          providerModels: { ...s.providerModels, [providerId]: [] },
        })),
    }),
    {
      name: "little-alphaxiv-settings",
      // Coerce a stale/corrupt theme id (e.g. after a catalog rename) back to
      // a valid one on rehydration. Old "dark"/"light" values are already
      // valid ids and pass through unchanged.
      onRehydrateStorage: () => (state) => {
        if (state) state.theme = coerceTheme(state.theme);
      },
    }
  )
);
