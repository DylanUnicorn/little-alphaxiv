// Theme catalog — the single source of truth for available interface themes.
//
// Each theme is a complete palette defined as CSS custom properties in
// index.css under `[data-theme="<id>"]` (and `:root` for the default). This
// file only carries the *metadata* needed to render the theme picker: the id,
// human label, light/dark mode, and a small swatch for the settings preview.
//
// Adding a theme = append one CSS block in index.css + one entry here.

export type ThemeMode = "dark" | "light";

export interface ThemeMeta {
  id: string;
  label: string;
  mode: ThemeMode;
  /** Four preview swatches: [bg, panel, accent, text]. */
  swatch: [string, string, string, string];
}

export const THEMES: ThemeMeta[] = [
  { id: "dark", label: "Default Dark", mode: "dark", swatch: ["#0f1115", "#1d212c", "#7c8cff", "#e6e8ee"] },
  { id: "light", label: "Light", mode: "light", swatch: ["#f6f7f9", "#eceef2", "#4f5dff", "#1a1d24"] },
  { id: "alphaxiv", label: "Alphaxiv", mode: "light", swatch: ["#f7f5f4", "#ffffff", "#a6223d", "#252223"] },
  { id: "nord", label: "Nord", mode: "dark", swatch: ["#2e3440", "#434c5e", "#88c0d0", "#eceff4"] },
  { id: "tokyo-night", label: "Tokyo Night", mode: "dark", swatch: ["#1a1b26", "#292a3a", "#7aa2f7", "#c0caf5"] },
  { id: "gruvbox-dark", label: "Gruvbox Dark", mode: "dark", swatch: ["#282828", "#504945", "#fabd2f", "#ebdbb2"] },
  { id: "catppuccin-mocha", label: "Catppuccin Mocha", mode: "dark", swatch: ["#1e1e2e", "#313244", "#cba6f7", "#cdd6f4"] },
  { id: "solarized-dark", label: "Solarized Dark", mode: "dark", swatch: ["#002b36", "#073642", "#2aa198", "#93a1a1"] },
  { id: "solarized-light", label: "Solarized Light", mode: "light", swatch: ["#fdf6e3", "#e6dcc0", "#268bd2", "#073642"] },
  { id: "sepia", label: "Sepia / Paper", mode: "light", swatch: ["#f4ecd8", "#ece0c4", "#b8632e", "#4a3621"] },
  { id: "dracula", label: "Dracula", mode: "dark", swatch: ["#282a36", "#44475a", "#bd93f9", "#f8f8f2"] },
  { id: "rose-pine", label: "Rosé Pine", mode: "dark", swatch: ["#191724", "#26233a", "#ebbcba", "#e0def4"] },
];

export const DEFAULT_THEME = "dark";

export const THEME_IDS = THEMES.map((t) => t.id) as [string, ...string[]];

export function isThemeId(value: unknown): value is string {
  return typeof value === "string" && THEMES.some((t) => t.id === value);
}

/** Coerce an arbitrary persisted value into a valid theme id. Old "dark"/"light"
 *  values are already valid ids, so this mainly guards against unknown/corrupt
 *  values by falling back to the default. */
export function coerceTheme(value: unknown): string {
  return isThemeId(value) ? value : DEFAULT_THEME;
}

export function getThemeMeta(id: string): ThemeMeta | undefined {
  return THEMES.find((t) => t.id === id);
}
