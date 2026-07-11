"""PDF proxy streaming + cache + range regression tests.

The cold-open path used to buffer the whole arXiv download in memory before
responding (frozen "Loading PDF…" spinner). It now streams bytes through to
the client chunk-by-chunk so pdf.js's onProgress fires (real download %),
while teeing to a .part file that is atomically renamed to the cache on
completion. The warm (cache-hit) path still serves byte ranges via
serve_pdf_bytes.

No real network: we swap `httpx.AsyncClient` for a fake whose `.send()`
returns a scripted streaming response. The pdf router is unauthenticated
(arXiv PDFs are public), so no login is needed to hit /api/pdf/{id}.
"""
from __future__ import annotations

import httpx
import pytest

from app.routers import pdf as pdf_mod


# --------------------------------------------------------------------------- #
# fakes
# --------------------------------------------------------------------------- #
class _FakeResp:
    """Stand-in for a streaming httpx.Response."""

    def __init__(self, status_code: int = 200, body: bytes = b"",
                 headers: dict[str, str] | None = None):
        self.status_code = status_code
        self._body = body
        self.headers = headers or {}
        self.closed = False

    async def aiter_bytes(self):
        # Yield in small chunks so the tee + atomic-rename path is exercised
        # across multiple iterations (not a single-shot body).
        for i in range(0, len(self._body), 7):
            yield self._body[i:i + 7]

    async def aclose(self):
        self.closed = True

    async def aread(self):
        return self._body


class _FakeClient:
    """Stand-in for httpx.AsyncClient. Class-level script so the instance
    constructed inside the handler sees the staged response/error."""

    next_resp: _FakeResp | None = None
    send_raises: BaseException | None = None
    constructed: int = 0

    def __init__(self, *args, **kwargs):
        _FakeClient.constructed += 1

    def build_request(self, method: str, url: str, headers=None):
        return {"method": method, "url": url, "headers": headers}

    async def send(self, request, stream: bool = False):
        if _FakeClient.send_raises is not None:
            raise _FakeClient.send_raises
        assert _FakeClient.next_resp is not None, "no fake response staged"
        return _FakeClient.next_resp

    async def aclose(self):
        pass


@pytest.fixture
def fake_arxiv(monkeypatch, tmp_path):
    """Point the pdf cache at a temp dir + install the fake httpx client."""
    monkeypatch.setattr(pdf_mod, "_CACHE_DIR", tmp_path)
    monkeypatch.setattr(pdf_mod.httpx, "AsyncClient", _FakeClient)
    _FakeClient.next_resp = None
    _FakeClient.send_raises = None
    _FakeClient.constructed = 0
    return tmp_path


# --------------------------------------------------------------------------- #
# cold cache miss: stream 200 + tee to cache
# --------------------------------------------------------------------------- #
PDF = b"%PDF-1.4 streaming cold-open fixture bytes %%EOF"


async def test_cold_miss_streams_body_and_caches(client, fake_arxiv):
    _FakeClient.next_resp = _FakeResp(
        200, PDF, headers={"content-length": str(len(PDF))}
    )
    r = await client.get("/api/pdf/1234.5678")
    assert r.status_code == 200
    assert r.content == PDF                      # client got the streamed bytes
    cache = fake_arxiv / "1234.5678.pdf"
    assert cache.exists()                         # tee populated the cache
    assert cache.read_bytes() == PDF
    # Content-Length is forwarded so pdf.js can show a real download %.
    assert r.headers.get("content-length") == str(len(PDF))
    # Accept-Ranges is NOT advertised on the streaming 200 — pdf.js uses
    # progressive full-body loading for this request; range kicks in on the
    # next (cache-hit) request via serve_pdf_bytes.
    assert "accept-ranges" not in {k.lower() for k in r.headers.keys()}
    # No .part litter left after a clean completion.
    assert not list(fake_arxiv.glob("*.part*"))
    assert _FakeClient.constructed == 1


