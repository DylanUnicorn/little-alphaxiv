"""LLM proxy — passthrough to an OpenAI-compatible /chat/completions endpoint.

Auth-aware: the body now carries only {provider_id, payload}. The provider's
base_url + (decrypted) api_key come from the authenticated user's stored
ProviderRow, so the plaintext key never crosses the wire from the browser. We
forward the payload verbatim and stream the upstream SSE response back
byte-for-byte. SSE piping / _TIMEOUT / error-event injection are unchanged.
"""
from __future__ import annotations

import json
from typing import Any

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
# Keep the upstream connection alive across long streaming turns.
_TIMEOUT = httpx.Timeout(connect=15.0, read=300.0, write=60.0, pool=15.0)


def _resolve_target(base_url: str) -> str:
    base = base_url.strip().rstrip("/")
    if not base:
        raise HTTPException(status_code=400, detail="base_url is required")
    return base + _CHAT_PATH


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
    target = _resolve_target(provider.base_url)
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
                resp = await client.post(target, headers=headers, json=payload)
            except httpx.RequestError as exc:
                raise HTTPException(
                    status_code=502, detail=f"upstream request error: {exc}"
                ) from exc
        if resp.status_code >= 400:
            return JSONResponse(content=resp.json(), status_code=resp.status_code)
        return JSONResponse(content=resp.json(), status_code=resp.status_code)

    # Streaming: pipe upstream SSE straight through.
    async def stream_upstream() -> Any:
        async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
            try:
                async with client.stream(
                    "POST", target, headers=headers, json=payload
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
