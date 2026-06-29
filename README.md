# Little Alphaxiv

A self-hosted, alphaxiv-style paper-reading app for you and a few friends.
Chat with an AI to find arXiv papers, click a link, and the PDF opens in the
left panel with a paper-aware assistant ready in the right panel. Bring your
own OpenAI-compatible API key — no quotas, no shared accounts.

Each user registers an account; their chat history, PDF annotations, and
provider settings live on the **server** (a SQLite database), encrypted at rest.
Switch browsers → just sign back in and everything's there. No more "my history
is gone because I cleared cookies / used a different machine."

```
 ┌─ Sidebar ─┐  ┌── General chat ──┐     ┌── Paper view ──────────────────┐
 │ + New chat│  │  find me papers   │     │  PDF (pdf.js)  │  Assistant     │
 │ conv list │  │  on X ...         │     │  preview       │  (paper text   │
 │ ⚙ Settings│  │  [clickable cards]│ ──▶ │  (left)        │   in context)  │
 │ ⎋ Log out │  └───────────────────┘     └────────────────┴────────────────┘
 └───────────┘
```

## What's here

- **`backend/`** — a FastAPI app. Originally a stateless CORS proxy; now also
  owns a **SQLite database** (`SQLModel` + `aiosqlite` + `Alembic`) for per-user
  persistence and **user auth** (httpOnly session cookies). It still proxies
  arXiv / LLM gateways / PDFs (those send no CORS headers), but your API key is
  now stored server-side, **Fernet-encrypted at rest**, and the browser only
  ever sends a `provider_id` — the plaintext key never travels with each chat
  request.
- **`frontend/`** — Vite + React + TypeScript SPA. State is hydrated from the
  backend on login; nothing of substance persists in the browser anymore (a
  tiny `lax-theme` localStorage cache is kept only to avoid a flash of the wrong
  colorscheme before login resolves).
- **`docs/designs/`** — the validated design docs.

## How it works

- **Auth + persistence:** register/login (`/login`); the backend sets an
  httpOnly `lax_session` cookie (signed via `itsdangerous`, looked up in a
  `sessions` table — logout deletes the row). Every API call is scoped to the
  authenticated `user.id`. Chat history, annotations, provider config, and
  settings all live in SQLite, per-user.
- **Discovery (general chat):** you describe what you want; the assistant calls
  a `search_arxiv` tool (and optionally `web_search`); results render as
  clickable paper cards. Click → paper view.
- **Paper view:** the PDF loads via the proxy (cached to disk); pdf.js extracts
  the full text once (`getTextContent`), cached in a **global** `papers` table
  (same arxiv_id → same text, deduplicated across users); that text is injected
  into the chat context so the assistant can discuss the paper's actual content.
- **Tools run in the browser.** The backend proxies + persists; the OpenAI-style
  tool-calling loop lives in the frontend (`src/lib/llm.ts`).
- **One-time migration:** on first login after upgrading from the old
  browser-only version, if the browser still holds legacy IndexedDB +
  localStorage data, the app offers to import it into your account (idempotent).

## Run it

### A. Single-machine (simplest, localhost-only)

Open **two** terminals:

```bash
# Terminal 1 — backend
cd backend
./run.sh                      # Windows: run.bat
# On first start this auto-creates little_alphaxiv.db + generates backend/.env

# Terminal 2 — frontend
cd frontend
npm install
npm run dev
```