async def test_cold_miss_unknown_length_streams_mb_progress(client, fake_arxiv):
    # Chunked arXiv response (no Content-Length) — pdf.js falls back to
    # bytes-loaded progress. Still streams + caches.
    _FakeClient.next_resp = _FakeResp(200, PDF, headers={})
    r = await client.get("/api/pdf/2345.6789")
    assert r.status_code == 200
    assert r.content == PDF
    assert (fake_arxiv / "2345.6789.pdf").read_bytes() == PDF
    assert "content-length" not in {k.lower() for k in r.headers.keys()}


# --------------------------------------------------------------------------- #
# warm cache hit: serve byte range (206)
# --------------------------------------------------------------------------- #
async def test_warm_hit_serves_range_206(client, fake_arxiv):
    (fake_arxiv / "1234.5678.pdf").write_bytes(PDF)
    # No fake response staged — the warm path must NOT touch arXiv.
    r = await client.get("/api/pdf/1234.5678", headers={"Range": "bytes=0-3"})
    assert r.status_code == 206
    assert r.content == PDF[0:4]
    assert r.headers["content-range"] == f"bytes 0-3/{len(PDF)}"
    assert r.headers["accept-ranges"] == "bytes"
    assert _FakeClient.constructed == 0           # served from disk, no upstream


async def test_warm_hit_no_range_serves_full_200(client, fake_arxiv):
    (fake_arxiv / "1234.5678.pdf").write_bytes(PDF)
    r = await client.get("/api/pdf/1234.5678")
    assert r.status_code == 200
    assert r.content == PDF
    assert r.headers["accept-ranges"] == "bytes"


# --------------------------------------------------------------------------- #
# error paths: 502 + no partial cache litter
# --------------------------------------------------------------------------- #
async def test_arxiv_non_200_returns_502_no_cache(client, fake_arxiv):
    _FakeClient.next_resp = _FakeResp(404, b"not found")
    r = await client.get("/api/pdf/9999.9999")
    assert r.status_code == 502
    assert "404" in r.json()["detail"]
    assert not (fake_arxiv / "9999.9999.pdf").exists()
    assert not list(fake_arxiv.glob("*.part*"))   # no litter on a clean 502


async def test_arxiv_request_error_returns_502(client, fake_arxiv):
    _FakeClient.send_raises = httpx.ConnectError("boom")
    r = await client.get("/api/pdf/1111.2222")
    assert r.status_code == 502
    assert "boom" in r.json()["detail"]
    assert not (fake_arxiv / "1111.2222.pdf").exists()


# --------------------------------------------------------------------------- #
# _commit_part: size-verified cache promotion (the post-download race fix)
# --------------------------------------------------------------------------- #
def test_commit_part_promotes_complete(tmp_path):
    # A .part whose size matches the declared length is atomically promoted.
    part = tmp_path / "x.pdf.part"
    cache = tmp_path / "x.pdf"
    part.write_bytes(PDF)
    pdf_mod._commit_part(part, cache, expected=len(PDF))
    assert cache.read_bytes() == PDF
    assert not part.exists()


def test_commit_part_drops_partial(tmp_path):
    # A truncated .part (mid-download cancellation) is dropped, never cached —
    # the next open must retry, not serve a truncated PDF.
    part = tmp_path / "x.pdf.part"
    cache = tmp_path / "x.pdf"
    part.write_bytes(PDF[:10])
    pdf_mod._commit_part(part, cache, expected=len(PDF))
    assert not cache.exists()
    assert not part.exists()


def test_commit_part_unknown_length_promotes(tmp_path):
    # No Content-Length (chunked upstream): can't size-check, so a completed
    # .part is promoted (the loop only reaches _commit_part after exhausting
    # aiter_bytes, so it's complete by construction).
    part = tmp_path / "x.pdf.part"
    cache = tmp_path / "x.pdf"
    part.write_bytes(PDF)
    pdf_mod._commit_part(part, cache, expected=None)
    assert cache.read_bytes() == PDF
    assert not part.exists()
