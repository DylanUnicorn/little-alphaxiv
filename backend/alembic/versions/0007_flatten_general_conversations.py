"""flatten legacy general-conversation branches

Revision ID: 0007
Revises: 0006
Create Date: 2026-07-29

Conversation branching is scoped to paper-preview chats.  An earlier build
briefly allowed the same lineage fields on general chats, so normalize any
rows created by that build into independent flat conversations.  Message
content and all non-lineage metadata are intentionally preserved.
"""
from __future__ import annotations

from alembic import op


revision = "0007"
down_revision = "0006"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        UPDATE conversationrow
        SET history_id = id,
            parent_id = NULL,
            branch_from_message_index = NULL,
            branch_excerpt = NULL
        WHERE type = 'general'
        """
    )


def downgrade() -> None:
    # The former parent/branch relationships cannot be reconstructed safely.
    # Leaving general conversations flat is lossless for their messages and
    # remains valid under the 0006 schema.
    pass
