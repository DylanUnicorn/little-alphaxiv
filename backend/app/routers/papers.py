"""Papers router — GLOBAL paper cache (metadata + extracted full_text).

No user_id: same arxiv_id → same content for everyone; full_text is tens-of-KB
to low MB and deduplicating it across users matters. Consistent with the
already-global PDF disk cache (routers/pdf.py). PUT is a global upsert.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlmodel.ext.asyncio.session import AsyncSession

from ..db import get_session
from ..deps import current_user
from ..models import PaperRow, User

router = APIRouter(prefix="/papers", tags=["papers"])


class Paper(BaseModel):
    arxiv_id: str
    title: str
    authors: list
    abstract: str
    pdf_url: str | None = None
    abs_url: str | None = None
    published: str | None = None
    primary_category: str | None = None
    source: str | None = None
    doi: str | None = None
    oa_pdf_url: str | None = None
    external_url: str | None = None


class StoredPaper(Paper):
    full_text: str | None = None
    fetched_at: int


@router.get("/{arxiv_id}", response_model=StoredPaper)
async def get_paper(
    arxiv_id: str,
    user: User = Depends(current_user),
    session: AsyncSession = Depends(get_session),
) -> StoredPaper:
    row = await session.get(PaperRow, arxiv_id)
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "paper not cached")
    return StoredPaper(
        arxiv_id=row.arxiv_id, title=row.title, authors=row.authors or [],
        abstract=row.abstract, pdf_url=row.pdf_url, abs_url=row.abs_url,
        published=row.published, primary_category=row.primary_category,
        source=row.source, doi=row.doi, oa_pdf_url=row.oa_pdf_url,
        external_url=row.external_url, full_text=row.full_text, fetched_at=row.fetched_at,
    )


@router.put("/{arxiv_id}", response_model=StoredPaper)
async def put_paper(
    arxiv_id: str,
    body: StoredPaper,
    user: User = Depends(current_user),
    session: AsyncSession = Depends(get_session),
) -> StoredPaper:
    if body.arxiv_id != arxiv_id:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "id mismatch")
    row = await session.get(PaperRow, arxiv_id)
    if row is None:
        row = PaperRow(
            arxiv_id=body.arxiv_id, title=body.title, authors=body.authors,
            abstract=body.abstract, pdf_url=body.pdf_url, abs_url=body.abs_url,
            published=body.published, primary_category=body.primary_category,
            source=body.source, doi=body.doi, oa_pdf_url=body.oa_pdf_url,
            external_url=body.external_url, full_text=body.full_text,
            fetched_at=body.fetched_at,
        )
        session.add(row)
    else:
        row.title = body.title
        row.authors = body.authors
        row.abstract = body.abstract
        row.pdf_url = body.pdf_url
        row.abs_url = body.abs_url
        row.published = body.published
        row.primary_category = body.primary_category
        row.source = body.source
        row.doi = body.doi
        row.oa_pdf_url = body.oa_pdf_url
        row.external_url = body.external_url
        # Don't clobber full_text with None on a metadata-only update.
        if body.full_text is not None:
            row.full_text = body.full_text
        row.fetched_at = body.fetched_at
        session.add(row)
    await session.commit()
    await session.refresh(row)
    return StoredPaper(
        arxiv_id=row.arxiv_id, title=row.title, authors=row.authors or [],
        abstract=row.abstract, pdf_url=row.pdf_url, abs_url=row.abs_url,
        published=row.published, primary_category=row.primary_category,
        source=row.source, doi=row.doi, oa_pdf_url=row.oa_pdf_url,
        external_url=row.external_url, full_text=row.full_text, fetched_at=row.fetched_at,
    )
