"""Shared fixtures: a fresh app + temp SQLite per test (isolated).

Each test gets a brand-new temp SQLite file. We set LAX_DATABASE_URL, then
rebuild the module-level engine + session factory on app.db (the router's
get_session reads `async_session_factory` as a module global at call time, so
rebinding the attribute re-points every router for the test). We run the real
app lifespan (init_db + alembic upgrade head + init_security) so the schema
matches production exactly.
"""
from __future__ import annotations

import os

import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import event
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app import db as dbmod


@pytest_asyncio.fixture
async def client(tmp_path, monkeypatch):
    db_file = tmp_path / "test.db"
    db_url = f"sqlite:///{db_file}"
    monkeypatch.setenv("LAX_DATABASE_URL", db_url)
    os.environ["LAX_DATABASE_URL"] = db_url

    # Rebuild the module-level engine + factory to point at the fresh temp DB.
    # get_session() references `async_session_factory` as a module global at
    # call time, so rebinding the attribute re-points every router.
    dbmod.engine = create_async_engine(
        db_url.replace("sqlite:///", "sqlite+aiosqlite:///"),
        echo=False,
        connect_args={"check_same_thread": False, "timeout": 30},
        pool_size=5,
        max_overflow=5,
        pool_pre_ping=True,
    )

    @event.listens_for(dbmod.engine.sync_engine, "connect")
    def _pragmas(conn, _record):  # noqa: ANN001 — SQLAlchemy signature
        cur = conn.cursor()
        cur.execute("PRAGMA journal_mode=WAL")
        cur.execute("PRAGMA busy_timeout=5000")
        cur.execute("PRAGMA foreign_keys=ON")
        cur.execute("PRAGMA synchronous=NORMAL")
        cur.close()

    dbmod.async_session_factory = async_sessionmaker(dbmod.engine, expire_on_commit=False)

    from app.main import app

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        # Run the real startup so tables exist + security is initialized.
        async with app.router.lifespan_context(app):
            yield ac

    await dbmod.engine.dispose()
