"""Password-reset endpoint tests.

Console mail backend (no LAX_SMTP_URL) → reset links land in
backend/lax_reset_links.log, which we scrape. Covers: anti-enumeration,
token creation + supersede, single-use reset, expiry, session purge, and the
account-email PATCH endpoint.
"""
from __future__ import annotations

import re
import time

from sqlmodel import select

from app import db as dbmod
from app.email import _LOG_PATH
from app.models import PasswordResetRow, User


GENERIC = "If an account with that identifier exists, a reset link is on its way."


async def _register(
    client,
    username="alice",
    email="alice@example.com",
    password="password123",
):
    r = await client.post(
        "/api/auth/register",
        json={"username": username, "email": email, "password": password},
    )
    assert r.status_code == 201, r.text
    return r


async def _grab_reset_link(client, identifier):
    """Trigger a forgot and scrape the latest reset link from the console log."""
    _LOG_PATH.write_text("", encoding="utf-8")
    r = await client.post(
        "/api/auth/forgot-password",
        json={"identifier": identifier},
    )
    assert r.is_success, f"forgot failed: {r.status} {r.text}"
    lines = _LOG_PATH.read_text(encoding="utf-8").splitlines()
    m = re.search(r"(https?://\S+/reset\?token=\S+)", lines[-1])
    assert m, f"no reset link in log: {lines}"
    return m.group(1)


# ---------------------------------------------------------------------------
# Registration now requires email.
# ---------------------------------------------------------------------------


async def test_register_requires_email(client):
    r = await client.post(
        "/api/auth/register",
        json={"username": "noemail", "password": "password123"},
    )
    assert r.status_code == 422  # missing required email field


async def test_register_rejects_duplicate_email(client):
    await _register(client, username="aaa", email="dup@example.com")
    r = await client.post(
        "/api/auth/register",
        json={"username": "bbb", "email": "dup@example.com", "password": "password123"},
    )
    assert r.status_code == 409


# ---------------------------------------------------------------------------
# Forgot password.
# ---------------------------------------------------------------------------


async def test_forgot_returns_generic_for_unknown_identifier(client):
    r = await client.post("/api/auth/forgot-password", json={"identifier": "ghost"})
    assert r.status_code == 200
    assert r.json()["message"] == GENERIC


async def test_forgot_returns_generic_for_known_user_without_email(client):
    # Register a user, then null their email to simulate a pre-migration account.
    await _register(client, username="bare", email="bare@example.com")
    async with dbmod.async_session_factory() as s:
        row = (await s.exec(select(User).where(User.username == "bare"))).first()
        row.email = None
        s.add(row)
        await s.commit()
    r = await client.post("/api/auth/forgot-password", json={"identifier": "bare"})
    assert r.status_code == 200 and r.json()["message"] == GENERIC
    # And no token row was created.
    async with dbmod.async_session_factory() as s:
        rows = (await s.exec(select(PasswordResetRow))).all()
    assert rows == []


async def test_forgot_creates_token_row_and_supersedes(client):
    await _register(client, username="alice", email="alice@example.com")
    await _grab_reset_link(client, "alice")
    await _grab_reset_link(client, "alice@example.com")
    async with dbmod.async_session_factory() as s:
        alice = (await s.exec(select(User).where(User.username == "alice"))).first()
        rows = (await s.exec(select(PasswordResetRow).where(
            PasswordResetRow.user_id == alice.id
        ))).all()
    assert len(rows) == 2
    # The older of the two must be marked used (superseded by the newer).
    used = [r for r in rows if r.used_at is not None]
    assert len(used) == 1
