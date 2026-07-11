"""LLM proxy for OpenAI-compatible Chat Completions and Responses endpoints.

Auth-aware: the body now carries only {provider_id, payload}. The provider's
base_url + (decrypted) api_key come from the authenticated user's stored
ProviderRow, so the plaintext key never crosses the wire from the browser. We
forward the payload verbatim for Chat Completions. Responses providers are
adapted at this boundary so the browser can keep its one Chat Completions-based
conversation and tool-calling protocol.
"""
from __future__ import annotations

import json
from typing import Any, AsyncIterable, AsyncIterator

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse, JSONResponse
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from .. import security
from ..db import get_session
from ..deps import current_user
from ..models import ProviderRow, User

router = APIRouter()

# OpenAI-compatible chat completions path appended to the provider's base_url.
_CHAT_PATH = "/chat/completions"
_RESPONSES_PATH = "/responses"
# Keep the upstream connection alive across long streaming turns.
_TIMEOUT = httpx.Timeout(connect=15.0, read=300.0, write=60.0, pool=15.0)


def _resolve_target(base_url: str, api_format: str = "chat_completions") -> str:
    base = base_url.strip().rstrip("/")
    if not base:
        raise HTTPException(status_code=400, detail="base_url is required")
    return base + (_RESPONSES_PATH if api_format == "responses" else _CHAT_PATH)


def _as_text(value: Any) -> str:
    return value if isinstance(value, str) else ""


def _to_responses_content(content: Any, role: str) -> list[dict[str, Any]]:
    """Translate Chat Completions text/image content to Responses content."""
    content_type = "output_text" if role == "assistant" else "input_text"
    if isinstance(content, str):
        return [{"type": content_type, "text": content}]
    if not isinstance(content, list):
        return []

    converted: list[dict[str, Any]] = []
    for part in content:
        if not isinstance(part, dict):
            continue
        if part.get("type") == "text" and isinstance(part.get("text"), str):
            converted.append({"type": content_type, "text": part["text"]})
        elif part.get("type") == "image_url":
            image = part.get("image_url")
            url = image.get("url") if isinstance(image, dict) else None
            if isinstance(url, str):
                converted.append({"type": "input_image", "image_url": url})
    return converted


def _to_responses_payload(payload: dict[str, Any]) -> dict[str, Any]:
    """Convert the app's Chat Completions-shaped payload for /v1/responses."""
    converted: dict[str, Any] = {
        "model": payload.get("model"),
        "stream": bool(payload.get("stream")),
        "input": [],
    }
    for message in payload.get("messages", []):
        if not isinstance(message, dict):
            continue
        role = _as_text(message.get("role"))
        if role == "tool":
            call_id = _as_text(message.get("tool_call_id"))
            if call_id:
                converted["input"].append({
                    "type": "function_call_output",
                    "call_id": call_id,
                    "output": _as_text(message.get("content")),
                })
            continue
        if role == "assistant":
            content = _to_responses_content(message.get("content"), role)
            if content:
                converted["input"].append({"role": "assistant", "content": content})
            for call in message.get("tool_calls", []):
                if not isinstance(call, dict) or call.get("type") != "function":
                    continue
                function = call.get("function")
                if not isinstance(function, dict):
                    continue
                call_id = _as_text(call.get("id"))
                name = _as_text(function.get("name"))
                if call_id and name:
                    converted["input"].append({
                        "type": "function_call",
                        "call_id": call_id,
                        "name": name,
                        "arguments": _as_text(function.get("arguments")),
                    })
            continue
        if role in {"system", "developer", "user"}:
            converted_role = "developer" if role == "system" else role
            content = _to_responses_content(message.get("content"), converted_role)
            if content:
                converted["input"].append({"role": converted_role, "content": content})

    tools: list[dict[str, Any]] = []
    for tool in payload.get("tools", []):
        if not isinstance(tool, dict) or tool.get("type") != "function":
            continue
        function = tool.get("function")
        if not isinstance(function, dict) or not isinstance(function.get("name"), str):
            continue
        converted_tool = {"type": "function", "name": function["name"]}
        for key in ("description", "parameters", "strict"):
            if key in function:
                converted_tool[key] = function[key]
        tools.append(converted_tool)
    if tools:
        converted["tools"] = tools
        converted["tool_choice"] = payload.get("tool_choice", "auto")
    return converted


