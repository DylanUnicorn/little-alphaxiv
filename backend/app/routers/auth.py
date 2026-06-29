"""Auth router: register / login / logout / me + password recovery.

Session = a row in the sessions table (PK = a 32-byte url-safe token). The
cookie value is an itsdangerous-signed {sid, exp}, NOT the raw id, so a stolen
DB row id alone can't be replayed. Logout deletes the row AND clears the cookie.

Recovery: forgot-password issues a single-use, TTL-bounded reset token (only
sha256(token) is stored) and emails a reset link (SMTP if configured, else the
link is printed to the terminal + lax_reset_links.log). reset-password verifies
the token, sets the new password hash, marks the token used, and DELETES every
session row for that user (so any old cookie dies the moment the password
changes), then issues a fresh session (auto-login). forgot-password always
returns the same generic 200 — no account-existence leak. Username normalized
to lower+trim; min length 3, password min length 8 — deliberately loose.
"""
from __future__ import annotations

import hashlib
import os
import secrets
import time

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from pydantic import BaseModel, EmailStr, Field
from sqlmodel import func, select
from sqlmodel.ext.asyncio.session import AsyncSession

from .. import security
from ..db import get_session
from ..deps import current_user
from ..email import send_reset_email
from ..models import AnnotationRow, ConversationRow, PasswordResetRow, Session, User

router = APIRouter(prefix="/auth", tags=["auth"])

USERNAME_MIN = 3
PASSWORD_MIN = 8

# In-process cooldown: {identifier_lower: last_sent_epoch}. Prevents one client
# from spamming reset emails for the same identifier. Not distributed.
_forgot_cooldown: dict[str, int] = {}
FORGOT_COOLDOWN_S = 60

GENERIC_FORGOT_MSG = (
    "If an account with that identifier exists, a reset link is on its way."
)


def _reset_ttl_seconds() -> int:
    return int(os.environ.get("LAX_PASSWORD_RESET_TTL_MIN", "30")) * 60


def _build_reset_link(token: str) -> str:
    origin = os.environ.get(
        "LAX_ALLOWED_ORIGINS", "http://127.0.0.1:5173"
    ).split(",")[0].strip()
    return f"{origin.rstrip('/')}/reset?token={token}"


class Credentials(BaseModel):
    """Login body: username + password only."""
    username: str = Field(min_length=USERNAME_MIN)
    password: str = Field(min_length=PASSWORD_MIN)


class RegisterBody(BaseModel):
    username: str = Field(min_length=USERNAME_MIN)
    email: EmailStr
    password: str = Field(min_length=PASSWORD_MIN)


class MeResponse(BaseModel):
    id: int
    username: str
    email: str | None = None
    hasData: bool


class ForgotBody(BaseModel):
    identifier: str


class ResetBody(BaseModel):
    token: str
    new_password: str = Field(min_length=PASSWORD_MIN)


class AccountBody(BaseModel):
    email: str | None = None


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
    creds: RegisterBody,
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
    email_norm = creds.email.strip().lower()
    email_taken = (
        await session.exec(select(User).where(User.email == email_norm))
    ).first()
    if email_taken is not None:
        raise HTTPException(status.HTTP_409_CONFLICT, "email already registered")
    user = User(
        username=username,
        email=email_norm,
        password_hash=security.hash_password(creds.password),
    )
    session.add(user)
    await session.commit()
    await session.refresh(user)
    await _issue_session(response, session, user)
    return MeResponse(id=user.id, username=user.username, email=user.email, hasData=False)


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
    return MeResponse(id=user.id, username=user.username, email=user.email, hasData=has_data)


@router.post("/forgot-password")
async def forgot_password(
    body: ForgotBody,
    session: AsyncSession = Depends(get_session),
) -> dict:
    """Issue a reset link if the identifier matches an account WITH an email.

    Always returns the same generic 200 — no account-existence leak. A new
    request supersedes the user's prior unused tokens (only the newest link
    is valid). Send failures are swallowed by the email module.
    """
    ident = body.identifier.strip().lower()
    now = int(time.time())
    # Cooldown: same identifier can't trigger a second send within 60s.
    last = _forgot_cooldown.get(ident, 0)
    if now - last < FORGOT_COOLDOWN_S:
        return {"ok": True, "message": GENERIC_FORGOT_MSG}
    _forgot_cooldown[ident] = now

    user = (
        await session.exec(
            select(User).where((User.username == ident) | (User.email == ident))
        )
    ).first()
    if user is None or not user.email:
        # No user, or no email on file → still return generic. No token created.
        return {"ok": True, "message": GENERIC_FORGOT_MSG}

    # Supersede this user's prior unused tokens so only the newest link works.
    prior = (
        await session.exec(
            select(PasswordResetRow).where(
                PasswordResetRow.user_id == user.id,
                PasswordResetRow.used_at.is_(None),
            )
        )
    ).all()
    for row in prior:
        row.used_at = now

    token = secrets.token_urlsafe(32)
    token_hash = hashlib.sha256(token.encode()).hexdigest()
    session.add(
        PasswordResetRow(
            user_id=user.id,
            token_hash=token_hash,
            expires_at=now + _reset_ttl_seconds(),
        )
    )
    await session.commit()

    await send_reset_email(user.email, user.username, _build_reset_link(token))
    return {"ok": True, "message": GENERIC_FORGOT_MSG}


@router.post("/reset-password", response_model=MeResponse)
async def reset_password(
    body: ResetBody,
    response: Response,
    session: AsyncSession = Depends(get_session),
) -> MeResponse:
    """Verify the token, set the new password, purge all the user's sessions
    (so any old cookie dies the moment the password changes), then issue a
    fresh session (auto-login → frontend redirects to /)."""
    token_hash = hashlib.sha256(body.token.encode()).hexdigest()
    row = (
        await session.exec(
            select(PasswordResetRow).where(PasswordResetRow.token_hash == token_hash)
        )
    ).first()
    now = int(time.time())
    if row is None or row.used_at is not None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "invalid or used reset token")
    if row.expires_at < now:
        raise HTTPException(status.HTTP_410_GONE, "reset token expired")
    user = await session.get(User, row.user_id)
    if user is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "invalid reset token")
    user.password_hash = security.hash_password(body.new_password)
    row.used_at = now
    # Invalidate ALL of this user's sessions — old cookies die immediately.
    old_sessions = (
        await session.exec(select(Session).where(Session.user_id == user.id))
    ).all()
    for s in old_sessions:
        await session.delete(s)
    await session.commit()
    await _issue_session(response, session, user)
    has_data = await _user_has_data(session, user.id)
    return MeResponse(
        id=user.id, username=user.username, email=user.email, hasData=has_data
    )


@router.patch("/account")
async def update_account(
    body: AccountBody,
    user: User = Depends(current_user),
    session: AsyncSession = Depends(get_session),
) -> dict:
    """Set or clear the authenticated user's recovery email. This is the only
    way for pre-migration accounts (no email on file) to enable recovery."""
    if body.email is None:
        user.email = None
    else:
        email_norm = body.email.strip().lower()
        # Light format check (pydantic didn't validate — email is Optional str).
        local, _, domain = email_norm.partition("@")
        if not local or "." not in domain:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "invalid email")
        taken = (
            await session.exec(
                select(User).where(User.email == email_norm, User.id != user.id)
            )
        ).first()
        if taken is not None:
            raise HTTPException(status.HTTP_409_CONFLICT, "email already registered")
        user.email = email_norm
    session.add(user)
    await session.commit()
    return {"email": user.email}


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
    return MeResponse(id=user.id, username=user.username, email=user.email, hasData=has_data)


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
