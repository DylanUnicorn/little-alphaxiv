"""FastAPI dependencies — the auth chokepoint.

`current_user` reads the lax_session cookie, verifies its itsdangerous
signature, looks up the session row (checking expiry), and returns the User.
Every protected router takes `user: User = Depends(current_user)` and filters
every query by user.id — this is the single place per-user scoping is enforced.
"""
from __future__ import annotations

import time

from fastapi import Depends, HTTPException, Request, status
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from . import security
from .db import get_session
from .models import Session, User


async def current_user(
    request: Request,
    session: AsyncSession = Depends(get_session),
) -> User:
    token = request.cookies.get(security.SESSION_COOKIE)
    if not token:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "not authenticated")
    sid = security.unsign_session(token)
    if not sid:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "invalid session")
    sess = await session.get(Session, sid)
    now = int(time.time())
    if sess is None or sess.expires_at < now:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "session expired")
    # Best-effort last-seen refresh; never fail the request on it.
    if now - sess.last_seen_at > 300:  # throttle to once per 5 min
        sess.last_seen_at = now
        try:
            await session.commit()
        except Exception:
            await session.rollback()
    user = await session.get(User, sess.user_id)
    if user is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "user not found")
    return user
