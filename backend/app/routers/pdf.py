"""arXiv PDF proxy with on-disk cache.

arXiv PDF files send no CORS headers, so pdf.js cannot load them from the
browser directly. We fetch once, cache to a local file, and stream back with
permissive CORS + the right content-type / range support.

Basic single-range support is included so pdf.js can request byte ranges
(needed for lazy loading of large PDFs).
"""
from __future__ import annotations

import hashlib
import os
from pathlib import Path
from typing import Any

import httpx
from fastapi import APIRouter, Header, HTTPException, Query, Request
from fastapi.responses import StreamingResponse, Response

from ._papershared import is_safe_external_url

router = APIRouter()

_CACHE_DIR = Path(
    os.environ.get("LAX_PDF_CACHE", Path.home() / ".little_alphaxiv" / "pdf_cache")
)
_CACHE_DIR.mkdir(parents=True, exist_ok=True)
_TIMEOUT = httpx.Timeout(connect=15.0, read=120.0, write=30.0, pool=15.0)

# Cap on a single OA PDF fetch through the open proxy — guards against
# unbounded/OOM responses (arbitrary-URL proxy, unlike the trusted arxiv path).
_OA_PDF_MAX_BYTES = 100 * 1024 * 1024


def _cache_path(arxiv_id: str) -> Path:
    # sanitize: keep alnum + dot + dash only
    safe = "".join(c for c in arxiv_id if c.isalnum() or c in ".-_")
    if not safe:
        raise HTTPException(status_code=400, detail="invalid arxiv id")
    return _CACHE_DIR / f"{safe}.pdf"


async def _fetch_from_arxiv(arxiv_id: str) -> bytes:
    base_id = arxiv_id.split("v")[0]
    url = f"https://arxiv.org/pdf/{base_id}.pdf"
    async with httpx.AsyncClient(timeout=_TIMEOUT, follow_redirects=True) as client:
        try:
            resp = await client.get(
                url, headers={"User-Agent": "little-alphaxiv/0.1"}
            )
        except httpx.RequestError as exc:
            raise HTTPException(status_code=502, detail=f"arxiv pdf error: {exc}") from exc
    if resp.status_code != 200:
        raise HTTPException(
            status_code=502,
            detail=f"arxiv pdf returned {resp.status_code} for {url}",
        )
    return resp.content


def _cache_path_for_url(url: str) -> Path:
    # URL characters aren't filename-safe and the plain-sanitize scheme collides
    # for non-arxiv ids; key the cache by a sha256 of the URL instead.
    digest = hashlib.sha256(url.encode("utf-8")).hexdigest()
    return _CACHE_DIR / f"oa-{digest}.pdf"


async def _fetch_from_url(url: str) -> bytes:
    ok, reason = is_safe_external_url(url)
    if not ok:
        raise HTTPException(status_code=400, detail=f"refused pdf url: {reason}")
    # Do NOT follow redirects on the open proxy: a 3xx could redirect to an
    # internal/metadata host that bypasses the SSRF guard (which only checks
    # the original URL). OA PDFs that require redirects fail with a clear 502.
    async with httpx.AsyncClient(timeout=_TIMEOUT, follow_redirects=False) as client:
        try:
            resp = await client.get(url, headers={"User-Agent": "little-alphaxiv/0.1"})
        except httpx.RequestError as exc:
            raise HTTPException(status_code=502, detail=f"pdf url error: {exc}") from exc
        if resp.is_redirect:
            raise HTTPException(
                status_code=502,
                detail=f"pdf url redirected (not followed for safety): {resp.status_code}",
            )
        if resp.status_code != 200:
            raise HTTPException(
                status_code=502,
                detail=f"pdf url returned {resp.status_code} for {url}",
            )
        # Guard against unbounded fetches: honor a declared content-length, and
        # also cap the streamed body (chunked responses have no content-length).
        cl = resp.headers.get("content-length")
        if cl and cl.isdigit() and int(cl) > _OA_PDF_MAX_BYTES:
            raise HTTPException(
                status_code=413, detail=f"pdf url too large: {cl} bytes (limit {_OA_PDF_MAX_BYTES})"
            )
        chunks: list[bytes] = []
        total = 0
        async for chunk in resp.aiter_bytes():
            total += len(chunk)
            if total > _OA_PDF_MAX_BYTES:
                raise HTTPException(
                    status_code=413, detail=f"pdf url exceeded {_OA_PDF_MAX_BYTES} bytes"
                )
            chunks.append(chunk)
        return b"".join(chunks)


@router.get("/pdf-url")
async def get_pdf_by_url(
    url: str = Query(..., description="Absolute http(s) URL of an open-access PDF"),
    range_header: str | None = Header(default=None, alias="Range"),
) -> Any:
    path = _cache_path_for_url(url)
    if not path.exists():
        data = await _fetch_from_url(url)
        try:
            path.write_bytes(data)
        except OSError:
            return _serve_bytes(data, range_header)
    else:
        data = path.read_bytes()
    return _serve_bytes(data, range_header)


@router.get("/pdf/{arxiv_id}")
async def get_pdf(
    arxiv_id: str,
    request: Request,
    range_header: str | None = Header(default=None, alias="Range"),
) -> Any:
    path = _cache_path(arxiv_id)
    if not path.exists():
        data = await _fetch_from_arxiv(arxiv_id)
        try:
            path.write_bytes(data)
        except OSError:
            # cache write is best-effort; serve from memory if disk fails
            return _serve_bytes(data, range_header)
    else:
        data = path.read_bytes()
    return _serve_bytes(data, range_header)


def _serve_bytes(data: bytes, range_header: str | None) -> Response:
    total = len(data)
    headers: dict[str, str] = {
        "Accept-Ranges": "bytes",
        "Cache-Control": "public, max-age=86400",
    }
    if range_header and range_header.startswith("bytes="):
        try:
            spec = range_header[len("bytes="):]
            start_s, end_s = spec.split("-", 1)
            start = int(start_s) if start_s else 0
            end = int(end_s) if end_s else total - 1
            end = min(end, total - 1)
            if start > end or start >= total:
                return Response(
                    status_code=416,
                    headers={"Content-Range": f"bytes */{total}"},
                )
            chunk = data[start : end + 1]
            headers["Content-Range"] = f"bytes {start}-{end}/{total}"
            return Response(
                content=chunk,
                status_code=206,
                media_type="application/pdf",
                headers=headers,
            )
        except (ValueError, IndexError):
            pass  # fall through to full response
    return Response(content=data, media_type="application/pdf", headers=headers)
