"""Migration router — one-time browser → server import.

POST /api/migrate/import takes a batch payload (all IDB stores + localStorage
settings) from the browser and upserts each into the authenticated user's rows.
Idempotent: conversations/providers/annotations use the client-supplied ids
(upsert by (user_id, id)), so re-importing the same data is a no-op.

Encrypts provider api_keys + search/zotero keys on insert. Runs the legacy
draw.points→draw.strokes annotation migration once, baking it into the stored
rows so subsequent reads don't need to transform.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlmodel.ext.asyncio.session import AsyncSession

from .. import security
from ..db import get_session
from ..deps import current_user
from ..models import (
    AnnotationRow, ConversationRow, PaperRow, ProviderRow, User, UserSettings,
    ZoteroNoteSyncRow,
)
from .annotations import _anno_to_payload
from .settings import _encrypt_search_keys, _encrypt_zotero_key

router = APIRouter(prefix="/migrate", tags=["migrate"])


class MigrateConversation(BaseModel):
    id: str
    title: str
    type: str
    paper_id: str | None = None
    provider_id: str | None = None
    model: str | None = None
    style_preset: str | None = None
    context_capacity_override: int | None = None
    reserve_tokens: int | None = None
    last_usage: dict | None = None
    messages: list = []
    created_at: int
    updated_at: int


class MigratePaper(BaseModel):
    arxiv_id: str
    title: str
    authors: list = []
    abstract: str = ""
    pdf_url: str | None = None
    abs_url: str | None = None
    published: str | None = None
    primary_category: str | None = None
    source: str | None = None
    doi: str | None = None
    oa_pdf_url: str | None = None
    external_url: str | None = None
    full_text: str | None = None
    fetched_at: int = 0


class MigrateAnnotation(BaseModel):
    id: str
    arxiv_id: str
    page: int
    type: str
    color: str
    createdAt: int
    highlight: dict | None = None
    rect: dict | None = None
    draw: dict | None = None
    text: dict | None = None


class MigrateProvider(BaseModel):
    id: str
    name: str
    base_url: str
    api_key: str
    model: str
    vision_model: str | None = None
    is_default: bool = False


class MigrateSettings(BaseModel):
    providers: list[MigrateProvider] = []
    defaultProviderId: str | None = None
    theme: str | None = None
    searchSources: dict | None = None
    zotero: dict | None = None
    providerModels: dict | None = None
    aiOutputFormat: dict | None = None


class MigrateNoteSync(BaseModel):
    enabled: bool = True
    note_key: str | None = None
    parent_key: str | None = None
    last_synced_at: int | None = None
    last_error: str | None = None
    last_count: int = 0
    content_sig: str | None = None


class MigratePayload(BaseModel):
    conversations: list[MigrateConversation] = []
    papers: list[MigratePaper] = []
    annotations: list[MigrateAnnotation] = []
    settings: MigrateSettings | None = None
    zoteroNoteSync: dict[str, MigrateNoteSync] | None = None


class MigrateResult(BaseModel):
    imported: dict


def _migrate_annotation_draw(a: MigrateAnnotation) -> MigrateAnnotation:
    """Server-side mirror of frontend migrateAnnotation (draw.points→strokes)."""
    if a.type != "draw" or not a.draw:
        return a
    d = a.draw
    if isinstance(d.get("strokes"), list):
        return a
    if isinstance(d.get("points"), list):
        a.draw = {"strokes": [d["points"]], "width": d.get("width", 0.0025)}
    return a


@router.post("/import", response_model=MigrateResult)
async def import_local_data(
    body: MigratePayload,
    user: User = Depends(current_user),
    session: AsyncSession = Depends(get_session),
) -> MigrateResult:
    counts = {"conversations": 0, "papers": 0, "annotations": 0,
              "providers": 0, "settings": 0, "zoteroNoteSync": 0}

    # Providers (encrypt api_key; resolve defaultProviderId)
    default_pid = body.settings.defaultProviderId if body.settings else None
    if body.settings and body.settings.providers:
        for p in body.settings.providers:
            existing = await session.get(ProviderRow, p.id)
            is_default = (p.is_default or p.id == default_pid)
            if existing is None or existing.user_id != user.id:
                row = ProviderRow(
                    id=p.id, user_id=user.id, name=p.name, base_url=p.base_url,
                    api_key_enc=security.encrypt(p.api_key), model=p.model,
                    vision_model=p.vision_model, is_default=is_default,
                )
                session.add(row)
            else:
                existing.name = p.name
                existing.base_url = p.base_url
                existing.api_key_enc = security.encrypt(p.api_key)
                existing.model = p.model
                existing.vision_model = p.vision_model
                existing.is_default = is_default
                session.add(existing)
            counts["providers"] += 1

    # Conversations (upsert by id; messages verbatim)
    for c in body.conversations:
        existing = await session.get(ConversationRow, c.id)
        if existing is None or existing.user_id != user.id:
            row = ConversationRow(
                id=c.id, user_id=user.id, title=c.title, type=c.type,
                paper_id=c.paper_id, provider_id=c.provider_id, model=c.model,
                style_preset=c.style_preset,
                context_capacity_override=c.context_capacity_override,
                reserve_tokens=c.reserve_tokens, last_usage=c.last_usage,
                messages=c.messages, created_at=c.created_at, updated_at=c.updated_at,
            )
            session.add(row)
        else:
            existing.title = c.title
            existing.type = c.type
            existing.paper_id = c.paper_id
            existing.provider_id = c.provider_id
            existing.model = c.model
            existing.style_preset = c.style_preset
            existing.context_capacity_override = c.context_capacity_override
            existing.reserve_tokens = c.reserve_tokens
            existing.last_usage = c.last_usage
            existing.messages = c.messages
            existing.created_at = c.created_at
            existing.updated_at = c.updated_at
            session.add(existing)
        counts["conversations"] += 1

    # Papers (global upsert; don't clobber full_text with None)
    for p in body.papers:
        existing = await session.get(PaperRow, p.arxiv_id)
        if existing is None:
            row = PaperRow(
                arxiv_id=p.arxiv_id, title=p.title, authors=p.authors,
                abstract=p.abstract, pdf_url=p.pdf_url, abs_url=p.abs_url,
                published=p.published, primary_category=p.primary_category,
                source=p.source, doi=p.doi, oa_pdf_url=p.oa_pdf_url,
                external_url=p.external_url, full_text=p.full_text, fetched_at=p.fetched_at,
            )
            session.add(row)
        else:
            existing.title = p.title
            existing.authors = p.authors
            existing.abstract = p.abstract
            existing.pdf_url = p.pdf_url
            existing.abs_url = p.abs_url
            existing.published = p.published
            existing.primary_category = p.primary_category
            existing.source = p.source
            existing.doi = p.doi
            existing.oa_pdf_url = p.oa_pdf_url
            existing.external_url = p.external_url
            if p.full_text is not None:
                existing.full_text = p.full_text
            existing.fetched_at = p.fetched_at
            session.add(existing)
        counts["papers"] += 1

    # Annotations (run draw migration once; pack payload)
    for a in body.annotations:
        a = _migrate_annotation_draw(a)
        existing = await session.get(AnnotationRow, a.id)
        payload = _anno_to_payload(a)  # packs highlight/rect/draw/text
        if existing is None or existing.user_id != user.id:
            row = AnnotationRow(
                id=a.id, user_id=user.id, arxiv_id=a.arxiv_id, page=a.page,
                type=a.type, color=a.color, created_at=a.createdAt, payload=payload,
            )
            session.add(row)
        else:
            existing.arxiv_id = a.arxiv_id
            existing.page = a.page
            existing.type = a.type
            existing.color = a.color
            existing.created_at = a.createdAt
            existing.payload = payload
            session.add(existing)
        counts["annotations"] += 1

    # Settings (non-provider slice; encrypt keys)
    if body.settings and (body.settings.theme or body.settings.searchSources
                          or body.settings.zotero or body.settings.providerModels
                          or body.settings.aiOutputFormat):
        from sqlmodel import select
        row = (await session.exec(
            select(UserSettings).where(UserSettings.user_id == user.id)
        )).first()
        if row is None:
            row = UserSettings(user_id=user.id)
            session.add(row)
        if body.settings.theme is not None:
            row.theme = body.settings.theme
        if body.settings.searchSources is not None:
            row.search_sources = _encrypt_search_keys(body.settings.searchSources)
        if body.settings.zotero is not None:
            row.zotero_config = _encrypt_zotero_key(body.settings.zotero)
        if body.settings.providerModels is not None:
            row.provider_models = body.settings.providerModels
        if body.settings.aiOutputFormat is not None:
            row.ai_output_format = body.settings.aiOutputFormat
        counts["settings"] += 1

    # Zotero note-sync map (per paper)
    if body.zoteroNoteSync:
        for arxiv_id, ns in body.zoteroNoteSync.items():
            row = await session.get(ZoteroNoteSyncRow, (user.id, arxiv_id))
            if row is None:
                row = ZoteroNoteSyncRow(
                    user_id=user.id, arxiv_id=arxiv_id, enabled=ns.enabled,
                    note_key=ns.note_key, parent_key=ns.parent_key,
                    last_synced_at=ns.last_synced_at, last_error=ns.last_error,
                    last_count=ns.last_count, content_sig=ns.content_sig,
                )
                session.add(row)
            else:
                row.enabled = ns.enabled
                row.note_key = ns.note_key
                row.parent_key = ns.parent_key
                row.last_synced_at = ns.last_synced_at
                row.last_error = ns.last_error
                row.last_count = ns.last_count
                row.content_sig = ns.content_sig
            counts["zoteroNoteSync"] += 1

    await session.commit()
    return MigrateResult(imported=counts)
