"""Auth router: register / login / logout / me.

Session = a row in the sessions table (PK = a 32-byte url-safe token). The
cookie value is an itsdangerous-signed {sid, exp}, NOT the raw id, so a stolen
DB row id alone can't be replayed. Logout deletes the row AND clears the cookie.

Username-only auth (no email server needed for a LAN app). Username normalized
to lower+trim; min length 3, password min length 8 — deliberately loose.
"""
from __future__ import annotations

import time

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from pydantic import BaseModel, Field
from sqlmodel import func, select
from sqlmodel.ext.asyncio.session import AsyncSession

from .. import security
from ..db import get_session
from ..deps import current_user
from ..models import AnnotationRow, ConversationRow, Session, User

router = APIRouter(prefix="/auth", tags=["auth"])

USERNAME_MIN = 3
PASSWORD_MIN = 8


class Credentials(BaseModel):
    username: str = Field(min_length=USERNAME_MIN)
    password: str = Field(min_length=PASSWORD_MIN)


class MeResponse(BaseModel):
    id: int
    username: str
    hasData: bool


def _set_session_cookie(response: Response, sid: str, expires_at: int) -> None:
    value = security.sign_session(sid, expires_at)
    response.set_cookie(
        key=security.SESSION_COOKIE,
        value=value,
        max_age=security.session_max_age_seconds(),
        httponly=True,
        samesite="lax",
        secure=security.cookie_secure(),
        path="/",
    )


async def _issue_session(response: Response, session: AsyncSession, user: User) -> None:
    sid = security.new_session_id()
    expires_at = int(time.time()) + security.session_max_age_seconds()
    session.add(Session(id=sid, user_id=user.id, expires_at=expires_at))
    await session.commit()
    _set_session_cookie(response, sid, expires_at)


@router.post("/register", status_code=status.HTTP_201_CREATED, response_model=MeResponse)
async def register(
    creds: Credentials,
    response: Response,
    session: AsyncSession = Depends(get_session),
) -> MeResponse:
    username = creds.username.strip().lower()
    if len(username) < USERNAME_MIN:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "username too short")
    existing = (
        await session.exec(select(User).where(User.username == username))
    ).first()
    if existing is not None:
        raise HTTPException(status.HTTP_409_CONFLICT, "username taken")
    user = User(username=username, password_hash=security.hash_password(creds.password))
    session.add(user)
    await session.commit()
    await session.refresh(user)
    await _issue_session(response, session, user)
    return MeResponse(id=user.id, username=user.username, hasData=False)


@router.post("/login", response_model=MeResponse)
async def login(
    creds: Credentials,
    response: Response,
    session: AsyncSession = Depends(get_session),
) -> MeResponse:
    username = creds.username.strip().lower()
    user = (await session.exec(select(User).where(User.username == username))).first()
    if user is None or not security.verify_password(creds.password, user.password_hash):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "invalid credentials")
    await _issue_session(response, session, user)
    has_data = await _user_has_data(session, user.id)
    return MeResponse(id=user.id, username=user.username, hasData=has_data)


@router.post("/logout")
async def logout(
    request: Request,
    response: Response,
    session: AsyncSession = Depends(get_session),
) -> dict:
    token = request.cookies.get(security.SESSION_COOKIE)
    sid = security.unsign_session(token) if token else None
    if sid:
        row = await session.get(Session, sid)
        if row is not None:
            await session.delete(row)
            await session.commit()
    response.delete_cookie(security.SESSION_COOKIE, path="/")
    return {"ok": True}


@router.get("/me", response_model=MeResponse)
async def me(
    user: User = Depends(current_user),
    session: AsyncSession = Depends(get_session),
) -> MeResponse:
    has_data = await _user_has_data(session, user.id)
    return MeResponse(id=user.id, username=user.username, hasData=has_data)


async def _user_has_data(session: AsyncSession, user_id: int) -> bool:
    """True if the user owns any conversation or annotation (drives boot redirect)."""
    conv = (
        await session.exec(
            select(func.count(ConversationRow.id)).where(ConversationRow.user_id == user_id)
        )
    ).first()
    if conv and conv > 0:
        return True
    annot = (
        await session.exec(
            select(func.count(AnnotationRow.id)).where(AnnotationRow.user_id == user_id)
        )
    ).first()
    return bool(annot and annot > 0)
