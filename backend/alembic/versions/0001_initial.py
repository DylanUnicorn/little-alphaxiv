"""initial schema — all 8 tables

Revision ID: 0001
Revises:
Create Date: 2026-06-29

Tables: user, session, providerrow, conversationrow, paper, annotationrow,
user_settings, zoteronotesyncrow. See app/models.py for the SQLModel source of
truth; this migration creates the matching SQL schema.
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision = "0001"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    # user
    op.create_table(
        "user",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("username", sa.String, nullable=False),
        sa.Column("password_hash", sa.String, nullable=False),
        sa.Column("created_at", sa.Integer, nullable=False),
    )
    op.create_index("ix_user_username", "user", ["username"], unique=True)

    # session
    op.create_table(
        "session",
        sa.Column("id", sa.String, primary_key=True),
        sa.Column("user_id", sa.Integer, sa.ForeignKey("user.id", ondelete="CASCADE"), nullable=False),
        sa.Column("created_at", sa.Integer, nullable=False),
        sa.Column("expires_at", sa.Integer, nullable=False),
        sa.Column("last_seen_at", sa.Integer, nullable=False),
    )
    op.create_index("ix_session_user_id", "session", ["user_id"])

    # providerrow (per-user provider config; api_key_enc is Fernet ciphertext)
    op.create_table(
        "providerrow",
        sa.Column("id", sa.String, primary_key=True),
        sa.Column("user_id", sa.Integer, sa.ForeignKey("user.id", ondelete="CASCADE"), nullable=False),
        sa.Column("name", sa.String, nullable=False),
        sa.Column("base_url", sa.String, nullable=False),
        sa.Column("api_key_enc", sa.String, nullable=False),
        sa.Column("model", sa.String, nullable=False),
        sa.Column("vision_model", sa.String, nullable=True),
        sa.Column("is_default", sa.Boolean, nullable=False, server_default=sa.text("0")),
        sa.Column("created_at", sa.Integer, nullable=False),
        sa.UniqueConstraint("user_id", "id", name="uq_provider_user_id"),
    )
    op.create_index("ix_providerrow_user_id", "providerrow", ["user_id"])

    # conversationrow (messages as JSON — exact TS ChatMessage[] shape)
    op.create_table(
        "conversationrow",
        sa.Column("id", sa.String, primary_key=True),
        sa.Column("user_id", sa.Integer, sa.ForeignKey("user.id", ondelete="CASCADE"), nullable=False),
        sa.Column("title", sa.String, nullable=False),
        sa.Column("type", sa.String, nullable=False),
        sa.Column("paper_id", sa.String, nullable=True),
        sa.Column("provider_id", sa.String, sa.ForeignKey("providerrow.id", ondelete="SET NULL"), nullable=True),
        sa.Column("model", sa.String, nullable=True),
        sa.Column("style_preset", sa.String, nullable=True),
        sa.Column("context_capacity_override", sa.Integer, nullable=True),
        sa.Column("reserve_tokens", sa.Integer, nullable=True),
        sa.Column("last_usage", sa.JSON, nullable=True),
        sa.Column("messages", sa.JSON, nullable=False),
        sa.Column("created_at", sa.Integer, nullable=False),
        sa.Column("updated_at", sa.Integer, nullable=False),
    )
    op.create_index("ix_conv_user_updated", "conversationrow", ["user_id", "updated_at"])

    # paper (GLOBAL cache — no user_id)
    op.create_table(
        "paper",
        sa.Column("arxiv_id", sa.String, primary_key=True),
        sa.Column("title", sa.String, nullable=False),
        sa.Column("authors", sa.JSON, nullable=False),
        sa.Column("abstract", sa.String, nullable=False),
        sa.Column("pdf_url", sa.String, nullable=True),
        sa.Column("abs_url", sa.String, nullable=True),
        sa.Column("published", sa.String, nullable=True),
        sa.Column("primary_category", sa.String, nullable=True),
        sa.Column("source", sa.String, nullable=True),
        sa.Column("doi", sa.String, nullable=True),
        sa.Column("oa_pdf_url", sa.String, nullable=True),
        sa.Column("external_url", sa.String, nullable=True),
        sa.Column("full_text", sa.String, nullable=True),
        sa.Column("fetched_at", sa.Integer, nullable=False),
    )

    # annotationrow (per-user; payload packs type-specific geometry)
    op.create_table(
        "annotationrow",
        sa.Column("id", sa.String, primary_key=True),
        sa.Column("user_id", sa.Integer, sa.ForeignKey("user.id", ondelete="CASCADE"), nullable=False),
        sa.Column("arxiv_id", sa.String, nullable=False),
        sa.Column("page", sa.Integer, nullable=False),
        sa.Column("type", sa.String, nullable=False),
        sa.Column("color", sa.String, nullable=False),
        sa.Column("created_at", sa.Integer, nullable=False),
        sa.Column("payload", sa.JSON, nullable=False),
        sa.UniqueConstraint("user_id", "id", name="uq_annot_user_id"),
    )
    op.create_index("ix_annot_user_paper", "annotationrow", ["user_id", "arxiv_id"])
    op.create_index("ix_annot_user_paper_page", "annotationrow", ["user_id", "arxiv_id", "page"])

    # user_settings (one row per user; JSON columns hold the non-provider slice)
    op.create_table(
        "user_settings",
        sa.Column("user_id", sa.Integer, sa.ForeignKey("user.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("theme", sa.String, nullable=False, server_default="default"),
        sa.Column("search_sources", sa.JSON, nullable=False),
        sa.Column("zotero_config", sa.JSON, nullable=False),
        sa.Column("provider_models", sa.JSON, nullable=False),
    )

    # zoteronotesyncrow (per-user, per-paper)
    op.create_table(
        "zoteronotesyncrow",
        sa.Column("user_id", sa.Integer, sa.ForeignKey("user.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("arxiv_id", sa.String, primary_key=True),
        sa.Column("enabled", sa.Boolean, nullable=False, server_default=sa.text("1")),
        sa.Column("note_key", sa.String, nullable=True),
        sa.Column("parent_key", sa.String, nullable=True),
        sa.Column("last_synced_at", sa.Integer, nullable=True),
        sa.Column("last_error", sa.String, nullable=True),
        sa.Column("last_count", sa.Integer, nullable=False, server_default=sa.text("0")),
        sa.Column("content_sig", sa.String, nullable=True),
    )


def downgrade() -> None:
    op.drop_table("zoteronotesyncrow")
    op.drop_table("user_settings")
    op.drop_table("annotationrow")
    op.drop_table("paper")
    op.drop_table("conversationrow")
    op.drop_table("providerrow")
    op.drop_table("session")
    op.drop_table("user")
