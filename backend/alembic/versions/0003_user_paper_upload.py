"""add user_paper_upload table

Revision ID: 0003
Revises: 0002
Create Date: 2026-07-01

Tables: per-user uploaded / Zotero-imported PDFs. The PDF bytes + extracted
full_text live here (user-private — for a paywalled upload the extracted text
IS the paywalled content). Shareable metadata is shared via the global paper
row (paper_id FK to paper.arxiv_id). Deduplicated per-user by content_hash.
See app/models.py for the SQLModel source.
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision = "0003"
down_revision = "0002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "user_paper_upload",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("user_id", sa.Integer, sa.ForeignKey("user.id", ondelete="CASCADE"), nullable=False),
        sa.Column("paper_id", sa.String, sa.ForeignKey("paper.arxiv_id", ondelete="CASCADE"), nullable=False),
        sa.Column("source", sa.String, nullable=False),
        sa.Column("content_hash", sa.String, nullable=False),
        sa.Column("stored_path", sa.String, nullable=False),
        sa.Column("zotero_item_key", sa.String, nullable=True),
        sa.Column("zotero_attachment_key", sa.String, nullable=True),
        sa.Column("full_text", sa.Text, nullable=True),
        sa.Column("byte_size", sa.Integer, nullable=False),
        sa.Column("uploaded_at", sa.Integer, nullable=False),
        sa.UniqueConstraint("user_id", "content_hash", name="uq_user_upload_hash"),
    )
    op.create_index("ix_user_paper_upload_user_id", "user_paper_upload", ["user_id"])
    op.create_index("ix_user_paper_upload_paper_id", "user_paper_upload", ["paper_id"])


def downgrade() -> None:
    op.drop_index("ix_user_paper_upload_paper_id", table_name="user_paper_upload")
    op.drop_index("ix_user_paper_upload_user_id", table_name="user_paper_upload")
    op.drop_table("user_paper_upload")
