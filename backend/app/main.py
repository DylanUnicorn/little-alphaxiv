"""Little Alphaxiv backend — CORS proxy + per-user persistence + auth.

Originally a stateless proxy (zero storage) that existed only to bypass browser
CORS for OpenAI-compatible LLM gateways, arXiv search, and arXiv PDFs. It now
also owns a SQLite store (see app/db.py) for per-user conversations, papers,
annotations, and encrypted provider/settings — and authenticates users via
httpOnly session cookies (see app/routers/auth.py).

The LLM api_key / base_url are NO LONGER sent per-request from the browser;
the browser sends a provider_id and the server resolves + decrypts the stored
provider row.
"""
from __future__ import annotations

import os
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse

from . import paths, security
from .db import close_db, init_db
from .routers import (
    annotations,
    auth,
    conversations,
    llm,
    migrate,
    models,
    openalex,
    paper_uploads,
    papers,
    pdf,
    providers,
    search,
    semantic_scholar,
    settings,
    websearch,
    zotero,
    zotero_note_sync,
)


@asynccontextmanager
async def lifespan(app: FastAPI):
    # 0. Consolidate any pre-consolidation scattered data files (DB, reset log)
    #    into backend/data/. No-op in Docker/tests — there LAX_DATABASE_URL is
    #    set explicitly, so the legacy backend-root files are left untouched.
    paths.migrate_legacy_paths()
    # 1. DB engine + tables (bootstrap; Alembic owns migrations going forward).
    await init_db()
    # 2. Run Alembic migrations to head so the schema is current.
    try:
        from pathlib import Path
        import alembic.command
        from alembic.config import Config as AlembicConfig

        backend_dir = Path(__file__).resolve().parent.parent
        cfg = AlembicConfig(str(backend_dir / "alembic.ini"))
        cfg.set_main_option("script_location", str(backend_dir / "alembic"))
        alembic.command.upgrade(cfg, "head")
    except Exception as exc:  # noqa: BLE001 — migrations must not crash startup
        print(f"[lax] alembic upgrade skipped: {exc}")
    # 3. Init security (Fernet + signer) from LAX_SECRET_KEY.
    security.init_security()
    app.state.security_ready = True
    yield
    await close_db()


app = FastAPI(title="Little Alphaxiv Proxy", version="0.2.0", lifespan=lifespan)

# Credentials now flow through httpOnly cookies, so CORS must use pinned origins
# (allow_credentials=True is incompatible with allow_origins=["*"]).
_origins = [
    o.strip()
    for o in os.environ.get(
        "LAX_ALLOWED_ORIGINS", "http://127.0.0.1:5173,http://localhost:5173"
    ).split(",")
    if o.strip()
]
app.add_middleware(
    CORSMiddleware,
    allow_origins=_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["*"],
)

app.include_router(auth.router, prefix="/api")
app.include_router(providers.router, prefix="/api")
app.include_router(settings.router, prefix="/api")
app.include_router(conversations.router, prefix="/api")
app.include_router(annotations.router, prefix="/api")
app.include_router(papers.router, prefix="/api")
app.include_router(paper_uploads.router, prefix="/api")
app.include_router(migrate.router, prefix="/api")
app.include_router(zotero_note_sync.router, prefix="/api")

app.include_router(llm.router, prefix="/api")
app.include_router(search.router, prefix="/api")
app.include_router(pdf.router, prefix="/api")
app.include_router(websearch.router, prefix="/api")
app.include_router(models.router, prefix="/api")
app.include_router(semantic_scholar.router, prefix="/api")
app.include_router(openalex.router, prefix="/api")
app.include_router(zotero.router, prefix="/api")


@app.get("/api/health")
async def health() -> dict:
    return {"status": "ok"}


# Serve the built frontend in production (same-origin → no CORS friction).
# Only mounts if the dist dir exists; dev uses the Vite server on :5173 instead.
_dist = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "..", "frontend", "dist")
_dist = os.path.normpath(_dist)
if os.path.isdir(_dist):
    # SPA history-fallback: React Router uses BrowserRouter (history mode), so
    # deep links like /reset, /login, /chat/:id, /paper/<id> must serve
    # index.html (not 404) — the client router then renders the right view.
    # StaticFiles(html=True) only falls back for directory requests, not for
    # arbitrary paths, so we add an explicit catch-all AFTER /api/* routes.
    # It serves a real static file if one exists at the path (assets/*,
    # favicon.svg, …), otherwise index.html for the client router to handle.
    _index = os.path.join(_dist, "index.html")

    @app.get("/{full_path:path}")
    async def spa_fallback(full_path: str, request: Request):
        # Never shadow API routes: an unmatched /api/* returns a proper 404
        # JSON (not the SPA shell), so clients get a real error status.
        if full_path.startswith("api/"):
            return JSONResponse({"detail": "Not Found"}, status_code=404)
        # Serve a real static file if it exists at that path (path traversal
        # guarded by the startswith check — candidate must stay under _dist).
        candidate = os.path.normpath(os.path.join(_dist, full_path))
        if (
            full_path
            and candidate.startswith(_dist + os.sep)
            and os.path.isfile(candidate)
        ):
            return FileResponse(candidate)
        # Otherwise fall back to index.html for the client router to handle.
        return FileResponse(_index)
