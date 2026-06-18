// Provider settings store. Persisted to localStorage. Each user keeps their
// own API keys in their own browser.

import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { Provider } from "../types";
import { coerceTheme, DEFAULT_THEME } from "../themes";

/** A theme id from `THEMES` (see themes.ts). Typed as string so the catalog
 *  can grow without churn; validity is enforced at runtime via coerceTheme. */
export type Theme = string;

interface SettingsState {
  providers: Provider[];
  defaultProviderId: string | null;
  theme: Theme;
  addProvider: (p: Omit<Provider, "id">) => Provider;
  updateProvider: (id: string, patch: Partial<Provider>) => void;
  removeProvider: (id: string) => void;
  setDefault: (id: string) => void;
  setTheme: (t: Theme) => void;
  getProvider: (id?: string | null) => Provider | undefined;
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
        })),
      removeProvider: (id) =>
        set((s) => {
          const providers = s.providers.filter((p) => p.id !== id);
          let defaultProviderId = s.defaultProviderId;
          if (defaultProviderId === id)
            defaultProviderId = providers[0]?.id ?? null;
          return { providers, defaultProviderId };
        }),
      setDefault: (id) => set({ defaultProviderId: id }),
      setTheme: (theme) => set({ theme }),
      getProvider: (id) => {
        const s = get();
        const targetId = id ?? s.defaultProviderId;
        return s.providers.find((p) => p.id === targetId);
      },
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
