"""Annotations router — per-user PDF annotations (highlight/rect/draw/text).

The TS Annotation shape (frontend/src/types.ts:190-201) has top-level optional
fields highlight/rect/draw/text. The server packs those into a single payload
JSON column to keep the row shape stable; the API layer re-flattens to the TS
shape on read and re-packs on write. migrateAnnotation (the legacy
draw.points→draw.strokes conversion) stays client-side on read.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from ..db import get_session
from ..deps import current_user
from ..models import AnnotationRow, User

router = APIRouter(prefix="/annotations", tags=["annotations"])

# The type-specific optional fields on the TS Annotation shape.
_PAYLOAD_KEYS = ("highlight", "rect", "draw", "text")


class Annotation(BaseModel):
    """Mirrors frontend/src/types.ts Annotation (page-normalized geometry)."""
    id: str
    arxiv_id: str
    page: int  # 1-based
    type: str  # highlight | rect | draw | text
    color: str  # hex
    createdAt: int
    highlight: dict | None = None
    rect: dict | None = None
    draw: dict | None = None
    text: dict | None = None


def _row_to_anno(row: AnnotationRow) -> Annotation:
    payload = row.payload or {}
    return Annotation(
        id=row.id, arxiv_id=row.arxiv_id, page=row.page, type=row.type,
        color=row.color, createdAt=row.created_at,
        highlight=payload.get("highlight"),
        rect=payload.get("rect"),
        draw=payload.get("draw"),
        text=payload.get("text"),
    )


def _anno_to_payload(a: Annotation) -> dict:
    return {k: getattr(a, k) for k in _PAYLOAD_KEYS if getattr(a, k) is not None}


@router.get("", response_model=list[Annotation])
async def list_annotations(
    arxiv_id: str,
    user: User = Depends(current_user),
    session: AsyncSession = Depends(get_session),
) -> list[Annotation]:
    rows = (
        await session.exec(
            select(AnnotationRow).where(
                AnnotationRow.user_id == user.id,
                AnnotationRow.arxiv_id == arxiv_id,
            )
        )
    ).all()
    return [_row_to_anno(r) for r in rows]


@router.put("/{anno_id}", response_model=Annotation)
async def put_annotation(
    anno_id: str,
    body: Annotation,
    user: User = Depends(current_user),
    session: AsyncSession = Depends(get_session),
) -> Annotation:
    if body.id != anno_id:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "id mismatch")
    row = await session.get(AnnotationRow, anno_id)
    if row is None:
        row = AnnotationRow(
            id=anno_id, user_id=user.id, arxiv_id=body.arxiv_id, page=body.page,
            type=body.type, color=body.color, created_at=body.createdAt,
            payload=_anno_to_payload(body),
        )
        session.add(row)
    else:
        if row.user_id != user.id:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "annotation not found")
        row.arxiv_id = body.arxiv_id
        row.page = body.page
        row.type = body.type
        row.color = body.color
        row.created_at = body.createdAt
        row.payload = _anno_to_payload(body)
        session.add(row)
    await session.commit()
    await session.refresh(row)
    return _row_to_anno(row)


@router.delete("/{anno_id}")
async def delete_annotation(
    anno_id: str,
    user: User = Depends(current_user),
    session: AsyncSession = Depends(get_session),
) -> dict:
    row = await session.get(AnnotationRow, anno_id)
    if row is not None and row.user_id == user.id:
        await session.delete(row)
        await session.commit()
    return {"ok": True}


@router.delete("")
async def clear_annotations(
    arxiv_id: str,
    user: User = Depends(current_user),
    session: AsyncSession = Depends(get_session),
) -> dict:
    rows = (
        await session.exec(
            select(AnnotationRow).where(
                AnnotationRow.user_id == user.id,
                AnnotationRow.arxiv_id == arxiv_id,
            )
        )
    ).all()
    for r in rows:
        await session.delete(r)
    if rows:
        await session.commit()
    return {"ok": True, "cleared": len(rows)}