def _responses_usage(response: dict[str, Any]) -> dict[str, int] | None:
    usage = response.get("usage")
    if not isinstance(usage, dict):
        return None
    prompt = int(usage.get("input_tokens") or 0)
    completion = int(usage.get("output_tokens") or 0)
    total = int(usage.get("total_tokens") or prompt + completion)
    return {"prompt_tokens": prompt, "completion_tokens": completion, "total_tokens": total}


def _responses_to_chat_completion(response: dict[str, Any]) -> dict[str, Any]:
    """Translate a non-streaming Responses result to the existing client shape."""
    text: list[str] = []
    tool_calls: list[dict[str, Any]] = []
    for item in response.get("output", []):
        if not isinstance(item, dict):
            continue
        if item.get("type") == "message":
            for content in item.get("content", []):
                if isinstance(content, dict) and content.get("type") == "output_text":
                    text.append(_as_text(content.get("text")))
        elif item.get("type") == "function_call":
            call_id = _as_text(item.get("call_id"))
            name = _as_text(item.get("name"))
            if call_id and name:
                tool_calls.append({
                    "id": call_id,
                    "type": "function",
                    "function": {"name": name, "arguments": _as_text(item.get("arguments"))},
                })
    message: dict[str, Any] = {"role": "assistant", "content": "".join(text)}
    if tool_calls:
        message["tool_calls"] = tool_calls
    result: dict[str, Any] = {
        "id": response.get("id"),
        "object": "chat.completion",
        "model": response.get("model"),
        "choices": [{"index": 0, "message": message, "finish_reason": "tool_calls" if tool_calls else "stop"}],
    }
    if usage := _responses_usage(response):
        result["usage"] = usage
    return result


def _chat_sse(delta: dict[str, Any], *, finish_reason: str | None = None, usage: dict[str, int] | None = None) -> str:
    choice: dict[str, Any] = {"index": 0, "delta": delta, "finish_reason": finish_reason}
    body: dict[str, Any] = {"choices": [choice]}
    if usage:
        body["usage"] = usage
    return f"data: {json.dumps(body)}\n\n"


async def _responses_events_to_chat_sse(events: AsyncIterable[dict[str, Any]]) -> AsyncIterator[str]:
    """Turn Responses SSE events into the Chat Completions SSE dialect we expose."""
    item_indexes: dict[str, int] = {}
    next_index = 0
    async for event in events:
        event_type = event.get("type")
        if event_type == "response.output_text.delta":
            yield _chat_sse({"content": _as_text(event.get("delta"))})
        elif event_type == "response.reasoning_summary_text.delta":
            yield _chat_sse({"reasoning_content": _as_text(event.get("delta"))})
        elif event_type == "response.function_call_arguments.delta":
            item_id = _as_text(event.get("item_id"))
            if item_id not in item_indexes:
                item_indexes[item_id] = next_index
                next_index += 1
            yield _chat_sse({"tool_calls": [{
                "index": item_indexes[item_id],
                "id": item_id,
                "type": "function",
                "function": {"arguments": _as_text(event.get("delta"))},
            }]})
        elif event_type == "response.output_item.done":
            item = event.get("item")
            if isinstance(item, dict) and item.get("type") == "function_call":
                item_id = _as_text(item.get("id"))
                if item_id not in item_indexes:
                    item_indexes[item_id] = next_index
                    next_index += 1
                yield _chat_sse({"tool_calls": [{
                    "index": item_indexes[item_id],
                    "id": _as_text(item.get("call_id")) or item_id,
                    "type": "function",
                    "function": {"name": _as_text(item.get("name"))},
                }]})
        elif event_type == "response.completed":
            response = event.get("response") if isinstance(event.get("response"), dict) else {}
            yield _chat_sse({}, finish_reason="stop", usage=_responses_usage(response))
        elif event_type in {"error", "response.failed"}:
            error = event.get("error") or event.get("response") or event
            yield f"data: {json.dumps({'error': True, 'body': error})}\n\n"
    yield "data: [DONE]\n\n"


