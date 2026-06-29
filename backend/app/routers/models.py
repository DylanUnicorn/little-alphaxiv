"""Models list proxy — forwards GET /v1/models to the user's provider.

Auth-aware: takes a provider_id query param (not inline base_url/api_key), loads
the provider from the authenticated user's rows, decrypts the api_key, and
forwards to {base_url}/models. This also fixes the old inconsistency where
/api/models used query-param creds while /api/llm used the JSON body — now both
resolve via provider_id.
"""
from __future__ import annotations

import httpx
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from sqlmodel.ext.asyncio.session import AsyncSession

from .. import security
from ..db import get_session
from ..deps import current_user
from ..models import ProviderRow, User

router = APIRouter()

_TIMEOUT = httpx.Timeout(connect=10.0, read=30.0, write=10.0, pool=10.0)


class ModelsTestBody(BaseModel):
    base_url: str
    api_key: str


@router.post("/models/test")
async def test_models(
    body: ModelsTestBody,
    user: User = Depends(current_user),
) -> JSONResponse:
    """Test-fetch /models for credentials the user is typing in the Add-provider
    form (before the provider is saved). The plaintext key is in the request
    body — same exposure as the save flow, and it's the authenticated owner."""
    target = body.base_url.strip().rstrip("/") + "/models"
    headers = {"Authorization": f"Bearer {body.api_key}", "Accept": "application/json"}
    async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
        try:
            resp = await client.get(target, headers=headers)
        except httpx.RequestError as exc:
            raise HTTPException(status_code=502, detail=f"upstream request error: {exc}") from exc
    if resp.status_code >= 400:
        raise HTTPException(status_code=502, detail=f"upstream returned {resp.status_code}: {resp.text[:300]}")
    return JSONResponse(content=resp.json(), status_code=resp.status_code)


@router.get("/models")
async def list_models(
    provider_id: str,
    user: User = Depends(current_user),
    session: AsyncSession = Depends(get_session),
) -> JSONResponse:
    """Proxy GET /models to the user's provider (resolved by provider_id)."""
    row = await session.get(ProviderRow, provider_id)
    if row is None or row.user_id != user.id:
        raise HTTPException(status_code=404, detail="provider not found")

    target = row.base_url.strip().rstrip("/") + "/models"
    api_key = security.decrypt(row.api_key_enc)
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Accept": "application/json",
    }

    async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
        try:
            resp = await client.get(target, headers=headers)
        except httpx.RequestError as exc:
            raise HTTPException(
                status_code=502, detail=f"upstream request error: {exc}"
            ) from exc

    if resp.status_code >= 400:
        raise HTTPException(
            status_code=502,
            detail=f"upstream returned {resp.status_code}: {resp.text[:300]}",
        )

    return JSONResponse(content=resp.json(), status_code=resp.status_code)
