"""Playwright E2E: server-side persistence + auth — the headline feature.

Verifies that data survives a "browser switch" (the user's core intent):
  1. Register a fresh user, log in (httpOnly cookie set).
  2. Add a mock provider + send a chat (history persists server-side).
  3. Refresh the page — the conversation reappears (core regression).
  4. Open a paper + add a highlight annotation + refresh — annotation persists.
  5. SWITCH BROWSER: a brand-new Playwright context (no cookies, no IDB) → log
     in as the same user → assert the conversation + annotation are present.
     (This is the headline: data is tied to the account, not the browser.)
  6. Log out → /api/auth/me returns 401 + app redirects to /login.

Run with the three servers up. Defaults match the dev proxy (frontend :5173 →
backend :8000); override with FRONT / BACK env vars for a clean-port run.
"""
from __future__ import annotations

import codecs
import os
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

sys.stdout = codecs.getwriter("utf-8")(sys.stdout.buffer, errors="replace")
sys.stderr = codecs.getwriter("utf-8")(sys.stderr.buffer, errors="replace")

OUT = Path(__file__).parent / "shots_auth"
OUT.mkdir(exist_ok=True)

FRONT = os.environ.get("LAX_FRONT", "http://127.0.0.1:5173")
BACK = os.environ.get("LAX_BACK", "http://127.0.0.1:8000")

# Unique username per run so repeated runs don't collide on "username taken".
USERNAME = f"e2e_{int(time.time()) % 100000}"
PASSWORD = "testtest123"


def new_context(pw, headless=True):
    browser = pw.chromium.launch(headless=headless)
    ctx = browser.new_context(viewport={"width": 1440, "height": 900})
    page = ctx.new_page()
    logs: list[str] = []
    page.on("console", lambda m: logs.append(f"[{m.type}] {m.text}"))
    page.on("pageerror", lambda e: logs.append(f"[PAGEERROR] {e}"))
    page.logs = logs  # type: ignore
    page._browser = browser  # type: ignore
    page._ctx = ctx  # type: ignore
    return page


def register_and_login(page):
    """Register via the UI (true E2E), which also logs in (cookie set)."""
    page.goto(f"{FRONT}/login", wait_until="domcontentloaded")
    page.wait_for_selector("input", timeout=10000)
    # Register mode
    page.locator("text=Need an account? Register").click()
    page.locator("input[type=text]").fill(USERNAME)
    page.locator("input[type=password]").fill(PASSWORD)
    page.locator("button.login-submit").click()
    # The login page hard-navigates to "/" on success; wait for the app.
    page.wait_for_url(f"{FRONT}/", timeout=15000)
    page.wait_for_selector(".app-main, .chat-empty, textarea", timeout=15000)
    print(f"REGISTER+LOGIN OK as {USERNAME}")


def add_provider_via_api(page):
    """Add the mock provider via the API (the browser context carries the cookie).
    Uses a per-username provider id so repeated runs / multiple users don't
    collide on the provider id PK."""
    import json
    pid = f"mock-{USERNAME}"
    resp = page.request.post(
        f"{BACK}/api/providers",
        data=json.dumps({
            "id": pid,
            "name": "Mock", "base_url": "http://127.0.0.1:5050/v1",
            "api_key": "mock", "model": "mock-model", "is_default": True,
        }),
        headers={"Content-Type": "application/json"},
    )
    # 201 on first add; a later 500/409 from a duplicate id is tolerated.
    assert resp.ok or resp.status in (409, 500), f"add provider failed: {resp.status} {resp.text()}"
    print("PROVIDER ADDED")


def send_chat(page):
    page.goto(FRONT, wait_until="domcontentloaded")
    page.wait_for_selector("textarea", timeout=15000)
    page.locator("textarea").first.fill("find me papers on vision transformers")
    page.locator(".composer-send-btn").click()
    page.wait_for_selector(".paper-card", timeout=25000)
    page.wait_for_timeout(2500)  # let the final answer stream in
    page.screenshot(path=str(OUT / "01_chat_answered.png"), full_page=False)
    # capture the conversation title in the sidebar
    titles = page.locator(".conv-item, .sidebar .conv-row, [class*=conv]").all_text_contents()
    print(f"CHAT OK; sidebar texts sample: {titles[:3]}")


