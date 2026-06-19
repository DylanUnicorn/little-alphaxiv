# Solarized PDF Page Wash — Stronger Tonal Alignment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Solarized Light and Solarized Dark PDF pages clearly read as Solarized (warm cream paper / teal-black paper) and match the theme chrome, instead of looking near-white / generic gray-black.

**Architecture:** CSS-only change to `frontend/src/index.css`. Two per-theme variable blocks set the values; one shared `::after`/`::before` rule consumes them. No new selectors, no JS. The tonal shift leans on the canvas `--pdf-filter` (legibility-safe, shifts text+paper together), the chromatic signal on the `--pdf-tint` `::after` wash; `--pdf-page-bg` is the unfilled-paper color behind the canvas.

**Tech Stack:** CSS custom properties, Vite dev server, Playwright (`tools/drive_themes.py`) for visual verification against the mock LLM rig (no real API key).

**Spec:** `docs/superpowers/specs/2026-06-19-solarized-pdf-page-wash-design.md`

## Global Constraints

- Work in a fresh git worktree under `.claude/worktrees/` (per project CLAUDE.md). `frontend/node_modules` is a junction to the main repo's — do NOT `npm install`, do NOT recursively delete it; to remove the worktree, `rmdir` the junction first.
- CSS-only: no `.ts`/`.tsx`/`.js` edits. `npm run typecheck` and `npm run build` must still pass (they will — pure CSS).
- Only the two Solarized themes change. The other 9 themes are untouched.
- Keep `@media (prefers-contrast: more)` stripping the wash (accessibility escape hatch).
- Verify via the keyless Playwright rig. Invoke the env Python directly, NOT `conda run` (GBK crash per project memory): `PYTHONUTF8=1 PYTHONIOENCODING=utf-8 /c/Users/Delig/.conda/envs/Agent_env/python.exe`.
- No backend tests exist; no frontend unit test covers these CSS values — verification is visual via screenshots, so the "test" steps here are screenshot + eyeball checks, not `pytest`/`vitest`.

---

## File Structure

- **Modify:** `frontend/src/index.css` — three spots:
  1. The early per-theme `--pdf-page-bg` block (lines ~215-219) — Solarized Light `--pdf-page-bg` base3 → base2 cream.
  2. The "Per-theme PDF page tint" block (lines ~992-1009) — Solarized Dark wash gray→teal, Solarized Light filter+wash values.
  3. The Solarized Light paper-grain `::before` opacity (line ~1034) — 0.045 → 0.06, and the header comment block (~960-980) — note the Solarized-Dark accent exception.
- **No new files.**

---

### Task 1: Bump Solarized Light paper background to base2 cream

**Files:**
- Modify: `frontend/src/index.css` — the `[data-theme="solarized-light"]` block in the "Per-theme PDF canvas filter + code-block surface" section (~line 215).

**Interfaces:** Consumes nothing. Produces the `--pdf-page-bg` behind the canvas for Solarized Light.

- [ ] **Step 1: Read the current block to confirm exact text**

Run: read `frontend/src/index.css` lines 215-219.
Expected: the `[data-theme="solarized-light"] { --pdf-filter: none; --pdf-page-bg: #fdf6e3; ... }` block.

- [ ] **Step 2: Edit `--pdf-page-bg` from base3 to base2**

Change `--pdf-page-bg: #fdf6e3;` → `--pdf-page-bg: #eee8d5;` (Solarized base2, the warmer cream — matches the chrome better than near-white base3). Leave `--pdf-filter: none;` here for now (Task 3 overrides it in the tint block, which has higher CSS specificity by coming later with the same selector specificity — but to be safe and single-source, this early block keeps `--pdf-filter: none` and Task 3's later block wins; confirm in Task 4 screenshots).

old_string:
```
[data-theme="solarized-light"] {
  --pdf-filter: none; --pdf-page-bg: #fdf6e3;
  --code-bg: #eee8d5; --code-fg: #073642;
  --pdf-page-shadow: 0 2px 10px rgba(0,0,0,0.12);
}
```
new_string:
```
[data-theme="solarized-light"] {
  --pdf-filter: none; --pdf-page-bg: #eee8d5;
  --code-bg: #eee8d5; --code-fg: #073642;
  --pdf-page-shadow: 0 2px 12px rgba(120,96,40,0.18);
}
```
(Also aligns `--pdf-page-shadow` with the tint-block value to avoid a later-rule flip; same color, so no visual conflict.)

- [ ] **Step 3: Commit**

```bash
git add frontend/src/index.css
git commit -m "style(pdf): solarized-light paper base3 -> base2 cream"
```

---

### Task 2: Solarized Dark wash — gray → accent teal

**Files:**
- Modify: `frontend/src/index.css` — the `[data-theme="solarized-dark"]` line in the "Per-theme PDF page tint" block (~line 997).

**Interfaces:** Consumes `--pdf-tint` (used by `.pdf-page-canvas-wrap::after`). Produces the teal-black page for Solarized Dark.

- [ ] **Step 1: Read the current tint block to confirm exact line**

Run: read `frontend/src/index.css` lines 992-1009.
Expected: the dark-theme tint lines including `[data-theme="solarized-dark"]   { --pdf-filter: invert(1) hue-rotate(180deg); --pdf-tint: rgba(147,161,161,0.14); ... }`.

- [ ] **Step 2: Change wash color gray → accent teal, alpha 0.14 → 0.18**

old_string:
```
[data-theme="solarized-dark"]   { --pdf-filter: invert(1) hue-rotate(180deg); --pdf-tint: rgba(147,161,161,0.14); --pdf-page-shadow: 0 2px 14px rgba(0,40,50,0.50); }
```
new_string:
```
[data-theme="solarized-dark"]   { --pdf-filter: invert(1) hue-rotate(180deg); --pdf-tint: rgba(42,161,152,0.18); --pdf-page-shadow: 0 2px 14px rgba(0,40,50,0.50); }
```
`rgba(42,161,152,...)` is Solarized accent teal `#2aa198`. After inversion the page is near-black; this teal wash turns it teal-black — Solarized's identity — instead of generic gray. Legibility: near-white inverted text (L≈0.9) over near-black+teal (L≈0.10) ≈ 5.7:1, above 4.5:1.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/index.css
git commit -m "style(pdf): solarized-dark wash gray -> accent teal"
```

---

### Task 3: Solarized Light filter + wash — warm cream signal

**Files:**
- Modify: `frontend/src/index.css` — the `[data-theme="solarized-light"]` line in the tint block (~line 1008).

**Interfaces:** Consumes `--pdf-filter` (applied to canvas) and `--pdf-tint` (`::after`). Produces the warm-cream Solarized Light page.

- [ ] **Step 1: Read the current Solarized Light tint line**

Run: read `frontend/src/index.css` line 1008.
Expected: `[data-theme="solarized-light"]  { --pdf-filter: sepia(0.15) brightness(1.01);  --pdf-tint: rgba(230,220,192,0.16); --pdf-page-shadow: 0 2px 12px rgba(120,96,40,0.18); }`.

- [ ] **Step 2: Strengthen filter + switch wash to chrome cream**

old_string:
```
[data-theme="solarized-light"]  { --pdf-filter: sepia(0.15) brightness(1.01);  --pdf-tint: rgba(230,220,192,0.16); --pdf-page-shadow: 0 2px 12px rgba(120,96,40,0.18); }
```
new_string:
```
[data-theme="solarized-light"]  { --pdf-filter: sepia(0.38) brightness(0.97) saturate(1.08);  --pdf-tint: rgba(221,210,176,0.22); --pdf-page-shadow: 0 2px 12px rgba(120,96,40,0.18); }
```
- `sepia(0.15)`→`0.38` + `saturate(1.08)` warms the paper noticeably toward Solarized cream without the muddy heaviness of the `sepia` theme. `brightness(1.01)`→`0.97` keeps it from washing out.
- Wash `rgba(230,220,192,0.16)` (near-white) → `rgba(221,210,176,0.22)` = bg-4 chrome cream `#ddd2b0`, so the page matches the sidebar/panel tone.

- [ ] **Step 3: Bump Solarized Light paper-grain opacity 0.045 → 0.06**

old_string (in the `::before` rule, ~line 1034):
```
  opacity: 0.045;
  mix-blend-mode: multiply;
}
```
new_string:
```
  opacity: 0.06;
  mix-blend-mode: multiply;
}
```
This `::before` rule is shared by `sepia` and `solarized-light` only; bumping to 0.06 affects both. Acceptable — sepia already reads as paper, a touch more grain is fine and matches the "feels like paper" intent. (If sepia looks too grainy in Task 4, split the rule so only solarized-light uses 0.06 — note as a possible follow-up.)

- [ ] **Step 4: Commit**

```bash
git add frontend/src/index.css
git commit -m "style(pdf): solarized-light warm-cream filter + chrome-cream wash"
```

---

### Task 4: Update the header comment to note the Solarized-Dark accent exception

**Files:**
- Modify: `frontend/src/index.css` — the "Per-theme PDF page tint" header comment block (~lines 984-991).

**Interfaces:** None (comment only).

- [ ] **Step 1: Read the comment block**

Run: read `frontend/src/index.css` lines 984-991.
Expected: the comment explaining dark themes wash with the theme's text color and that "the accent is for actions and selection, not for coloring an entire page surface."

- [ ] **Step 2: Append the Solarized-Dark exception note**

old_string:
```
   This replaces the earlier accent-based wash — the accent is for actions and
   selection, not for coloring an entire page surface (impeccable: "accent for
   primary actions, current selection, state indicators only, not decoration";
   tinted neutrals at 0.005–0.015 chroma toward the brand's own hue). */
```
new_string:
```
   This replaces the earlier accent-based wash — the accent is for actions and
   selection, not for coloring an entire page surface (impeccable: "accent for
   primary actions, current selection, state indicators only, not decoration";
   tinted neutrals at 0.005–0.015 chroma toward the brand's own hue).
   EXCEPTION: solarized-dark washes with the accent teal itself, because for
   Solarized that hue IS the theme's identity — a gray wash reads as a generic
   dark theme, not Solarized. Per-theme, not a blanket rule. */
```

- [ ] **Step 3: Commit**

```bash
git add frontend/src/index.css
git commit -m "docs(css): note solarized-dark accent-wash exception in tint header"
```

---

### Task 5: Verify — typecheck, build, then visual screenshot sweep

**Files:**
- Run: `frontend/` (typecheck + build), `tools/drive_themes.py` (screenshots).

**Interfaces:** None.

- [ ] **Step 1: typecheck + build pass**

Run (in `frontend/`):
```bash
npm run typecheck && npm run build
```
Expected: both pass (CSS-only change; tsc/vite unaffected). If they fail, it's unrelated to this change — investigate, don't force.

- [ ] **Step 2: Bring up the three servers**

Three terminals (the worktree's vite; backend + mock from main or worktree):
1. `cd backend && ./run.sh`  → :8000
2. `cd frontend && npm run dev`  → :5173 (note if worktree picks :5174; then `APP_URL=http://127.0.0.1:5174` for the driver)
3. `PYTHONUTF8=1 PYTHONIOENCODING=utf-8 /c/Users/Delig/.conda/envs/Agent_env/python.exe tools/mock_llm.py`  → :5050

- [ ] **Step 3: Run the theme screenshot sweep**

Run:
```bash
PYTHONUTF8=1 PYTHONIOENCODING=utf-8 /c/Users/Dilig/.conda/envs/Agent_env/python.exe tools/drive_themes.py
```
(if vite is on :5174, prefix `APP_URL=http://127.0.0.1:5174`).
Expected: prints `paper : solarized-dark` and `paper : solarized-light` lines with `canvases=` > 0, ends with `THEMES_SHOT: 11 themes x 2 views` and no ERRORS. Output PNGs in `tools/shots/themes/`.

- [ ] **Step 4: Eyeball the two Solarized paper screenshots**

Open `tools/shots/themes/solarized-light-paper.png` and `solarized-dark-paper.png`. Confirm:
- **Light:** page is clearly warm cream (not near-white), matching the sidebar/panel tone. Text still legible.
- **Dark:** page is clearly teal-black (not generic gray-black). Text still legible.
- Neither page has obviously broken rendering (blank canvas, no shadow, etc.).

- [ ] **Step 5: Iterate if needed (one expected)**

If Light still reads too white → bump `sepia` 0.38→0.45 (Task 3 line) and re-shoot.
If Dark teal too faint → bump wash alpha 0.18→0.22 (Task 2 line) and re-shoot.
If sepia theme now looks too grainy → split the `::before` rule so only solarized-light uses 0.06, sepia stays 0.045.
Re-run Step 3 after each tweak. Commit each tweak.

- [ ] **Step 6: Final commit + merge to main**

When screenshots look right:
```bash
git add -A
git commit -m "style(pdf): solarized page wash verification pass" --allow-empty
```
Then merge the worktree branch into `main` (resolve conflicts if another agent merged meanwhile — wait + retry rather than racing), push to remote. Finally remove the worktree: kill any orphaned vite, `rmdir` the `frontend/node_modules` junction, then remove the worktree dir.

---

## Self-Review

**1. Spec coverage:** Spec's Solarized Light changes (filter `sepia(0.38) brightness(0.97) saturate(1.08)`, tint `rgba(221,210,176,0.22)`, page-bg `#eee8d5`, grain 0.06) → Task 1 (page-bg) + Task 3 (filter/tint/grain). Spec's Solarized Dark changes (tint `rgba(42,161,152,0.18)`, filter unchanged, page-bg unchanged) → Task 2. Spec's comment update → Task 4. Spec's verification → Task 5. All covered.

**2. Placeholder scan:** No TBD/TODO. Every code step shows the exact old/new strings. Verify steps name exact files and commands.

**3. Type/consistency:** `--pdf-page-shadow` value `0 2px 12px rgba(120,96,40,0.18)` appears identically in Task 1 (early block) and Task 3 (tint block) — consistent, no flip. `rgba(221,210,176,0.22)` matches `#ddd2b0` (221,210,176 ✓). `rgba(42,161,152,0.18)` matches `#2aa198` (42,161,152 ✓). Teal/grain selectors consistent.

One caveat surfaced: Task 1 edits the early per-theme block AND Task 3 edits the later tint block for the same selector — both set `--pdf-filter` for solarized-light. CSS later-rule-wins means Task 3's `sepia(0.38)...` takes effect (correct). Task 1's `--pdf-filter: none` in the early block is now shadowed but harmless; kept to avoid leaving the early block's filter divergent-looking. No bug.
