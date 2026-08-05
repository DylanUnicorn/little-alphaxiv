"""Regression coverage for OpenAI Responses API provider support."""
from __future__ import annotations

import json

import httpx
import pytest

from app.routers import llm


class _StreamResponse:
    status_code = 200

    def __init__(self, chunks):
        self._chunks = chunks

    async def aiter_raw(self):
        for item in self._chunks:
            if isinstance(item, BaseException):
                raise item
            yield item


class _StreamContext:
    def __init__(self, item):
        self._item = item

    async def __aenter__(self):
        if isinstance(self._item, BaseException):
            raise self._item
        return self._item

    async def __aexit__(self, *args):
        return False


class _ScriptedStreamClient:
    script = []
    calls = 0

    def __init__(self, **_kwargs):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return False

    def stream(self, *_args, **_kwargs):
        item = self.script[self.calls]
        self.__class__.calls += 1
        return _StreamContext(item)


def _script_streams(monkeypatch, items):
    _ScriptedStreamClient.script = list(items)
    _ScriptedStreamClient.calls = 0
    monkeypatch.setattr(llm.httpx, "AsyncClient", _ScriptedStreamClient)
    monkeypatch.setattr(llm, "_STREAM_RETRY_BACKOFF_S", 0, raising=False)


async def _register_and_add_provider(client, *, api_format: str | None = None) -> dict:
    registered = await client.post(
        "/api/auth/register",
        json={"username": "responses_user", "password": "correct-horse-battery-staple", "email": "responses@example.com"},
    )
    assert registered.status_code == 201
    body = {
        "id": "responses-provider",
        "name": "Responses gateway",
        "base_url": "https://gateway.example/v1",
        "api_key": "secret-key",
        "model": "gpt-4.1-mini",
        "is_default": True,
    }
    if api_format is not None:
        body["api_format"] = api_format
    response = await client.post("/api/providers", json=body)
    assert response.status_code == 201
    return response.json()


@pytest.mark.asyncio
async def test_provider_api_format_defaults_to_chat_and_persists_responses(client):
    provider = await _register_and_add_provider(client, api_format="responses")
    assert provider["api_format"] == "responses"

    listed = await client.get("/api/providers")
    assert listed.status_code == 200
    assert listed.json()[0]["api_format"] == "responses"


@pytest.mark.asyncio
async def test_proxy_uses_responses_endpoint_and_returns_chat_shape(client, monkeypatch):
    await _register_and_add_provider(client, api_format="responses")
    calls: dict[str, object] = {}

    class UpstreamResponse:
        status_code = 200

        def json(self):
            return {
                "id": "resp_123",
                "model": "gpt-4.1-mini",
                "output": [{
                    "type": "message",
                    "content": [{"type": "output_text", "text": "Hello from Responses."}],
                }],
            }

    class UpstreamClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return None

        async def post(self, target, *, headers, json):
            calls.update(target=target, headers=headers, payload=json)
            return UpstreamResponse()

    monkeypatch.setattr(llm.httpx, "AsyncClient", lambda **_kwargs: UpstreamClient())
    response = await client.post("/api/llm", json={
        "provider_id": "responses-provider",
        "payload": {"model": "gpt-4.1-mini", "stream": False, "messages": [{"role": "user", "content": "Hello"}]},
    })

    assert response.status_code == 200
    assert calls["target"] == "https://gateway.example/v1/responses"
    assert calls["payload"] == {
        "model": "gpt-4.1-mini",
        "stream": False,
        "input": [{"role": "user", "content": [{"type": "input_text", "text": "Hello"}]}],
    }
    assert response.json()["choices"][0]["message"]["content"] == "Hello from Responses."


def test_responses_payload_converts_messages_and_function_tools():
    assert llm._resolve_target("https://gateway.example/v1/", "responses") == "https://gateway.example/v1/responses"
    payload = {
        "model": "gpt-4.1-mini",
        "stream": True,
        "stream_options": {"include_usage": True},
        "messages": [
            {"role": "system", "content": "Be concise."},
            {"role": "user", "content": [{"type": "text", "text": "Find papers"}]},
            {
                "role": "assistant",
                "content": None,
                "tool_calls": [{
                    "id": "call_123",
                    "type": "function",
                    "function": {"name": "search_arxiv", "arguments": '{"query":"LLMs"}'},
                }],
            },
            {"role": "tool", "tool_call_id": "call_123", "name": "search_arxiv", "content": "[]"},
        ],
        "tools": [{
            "type": "function",
            "function": {
                "name": "search_arxiv",
                "description": "Search arXiv",
                "parameters": {"type": "object", "properties": {}},
            },
        }],
        "tool_choice": "auto",
    }

    converted = llm._to_responses_payload(payload)

    assert converted == {
        "model": "gpt-4.1-mini",
        "stream": True,
        "input": [
            {"role": "developer", "content": [{"type": "input_text", "text": "Be concise."}]},
            {"role": "user", "content": [{"type": "input_text", "text": "Find papers"}]},
            {"type": "function_call", "call_id": "call_123", "name": "search_arxiv", "arguments": '{"query":"LLMs"}'},
            {"type": "function_call_output", "call_id": "call_123", "output": "[]"},
        ],
        "tools": [{
            "type": "function",
            "name": "search_arxiv",
            "description": "Search arXiv",
            "parameters": {"type": "object", "properties": {}},
        }],
        "tool_choice": "auto",
    }


