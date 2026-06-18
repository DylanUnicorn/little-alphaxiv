# Little Alphaxiv — Multi-Theme System + UI/UX Reshape

**Date**: 2026-06-18
**Status**: Brainstormed & approved; ready for implementation planning
**Branch**: `ui-themes-redesign` (isolated worktree)
**Stack**: React 18 + Vite + TS, zustand, plain CSS custom properties

## 1. Goal

Two intertwined goals, both requested by the user:

1. **Add several named interface styles ("themes")** beyond the current binary Dark/Light — a curated set of complete color palettes the user can switch between with one click.
2. **Optimize the whole interface** — visual polish (typography, spacing, radii, shadows, motion, scrollbars) **and** UX reshape (sidebar grouping, empty states, paper-view refinements, settings layout).

A second agent is concurrently adding *features* in the main checkout. To minimize merge friction, this work happens in an isolated git worktree on branch `ui-themes-redesign`. The theme system (CSS variables + settings store) has the smallest conflict surface; the UX reshape touches shared components and will need manual reconciliation at merge time (user accepted this tradeoff).

## 2. Non-goals (YAGNI)

- No backend changes (theme is client-side only; backend stays a stateless CORS proxy).
- No new runtime dependencies (no Tailwind, no CSS-in-JS, no icon library). Pure CSS variables + existing stack. Emoji icons stay where used; inline SVG only where a real icon is needed.
- No RAG/slicing/auth (out of v1 scope per the original design doc).
- No auto-follow-system (`prefers-color-scheme`) in v1 of this change — manual themes only. Listed as an optional follow-up, not built now.
- No per-component theming API. Themes are global CSS-variable swaps, period.

## 3. Current State (baseline)

- `frontend/src/index.css` — single stylesheet (~380 lines). `:root` defines the dark palette via CSS custom properties; `[data-theme="light"]` overrides them. Applied by `<html data-theme="…">` set in `main.tsx` from the persisted `useSettings` store.
- `frontend/src/store/settings.ts` — `Theme = "dark" | "light"`, persisted via `zustand/persist` under `little-alphaxiv-settings`. `setTheme(t)` updates it.
- `frontend/src/views/SettingsView.tsx` — "Appearance" section renders a 2-button `style-presets` row (🌙 Dark / ☀ Light). CSS `.style-presets` / `.style-preset-btn` already exist.
- **Hardcoded-color debt**: the PDF viewer (`index.css` `.pdf-viewer`, `.pdf-toolbar`, `.pdf-toolbar button`) uses literal hex (`#404045`, `#2b2b30`, `#4a4a50`, `#4a4a50`, `#1a1a1e`, `#bbb`, `#0b0d12`) that ignore the theme variables — so it will NOT adapt to new themes. Wiring these to theme variables is a first-class deliverable.
- No motion/transitions beyond a few `:hover` color changes. System-font stack only. No focus-visible rings.

## 4. Design

### 4.1 Theme token system (foundation for both goals)

Extend the CSS custom-property set. **All existing variables are preserved** (backward compat with current rules), and new ones added. Every theme defines the full set; radius/shadow/motion are global defaults that any theme may override.

Surface:
- `--bg` (app background), `--bg-2` (panel/sidebar), `--bg-3` (raised/card), `--bg-4` (hover), `--bg-sunken` (code/pre)

Border:
- `--border`, `--border-strong`

Text:
- `--text`, `--text-dim`, `--text-faint`

Accent:
- `--accent`, `--accent-2` (slightly darker, for filled buttons), `--accent-soft` (low-opacity tint background), `--accent-contrast` (text on accent fill, usually white/near-white)

Semantic:
- `--danger`, `--ok`, `--warn`

Shape / depth / motion (global defaults):
- `--radius-sm` (4px), `--radius-md` (8px), `--radius-lg` (12px)
- `--shadow-sm`, `--shadow-md`
- `--transition-fast` (0.1s), `--transition-base` (0.18s)
- `--font-sans`, `--font-mono` (keep system stacks; tightened scale via direct rules)

PDF viewer (replaces hardcoded hex):
- `--pdf-bg`, `--pdf-toolbar-bg`, `--pdf-toolbar-btn`, `--pdf-toolbar-btn-hover`, `--pdf-page-shadow`, `--pdf-text` (toolbar text)

Reasoning / code-block tint:
- `--code-bg`, `--reasoning-bg`

### 4.2 Theme catalog (11 themes)

`Theme` becomes a string union of theme ids. The catalog lives in `frontend/src/themes.ts` as a typed constant.

