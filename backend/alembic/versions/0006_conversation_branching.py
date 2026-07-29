"""add conversation History lineage

Revision ID: 0006
Revises: 0005
Create Date: 2026-07-29
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op


revision = "0006"
down_revision = "0005"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("conversationrow", sa.Column("history_id", sa.String(), nullable=True))
    op.add_column("conversationrow", sa.Column("parent_id", sa.String(), nullable=True))
    op.add_column(
        "conversationrow",
        sa.Column("branch_from_message_index", sa.Integer(), nullable=True),
    )
    op.add_column("conversationrow", sa.Column("branch_excerpt", sa.String(), nullable=True))
    # Every pre-feature conversation is one independent History root.
    op.execute("UPDATE conversationrow SET history_id = id WHERE history_id IS NULL")
    op.create_index("ix_conv_user_history", "conversationrow", ["user_id", "history_id"])
    op.create_index("ix_conv_user_parent", "conversationrow", ["user_id", "parent_id"])


def downgrade() -> None:
    op.drop_index("ix_conv_user_parent", table_name="conversationrow")
    op.drop_index("ix_conv_user_history", table_name="conversationrow")
    op.drop_column("conversationrow", "branch_excerpt")
    op.drop_column("conversationrow", "branch_from_message_index")
    op.drop_column("conversationrow", "parent_id")
    op.drop_column("conversationrow", "history_id")
