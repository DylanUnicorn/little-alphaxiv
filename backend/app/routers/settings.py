"""Settings router — the non-provider settings slice (per-user).

Holds theme, search_sources (OpenAlex + Semantic Scholar keys), zotero_config
(mode/userId/apiKey), and provider_models (cached /v1/models lists).

The apiKey fields inside the search_sources and zotero_config JSON objects are
Fernet-encrypted at those specific paths on write and decrypted on read, so the
authenticated owner gets their plaintext keys back (the zotero router still
passes them per-request in v1). provider_models is non-sensitive — plaintext.
"""
from __future__ import annotations

import copy

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from .. import security
from ..db import get_session
from ..deps import current_user
from ..models import User, UserSettings

router = APIRouter(prefix="/settings", tags=["settings"])

# Paths inside the JSON blobs that hold secrets (encrypted at rest).
_SEARCH_KEY_PATHS = [("openalex", "apiKey"), ("semanticScholar", "apiKey")]
_ZOTERO_KEY_PATH = ("apiKey",)


class SearchSources(BaseModel):
    openalex: dict | None = None
    semanticScholar: dict | None = None


class ZoteroConfig(BaseModel):
    mode: str | None = None
    userId: str | None = None
    apiKey: str | None = None


class SettingsOut(BaseModel):
    theme: str
    searchSources: dict
    zotero: dict
    providerModels: dict


class SettingsPatch(BaseModel):
    theme: str | None = None
    searchSources: dict | None = None
    zotero: dict | None = None
    providerModels: dict | None = None


def _encrypt_search_keys(obj: dict) -> dict:
    out = copy.deepcopy(obj)
    for path in _SEARCH_KEY_PATHS:
        cur = out
        for k in path[:-1]:
            if not isinstance(cur, dict) or k not in cur or not isinstance(cur[k], dict):
                cur = None
                break
            cur = cur[k]
        if isinstance(cur, dict) and path[-1] in cur and cur[path[-1]]:
            cur[path[-1]] = security.encrypt(cur[path[-1]])
    return out


def _decrypt_search_keys(obj: dict) -> dict:
    out = copy.deepcopy(obj)
    for path in _SEARCH_KEY_PATHS:
        cur = out
        for k in path[:-1]:
            if not isinstance(cur, dict) or k not in cur or not isinstance(cur[k], dict):
                cur = None
                break
            cur = cur[k]
        if isinstance(cur, dict) and path[-1] in cur and cur[path[-1]]:
            cur[path[-1]] = security.decrypt(cur[path[-1]])
    return out


def _encrypt_zotero_key(obj: dict) -> dict:
    out = copy.deepcopy(obj)
    if isinstance(out, dict) and out.get(_ZOTERO_KEY_PATH[0]):
        out[_ZOTERO_KEY_PATH[0]] = security.encrypt(out[_ZOTERO_KEY_PATH[0]])
    return out


def _decrypt_zotero_key(obj: dict) -> dict:
    out = copy.deepcopy(obj)
    if isinstance(out, dict) and out.get(_ZOTERO_KEY_PATH[0]):
        out[_ZOTERO_KEY_PATH[0]] = security.decrypt(out[_ZOTERO_KEY_PATH[0]])
    return out


async def _get_or_create(session: AsyncSession, user_id: int) -> UserSettings:
    row = (await session.exec(select(UserSettings).where(UserSettings.user_id == user_id))).first()
    if row is None:
        row = UserSettings(user_id=user_id)
        session.add(row)
        await session.commit()
        await session.refresh(row)
    return row


@router.get("", response_model=SettingsOut)
async def get_settings(
    user: User = Depends(current_user),
    session: AsyncSession = Depends(get_session),
) -> SettingsOut:
    row = await _get_or_create(session, user.id)
    return SettingsOut(
        theme=row.theme,
        searchSources=_decrypt_search_keys(row.search_sources or {}),
        zotero=_decrypt_zotero_key(row.zotero_config or {}),
        providerModels=row.provider_models or {},
    )


@router.patch("", response_model=SettingsOut)
async def patch_settings(
    body: SettingsPatch,
    user: User = Depends(current_user),
    session: AsyncSession = Depends(get_session),
) -> SettingsOut:
    row = await _get_or_create(session, user.id)
    if body.theme is not None:
        row.theme = body.theme
    if body.searchSources is not None:
        row.search_sources = _encrypt_search_keys(body.searchSources)
    if body.zotero is not None:
        row.zotero_config = _encrypt_zotero_key(body.zotero)
    if body.providerModels is not None:
        row.provider_models = body.providerModels
    await session.commit()
    await session.refresh(row)
    return SettingsOut(
        theme=row.theme,
        searchSources=_decrypt_search_keys(row.search_sources or {}),
        zotero=_decrypt_zotero_key(row.zotero_config or {}),
        providerModels=row.provider_models or {},
    )