Open **http://127.0.0.1:5173** → you're redirected to `/login` → click
**Register**, pick a username + email + password → **Settings** → add an OpenAI-compatible
provider (see below) and set it default → back to the chat. (The email is for
password recovery — see [Forgot password](#forgot-password).)

Vite proxies `/api/*` → `http://127.0.0.1:8000`. No env vars needed for the
default setup.

### B. LAN multi-user (the original goal: colleagues register & log in)

`run.sh`/`run.bat` bind `127.0.0.1` only. For LAN access, serve the built
frontend from the backend (same-origin — avoids all cookie/CORS friction):

```bash
# 1. Build the frontend (produces frontend/dist)
cd frontend && npm run build

# 2. Run the backend on 0.0.0.0; it auto-mounts frontend/dist at "/"
cd ../backend
uvicorn app.main:app --host 0.0.0.0 --port 8000
```

Find your LAN IP (`ipconfig` → the `192.168.x.x` one). Colleagues open
**`http://<your-ip>:8000/`** in their browser → each registers their own account,
adds their own provider, and chats. Everyone's data is independent and
invisible to others.

> Same-origin serving means you don't need to set `LAX_ALLOWED_ORIGINS`.
> ⚠️ `--host 0.0.0.0` exposes the backend — keep it on the LAN, not the public
> internet (the DB now holds everyone's encrypted API keys + chat history).

### Configure a provider

Click ⚙ Settings → add an OpenAI-compatible provider:

| Field    | Example                                   |
|----------|-------------------------------------------|
| Name     | OpenAI / My Gateway                       |
| Base URL | `https://api.openai.com/v1`               |
| API key  | `sk-...`                                  |
| Model    | `gpt-4o-mini`                             |

Any OpenAI-compatible endpoint works (OpenAI, an OpenAI-compatible Anthropic
gateway, local Ollama with the OpenAI shim, one-api/new-api, etc.). Set one as
default. The key is sent to the server **once** (over your loopback/LAN),
encrypted with Fernet, and stored; afterward the UI only shows a masked preview
(`sk-m…cret`).

Then start a new chat and ask: *"find me recent papers on vision transformers"*.

## Configuration (env vars, all optional)

Set in `backend/.env` (copy from `backend/.env.example`) or the environment.
Defaults work for localhost dev.

| Var | Default | Purpose |
|-----|---------|---------|
| `LAX_DATABASE_URL` | `sqlite:///./little_alphaxiv.db` | SQLite file (resolved relative to `backend/`). |
| `LAX_SECRET_KEY` | *(auto-generated on first run)* | Fernet key for encrypting stored API keys + signing session cookies. Written to `backend/.env` on first start; **keep it secret — losing it orphans all encrypted keys + sessions.** |
| `LAX_ALLOWED_ORIGINS` | `http://127.0.0.1:5173,http://localhost:5173` | Comma-separated browser origins for CORS. Pinned (no `*`) because credentials flow through cookies. Add your LAN origin if running cross-origin. |
| `LAX_SECURE_COOKIES` | `false` | Set `true` when behind HTTPS so the session cookie gets the `Secure` flag. |
| `LAX_SESSION_MAX_AGE_DAYS` | `30` | Session cookie + row lifetime. |
| `LAX_SMTP_URL` | *(unset)* | SMTP URL for sending password-reset emails, e.g. `smtps://user:pass@smtp.gmail.com:465`. Unset → reset links are printed to the backend terminal + `backend/lax_reset_links.log` (zero-config for localhost). |
| `LAX_SMTP_FROM` | *(SMTP user)* | `From:` address for reset emails. |
| `LAX_PASSWORD_RESET_TTL_MIN` | `30` | Reset-link lifetime in minutes. |
| `LAX_PDF_CACHE` | `~/.little_alphaxiv/pdf_cache` | PDF disk-cache dir (content-addressed, global, non-sensitive). |

## Status

| Area | Feature | State |
|------|---------|-------|
| Auth | register/login/logout, httpOnly session cookies, bcrypt | ✅ verified |
| Password recovery | email reset link (SMTP/console), single-use tokens, session purge on reset | ✅ verified |
| Persistence | SQLite + per-user conversations/annotations/providers/settings | ✅ verified |
| Security | API keys Fernet-encrypted at rest; plaintext key leaves browser only at save | ✅ verified |
| 1 | LLM proxy + streaming chat (now auth-aware, `provider_id`) | ✅ verified |
| 2 | arXiv search + tool-calling loop | ✅ verified (E2E via mock LLM) |
| 3 | PDF proxy + pdf.js preview + range | ✅ verified |
| 4 | Full-text extraction + paper chat | ✅ verified |
| 5 | Browser → server one-time migration | ✅ verified (E2E: data survives a browser switch) |
| 6 | anysearch MCP (`web_search`) | ⏳ stub — real wiring TODO |
| 7 | Settings + multi-provider (per-user) | ✅ verified |
| 8 | Zotero integration (local + web) | ✅ working; per-request creds (v1) |

### Known follow-ups (non-blocking)

- **Step 6 — real anysearch MCP wiring.** `backend/app/routers/websearch.py` is
  a placeholder.
- **~18 Playwright drivers** in `tools/` still use the old localStorage
  `seed_provider`; only `drive.py` and the new `drive_auth_persistence.py` were
  adapted to API-driven auth. They'll fail until adapted — doesn't affect the
  app itself.
- **`zotero.py` full migration** — the ~960-line router still receives Zotero
  creds per request (stored encrypted in `user_settings`, returned decrypted to
  the owner). Functional; a full rewrite to read creds from the DB inside each
  handler is a future cleanup.
- **Password recovery now exists** — see [Forgot password](#forgot-password).
  Emails a single-use reset link (SMTP when configured, else printed to the
  terminal); resetting purges all of the user's sessions. An admin CLI
  (`tools/reset_password.py`) is the escape hatch for accounts with no email.

## Forgot password

- On the login page, click **Forgot password?** and enter your username or
  email. A reset link is sent to the email on file (the endpoint always returns
  the same generic success — it never reveals whether an account exists).
- No SMTP configured (`LAX_SMTP_URL` unset)? The link is printed to the backend
  terminal and appended to `backend/lax_reset_links.log` — fine for localhost.
- Configure SMTP via `LAX_SMTP_URL` (e.g. `smtps://user:pass@smtp.gmail.com:465`)
  for real email. Gmail: use an app password, not your account password.
- Opening the link lets you set a new password; you're then auto-logged-in. The
  link is single-use and expires after `LAX_PASSWORD_RESET_TTL_MIN` (30 min).
- Accounts created before email was required (no email on file) can't use the
  email flow. Set an email in **Settings → Account** while logged in, or — if
  you're locked out *now* — use the admin CLI to reset directly:

  ```bash
  python tools/reset_password.py <username>
  ```

  It bcrypt-hashes a new password straight in the DB (no Fernet key needed) and
  optionally clears the user's sessions.

## Project layout

```
little_alphaxiv/
  backend/
    app/main.py              # FastAPI app, lifespan (DB+migrations+security init), CORS, routers
    app/security.py          # Fernet (api keys) + bcrypt (passwords) + itsdangerous (session cookie)
    app/db.py                # async engine, WAL PRAGMAs, session factory, get_session dependency
    app/models.py            # 8 SQLModel tables + password_reset
    app/deps.py              # current_user dependency (the per-user scoping chokepoint)
    app/routers/auth.py      # /api/auth/{register,login,logout,me,forgot-password,reset-password,account}
    app/email.py             # password-reset email delivery (SMTP or console backend)
    app/routers/providers.py # /api/providers — per-user provider CRUD (key masked on read)
    app/routers/settings.py  # /api/settings — theme, searchSources, zotero (keys encrypted)
    app/routers/conversations.py  # /api/conversations — messages stored as JSON column
    app/routers/annotations.py     # /api/annotations — per-user PDF annotations
    app/routers/papers.py    # /api/papers — GLOBAL paper cache (full_text dedup)
    app/routers/migrate.py   # /api/migrate/import — one-time browser→server import
    app/routers/llm.py       # /api/llm — passthrough + SSE (takes provider_id, decrypts key)
    app/routers/{search,pdf,models,websearch,semantic_scholar,openalex,zotero,zotero_note_sync}.py
    alembic/                 # migrations (lifespan runs `upgrade head` on startup)
    run.sh, run.bat, requirements.txt
  frontend/
    src/lib/api.ts           # fetch wrappers (credentials:include), SSE parser, auth/CRUD/migrate
    src/lib/llm.ts           # client-side tool-calling loop
    src/lib/db.ts            # thin shim → /api/papers (was IndexedDB)
    src/lib/legacyDb.ts      # read-only IDB reader, used once by migrate.ts
    src/lib/migrate.ts       # one-time browser→server import
    src/store/{settings,conversations,annotations,zoteroNoteSync,ui}.ts  # hydrate from backend
    src/pages/Login.tsx      # register/login + forgot-password link
    src/pages/ForgotPassword.tsx  # /forgot — request a reset link
    src/pages/ResetPassword.tsx   # /reset?token=… — set a new password
    src/components/{ChatPanel,PdfViewer,PaperCard,Sidebar}.tsx
    src/views/{ChatView,PaperView,SettingsView}.tsx
  tools/
    drive_auth_persistence.py  # E2E: register→chat→refresh→fresh-browser-login→data-present→logout
    drive_password_reset.py    # E2E: register→forgot→reset→auto-login→old-pw-fails→single-use
    reset_password.py          # admin CLI: reset a user's password directly in the DB
    mock_llm.py                # mock OpenAI-compatible server on :5050 (no real key needed)
    drive_*.py                 # other Playwright drivers (most still on the old seed pattern)
  docs/designs/
```

## Security note

API keys are stored server-side, **Fernet-encrypted at rest** (keyed by
`LAX_SECRET_KEY`). The plaintext key leaves the browser only once — when you
save a provider — travels over your loopback/LAN to the backend, and is
decrypted in memory only for the duration of one upstream LLM call (or to show
the masked preview back to you, the owner). It is never logged. Passwords are
bcrypt-hashed. Sessions are httpOnly + signed cookies backed by a DB table
(logout = row delete).

The app is designed for a trusted LAN. Don't expose it to the public internet
without adding TLS (`LAX_SECURE_COOKIES=true`) and reconsidering registration
openness.
