<div align="center">

# Little Alphaxiv

**English** | [中文](./README.zh-CN.md)

**A self-hosted, alphaxiv-style arXiv paper-reading workspace.**
Chat with an LLM to discover papers, then read the PDF side-by-side with a
paper-aware assistant. Bring your own key. Your data stays on your server.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Docker](https://img.shields.io/badge/Docker-ready-2496ED?logo=docker&logoColor=white)](./deploy/docker-compose.yml)
[![Python](https://img.shields.io/badge/Python-3.12+-3776AB?logo=python&logoColor=white)](./backend/requirements.txt)
[![FastAPI](https://img.shields.io/badge/FastAPI-0.110+-009688?logo=fastapi&logoColor=white)](https://fastapi.tiangolo.com)
[![React](https://img.shields.io/badge/React-18-61DAFB?logo=react&logoColor=black)](https://react.dev)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.5+-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](./CONTRIBUTING.md)

</div>

---

Little Alphaxiv is a self-hosted reading-and-discussion workspace for arXiv
papers. Ask the assistant what you're looking for in plain language; it searches
arXiv (and optionally the web) and surfaces results as clickable cards. Click
one and the PDF opens in the left panel with a paper-aware assistant in the
right panel — the paper's full text is injected into the conversation, so you
can discuss the *actual* content, highlight, annotate, and sync notes to Zotero.

Bring your own OpenAI-compatible API key — no quotas, no shared accounts, no
vendor lock-in. OpenAI, an OpenAI-compatible Anthropic gateway, local Ollama
with the OpenAI shim, one-api/new-api, etc. all work.

Each user registers an account; their chat history, PDF annotations, and
provider settings live on the **server** in a SQLite database, with API keys
**Fernet-encrypted at rest**. Switch browsers → sign back in → everything's
there.

```
 ┌─ Sidebar ─┐  ┌── General chat ──┐     ┌── Paper view ──────────────────┐
 │ + New chat│  │  find me papers   │     │  PDF (pdf.js)  │  Assistant     │
 │ conv list │  │  on X ...         │     │  preview       │  (paper text   │
 │ ⚙ Settings│  │  [clickable cards]│ ──▶ │  (left)        │   in context)  │
 │ ⎋ Log out │  └───────────────────┘     └────────────────┴────────────────┘
 └───────────┘
```

## ✨ Features

- **Conversational paper discovery** — describe what you want; the assistant
  calls a `search_arxiv` tool (and optionally `web_search`) and renders results
  as clickable paper cards.
- **Paper-aware chat** — pdf.js extracts the full text once (cached globally and
  deduplicated across users); the assistant discusses the paper's actual content.
- **PDF annotations** — rectangle / freehand / text / highlight tools with an
  undo-redo op stack, per-user and server-backed.
- **Per-user accounts** — register/login, httpOnly session cookies, bcrypt
  passwords; every query is scoped to the authenticated user.
- **Encrypted-at-rest API keys** — the plaintext key leaves the browser only
  once (at save); afterward the UI only shows a masked preview (`sk-m…cret`).
- **Password recovery** — email-based reset (SMTP or console), single-use tokens,
  session purge on reset.
- **Multi-provider** — configure multiple OpenAI-compatible providers, set a
  default per-conversation or globally.
- **Zotero integration** — local + connector + web API; one-click note sync from
  annotations.
- **11 themes** — dark-first, including sepia and solarized for long reading
  sessions.
- **One-time browser → server migration** — if you used the old browser-only
  build, your local data is imported into your account on first login.

## 🧱 Tech stack

| Layer      | Technology |
|------------|------------|
| Backend    | FastAPI, SQLModel, aiosqlite, Alembic, uvicorn |
| Frontend   | React 18, Vite 5, TypeScript, pdf.js, Zustand |
| Database   | SQLite (WAL mode) |
| Auth       | httpOnly session cookies (itsdangerous) + bcrypt + Fernet |
| PDF        | pdf.js (text extraction + annotation layer) |
| Tooling    | Vitest (frontend), pytest (backend), Playwright (E2E) |

## 🚀 Quick start (Docker)

The fastest way to run Little Alphaxiv — a single image builds the frontend and
serves it same-origin from the backend. The `LAX_SECRET_KEY` is auto-generated
into the `deploy/data` volume on first start, so there's **zero config** required.

```bash
git clone https://github.com/DylanUnicorn/little-alphaxiv.git
cd little-alphaxiv
cd deploy && docker compose up -d   # builds + starts on http://127.0.0.1:8000
```

Then:

1. Open **http://127.0.0.1:8000** → you're redirected to `/login`.
2. Click **Register**, pick a username + email + password.
3. Go to **⚙ Settings → Providers**, add an OpenAI-compatible provider
   (see [Configure a provider](#configure-a-provider)), set it default.
4. Back to the chat — ask: *"find me recent papers on vision transformers"*.

Data (SQLite DB, PDF cache, the persisted secret key) lives in `deploy/data/`.
View server logs with `docker compose logs -f little-alphaxiv` (run from
`deploy/`, or `docker logs little-alphaxiv` from anywhere). Stop with
`docker compose down`.

> **Password recovery without SMTP:** by default, reset links are printed to the
> container logs (no mail server needed for localhost). To email them, set
> `LAX_SMTP_URL` in a `.env` next to `docker-compose.yml` — see
> [Configuration](#configuration-env-vars).

## 📦 Installation

### A. Docker (recommended)

See [Quick start](#quick-start-docker) above. All Docker files live in the
`deploy/` directory — run commands from there. Optional advanced config via a
`.env` in `deploy/` (copy from `deploy/.env.docker.example`):

```bash
cd deploy
cp .env.docker.example .env      # optional — all values have sensible defaults
# edit .env to set LAX_PORT, LAX_SMTP_URL, LAX_SECURE_COOKIES, etc.
docker compose up -d
```

Customize the host port without editing the compose file:

```bash
cd deploy
LAX_PORT=8080 docker compose up -d
```

### B. Local development (two terminals, localhost-only)

```bash
# Terminal 1 — backend (Python 3.10+)
cd backend
./run.sh                        # Windows: run.bat
# run.sh/run.bat auto-point the backend at deploy/data/ (the SAME data dir
# Docker uses), so native dev and the container share one DB + secret key —
# no data fork. On first start this auto-creates deploy/data/little_alphaxiv.db
# + generates deploy/data/.lax_secret_key.

# Terminal 2 — frontend
cd frontend
npm install
npm run dev                     # http://127.0.0.1:5173
```

Open **http://127.0.0.1:5173** → register → add a provider → chat. Vite proxies
`/api/*` → `http://127.0.0.1:8000`. No env vars needed for the default setup —
`run.sh`/`run.bat` set `LAX_DATABASE_URL` + `LAX_PDF_CACHE` to `../deploy/data/`
for you (set your own to override). To run the backend and the container
**simultaneously**, don't — they share one SQLite file; use one or the other.

> **Upgrading from an older version?** If you have data in the old
> `backend/data/` location (pre-2026-06-30), copy it into `deploy/data/` to keep
> using it: `cp -r backend/data/* deploy/data/` (Windows: `Copy-Item
> backend\data\* deploy\data\ -Recurse -Force`). Everything carries over intact
> — the Fernet secret key is reused, so encrypted API keys + active sessions
> keep working. A fresh install just starts empty in `deploy/data/`.

> Windows users: prefer `run.bat` over `bash run.sh` — `bash` may resolve to
> WSL, whose Python 3.8 can't parse the backend's `str | None` syntax (needs
> Python 3.10+).

### C. LAN multi-user (colleagues register & log in)

`run.sh`/`run.bat` bind `127.0.0.1` only. For LAN access, serve the **built**
frontend from the backend (same-origin — avoids all cookie/CORS friction):

```bash
cd frontend && npm run build     # produces frontend/dist
cd ../backend
uvicorn app.main:app --host 0.0.0.0 --port 8000   # auto-mounts frontend/dist at "/"
```

Find your LAN IP (`ipconfig` → the `192.168.x.x` one). Colleagues open
**`http://<your-ip>:8000/`**, register their own account, add their own
provider, and chat. Everyone's data is independent and invisible to others.

> ⚠️ `--host 0.0.0.0` exposes the backend — keep it on the LAN, not the public
> internet (the DB holds everyone's encrypted API keys + chat history). For
> internet exposure, put it behind TLS and set `LAX_SECURE_COOKIES=true`.

## 🔑 Configure a provider

Click ⚙ **Settings → Providers** → add an OpenAI-compatible provider:

| Field    | Example                                   |
|----------|-------------------------------------------|
| Name     | OpenAI / My Gateway                       |
| Base URL | `https://api.openai.com/v1`               |
| API key  | `sk-...`                                  |
| Model    | `gpt-4o-mini`                             |

Any OpenAI-compatible endpoint works (OpenAI, an OpenAI-compatible Anthropic
gateway, local Ollama with the OpenAI shim, one-api/new-api, etc.). Set one as
default. The key is sent to the server once, encrypted with Fernet, and stored;
afterward the UI only shows a masked preview.

## ⚙️ Configuration (env vars)

All optional — defaults work for localhost. In Docker, set these in a `.env`
next to `deploy/docker-compose.yml` (copy from `deploy/.env.docker.example`).
For native dev, `run.sh`/`run.bat` set the data-dir vars for you; copy
`backend/.env.example` → `backend/.env` only to override other vars.

| Var | Default | Purpose |
|-----|---------|---------|
| `LAX_DATABASE_URL` | `sqlite:///./data/little_alphaxiv.db` | SQLite file (relative paths resolve under `backend/`). `run.sh`/`run.bat` point this at `../deploy/data/little_alphaxiv.db`; Docker uses `sqlite:////app/data/little_alphaxiv.db`. The secret key + reset log live next to the DB. |
| `LAX_SECRET_KEY` | *(auto-generated)* | Fernet key for encrypting stored API keys + signing session cookies. Auto-generated into `deploy/data/.lax_secret_key` (native dev + Docker share it) on first run — the DB, PDF cache, secret key, and reset log all live in one data dir. **Keep it secret — losing it orphans all encrypted keys + sessions.** |
| `LAX_ALLOWED_ORIGINS` | `http://127.0.0.1:5173,http://localhost:5173` | Comma-separated browser origins for CORS. Pinned (no `*`) because credentials flow through cookies. Add your LAN origin if running cross-origin. |
| `LAX_SECURE_COOKIES` | `false` | Set `true` behind HTTPS so the session cookie gets the `Secure` flag. |
| `LAX_SESSION_MAX_AGE_DAYS` | `30` | Session cookie + row lifetime. |
| `LAX_SMTP_URL` | *(unset)* | SMTP URL for password-reset emails, e.g. `smtps://user:pass@smtp.gmail.com:465`. Unset → reset links are printed to the logs (zero-config for localhost). |
| `LAX_SMTP_FROM` | *(SMTP user)* | `From:` address for reset emails. |
| `LAX_PASSWORD_RESET_TTL_MIN` | `30` | Reset-link lifetime in minutes. |
| `LAX_PDF_CACHE` | `deploy/data/pdf_cache` | PDF disk-cache dir (content-addressed, global, non-sensitive). `run.sh`/`run.bat` point here; Docker uses `/app/data/pdf_cache`. |
| `LAX_PORT` | `8000` | *(Docker only)* Host port to expose. |

## 🧠 How it works

- **Auth + persistence:** register/login; the backend sets an httpOnly
  `lax_session` cookie (signed via `itsdangerous`, looked up in a `sessions`
  table — logout deletes the row). Every API call is scoped to the authenticated
  `user.id`. Chat history, annotations, provider config, and settings all live
  in SQLite, per-user.
- **Discovery (general chat):** you describe what you want; the assistant calls
  `search_arxiv` (and optionally `web_search`); results render as clickable paper
  cards. Click → paper view.
- **Paper view:** the PDF loads via the proxy (cached to disk); pdf.js extracts
  the full text once, cached in a **global** `papers` table (same arxiv_id → same
  text, deduplicated across users); that text is injected into the chat context.
- **Tools run in the browser.** The backend proxies + persists; the OpenAI-style
  tool-calling loop lives in the frontend (`src/lib/llm.ts`).
- **One-time migration:** on first login after upgrading from the old
  browser-only version, if the browser still holds legacy IndexedDB + localStorage
  data, the app offers to import it into your account (idempotent).

For a deeper architecture tour, see [`CLAUDE.md`](./CLAUDE.md).

## 📁 Project structure

```
little-alphaxiv/
├── backend/                  # FastAPI: proxy + per-user persistence + auth
│   ├── app/
│   │   ├── main.py           # FastAPI app, lifespan, CORS, static mount, routers
│   │   ├── security.py       # Fernet (keys) + bcrypt (passwords) + itsdangerous (sessions)
│   │   ├── db.py             # async engine, WAL PRAGMAs, session factory
│   │   ├── models.py         # SQLModel tables + password_reset
│   │   ├── deps.py           # current_user — the per-user scoping chokepoint
│   │   ├── email.py          # password-reset delivery (SMTP or console)
│   │   └── routers/          # auth, providers, settings, conversations,
│   │                         #   annotations, papers, llm, search, pdf, models,
│   │                         #   zotero, zotero_note_sync, migrate, websearch, …
│   ├── alembic/              # migrations (lifespan runs `upgrade head` on startup)
│   ├── tests/                # pytest (conftest builds a per-test temp SQLite)
│   ├── requirements.txt
│   └── run.sh / run.bat
├── frontend/                 # Vite + React + TypeScript SPA
│   ├── src/
│   │   ├── lib/              # api, llm (tool-calling loop), stores, annotations
│   │   ├── components/       # ChatPanel, PdfViewer, AnnotLayer, Sidebar, …
│   │   ├── views/            # ChatView, PaperView, SettingsView
│   │   └── store/            # zustand stores (hydrated from backend on login)
│   └── package.json
├── tools/                    # Playwright E2E drivers + mock LLM + admin CLIs
├── docs/designs/             # validated design docs
├── deploy/                   # all Docker files (build + run + data volume)
│   ├── Dockerfile            # multi-stage: build frontend → run backend + serve dist
│   ├── docker-compose.yml    # one-command self-hosted run (build context = repo root)
│   ├── entrypoint.sh         # auto-generates + persists LAX_SECRET_KEY
│   ├── .env.docker.example   # optional compose env overrides
│   └── data/                 # runtime data volume (DB + key + PDF cache; gitignored)
└── .dockerignore             # build-context exclusions (stays at repo root)
```

## 🔒 Security

- API keys are stored server-side, **Fernet-encrypted at rest** (keyed by
  `LAX_SECRET_KEY`). The plaintext key leaves the browser only once — when you
  save a provider — and is decrypted in memory only for the duration of one
  upstream LLM call (or to show the masked preview back to you, the owner). It
  is never logged.
- Passwords are bcrypt-hashed. Sessions are httpOnly + signed cookies backed by
  a DB table (logout = row delete).
- Password reset tokens are single-use, TTL-bounded, and only `sha256(token)` is
  stored. The `forgot-password` endpoint always returns the same generic success
  — it never reveals whether an account exists (anti-enumeration). Resetting
  purges all of the user's sessions.
- The app is designed for a **trusted LAN**. Don't expose it to the public
  internet without adding TLS (`LAX_SECURE_COOKIES=true`) and reconsidering
  registration openness.

## 🗺 Roadmap

| Area | Status |
|------|--------|
| Auth, persistence, encrypted keys, password recovery | ✅ verified |
| arXiv search + tool-calling, PDF preview, paper chat | ✅ verified |
| PDF annotations (rect/draw/text/highlight) | ✅ verified |
| Zotero integration (local + web) | ✅ working; per-request creds (v1) |
| `web_search` via anysearch MCP | ⏳ stub — real wiring TODO |

Known follow-ups (non-blocking) live in [`CLAUDE.md`](./CLAUDE.md). Notable ones:
real anysearch MCP wiring; a handful of Playwright drivers in `tools/` still use
the old localStorage seed pattern; the Zotero router still takes per-request
creds (functional, future cleanup).

## 🤝 Contributing

Contributions are welcome! See [`CONTRIBUTING.md`](./CONTRIBUTING.md) for the
full guide. The short version:

```bash
# Backend (Python 3.10+)
cd backend && ./run.sh                 # Windows: run.bat

# Frontend
cd frontend && npm install && npm run dev

# Tests (the gates)
cd frontend && npm run typecheck && npm test      # frontend (TS + Vitest)
cd backend && python -m pytest                   # backend (pytest)
```

The E2E rig (Playwright + a mock LLM on `:5050`) lets you verify frontend
changes with **no real API key** — see [`tools/mock_llm.py`](./tools/mock_llm.py)
and the `tools/drive_*.py` drivers. `drive_auth_persistence.py` and
`drive_password_reset.py` are the canonical regressions.

Before opening a PR: run the gates above, keep the diff focused, and
[open an issue](https://github.com/DylanUnicorn/little-alphaxiv/issues) first for
larger changes so we can align on direction.

## ❓ FAQ

<details>
<summary><b>Is my API key safe?</b></summary>

Your key is sent to the server once (over your loopback/LAN), encrypted with
Fernet, and stored. It's decrypted in memory only for the duration of a single
upstream LLM call and never logged. The browser only ever holds a masked
preview. Lose `LAX_SECRET_KEY`, however, and all encrypted keys + sessions are
orphaned — back up `deploy/data/.lax_secret_key` (native dev + Docker share it).
</details>

<details>
<summary><b>Can I run this on the public internet?</b></summary>

It's designed for a trusted LAN. If you expose it publicly, put it behind TLS,
set `LAX_SECURE_COOKIES=true`, restrict `LAX_ALLOWED_ORIGINS`, and reconsider
whether registration should be open (anyone who registers can store an
encrypted key + chat history on your server).
</details>

<details>
<summary><b>How are papers stored? Are they shared?</b></summary>

PDF full text is extracted once and cached in a **global** `papers` table
(deduplicated across users by arxiv_id — same paper, one copy). Your
*conversations* and *annotations* are per-user and invisible to others. The PDF
file cache is content-addressed and non-sensitive.
</details>

<details>
<summary><b>I forgot my password and have no email on file.</b></summary>

Accounts created before email was required can't use the email flow. Set an
email in **Settings → Account** while logged in, or — if you're locked out now —
use the admin CLI to reset directly:

```bash
python tools/reset_password.py <username>   # bcrypt-hashes a new password in the DB
```
</details>

<details>
<summary><b>Which LLM providers work?</b></summary>

Any OpenAI-compatible `/v1/chat/completions` endpoint: OpenAI, an
OpenAI-compatible Anthropic gateway, local Ollama with the OpenAI shim,
one-api/new-api, etc. Add the base URL + key in Settings → Providers.
</details>

## 📄 License

Released under the [MIT License](./LICENSE) — © 2026 DylanUnicorn and
contributors.

---

<div align="center">

**If Little Alphaxiv is useful to you, please consider giving it a ⭐ — it helps others find it.**

</div>
