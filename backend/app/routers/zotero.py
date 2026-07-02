"""Zotero integration proxy.

Zotero exposes three APIs, none of which send CORS headers, so the browser
can't reach them directly. This router proxies to whichever the user picked:

  - local  -> http://127.0.0.1:23119   (Zotero desktop running with
             "Allow other applications to communicate with Zotero" enabled)
             * read via  /api/users/0/...        (read-only, no key)
             * create via /connector/saveItems   (+ /connector/saveAttachment
               two-step to attach a PDF; no key)
  - web    -> https://api.zotero.org   (full CRUD; needs userID + API key,
             library synced to zotero.org). Header `Zotero-API-Key`.
  - auto   -> try local first (short timeout), fall back to web if the user
             supplied credentials.

Like every other router here this is a stateless dumb pipe: userID / API key
arrive per-request from the browser (stored in the user's own localStorage).
Nothing is persisted server-side.

API reality (verified against Zotero 7/8):
  - local /api/ is READ ONLY; all writes 501.
  - /connector/ can CREATE items (+ attach files) but cannot update/delete/move
    or create collections — those need the web API.
  - So "organize" (create collection / add-to-collection) is web-only by
    Zotero's design, not ours.
"""
from __future__ import annotations

import asyncio
import html
import json
import os
import pathlib
import re
import uuid
from datetime import date
from typing import Any
from urllib.parse import urlencode, urlparse, unquote

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from .. import security
from ..db import get_session
from ..deps import current_user
from ..models import User, UserSettings
from .search import fetch_arxiv_by_id

router = APIRouter()

_LOCAL = "http://127.0.0.1:23119"
_WEB = "https://api.zotero.org"
# Local read API lives under /api ; the user library is identified by "0".
# Connector endpoints live directly under /connector (no /api prefix).
_LOCAL_READ = f"{_LOCAL}/api"
_LOCAL_CONN = _LOCAL

# Optional HTTP(S) proxy for Zotero WEB-mode calls ONLY (the local API on
# 127.0.0.1:23119 is never proxied — it's loopback). Docker Desktop on Windows
# runs the container in a WSL2 VM whose egress bypasses the host's system
# proxy (Clash/V2Ray at 127.0.0.1:7890 on the Windows host), so from inside a
# container api.zotero.org is reached over the raw NIC — which, from networks
# that intermittently throttle api.zotero.org, produces persistent ReadTimeout
# / ConnectError("")(RST). Setting LAX_ZOTERO_PROXY to a proxy the container CAN
# reach (e.g. http://host.docker.internal:7890 with Clash's "Allow LAN" on,
# binding 0.0.0.0:7890) routes only the Zotero web calls through that clean
# path. Empty/unset = current behavior (direct). See docs/designs.
_ZOTERO_PROXY = os.environ.get("LAX_ZOTERO_PROXY", "").strip() or None

# Read timeout is generous (60s) because Zotero's qmode=everything full-text
# search is variable server-side: on a ~526-item library the cold-cache first
# call ranges 1-30s (measured 2026-06-30 — 10/10 at read=60s, max 21.74s; a
# 30.69s stall observed at read=30s). The old 30s read timeout turned a normal
# slow-but-completing everything search into a hard ReadTimeout. 60s absorbs
# the observed variance; the _zotero_get retry (round-1 fix) covers the rare
# >60s stall. The frontend also avoids firing two everything searches
# concurrently (findCurrentPaper's title search uses titleCreatorYear).
_TIMEOUT = httpx.Timeout(connect=4.0, read=60.0, write=15.0, pool=10.0)
_PDF_TIMEOUT = httpx.Timeout(connect=10.0, read=90.0, write=90.0, pool=15.0)
# Short timeout for the local ping — Zotero desktop is on the loopback, so 2s
# is plenty to tell "running" from "not running" without hanging auto mode.
_PING_TIMEOUT = httpx.Timeout(connect=1.5, read=2.0, write=2.0, pool=2.0)

# --- Local-first PDF import (cloud fallback) -------------------------------
# The Zotero WEB file download 302-redirects to zoterofilestorage.s3..., which
# is intermittently (and sometimes persistently) interfered with from a Docker
# container's raw NIC — hanging up to the OS TCP timeout (~5 min). But the PDF
# is ALSO sitting on the user's local disk under their Zotero storage dir. The
# local Zotero API (127.0.0.1:23119) exposes GET /api/users/0/items/<key>/file
# which returns a 302 -> file:///<storage>/<key>/<filename>.pdf pointing at that
# local file. So we try local FIRST (read the file straight off disk), and only
# fall back to the flaky S3 cloud download if local is unavailable.
#
# Native (run.bat): _LOCAL_BASE defaults to 127.0.0.1:23119 and the file:// path
#   is read directly by the OS — zero config.
# Docker: the container can't reach 127.0.0.1:23119 (that's the container's own
#   loopback) and can't read C:/Users/... So set LAX_ZOTERO_LOCAL_BASE to point
#   at the host (http://host.docker.internal:23119) + mount the host Zotero
#   storage dir read-only at /zotero-storage + set LAX_ZOTERO_STORAGE_DIR to the
#   host path so the file:// path can be rewritten to the mount. See
#   docs/superpowers/specs/2026-07-02-zotero-local-first-import-design.md.
#
# Zotero's local HTTP server rejects requests whose Host header isn't localhost
# (anti-CSRF). Connecting to host.docker.internal would set Host=host.docker.internal
# and get a 400 — so we always send Host: 127.0.0.1:23119 (harmless in native where
# it's already the natural value). Verified against Zotero 7.
_lb_raw = os.environ.get("LAX_ZOTERO_LOCAL_BASE", "http://127.0.0.1:23119").strip()
_LOCAL_BASE: str | None = _lb_raw or None  # "" (explicit) -> disabled -> cloud only
_LOCAL_HOST_HEADER = "127.0.0.1:23119"
# Host-side Zotero storage dir (set in Docker; empty in native where file:// is
# read directly). When set, a file:// path whose host-prefix matches is rewritten
# to /zotero-storage/<rest> (the container mount).
_STORAGE_MAP_HOST = os.environ.get("LAX_ZOTERO_STORAGE_DIR", "").strip().replace("\\", "/")
_STORAGE_CONTAINER_PREFIX = "/zotero-storage"

_ARXIV_RE = re.compile(r"(?:arxiv[:\s/]*|arxiv\.org/(?:abs|pdf)/)([0-9]{4}\.[0-9]{4,5}(?:v[0-9]+)?)", re.IGNORECASE)
_UA = "little-alphaxiv/0.1 (zotero-integration)"


# --------------------------------------------------------------------------- #
# upstream GET with one retry on transient errors
# --------------------------------------------------------------------------- #
# Zotero (especially the web API, especially qmode=everything full-text
# searches) is variable server-side: the FIRST search on a cold cache can
# take ~10s on a ~526-item library, while the immediate retry hits a warm
# cache and returns in ~0.5s (measured 2026-06-30 against a real library).
# A ReadTimeout on a read GET is therefore usually a cold-cache slow query,
# NOT a genuinely dead upstream — a single retry almost always succeeds
# fast. So read GETs retry ONCE on ANY httpx.RequestError (network/protocol
# errors AND timeouts) and on HTTP 429 / 5xx. Writes are not retried here
# (the web API's Zotero-Write-Token already makes writes idempotent, but the
# local connector has no such guard, so retry stays read-only).
_RETRY_BACKOFF_S = 0.5
_RETRY_MAX_ATTEMPTS = 2  # 1 initial attempt + 1 retry


