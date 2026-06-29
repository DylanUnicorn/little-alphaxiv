"""Alembic env — synchronous (migrations run at startup via command.upgrade).

We use a sync engine here (plain sqlite3 via SQLAlchemy) because Alembic's
offline/online migration runner is sync; the async aiosqlite engine in app.db
is for the live app. The migration creates the same schema the models define.
"""
from __future__ import annotations

import os
import sys
from logging.config import fileConfig

from alembic import context
from sqlalchemy import engine_from_config, pool

# Make backend/ importable so `from app import models` works when alembic runs
# from the backend/ dir (it does — script_location = alembic, run from backend/).
this_dir = os.path.dirname(os.path.abspath(__file__))
backend_dir = os.path.dirname(this_dir)
sys.path.insert(0, backend_dir)

from app import models  # noqa: E402 — registers all SQLModel tables
import sqlmodel  # noqa: E402

config = context.config
if config.config_file_name is not None:
    fileConfig(config.config_file_name)

# Resolve the DB URL the same way app.db does (relative path → backend/ dir).
_url = os.environ.get("LAX_DATABASE_URL", "sqlite:///./little_alphaxiv.db")
if _url.startswith("sqlite:///") and not _url.startswith("sqlite:////"):
    _path = _url[len("sqlite:///"):]
    if not os.path.isabs(_path):
        _path = os.path.join(backend_dir, _path)
    _url = f"sqlite:///{_path}"
config.set_main_option("sqlalchemy.url", _url)

target_metadata = sqlmodel.SQLModel.metadata


def run_migrations_offline() -> None:
    url = config.get_main_option("sqlalchemy.url")
    context.configure(
        url=url, target_metadata=target_metadata, literal_binds=True,
        dialect_opts={"paramstyle": "named"}, render_as_batch=True,
    )
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    connectable = engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )
    with connectable.connect() as connection:
        context.configure(
            connection=connection,
            target_metadata=target_metadata,
            render_as_batch=True,  # SQLite ALTER needs batch mode
        )
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
