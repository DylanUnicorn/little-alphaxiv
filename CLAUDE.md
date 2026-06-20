# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Little Alphaxiv — a self-hosted, alphaxiv-style arXiv paper-reading app. Chat with an LLM to discover papers (general chat); click a result and the PDF opens with a paper-aware assistant (paper view). Bring-your-own OpenAI-compatible API key. All state lives in the browser; the backend is a **stateless CORS proxy**.

Not a monorepo: `frontend/` and `backend/` are independent — run both manually.

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
- No backend tests.

### E2E (Playwright, in `tools/`) — verify frontend changes with no real key
The sanctioned verification rig. Each `tools/drive_*.py` is a standalone Playwright (Python sync API) script; there is no `npm run e2e` wrapper. Run all three servers, then a driver:
1. Backend `:8000` → `cd backend && ./run.sh` (Windows: `run.bat`)
2. Frontend `:5173` → `cd frontend && npm run dev`
3. Mock OpenAI-compatible LLM `:5050` → `python tools/mock_llm.py` (in `Agent_env`)
4. A driver, e.g. `python tools/drive_titles.py` (titles + date groups), `drive_fixes.py` (regressions), `drive_themes.py` (theme screenshots), `drive.py` (chat/paper scenario).

## Architecture

### The backend is a dumb pipe; the tool-calling loop runs in the browser
arXiv and most LLM gateways send no CORS headers, so the browser can't reach them directly. The FastAPI backend (`backend/app/`) exists only to proxy. It stores nothing; permissive `allow_origins=["*"]` is acceptable precisely because it's stateless. `base_url`, `api_key`, and the full OpenAI payload arrive **per-request in the JSON body** — the proxy adds `Authorization: Bearer <key>` and forwards. Providers are configured in the browser UI, never server-side.

Routers (all under `/api`): `llm.py` (`POST /api/llm` passthrough + SSE), `search.py` (arXiv Atom→JSON), `pdf.py` (PDF proxy + disk cache + range support), `models.py` (`/v1/models` for the model dropdown), `websearch.py` (**stub** — anysearch MCP not yet wired).

The OpenAI-style tool-calling loop lives in the frontend (`src/lib/llm.ts` `runConversation`), not the backend.

### Frontend data flow & storage split
Two persistence layers by lifetime:
- **IndexedDB** (`src/lib/db.ts`, DB `little-alphaxiv` v2) — conversations (indexed by `updated_at`), papers (arxiv-id-keyed, holds extracted `full_text`), annotations. Written explicitly via `db.saveConversation()` on every conversation mutation.
- **localStorage** (key `little-alphaxiv-settings`, via zustand `persist`) — providers + API keys, theme, cached model lists.

Four independent zustand stores (`src/store/`): `conversations` (the core; **not** middleware-persisted — it writes to IDB itself), `settings` (persisted), `annotations` (op-stack undo/redo), `ui` (ephemeral). No context/redux.

Two flows share the `ChatPanel` component:
- **General chat** (`/chat/:id`, `ChatView`) — assistant surfaces papers as clickable `PaperCard`s; a link navigates to `/paper/<id>`.
- **Paper view** (`/paper/:arxivId[/:convId]`, `PaperView`) — two-pane (PDF | chat) with draggable divider. **Paper threads**: one paper has many sub-conversations that collapse to a single sidebar row; thread management lives in `HistoryPanel` inside the paper view, not the sidebar.

### The two LLM call paths (same `/api/llm` endpoint, different branches)
- `streamChat()` (`src/lib/api.ts`) — SSE streaming, drives the conversational tool-calling loop. Surfaces GLM-style `delta.reasoning_content` as a separate "thinking" stream.
- `completeChat()` (`src/lib/api.ts`) — non-streaming (`stream:false`), used by title generation. Deliberately skips the SSE/tool machinery.

Model precedence for both: per-conversation override (`Conversation.model`) → provider default (`Provider.model`).

### Title generation (the recently-added feature)
On a conversation's first turn, `ChatPanel.send()` immediately sets a truncated-first-message title, runs the chat loop, then `void maybeSummarizeTitle(...)` (never awaited, wrapped to never throw) → `generateConversationTitle()` (`lib/llm.ts`) → `completeChat()`. On failure/slow the truncated title stays. Triggered exactly once per conversation; no backfill of existing ones. Read `docs/designs/2026-06-19-sidebar-title-summary-and-date-groups-design.md` before touching this.

## Non-obvious conventions

- **React.StrictMode is disabled** (`src/main.tsx`) — double-mounting aborts in-flight SSE streams. Do not re-enable without reworking abort behavior.
- **Empty-conversation rule** (`store/conversations.ts`) — a brand-new 0-message conversation lives in memory only and is never written to IDB (reload discards it). `create({ reuseEmpty: true })` reuses an existing empty conversation of the same shape instead of stacking duplicates — this is why clicking "+ New chat" repeatedly yields one row.
- **Paper-chat sidebar grouping** (`Sidebar.tsx`) — all threads for one `paper_id` collapse to one sidebar row whose title is the most-recent thread's title (falls back to `📄 <arxivId>`).
- **Mock-LLM title-sniffing contract** — `tools/mock_llm.py` detects title-generation requests by sniffing the system prompt for `"title generator"` and `"paper being discussed"`. If you change the title system/user prompt, keep these phrases or the mock misroutes title requests to the tool-call branch and the E2E rig breaks.
- **Date grouping** (`lib/dates.ts` `groupByDate`) — sidebar buckets: Today / Yesterday / Previous 7 Days / Previous 30 Days / `<Month Year>` (newest first; items keep input order so each section is MRU internally; `now` is injectable for deterministic tests). Used only in the left sidebar, not in the paper-view HistoryPanel.
- **arXiv links render in-app** — the general system prompt tells the model any `arxiv.org` link it writes renders as an in-app preview card, so citing papers by link is encouraged and never opens an external site.
- **Backend env**: `LAX_PDF_CACHE` overrides the PDF disk-cache dir (default `~/.little_alphaxiv/pdf_cache`). Frontend needs no env vars.

## Working in worktrees

Feature work happens in git worktrees under `.claude/worktrees/`. In a fresh worktree, `frontend/node_modules` is a **junction/symlink to the main repo's `frontend/node_modules`** — so `npm install` is usually unnecessary. To remove a worktree, delete the node_modules junction first (e.g. `rmdir` the link), then remove the worktree; never recursively delete a junctioned `node_modules` from the worktree side, and kill any orphaned `vite` process before removal.

## Docs

- `docs/designs/2026-06-17-little-alphaxiv-design.md` — main design doc (overall goals, Flow A/B split, the "dumb pipe" decision). In Chinese.
- `docs/designs/2026-06-18-pdf-annotation-layer-design.md` — PDF annotation layer (rect/draw/text/highlight, op-stack undo/redo).
- `docs/designs/2026-06-19-sidebar-title-summary-and-date-groups-design.md` — title-summary + date-group feature. Read before touching title or date logic.