def _is_transient(exc: BaseException) -> bool:
    """A RequestError worth retrying. For Zotero this INCLUDES timeouts:
    measured evidence shows a ReadTimeout on a qmode=everything search is a
    cold-cache slow query whose immediate retry hits warm cache (~0.5s vs
    ~10s+). Treating timeouts as transient turns a hard 30s failure into a
    ~30.5s success for the common cold-cache case; the persistent-stall
    case still surfaces the timeout after the single retry."""
    return isinstance(exc, httpx.RequestError)


async def _zotero_get(
    url: str, *, headers: dict[str, str], timeout: httpx.Timeout, trust_env: bool,
) -> httpx.Response:
    """GET a Zotero read URL with one retry on transient errors. Raises the
    last httpx.RequestError on persistent failure; returns the httpx.Response
    (status unchecked) on success — the caller inspects status_code and handles
    4xx/5xx. 429 / 5xx are retried once before being surfaced.

    Proxy: web-mode calls (trust_env=True) route through LAX_ZOTERO_PROXY when
    set, so a Docker container whose egress bypasses the host's system proxy can
    still reach api.zotero.org over a clean path. Local-mode calls
    (trust_env=False, loopback) are never proxied."""
    proxy = _ZOTERO_PROXY if trust_env else None
    for attempt in range(_RETRY_MAX_ATTEMPTS):
        try:
            async with httpx.AsyncClient(timeout=timeout, follow_redirects=True,
                                         trust_env=trust_env, proxy=proxy) as client:
                r = await client.get(url, headers=headers)
        except httpx.RequestError as exc:
            if _is_transient(exc) and attempt + 1 < _RETRY_MAX_ATTEMPTS:
                await asyncio.sleep(_RETRY_BACKOFF_S)
                continue
            raise
        if (r.status_code == 429 or 500 <= r.status_code < 600) and attempt + 1 < _RETRY_MAX_ATTEMPTS:
            await asyncio.sleep(_RETRY_BACKOFF_S)
            continue
        return r
    raise RuntimeError("zotero get: unreachable")  # pragma: no cover


# --------------------------------------------------------------------------- #
# mode resolution
# --------------------------------------------------------------------------- #
async def _local_alive() -> bool:
    """True if the Zotero local READ API is usable.

    We gate on the read API, not /connector/ping, because the connector server
    is always on while Zotero runs (it's how the browser extension works) but
    /api/ reads require the user to enable "Allow other applications to
    communicate with Zotero". Since search/find (reads) is the entry point of
    the feature, a local mode that can't read isn't usable — auto mode should
    fall back to web in that case. trust_env=False so a corporate HTTP_PROXY
    never intercepts a loopback call.
    """
    try:
        async with httpx.AsyncClient(timeout=_PING_TIMEOUT, trust_env=False) as client:
            r = await client.get(f"{_LOCAL_READ}/users/0/items?limit=1&format=keys")
            return r.status_code == 200
    except httpx.RequestError:
        return False


async def _resolve_mode(mode: str, user_id: str, api_key: str) -> str:
    """Resolve 'auto' to a concrete 'local' | 'web'. 'local'/'web' pass through
    (we do NOT silently rewrite an explicit choice). Returns None-equivalent
    via raising when auto can't resolve to anything usable."""
    if mode == "local":
        return "local"
    if mode == "web":
        return "web"
    # auto: prefer local (zero-config, attaches PDFs), fall back to web.
    if await _local_alive():
        return "local"
    if user_id and api_key:
        return "web"
    # No local, no web creds -> prefer local so the error message points the
    # user at starting Zotero rather than at missing API keys.
    return "local"


def _require_web(mode: str) -> None:
    if mode != "web":
        raise HTTPException(
            status_code=400,
            detail="This Zotero operation (create collection / add to collection) "
            "requires Web API mode — the local API is read-only and the connector "
            "can only create items. Switch to Web API in Settings.",
        )


def _headers_web(api_key: str) -> dict[str, str]:
    return {"Zotero-API-Key": api_key, "User-Agent": _UA}


def _user_seg(mode: str, user_id: str) -> str:
    # Local API always addresses the logged-in user as "0".
    return "0" if mode == "local" else user_id


# --------------------------------------------------------------------------- #
# response normalization
# --------------------------------------------------------------------------- #
def _parse_arxiv_id(item: dict[str, Any]) -> str:
    data = item.get("data") or item
    extra = data.get("extra") or ""
    m = _ARXIV_RE.search(extra)
    if m:
        return m.group(1)
    for url in (data.get("url") or "", data.get("source") or ""):
        m = _ARXIV_RE.search(url)
        if m:
            return m.group(1)
    return ""


def _year_from_date(date: str) -> str:
    if not date:
        return ""
    m = re.search(r"(1[89][0-9]{2}|20[0-9]{2})", date)
    return m.group(1) if m else ""


def _format_creators(creators: list[dict[str, Any]]) -> str:
    parts: list[str] = []
    for c in creators or []:
        last = c.get("lastName") or ""
        first = c.get("firstName") or ""
        name = c.get("name") or ""
        if name:
            parts.append(name)
        elif last or first:
            parts.append(f"{first} {last}".strip())
    return "; ".join(parts)


def _normalize_item(item: dict[str, Any]) -> dict[str, Any]:
    data = item.get("data") or item
    return {
        "key": item.get("key") or data.get("key") or "",
        "title": data.get("title") or "(untitled)",
        "creators": _format_creators(data.get("creators") or []),
        "itemType": data.get("itemType") or "",
        "year": _year_from_date(data.get("date") or ""),
        "date": data.get("date") or "",
        "url": data.get("url") or "",
        "doi": (data.get("DOI") or "").lower() or "",
        "arxivId": _parse_arxiv_id(item),
        "abstract": data.get("abstractNote") or "",
        "collections": data.get("collections") or [],
        "tags": [t.get("tag", "") for t in (data.get("tags") or []) if isinstance(t, dict)],
    }


def _normalize_collection(coll: dict[str, Any]) -> dict[str, Any]:
    data = coll.get("data") or coll
    meta = coll.get("meta") or {}
    return {
        "key": coll.get("key") or data.get("key") or "",
        "name": data.get("name") or "(unnamed)",
        "parentKey": data.get("parentCollection") or "",
        "numItems": meta.get("numItems", 0) if isinstance(meta, dict) else 0,
    }


