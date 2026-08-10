from __future__ import annotations

import httpx
import pytest

from app.routers import search


ATOM_OK = b"""<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"
      xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">
  <opensearch:totalResults>1</opensearch:totalResults>
  <entry>
    <id>http://arxiv.org/abs/2103.00020v1</id>
    <title>Learning Transferable Visual Models</title>
    <summary>CLIP abstract</summary>
    <published>2021-02-26T00:00:00Z</published>
    <updated>2021-02-26T00:00:00Z</updated>
    <author><name>Alec Radford</name></author>
  </entry>
</feed>
"""


class FakeAsyncClient:
    responses: list[httpx.Response | Exception] = []
    calls = 0

    def __init__(self, *args, **kwargs):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        return False

    async def get(self, url: str, **kwargs) -> httpx.Response:
        type(self).calls += 1
        item = type(self).responses.pop(0)
        if isinstance(item, Exception):
            raise item
        return item


def response(status: int, body: bytes | str, *, retry_after: str | None = None) -> httpx.Response:
    headers = {"Retry-After": retry_after} if retry_after else None
    return httpx.Response(status, content=body, headers=headers)


@pytest.fixture(autouse=True)
def fake_arxiv_client(monkeypatch):
    FakeAsyncClient.responses = []
    FakeAsyncClient.calls = 0
    monkeypatch.setattr(search.httpx, "AsyncClient", FakeAsyncClient)
    # Focus these endpoint tests on retry semantics without a real three-second wait.
    monkeypatch.setattr(search, "_ARXIV_MIN_INTERVAL_SECONDS", 0.0, raising=False)


@pytest.mark.asyncio
async def test_search_retries_rate_limit_then_returns_results(client):
    FakeAsyncClient.responses = [
        response(429, "Rate exceeded.", retry_after="0"),
        response(200, ATOM_OK),
    ]

    result = await client.get("/api/search", params={"q": "CLIP", "max_results": 3})

    assert result.status_code == 200
    assert FakeAsyncClient.calls == 2
    assert result.json()["results"][0]["arxiv_id"] == "2103.00020v1"


@pytest.mark.asyncio
async def test_search_preserves_persistent_arxiv_rate_limit(client):
    FakeAsyncClient.responses = [
        response(429, "Rate exceeded.", retry_after="0"),
        response(429, "Rate exceeded.", retry_after="7"),
    ]

    result = await client.get("/api/search", params={"q": "CLIP"})

    assert result.status_code == 429
    assert result.headers["retry-after"] == "7"
    assert FakeAsyncClient.calls == 2
    assert "rate limit" in result.json()["detail"].lower()
