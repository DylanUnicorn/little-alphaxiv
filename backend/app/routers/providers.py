"""Provider CRUD router — a user's OpenAI-compatible provider configs.

The api_key is Fernet-encrypted at rest (api_key_enc) and returned to the
authenticated owner as a MASK (first4…last4). The frontend never receives the
plaintext key; it sends provider_id to /api/llm, which decrypts server-side.
"""
from __future__ import annotations

import secrets
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from .. import security
from ..db import get_session
from ..deps import current_user
from ..models import ProviderRow, User

router = APIRouter(prefix="/providers", tags=["providers"])


class ProviderOut(BaseModel):
    id: str
    name: str
    base_url: str
    api_key: str  # MASKED — first4…last4, never the plaintext
    model: str
    api_format: Literal["chat_completions", "responses"] = "chat_completions"
    vision_model: str | None = None
    is_default: bool = False


class ProviderCreate(BaseModel):
    id: str | None = None  # optional client-supplied id (frontend generates it)
    name: str
    base_url: str
    api_key: str  # plaintext from the authenticated user; encrypted on store
    model: str
    api_format: Literal["chat_completions", "responses"] = "chat_completions"
    vision_model: str | None = None
    is_default: bool = False


class ProviderPatch(BaseModel):
    name: str | None = None
    base_url: str | None = None
    api_key: str | None = None  # if provided, re-encrypt
    model: str | None = None
    api_format: Literal["chat_completions", "responses"] | None = None
    vision_model: str | None = None
    is_default: bool | None = None


def _to_out(row: ProviderRow) -> ProviderOut:
    plain = security.decrypt(row.api_key_enc)
    return ProviderOut(
        id=row.id,
        name=row.name,
        base_url=row.base_url,
        api_key=security.mask_key(plain),
        model=row.model,
        api_format=row.api_format,
        vision_model=row.vision_model,
        is_default=row.is_default,
    )


async def _clear_other_defaults(session: AsyncSession, user_id: int) -> None:
    rows = (
        await session.exec(
            select(ProviderRow).where(ProviderRow.user_id == user_id, ProviderRow.is_default == True)  # noqa: E712
        )
    ).all()
    for r in rows:
        r.is_default = False
    if rows:
        await session.commit()


@router.get("", response_model=list[ProviderOut])
async def list_providers(
    user: User = Depends(current_user),
    session: AsyncSession = Depends(get_session),
) -> list[ProviderOut]:
    rows = (
        await session.exec(select(ProviderRow).where(ProviderRow.user_id == user.id))
    ).all()
    return [_to_out(r) for r in rows]


@router.post("", response_model=ProviderOut, status_code=status.HTTP_201_CREATED)
async def create_provider(
    body: ProviderCreate,
    user: User = Depends(current_user),
    session: AsyncSession = Depends(get_session),
) -> ProviderOut:
    if body.is_default:
        await _clear_other_defaults(session, user.id)
    row = ProviderRow(
        id=body.id or secrets.token_urlsafe(9),
        user_id=user.id,
        name=body.name,
        base_url=body.base_url,
        api_key_enc=security.encrypt(body.api_key),
        model=body.model,
        api_format=body.api_format,
        vision_model=body.vision_model,
        is_default=body.is_default,
    )
    session.add(row)
    await session.commit()
    await session.refresh(row)
    return _to_out(row)


@router.patch("/{provider_id}", response_model=ProviderOut)
async def update_provider(
    provider_id: str,
    body: ProviderPatch,
    user: User = Depends(current_user),
    session: AsyncSession = Depends(get_session),
) -> ProviderOut:
    row = await session.get(ProviderRow, provider_id)
    if row is None or row.user_id != user.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "provider not found")
    if body.name is not None:
        row.name = body.name
    if body.base_url is not None:
        row.base_url = body.base_url
    if body.api_key:  # only re-encrypt if a new key was supplied
        row.api_key_enc = security.encrypt(body.api_key)
    if body.model is not None:
        row.model = body.model
    if body.api_format is not None:
        row.api_format = body.api_format
    if body.vision_model is not None:
        row.vision_model = body.vision_model
    if body.is_default is True:
        await _clear_other_defaults(session, user.id)
        row.is_default = True
    elif body.is_default is False:
        row.is_default = False
    await session.commit()
    await session.refresh(row)
    return _to_out(row)


@router.delete("/{provider_id}")
async def delete_provider(
    provider_id: str,
    user: User = Depends(current_user),
    session: AsyncSession = Depends(get_session),
) -> dict:
    row = await session.get(ProviderRow, provider_id)
    if row is None or row.user_id != user.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "provider not found")
    await session.delete(row)  # FK ON DELETE SET NULL on conversations
    await session.commit()
    return {"ok": True}


@router.post("/{provider_id}/default", response_model=ProviderOut)
async def set_default(
    provider_id: str,
    user: User = Depends(current_user),
    session: AsyncSession = Depends(get_session),
) -> ProviderOut:
    row = await session.get(ProviderRow, provider_id)
    if row is None or row.user_id != user.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "provider not found")
    await _clear_other_defaults(session, user.id)
    row.is_default = True
    await session.commit()
    await session.refresh(row)
    return _to_out(row)