# --------------------------------------------------------------------------- #
# 1. status / connectivity
# --------------------------------------------------------------------------- #
@router.get("/zotero/status")
async def status(
    mode: str = Query("auto"),
    user_id: str = Query("", description="Zotero userID (web mode)"),
    api_key: str = Query("", description="Zotero API key (web mode)"),
) -> Any:
    resolved = await _resolve_mode(mode, user_id, api_key)
    user_seg = _user_seg(resolved, user_id)

    if resolved == "local":
        # _resolve_mode already verified the read API for auto; for an explicit
        # "local" choice we re-verify here and report a clear error if the user
        # hasn't enabled "Allow other applications to communicate with Zotero".
        url = f"{_LOCAL_READ}/users/{user_seg}/items?limit=1&format=keys"
        try:
            # Route through _zotero_get so a transient blip (the Zotero desktop
            # connector occasionally drops a loopback connection) is retried once
            # instead of immediately reporting "unreachable".
            r = await _zotero_get(url, headers={"User-Agent": _UA},
                                  timeout=_TIMEOUT, trust_env=False)
        except httpx.RequestError as exc:
            # str(exc) can be "" (terse ConnectError on a reset); fall back to
            # the type name so the surfaced error is never the blank
            # "local-unreachable: " the user would otherwise see.
            return JSONResponse(content={"ok": False, "mode": "local",
                                         "error": f"local-unreachable: {str(exc) or type(exc).__name__}"})
        if r.status_code != 200:
            return JSONResponse(content={"ok": False, "mode": "local",
                                         "error": f"local-read-disabled (Zotero returned {r.status_code}). "
                                                  "Enable 'Allow other applications to communicate with Zotero' "
                                                  "in Zotero → Preferences → Advanced."})
        return JSONResponse(content={"ok": True, "mode": "local", "library": "My Library"})

    # web
    if not (user_id and api_key):
        return JSONResponse(content={"ok": False, "mode": "web", "error": "missing user_id or api_key"})
    url = f"{_WEB}/users/{user_seg}/items?limit=1&format=keys"
    try:
        # Route through _zotero_get so a transient blip (TCP reset / ReadTimeout
        # — common from networks where api.zotero.org is intermittently
        # interfered with; measured 15/15 success on a good moment but RSTs
        # happen on bad ones) is retried once instead of immediately reporting
        # "unreachable". Same retry the items/collections reads already get.
        r = await _zotero_get(url, headers=_headers_web(api_key),
                              timeout=_TIMEOUT, trust_env=True)
    except httpx.RequestError as exc:
        # str(exc) can be "" (e.g. a terse ConnectError on a reset); fall back
        # to the type name so the surfaced error is never the blank
        # "web-unreachable: " the user would otherwise see.
        return JSONResponse(content={"ok": False, "mode": "web",
                                     "error": f"web-unreachable: {str(exc) or type(exc).__name__}"})
    if r.status_code == 403:
        return JSONResponse(content={"ok": False, "mode": "web", "error": "invalid api key (403)"})
    if r.status_code != 200:
        return JSONResponse(content={"ok": False, "mode": "web",
                                     "error": f"web api returned {r.status_code}"})
    return JSONResponse(content={"ok": True, "mode": "web", "library": f"user {user_id}"})


# --------------------------------------------------------------------------- #
# 2. search / list items
# --------------------------------------------------------------------------- #
@router.get("/zotero/items")
async def list_items(
    mode: str = Query("auto"),
    user_id: str = Query(""),
    api_key: str = Query(""),
    q: str = Query("", description="search query (title/creator, or everything with qmode)"),
    qmode: str = Query("", description="titleCreatorYear | everything"),
    limit: int = Query(25, ge=1, le=100),
    start: int = Query(0, ge=0),
    collection_key: str = Query("", description="restrict to a collection"),
) -> Any:
    resolved = await _resolve_mode(mode, user_id, api_key)
    user_seg = _user_seg(resolved, user_id)

    if collection_key:
        path = f"users/{user_seg}/collections/{collection_key}/items"
    else:
        path = f"users/{user_seg}/items"
    params: dict[str, Any] = {"limit": limit, "start": start, "itemType": "-attachment"}
    if q:
        params["q"] = q
    if qmode:
        params["qmode"] = qmode
    if resolved == "local":
        url = f"{_LOCAL_READ}/{path}?{urlencode(params)}"
        headers = {"User-Agent": _UA}
    else:
        if not (user_id and api_key):
            raise HTTPException(status_code=400, detail="web mode requires user_id and api_key")
        url = f"{_WEB}/{path}?{urlencode(params)}"
        headers = _headers_web(api_key)

    try:
        r = await _zotero_get(url, headers=headers, timeout=_TIMEOUT,
                              trust_env=(resolved != "local"))
    except httpx.RequestError as exc:
        # str(exc) is sometimes "" (e.g. a terse ConnectError on a dropped
        # loopback / reset); fall back to the exception type so the surfaced
        # message is never the blank "zotero request error: ".
        raise HTTPException(
            status_code=502,
            detail=f"zotero request error: {str(exc) or type(exc).__name__}",
        ) from exc
    if r.status_code != 200:
        raise HTTPException(status_code=502, detail=f"zotero items returned {r.status_code}: {r.text[:200]}")
    try:
        data = r.json()
    except ValueError as exc:
        raise HTTPException(status_code=502, detail=f"zotero json error: {exc}") from exc
    items = [_normalize_item(it) for it in data] if isinstance(data, list) else []
    total = int(r.headers.get("Total-Results", len(items)))
    return JSONResponse(content={"total": total, "results": items, "mode": resolved})


# --------------------------------------------------------------------------- #
# 3. collections
# --------------------------------------------------------------------------- #
@router.get("/zotero/collections")
async def list_collections(
    mode: str = Query("auto"),
    user_id: str = Query(""),
    api_key: str = Query(""),
) -> Any:
    resolved = await _resolve_mode(mode, user_id, api_key)
    user_seg = _user_seg(resolved, user_id)
    path = f"users/{user_seg}/collections"
    params = {"limit": 100}
    if resolved == "local":
        url = f"{_LOCAL_READ}/{path}?{urlencode(params)}"
        headers = {"User-Agent": _UA}
    else:
        if not (user_id and api_key):
            raise HTTPException(status_code=400, detail="web mode requires user_id and api_key")
        url = f"{_WEB}/{path}?{urlencode(params)}"
        headers = _headers_web(api_key)
    try:
        r = await _zotero_get(url, headers=headers, timeout=_TIMEOUT,
                              trust_env=(resolved != "local"))
    except httpx.RequestError as exc:
        raise HTTPException(
            status_code=502,
            detail=f"zotero request error: {str(exc) or type(exc).__name__}",
        ) from exc
    if r.status_code != 200:
        raise HTTPException(status_code=502, detail=f"zotero collections returned {r.status_code}: {r.text[:200]}")
    data = r.json() if r.text else []
    cols = [_normalize_collection(c) for c in (data or [])] if isinstance(data, list) else []
    return JSONResponse(content={"results": cols, "mode": resolved})


# --------------------------------------------------------------------------- #
# 3b. currently-selected save target (local mode)
# --------------------------------------------------------------------------- #
# The local connector has no way to *choose* a target collection for a new
# item — /connector/saveItems always saves into the Zotero desktop's
# currently-selected collection (getSaveTarget() in server_connector.js),
# ignoring any collections field. To make that "saves somewhere I didn't
# pick" behavior visible (instead of feeling random), we surface the
# desktop's current selection via /connector/getSelectedCollection so the
# UI can show "Saving to: <name>" and tell the user to change it in Zotero
# (or switch to Web API to choose here). Web mode has no GUI selection, so
# it reports nothing to choose.
@router.get("/zotero/selected-collection")
async def get_selected_collection(
    mode: str = Query("auto"),
    user_id: str = Query(""),
    api_key: str = Query(""),
) -> Any:
    resolved = await _resolve_mode(mode, user_id, api_key)
    if resolved != "local":
        return JSONResponse(content={"ok": True, "mode": resolved,
                                     "libraryName": "", "collectionName": ""})
    headers = {"Content-Type": "application/json", "X-Zotero-Connector-API-Version": "3"}
    async with httpx.AsyncClient(timeout=_TIMEOUT, trust_env=False) as client:
        try:
            r = await client.post(f"{_LOCAL_CONN}/connector/getSelectedCollection",
                                  json={}, headers=headers)
        except httpx.RequestError as exc:
            return JSONResponse(content={"ok": False, "mode": "local",
                                         "error": f"local-unreachable: {exc}"})
    if r.status_code != 200:
        return JSONResponse(content={"ok": False, "mode": "local",
                                     "error": f"getSelectedCollection returned {r.status_code}"})
    data = r.json() or {}
    # When My Library itself (not a collection) is selected, Zotero returns
    # id:null and name=<libraryName>.
    return JSONResponse(content={
        "ok": True, "mode": "local",
        "libraryName": data.get("libraryName") or "",
        "collectionName": data.get("name") or data.get("libraryName") or "",
        "collectionId": data.get("id"),
    })


# --------------------------------------------------------------------------- #
# 4. create item (generic)
# --------------------------------------------------------------------------- #
class CreateItemRequest(BaseModel):
    mode: str = "auto"
    user_id: str = ""
    api_key: str = ""
    item: dict[str, Any]


