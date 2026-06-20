"""arXiv search proxy — arxiv.org sends no CORS headers, so the browser can't
fetch it directly. We query the public arXiv Atom API and return clean JSON.
"""
from __future__ import annotations

import xml.etree.ElementTree as ET
from typing import Any
from urllib.parse import urlencode

import httpx
from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import JSONResponse

router = APIRouter()

_ARXIV_API = "https://export.arxiv.org/api/query"
# Atom + arXiv namespaces.
_NS = {
    "a": "http://www.w3.org/2005/Atom",
    "arxiv": "http://arxiv.org/schemas/atom",
}
_TIMEOUT = httpx.Timeout(connect=10.0, read=30.0, write=10.0, pool=10.0)


def _text(el: ET.Element | None, path: str, default: str = "") -> str:
    if el is None:
        return default
    found = el.find(path, _NS)
    return (found.text or "").strip() if found is not None else default


def _primary_category(entry: ET.Element) -> str:
    el = entry.find("arxiv:primary_category", _NS)
    if el is not None:
        return el.get("term", "") or ""
    return ""


def _parse_entry(entry: ET.Element) -> dict[str, Any]:
    # arxiv id is the last path segment of the entry <id>, e.g.
    # http://arxiv.org/abs/2401.12345v1 -> 2401.12345v1
    raw_id = _text(entry, "a:id")
    arxiv_id = raw_id.rsplit("/", 1)[-1] if raw_id else ""

    authors: list[str] = []
    for author_el in entry.findall("a:author", _NS):
        name_el = author_el.find("a:name", _NS)
        if name_el is not None and name_el.text:
            authors.append(name_el.text.strip())

    # PDF link from <link rel="related" title="pdf"> or construct from id.
    pdf_url = ""
    for link in entry.findall("a:link", _NS):
        if link.get("title") == "pdf" or link.get("type") == "application/pdf":
            pdf_url = link.get("href", "")
            break
    if not pdf_url and arxiv_id:
        # strip version for a stable pdf url
        base_id = arxiv_id.split("v")[0]
        pdf_url = f"https://arxiv.org/pdf/{base_id}.pdf"

    abs_url = ""
    for link in entry.findall("a:link", _NS):
        if link.get("type") == "text/html":
            abs_url = link.get("href", "")
            break
    if not abs_url and arxiv_id:
        base_id = arxiv_id.split("v")[0]
        abs_url = f"https://arxiv.org/abs/{base_id}"

    return {
        "arxiv_id": arxiv_id,
        "title": _text(entry, "a:title").replace("\n", " "),
        "authors": [a for a in authors if a],
        "abstract": _text(entry, "a:summary").replace("\n", " "),
        "pdf_url": pdf_url,
        "abs_url": abs_url,
        "published": _text(entry, "a:published"),
        "updated": _text(entry, "a:updated"),
        # arXiv primary category, if present.
        "primary_category": _primary_category(entry),
        # DOI when arXiv has one on file (<arxiv:doi>); many preprints don't.
        "doi": _text(entry, "arxiv:doi"),
    }


async def fetch_arxiv_by_id(arxiv_id: str) -> dict[str, Any] | None:
    """Fetch a single arXiv paper's metadata by id via the `id_list` query.

    Reused by the Zotero "save paper" flow (which needs full metadata even when
    the browser only cached a bare-id stub) and by `GET /paper`. Returns the
    parsed entry dict, or None on any network/parse/not-found failure — callers
    treat that as "keep what we have". The version suffix is stripped for the
    lookup so `2401.12345v1` resolves to the latest version's entry.
    """
    base = (arxiv_id or "").strip().split("v")[0]
    if not base:
        return None
    url = f"{_ARXIV_API}?{urlencode({'id_list': base})}"
    async with httpx.AsyncClient(timeout=_TIMEOUT, follow_redirects=True) as client:
        try:
            resp = await client.get(url, headers={"User-Agent": "little-alphaxiv/0.1"})
        except httpx.RequestError:
            return None
    if resp.status_code != 200:
        return None
    try:
        root = ET.fromstring(resp.content)
    except ET.ParseError:
        return None
    entries = root.findall("a:entry", _NS)
    if not entries:
        return None
    parsed = _parse_entry(entries[0])
    # arXiv's id_list query returns a single empty <entry> (no title, no
    # authors) when the id doesn't match — treat that as not-found rather than
    # a real paper with blank fields.
    if not parsed.get("title") and not parsed.get("authors"):
        return None
    return parsed


@router.get("/search")
async def search_arxiv(
    q: str = Query(..., description="arXiv query string (e.g. 'transformer attention')"),
    max_results: int = Query(10, ge=1, le=50),
    sort_by: str = Query("relevance", description="relevance | lastUpdatedDate | submittedDate"),
    sort_order: str = Query("descending", description="ascending | descending"),
) -> Any:
    params = {
        "search_query": _build_query(q),
        "start": 0,
        "max_results": max_results,
        "sortBy": sort_by,
        "sortOrder": sort_order,
    }
    url = f"{_ARXIV_API}?{urlencode(params)}"
    async with httpx.AsyncClient(timeout=_TIMEOUT, follow_redirects=True) as client:
        try:
            resp = await client.get(url, headers={"User-Agent": "little-alphaxiv/0.1"})
        except httpx.RequestError as exc:
            raise HTTPException(status_code=502, detail=f"arxiv request error: {exc}") from exc

    if resp.status_code != 200:
        raise HTTPException(
            status_code=502,
            detail=f"arxiv returned status {resp.status_code}: {resp.text[:300]}",
        )

    try:
        root = ET.fromstring(resp.content)
    except ET.ParseError as exc:
        raise HTTPException(status_code=502, detail=f"arxiv XML parse error: {exc}") from exc

    total = root.find("{http://a9.com/-/spec/opensearch/1.1/}totalResults")
    results = [_parse_entry(e) for e in root.findall("a:entry", _NS)]
    return JSONResponse(
        content={
            "total": int(total.text) if total is not None and total.text else len(results),
            "results": results,
        }
    )


@router.get("/paper")
async def fetch_paper(
    arxiv_id: str = Query(..., description="arXiv id, versioned or not (e.g. 2401.12345 or 2401.12345v2)"),
) -> Any:
    """Fetch one paper's metadata by arXiv id. Used by the paper view + Zotero
    panel to populate title/authors/abstract/DOI when a paper was opened by
    direct URL navigation (so the cached record isn't a bare-id stub)."""
    arxiv_id = (arxiv_id or "").strip()
    if not arxiv_id:
        raise HTTPException(status_code=400, detail="arxiv_id is required")
    paper = await fetch_arxiv_by_id(arxiv_id)
    if not paper:
        raise HTTPException(status_code=404, detail=f"arXiv paper not found: {arxiv_id}")
    # Tag the source here (not in _parse_entry) so arXiv *search* results keep
    # the legacy "source omitted" invariant; only this dedicated fetch advertises
    # source=arxiv.
    paper["source"] = "arxiv"
    return JSONResponse(content={"paper": paper})


def _build_query(q: str) -> str:
    """If the user query already looks like a fielded arXiv query
    (contains 'ti:', 'au:', 'abs:', 'cat:', or boolean operators), pass it
    through. Otherwise treat it as an all-fields search by wrapping each term
    in all:.
    """
    q = q.strip()
    if any(tok in q for tok in (":", " AND ", " OR ", "NOT ")):
        return q
    # bare terms -> all:term1 AND all:term2
    terms = [t for t in q.split() if t]
    if not terms:
        return q
    return " AND ".join(f"all:{t}" for t in terms)