def test_responses_result_converts_text_usage_and_function_calls():
    result = llm._responses_to_chat_completion({
        "id": "resp_123",
        "model": "gpt-4.1-mini",
        "usage": {"input_tokens": 12, "output_tokens": 7, "total_tokens": 19},
        "output": [
            {"type": "message", "content": [{"type": "output_text", "text": "Here is a paper."}]},
            {"type": "function_call", "call_id": "call_456", "name": "search_arxiv", "arguments": '{"query":"RAG"}'},
        ],
    })

    assert result["choices"][0]["message"] == {
        "role": "assistant",
        "content": "Here is a paper.",
        "tool_calls": [{
            "id": "call_456",
            "type": "function",
            "function": {"name": "search_arxiv", "arguments": '{"query":"RAG"}'},
        }],
    }
    assert result["usage"] == {"prompt_tokens": 12, "completion_tokens": 7, "total_tokens": 19}


@pytest.mark.asyncio
async def test_responses_stream_converts_text_tool_and_completion_events():
    async def events():
        yield {"type": "response.output_text.delta", "delta": "Hello"}
        yield {"type": "response.function_call_arguments.delta", "item_id": "fc_1", "delta": '{"query"'}
        yield {"type": "response.output_item.done", "item": {"id": "fc_1", "type": "function_call", "call_id": "call_1", "name": "search_arxiv", "arguments": '{"query":"LLM"}'}}
        yield {"type": "response.completed", "response": {"usage": {"input_tokens": 10, "output_tokens": 4, "total_tokens": 14}}}

    chunks = [chunk async for chunk in llm._responses_events_to_chat_sse(events())]
    payloads = [json.loads(chunk.removeprefix("data: ").strip()) for chunk in chunks[:-1]]

    assert payloads[0]["choices"][0]["delta"]["content"] == "Hello"
    assert payloads[1]["choices"][0]["delta"]["tool_calls"][0] == {
        "index": 0,
        "id": "fc_1",
        "type": "function",
        "function": {"arguments": '{"query"'},
    }
    assert payloads[2]["choices"][0]["delta"]["tool_calls"][0] == {
        "index": 0,
        "id": "call_1",
        "type": "function",
        "function": {"name": "search_arxiv"},
    }
    assert payloads[3]["usage"] == {"prompt_tokens": 10, "completion_tokens": 4, "total_tokens": 14}
    assert chunks[-1] == "data: [DONE]\n\n"


@pytest.mark.asyncio
async def test_stream_retries_request_error_before_first_upstream_byte(client, monkeypatch):
    await _register_and_add_provider(client, api_format="responses")
    completed = (
        b'data: {"type":"response.output_text.delta","delta":"Recovered"}\n\n'
        b'data: {"type":"response.completed","response":{}}\n\n'
    )
    _script_streams(monkeypatch, [httpx.ConnectError("TLS EOF"), _StreamResponse([completed])])

    response = await client.post("/api/llm", json={
        "provider_id": "responses-provider",
        "payload": {"model": "gpt-4.1-mini", "stream": True, "messages": [{"role": "user", "content": "Hello"}]},
    })

    assert response.status_code == 200
    assert _ScriptedStreamClient.calls == 2
    assert '"content": "Recovered"' in response.text
    assert "upstream stream error" not in response.text


@pytest.mark.asyncio
async def test_stream_persistent_blank_error_names_exception_type(client, monkeypatch):
    await _register_and_add_provider(client, api_format="responses")
    _script_streams(monkeypatch, [httpx.ConnectError(""), httpx.ConnectError("")])

    response = await client.post("/api/llm", json={
        "provider_id": "responses-provider",
        "payload": {"model": "gpt-4.1-mini", "stream": True, "messages": [{"role": "user", "content": "Hello"}]},
    })

    assert _ScriptedStreamClient.calls == 2
    assert "upstream stream error (ConnectError): ConnectError" in response.text


@pytest.mark.asyncio
async def test_stream_does_not_retry_after_first_upstream_byte(client, monkeypatch):
    await _register_and_add_provider(client)
    partial = b'data: {"choices":[{"delta":{"content":"Partial"},"finish_reason":null}]}\n\n'
    _script_streams(monkeypatch, [
        _StreamResponse([partial, httpx.ReadError("connection reset")]),
        _StreamResponse([b'data: [DONE]\n\n']),
    ])

    response = await client.post("/api/llm", json={
        "provider_id": "responses-provider",
        "payload": {"model": "gpt-4.1-mini", "stream": True, "messages": [{"role": "user", "content": "Hello"}]},
    })

    assert _ScriptedStreamClient.calls == 1
    assert "Partial" in response.text
    assert "upstream stream error (ReadError): connection reset" in response.text
