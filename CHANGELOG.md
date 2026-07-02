# Changelog

All notable changes to **Little Alphaxiv** are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Release notes are also published on the
[GitHub releases page](https://github.com/DylanUnicorn/little-alphaxiv/releases).

## [Unreleased]

## [v0.1.2] - 2026-07-03

A Zotero-focused release. Importing a PDF from your Zotero library could hang
indefinitely on "Importing…" then fail — and the cloud path was the only path.
This release **fixes the hang** and adds a **local-first** import that reads
PDFs straight off your local Zotero storage (fast, offline, quota-immune),
with a status hint so Docker users see how to enable it.

### Fixed

- **Zotero PDF import hanging on "Importing…"** — importing a Zotero PDF
  downloaded it from the Zotero web API's S3 file host, which from a Docker
  container's raw NIC is intermittently (and sometimes persistently) interfered
  with at the TCP layer: packets are silently dropped during the TLS handshake,
  *before* any response headers arrive. httpx's `read` timeout only starts
  once headers arrive, so the stall slid past the 90s read timeout and only
  ended at the OS TCP timeout (~5 min) — the "stuck on Importing… forever"
  symptom, followed by a blank `502: zotero download error: ReadTimeout`.
  Two fixes: (1) the PDF download now **retries once** on transient errors
  (it was the only Zotero read without a retry); (2) each attempt is wrapped
  in a **30s wall-clock cap** (`asyncio.wait_for`) so a stalled connection
  aborts in 30s, not 5 min. On a persistent stall both attempts end in ~60s
  with a clear message ("…upload the PDF manually via Open Paper → Upload
  Local PDF") instead of hanging.
  ([eb754e2](https://github.com/DylanUnicorn/little-alphaxiv/commit/eb754e2),
  [01cfce6](https://github.com/DylanUnicorn/little-alphaxiv/commit/01cfce6))

### Added

- **Local-first Zotero PDF import** — the PDF is also sitting on your local
  disk under the Zotero storage folder, so imports now read it **straight off
  local disk** via the local Zotero API's `file://` redirect, falling back to
  the (now retried + capped) cloud download only when local is unavailable.
  This dodges both the S3 throttle AND the cloud-storage-quota gap: a file
  that never synced to zotero.org (the cloud path returns 404) is still on
  local disk and imports fine. Native (`run.bat`/`run.sh`) needs **no config**;
  Docker sets `LAX_ZOTERO_LOCAL_BASE` + `LAX_ZOTERO_STORAGE_DIR` (see
  `deploy/.env.docker.example`). Measured: a 39.6 MB attachment that hung ~5
  min then failed now imports in **0.3 s** off the local disk.
  ([7a25eac](https://github.com/DylanUnicorn/little-alphaxiv/commit/7a25eac))
- **Local-first status + UI hints** — a new `GET /api/zotero/local-first-status`
  endpoint reports whether local-first is usable, with an actionable hint when
  it isn't (e.g. Docker deployed without the storage mount). Settings → Zotero
  shows a status line (✓ active, or ⚠ with the env vars to fix it + a docs
  link); the Import dialog shows a compact hint with a jump link to
  `/settings#zotero` when imports fall back to the slower cloud path — so
  users no longer wonder *why* an import is slow.
  ([e2a7870](https://github.com/DylanUnicorn/little-alphaxiv/commit/e2a7870))

## [v0.1.1] - 2026-07-02

A polish release fixing the three papercuts reported shortly after v0.1.0:
the code-block **copy button** (and its tooltip) landing in the wrong corner,
the **PDF-pane scrollbar** being invisible against its background, and a hard
**snap at the end** of scroll restore. Plus a sidebar-recency fix and a
smoother glide to the saved scroll position.

### Fixed

- **Code-block copy button + tooltip position** — the copy button on assistant
  code blocks (and its "Copy" tooltip bubble) landed at the top-LEFT corner of
  the block instead of the top-right. Root cause: the button is wrapped in a
  `<Tooltip>` whose host span collapses to a 0×0 box (both children are
  out-of-flow), which then became the button's containing block — so
  `top:6px;right:6px` resolved against a zero-width box at the top-left. The
  absolute positioning now lives on the host so it shrink-wraps the button and
  gets a real on-screen rect: the button sits top-right in-flow and the bubble
  is measured against that real rect (landing just below, horizontally
  centered on the button).
  ([0b48849](https://github.com/DylanUnicorn/little-alphaxiv/commit/0b48849),
  [475dcbc](https://github.com/DylanUnicorn/little-alphaxiv/commit/475dcbc))
- **PDF-pane scrollbar invisible** — the PDF scroll container sits on
  `--pdf-bg`, which has near-zero luminance contrast with the global
  scrollbar-thumb token `--border` (≈1.1:1 on the default dark theme:
  `#2a2f3a` thumb on `#34363d` bg), so the thumb was invisible: the pane kept
  scrolling (per-paper scroll-memory still worked) but looked like it had no
  scrollbar. The chat and sidebar panes don't hit this because their background
  is the darker `--bg`. Scoped a `--text-dim` thumb override to `.pdf-scroll`
  only, which flips tonally with the theme (light on dark `--pdf-bg`, dark on
  light) so it stays visible across all 11 palettes (~4.6:1 dark, ~3.0:1
  light); chat/sidebar scrollbars untouched.
  ([ef864d2](https://github.com/DylanUnicorn/little-alphaxiv/commit/ef864d2))
- **Scrollbar hover deepens, not brightens** — the previous fix made the
  `.pdf-scroll` thumb default `--text-dim` but hover `--text`, which on the
  default dark theme *brightened* the thumb (`#9aa0ad → #e6e8ee`) — the opposite
  of the expected "default lighter, hover darker" affordance. A plain token
  swap can't fix the direction: the dim/text/faint tokens reverse their
  lightness order between dark themes (text brightest) and light themes (text
  darkest), so any token pair points "brighter" in one palette and "darker" in
  the other. `:hover` now uses `color-mix(in srgb, var(--text-dim), #000 20%)`
  — mixing toward black lowers luminance unconditionally, so hover is always
  darker than default in every palette while staying lighter than `--pdf-bg`
  (~3.0:1 hover dark, ~4.0:1 light). WebKit/Chromium only (Firefox
  `scrollbar-color` has no `:hover` state).
  ([d670f8f](https://github.com/DylanUnicorn/little-alphaxiv/commit/d670f8f))
- **Fractional scroll-settle snap** — after the smooth glide landed at the
  target page top, the saved fractional offset was applied as one instant
  `scrollTop += delta` jump. `delta` can be up to a full page height (~1.1kpx),
  so after the smooth glide the view hard-cut to the page-middle — the "snaps
  at the end" regression. The delta is now eased with a short easeOutCubic
  (matching the main glide) scaled to the distance: small fractions settle
  gently, large fractions get a brisk eased finish, never an instant cut.
  ([0bc3565](https://github.com/DylanUnicorn/little-alphaxiv/commit/0bc3565))
- **Sidebar recency on "+ New chat" reuse** — a brand-new empty conversation
  is in-memory only and never persisted, so its `updated_at` is the moment it
  was created. `create({ reuseEmpty: true })` reused an existing empty chat but
  returned it with that stale `updated_at`, so in a long-lived session
  clicking "+ New chat" (or opening a paper) minutes/hours/days after the
  empty chat was first spawned sorted the row into an old recency bucket
  ("Yesterday" / "Previous 7 Days") instead of "Today", and not at the top of
  the list. `updated_at` is now refreshed on reuse (`created_at` stays as the
  true creation moment); empty conversations are still not persisted until the
  first message.
  ([b4468db](https://github.com/DylanUnicorn/little-alphaxiv/commit/b4468db))

### Changed

- **Glide to saved scroll position** — scroll-restore now uses a short ease-out
  glide that re-targets each frame by reading the target page-wrap's live rect
  (robust to the lazy-render placeholder heights shifting as pages render),
  cancels on user scroll (wheel/touch/keys) so it never fights the reader, and
  falls back to the instant restore for `prefers-reduced-motion`. Previously
  `scrollIntoView` (instant) flashed page 1 → target on every remount because
  the container starts at `scrollTop 0`. Final position is unchanged: same
  goal alignment + same fractional delta.
  ([888fa58](https://github.com/DylanUnicorn/little-alphaxiv/commit/888fa58))

### Tests

- New E2E driver exercising the code-block copy button + tooltip on a real
  code block rendered by the actual React components (against the mock LLM at
  `:5050`, reachable from the container via `host.docker.internal`), verifying
  the button lands top-right inside the box and the bubble lands below +
  horizontally centered on it. Complements the serverless static-layout test.
  ([dd06931](https://github.com/DylanUnicorn/little-alphaxiv/commit/dd06931))

## [v0.1.0] - 2026-07-02

First public release. Bundles the core reading + annotation + AI-chat
experience together with local-paper upload, Zotero reverse-import, per-paper
page memory, and anysearch web search. Full notes on the
[v0.1.0 release page](https://github.com/DylanUnicorn/little-alphaxiv/releases/tag/v0.1.0).

[v0.1.1]: https://github.com/DylanUnicorn/little-alphaxiv/releases/tag/v0.1.1
[v0.1.0]: https://github.com/DylanUnicorn/little-alphaxiv/releases/tag/v0.1.0
[Unreleased]: https://github.com/DylanUnicorn/little-alphaxiv/compare/v0.1.1...HEAD
