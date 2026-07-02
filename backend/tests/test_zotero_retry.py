"""Zotero read-endpoint retry + error-message regression tests.

The Zotero web API (api.zotero.org) is occasionally flaky from some networks
— a request drops mid-flight and a fresh attempt clears it. `list_items` /
`list_collections` previously turned every transient `httpx.RequestError` into
an immediate hard 502 with a detail that could be the blank
`"zotero request error: "` (when the exception's str() was empty), which is
what users saw as "Search failed: zotero items error 502: ...".

These tests pin the two fixes:
  - `_zotero_get` retries ONCE on transient network errors (not timeouts) and
    on HTTP 429 / 5xx; it gives up on persistent failure.
  - The surfaced 502 detail is never blank — it falls back to the exception
    type name when str(exc) is empty.

No real network: we swap `httpx.AsyncClient` for a scripted fake whose
`.get()` yields a fixed sequence of responses/exceptions (one per attempt).
No DB needed — the read endpoints are stateless proxies.
"""
from __future__ import annotations

import json

import httpx
import pytest
from fastapi import HTTPException

from app.routers import zotero


# --------------------------------------------------------------------------- #
# fakes
# --------------------------------------------------------------------------- #
class _FakeResp:
    def __init__(self, status_code: int = 200, json_data=None, text: str | None = None,
                 body: bytes = b""):
        self.status_code = status_code
        self._json = json_data if json_data is not None else []
        # Mimic httpx: .text is the decoded body string. Default to the
        # JSON-encoded body so `if r.text` guards (list_collections uses one)
        # see a truthy body, matching a real non-empty response.
        self.text = text if text is not None else json.dumps(self._json)
        self.headers: dict[str, str] = {}
        # For the streaming download path (download_attachment_bytes calls
        # r.aiter_bytes()); a default-empty body is fine for the read tests
        # which never iterate it.
        self._body = body

    def json(self):
        return self._json

    async def aiter_bytes(self):
        # Yield the body in one chunk. Real httpx yields many; one is enough
        # for the download-retry tests which assert byte-equality + call count.
        if self._body:
            yield self._body


class _FakeClient:
    """Stand-in for httpx.AsyncClient whose `.get()` yields a scripted
    sequence (one item per attempt). Shared class-level state so the fresh
    client instance created on each retry continues the same script.
    Records the `proxy` kwarg so the LAX_ZOTERO_PROXY wiring can be asserted."""

    script: list = []  # each item: a _FakeResp or a BaseException to raise
    calls: int = 0
    last_proxy: object = "UNSET"  # proxy= kwarg from the most recent construction

    def __init__(self, *args, **kwargs):
        _FakeClient.last_proxy = kwargs.get("proxy", "UNSET")

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return False

    async def get(self, url, headers=None):
        idx = _FakeClient.calls
        _FakeClient.calls += 1
        item = _FakeClient.script[idx]
        if isinstance(item, BaseException):
            raise item
        return item

    async def post(self, url, *args, **kwargs):
        # Writes (.post) reuse the same script as reads (.get) — the proxy
        # wiring under test is in the AsyncClient construction, identical for
        # both, so a get-shaped fake suffices for write-path assertions.
        return await self.get(url, headers=kwargs.get("headers"))


def _script(monkeypatch, items):
    """Install a scripted fake httpx.AsyncClient + zero retry backoff."""
    _FakeClient.script = list(items)
    _FakeClient.calls = 0
    monkeypatch.setattr(zotero.httpx, "AsyncClient", _FakeClient)
    monkeypatch.setattr(zotero, "_RETRY_BACKOFF_S", 0)


# --------------------------------------------------------------------------- #
# _zotero_get: retry policy
# --------------------------------------------------------------------------- #
async def test_get_retries_transient_then_succeeds(monkeypatch):
    _script(monkeypatch, [httpx.ConnectError("boom"), _FakeResp(200, json_data=[])])
    r = await zotero._zotero_get("http://x", headers={}, timeout=zotero._TIMEOUT, trust_env=True)
    assert r.status_code == 200
    assert _FakeClient.calls == 2  # initial blip + retry


