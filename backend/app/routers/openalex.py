"""OpenAlex API search proxy.

OpenAlex sends no CORS headers, so the browser can't reach it directly. We
query the public /works endpoint and normalize results to the shared Paper
shape. An optional API key (free — get yours at openalex.org/settings/api)
and an optional email (the 'polite pool' mailto param) improve rate limits.
"""
from __future__ import annotations

from typing import Any
from urllib.parse import urlencode

import httpx
from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import JSONResponse

from ._papershared import normalize_doi, arxiv_id_from_doi, abstract_from_inverted_index

router = APIRouter()

_OPENALEX_WORKS = "https://api.openalex.org/works"
_TIMEOUT = httpx.Timeout(connect=10.0, read=30.0, write=10.0, pool=10.0)


def _parse_work(item: dict[str, Any]) -> dict[str, Any]:
    doi = normalize_doi(item.get("doi"))
    arxiv_id = arxiv_id_from_doi(doi) or ""

    authors: list[str] = []
    for a in item.get("authorships") or []:
        author = a.get("author") or {}
        name = author.get("display_name")
        if name:
            authors.append(name)

    abstract = abstract_from_inverted_index(item.get("abstract_inverted_index"))

    # OpenAlex exposes the best OA PDF under best_oa_location.pdf_url.
    oa = item.get("best_oa_location") or item.get("open_access") or {}
    oa_pdf_url = ""
    if isinstance(oa, dict):
        oa_pdf_url = oa.get("pdf_url") or ""

    published = item.get("publication_date") or ""

    primary_topic = item.get("primary_topic") or {}
    primary_category = ""
    if isinstance(primary_topic, dict):
        primary_category = primary_topic.get("display_name") or ""

    # OpenAlex work id is like https://openalex.org/W123; landing page is the
    # work URL itself (falls back to the DOI landing page).
    external_url = item.get("id") or (f"https://doi.org/{doi}" if doi else "")

    return {
        "arxiv_id": arxiv_id,
        "title": item.get("title") or item.get("display_name") or "",
        "authors": authors,
        "abstract": abstract,
        "pdf_url": "",
        "abs_url": "",
        "published": published,
        "primary_category": primary_category,
        "source": "openalex",
        "doi": doi,
        "oa_pdf_url": oa_pdf_url,
        "external_url": external_url,
    }


@router.get("/openalex")
async def search_openalex(
    q: str = Query(..., description="OpenAlex search query"),
    max_results: int = Query(10, ge=1, le=50),
    api_key: str = Query("", description="Optional OpenAlex API key"),
    email: str = Query("", description="Optional email for OpenAlex polite pool"),
) -> Any:
    params: dict[str, Any] = {
        "search": q,
        "per_page": max_results,
    }
    if email:
        params["mailto"] = email
    if api_key:
        params["api_key"] = api_key
    url = f"{_OPENALEX_WORKS}?{urlencode(params)}"
    async with httpx.AsyncClient(timeout=_TIMEOUT, follow_redirects=True) as client:
        try:
            resp = await client.get(url, headers={"User-Agent": "little-alphaxiv/0.1"})
        except httpx.RequestError as exc:
            raise HTTPException(status_code=502, detail=f"openalex request error: {exc}") from exc

    if resp.status_code == 429:
        raise HTTPException(status_code=429, detail="openalex rate limited; try search_arxiv")
    if resp.status_code != 200:
        raise HTTPException(
            status_code=502,
            detail=f"openalex returned status {resp.status_code}: {resp.text[:300]}",
        )
    try:
        data = resp.json()
    except ValueError as exc:
        raise HTTPException(status_code=502, detail=f"openalex json error: {exc}") from exc

    items = data.get("results") or []
    results = [_parse_work(it) for it in items]
    total = data.get("meta", {}).get("count", len(results)) if isinstance(data.get("meta"), dict) else len(results)
    return JSONResponse(content={"total": total, "results": results})
