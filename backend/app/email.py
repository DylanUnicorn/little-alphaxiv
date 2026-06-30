"""Password-reset email delivery.

Two backends, chosen by config:
  * SMTP   — when LAX_SMTP_URL is set (e.g. smtps://user:pass@host:465).
  * Console — otherwise: print the link + append to the reset-link log that
    lives next to the DB (backend/data/lax_reset_links.log locally,
    /app/data/lax_reset_links.log in Docker; zero-config for localhost; the
    E2E driver scrapes the link from here).

Never raises: a send failure is logged and swallowed so the forgot-password
endpoint can't leak send state or 500. Network IO runs in a worker thread via
asyncio.to_thread so the event loop isn't blocked.
"""
from __future__ import annotations

import asyncio
import os
import urllib.parse
from email.message import EmailMessage

import smtplib

from . import paths


def _parse_smtp_url(url: str) -> dict:
    """Parse smtp(s)://user:pass@host:port[?starttls=true&from=...]."""
    p = urllib.parse.urlsplit(url)
    scheme = p.scheme.lower()
    use_ssl = scheme == "smtps"
    starttls = False
    from_addr: str | None = None
    for k, v in urllib.parse.parse_qsl(p.query, keep_blank_values=True):
        if k.lower() == "starttls" and v.lower() in ("1", "true", "yes"):
            starttls = True
        if k.lower() == "from":
            from_addr = v
    userinfo = urllib.parse.unquote(p.username) if p.username else ""
    password = urllib.parse.unquote(p.password) if p.password else ""
    if not from_addr and userinfo:
        from_addr = userinfo
    if not p.hostname or not p.port:
        raise ValueError(f"invalid SMTP url: {url}")
    # Default: plain SMTP on 587 uses STARTTLS; ssl port 465 does not.
    if not starttls and not use_ssl and p.port == 587 and "starttls=false" not in url.lower():
        starttls = True
    return {
        "host": p.hostname, "port": p.port, "use_ssl": use_ssl,
        "starttls": starttls,
        "username": userinfo, "password": password, "from_addr": from_addr,
    }


def _build_message(to: str, username: str, link: str, from_addr: str) -> EmailMessage:
    msg = EmailMessage()
    msg["From"] = from_addr
    msg["To"] = to
    msg["Subject"] = "Little Alphaxiv — reset your password"
    body_text = (
        f"Hi {username},\n\n"
        f"Someone (hopefully you) requested a password reset for your Little "
        f"Alphaxiv account.\n\n"
        f"Reset link (expires in 30 minutes):\n{link}\n\n"
        f"If you didn't request this, ignore this email — your password stays "
        f"unchanged.\n"
    )
    msg.set_content(body_text)
    msg.add_alternative(
        f"<html><body><p>Hi {username},</p>"
        f"<p>Someone (hopefully you) requested a password reset for your "
        f"Little Alphaxiv account.</p>"
        f"<p><a href=\"{link}\">Reset your password</a> "
        f"(expires in 30 minutes).</p>"
        f"<p>If you didn't request this, ignore this email — your password "
        f"stays unchanged.</p></body></html>",
        subtype="html",
    )
    return msg


def _send_smtp_sync(cfg: dict, to: str, username: str, link: str) -> None:
    from_addr = cfg["from_addr"] or cfg["username"]
    if not from_addr:
        raise ValueError("no from address: set LAX_SMTP_FROM")
    msg = _build_message(to, username, link, from_addr)
    if cfg["use_ssl"]:
        server = smtplib.SMTP_SSL(cfg["host"], cfg["port"], timeout=20)
    else:
        server = smtplib.SMTP(cfg["host"], cfg["port"], timeout=20)
    try:
        server.ehlo()
        if cfg["starttls"]:
            server.starttls()
            server.ehlo()
        if cfg["username"]:
            server.login(cfg["username"], cfg["password"])
        server.send_message(msg)
    finally:
        server.quit()


def _send_console_sync(to: str, username: str, link: str) -> None:
    line = f"[lax] password-reset link for {to} (user={username}): {link}"
    print(line, flush=True)
    try:
        paths.ensure_db_parent_dir()
        with paths.reset_log_path().open("a", encoding="utf-8") as f:
            f.write(line + "\n")
    except OSError as exc:
        print(f"[lax] failed to write reset link log: {exc}", flush=True)


async def send_reset_email(to: str, username: str, link: str) -> None:
    """Send the reset link. SMTP if configured, else console. Never raises."""
    url = os.environ.get("LAX_SMTP_URL", "").strip()
    try:
        if not url:
            await asyncio.to_thread(_send_console_sync, to, username, link)
            return
        cfg = _parse_smtp_url(url)
        override = os.environ.get("LAX_SMTP_FROM", "").strip()
        if override:
            cfg["from_addr"] = override
        await asyncio.to_thread(_send_smtp_sync, cfg, to, username, link)
    except Exception as exc:  # noqa: BLE001 — must not break the forgot endpoint
        print(f"[lax] password-reset email send failed: {exc}", flush=True)