@router.post("/zotero/items")
async def create_item(req: CreateItemRequest) -> Any:
    resolved = await _resolve_mode(req.mode, req.user_id, req.api_key)
    user_seg = _user_seg(resolved, req.user_id)
    item = req.item or {}

    if resolved == "local":
        # Connector: items must be an array; collections field is ignored.
        body = {
            "items": [item],
            "uri": item.get("url") or "https://arxiv.org",
            "sessionID": uuid.uuid4().hex,
        }
        headers = {"Content-Type": "application/json", "X-Zotero-Connector-API-Version": "3"}
        async with httpx.AsyncClient(timeout=_TIMEOUT, trust_env=False) as client:
            try:
                r = await client.post(f"{_LOCAL_CONN}/connector/saveItems", json=body, headers=headers)
            except httpx.RequestError as exc:
                raise HTTPException(status_code=502, detail=f"zotero connector error: {exc}") from exc
        if r.status_code not in (200, 201):
            raise HTTPException(status_code=502, detail=f"connector saveItems returned {r.status_code}: {r.text[:200]}")
        # Connector returns an empty body; recover the new key by reading the
        # most-recently-added item matching the title.
        key = await _find_local_key_by_title(item.get("title") or "")
        return JSONResponse(content={"ok": True, "mode": "local", "key": key})

    # web
    if not (req.user_id and req.api_key):
        raise HTTPException(status_code=400, detail="web mode requires user_id and api_key")
    token = uuid.uuid4().hex
    headers = {**_headers_web(req.api_key), "Content-Type": "application/json",
               "Zotero-Write-Token": token}
    async with httpx.AsyncClient(timeout=_TIMEOUT, proxy=_ZOTERO_PROXY) as client:
        try:
            r = await client.post(f"{_WEB}/users/{user_seg}/items", json=[item], headers=headers)
        except httpx.RequestError as exc:
            raise HTTPException(status_code=502, detail=f"zotero request error: {exc}") from exc
    if r.status_code not in (200, 201):
        raise HTTPException(status_code=502, detail=f"zotero create returned {r.status_code}: {r.text[:200]}")
    data = r.json() if r.text else {}
    key = ""
    success = data.get("success") or {}
    if success and str(0) in success:
        key = success["0"]
    return JSONResponse(content={"ok": True, "mode": "web", "key": key})


async def _find_local_key_by_title(title: str) -> str:
    if not title:
        return ""
    url = f"{_LOCAL_READ}/users/0/items?sort=dateAdded&direction=desc&limit=10&itemType=-attachment"
    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT, trust_env=False) as client:
            r = await client.get(url, headers={"User-Agent": _UA})
    except httpx.RequestError:
        return ""
    if r.status_code != 200:
        return ""
    for it in (r.json() or []):
        d = it.get("data") or {}
        if (d.get("title") or "").strip().lower() == title.strip().lower():
            return it.get("key") or ""
    return ""


# --------------------------------------------------------------------------- #
# 5. create collection (web only)
# --------------------------------------------------------------------------- #
class CreateCollectionRequest(BaseModel):
    mode: str = "auto"
    user_id: str = ""
    api_key: str = ""
    name: str
    parent_key: str = ""


@router.post("/zotero/collections")
async def create_collection(req: CreateCollectionRequest) -> Any:
    resolved = await _resolve_mode(req.mode, req.user_id, req.api_key)
    _require_web(resolved)
    if not (req.user_id and req.api_key):
        raise HTTPException(status_code=400, detail="web mode requires user_id and api_key")
    payload: dict[str, Any] = {"name": req.name}
    if req.parent_key:
        payload["parentCollection"] = req.parent_key
    token = uuid.uuid4().hex
    headers = {**_headers_web(req.api_key), "Content-Type": "application/json",
               "Zotero-Write-Token": token}
    async with httpx.AsyncClient(timeout=_TIMEOUT, proxy=_ZOTERO_PROXY) as client:
        try:
            r = await client.post(f"{_WEB}/users/{req.user_id}/collections", json=[payload], headers=headers)
        except httpx.RequestError as exc:
            raise HTTPException(status_code=502, detail=f"zotero request error: {exc}") from exc
    if r.status_code not in (200, 201):
        raise HTTPException(status_code=502, detail=f"zotero create collection returned {r.status_code}: {r.text[:200]}")
    data = r.json() if r.text else {}
    key = ""
    success = data.get("success") or {}
    if success and str(0) in success:
        key = success["0"]
    return JSONResponse(content={"ok": True, "key": key})


# --------------------------------------------------------------------------- #
# 6. add item to collection(s) (web only)
# --------------------------------------------------------------------------- #
class AddToCollectionRequest(BaseModel):
    mode: str = "auto"
    user_id: str = ""
    api_key: str = ""
    collection_keys: list[str] = Field(default_factory=list)


@router.post("/zotero/items/{item_key}/collections")
async def add_to_collection(item_key: str, req: AddToCollectionRequest) -> Any:
    resolved = await _resolve_mode(req.mode, req.user_id, req.api_key)
    _require_web(resolved)
    if not (req.user_id and req.api_key):
        raise HTTPException(status_code=400, detail="web mode requires user_id and api_key")
    headers = _headers_web(req.api_key)
    async with httpx.AsyncClient(timeout=_TIMEOUT, proxy=_ZOTERO_PROXY) as client:
        # GET current item to read its version + existing collections (merge, not replace).
        try:
            g = await client.get(f"{_WEB}/users/{req.user_id}/items/{item_key}", headers=headers)
        except httpx.RequestError as exc:
            raise HTTPException(status_code=502, detail=f"zotero request error: {exc}") from exc
        if g.status_code != 200:
            raise HTTPException(status_code=502, detail=f"zotero get item returned {g.status_code}: {g.text[:200]}")
        version = g.headers.get("Last-Modified-Version", "")
        data = g.json() or {}
        existing = (data.get("data") or {}).get("collections") or []
        merged: list[str] = []
        seen: set[str] = set()
        for k in [*existing, *req.collection_keys]:
            if k and k not in seen:
                seen.add(k)
                merged.append(k)
        patch_headers = {**headers, "Content-Type": "application/json",
                         "If-Unmodified-Since-Version": version}
        try:
            r = await client.patch(f"{_WEB}/users/{req.user_id}/items/{item_key}",
                                   json={"collections": merged}, headers=patch_headers)
        except httpx.RequestError as exc:
            raise HTTPException(status_code=502, detail=f"zotero request error: {exc}") from exc
    if r.status_code not in (200, 204):
        raise HTTPException(status_code=502, detail=f"zotero patch returned {r.status_code}: {r.text[:200]}")
    return JSONResponse(content={"ok": True, "collections": merged})


# --------------------------------------------------------------------------- #
# 6b. upsert child note (web only) — "Create Note from Annotations"
# --------------------------------------------------------------------------- #
# The browser continuously extracts the user's PDF annotations (highlights +
# text notes) and pushes them as a single child note under the paper's Zotero
# item. To keep that idempotent across sessions — and resilient to a cached
# note key going stale after the user deletes the note in Zotero — we tag the
# note with a fixed marker and rediscover it by tag when the cached key misses.
#
# Web-only by necessity: the local Zotero connector cannot link child notes
# (see save_arxiv), so there is no local path here.
ANNOT_NOTE_TAG = "little-alphaxiv-annotations"


class UpsertNoteRequest(BaseModel):
    mode: str = "auto"
    user_id: str = ""
    api_key: str = ""
    html: str
    # Cached note key from a previous successful sync — lets us PATCH directly
    # without listing children. If it 404s (note deleted in Zotero) we fall
    # back to tag-based discovery, then create.
    note_key: str = ""
    tag: str = ANNOT_NOTE_TAG


