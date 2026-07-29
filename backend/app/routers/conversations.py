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
    history_id: str | None = None
    parent_id: str | None = None
    branch_from_message_index: int | None = None
    branch_excerpt: str | None = None
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


_LINEAGE_FIELDS = (
    "history_id",
    "parent_id",
    "branch_from_message_index",
    "branch_excerpt",
)


def _summary(row: ConversationRow) -> ConversationSummary:
    return ConversationSummary(
        id=row.id, title=row.title, type=row.type,
        history_id=row.history_id or row.id, parent_id=row.parent_id,
        branch_from_message_index=row.branch_from_message_index,
        branch_excerpt=row.branch_excerpt, paper_id=row.paper_id,
        provider_id=row.provider_id, model=row.model, style_preset=row.style_preset,
        context_capacity_override=row.context_capacity_override,
        reserve_tokens=row.reserve_tokens, last_usage=row.last_usage,
        created_at=row.created_at, updated_at=row.updated_at,
    )


def _full(row: ConversationRow) -> ConversationFull:
    return ConversationFull(**_summary(row).model_dump(), messages=row.messages or [])


def _body_lineage(body: ConversationFull, row: ConversationRow | None = None) -> tuple:
    """Honor omitted lineage fields from pre-feature clients on updates."""
    fields_set = body.model_fields_set
    return tuple(
        getattr(body, field)
        if row is None or field in fields_set
        else getattr(row, field)
        for field in _LINEAGE_FIELDS
    )


def _normalized_excerpt(value: str | None) -> str | None:
    if value is None:
        return None
    normalized = " ".join(value.split()).strip()
    if not normalized:
        return None
    return normalized[:1999] + "…" if len(normalized) > 2000 else normalized


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
    return [_summary(row) for row in rows]


@router.get("/{conv_id}", response_model=ConversationFull)
async def get_conversation(
    conv_id: str,
    user: User = Depends(current_user),
    session: AsyncSession = Depends(get_session),
) -> ConversationFull:
    row = await session.get(ConversationRow, conv_id)
    if row is None or row.user_id != user.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "conversation not found")
    return _full(row)


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
    history_id, parent_id, branch_index, branch_excerpt = _body_lineage(body, row)
    branch_excerpt = _normalized_excerpt(branch_excerpt)
    if row is None:
        if parent_id is None:
            if history_id not in (None, conv_id):
                raise HTTPException(status.HTTP_400_BAD_REQUEST, "root history_id must equal id")
            history_id = conv_id
            branch_index = None
            branch_excerpt = None
        else:
            parent = await session.get(ConversationRow, parent_id)
            if parent is None or parent.user_id != user.id:
                raise HTTPException(status.HTTP_404_NOT_FOUND, "parent conversation not found")
            if parent.type != "paper" or not parent.paper_id:
                raise HTTPException(
                    status.HTTP_400_BAD_REQUEST,
                    "conversation branches are only supported for paper conversations",
                )
            expected_history_id = parent.history_id or parent.id
            if history_id != expected_history_id:
                raise HTTPException(status.HTTP_400_BAD_REQUEST, "branch history_id mismatch")
            if body.type != parent.type or body.paper_id != parent.paper_id:
                raise HTTPException(status.HTTP_400_BAD_REQUEST, "branch type or paper mismatch")
            if (
                branch_index is None
                or branch_index < 0
                or branch_index >= len(parent.messages or [])
                or (parent.messages[branch_index] or {}).get("role") != "assistant"
            ):
                raise HTTPException(
                    status.HTTP_400_BAD_REQUEST,
                    "branch locator must point to an assistant message",
                )
            expected_prefix = (parent.messages or [])[: branch_index + 1]
            if body.messages[: branch_index + 1] != expected_prefix or len(body.messages) < len(expected_prefix):
                raise HTTPException(status.HTTP_400_BAD_REQUEST, "branch message prefix mismatch")
            if not branch_excerpt:
                raise HTTPException(status.HTTP_400_BAD_REQUEST, "branch excerpt is required")
        row = ConversationRow(
            id=conv_id, user_id=user.id, title=body.title, type=body.type,
            history_id=history_id, parent_id=parent_id,
            branch_from_message_index=branch_index, branch_excerpt=branch_excerpt,
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
        if (
            history_id,
            parent_id,
            branch_index,
            branch_excerpt,
        ) != (
            row.history_id or row.id,
            row.parent_id,
            row.branch_from_message_index,
            row.branch_excerpt,
        ):
            raise HTTPException(status.HTTP_409_CONFLICT, "conversation lineage is immutable")
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
    return _full(row)


@router.delete("/{conv_id}")
async def delete_conversation(
    conv_id: str,
    user: User = Depends(current_user),
    session: AsyncSession = Depends(get_session),
) -> dict:
    row = await session.get(ConversationRow, conv_id)
    if row is None or row.user_id != user.id:
        return {"ok": True, "deleted_ids": []}

    rows = (
        await session.exec(select(ConversationRow).where(ConversationRow.user_id == user.id))
    ).all()
    children: dict[str, list[str]] = {}
    by_id = {candidate.id: candidate for candidate in rows}
    for candidate in rows:
        if candidate.parent_id:
            children.setdefault(candidate.parent_id, []).append(candidate.id)
    deleted_ids: list[str] = []
    queue = [conv_id]
    seen: set[str] = set()
    while queue:
        candidate_id = queue.pop(0)
        if candidate_id in seen:
            continue
        seen.add(candidate_id)
        deleted_ids.append(candidate_id)
        queue.extend(children.get(candidate_id, []))
    # Delete descendants before ancestors, ready for a future self-FK without
    # changing this endpoint's behavior.
    for candidate_id in reversed(deleted_ids):
        candidate = by_id.get(candidate_id)
        if candidate is not None:
            await session.delete(candidate)
    await session.commit()
    return {"ok": True, "deleted_ids": deleted_ids}
