"""SQLModel table definitions — server-side persistence for Little Alphaxiv.

Eight tables. Per-user scope is enforced in the routers (every query filters by
user.id); the schema makes the relationships explicit via foreign keys.

Design notes (see plan §6):
  * Conversation.messages is a JSON column, not a normalized messages table —
    conversations are always read/written whole (store calls saveConversation
    with the full message array on every mutation), there's no per-message
    query, and the embedded TS shape includes base64 attachments / tool_calls /
    ui metadata that we want to preserve verbatim.
  * papers is GLOBAL (not per-user): same arxiv_id → same content; full_text is
    tens-of-KB-to-MB and deduplicating it across users matters. Consistent with
    the already-global PDF disk cache (routers/pdf.py).
  * providers.api_key_enc holds Fernet ciphertext — never plaintext.
  * The deprecated Conversation.context_window field is intentionally absent
    from the server schema (dormant in the frontend; ignored on import).
"""
from __future__ import annotations

import time

from sqlalchemy import Column, Index, JSON, UniqueConstraint
from sqlmodel import Field, SQLModel


def _now() -> int:
    """Epoch seconds. (time.time is fine here — only called at row-write time.)"""
    return int(time.time())


# ---------------------------------------------------------------------------
# Auth
# ---------------------------------------------------------------------------


class User(SQLModel, table=True):
    id: int | None = Field(default=None, primary_key=True)
    # username stored lowercased+trimmed on insert; unique index for fast lookup
    username: str = Field(unique=True, index=True)
    password_hash: str  # bcrypt
    # Email for password recovery. Nullable so pre-migration accounts survive;
    # unique so email→account is unambiguous (SQLite allows multiple NULLs).
    email: str | None = Field(default=None, unique=True, index=True)
    created_at: int = Field(default_factory=_now)


class Session(SQLModel, table=True):
    # id is the 32-byte url-safe token (sessions table PK); the cookie value is
    # an itsdangerous-signed {sid, exp}, NOT this raw id.
    id: str = Field(primary_key=True)
    user_id: int = Field(foreign_key="user.id", ondelete="CASCADE", index=True)
    created_at: int = Field(default_factory=_now)
    expires_at: int
    last_seen_at: int = Field(default_factory=_now)


# ---------------------------------------------------------------------------
# Per-user provider config (LLM gateway creds)
# ---------------------------------------------------------------------------


class ProviderRow(SQLModel, table=True):
    """A user's OpenAI-compatible provider. api_key_enc is Fernet ciphertext."""
    id: str = Field(primary_key=True)  # the frontend-generated uid
    user_id: int = Field(foreign_key="user.id", ondelete="CASCADE", index=True)
    name: str
    base_url: str
    api_key_enc: str  # Fernet ciphertext — never plaintext
    model: str
    vision_model: str | None = None
    is_default: bool = False
    created_at: int = Field(default_factory=_now)

    __table_args__ = (UniqueConstraint("user_id", "id", name="uq_provider_user_id"),)


# ---------------------------------------------------------------------------
# Per-user conversations (messages as JSON)
# ---------------------------------------------------------------------------


class ConversationRow(SQLModel, table=True):
    id: str = Field(primary_key=True)  # the frontend-generated uid
    user_id: int = Field(foreign_key="user.id", ondelete="CASCADE", index=True)
    title: str
    type: str  # "general" | "paper"
    paper_id: str | None = None
    # ON DELETE SET NULL: deleting a provider leaves conversations alive but
    # unbound; the frontend already tolerates a dangling provider_id.
    provider_id: str | None = Field(
        default=None, foreign_key="providerrow.id", ondelete="SET NULL"
    )
    model: str | None = None
    style_preset: str | None = None
    context_capacity_override: int | None = None
    reserve_tokens: int | None = None
    last_usage: dict | None = Field(default=None, sa_column=Column(JSON))
    messages: list = Field(sa_column=Column(JSON))  # ChatMessage[] — exact TS shape
    created_at: int
    updated_at: int

    __table_args__ = (Index("ix_conv_user_updated", "user_id", "updated_at"),)


# ---------------------------------------------------------------------------
# Global paper cache (metadata + extracted full_text)
# ---------------------------------------------------------------------------


class PaperRow(SQLModel, table=True):
    """Global cache keyed by arxiv_id. full_text is deduplicated across users."""
    __tablename__ = "paper"
    arxiv_id: str = Field(primary_key=True)
    title: str
    authors: list = Field(sa_column=Column(JSON))  # string[]
    abstract: str
    pdf_url: str | None = None
    abs_url: str | None = None
    published: str | None = None
    primary_category: str | None = None
    source: str | None = None  # "arxiv" | "openalex" | "s2" | "upload" | "zotero"
    doi: str | None = None
    oa_pdf_url: str | None = None
    external_url: str | None = None
    full_text: str | None = None  # extracted, tens of KB to low MB
    fetched_at: int


