# Solarized PDF Page Wash — Stronger Tonal Alignment

**Date:** 2026-06-19
**Status:** Approved (option A)
**Scope:** `frontend/src/index.css` — Solarized Light + Solarized Dark PDF page rendering only.

## Problem

Under both Solarized themes, the PDF page reads as "untreated" and clashes with the
theme chrome around it:

- **Solarized Light:** paper stays near-white. `--pdf-page-bg` is base3 `#fdf6e3`
  (almost white), the canvas filter is a weak `sepia(0.15)`, and the `::after` wash
  uses a near-white `rgba(230,220,192, 0.16)`. The sidebar/panels are clearly warm
  cream (`#e6dcc0` / `#ddd2b0`), so a near-white page looks like it doesn't belong.
  A prior bump (0.10 → 0.16 alpha) was not enough.
- **Solarized Dark:** after `invert(1) hue-rotate(180deg)` the page is near-black,
  and the wash is a low-chroma text gray `rgba(147,161,161, 0.14)`. Gray-on-black
  reads as a generic dark theme, not Solarized's signature teal-black.

## Goal

Both Solarized PDF pages should clearly read as Solarized paper and match the chrome,
while text stays comfortably legible (≥ 4.5:1).

## Key mechanism facts (why these levers, why these numbers)

The visible text is baked into the canvas **bitmap**; the `.pdf-textlayer` above it is
transparent (selection only). Therefore:

- `--pdf-filter` (`sepia`/`invert`) is applied to the canvas — it shifts the whole page
  (text + paper together), **preserving their relative contrast**. This is the
  legibility-safe lever for the big tonal shift.
- `--pdf-tint` `::after` sits **on top** of the bitmap, so its alpha also dims text.
  Keep it moderate; use it for the chromatic "this is Solarized" signal, not the bulk
  of the tonal change.

We lean on the **filter** for the big tonal shift and the **wash** for the chromatic
signal.

## Design

### Solarized Light (near-white → clearly warm cream, aligning with cream chrome)

```css
[data-theme="solarized-light"] {
  --pdf-filter: sepia(0.38) brightness(0.97) saturate(1.08);
  --pdf-tint:   rgba(221, 210, 176, 0.22);   /* bg-4 cream #ddd2b0, was rgba(230,220,192,0.16) */
  --pdf-page-shadow: 0 2px 12px rgba(120,96,40,0.18);
}
```
- Also in the earlier per-theme block: `--pdf-page-bg: #eee8d5;` (base2 cream, was base3 `#fdf6e3` near-white).
- `sepia(0.38)` (was 0.15) + `saturate(1.08)` warms the paper noticeably toward
  Solarized cream without the heavy muddying the `sepia` theme uses.
- Wash color switches from near-white to the actual chrome cream `#ddd2b0` (bg-4) so the
  page matches the sidebar/panel tone instead of staying white.
- Paper grain `::before` opacity 0.045 → 0.06 (only solarized-light + sepia share it).

### Solarized Dark (gray-on-black → teal-black, the Solarized signature)

```css
[data-theme="solarized-dark"] {
  --pdf-filter: invert(1) hue-rotate(180deg);            /* unchanged safe inversion */
  --pdf-tint:   rgba(42, 161, 152, 0.18);                 /* accent teal #2aa198, was gray 147,161,161 @0.14 */
  --pdf-page-shadow: 0 2px 14px rgba(0,40,50,0.50);
}
```
- Single real change: wash color gray → **accent teal**, alpha 0.14 → 0.18. After
  inversion the page is near-black; a teal wash turns it teal-black (Solarized's
  identity) instead of generic gray-black. This is the change that makes it stop
  looking "untreated."
- Legibility: near-white inverted text (L≈0.9) over near-black+teal (L≈0.10) stays
  ~5.7:1 — well above 4.5:1.

### Comment update

The existing header comment says the accent is "not for coloring a page surface." For
**Solarized Dark specifically**, the teal *is* the theme, so this is a per-theme
exception. Update the comment block to state the exception explicitly (accent-as-wash
is allowed only for Solarized Dark, where the theme's identity is that hue).

## Out of scope

- The other 9 themes untouched.
- `@media (prefers-contrast: more)` still strips the wash (accessibility escape hatch).
- No JS, no TS, no build config — CSS only. `npm run typecheck` / `npm run build`
  unaffected.

## Verification

1. Worktree under `.claude/worktrees/`.
2. Backend :8000, frontend :5173 (worktree), mock LLM :5050.
3. `PYTHONUTF8=1 PYTHONIOENCODING=utf-8 /c/Users/Delig/.conda/envs/Agent_env/python.exe tools/drive_themes.py`
4. Eyeball `tools/shots/themes/solarized-light-paper.png` and
   `solarized-dark-paper.png` against the chrome. Confirm:
   - Light page is clearly warm cream, not near-white, matching the sidebar.
   - Dark page is clearly teal-black, not gray-black.
   - Text still legible in both.
5. If Light still too white → bump `sepia` to 0.45; if Dark teal too faint → bump wash
   alpha to 0.22. One iteration expected. Re-shoot.
6. Merge to `main`, delete worktree (rmdir node_modules junction first), push.
