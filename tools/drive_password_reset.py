"""Playwright E2E: the email password-reset flow (console backend).

Covers the full link:
  1. Register with email → logged in.
  2. /forgot submit (by email) → backend writes reset link to lax_reset_links.log.
  3. Fresh context opens /reset?token=… → set new password → auto-login to /.
  4. Old password now fails to log in (401).
  5. Token is single-use: reusing it → 401.
  6. Forgot with unknown identifier still returns success (anti-enumeration).

Run with backend + frontend up. Scrapes the link from deploy/data/lax_reset_links.log
(console mail backend). Defaults match the dev proxy.
"""
from __future__ import annotations

import codecs
import os
import re
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

sys.stdout = codecs.getwriter("utf-8")(sys.stdout.buffer, errors="replace")
sys.stderr = codecs.getwriter("utf-8")(sys.stderr.buffer, errors="replace")

FRONT = os.environ.get("LAX_FRONT", "http://127.0.0.1:5173")
BACK = os.environ.get("LAX_BACK", "http://127.0.0.1:8000")
LOG = Path(__file__).resolve().parent.parent / "deploy" / "data" / "lax_reset_links.log"

USERNAME = f"e2e_{int(time.time()) % 100000}"
EMAIL = f"{USERNAME}@example.com"
PASSWORD = "oldpass123"
NEW_PASSWORD = "brandnew9"


def new_context(pw, headless=True):
    browser = pw.chromium.launch(headless=headless)
    ctx = browser.new_context(viewport={"width": 1440, "height": 900})
    page = ctx.new_page()
    page._browser = browser  # type: ignore
    page._ctx = ctx  # type: ignore
    return page


def register_with_email(page):
    page.goto(f"{FRONT}/login", wait_until="domcontentloaded")
    page.wait_for_selector("input", timeout=10000)
    page.locator("text=Need an account? Register").click()
    page.locator("input[type=text]").fill(USERNAME)
    page.locator("input[type=email]").fill(EMAIL)
    page.locator("input[type=password]").fill(PASSWORD)
    page.locator("button.login-submit").click()
    # The login page hard-navigates to "/" on success; wait for the app.
    page.wait_for_url(f"{FRONT}/", timeout=15000)
    page.wait_for_selector(".app-main, .chat-empty, textarea", timeout=15000)
    print(f"REGISTER OK as {USERNAME}")


def latest_reset_link() -> str:
    text = LOG.read_text(encoding="utf-8")
    # Match the line for OUR email, take its link.
    m = re.search(rf"{re.escape(EMAIL)}.*?(https?://\S+/reset\?token=\S+)", text)
    assert m, f"no reset link for {EMAIL} in {LOG}"
    return m.group(1)


def main():
    # Clean the log so we don't grab a stale link from a prior run.
    if LOG.exists():
        LOG.write_text("")
    with sync_playwright() as pw:
        page = new_context(pw, headless=True)
        try:
            register_with_email(page)
            # Logout back to /login so the reset flow isn't pre-authed.
            page.request.post(f"{BACK}/api/auth/logout")

            # 2. Forgot via the API (deterministic; the /forgot UI also works).
            r = page.request.post(
                f"{BACK}/api/auth/forgot-password",
                data=f'{{"identifier":"{EMAIL}"}}',
                headers={"Content-Type": "application/json"},
            )
            assert r.ok, f"forgot failed: {r.status} {r.text()}"
            link = latest_reset_link()
            token = link.split("token=")[1]
            print(f"GOT RESET LINK (token len={len(token)})")

            # 3. Fresh context opens /reset → set new password → land on /.
            page2 = new_context(pw, headless=True)
            page2.goto(f"{FRONT}/reset?token={token}", wait_until="domcontentloaded")
            page2.wait_for_selector("input[type=password]", timeout=10000)
            pw_inputs = page2.locator("input[type=password]")
            pw_inputs.nth(0).fill(NEW_PASSWORD)
            pw_inputs.nth(1).fill(NEW_PASSWORD)
            page2.locator("button.login-submit").click()
            page2.wait_for_url(f"{FRONT}/", timeout=15000)
            page2.wait_for_selector(".app-main, .chat-empty, textarea", timeout=15000)
            print("RESET+AUTOLOGIN OK")

            # 4. Old password fails; new password works.
            r4 = page2.request.post(
                f"{BACK}/api/auth/login",
                data=f'{{"username":"{USERNAME}","password":"{PASSWORD}"}}',
                headers={"Content-Type": "application/json"},
            )
            assert r4.status == 401, f"old password should fail, got {r4.status}"
            r5 = page2.request.post(
                f"{BACK}/api/auth/login",
                data=f'{{"username":"{USERNAME}","password":"{NEW_PASSWORD}"}}',
                headers={"Content-Type": "application/json"},
            )
            assert r5.ok, f"new password should work, got {r5.status}"
            print("PASSWORD SWAP VERIFIED")

            # 5. Token is single-use → reuse fails.
            r6 = page2.request.post(
                f"{BACK}/api/auth/reset-password",
                data=f'{{"token":"{token}","new_password":"yetanother1"}}',
                headers={"Content-Type": "application/json"},
            )
            assert r6.status == 401, f"token reuse should fail, got {r6.status}"
            print("SINGLE-USE VERIFIED")

            # 6. Anti-enumeration: unknown identifier → 200.
            r7 = page2.request.post(
                f"{BACK}/api/auth/forgot-password",
                data='{"identifier":"definitely-nobody-xyz"}',
                headers={"Content-Type": "application/json"},
            )
            assert r7.ok and r7.json()["ok"], "unknown identifier must return 200"
            print("ANTI-ENUMERATION VERIFIED")

            print("\nALL PASSWORD-RESET E2E CHECKS PASSED")
        finally:
            page._browser.close()  # type: ignore


if __name__ == "__main__":
    main()
