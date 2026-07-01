"""Tests for the anysearch web-search proxy.

Covers the pure markdown parser + JSON-RPC extractor (no network), the
``_post_jsonrpc`` HTTP layer with an ``httpx.MockTransport``, and the
``/api/websearch`` endpoint's three branches (not-configured, success,
upstream-error / JSON-RPC error) with ``_post_jsonrpc`` monkeypatched so no
real anysearch call is made.
"""
from __future__ import annotations

import json

import httpx
import pytest

from app.routers import websearch

# Real-shaped anysearch `search` tool output (two results, trimmed).
_SAMPLE_MD = (
    "## Search Results (2 results, 3082ms)\n\n"
    "### 1. A Survey of Routing Protocols for Underwater Wireless Sensor ...\n"
    "- **URL**: https://ieeexplore.ieee.org/document/9312119/\n"
    "- This article presents a review of underwater routing protocols for UWSNs. "
    "We classify the existing underwater routing protocols into three categories.\n\n"
    "### 2. A Survey on Underwater Wireless Sensor Networks - PMC - NIH\n"
    "- **URL**: https://pmc.ncbi.nlm.nih.gov/articles/PMC7570626/\n"
    "- Checking your browser before accessing pmc.ncbi.nlm.nih.gov.\n"
)

_SAMPLE_RPC = {
    "jsonrpc": "2.0",
    "id": 1,
    "result": {"content": [{"type": "text", "text": _SAMPLE_MD}]},
}


# --------------------------------------------------------------------------- #
# parse_anysearch_markdown (pure)
# --------------------------------------------------------------------------- #
def test_parse_empty_returns_empty():
    assert websearch.parse_anysearch_markdown("") == []
    assert websearch.parse_anysearch_markdown("   \n  ") == []


def test_parse_extracts_title_url_snippet():
    results = websearch.parse_anysearch_markdown(_SAMPLE_MD)
    assert len(results) == 2
    assert results[0]["rank"] == 1
    assert "Routing Protocols" in results[0]["title"]
    assert results[0]["url"] == "https://ieeexplore.ieee.org/document/9312119/"
    assert "underwater routing protocols" in results[0]["snippet"]
    assert results[1]["rank"] == 2
    assert results[1]["url"] == "https://pmc.ncbi.nlm.nih.gov/articles/PMC7570626/"
    assert "PMC" in results[1]["title"]


def test_parse_unexpected_format_falls_back_to_raw_text():
    # An error string or changed rendering: don't return [] (silent), surface it.
    md = "anysearch: internal error, please retry"
    results = websearch.parse_anysearch_markdown(md)
    assert len(results) == 1
    assert results[0]["url"] == ""
    assert "internal error" in results[0]["snippet"]


def test_parse_handles_url_without_bold_markers():
    md = (
        "### 1. Some Title\n"
        "URL: https://example.org/x\n"
        "- snippet line\n"
    )
    results = websearch.parse_anysearch_markdown(md)
    assert results[0]["url"] == "https://example.org/x"
    assert results[0]["snippet"] == "snippet line"


# --------------------------------------------------------------------------- #
# _extract_markdown (pure)
# --------------------------------------------------------------------------- #
def test_extract_markdown_returns_text():
    assert websearch._extract_markdown(_SAMPLE_RPC) == _SAMPLE_MD


def test_extract_markdown_empty_when_no_text_content():
    assert websearch._extract_markdown({}) == ""
    assert websearch._extract_markdown({"result": {}}) == ""
    assert websearch._extract_markdown({"result": {"content": []}}) == ""
    assert websearch._extract_markdown({"result": {"content": [{"type": "image"}]}}) == ""


# --------------------------------------------------------------------------- #
# _post_jsonrpc (httpx.MockTransport — no real network)
# --------------------------------------------------------------------------- #
_PAYLOAD = {
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tools/call",
    "params": {"name": "search", "arguments": {"query": "x", "max_results": 8}},
}


def _mock_transport(handler):
    return httpx.MockTransport(handler)


async def test_post_jsonrpc_parses_json_response():
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.method == "POST"
        body = json.loads(request.content)
        assert body["method"] == "tools/call"
        assert body["params"]["name"] == "search"
        return httpx.Response(200, json=_SAMPLE_RPC, headers={"content-type": "application/json"})

    rpc = await websearch._post_jsonrpc(
        "https://example.test/mcp", {"Authorization": "Bearer k"}, _PAYLOAD, transport=_mock_transport(handler)
    )
    assert rpc == _SAMPLE_RPC


async def test_post_jsonrpc_parses_sse_response():
    sse_body = (
        "event: message\n"
        f"data: {json.dumps(_SAMPLE_RPC)}\n\n"
    )

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200, content=sse_body, headers={"content-type": "text/event-stream"}
        )

    rpc = await websearch._post_jsonrpc(
        "https://example.test/mcp", {"Authorization": "Bearer k"}, _PAYLOAD, transport=_mock_transport(handler)
    )
    assert rpc == _SAMPLE_RPC