| id | label | mode | accent | swatch (for settings preview) | origin |
|---|---|---|---|---|---|
| `dark` | Default Dark | dark | `#7c8cff` | indigo/charcoal | existing (refined) |
| `light` | Light | light | `#4f5dff` | blue/white | existing (refined) |
| `nord` | Nord | dark | `#88c0d0` | frost/slate | Nord |
| `tokyo-night` | Tokyo Night | dark | `#7aa2f7` | blue-purple/cyan | Tokyo Night |
| `gruvbox-dark` | Gruvbox Dark | dark | `#fabd2f` | amber/olive | Gruvbox |
| `catppuccin-mocha` | Catppuccin Mocha | dark | `#cba6f7` | mauve/dark | Catppuccin |
| `solarized-dark` | Solarized Dark | dark | `#2aa198` | teal/base03 | Solarized |
| `solarized-light` | Solarized Light | light | `#268bd2` | blue/base3 | Solarized |
| `sepia` | Sepia / Paper | light | `#b8632e` | warm cream/brown (reading-focused) | custom |
| `dracula` | Dracula | dark | `#bd93f9` | purple/pink | Dracula |
| `rose-pine` | Rosé Pine | dark | `#ebbcba` | rose/iris | Rosé Pine |

Coverage rationale: cold/warm/neutral palettes, dark/light, a paper-reading light theme, and popular community palettes — enough variety to satisfy "several interface styles." Adding/removing a theme = append one CSS block + one catalog row.

Each CSS block: `[data-theme="<id>"] { --bg: …; … all tokens … }`. `:root` keeps the default-dark values (so a missing/unknown `data-theme` falls back gracefully). The existing `[data-theme="light"]` block is kept and enriched.

### 4.3 Backward compatibility for persisted theme

`settings.ts` migrates the old `Theme = "dark"|"light"`:
- `theme` field stays a string in localStorage.
- On read, if the stored value is `"dark"` → map to `"dark"` (id unchanged); `"light"` → `"light"` (id unchanged). Both old ids are valid catalog ids, so no migration needed — they remain first-class themes.
- `Theme` type widens to the union of catalog ids. `setTheme(id: Theme)`.

No data migration script required; old values are already valid ids.

### 4.4 Settings UI — theme grid

`SettingsView` "Appearance" replaces the 2-button preset row with a **theme grid**:
- Each theme is a card showing a 4-swatch row (bg / panel / accent / text) + the theme label.
- Clicking a card calls `setTheme(id)`; the active card gets a ring/border in the theme's accent.
- Cards arranged in a responsive wrap (`display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr))`).
- A small "mode" chip (🌙/☀) on each card indicates dark/light.

The existing `.style-presets`/`.style-preset-btn` CSS is repurposed into `.theme-grid`/`.theme-card`.

### 4.5 Quick theme switch in sidebar footer

The sidebar footer gains a compact theme-switch affordance (e.g., a small dropdown or a cycle button) so the user can change themes without entering Settings. Keeps the existing "provider status" + "settings" button. This is additive, low-risk.

### 4.6 Visual polish (applies to all themes)

- Replace magic-number radii/borders with `--radius-*` / `--border` tokens across the stylesheet.
- Add `transition: var(--transition-base)` on theme-relevant properties (bg, border, color) so theme switches animate smoothly (a single global rule on `*` guarded to only transition colors, to avoid layout-transition jank: `* { transition: background-color var(--transition-base), border-color var(--transition-base), color var(--transition-base); }`).
- `:focus-visible` rings using `--accent` for keyboard a11y.
- Themed scrollbars (`::-webkit-scrollbar-thumb` already uses `--border`; extend to `--bg-4` on hover).
- Tighten the type scale and font-weight ratios; keep system font stack (`--font-sans`), monospace for code (`--font-mono`).
- Consistent shadow elevation on cards/popovers using `--shadow-sm/md`.

### 4.7 UX reshape (scope accepted by user)

- **Sidebar**: group conversations by type (💬 General / 📄 Paper) with section labels; refine the "New chat" button; polish logo + footer (theme quick-switch + settings). Collapsed state shows clean icons.
- **Chat**: refine message rhythm/spacing; collapsible reasoning block; streaming caret indicator; friendlier empty state with suggested prompts; polished input row (attachment + send, already present — refine visuals).
- **Paper view**: PDF viewer de-hardcoded to theme variables; refined toolbar, history panel, and resizable divider grip.
- **Settings**: theme grid (4.4); tighter provider cards with validation hints.
- **States**: consistent loading/skeleton, empty, and error treatments using tokens.

