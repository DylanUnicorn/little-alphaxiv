"""Data-migration regressions."""
from __future__ import annotations

import json
from pathlib import Path

import sqlalchemy as sa
from alembic import command
from alembic.config import Config


def _alembic_config() -> Config:
    backend_dir = Path(__file__).resolve().parents[1]
    config = Config(str(backend_dir / "alembic.ini"))
    config.set_main_option("script_location", str(backend_dir / "alembic"))
    return config


def test_0007_flattens_only_general_conversations_and_round_trips(
    tmp_path,
    monkeypatch,
):
    db_file = tmp_path / "migration.db"
    db_url = f"sqlite:///{db_file}"
    monkeypatch.setenv("LAX_DATABASE_URL", db_url)
    config = _alembic_config()

    command.upgrade(config, "0006")
    engine = sa.create_engine(db_url)
    root_messages = json.dumps([{"role": "assistant", "content": "root"}])
    child_messages = json.dumps(
        [
            {"role": "assistant", "content": "root"},
            {"role": "user", "content": "detail"},
        ]
    )
    rows = [
        {
            "id": "general-root",
            "type": "general",
            "paper_id": None,
            "history_id": "general-root",
            "parent_id": None,
            "branch_index": None,
            "branch_excerpt": None,
            "messages": root_messages,
        },
        {
            "id": "general-child",
            "type": "general",
            "paper_id": None,
            "history_id": "general-root",
            "parent_id": "general-root",
            "branch_index": 0,
            "branch_excerpt": "root",
            "messages": child_messages,
        },
        {
            "id": "paper-root",
            "type": "paper",
            "paper_id": "paper:test",
            "history_id": "paper-root",
            "parent_id": None,
            "branch_index": None,
            "branch_excerpt": None,
            "messages": root_messages,
        },
        {
            "id": "paper-child",
            "type": "paper",
            "paper_id": "paper:test",
            "history_id": "paper-root",
            "parent_id": "paper-root",
            "branch_index": 0,
            "branch_excerpt": "root",
            "messages": child_messages,
        },
    ]
    with engine.begin() as connection:
        connection.execute(
            sa.text(
                """
                INSERT INTO user (id, username, password_hash, created_at)
                VALUES (1, 'migration-user', 'hash', 1)
                """
            )
        )
        connection.execute(
            sa.text(
                """
                INSERT INTO conversationrow (
                    id, user_id, title, type, paper_id, messages,
                    created_at, updated_at, history_id, parent_id,
                    branch_from_message_index, branch_excerpt
                ) VALUES (
                    :id, 1, :id, :type, :paper_id, :messages,
                    1, 1, :history_id, :parent_id,
                    :branch_index, :branch_excerpt
                )
                """
            ),
            rows,
        )
    engine.dispose()

    command.upgrade(config, "head")
    engine = sa.create_engine(db_url)
    with engine.connect() as connection:
        migrated = {
            row.id: row
            for row in connection.execute(
                sa.text(
                    """
                    SELECT id, history_id, parent_id,
                           branch_from_message_index, branch_excerpt, messages
                    FROM conversationrow
                    ORDER BY id
                    """
                )
            ).mappings()
        }

    assert migrated["general-root"] == {
        "id": "general-root",
        "history_id": "general-root",
        "parent_id": None,
        "branch_from_message_index": None,
        "branch_excerpt": None,
        "messages": root_messages,
    }
    assert migrated["general-child"] == {
        "id": "general-child",
        "history_id": "general-child",
        "parent_id": None,
        "branch_from_message_index": None,
        "branch_excerpt": None,
        "messages": child_messages,
    }
    assert migrated["paper-child"]["history_id"] == "paper-root"
    assert migrated["paper-child"]["parent_id"] == "paper-root"
    assert migrated["paper-child"]["branch_from_message_index"] == 0
    assert migrated["paper-child"]["branch_excerpt"] == "root"
    assert migrated["paper-child"]["messages"] == child_messages
    engine.dispose()

    # The data-only downgrade intentionally keeps the safe flat shape, and a
    # subsequent upgrade remains idempotent.
    command.downgrade(config, "0006")
    command.upgrade(config, "head")
    engine = sa.create_engine(db_url)
    with engine.connect() as connection:
        general_child = connection.execute(
            sa.text(
                """
                SELECT history_id, parent_id,
                       branch_from_message_index, branch_excerpt, messages
                FROM conversationrow WHERE id = 'general-child'
                """
            )
        ).mappings().one()
        revision = connection.execute(
            sa.text("SELECT version_num FROM alembic_version")
        ).scalar_one()
    engine.dispose()

    assert dict(general_child) == {
        "history_id": "general-child",
        "parent_id": None,
        "branch_from_message_index": None,
        "branch_excerpt": None,
        "messages": child_messages,
    }
    assert revision == "0007"
