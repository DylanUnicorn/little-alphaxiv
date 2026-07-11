"""add provider API format

Revision ID: 0005
Revises: 0004
Create Date: 2026-07-11
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op


revision = "0005"
down_revision = "0004"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "providerrow",
        sa.Column(
            "api_format",
            sa.String(),
            nullable=False,
            server_default=sa.text("'chat_completions'"),
        ),
    )


def downgrade() -> None:
    op.drop_column("providerrow", "api_format")
