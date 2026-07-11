"""Playwright driver to verify Little Alphaxiv in a real browser.

Captures console logs + page errors + screenshots. Configured against the
mock LLM at http://127.0.0.1:5050/v1 so no real key is needed.

Usage:
    python drive.py <scenario>
scenarios:
    chat        — seed mock provider, open new chat, send a question, screenshot
    paper       — open /paper/1706.03762 directly, screenshot PDF + chat
    md          — after chat, screenshot to inspect markdown rendering
"""
from __future__ import annotations

import sys
import codecs
from pathlib import Path

from playwright.sync_api import sync_playwright

# Force UTF-8 stdout so emoji/CJK in console logs don't crash GBK on Windows.
sys.stdout = codecs.getwriter("utf-8")(sys.stdout.buffer, errors="replace")
sys.stderr = codecs.getwriter("utf-8")(sys.stderr.buffer, errors="replace")

OUT = Path(__file__).parent / "shots"
OUT.mkdir(exist_ok=True)

APP = "http://127.0.0.1:5173"
MOCK_PROVIDER = {
    "name": "Mock",
    "base_url": "http://127.0.0.1:5050/v1",
    "api_key": "mock",
    "model": "mock-model",
}


def new_page(pw, headless=True):
    browser = pw.chromium.launch(headless=headless)
    ctx = browser.new_context(viewport={"width": 1440, "height": 900})
    page = ctx.new_page()
    logs: list[str] = []
    page.on("console", lambda m: logs.append(f"[{m.type}] {m.text}"))
    page.on("pageerror", lambda e: logs.append(f"[PAGEERROR] {e}"))
    page.logs = logs  # type: ignore
    page._browser = browser  # type: ignore
    return page


E2E_USER = "e2e_drive_v2"
E2E_PASS = "testtest123"
BACK = "http://127.0.0.1:8000"


def seed_provider(page):
    """Register/login the e2e user and add the mock provider via the API.

    Persistence is server-side + per-user now, so we authenticate the browser
    context (cookie set by /login) and POST the provider, instead of injecting
    into localStorage.
    """
    import json
    # Register (idempotent: ignore 409 if the user already exists).
    register = page.request.post(
        f"{BACK}/api/auth/register",
        data=json.dumps({"username": E2E_USER, "email": "e2e_drive_v2@example.com", "password": E2E_PASS}),
        headers={"Content-Type": "application/json"},
    )
    # Login to set the cookie in the browser context.
    login = page.request.post(
        f"{BACK}/api/auth/login",
        data=json.dumps({"username": E2E_USER, "password": E2E_PASS}),
        headers={"Content-Type": "application/json"},
    )
    # ProviderRow.id is globally unique, so scope the deterministic mock id to
    # this E2E account instead of colliding with another test user's provider.
    provider_id = f"mock-{E2E_USER}"
    existing = page.request.get(f"{BACK}/api/providers")
    if existing.ok and any(row.get("id") == provider_id for row in existing.json()):
        return
    provider = page.request.post(
        f"{BACK}/api/providers",
        data=json.dumps({"id": provider_id, **MOCK_PROVIDER, "is_default": True}),
        headers={"Content-Type": "application/json"},
    )
    if not register.ok and register.status != 409:
        raise RuntimeError(f"E2E registration failed: {register.status} {register.text()}")
    if not login.ok:
        raise RuntimeError(f"E2E login failed: {login.status} {login.text()}")
    if not provider.ok and provider.status != 409:
        raise RuntimeError(f"E2E provider setup failed: {provider.status} {provider.text()}")


def run_chat(page):
    seed_provider(page)
    page.goto(APP, wait_until="networkidle")
    page.wait_for_timeout(800)
    page.screenshot(path=str(OUT / "01_landed.png"), full_page=False)
    # type a question
    ta = page.locator("textarea").first
    ta.fill("find me papers on vision transformers")
    page.screenshot(path=str(OUT / "02_typed.png"), full_page=False)
    page.locator(".composer-send-btn").click()
    # wait for paper cards to appear (tool call round + final answer)
    page.wait_for_selector(".paper-card", timeout=20000)
    page.wait_for_timeout(2500)  # let final markdown stream in
    page.screenshot(path=str(OUT / "03_answered.png"), full_page=False)
    # inspect: is the textarea still present? (input-disappears bug)
    has_input = page.locator("textarea").count()
    has_send = page.locator(".composer-send-btn").count()
    print(f"POST_CHAT: textarea={has_input} send_btn={has_send}")
    print(f"LOGS:\n" + "\n".join(page.logs))  # type: ignore


def run_paper(page):
    page.goto(f"{APP}/paper/1706.03762", wait_until="networkidle")
    # wait for the PDF document to load + first page to lazy-render
    page.wait_for_selector(".pdf-page-canvas-wrap canvas", timeout=20000)
    page.wait_for_timeout(4000)  # let a few pages render + text extraction
    # scroll down a bit so more pages lazy-render
    page.evaluate("() => { const el = document.querySelector('.pdf-scroll'); if (el) el.scrollTop = 1600; }")
    page.wait_for_timeout(3000)
    page.screenshot(path=str(OUT / "10_paper_default.png"), full_page=False)
    canvases = page.locator(".pdf-page-canvas-wrap canvas").count()
    textlayer = page.locator(".pdf-textlayer span").count()
    divider = page.locator(".panel-divider").count()
    collapsed = page.locator(".sidebar-collapsed").count()
    print(f"PAPER: canvas_count={canvases} textlayer_spans={textlayer} divider={divider} sidebar_collapsed={collapsed}")
    # test zoom buttons
    page.screenshot(path=str(OUT / "11_paper_zoom100.png"), full_page=False)
    print(f"LOGS:\n" + "\n".join(page.logs))  # type: ignore


def main():
    scenario = sys.argv[1] if len(sys.argv) > 1 else "chat"
    with sync_playwright() as pw:
        page = new_page(pw, headless=True)
        try:
            if scenario == "chat" or scenario == "md":
                run_chat(page)
            elif scenario == "paper":
                run_paper(page)
            else:
                print("unknown scenario")
        finally:
            page._browser.close()  # type: ignore


if __name__ == "__main__":
    main()
