# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Little Alphaxiv — a self-hosted, alphaxiv-style arXiv paper-reading app. Chat with an LLM to discover papers (general chat); click a result and the PDF opens with a paper-aware assistant (paper view). Bring-your-own OpenAI-compatible API key.

User data (chat history, PDF annotations, provider config, settings) lives in a **server-side SQLite database**, scoped per-user via httpOnly session-cookie auth. The backend is no longer a stateless proxy — it owns the DB and authenticates users — but it still proxies arXiv / LLM gateways / PDFs (those send no CORS headers). The plaintext LLM API key is stored server-side **Fernet-encrypted at rest**; the browser only ever sends a `provider_id`.

Not a monorepo: `frontend/` and `backend/` are independent — run both manually.

## Autonomy

Act on your own judgment — don't checkpoint every change. If you spot a bug or have a clear idea for a feature or improvement, just fix or implement it; don't stop to ask for permission first. Pick a reasonable approach, do the work in a worktree (see Workflow below), then report what you changed and why. Only pause to ask when a decision is genuinely irreversible or outward-facing and you can't infer the right call from the code, design docs, or existing conventions.

## Workflow (always work in a fresh worktree)

For every task, start a **new worktree** under `.claude/worktrees/` and do all edits, testing, and iteration there — never work directly on `main`. When the change is ready, merge it back into `main`. If another agent is mid-merge, wait a bit and retry instead of racing it; if the merge conflicts, resolve them. After a successful merge, delete the worktree (remove the `node_modules` junction first — see "Working in worktrees" below) and push to the remote.

## Commands

### Frontend (`cd frontend`)
- `npm run dev` — Vite dev server on `:5173` (proxies `/api/*` → `http://127.0.0.1:8000`)
- `npm run typecheck` — `tsc --noEmit` (the type gate; **there is no lint script** — typecheck is the gate)
- `npm run build` — `tsc --noEmit && vite build`
- `npm test` — Vitest (`vitest run`); `npm run test:watch` to watch
- One test file: `npx vitest run src/lib/dates.test.ts`
- One test by name: `npx vitest run -t "keeps input order"`

### Backend (`cd backend`)
- `./run.sh` — activates the `Agent_env` conda env if present, installs deps if missing, runs `uvicorn app.main:app --host 127.0.0.1 --port 8000 --reload`
- Windows CMD: `run.bat` — same as `./run.sh` but native to CMD. **On Windows, do NOT use `bash run.sh`**: `bash` often resolves to WSL, whose Python 3.8 can't parse the backend's `str | None` syntax (needs Python 3.10+). `run.bat` uses the Windows conda `Agent_env` (Python 3.10).
- Manual: `pip install -r requirements.txt && uvicorn app.main:app --host 127.0.0.1 --port 8000 --reload`
- **Migrations run automatically** on startup: the `lifespan` in `main.py` runs `alembic upgrade head`. There is no separate `migrate` step; `run.sh`/`run.bat` are unchanged. To create a new migration after editing `app/models.py`: `alembic revision --autogenerate -m "..."` (run from `backend/`).
- **First run** auto-creates `backend/little_alphaxiv.db` and generates `LAX_SECRET_KEY` into `backend/.env` (keep it; losing it orphans all encrypted keys + sessions).
- **Backend tests (pytest):** `cd backend && python -m pytest` (run in `Agent_env`). Tests live in `backend/tests/`; `conftest.py` builds a per-test temp SQLite + runs the real app lifespan. The password-recovery feature is security-sensitive and is the reason backend tests exist — keep them green.
- Frontend gate: `npm run typecheck` + `npm test` (Vitest).