async def _patch_note(
    client: httpx.AsyncClient, user_id: str, note_key: str, note_html: str,
    headers: dict[str, str], tag: str,
) -> tuple[bool, str]:
    """PATCH an existing note's body. Returns (ok, key). On 404/gone (note
    deleted in Zotero) returns (False, '') so the caller falls back to
    discovery/create. Verifies the item is actually one of our tagged notes
    before overwriting, so a stale note_key pointing at an unrelated item is
    not clobbered."""
    try:
        g = await client.get(f"{_WEB}/users/{user_id}/items/{note_key}", headers=headers)
    except httpx.RequestError:
        return (False, "")
    if g.status_code == 404:
        return (False, "")
    if g.status_code != 200:
        return (False, "")
    data = (g.json() or {}).get("data") or {}
    if (data.get("itemType") or "") != "note":
        return (False, "")
    tags = {t.get("tag", "") for t in (data.get("tags") or []) if isinstance(t, dict)}
    # If the existing note carries tags and ours isn't among them, treat it as
    # someone else's note — don't overwrite. (Discovery normally only lands us
    # on tagged notes; this guards a stale cached key.)
    if tags and tag not in tags:
        return (False, "")
    version = g.headers.get("Last-Modified-Version", "")
    patch_headers = {**headers, "Content-Type": "application/json",
                     "If-Unmodified-Since-Version": version}
    try:
        r = await client.patch(f"{_WEB}/users/{user_id}/items/{note_key}",
                               json={"note": note_html}, headers=patch_headers)
    except httpx.RequestError:
        return (False, "")
    if r.status_code not in (200, 204):
        return (False, "")
    return (True, note_key)


async def _find_child_note_by_tag(
    client: httpx.AsyncClient, user_id: str, parent_key: str, tag: str,
    headers: dict[str, str],
) -> str:
    """Return the key of the parent's child note carrying `tag`, or ''.
    Lists the parent's children (notes are children in the web API) and matches
    itemType=note + tag."""
    try:
        r = await client.get(
            f"{_WEB}/users/{user_id}/items/{parent_key}/children",
            headers=headers, params={"itemType": "note", "limit": 100},
        )
    except httpx.RequestError:
        return ""
    if r.status_code != 200:
        return ""
    for it in (r.json() or []):
        d = it.get("data") or {}
        if (d.get("itemType") or "") != "note":
            continue
        tags = {t.get("tag", "") for t in (d.get("tags") or []) if isinstance(t, dict)}
        if tag in tags:
            return it.get("key") or ""
    return ""


async def _create_child_note(
    client: httpx.AsyncClient, user_id: str, parent_key: str, note_html: str,
    tag: str, headers: dict[str, str],
) -> str:
    """Create a new child note under parent_key, tagged with `tag`. Returns
    the new key or '' on failure."""
    item = {"itemType": "note", "note": note_html, "parentItem": parent_key,
            "tags": [{"tag": tag}]}
    token = uuid.uuid4().hex
    post_headers = {**headers, "Content-Type": "application/json",
                    "Zotero-Write-Token": token}
    try:
        r = await client.post(f"{_WEB}/users/{user_id}/items",
                              json=[item], headers=post_headers)
    except httpx.RequestError:
        return ""
    if r.status_code not in (200, 201):
        return ""
    data = r.json() if r.text else {}
    success = data.get("success") or {}
    if success and str(0) in success:
        return success["0"]
    return ""


@router.post("/zotero/items/{parent_key}/note")
async def upsert_note(parent_key: str, req: UpsertNoteRequest) -> Any:
    """Create-or-update the paper's annotations child note (web only).

    Resolution order: (1) PATCH the cached `note_key` if given and still
    valid; (2) discover an existing tagged child note under `parent_key`;
    (3) create a new tagged child note. Returns {ok, key, created, mode,
    error?}."""
    resolved = await _resolve_mode(req.mode, req.user_id, req.api_key)
    if resolved != "web":
        raise HTTPException(
            status_code=400,
            detail="Note sync requires Web API mode — the local Zotero "
            "connector cannot attach child notes. Switch to Web API in Settings.",
        )
    if not (req.user_id and req.api_key):
        raise HTTPException(status_code=400, detail="web mode requires user_id and api_key")
    headers = _headers_web(req.api_key)
    tag = req.tag or ANNOT_NOTE_TAG
    async with httpx.AsyncClient(timeout=_TIMEOUT, proxy=_ZOTERO_PROXY) as client:
        if req.note_key:
            ok, key = await _patch_note(client, req.user_id, req.note_key, req.html, headers, tag)
            if ok:
                return JSONResponse(content={"ok": True, "key": key, "created": False, "mode": "web"})
        found = await _find_child_note_by_tag(client, req.user_id, parent_key, tag, headers)
        if found:
            ok, key = await _patch_note(client, req.user_id, found, req.html, headers, tag)
            if ok:
                return JSONResponse(content={"ok": True, "key": key, "created": False, "mode": "web"})
        new_key = await _create_child_note(client, req.user_id, parent_key, req.html, tag, headers)
    if new_key:
        return JSONResponse(content={"ok": True, "key": new_key, "created": True, "mode": "web"})
    return JSONResponse(content={"ok": False, "key": "", "created": False, "mode": "web",
                                 "error": "note upsert failed (Zotero returned no key)"})


# --------------------------------------------------------------------------- #
# 7. save current arXiv paper (+ optional PDF) — the "connector-like" flow
# --------------------------------------------------------------------------- #
class SaveArxivRequest(BaseModel):
    mode: str = "auto"
    user_id: str = ""
    api_key: str = ""
    paper: dict[str, Any]
    attach_pdf: bool = True
    # Optional target collection(s) for the new item. Web mode honors this at
    # creation time (item goes straight into the collection); local mode cannot
    # — see save_arxiv — so this is effectively web-only.
    collection_keys: list[str] = Field(default_factory=list)