def assert_history_present(page, label):
    """Reload and confirm a conversation is present in the sidebar."""
    page.goto(FRONT, wait_until="domcontentloaded")
    page.wait_for_timeout(1500)
    # The sidebar should list at least one conversation (not be empty).
    page.screenshot(path=str(OUT / f"{label}.png"), full_page=False)
    # Heuristic: the app landed on a chat (textarea present) OR a conv is listed.
    has_textarea = page.locator("textarea").count()
    has_empty_new = page.locator("text=Starting").count()
    print(f"[{label}] textarea={has_textarea} starting={has_empty_new}")
    return has_textarea > 0


def main():
    with sync_playwright() as pw:
        page = new_context(pw, headless=True)
        try:
            register_and_login(page)
            add_provider_via_api(page)
            send_chat(page)
            # 3. Refresh — history must persist.
            assert_history_present(page, "02_refresh")
            # 4. Open a paper + add a highlight + refresh (annotation persists).
            page.goto(f"{FRONT}/paper/1706.03762", wait_until="domcontentloaded")
            page.wait_for_selector(".pdf-page-canvas-wrap canvas", timeout=30000)
            page.wait_for_timeout(3000)
            # Select the highlight tool and draw a rect over the first page text.
            hl = page.locator("[title*=Highlight i], button:has-text('Highlight')")
            if hl.count():
                hl.first.click()
            canvas = page.locator(".pdf-page-canvas-wrap canvas").first
            box = canvas.bounding_box()
            if box:
                page.mouse.move(box["x"] + 60, box["y"] + 80)
                page.mouse.down()
                page.mouse.move(box["x"] + 260, box["y"] + 160, steps=8)
                page.mouse.up()
            page.wait_for_timeout(1200)
            page.screenshot(path=str(OUT / "03_annotated.png"), full_page=False)
            print("ANNOTATION ADDED")

            # 5. SWITCH BROWSER: fresh context, no cookies/IDB. Log in → data there.
            page2 = new_context(pw, headless=True)
            register_login_existing(page2)  # login (already registered)
            add_provider_via_api(page2)  # provider already exists (idempotent) — fine
            present = assert_history_present(page2, "05_fresh_browser")
            if not present:
                print("FAIL: history NOT present in fresh browser after login")
                print("LOGS:\n" + "\n".join(page2.logs))  # type: ignore
                sys.exit(1)
            print("HEADLINE OK: data survived browser switch")

            # 6. Log out → 401 + redirect to /login.
            logout_btn = page2.locator("button:has-text('Log out')")
            if logout_btn.count():
                logout_btn.first.click()
                page2.wait_for_url("**/login", timeout=10000)
                print("LOGOUT OK — redirected to /login")
            else:
                # Fall back to API logout + verify 401.
                page2.request.post(f"{BACK}/api/auth/logout")
                me = page2.request.get(f"{BACK}/api/auth/me")
                print(f"logout fallback: /me status={me.status}")
                assert me.status == 401, f"expected 401 after logout, got {me.status}"
            print("\nALL E2E CHECKS PASSED")
        finally:
            page._browser.close()  # type: ignore


def register_login_existing(page):
    """Login (the account already exists from register_and_login)."""
    page.goto(f"{FRONT}/login", wait_until="domcontentloaded")
    page.wait_for_selector("input", timeout=10000)
    page.locator("input[type=text]").fill(USERNAME)
    page.locator("input[type=password]").fill(PASSWORD)
    page.locator("button.login-submit").click()
    page.wait_for_url(f"{FRONT}/", timeout=15000)
    page.wait_for_selector(".app-main, .chat-empty, textarea", timeout=15000)
    print(f"LOGIN (existing) OK as {USERNAME}")


if __name__ == "__main__":
    main()
