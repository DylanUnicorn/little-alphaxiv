"""Async SQLite database layer.

Engine config rationale (plan §4): SQLite + WAL supports concurrent readers +
one writer; aiosqlite connections are serial per-connection. A small queue pool
(pool_size 5) lets several read queries coexist with the writer, and
busy_timeout makes a contended write wait instead of erroring. This is the right
trade-off for this app's load — one server process, each user writing only their
own rows.

PRAGMAs applied on every fresh connection via a SQLAlchemy connect event:
  * journal_mode=WAL   — concurrent readers + one writer
  * busy_timeout=5000  — wait up to 5s on a contended write instead of erroring
  * foreign_keys=ON    — enforce FK cascade/SET NULL
  * synchronous=NORMAL — WAL-safe, faster than FULL
"""
from __future__ import annotations

from typing import AsyncIterator

from sqlalchemy import event
from sqlalchemy.ext.asyncio import AsyncEngine, async_sessionmaker, create_async_engine
from sqlmodel.ext.asyncio.session import AsyncSession

from . import paths

# The aiosqlite driver. The user-facing env var LAX_DATABASE_URL uses the
# sqlite:/// form (familiar); paths.resolved_db_url() rewrites relative paths
# to absolute (against backend/, → backend/data/…) and we swap the driver here.


def _database_url() -> str:
    # resolved_db_url() handles the sqlite:/// → absolute rewrite + passes
    # non-sqlite URLs through unchanged; we just swap in the aiosqlite driver.
    return paths.resolved_db_url().replace("sqlite:///", "sqlite+aiosqlite:///")


engine: AsyncEngine = create_async_engine(
    _database_url(),
    echo=False,
    connect_args={"check_same_thread": False, "timeout": 30},
    pool_size=5,
    max_overflow=5,
    pool_pre_ping=True,
)


@event.listens_for(engine.sync_engine, "connect")
def _set_pragmas(dbapi_conn, _record):  # noqa: ANN001 — SQLAlchemy signature
    cur = dbapi_conn.cursor()
    cur.execute("PRAGMA journal_mode=WAL")
    cur.execute("PRAGMA busy_timeout=5000")
    cur.execute("PRAGMA foreign_keys=ON")
    cur.execute("PRAGMA synchronous=NORMAL")
    cur.close()


async_session_factory = async_sessionmaker(
    engine, class_=AsyncSession, expire_on_commit=False
)


async def get_session() -> AsyncIterator[AsyncSession]:
    """FastAPI dependency: yields a session, closes it on exit."""
    async with async_session_factory() as session:
        yield session


# ---------------------------------------------------------------------------
# Startup / shutdown
# ---------------------------------------------------------------------------


async def init_db() -> None:
    """Called from the FastAPI lifespan on startup.

    Only ensures the DB file is reachable + PRAGMAs are applied (the connect
    event does the latter). Schema creation is Alembic's job (run right after
    this in the lifespan) — we do NOT call create_all here, because that would
    create tables without stamping the alembic version, causing the subsequent
    `upgrade head` to fail with "table already exists".
    """
    # Importing .models registers every table model with SQLModel.metadata
    # (needed by alembic/env.py's target_metadata); the import side effect is
    # all we want here.
    from . import models  # noqa: F401
    # SQLite won't create the DB file's parent dir — make sure backend/data/
    # (or wherever LAX_DATABASE_URL points) exists before the first connect.
    paths.ensure_db_parent_dir()
    # Touch the engine so PRAGMAs (WAL etc.) get applied on the first conn.
    async with engine.connect() as conn:
        await conn.exec_driver_sql("SELECT 1")


async def close_db() -> None:
    """Called from the FastAPI lifespan on shutdown."""
    await engine.dispose()