### E2E (Playwright, in `tools/`) — verify frontend changes with no real key
The sanctioned verification rig. Each `tools/drive_*.py` is a standalone Playwright (Python sync API) script; there is no `npm run e2e` wrapper. The app now requires auth, so drivers must register/login + seed a provider via the API (not localStorage). Run all three servers, then a driver:
1. Backend `:8000` → `cd backend && ./run.sh` (Windows: `run.bat`)
2. Frontend `:5173` → `cd frontend && npm run dev`
3. Mock OpenAI-compatible LLM `:5050` → `python tools/mock_llm.py` (in `Agent_env`)
4. A driver. **`drive_auth_persistence.py`** is the canonical auth+persistence regression (register → chat → refresh → fresh-browser login → data present → logout). **`drive_password_reset.py`** is the password-recovery regression (register → forgot → reset → auto-login → old pw fails → token single-use → anti-enumeration); it uses the console mail backend and scrapes the link from `backend/lax_reset_links.log`, so it needs no mock LLM. **`drive.py`** is the adapted general chat/paper scenario (`seed_provider` now registers `e2e_drive` + adds the mock provider via API). `drive_titles.py`/`drive_fixes.py`/`drive_themes.py` still use the old localStorage `seed_provider` and will fail until adapted.
- Mock-LLM provider: register a provider with `base_url=http://127.0.0.1:5050/v1`, `api_key=mock`; the backend decrypts `mock` and forwards `Bearer mock`, which the mock ignores. The mock's title-sniffing contract still applies (see below).

## Architecture

### The backend: proxy + per-user persistence + auth
The backend (`backend/app/`) does three jobs now:
1. **Proxy** arXiv / LLM gateways / PDFs (they send no CORS headers, so the browser can't reach them directly).
2. **Persist** per-user data in SQLite (`SQLModel` + `aiosqlite` + Alembic; WAL mode). 9 tables: `user` (now has nullable `email`), `session`, `providerrow` (api_key Fernet-encrypted), `conversationrow` (messages stored as a JSON column), `paper` (GLOBAL — no user_id, dedups `full_text`), `annotationrow`, `usersettings`, `zoteronotesyncrow`, `password_reset` (hashed single-use reset tokens). Migrations run on startup via the `lifespan` in `main.py` (`alembic upgrade head`).
3. **Authenticate** users via httpOnly `lax_session` cookies (signed by `itsdangerous`, looked up in the `session` table; logout = row delete). Passwords are bcrypt-hashed. The `current_user` dependency (`app/deps.py`) is the single chokepoint — **every protected router takes `user: User = Depends(current_user)` and filters every query by `user.id`**.

`base_url`/`api_key` no longer arrive per-request in the body. `/api/llm` and `/api/models` take a `provider_id`; the backend loads the `ProviderRow`, decrypts `api_key_enc`, and forwards `Authorization: Bearer <key>`. Providers are still configured via the browser UI, but the key is sent to the server **once** (at save) and stored encrypted; the frontend only ever sees a masked preview (`first4…last4`).

Routers (all under `/api`): `auth.py` (register/login/logout/me + `forgot-password`/`reset-password`/`PATCH account`; password reset uses hashed single-use tokens in `password_reset` and purges all the user's sessions on success — see `app/email.py` for SMTP/console delivery), `providers.py` (CRUD, key masked on read), `settings.py` (theme/searchSources/zotero, keys encrypted inside JSON), `conversations.py` (messages as JSON, list omits messages), `annotations.py` (per-user), `papers.py` (global cache), `migrate.py` (one-time browser→server import), `llm.py` (`POST /api/llm` passthrough + SSE), `search.py` (arXiv Atom→JSON), `pdf.py` (PDF proxy + disk cache + range support), `models.py` (`/v1/models` + `/models/test` for the Add-provider form), `websearch.py` (**stub** — anysearch MCP not yet wired), `semantic_scholar.py`, `openalex.py`, `zotero.py` (8 endpoints, still per-request Zotero creds in v1), `zotero_note_sync.py`.

The OpenAI-style tool-calling loop still lives in the frontend (`src/lib/llm.ts` `runConversation`), not the backend.

### Frontend data flow & persistence (server-backed)
Data lives on the server, hydrated on login. The browser holds nothing sensitive:
- **`store/settings.ts`** — **no longer** uses zustand `persist`; `load()` hydrates from `/api/settings` + `/api/providers` on login. Mutations update local state optimistically + fire backend writes (debounced PATCH for the settings slice). `Provider.api_key` is the masked display string. A tiny `lax-theme` localStorage cache is kept purely to avoid a FOUC before `load()` resolves.
- **`store/conversations.ts`** — `load()` calls `listConversations()` (no messages) then fetches each full conversation; every mutation PUTs to `/api/conversations/{id}`. The empty-conversation rule + `withConvLock` per-conversation write serialization are preserved.
- **`store/annotations.ts`** — `load()`/`persistOp()` call the API; the op-stack undo/redo + `drawSession` stay in-memory. `migrateAnnotation` (legacy `draw.points`→`strokes`) still runs on read.
- **`store/zoteroNoteSync.ts`** — hydrates from `/api/zotero-note-sync`; `syncing` is ephemeral.
- **`lib/db.ts`** — gutted to a thin shim delegating `getPaper`/`savePaper` to `/api/papers`. The old IndexedDB reader lives on as **`lib/legacyDb.ts`**, used once by **`lib/migrate.ts`** for the browser→server import.

Five independent zustand stores (`src/store/`): `conversations`, `settings`, `annotations`, `zoteroNoteSync`, `ui` (ephemeral). No context/redux.

Two flows share the `ChatPanel` component:
- **General chat** (`/chat/:id`, `ChatView`) — assistant surfaces papers as clickable `PaperCard`s; a link navigates to `/paper/<id>`.
- **Paper view** (`/paper/:arxivId[/:convId]`, `PaperView`) — two-pane (PDF | chat) with draggable divider. **Paper threads**: one paper has many sub-conversations that collapse to a single sidebar row; thread management lives in `HistoryPanel` inside the paper view, not the sidebar.

### Boot sequence (`App.tsx`)
On mount: `getMe()` → 401 redirects to `/login` → on success, `Promise.all([settings.load(), conversations.load(), zoteroNoteSync.load()])` → `applyTheme()` → `ensureRootChat()`. Unauthenticated users see only the `/login` route. `OriginBanner`/loopback-redirect (`lib/origin.ts`) were **removed** — server-side storage made per-origin browser state moot.

### The two LLM call paths (same `/api/llm` endpoint, different branches)
- `streamChat()` (`src/lib/api.ts`) — SSE streaming, drives the conversational tool-calling loop. Surfaces GLM-style `delta.reasoning_content` as a separate "thinking" stream. Body is `{provider_id, payload}` with `credentials:"include"`; the backend resolves + decrypts the provider key.
- `completeChat()` (`src/lib/api.ts`) — non-streaming (`stream:false`), used by title generation. Deliberately skips the SSE/tool machinery. Same `provider_id` body shape.

Model precedence for both: per-conversation override (`Conversation.model`) → provider default (`Provider.model`).

### Title generation (the recently-added feature)
On a conversation's first turn, `ChatPanel.send()` immediately sets a truncated-first-message title, runs the chat loop, then `void maybeSummarizeTitle(...)` (never awaited, wrapped to never throw) → `generateConversationTitle()` (`lib/llm.ts`) → `completeChat()`. On failure/slow the truncated title stays. Triggered exactly once per conversation; no backfill of existing ones. Read `docs/designs/2026-06-19-sidebar-title-summary-and-date-groups-design.md` before touching this.

## Non-obvious conventions

- **React.StrictMode is disabled** (`src/main.tsx`) — double-mounting aborts in-flight SSE streams. Do not re-enable without reworking abort behavior.
- **Empty-conversation rule** (`store/conversations.ts`) — a brand-new 0-message conversation lives in memory only and is never PUT to the backend (reload discards it). `create({ reuseEmpty: true })` reuses an existing empty conversation of the same shape instead of stacking duplicates — this is why clicking "+ New chat" repeatedly yields one row.
- **Paper-chat sidebar grouping** (`Sidebar.tsx`) — all threads for one `paper_id` collapse to one sidebar row whose title is the most-recent thread's title (falls back to `📄 <arxivId>`).
- **Mock-LLM title-sniffing contract** — `tools/mock_llm.py` detects title-generation requests by sniffing the system prompt for `"title generator"` and `"paper being discussed"`. If you change the title system/user prompt, keep these phrases or the mock misroutes title requests to the tool-call branch and the E2E rig breaks. The backend forwards `payload` verbatim, so these strings are untouched by the auth/provider_id change.
- **`ProviderRow.id` is a global PK** — the frontend generates a high-entropy `uid()`, so collisions are negligible in practice, but the id is unique across all users (not per-user). Test drivers that hardcode a fixed provider id (e.g. `mock-prov`) collide across users — use a per-username id (see `drive_auth_persistence.py`).
- **Date grouping** (`lib/dates.ts` `groupByDate`) — sidebar buckets: Today / Yesterday / Previous 7 Days / Previous 30 Days / `<Month Year>` (newest first; items keep input order so each section is MRU internally; `now` is injectable for deterministic tests). Used only in the left sidebar, not in the paper-view HistoryPanel.
- **arXiv links render in-app** — the general system prompt tells the model any `arxiv.org` link it writes renders as an in-app preview card, so citing papers by link is encouraged and never opens an external site.
- **Password reset security invariants** — `forgot-password` ALWAYS returns the same generic 200 (no account-existence leak); reset tokens are single-use (`password_reset.used_at`) + TTL-bounded + only `sha256(token)` is stored; a new forgot request supersedes the user's prior unused tokens; `reset-password` DELETES every `Session` row for that user before issuing a fresh one (old cookies die the instant the password changes). Email is required at registration going forward, but pre-migration accounts have `email=NULL` and must set one via `PATCH /api/auth/account` (Settings → Account) to enable recovery — `tools/reset_password.py` is the escape hatch for accounts with no email. Delivery: `app/email.py` sends via SMTP when `LAX_SMTP_URL` is set, else prints the link + appends to `backend/lax_reset_links.log` (the E2E driver scrapes it).
- **Backend env**: `LAX_PDF_CACHE` overrides the PDF disk-cache dir (default `~/.little_alphaxiv/pdf_cache`). New persistence/auth vars (all optional, defaults work for localhost): `LAX_DATABASE_URL` (SQLite file), `LAX_SECRET_KEY` (Fernet key — **auto-generated to `backend/.env` on first run; never delete or rotate it or all encrypted keys + sessions are orphaned**), `LAX_ALLOWED_ORIGINS` (pinned, no `*` — credentials need it), `LAX_SECURE_COOKIES` (true behind HTTPS), `LAX_SESSION_MAX_AGE_DAYS`. See `backend/.env.example`.

## Working in worktrees

Feature work happens in git worktrees under `.claude/worktrees/`. In a fresh worktree, `frontend/node_modules` is a **junction/symlink to the main repo's `frontend/node_modules`** — so `npm install` is usually unnecessary. To remove a worktree, delete the node_modules junction first (e.g. `rmdir` the link), then remove the worktree; never recursively delete a junctioned `node_modules` from the worktree side, and kill any orphaned `vite` process before removal.

- **If the junction target is incomplete** (e.g. vite fails with `Cannot find package '@babel/core'` — the main repo's `node_modules` can drift out of sync with `package-lock.json`), remove the junction (`rm frontend/node_modules`) and run `npm install` in the worktree for a complete private install. That real `node_modules` dir is gitignored.
- **Orphan backend processes**: `uvicorn --reload` spawns a multiprocessing worker; if the parent dies, the worker can keep holding `:8000` as an orphan socket that `Get-NetTCPConnection` reports under a now-dead PID (hard to kill, may need a reboot). Always stop the backend with **Ctrl+C** in its window, never by closing it. Before assuming "my code is broken," check whether a stale server is serving old code on the port.

## Docs

- `docs/designs/2026-06-17-little-alphaxiv-design.md` — main design doc (overall goals, Flow A/B split). In Chinese. **Note:** this predates the server-side persistence + auth change (2026-06-29) — it describes the original "dumb pipe / browser-only storage" architecture. The backend is no longer stateless; treat its architecture sections as historical context, not current truth. The current architecture is documented above and in `README.md`.
- `docs/designs/2026-06-18-pdf-annotation-layer-design.md` — PDF annotation layer (rect/draw/text/highlight, op-stack undo/redo). Still accurate (annotations are now server-backed but the layer/UI is unchanged).
- `docs/designs/2026-06-19-sidebar-title-summary-and-date-groups-design.md` — title-summary + date-group feature. Read before touching title or date logic.