async def _responses_sse_to_chat_sse(chunks: AsyncIterable[bytes]) -> AsyncIterator[str]:
    async def events() -> AsyncIterator[dict[str, Any]]:
        buffer = ""
        async for chunk in chunks:
            buffer += chunk.decode("utf-8", errors="replace")
            lines = buffer.split("\n")
            buffer = lines.pop()
            for line in lines:
                if not line.startswith("data:"):
                    continue
                raw = line[5:].strip()
                if not raw or raw == "[DONE]":
                    continue
                try:
                    event = json.loads(raw)
                except json.JSONDecodeError:
                    continue
                if isinstance(event, dict):
                    yield event
    async for chunk in _responses_events_to_chat_sse(events()):
        yield chunk


async def _resolve_provider(
    provider_id: str | None, user: User, session: AsyncSession
) -> ProviderRow:
    """Load the user's provider by id, or their default if id is null."""
    if provider_id:
        row = await session.get(ProviderRow, provider_id)
        if row is None or row.user_id != user.id:
            raise HTTPException(status_code=404, detail="provider not found")
        return row
    rows = (
        await session.exec(
            select(ProviderRow).where(
                ProviderRow.user_id == user.id,
                ProviderRow.is_default == True,  # noqa: E712
            )
        )
    ).all()
    if not rows:
        # Fall back to any provider the user has.
        rows = (
            await session.exec(select(ProviderRow).where(ProviderRow.user_id == user.id))
        ).all()
    if not rows:
        raise HTTPException(status_code=400, detail="no provider configured")
    return rows[0]


@router.post("/llm")
async def llm_proxy(
    request: Request,
    user: User = Depends(current_user),
    session: AsyncSession = Depends(get_session),
) -> Any:
    """Forward a chat-completion request to the user's configured provider.

    Body shape:
        {
          "provider_id": "<id>" | null,   # null → user's default provider
          "payload": { ...full OpenAI chat completion body incl. messages, tools, stream }
        }
    """
    try:
        body = await request.json()
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=f"invalid JSON: {exc}") from exc

    provider_id = body.get("provider_id")
    payload = body.get("payload")
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="payload object is required")

    provider = await _resolve_provider(provider_id, user, session)
    is_responses = provider.api_format == "responses"
    target = _resolve_target(provider.base_url, provider.api_format)
    upstream_payload = _to_responses_payload(payload) if is_responses else payload
    api_key = security.decrypt(provider.api_key_enc)
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        # Some OpenAI-compatible gateways require an explicit accept for SSE.
        "Accept": "text/event-stream" if payload.get("stream") else "application/json",
    }

    want_stream = bool(payload.get("stream"))

    if not want_stream:
        # Non-streaming: forward and return JSON.
        async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
            try:
                resp = await client.post(target, headers=headers, json=upstream_payload)
            except httpx.RequestError as exc:
                raise HTTPException(
                    status_code=502, detail=f"upstream request error: {exc}"
                ) from exc
        if resp.status_code >= 400:
            return JSONResponse(content=resp.json(), status_code=resp.status_code)
        content = resp.json()
        if is_responses:
            content = _responses_to_chat_completion(content)
        return JSONResponse(content=content, status_code=resp.status_code)

    # Streaming: pipe upstream SSE straight through.
    async def stream_upstream() -> Any:
        async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
            try:
                async with client.stream(
                    "POST", target, headers=headers, json=upstream_payload
                ) as resp:
                    if resp.status_code >= 400:
                        text = await resp.aread()
                        # Surface upstream error as an SSE error event so the
                        # client can render it instead of silently dying.
                        err = {
                            "error": True,
                            "status": resp.status_code,
                            "body": text.decode("utf-8", errors="replace"),
                        }
                        yield f"data: {json.dumps(err)}\n\n"
                        yield "data: [DONE]\n\n"
                        return
                    if is_responses:
                        async for chunk in _responses_sse_to_chat_sse(resp.aiter_raw()):
                            yield chunk
                    else:
                        async for chunk in resp.aiter_raw():
                            if chunk:
                                yield chunk
            except httpx.RequestError as exc:
                err = {"error": True, "message": f"upstream stream error: {exc}"}
                yield f"data: {json.dumps(err)}\n\n"
                yield "data: [DONE]\n\n"

    return StreamingResponse(
        stream_upstream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )
