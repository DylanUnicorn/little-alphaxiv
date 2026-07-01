"""User-private PDF upload + serve router.

Some PDFs are paywalled or off-arXiv, so the arXiv search/proxy can't reach
them. This router lets a user upload such a PDF (or import one from their
Zotero library — see routers/zotero.py) and serve it back to pdf.js in the
PaperView, on top of the existing global paper cache.

Bytes + extracted full_text are USER-PRIVATE (stored in user_paper_upload +
under <pdf_cache>/uploads/<user_id>/). Shareable metadata lives on the global
paper row pointed to by paper_id. The serve endpoint is auth-gated and returns
404 for non-owners — the same response as "not found", so an id can't be
probed for cross-user enumeration.
"""
from __future__ import annotations

import hashlib
import json
import time

from fastapi import (
    APIRouter,
    Depends,
    File,
    Form,
    Header,
    HTTPException,
    UploadFile,
    status,
)
from pydantic import BaseModel
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from .. import paths
from ..db import get_session
from ..deps import current_user
from ..models import PaperRow, User, UserPaperUpload
from .pdf import serve_pdf_bytes
from .zotero import (
    download_attachment_bytes,
    get_zotero_item,
    list_pdf_attachments,
    load_zotero_creds,
)

router = APIRouter(prefix="/paper-upload", tags=["paper-upload"])

# 50 MiB — same order as the OA open-proxy cap (pdf.py::_OA_PDF_MAX_BYTES).
_MAX_UPLOAD_BYTES = 50 * 1024 * 1024


class UploadResult(BaseModel):
    paper_id: str
    title: str
    authors: list
    abstract: str
    doi: str | None = None
    source: str
    external_url: str | None = None
    full_text: str | None = None  # always None here — private; client reads via /papers
    fetched_at: int
    is_new: bool  # False when a per-user hash dedup hit returned the existing row


def _to_result(row: PaperRow, is_new: bool) -> UploadResult:
    return UploadResult(
        paper_id=row.arxiv_id,
        title=row.title,
        authors=row.authors or [],
        abstract=row.abstract,
        doi=row.doi,
        source=row.source or "upload",
        external_url=row.external_url,
        full_text=None,
        fetched_at=row.fetched_at,
        is_new=is_new,
    )


@router.post("", response_model=UploadResult)
async def upload_paper(
    file: UploadFile = File(...),
    title: str | None = Form(default=None),
    authors_json: str | None = Form(default=None),
    abstract: str | None = Form(default=None),
    doi: str | None = Form(default=None),
    user: User = Depends(current_user),
    session: AsyncSession = Depends(get_session),
) -> UploadResult:
    data = await file.read()
    if not data:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "empty file")
    if len(data) > _MAX_UPLOAD_BYTES:
        raise HTTPException(
            status.HTTP_413_CONTENT_TOO_LARGE,
            f"file too large: {len(data)} bytes (limit {_MAX_UPLOAD_BYTES})",
        )
    content_hash = hashlib.sha256(data).hexdigest()

    # Per-user dedup by content hash → return the existing row, no re-store.
    existing = (
        await session.exec(
            select(UserPaperUpload).where(
                UserPaperUpload.user_id == user.id,
                UserPaperUpload.content_hash == content_hash,
            )
        )
    ).first()
    if existing is not None:
        prow = await session.get(PaperRow, existing.paper_id)
        if prow is not None:
            return _to_result(prow, is_new=False)
        # Orphaned upload row (paper deleted) — fall through to recreate.

    # Parse optional metadata fields.
    authors: list[str] = []
    if authors_json:
        try:
            parsed = json.loads(authors_json)
            if isinstance(parsed, list):
                authors = [str(a) for a in parsed]
        except json.JSONDecodeError:
            pass
    norm_doi = doi.strip().lower() if doi else None
    paper_id = f"doi:{norm_doi}" if norm_doi else f"sha256:{content_hash[:16]}"

    # Persist bytes to the per-user upload dir.
    upath = paths.uploads_dir() / str(user.id)
    upath.mkdir(parents=True, exist_ok=True)
    stored = upath / f"{content_hash}.pdf"
    if not stored.exists():
        stored.write_bytes(data)

    # Upsert the global metadata row (full_text stays NULL for uploads).
    now = int(time.time())
    prow = await session.get(PaperRow, paper_id)
    if prow is None:
        prow = PaperRow(
            arxiv_id=paper_id,
            title=title or "Untitled upload",
            authors=authors,
            abstract=abstract or "",
            source="upload",
            doi=norm_doi,
            full_text=None,
            fetched_at=now,
        )
        session.add(prow)
    else:
        # Enrich metadata when the caller supplied richer values.
        if title:
            prow.title = title
        if authors:
            prow.authors = authors
        if abstract:
            prow.abstract = abstract
        if norm_doi:
            prow.doi = norm_doi
        prow.source = prow.source or "upload"
        prow.fetched_at = now
        session.add(prow)

    uprow = UserPaperUpload(
        user_id=user.id,
        paper_id=paper_id,
        source="upload",
        content_hash=content_hash,
        stored_path=f"{user.id}/{content_hash}.pdf",
        byte_size=len(data),
    )
    session.add(uprow)
    await session.commit()
    await session.refresh(prow)
    return _to_result(prow, is_new=True)


@router.get("/{paper_id:path}")
async def serve_uploaded_paper(
    paper_id: str,
    range_header: str | None = Header(default=None, alias="Range"),
    user: User = Depends(current_user),
    session: AsyncSession = Depends(get_session),
):
    row = (
        await session.exec(
            select(UserPaperUpload).where(
                UserPaperUpload.user_id == user.id,
                UserPaperUpload.paper_id == paper_id,
            )
        )
    ).first()
    if row is None:
        # Same 404 for "not found" and "not yours" — no cross-user enumeration.
        raise HTTPException(status.HTTP_404_NOT_FOUND, "paper not found")
    path = paths.uploads_dir() / row.stored_path
    if not path.exists():
        raise HTTPException(status.HTTP_404_NOT_FOUND, "file not found")
    return serve_pdf_bytes(path.read_bytes(), range_header)


class ImportFromZoteroReq(BaseModel):
    item_key: str
    attachment_key: str | None = None  # if absent, pick the largest PDF attachment


@router.post("/import-from-zotero", response_model=UploadResult)
async def import_from_zotero(
    req: ImportFromZoteroReq,
    user: User = Depends(current_user),
    session: AsyncSession = Depends(get_session),
) -> UploadResult:
    creds = await load_zotero_creds(session, user)
    if not creds or not creds.get("mode"):
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "Zotero not configured. Set Zotero mode/userId/apiKey in Settings first.",
        )
    # Pick the PDF attachment: explicit, or the largest among the item's PDFs.
    if req.attachment_key:
        att_key = req.attachment_key
    else:
        attachments, _ = await list_pdf_attachments(creds, req.item_key)
        if not attachments:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                "This Zotero item has no PDF attachment. Try manual upload instead.",
            )
        att_key = max(attachments, key=lambda a: a.get("fileSize", 0))["key"]

    data = await download_attachment_bytes(creds, att_key)
    if len(data) > _MAX_UPLOAD_BYTES:
        raise HTTPException(
            status.HTTP_413_CONTENT_TOO_LARGE,
            f"zotero file too large: {len(data)} bytes (limit {_MAX_UPLOAD_BYTES})",
        )
    content_hash = hashlib.sha256(data).hexdigest()

    # Per-user dedup by content hash → return the existing row, no re-store.
    existing = (
        await session.exec(
            select(UserPaperUpload).where(
                UserPaperUpload.user_id == user.id,
                UserPaperUpload.content_hash == content_hash,
            )
        )
    ).first()
    if existing is not None:
        prow = await session.get(PaperRow, existing.paper_id)
        if prow is not None:
            return _to_result(prow, is_new=False)

    # Pull the item's metadata (title/creators/abstract/doi/url) from Zotero.
    try:
        meta = await get_zotero_item(creds, req.item_key)
    except HTTPException:
        meta = {}
    title = meta.get("title") or "Untitled Zotero import"
    authors_str = meta.get("creators") or ""
    authors = (
        [a.strip() for a in authors_str.split(";") if a.strip()]
        if authors_str
        else []
    )
    abstract = meta.get("abstract") or ""
    norm_doi = (meta.get("doi") or "").lower() or None
    paper_id = f"doi:{norm_doi}" if norm_doi else f"sha256:{content_hash[:16]}"

    # Persist bytes to the per-user upload dir.
    upath = paths.uploads_dir() / str(user.id)
    upath.mkdir(parents=True, exist_ok=True)
    stored = upath / f"{content_hash}.pdf"
    if not stored.exists():
        stored.write_bytes(data)

    # Upsert the global metadata row (full_text stays NULL for uploads).
    now = int(time.time())
    prow = await session.get(PaperRow, paper_id)
    if prow is None:
        prow = PaperRow(
            arxiv_id=paper_id,
            title=title,
            authors=authors,
            abstract=abstract,
            source="zotero",
            doi=norm_doi,
            external_url=meta.get("url") or None,
            full_text=None,
            fetched_at=now,
        )
        session.add(prow)
    else:
        if title:
            prow.title = title
        if authors:
            prow.authors = authors
        if abstract:
            prow.abstract = abstract
        if norm_doi:
            prow.doi = norm_doi
        prow.source = prow.source or "zotero"
        prow.fetched_at = now
        session.add(prow)

    uprow = UserPaperUpload(
        user_id=user.id,
        paper_id=paper_id,
        source="zotero",
        content_hash=content_hash,
        stored_path=f"{user.id}/{content_hash}.pdf",
        zotero_item_key=req.item_key,
        zotero_attachment_key=att_key,
        byte_size=len(data),
    )
    session.add(uprow)
    await session.commit()
    await session.refresh(prow)
    return _to_result(prow, is_new=True)