# ---------------------------------------------------------------------------
# Per-user uploaded papers (private PDF bytes + extracted full_text)
# ---------------------------------------------------------------------------


class UserPaperUpload(SQLModel, table=True):
    """A user-private uploaded / Zotero-imported PDF.

    The PDF bytes + extracted ``full_text`` live HERE, never on the global
    PaperRow — for an uploaded paywalled paper the extracted text IS the
    paywalled content, so it must stay user-private. Shareable metadata
    (title/authors/abstract) is shared via the global ``PaperRow`` pointed to
    by ``paper_id``. Deduplicated per-user by ``content_hash`` so re-uploading
    the same bytes returns the existing row instead of re-storing.
    """
    __tablename__ = "user_paper_upload"
    id: int | None = Field(default=None, primary_key=True)
    user_id: int = Field(foreign_key="user.id", ondelete="CASCADE", index=True)
    paper_id: str = Field(foreign_key="paper.arxiv_id", ondelete="CASCADE", index=True)
    source: str  # "upload" | "zotero"
    content_hash: str  # sha256 of PDF bytes, hex
    stored_path: str  # relative path under the uploads dir: "<user_id>/<hash>.pdf"
    zotero_item_key: str | None = None
    zotero_attachment_key: str | None = None
    full_text: str | None = None  # extracted text (private); NULL until extracted
    byte_size: int
    uploaded_at: int = Field(default_factory=_now)

    __table_args__ = (
        UniqueConstraint("user_id", "content_hash", name="uq_user_upload_hash"),
    )


# ---------------------------------------------------------------------------
# Per-user annotations (page-normalized highlight/rect/draw/text geometry)
# ---------------------------------------------------------------------------


class AnnotationRow(SQLModel, table=True):
    id: str = Field(primary_key=True)
    user_id: int = Field(foreign_key="user.id", ondelete="CASCADE")
    arxiv_id: str
    page: int  # 1-based
    type: str  # highlight | rect | draw | text
    color: str  # hex
    created_at: int
    # payload packs the type-specific geometry: {highlight? rect? draw? text?}
    # The API layer re-flattens this to the TS Annotation shape on read and
    # re-packs on write.
    payload: dict = Field(sa_column=Column(JSON))

    __table_args__ = (
        UniqueConstraint("user_id", "id", name="uq_annot_user_id"),
        Index("ix_annot_user_paper", "user_id", "arxiv_id"),
        Index("ix_annot_user_paper_page", "user_id", "arxiv_id", "page"),
    )


# ---------------------------------------------------------------------------
# Per-user settings (non-provider slice)
# ---------------------------------------------------------------------------


class UserSettings(SQLModel, table=True):
    """One row per user. JSON columns hold the non-provider settings slice.

    search_sources.openalex.apiKey, search_sources.semanticScholar.apiKey, and
    zotero_config.apiKey are Fernet-encrypted inside their JSON objects (the
    settings router encrypts/decrypts at those specific paths). provider_models
    is a non-sensitive cached /v1/models list — plaintext.
    """
    __tablename__ = "user_settings"
    user_id: int = Field(foreign_key="user.id", ondelete="CASCADE", primary_key=True)
    theme: str = "default"
    search_sources: dict = Field(default_factory=dict, sa_column=Column(JSON))
    zotero_config: dict = Field(default_factory=dict, sa_column=Column(JSON))
    provider_models: dict = Field(default_factory=dict, sa_column=Column(JSON))
    ai_output_format: dict = Field(default_factory=dict, sa_column=Column(JSON))


# ---------------------------------------------------------------------------
# Per-user Zotero note-sync state (per paper)
# ---------------------------------------------------------------------------


class ZoteroNoteSyncRow(SQLModel, table=True):
    user_id: int = Field(foreign_key="user.id", ondelete="CASCADE", primary_key=True)
    arxiv_id: str = Field(primary_key=True)
    enabled: bool = True
    note_key: str | None = None
    parent_key: str | None = None
    last_synced_at: int | None = None
    last_error: str | None = None
    last_count: int = 0
    content_sig: str | None = None


# ---------------------------------------------------------------------------
# Password reset tokens (hashed, single-use, TTL-bounded)
# ---------------------------------------------------------------------------


class PasswordResetRow(SQLModel, table=True):
    """A single-use password-reset token. Only sha256(token) is stored — the
    plaintext token exists only in the reset link sent to the user. A new
    request supersedes the user's prior unused tokens (marked used_at)."""
    __tablename__ = "password_reset"
    id: int | None = Field(default=None, primary_key=True)
    user_id: int = Field(foreign_key="user.id", ondelete="CASCADE", index=True)
    token_hash: str = Field(unique=True, index=True)  # sha256(token).hexdigest()
    expires_at: int  # epoch seconds
    used_at: int | None = None  # set when consumed → single-use
    created_at: int = Field(default_factory=_now)
