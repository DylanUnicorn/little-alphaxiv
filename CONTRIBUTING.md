# Contributing to Little Alphaxiv

Thanks for your interest in improving Little Alphaxiv! This is a small,
opinionated project — the guide below keeps contributions smooth.

## Development setup

You need **Python 3.10+** and **Node 18+**.

```bash
# Backend (Terminal 1)
cd backend
./run.sh                 # macOS/Linux — activates Agent_env if present, installs deps, runs uvicorn
# Windows: run.bat       # do NOT use `bash run.sh` on Windows (WSL Python 3.8 can't parse the backend)

# Frontend (Terminal 2)
cd frontend
npm install
npm run dev              # http://127.0.0.1:5173 (proxies /api → :8000)
```

For the Docker-based flow (no local Python/Node needed), see the
[README](./README.md#-quick-start-docker).

## The gates (run these before pushing)

```bash
cd frontend && npm run typecheck   # tsc --noEmit — the type gate (there is no lint script)
cd frontend && npm test            # Vitest
cd backend   && python -m pytest   # pytest (per-test temp SQLite via conftest)
```

These are the same checks CI will run. Keep them green.

## E2E verification (no real API key needed)

The Playwright rig in `tools/` + a mock OpenAI-compatible server (`tools/mock_llm.py`
on `:5050`) let you verify frontend changes without a real key. The canonical
regressions:

- **`tools/drive_auth_persistence.py`** — register → chat → refresh →
  fresh-browser login → data present → logout.
- **`tools/drive_password_reset.py`** — register → forgot → reset → auto-login →
  old pw fails → token single-use → anti-enumeration.

See the [README](./README.md#-contributing) and `CLAUDE.md` for the full rig
(run backend `:8000` + frontend `:5173` + mock LLM `:5050`, then a driver).

## Before you open a PR

1. **[Open an issue](https://github.com/DylanUnicorn/little-alphaxiv/issues)** for
   anything beyond a small fix or docs tweak — align on direction first.
2. **Keep the diff focused** — one logical change per PR.
3. **Match the surrounding code** — naming, comment density, conventions.
   `CLAUDE.md` documents the non-obvious ones (e.g. React.StrictMode is
   intentionally disabled; the empty-conversation rule; same-origin serving).
4. **Don't re-enable `React.StrictMode`** without reworking SSE abort behavior —
   double-mounting aborts in-flight streams.
5. **Never commit secrets** — `.env`, `*.db`, and the whole `deploy/data/`
   dir (DB, PDF cache, `lax_reset_links.log`, `.lax_secret_key`) are already
   gitignored. Keep it that way.

## Architecture orientation

- `CLAUDE.md` — the full architecture, data flow, and conventions (start here).
- `docs/designs/` — validated design docs per feature.
- `PRODUCT.md` — product positioning + design principles.

## Security-sensitive areas

Anything touching auth, password recovery, or key encryption is security-critical
and the reason backend tests exist. Be extra careful, keep tests green, and
prefer to open an issue before refactoring:

- `backend/app/security.py` — Fernet + bcrypt + itsdangerous.
- `backend/app/routers/auth.py` — register/login/logout/forgot/reset.
- `backend/app/email.py` — reset email delivery.

## License

By contributing, you agree your contributions will be licensed under the
[MIT License](./LICENSE).