async def test_post_jsonrpc_raises_on_non_200():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500, text="boom")

    with pytest.raises(RuntimeError, match="status 500"):
        await websearch._post_jsonrpc(
            "https://example.test/mcp", {"Authorization": "Bearer k"}, _PAYLOAD, transport=_mock_transport(handler)
        )


async def test_post_jsonrpc_raises_on_bad_json():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, text="<<not json>>", headers={"content-type": "application/json"})

    with pytest.raises(RuntimeError, match="json error"):
        await websearch._post_jsonrpc(
            "https://example.test/mcp", {"Authorization": "Bearer k"}, _PAYLOAD, transport=_mock_transport(handler)
        )


# --------------------------------------------------------------------------- #
# /api/websearch endpoint (monkeypatch _post_jsonrpc — no real network)
# --------------------------------------------------------------------------- #
async def test_endpoint_anonymous_when_no_key(client, monkeypatch):
    """No user key, no env key → anonymous call (no Authorization header)."""
    monkeypatch.delenv("ANYSEARCH_API_KEY", raising=False)

    async def fake_post(url, headers, payload, transport=None):
        # Anonymous = no Authorization header sent to anysearch.
        assert "Authorization" not in headers
        return _SAMPLE_RPC

    monkeypatch.setattr(websearch, "_post_jsonrpc", fake_post)

    r = await client.get("/api/websearch", params={"q": "ieee paper", "max_results": 3})
    assert r.status_code == 200
    body = r.json()
    assert body["configured"] is True
    assert body["key_used"] == "anonymous"
    assert body["total"] == 2
    assert body["query"] == "ieee paper"


async def test_endpoint_user_key_param_preferred_over_env(client, monkeypatch):
    """Per-request user key wins over the env fallback."""
    monkeypatch.setenv("ANYSEARCH_API_KEY", "env-key")

    async def fake_post(url, headers, payload, transport=None):
        assert headers["Authorization"] == "Bearer user-key"  # param, not env
        return _SAMPLE_RPC

    monkeypatch.setattr(websearch, "_post_jsonrpc", fake_post)

    r = await client.get("/api/websearch", params={"q": "x", "api_key": "user-key"})
    body = r.json()
    assert body["configured"] is True
    assert body["key_used"] == "user"


async def test_endpoint_env_key_fallback(client, monkeypatch):
    """No user key param → env key is used."""
    monkeypatch.setenv("ANYSEARCH_API_KEY", "env-key")

    async def fake_post(url, headers, payload, transport=None):
        assert headers["Authorization"] == "Bearer env-key"
        return _SAMPLE_RPC

    monkeypatch.setattr(websearch, "_post_jsonrpc", fake_post)

    r = await client.get("/api/websearch", params={"q": "x"})
    body = r.json()
    assert body["configured"] is True
    assert body["key_used"] == "env"


async def test_endpoint_success_parses_results(client, monkeypatch):
    monkeypatch.setenv("ANYSEARCH_API_KEY", "test-key")

    async def fake_post(url, headers, payload, transport=None):
        assert url == "https://api.anysearch.com/mcp"
        assert headers["Authorization"] == "Bearer test-key"
        assert payload["params"]["arguments"]["query"] == "ieee paper"
        assert payload["params"]["arguments"]["max_results"] == 3
        return _SAMPLE_RPC

    monkeypatch.setattr(websearch, "_post_jsonrpc", fake_post)

    r = await client.get("/api/websearch", params={"q": "ieee paper", "max_results": 3})
    assert r.status_code == 200
    body = r.json()
    assert body["configured"] is True
    assert body["total"] == 2
    assert body["results"][0]["url"].startswith("https://ieeexplore.ieee.org/")


async def test_endpoint_upstream_error_returns_fallback(client, monkeypatch):
    monkeypatch.setenv("ANYSEARCH_API_KEY", "test-key")

    async def fake_post(url, headers, payload, transport=None):
        raise httpx.ConnectError("dns failure")

    monkeypatch.setattr(websearch, "_post_jsonrpc", fake_post)

    r = await client.get("/api/websearch", params={"q": "anything"})
    assert r.status_code == 200  # never throw — the LLM loop has no try/catch
    body = r.json()
    assert body["configured"] is True
    assert body["results"] == []
    assert "search_arxiv" in body["message"]  # nudges the model to fall back


async def test_endpoint_jsonrpc_error_returns_fallback(client, monkeypatch):
    monkeypatch.setenv("ANYSEARCH_API_KEY", "test-key")

    async def fake_post(url, headers, payload, transport=None):
        return {"jsonrpc": "2.0", "id": 1, "error": {"code": -32602, "message": "bad params"}}

    monkeypatch.setattr(websearch, "_post_jsonrpc", fake_post)

    r = await client.get("/api/websearch", params={"q": "anything"})
    assert r.status_code == 200
    body = r.json()
    assert body["configured"] is True
    assert body["results"] == []
    assert "bad params" in body["message"]