async def test_get_retries_timeout_then_succeeds(monkeypatch):
    # A ReadTimeout on a Zotero qmode=everything search is a cold-cache slow
    # query, NOT a dead upstream — measured: first call ~10s on a 526-item
    # library, immediate retry hits warm cache in ~0.5s. So we retry once;
    # the retry almost always succeeds fast.
    _script(monkeypatch, [httpx.ReadTimeout("read timed out"), _FakeResp(200, json_data=[])])
    r = await zotero._zotero_get("http://x", headers={}, timeout=zotero._TIMEOUT, trust_env=True)
    assert r.status_code == 200
    assert _FakeClient.calls == 2  # timed out, retried, succeeded


async def test_get_persistent_timeout_raises(monkeypatch):
    # If BOTH attempts time out, surface the ReadTimeout (don't loop forever).
    _script(monkeypatch, [httpx.ReadTimeout("read timed out"), httpx.ReadTimeout("read timed out")])
    with pytest.raises(httpx.ReadTimeout):
        await zotero._zotero_get("http://x", headers={}, timeout=zotero._TIMEOUT, trust_env=True)
    assert _FakeClient.calls == 2  # tried, retried once, gave up


async def test_get_retries_5xx_then_succeeds(monkeypatch):
    _script(monkeypatch, [_FakeResp(503), _FakeResp(200, json_data=[])])
    r = await zotero._zotero_get("http://x", headers={}, timeout=zotero._TIMEOUT, trust_env=True)
    assert r.status_code == 200
    assert _FakeClient.calls == 2


async def test_get_retries_429_then_succeeds(monkeypatch):
    _script(monkeypatch, [_FakeResp(429), _FakeResp(200, json_data=[])])
    r = await zotero._zotero_get("http://x", headers={}, timeout=zotero._TIMEOUT, trust_env=True)
    assert r.status_code == 200
    assert _FakeClient.calls == 2


async def test_get_returns_4xx_without_retry(monkeypatch):
    # 4xx (other than 429) is a real client error — surface it, don't retry.
    _script(monkeypatch, [_FakeResp(403)])
    r = await zotero._zotero_get("http://x", headers={}, timeout=zotero._TIMEOUT, trust_env=True)
    assert r.status_code == 403
    assert _FakeClient.calls == 1


async def test_get_persistent_failure_raises(monkeypatch):
    _script(monkeypatch, [httpx.ConnectError("boom"), httpx.ConnectError("boom")])
    with pytest.raises(httpx.ConnectError):
        await zotero._zotero_get("http://x", headers={}, timeout=zotero._TIMEOUT, trust_env=True)
    assert _FakeClient.calls == 2  # tried, retried once, gave up


# --------------------------------------------------------------------------- #
# list_items / list_collections: end-to-end through the route function
# --------------------------------------------------------------------------- #
async def test_list_items_empty_message_error_is_descriptive(monkeypatch):
    # The blank-message ConnectError that produced the user's empty
    # "zotero request error: " must surface a non-empty, type-named detail.
    _script(monkeypatch, [httpx.ConnectError(""), httpx.ConnectError("")])
    with pytest.raises(HTTPException) as ei:
        await zotero.list_items(
            mode="web", user_id="u", api_key="k", q="2401.07041",
            qmode="everything", limit=25, start=0, collection_key="",
        )
    assert ei.value.status_code == 502
    detail = ei.value.detail
    assert isinstance(detail, str) and detail.strip()  # never blank
    assert "ConnectError" in detail  # type-name fallback filled the empty str()


async def test_list_items_retries_then_returns_results(monkeypatch):
    payload = [{"key": "ABCD1234", "data": {"title": "A Paper", "itemType": "journalArticle"}}]
    _script(monkeypatch, [httpx.ConnectError("blip"), _FakeResp(200, json_data=payload)])
    resp = await zotero.list_items(
        mode="web", user_id="u", api_key="k", q="A Paper",
        qmode="everything", limit=25, start=0, collection_key="",
    )
    assert resp.status_code == 200
    body = json.loads(resp.body)
    assert body["mode"] == "web"
    assert len(body["results"]) == 1
    assert body["results"][0]["title"] == "A Paper"
    assert _FakeClient.calls == 2  # retried once after the blip


async def test_list_collections_retries_then_returns_results(monkeypatch):
    payload = [{"key": "COLL1", "data": {"name": "My Collection"}, "meta": {"numItems": 3}}]
    _script(monkeypatch, [httpx.ConnectError("blip"), _FakeResp(200, json_data=payload)])
    resp = await zotero.list_collections(mode="web", user_id="u", api_key="k")
    assert resp.status_code == 200
    body = json.loads(resp.body)
    assert body["mode"] == "web"
    assert len(body["results"]) == 1
    assert body["results"][0]["name"] == "My Collection"
    assert _FakeClient.calls == 2  # retried once after the blip


