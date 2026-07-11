"""arXiv PDF proxy with on-disk cache.

arXiv PDF files send no CORS headers, so pdf.js cannot load them from the
browser directly. We fetch once, cache to a local file, and stream back with
permissive CORS + the right content-type / range support.

Basic single-range support is included so pdf.js can request byte ranges
(needed for lazy loading of large PDFs).

Cold-open streaming: on a cache miss the arXiv download is streamed through
to the client chunk-by-chunk (instead of buffering the whole file in memory
before responding) so pdf.js's onProgress fires and the user sees a real
download % rather than a frozen "Loading PDF…" spinner. The stream is teed
to a .part file that is atomically renamed to the cache on completion, so the
next open is a warm disk hit (served with range support). Accept-Ranges is
NOT advertised on the streaming 200 — pdf.js then uses progressive full-body
loading for that request; range seeking kicks in on the next (cache-hit)
request via serve_pdf_bytes.
"""
from __future__ import annotations

import hashlib
import os
import secrets
from pathlib import Path
from typing import Any

import httpx
from fastapi import APIRouter, Header, HTTPException, Query, Request
from fastapi.responses import StreamingResponse, Response

from .. import paths
from ._papershared import is_safe_external_url

router = APIRouter()

# PDF disk cache (content-addressed, global, non-sensitive). Default lives in
# the consolidated data dir (backend/data/pdf_cache locally, /app/data/pdf_cache
# in Docker where the Dockerfile sets LAX_PDF_CACHE explicitly).
_CACHE_DIR = paths.pdf_cache_dir()
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
            return serve_pdf_bytes(data, range_header)
    else:
        data = path.read_bytes()
    return serve_pdf_bytes(data, range_header)


@router.get("/pdf/{arxiv_id}")
async def get_pdf(
    arxiv_id: str,
    request: Request,
    range_header: str | None = Header(default=None, alias="Range"),
) -> Any:
    path = _cache_path(arxiv_id)
    if path.exists():
        # Warm: serve from disk with range support so pdf.js can seek fast.
        return serve_pdf_bytes(path.read_bytes(), range_header)
    # Cold: stream the arXiv download through to the client (tee to cache) so
    # pdf.js gets bytes progressively + onProgress fires (real download %).
    return await _stream_arxiv_pdf(arxiv_id, path)


def _commit_part(part: Path, cache_path: Path, expected: int | None) -> None:
    """Promote a .part download to the cache atomically, iff its size matches
    the declared Content-Length (or the length is unknown). A mismatched/partial
    .part is dropped so the next open retries instead of caching a truncated
    PDF. Best-effort: any OSError (stat/rename/unlink) drops the .part — the
    client already received the bytes either way; the cache is just a bonus.
    """
    try:
        if expected is not None and part.stat().st_size != expected:
            part.unlink(missing_ok=True)
            return
        os.replace(part, cache_path)
    except OSError:
        part.unlink(missing_ok=True)


async def _stream_arxiv_pdf(arxiv_id: str, cache_path: Path) -> StreamingResponse:
    """Stream an arXiv PDF to the client while teeing it into the disk cache.

    On a cache miss we forward arXiv's bytes chunk-by-chunk so pdf.js receives
    them progressively and its onProgress fires (real download %). The same
    bytes are written to a unique .part file and atomically renamed to
    cache_path on completion — the next open hits the warm disk cache (range
    served via serve_pdf_bytes). No Accept-Ranges is advertised on this 200 so
    pdf.js uses progressive full-body loading for this request.
    """
    base_id = arxiv_id.split("v")[0]
    url = f"https://arxiv.org/pdf/{base_id}.pdf"
    client = httpx.AsyncClient(timeout=_TIMEOUT, follow_redirects=True)
    try:
        resp = await client.send(
            client.build_request("GET", url, headers={"User-Agent": "little-alphaxiv/0.1"}),
            stream=True,
        )
    except httpx.RequestError as exc:
        await client.aclose()
        raise HTTPException(status_code=502, detail=f"arxiv pdf error: {exc}") from exc
    if resp.status_code != 200:
        await resp.aclose()
        await client.aclose()
        raise HTTPException(
            status_code=502,
            detail=f"arxiv pdf returned {resp.status_code} for {url}",
        )

    headers: dict[str, str] = {"Cache-Control": "public, max-age=86400"}
    cl = resp.headers.get("content-length")
    if cl and cl.isdigit():
        headers["Content-Length"] = cl  # lets pdf.js show a % (absent → bytes only)

    # Unique .part per stream: two concurrent cold opens of the same paper would
    # otherwise truncate each other's write. Both pull identical bytes from
    # arXiv, so last-writer-wins on the atomic rename is safe.
    part = cache_path.with_name(f"{cache_path.name}.{secrets.token_hex(4)}.part")

    async def gen():
        expected = int(cl) if (cl and cl.isdigit()) else None
        committed = False
        try:
            # `with` keeps the file open across yields (the client may read
            # slowly) and closes it on normal exit OR on cancellation
            # (GeneratorExit propagates through __exit__ → file closed before
            # we rename/unlink — required on Windows where an open file can't
            # be renamed or deleted).
            with open(part, "wb") as f:
                async for chunk in resp.aiter_bytes():
                    f.write(chunk)
                    yield chunk
            # Loop completed normally → commit (size-checked).
            _commit_part(part, cache_path, expected)
            committed = cache_path.exists()
        finally:
            # A cancellation or a post-download protocol error (real uvicorn +
            # `connection: close` surfaces one after the last chunk) can land
            # between the final yield and the commit above — observed in the
            # real-arXiv smoke: 2.2MB streamed to the client but the cache
            # stayed empty. If the .part is complete (size matches the declared
            # length) and we haven't committed, commit it here so a fully-
            # downloaded file still populates the cache. A partial .part
            # (mid-download cancellation) is dropped so the next open retries
            # instead of caching a truncated PDF.
            if not committed and part.exists() and not cache_path.exists():
                _commit_part(part, cache_path, expected)
            await resp.aclose()
            await client.aclose()

    return StreamingResponse(gen(), media_type="application/pdf", headers=headers)


def serve_pdf_bytes(data: bytes, range_header: str | None) -> Response:
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