def _zotero_creators(authors: list[str]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for a in authors or []:
        a = (a or "").strip()
        if not a:
            continue
        if "," in a:
            last, _, first = a.partition(",")
            out.append({"creatorType": "author", "lastName": last.strip(), "firstName": first.strip()})
        else:
            parts = a.split()
            if len(parts) >= 2:
                out.append({"creatorType": "author", "lastName": parts[-1], "firstName": " ".join(parts[:-1])})
            else:
                out.append({"creatorType": "author", "name": a})
    return out


def _short_title(title: str) -> str:
    """Derive a Zotero `shortTitle` from a paper title: take the text before the
    first colon (the subtitle separator, common in "Main: Sub" academic titles),
    in either ASCII or full-width form. Only return it when it's a genuine
    shortening (>= 10 chars and strictly shorter than the full title) —
    otherwise leave shortTitle empty, matching Zotero's own auto-shorten."""
    title = (title or "").strip()
    if not title:
        return ""
    for sep in (":", "："):
        if sep in title:
            head = title.split(sep, 1)[0].strip()
            if len(head) >= 10 and len(head) < len(title) - 2:
                return head
    return ""


def _build_arxiv_item(paper: dict[str, Any]) -> dict[str, Any]:
    """Build a Zotero `preprint` item from a Paper record, populating every
    field the user expects on "Add to Zotero": title, authors, archive +
    archiveID (存档id), date, DOI, shortTitle (短标题), language (语言),
    libraryCatalog (文库编目), abstractNote (摘要), repository, url, extra, tags.
    `extra` keeps the `arXiv: <id>` line so the find-current-paper search
    (qmode=everything) still matches future lookups."""
    arxiv_id = (paper.get("arxiv_id") or "").strip()
    title = paper.get("title") or arxiv_id or "Untitled"
    extra_lines = [f"arXiv: {arxiv_id}"] if arxiv_id else []

    item: dict[str, Any] = {
        "itemType": "preprint",
        "title": title,
        "creators": _zotero_creators(paper.get("authors") or []),
        "abstractNote": paper.get("abstract") or "",
        "date": (paper.get("published") or "")[:10],
        "url": paper.get("abs_url") or (f"https://arxiv.org/abs/{arxiv_id}" if arxiv_id else ""),
        # Provenance: arXiv is simultaneously the archive (with an archive ID),
        # the repository, and the library catalog. All three are independent
        # preprint fields, so setting them together is fine and matches what
        # users see when they "Add to Zotero" from arxiv.org via the connector.
        "archive": "arXiv",
        "archiveID": arxiv_id,
        "repository": "arXiv",
        "libraryCatalog": "arXiv",
        # arXiv metadata carries no language field; arXiv is overwhelmingly
        # English, so default to "en" (ISO 639-1) rather than leave it blank.
        "language": "en",
        "shortTitle": _short_title(title),
        "extra": "\n".join(extra_lines),
    }
    doi = (paper.get("doi") or "").strip()
    if doi:
        item["DOI"] = doi
    # Tag with the primary category (e.g. cs.CL) for easy filtering.
    cat = (paper.get("primary_category") or "").strip()
    if cat:
        item["tags"] = [{"tag": cat}]
    return item


def _build_note_html(paper: dict[str, Any]) -> str:
    """HTML body for the child note (笔记) attached to the saved paper: a
    compact provenance card (arXiv id, authors, category, date, DOI, links)
    plus an "Added via Little Alphaxiv on <date>" stamp. Values are HTML-
    escaped — author/comment text is user/foreign data."""
    arxiv_id = (paper.get("arxiv_id") or "").strip()
    authors = paper.get("authors") or []
    abs_url = paper.get("abs_url") or (f"https://arxiv.org/abs/{arxiv_id}" if arxiv_id else "")
    pdf_url = paper.get("pdf_url") or (f"https://arxiv.org/pdf/{arxiv_id}" if arxiv_id else "")
    doi = (paper.get("doi") or "").strip()
    rows = [
        ("arXiv ID", arxiv_id),
        ("Authors", "; ".join(authors)),
        ("Primary category", paper.get("primary_category") or ""),
        ("Published", (paper.get("published") or "")[:10]),
        ("DOI", doi),
    ]
    table = "".join(
        f"<tr><td><b>{html.escape(k)}</b></td><td>{html.escape(str(v))}</td></tr>"
        for k, v in rows if v
    )
    links = " · ".join(
        f'<a href="{html.escape(u)}">{html.escape(label)}</a>'
        for label, u in (("abstract", abs_url), ("PDF", pdf_url)) if u
    )
    stamp = date.today().isoformat()
    head = (
        f"<p>Added via <b>Little Alphaxiv</b> on {html.escape(stamp)}"
        + (f' from <a href="{html.escape(abs_url)}">arXiv:{html.escape(arxiv_id)}</a>.</p>'
           if abs_url else ".</p>")
    )
    return f"{head}<table>{table}</table>" + (f"<p>{links}</p>" if links else "")


def _note_item_web(note_html: str, parent_key: str) -> dict[str, Any]:
    """Child note for the web API. `parentItem` is the parent's Zotero key
    (returned by the create-item POST) — the documented, reliable way to
    attach a child note. (The local connector does NOT support linking child
    notes — see save_arxiv — so this helper is web-only.)"""
    return {"itemType": "note", "note": note_html, "parentItem": parent_key, "tags": []}


async def _enrich_paper_from_arxiv(paper: dict[str, Any]) -> dict[str, Any]:
    """Safety net: if the incoming `paper` is a bare-id stub (no real title or
    no authors — this happens when a paper was opened by direct URL navigation
    and the browser only cached `title = arxivId`), fetch real metadata from
    arXiv by id and merge it in. Incoming non-empty values always win; only
    gaps are filled. Best-effort: on any failure the original paper is
    returned unchanged so the save still proceeds with whatever we have."""
    arxiv_id = (paper.get("arxiv_id") or "").strip()
    title = (paper.get("title") or "").strip()
    has_title = bool(title) and title != arxiv_id
    has_authors = bool(paper.get("authors"))
    if (has_title and has_authors) or not arxiv_id:
        return paper
    try:
        fetched = await fetch_arxiv_by_id(arxiv_id)
    except Exception:
        return paper
    if not fetched:
        return paper
    merged = dict(paper)
    if not has_title:
        merged["title"] = fetched.get("title") or merged.get("title") or arxiv_id
    if not has_authors:
        merged["authors"] = fetched.get("authors") or merged.get("authors") or []
    for k in ("abstract", "published", "abs_url", "pdf_url", "doi", "primary_category"):
        if not (merged.get(k) or "").strip():
            merged[k] = fetched.get(k) or merged.get(k) or ""
    return merged


async def _attach_pdf_local(arxiv_id: str, session_id: str, parent_item_id: str) -> bool:
    """Two-step connector protocol, step 2: POST the arXiv PDF as an attachment
    linked to the parent item saved in save_arxiv. `session_id` and
    `parent_item_id` MUST match what save_arxiv used in saveItems (per Zotero's
    connector contract). Returns True on success.

    The PDF is fetched from arxiv.org (proxy-aware, trust_env=True) and POSTed
    to the local connector (trust_env=False so a corporate proxy never
    intercepts a loopback call)."""
    if not arxiv_id:
        return False
    pdf_url = f"https://arxiv.org/pdf/{arxiv_id}"
    try:
        async with httpx.AsyncClient(timeout=_PDF_TIMEOUT, follow_redirects=True) as fetch:
            pdf = await fetch.get(pdf_url, headers={"User-Agent": _UA})
            if pdf.status_code != 200 or "pdf" not in (pdf.headers.get("content-type") or "").lower():
                return False
            pdf_bytes = pdf.content
        meta = {"sessionID": session_id, "parentItemID": parent_item_id,
                "title": f"{arxiv_id}.pdf", "url": pdf_url}
        async with httpx.AsyncClient(timeout=_PDF_TIMEOUT, trust_env=False) as conn:
            r = await conn.post(
                f"{_LOCAL_CONN}/connector/saveAttachment",
                content=pdf_bytes,
                headers={
                    "Content-Type": "application/pdf",
                    "Content-Length": str(len(pdf_bytes)),
                    "X-Metadata": json.dumps(meta),
                    "X-Zotero-Connector-API-Version": "3",
                },
            )
            return r.status_code in (200, 201)
    except httpx.RequestError:
        return False


@router.post("/zotero/save-arxiv")
async def save_arxiv(req: SaveArxivRequest) -> Any:
    resolved = await _resolve_mode(req.mode, req.user_id, req.api_key)
    # Enrich first: guarantees a complete item even if the browser only cached
    # a bare-id stub (title = arxivId, no authors/abstract/DOI).
    paper = await _enrich_paper_from_arxiv(req.paper or {})
    arxiv_id = (paper.get("arxiv_id") or "").strip()
    item = _build_arxiv_item(paper)

    if resolved == "local":
        # Create the parent item via the connector. We set a connector `id` on
        # the item so the PDF (two-step saveAttachment) can link to it — same as
        # the original working save, parent only.
        #
        # NOTE on the child note (笔记): the local Zotero connector does NOT
        # support attaching child notes. saveItems links child items via
        # `parentItem` only for attachments (itemType=attachment); for notes it
        # silently creates a STANDALONE note regardless of parentItem (verified
        # against Zotero 7/8 — both parentItem=<connector id> in-batch and
        # parentItem=<Zotero key> cross-call leave the note unlinked). Creating
        # orphan notes would clutter the library, so in local mode we attach
        # metadata only. The web API does support child notes (parentItem=key),
        # so noteAdded is true there.
        session_id = uuid.uuid4().hex
        conn_item_id = uuid.uuid4().hex
        item["id"] = conn_item_id
        body = {
            "items": [item],
            "uri": item.get("url") or "https://arxiv.org",
            "sessionID": session_id,
        }
        headers = {"Content-Type": "application/json", "X-Zotero-Connector-API-Version": "3"}
        async with httpx.AsyncClient(timeout=_TIMEOUT, trust_env=False) as client:
            try:
                r = await client.post(f"{_LOCAL_CONN}/connector/saveItems", json=body, headers=headers)
            except httpx.RequestError as exc:
                raise HTTPException(status_code=502, detail=f"zotero connector error: {exc}") from exc
        if r.status_code not in (200, 201):
            raise HTTPException(status_code=502, detail=f"connector saveItems returned {r.status_code}: {r.text[:200]}")
        key = await _find_local_key_by_title(item.get("title") or "")
        pdf_ok = False
        if req.attach_pdf and arxiv_id:
            pdf_ok = await _attach_pdf_local(arxiv_id, session_id, conn_item_id)
        return JSONResponse(content={"ok": True, "mode": "local", "key": key,
                                     "pdfAttached": pdf_ok, "noteAdded": False})

    # web
    if not (req.user_id and req.api_key):
        raise HTTPException(status_code=400, detail="web mode requires user_id and api_key")
    note_html = _build_note_html(paper)
    # The Web API honors `collections` at creation time — place the item directly
    # into the chosen collection(s). The local connector CANNOT do this:
    # /connector/saveItems saves into the Zotero desktop's currently-selected
    # collection (getSaveTarget() in Zotero's server_connector.js) and ignores
    # any collections field on the item. So collection_keys only takes effect
    # here, in web mode.
    if req.collection_keys:
        item["collections"] = req.collection_keys
    token = uuid.uuid4().hex
    headers = {**_headers_web(req.api_key), "Content-Type": "application/json",
               "Zotero-Write-Token": token}
    note_added = False
    async with httpx.AsyncClient(timeout=_TIMEOUT, proxy=_ZOTERO_PROXY) as client:
        try:
            r = await client.post(f"{_WEB}/users/{req.user_id}/items", json=[item], headers=headers)
        except httpx.RequestError as exc:
            raise HTTPException(status_code=502, detail=f"zotero request error: {exc}") from exc
        if r.status_code not in (200, 201):
            raise HTTPException(status_code=502, detail=f"zotero create returned {r.status_code}: {r.text[:200]}")
        data = r.json() if r.text else {}
        key = ""
        success = data.get("success") or {}
        if success and str(0) in success:
            key = success["0"]
        # Attach a child note (笔记) to the freshly created parent. Best-effort:
        # a failure here must not undo the parent item, so it's swallowed.
        if key:
            try:
                note_headers = {**_headers_web(req.api_key), "Content-Type": "application/json",
                                "Zotero-Write-Token": uuid.uuid4().hex}
                nr = await client.post(f"{_WEB}/users/{req.user_id}/items",
                                       json=[_note_item_web(note_html, key)], headers=note_headers)
                note_added = nr.status_code in (200, 201)
            except httpx.RequestError:
                note_added = False
    # Web PDF attach is out of v1 scope (needs file-upload registration); metadata-only.
    return JSONResponse(content={"ok": True, "mode": "web", "key": key,
                                 "pdfAttached": False, "noteAdded": note_added})


# --------------------------------------------------------------------------- #
# Reverse-import: read a user's Zotero PDF attachment into the app.
# --------------------------------------------------------------------------- #
# Creds (userId + apiKey) live server-side, Fernet-encrypted in
# user_settings.zotero_config (see routers/settings.py). The legacy zotero
# endpoints still take creds per-request in the query string; these new
# reverse-import helpers read from UserSettings so the browser never re-sends
# the key. Web mode is REQUIRED for file download (the local desktop API
# doesn't expose /file bytes), so local-mode users fall back to manual upload
# — their PDFs are already on disk anyway.

_IMPORT_MAX_BYTES = 50 * 1024 * 1024  # mirror the upload cap


async def load_zotero_creds(session: AsyncSession, user: User) -> dict | None:
    """Decrypt the user's stored Zotero config. Returns {mode, userId, apiKey}
    or None if unconfigured. The apiKey is Fernet-decrypted here so callers
    never handle ciphertext."""
    row = (
        await session.exec(
            select(UserSettings).where(UserSettings.user_id == user.id)
        )
    ).first()
    if row is None:
        return None
    cfg = dict(row.zotero_config or {})
    key = cfg.get("apiKey")
    if key:
        try:
            cfg["apiKey"] = security.decrypt(key)
        except Exception:  # noqa: BLE001 — bad ciphertext → treat as no key
            cfg["apiKey"] = ""
    return cfg or None


async def list_pdf_attachments(creds: dict, item_key: str) -> tuple[list, str]:
    """Enumerate the PDF attachment children of a Zotero item. Works in both
    local and web modes (both support reading item children)."""
    resolved = await _resolve_mode(
        creds.get("mode", "auto"), creds.get("userId", ""), creds.get("apiKey", "")
    )
    user_seg = _user_seg(resolved, creds.get("userId", ""))
    path = f"users/{user_seg}/items/{item_key}/children"
    params = {"itemType": "attachment", "limit": 50}
    if resolved == "local":
        url = f"{_LOCAL_READ}/{path}?{urlencode(params)}"
        headers = {"User-Agent": _UA}
    else:
        if not (creds.get("userId") and creds.get("apiKey")):
            raise HTTPException(status_code=400, detail="Zotero Web mode requires userId and apiKey.")
        url = f"{_WEB}/{path}?{urlencode(params)}"
        headers = _headers_web(creds["apiKey"])
    try:
        r = await _zotero_get(
            url, headers=headers, timeout=_TIMEOUT, trust_env=(resolved != "local")
        )
    except httpx.RequestError as exc:
        raise HTTPException(
            status_code=502,
            detail=f"zotero request error: {str(exc) or type(exc).__name__}",
        ) from exc
    if r.status_code != 200:
        raise HTTPException(
            status_code=502,
            detail=f"zotero attachments returned {r.status_code}: {r.text[:200]}",
        )
    try:
        data = r.json()
    except ValueError as exc:
        raise HTTPException(status_code=502, detail=f"zotero json error: {exc}") from exc
    out: list[dict] = []
    for it in data if isinstance(data, list) else []:
        d = it.get("data") or it
        if (d.get("contentType") or "").lower() == "application/pdf":
            out.append(
                {
                    "key": it.get("key") or d.get("key") or "",
                    "title": d.get("title") or "",
                    "contentType": d.get("contentType") or "",
                    "fileSize": d.get("fileSize") or 0,
                    "linkMode": d.get("linkMode") or "",
                }
            )
    return out, resolved


async def get_zotero_item(creds: dict, item_key: str) -> dict:
    """Fetch + normalize a single Zotero item (metadata for an import)."""
    resolved = await _resolve_mode(
        creds.get("mode", "auto"), creds.get("userId", ""), creds.get("apiKey", "")
    )
    user_seg = _user_seg(resolved, creds.get("userId", ""))
    path = f"users/{user_seg}/items/{item_key}"
    if resolved == "local":
        url = f"{_LOCAL_READ}/{path}"
        headers = {"User-Agent": _UA}
    else:
        if not (creds.get("userId") and creds.get("apiKey")):
            raise HTTPException(status_code=400, detail="Zotero Web mode requires userId and apiKey.")
        url = f"{_WEB}/{path}"
        headers = _headers_web(creds["apiKey"])
    try:
        r = await _zotero_get(
            url, headers=headers, timeout=_TIMEOUT, trust_env=(resolved != "local")
        )
    except httpx.RequestError as exc:
        raise HTTPException(
            status_code=502,
            detail=f"zotero request error: {str(exc) or type(exc).__name__}",
        ) from exc
    if r.status_code != 200:
        raise HTTPException(
            status_code=502,
            detail=f"zotero item returned {r.status_code}: {r.text[:200]}",
        )
    try:
        data = r.json()
    except ValueError as exc:
        raise HTTPException(status_code=502, detail=f"zotero json error: {exc}") from exc
    return _normalize_item(data)


class _LocalUnavailable(Exception):
    """Raised by download_local_attachment_bytes when the local Zotero file
    can't be fetched (no local Zotero running, attachment not on disk, storage
    dir not mounted, path outside the allowed base, IO error, etc.). The caller
    (fetch_attachment_bytes) treats this as a silent signal to fall back to the
    cloud download — it is NOT surfaced to the user."""


def _resolve_local_path(file_url: str) -> str | None:
    """Translate a local-API `file://` redirect into a path this process can
    read. Returns None if the URL isn't a file URL or resolves outside the
    allowed storage base (path-traversal guard).

    Native (LAX_ZOTERO_STORAGE_DIR unset): the file:// path is a real host path
    the OS reads directly (e.g. C:/Users/.../Zotero/storage/KEY/file.pdf).
    Docker (LAX_ZOTERO_STORAGE_DIR set): the host prefix is rewritten to the
    /zotero-storage mount point so the container can read the mounted file."""
    if not file_url.startswith("file:"):
        return None
    host_path = unquote(urlparse(file_url).path).lstrip("/").replace("\\", "/")
    if not host_path:
        return None
    if _STORAGE_MAP_HOST:
        if not host_path.lower().startswith(_STORAGE_MAP_HOST.lower()):
            return None  # file lives outside the mounted storage dir — don't read it
        rel = host_path[len(_STORAGE_MAP_HOST):].lstrip("/")
        resolved = f"{_STORAGE_CONTAINER_PREFIX}/{rel}"
    else:
        resolved = host_path
    # Path-traversal guard: no ".." components may remain in the resolved path.
    if any(part == ".." for part in pathlib.PurePosixPath(resolved).parts):
        return None
    return resolved


async def download_local_attachment_bytes(attachment_key: str) -> bytes:
    """Read a Zotero PDF attachment's bytes straight off the local disk, via the
    local Zotero API's `file://` redirect. Raises _LocalUnavailable on ANY local
    failure so the caller can fall back to the cloud download silently.

    The local API needs no creds (it addresses the logged-in user as "0") and
    works regardless of the user's configured mode — even a Web-mode user whose
    cloud download is flaky gets the file from local disk if Zotero desktop is
    running. This is the fast, proxy-free, quota-immune path."""
    if not _LOCAL_BASE:
        raise _LocalUnavailable("local-first disabled (LAX_ZOTERO_LOCAL_BASE empty)")
    url = f"{_LOCAL_BASE}/api/users/0/items/{attachment_key}/file"
    # Host: 127.0.0.1:23119 — Zotero's anti-CSRF rejects non-localhost Host
    # headers, so a Docker container hitting host.docker.internal must spoof it.
    headers = {"User-Agent": _UA, "Host": _LOCAL_HOST_HEADER}
    try:
        async with httpx.AsyncClient(
            timeout=_PING_TIMEOUT, trust_env=False, follow_redirects=False
        ) as client:
            r = await client.get(url, headers=headers)
    except httpx.RequestError:
        raise _LocalUnavailable("local API unreachable")
    if r.status_code != 302:
        raise _LocalUnavailable(f"local /file returned {r.status_code} (no local file)")
    resolved = _resolve_local_path(r.headers.get("location", ""))
    if not resolved:
        raise _LocalUnavailable("local file path unresolved/unsafe")
    try:
        data = await asyncio.to_thread(pathlib.Path(resolved).read_bytes)
    except OSError:
        raise _LocalUnavailable(f"local file unreadable: {resolved}")
    if len(data) > _IMPORT_MAX_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"zotero file exceeded {_IMPORT_MAX_BYTES} bytes",
        )
    return data


