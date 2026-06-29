"""Zotero note-sync state router — per-user, per-paper sync state.

Tracks the cached noteKey/parentKey, last sync result, and enabled flag for the
"Create Note from Annotations" Zotero flow. `syncing` is ephemeral and never
persisted (no sync is in flight across a reload).
"""
from __future__ import annotations

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from ..db import get_session
from ..deps import current_user
from ..models import User, ZoteroNoteSyncRow

router = APIRouter(prefix="/zotero-note-sync", tags=["zotero-note-sync"])


class NoteSyncOut(BaseModel):
    enabled: bool
    noteKey: str | None
    parentKey: str | None
    lastSyncedAt: int | None
    lastError: str | None
    lastCount: int
    contentSig: str | None


class NoteSyncPatch(BaseModel):
    enabled: bool | None = None
    noteKey: str | None = None
    parentKey: str | None = None
    lastSyncedAt: int | None = None
    lastError: str | None = None
    lastCount: int | None = None
    contentSig: str | None = None


def _to_out(row: ZoteroNoteSyncRow) -> NoteSyncOut:
    return NoteSyncOut(
        enabled=row.enabled, noteKey=row.note_key, parentKey=row.parent_key,
        lastSyncedAt=row.last_synced_at, lastError=row.last_error,
        lastCount=row.last_count, contentSig=row.content_sig,
    )


@router.get("", response_model=dict[str, NoteSyncOut])
async def list_note_sync(
    user: User = Depends(current_user),
    session: AsyncSession = Depends(get_session),
) -> dict[str, NoteSyncOut]:
    rows = (
        await session.exec(
            select(ZoteroNoteSyncRow).where(ZoteroNoteSyncRow.user_id == user.id)
        )
    ).all()
    return {r.arxiv_id: _to_out(r) for r in rows}


@router.put("/{arxiv_id}", response_model=NoteSyncOut)
async def put_note_sync(
    arxiv_id: str,
    body: NoteSyncPatch,
    user: User = Depends(current_user),
    session: AsyncSession = Depends(get_session),
) -> NoteSyncOut:
    row = await session.get(ZoteroNoteSyncRow, (user.id, arxiv_id))
    if row is None:
        row = ZoteroNoteSyncRow(
            user_id=user.id, arxiv_id=arxiv_id,
            enabled=body.enabled if body.enabled is not None else True,
            note_key=body.noteKey, parent_key=body.parentKey,
            last_synced_at=body.lastSyncedAt, last_error=body.lastError,
            last_count=body.lastCount or 0, content_sig=body.contentSig,
        )
        session.add(row)
    else:
        if body.enabled is not None:
            row.enabled = body.enabled
        if body.noteKey is not None:
            row.note_key = body.noteKey
        if body.parentKey is not None:
            row.parent_key = body.parentKey
        if body.lastSyncedAt is not None:
            row.last_synced_at = body.lastSyncedAt
        if body.lastError is not None:
            row.last_error = body.lastError
        if body.lastCount is not None:
            row.last_count = body.lastCount
        if body.contentSig is not None:
            row.content_sig = body.contentSig
        session.add(row)
    await session.commit()
    await session.refresh(row)
    return _to_out(row)