### 4.8 File-level changes (planned footprint)

- `frontend/src/index.css` — major rewrite: token set, 11 theme blocks, PDF de-hardcoding, polish rules. Largest change; pure CSS, low merge-conflict risk on logic.
- `frontend/src/themes.ts` — NEW: typed `Theme` union + `THEMES` catalog (`{ id, label, mode, swatch: string[] }[]`).
- `frontend/src/store/settings.ts` — widen `Theme` to union; keep `setTheme`.
- `frontend/src/views/SettingsView.tsx` — theme grid UI.
- `frontend/src/components/Sidebar.tsx` — grouping + footer theme switch + polish.
- `frontend/src/components/ChatPanel.tsx`, `ChatToolbar.tsx`, `HistoryPanel.tsx`, `PaperCard.tsx` — polish + state treatments (small, targeted).
- `frontend/src/views/ChatView.tsx`, `PaperView.tsx` — empty states, layout polish.
- `frontend/src/components/PdfViewer.tsx` — likely unchanged (CSS-only de-hardcode), verify.
- `tools/drive_themes.py` — NEW: screenshot every theme via the existing Playwright+mock rig.

## 5. Testing & Verification

- **Type/build**: `npm run typecheck` (`tsc --noEmit`) + `npm run build` must pass.
- **E2E (keyless, via existing rig)**: backend on :8000 (`backend/run.sh`), frontend dev on :5173 (`npm run dev`), mock LLM on :5050 (`PYTHONUTF8=1 PYTHONIOENCODING=utf-8 /c/Users/Delig/.conda/envs/Agent_env/python.exe tools/mock_llm.py`). Invoke the env python directly, NOT `conda run` (GBK crash per project memory).
- `python tools/drive.py chat` then `python tools/drive.py paper` (run with the env python + UTF-8 env vars) — inspect `tools/shots/*.png` + summary line.
- **NEW `tools/drive_themes.py`**: iterate every theme id, set it in localStorage, screenshot chat + paper views into `tools/shots/themes/<id>-{chat,paper}.png`. Eyeball each, especially that the PDF viewer tracks the theme (no leftover hardcoded gray) and that contrast is legible.
- Implementation-time live iteration: `npm run dev` + the `impeccable` skill for in-browser UI tuning.

## 6. Git / Worktree workflow

1. `.gitignore` already updated to ignore `.worktrees/` and `.claude/worktrees/` (committed on `main`).
2. Worktree created at `.worktrees/ui-themes-redesign` on branch `ui-themes-redesign`, branching from `origin/main` (clean baseline `bb28b1e`). `main` stays untouched for the concurrent feature agent.
3. All implementation commits land on `ui-themes-redesign`; push to `origin ui-themes-redesign`.
4. On completion: optional PR via `gh`; manual reconciliation with the feature branch at merge.

Note: native `EnterWorktree` was blocked by a stale "not a git repo" session flag (repo was `git init`'d mid-session), so the manual `git worktree add` fallback (per the using-git-worktrees skill) is used. Cleanup at the end: `git worktree remove .worktrees/ui-themes-redesign`.

## 7. Merge-conflict risk notes

- **Lowest risk**: `index.css` (CSS only), `themes.ts` (new file), `settings.ts` (`Theme` type widen — additive).
- **Medium risk**: `SettingsView.tsx`, `Sidebar.tsx` (shared components the feature agent may also touch).
- **Highest risk**: `ChatPanel.tsx`, `ChatToolbar.tsx`, `PaperView.tsx` if the feature agent adds message/toolbar features. Mitigation: keep edits targeted and token-driven rather than restructuring component logic.

## 8. Open decisions (resolved during brainstorming)

- Theme direction: **curated named themes** (full palettes), not accent-only variants. ✓
- Optimization scope: **visual + UX reshape** (user accepted merge-conflict tradeoff). ✓
- Theme mechanism: **CSS variables** (extend existing `:root`/`[data-theme]` pattern). ✓
- Theme count: 11 (2 existing refined + 9 new). Adjustable. ✓

## 9. Success criteria

- 11 themes switchable from Settings (and quick-switch from sidebar), each visually distinct and legible.
- PDF viewer, code blocks, reasoning blocks, scrollbars, focus rings all track the active theme (no hardcoded colors in theme-affected areas).
- `tsc --noEmit` and `vite build` pass; Playwright `drive.py chat` + `paper` produce clean screenshots for the default theme; `drive_themes.py` produces a screenshot per theme with no obvious breakage.
- Sidebar grouping, empty states, and paper-view polish visibly improve information hierarchy.