async def fetch_attachment_bytes(creds: dict, attachment_key: str) -> bytes:
    """Fetch a Zotero PDF attachment's bytes, preferring local disk and falling
    back to the (flaky, proxy-needing) cloud download only if local is
    unavailable. Local-first dodges both the S3 throttling AND the cloud-storage-
    quota-exhaustion case (a file not synced to zotero.org is still on disk)."""
    try:
        return await download_local_attachment_bytes(attachment_key)
    except _LocalUnavailable:
        return await download_attachment_bytes(creds, attachment_key)


async def download_attachment_bytes(creds: dict, attachment_key: str) -> bytes:
    """Download a Zotero PDF attachment's bytes from the cloud (Web mode only).
    Zotero's web file API 302-redirects to S3, so follow_redirects=True. Capped at
    _IMPORT_MAX_BYTES. This is the CLOUD FALLBACK — fetch_attachment_bytes tries
    the local disk path first via download_local_attachment_bytes; this runs only
    when local is unavailable (no Zotero desktop, storage not mounted, file
    missing). Has retry + per-attempt cap to bound the S3 stall on bad networks."""
    so follow_redirects=True. Capped at _IMPORT_MAX_BYTES."""
    resolved = await _resolve_mode(
        creds.get("mode", "auto"), creds.get("userId", ""), creds.get("apiKey", "")
    )
    if resolved != "web":
        raise HTTPException(
            status_code=400,
            detail="Importing a Zotero PDF requires Web API mode (the local API "
            "doesn't expose file downloads). Switch to Web API in Settings, or "
            "upload the PDF manually.",
        )
    if not (creds.get("userId") and creds.get("apiKey")):
        raise HTTPException(status_code=400, detail="Zotero Web mode requires userId and apiKey.")
    url = f"{_WEB}/users/{creds['userId']}/items/{attachment_key}/file"
    headers = _headers_web(creds["apiKey"])
    chunks: list[bytes] = []
    total = 0
    async with httpx.AsyncClient(
        timeout=_PDF_TIMEOUT, follow_redirects=True, proxy=_ZOTERO_PROXY
    ) as client:
        try:
            r = await client.get(url, headers=headers)
        except httpx.RequestError as exc:
            raise HTTPException(
                status_code=502,
                detail=f"zotero download error: {str(exc) or type(exc).__name__}",
            ) from exc
        if r.status_code != 200:
            raise HTTPException(
                status_code=502,
                detail=f"zotero file returned {r.status_code}: {r.text[:200]}",
            )
        async for chunk in r.aiter_bytes():
            total += len(chunk)
            if total > _IMPORT_MAX_BYTES:
                raise HTTPException(
                    status_code=413,
                    detail=f"zotero file exceeded {_IMPORT_MAX_BYTES} bytes",
                )
            chunks.append(chunk)
    return b"".join(chunks)


@router.get("/zotero/items/{item_key}/attachments")
async def list_item_attachments(
    item_key: str,
    user: User = Depends(current_user),
    session: AsyncSession = Depends(get_session),
) -> Any:
    """List a Zotero item's PDF attachments (for the Import-from-Zotero picker)."""
    creds = await load_zotero_creds(session, user)
    if not creds or not creds.get("mode"):
        raise HTTPException(
            status_code=400,
            detail="Zotero not configured. Set Zotero mode/userId/apiKey in Settings first.",
        )
    items, resolved = await list_pdf_attachments(creds, item_key)
    return JSONResponse(content={"results": items, "mode": resolved})