# --------------------------------------------------------------------------- #
# status: the connectivity probe (was a bare httpx.AsyncClient with NO retry
# and a blank "web-unreachable: " when str(exc) was empty — the symptom the
# Docker user saw). Now routes through _zotero_get for retry + type-name fallback.
# --------------------------------------------------------------------------- #
async def test_status_web_retries_timeout_then_ok(monkeypatch):
    # The exact symptom: a transient ReadTimeout on the status probe. Retry
    # once → success, instead of immediately reporting "unreachable".
    _script(monkeypatch, [httpx.ReadTimeout("read timed out"), _FakeResp(200, json_data=[])])
    resp = await zotero.status(mode="web", user_id="u", api_key="k")
    assert resp.status_code == 200
    body = json.loads(resp.body)
    assert body["ok"] is True
    assert body["mode"] == "web"
    assert _FakeClient.calls == 2  # timed out, retried, succeeded


async def test_status_web_persistent_blip_is_descriptive(monkeypatch):
    # Blank-message ConnectError ("") — the empty str() that produced the
    # user's "web-unreachable: " (trailing blank). Must surface the type name
    # so the error is never blank, and report ok:False only after the retry.
    _script(monkeypatch, [httpx.ConnectError(""), httpx.ConnectError("")])
    resp = await zotero.status(mode="web", user_id="u", api_key="k")
    assert resp.status_code == 200
    body = json.loads(resp.body)
    assert body["ok"] is False
    assert body["mode"] == "web"
    err = body["error"]
    assert isinstance(err, str) and err.strip()  # never blank
    assert "web-unreachable" in err
    assert "ConnectError" in err  # type-name fallback filled the empty str()
    assert _FakeClient.calls == 2  # tried, retried once, gave up


# --------------------------------------------------------------------------- #
# LAX_ZOTERO_PROXY: route only Zotero WEB calls through a proxy (the Docker
# container-bypasses-host-Clash fix). Local calls (loopback) must never proxy.
# --------------------------------------------------------------------------- #
async def test_status_web_forwards_proxy_when_set(monkeypatch):
    # When LAX_ZOTERO_PROXY is set, web-mode status passes proxy= to the client
    # so the request can route through (e.g.) host.docker.internal:7890.
    _script(monkeypatch, [_FakeResp(200, json_data=[])])
    monkeypatch.setattr(zotero, "_ZOTERO_PROXY", "http://host.docker.internal:7890")
    resp = await zotero.status(mode="web", user_id="u", api_key="k")
    assert resp.status_code == 200
    assert _FakeClient.last_proxy == "http://host.docker.internal:7890"


async def test_status_web_no_proxy_when_unset(monkeypatch):
    # Backward compat: empty/unset LAX_ZOTERO_PROXY = proxy=None, direct.
    _script(monkeypatch, [_FakeResp(200, json_data=[])])
    monkeypatch.setattr(zotero, "_ZOTERO_PROXY", None)
    resp = await zotero.status(mode="web", user_id="u", api_key="k")
    assert resp.status_code == 200
    assert _FakeClient.last_proxy is None


async def test_status_local_never_proxies_even_if_set(monkeypatch):
    # Local mode hits the loopback (127.0.0.1:23119) — must NEVER be proxied,
    # even when LAX_ZOTERO_PROXY is set, or the loopback call gets misrouted.
    _script(monkeypatch, [_FakeResp(200, json_data=[])])
    monkeypatch.setattr(zotero, "_ZOTERO_PROXY", "http://host.docker.internal:7890")
    resp = await zotero.status(mode="local", user_id="", api_key="")
    assert resp.status_code == 200
    assert _FakeClient.last_proxy is None  # local = trust_env=False = no proxy


