"""Password-reset endpoint tests.

Console mail backend (no LAX_SMTP_URL) → reset links land in the reset-link
log next to the DB (backend/data/lax_reset_links.log locally), which we scrape.
Covers: anti-enumeration, token creation + supersede, single-use reset,
expiry, session purge, and the account-email PATCH endpoint.
"""
from __future__ import annotations

import re
import time

from sqlmodel import select

from app import db as dbmod
from app.paths import reset_log_path
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
    log = reset_log_path()
    log.write_text("", encoding="utf-8")
    r = await client.post(
        "/api/auth/forgot-password",
        json={"identifier": identifier},
    )
    assert r.is_success, f"forgot failed: {r.status} {r.text}"
    lines = log.read_text(encoding="utf-8").splitlines()
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


# ---------------------------------------------------------------------------
# Reset password.
# ---------------------------------------------------------------------------


async def _reset_token_for(client, identifier):
    link = await _grab_reset_link(client, identifier)
    return link.split("token=")[1]


async def test_reset_succeeds_and_invalidates_old_password(client):
    await _register(client, username="bob", email="bob@example.com", password="oldpass123")
    # Old password works.
    r0 = await client.post("/api/auth/login", json={"username": "bob", "password": "oldpass123"})
    assert r0.is_success
    token = await _reset_token_for(client, "bob")
    # Reset → 200 + auto-login (Me returned).
    r = await client.post(
        "/api/auth/reset-password", json={"token": token, "new_password": "brandnew9"}
    )
    assert r.is_success, r.text
    assert r.json()["username"] == "bob"
    # Token is single-use: reuse → 401.
    r2 = await client.post(
        "/api/auth/reset-password", json={"token": token, "new_password": "another11"}
    )
    assert r2.status_code == 401
    # Old password now fails.
    r3 = await client.post("/api/auth/login", json={"username": "bob", "password": "oldpass123"})
    assert r3.status_code == 401
    # New password works.
    r4 = await client.post("/api/auth/login", json={"username": "bob", "password": "brandnew9"})
    assert r4.is_success


async def test_reset_expired_token_returns_410(client):
    await _register(client, username="carol", email="carol@example.com", password="pass1234")
    token = await _reset_token_for(client, "carol")
    # Backdate the row so the token is expired.
    async with dbmod.async_session_factory() as s:
        row = (await s.exec(select(PasswordResetRow).where(
            PasswordResetRow.used_at.is_(None)
        ))).first()
        row.expires_at = int(time.time()) - 1
        s.add(row)
        await s.commit()
    r = await client.post(
        "/api/auth/reset-password", json={"token": token, "new_password": "newpass12"}
    )
    assert r.status_code == 410


async def test_reset_invalidates_all_sessions(client):
    await _register(client, username="dave", email="dave@example.com", password="pass1234")
    # Login creates a session; the cookie jar carries it.
    await client.post("/api/auth/login", json={"username": "dave", "password": "pass1234"})
    me1 = await client.get("/api/auth/me")
    assert me1.is_success
    token = await _reset_token_for(client, "dave")
    # Reset uses a fresh token; it purges all sessions.
    await client.post(
        "/api/auth/reset-password", json={"token": token, "new_password": "newpass12"}
    )
    # The OLD session cookie must now be invalid (reset issued a new one).
    # Note: httpx carries the new Set-Cookie from reset-password, so /me here
    # reflects the NEW session — we instead verify the old session row is gone
    # by counting session rows for the user (should be exactly 1: the new one).
    async with dbmod.async_session_factory() as s:
        dave = (await s.exec(select(User).where(User.username == "dave"))).first()
        from app.models import Session as SessionRow
        sessions = (await s.exec(select(SessionRow).where(SessionRow.user_id == dave.id))).all()
    assert len(sessions) == 1  # old sessions purged; only the new one remains


async def test_reset_garbage_token_returns_401(client):
    r = await client.post(
        "/api/auth/reset-password",
        json={"token": "not-a-real-token", "new_password": "newpass12"},
    )
    assert r.status_code == 401


# ---------------------------------------------------------------------------
# Account email PATCH.
# ---------------------------------------------------------------------------


async def test_set_account_email_unique(client):
    await _register(client, username="eve", email="eve@example.com")
    await _register(client, username="frank", email="frank@example.com")
    # frank's account (last register) holds the cookie. Reset to eve's cookie.
    await client.post("/api/auth/login", json={"username": "eve", "password": "password123"})
    # eve tries to take frank's email → 409.
    r = await client.patch(
        "/api/auth/account", json={"email": "frank@example.com"}
    )
    assert r.status_code == 409
    # eve changes her own email → ok.
    r2 = await client.patch(
        "/api/auth/account", json={"email": "eve2@example.com"}
    )
    assert r2.is_success, r2.text
    assert r2.json()["email"] == "eve2@example.com"
    # me reflects the new email.
    me = await client.get("/api/auth/me")
    assert me.json()["email"] == "eve2@example.com"


async def test_set_account_email_invalid_format(client):
    await _register(client, username="greg", email="greg@example.com")
    r = await client.patch("/api/auth/account", json={"email": "not-an-email"})
    assert r.status_code == 400


async def test_account_requires_auth(client):
    r = await client.patch("/api/auth/account", json={"email": "x@example.com"})
    assert r.status_code == 401


async def test_set_account_email_can_clear(client):
    await _register(client, username="hank", email="hank@example.com")
    r = await client.patch("/api/auth/account", json={"email": None})
    assert r.is_success
    assert r.json()["email"] is None
