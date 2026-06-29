"""Conversations router — per-user chat history (messages as JSON).

The PUT is the single write path (the frontend's persist() calls it on every
conversation mutation). GET list omits messages (too heavy for the sidebar);
the client fetches the full conversation on open. Upserts by (user_id, id) so
the frontend-generated uid is the stable identity.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from ..db import get_session
from ..deps import current_user
from ..models import ConversationRow, User

router = APIRouter(prefix="/conversations", tags=["conversations"])


class ConversationSummary(BaseModel):
    """Sidebar row — messages omitted."""
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
    created_at: int
    updated_at: int


class ConversationFull(ConversationSummary):
    messages: list


@router.get("", response_model=list[ConversationSummary])
async def list_conversations(
    user: User = Depends(current_user),
    session: AsyncSession = Depends(get_session),
) -> list[ConversationSummary]:
    rows = (
        await session.exec(
            select(ConversationRow)
            .where(ConversationRow.user_id == user.id)
            .order_by(ConversationRow.updated_at.desc())
        )
    ).all()
    return [
        ConversationSummary(
            id=r.id, title=r.title, type=r.type, paper_id=r.paper_id,
            provider_id=r.provider_id, model=r.model, style_preset=r.style_preset,
            context_capacity_override=r.context_capacity_override,
            reserve_tokens=r.reserve_tokens, last_usage=r.last_usage,
            created_at=r.created_at, updated_at=r.updated_at,
        )
        for r in rows
    ]


@router.get("/{conv_id}", response_model=ConversationFull)
async def get_conversation(
    conv_id: str,
    user: User = Depends(current_user),
    session: AsyncSession = Depends(get_session),
) -> ConversationFull:
    row = await session.get(ConversationRow, conv_id)
    if row is None or row.user_id != user.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "conversation not found")
    return ConversationFull(
        id=row.id, title=row.title, type=row.type, paper_id=row.paper_id,
        provider_id=row.provider_id, model=row.model, style_preset=row.style_preset,
        context_capacity_override=row.context_capacity_override,
        reserve_tokens=row.reserve_tokens, last_usage=row.last_usage,
        created_at=row.created_at, updated_at=row.updated_at, messages=row.messages or [],
    )


@router.put("/{conv_id}", response_model=ConversationFull)
async def put_conversation(
    conv_id: str,
    body: ConversationFull,
    user: User = Depends(current_user),
    session: AsyncSession = Depends(get_session),
) -> ConversationFull:
    if body.id != conv_id:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "id mismatch")
    row = await session.get(ConversationRow, conv_id)
    if row is None:
        row = ConversationRow(
            id=conv_id, user_id=user.id, title=body.title, type=body.type,
            paper_id=body.paper_id, provider_id=body.provider_id, model=body.model,
            style_preset=body.style_preset,
            context_capacity_override=body.context_capacity_override,
            reserve_tokens=body.reserve_tokens, last_usage=body.last_usage,
            messages=body.messages, created_at=body.created_at, updated_at=body.updated_at,
        )
        session.add(row)
    else:
        if row.user_id != user.id:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "conversation not found")
        row.title = body.title
        row.type = body.type
        row.paper_id = body.paper_id
        row.provider_id = body.provider_id
        row.model = body.model
        row.style_preset = body.style_preset
        row.context_capacity_override = body.context_capacity_override
        row.reserve_tokens = body.reserve_tokens
        row.last_usage = body.last_usage
        row.messages = body.messages
        row.created_at = body.created_at
        row.updated_at = body.updated_at
        session.add(row)
    await session.commit()
    await session.refresh(row)
    return ConversationFull(
        id=row.id, title=row.title, type=row.type, paper_id=row.paper_id,
        provider_id=row.provider_id, model=row.model, style_preset=row.style_preset,
        context_capacity_override=row.context_capacity_override,
        reserve_tokens=row.reserve_tokens, last_usage=row.last_usage,
        created_at=row.created_at, updated_at=row.updated_at, messages=row.messages or [],
    )


@router.delete("/{conv_id}")
async def delete_conversation(
    conv_id: str,
    user: User = Depends(current_user),
    session: AsyncSession = Depends(get_session),
) -> dict:
    row = await session.get(ConversationRow, conv_id)
    if row is not None and row.user_id == user.id:
        await session.delete(row)
        await session.commit()
    return {"ok": True}