async def test_create_collection_web_forwards_proxy(monkeypatch):
    # A web WRITE (bare AsyncClient, not _zotero_get) must also route through
    # the proxy — writes hit api.zotero.org too and would otherwise stall the
    # same way reads do.
    _script(monkeypatch, [
        _FakeResp(200, json_data={"success": {"0": "KEY1"}}),
        _FakeResp(200, json_data={"success": {"0": "KEY1"}}),  # not reached
    ])
    monkeypatch.setattr(zotero, "_ZOTERO_PROXY", "http://host.docker.internal:7890")
    from app.routers.zotero import CreateCollectionRequest
    resp = await zotero.create_collection(
        CreateCollectionRequest(mode="web", user_id="u", api_key="k", name="X"))
    assert resp.status_code == 200
    assert _FakeClient.last_proxy == "http://host.docker.internal:7890"


# --------------------------------------------------------------------------- #
# download_attachment_bytes: retry policy. The PDF download is the ONLY Zotero
# read that doesn't go through _zotero_get (it streams the S3-redirected body),
# so its retry is implemented inline. The user's Docker symptom — stuck on
# "Importing…" then 502 ReadTimeout — was a transient S3 stall with no retry.
# --------------------------------------------------------------------------- #
PDF = b"%PDF-1.4 fake zotero pdf bytes %%EOF"


def _download_creds():
    return {"mode": "web", "userId": "u", "apiKey": "k"}


async def test_download_retries_timeout_then_succeeds(monkeypatch):
    # The exact symptom: a ReadTimeout on the S3 download leg. A single retry
    # recovers (the stall is transient), instead of the old hard 502 after 90s.
    _script(monkeypatch, [
        httpx.ReadTimeout("read timed out"),
        _FakeResp(200, body=PDF),
    ])
    data = await zotero.download_attachment_bytes(_download_creds(), "att1")
    assert data == PDF
    assert _FakeClient.calls == 2  # timed out, retried, succeeded


async def test_download_retries_connect_error_then_succeeds(monkeypatch):
    # A mid-flight RST (terse ConnectError with empty message, per the GFW
    # symptom recorded for this user's container) must also retry once.
    _script(monkeypatch, [httpx.ConnectError(""), _FakeResp(200, body=PDF)])
    data = await zotero.download_attachment_bytes(_download_creds(), "att1")
    assert data == PDF
    assert _FakeClient.calls == 2


async def test_download_persistent_timeout_raises_502(monkeypatch):
    # If BOTH attempts stall, surface a 502 with a non-blank detail (the
    # user's old "zotero download error: ReadTimeout" must stay non-blank).
    # str(ReadTimeout("read timed out")) is "read timed out" (non-empty), so
    # the detail carries the message verbatim — the type-name fallback only
    # kicks in for the blank-message variant (asserted in the connect-error
    # test below).
    _script(monkeypatch, [
        httpx.ReadTimeout("read timed out"),
        httpx.ReadTimeout("read timed out"),
    ])
    with pytest.raises(HTTPException) as ei:
        await zotero.download_attachment_bytes(_download_creds(), "att1")
    assert ei.value.status_code == 502
    assert isinstance(ei.value.detail, str) and ei.value.detail.strip()  # never blank
    assert "read timed out" in ei.value.detail  # message verbatim
    assert _FakeClient.calls == 2  # tried, retried once, gave up


async def test_download_persistent_blip_detail_nonblank(monkeypatch):
    # The blank-message ConnectError ("") that produced the user's empty
    # "zotero download error: " (trailing blank) must surface the type name so
    # the error is never blank, even when both attempts carry an empty str().
    _script(monkeypatch, [httpx.ConnectError(""), httpx.ConnectError("")])
    with pytest.raises(HTTPException) as ei:
        await zotero.download_attachment_bytes(_download_creds(), "att1")
    assert ei.value.status_code == 502
    assert isinstance(ei.value.detail, str) and ei.value.detail.strip()  # never blank
    assert "ConnectError" in ei.value.detail  # type-name fallback filled the empty str()
    assert _FakeClient.calls == 2


async def test_download_404_not_retried(monkeypatch):
    # A 404 from the file endpoint is a PERMANENT failure (the attachment isn't
    # synced to Zotero's cloud — fileSize=0 imported_file, observed for many of
    # this user's recent items). It must surface fast, NOT burn a retry attempt.
    _script(monkeypatch, [_FakeResp(404, text="Not found")])
    with pytest.raises(HTTPException) as ei:
        await zotero.download_attachment_bytes(_download_creds(), "att1")
    assert ei.value.status_code == 502
    assert "404" in ei.value.detail
    assert _FakeClient.calls == 1  # no retry on a permanent 4xx


