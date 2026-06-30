"""Centralized runtime-data paths.

All runtime data — the SQLite DB, the PDF disk cache, the Fernet secret key,
and the password-reset link log — lives in ONE directory, so the backend root
stays clean and operators have a single thing to back up.

Resolution rule: the secret key + reset log live NEXT TO the DB (in the DB
file's parent dir). That way the convention is the same everywhere:

  * Local dev (no env overrides) → backend/data/
  * Docker (LAX_DATABASE_URL=sqlite:////app/data/little_alphaxiv.db) → /app/data/
  * Custom LAX_DATABASE_URL → wherever the operator put the DB.

Relative sqlite paths in LAX_DATABASE_URL resolve against the backend/ dir
(the parent of the app/ package) so the DB lands in backend/data/ regardless
of where uvicorn was launched from. This mirrors the old app/db.py resolution,
now shared with alembic/env.py so the two can't drift.

Non-sqlite LAX_DATABASE_URL values pass through unchanged (future-proof; the
secret-key/reset-log helpers fall back to backend/data/ in that case).
"""
from __future__ import annotations

import os
import shutil
from pathlib import Path

# backend/app/paths.py → up one dir → backend/
_BACKEND_DIR = Path(__file__).resolve().parent.parent
# Default data dir for local dev. In Docker the entrypoint + Dockerfile ENV
# point everything at /app/data via absolute LAX_DATABASE_URL / LAX_PDF_CACHE.
DATA_DIR = _BACKEND_DIR / "data"

# Default DB URL (relative sqlite path → resolved against backend/).
_DEFAULT_DB_URL = "sqlite:///./data/little_alphaxiv.db"

# Pre-consolidation locations (backend root) — migrated once on local-dev startup.
_LEGACY_DB = _BACKEND_DIR / "little_alphaxiv.db"
_LEGACY_LOG = _BACKEND_DIR / "lax_reset_links.log"


def resolved_db_url() -> str:
    """LAX_DATABASE_URL with relative sqlite paths resolved to absolute.

    Returns the sync ``sqlite:///`` form (callers swap the driver if needed).
    Non-sqlite URLs pass through unchanged. Four-slash absolute sqlite URLs
    (``sqlite:////abs/path``) are left alone.
    """
    url = os.environ.get("LAX_DATABASE_URL", _DEFAULT_DB_URL)
    if url.startswith("sqlite:///") and not url.startswith("sqlite:////"):
        path = url[len("sqlite:///"):]
        if not os.path.isabs(path):
            path = str(_BACKEND_DIR / path)
        url = f"sqlite:///{path}"
    return url


def _db_file_path() -> Path | None:
    """Absolute DB file path, or None for non-sqlite URLs."""
    url = resolved_db_url()
    if url.startswith("sqlite:///"):
        return Path(url[len("sqlite:///"):])
    return None


def db_parent_dir() -> Path:
    """Dir holding the DB. Secret key + reset log live here too.

    Falls back to DATA_DIR (backend/data) for non-sqlite URLs.
    """
    p = _db_file_path()
    return p.parent if p is not None else DATA_DIR


def ensure_db_parent_dir() -> Path:
    """Create the DB parent dir if missing (SQLite won't) and return it."""
    d = db_parent_dir()
    d.mkdir(parents=True, exist_ok=True)
    return d


def secret_key_path() -> Path:
    """Path to the persisted Fernet secret key (next to the DB)."""
    return db_parent_dir() / ".lax_secret_key"


def reset_log_path() -> Path:
    """Path to the console password-reset link log (next to the DB)."""
    return db_parent_dir() / "lax_reset_links.log"


def pdf_cache_dir() -> Path:
    """LAX_PDF_CACHE or backend/data/pdf_cache (Docker sets /app/data/pdf_cache)."""
    return Path(os.environ.get("LAX_PDF_CACHE", DATA_DIR / "pdf_cache"))


def migrate_legacy_paths() -> None:
    """One-time move of pre-consolidation scattered files into the data dir.

    Moves the SQLite DB (+ WAL/SHM siblings) and the reset-links log from the
    backend root into the data dir — but ONLY when the operator is on the
    default DB location (``LAX_DATABASE_URL`` unset). Tests set it to a temp
    path; Docker sets it to /app/data; both are already organized, so this is
    a no-op there. Idempotent and safe to run on every startup.

    The Fernet secret key is migrated separately in security._ensure_secret_key()
    (from backend/.env → next to the DB).
    """
    # Operator/test/Docker chose a location explicitly — leave everything as-is.
    if os.environ.get("LAX_DATABASE_URL"):
        return
    ensure_db_parent_dir()
    new_db = _db_file_path()  # backend/data/little_alphaxiv.db on the default
    if new_db is not None and not new_db.exists() and _LEGACY_DB.exists():
        shutil.move(str(_LEGACY_DB), str(new_db))
        # Move WAL/SHM siblings too so no committed txn is lost; SQLite recreates
        # -shm if absent, but -wal must travel with the main DB file.
        for ext in ("-wal", "-shm"):
            sib = _BACKEND_DIR / f"little_alphaxiv.db{ext}"
            if sib.exists():
                shutil.move(str(sib), str(new_db.parent / sib.name))
    new_log = reset_log_path()
    if not new_log.exists() and _LEGACY_LOG.exists():
        shutil.move(str(_LEGACY_LOG), str(new_log))
