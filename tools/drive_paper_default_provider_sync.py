"""E2E regression: an unstarted paper chat follows a changed default provider.

Run with the backend (:8000), mock LLM (:5050), and a Vite frontend running.
The scenario deliberately uses SPA navigation to Settings and browser-history
return, so the empty paper conversation remains in memory.
"""
from __future__ import annotations

import codecs
import json
import os
import sys
import time

from playwright.sync_api import Page, sync_playwright

sys.stdout = codecs.getwriter("utf-8")(sys.stdout.buffer, errors="replace")
sys.stderr = codecs.getwriter("utf-8")(sys.stderr.buffer, errors="replace")

FRONT = os.environ.get("LAX_FRONT", "http://127.0.0.1:5174")
BACK = os.environ.get("LAX_BACK", "http://127.0.0.1:8000")
USERNAME = f"provider_sync_{int(time.time() * 1000)}"
PASSWORD = "testtest123"


def register(page: Page) -> None:
    page.goto(f"{FRONT}/login", wait_until="domcontentloaded")
    page.get_by_text("Need an account? Register").click()
    page.locator("input[type=text]").fill(USERNAME)
    page.locator("input[type=email]").fill(f"{USERNAME}@example.com")
    page.locator("input[type=password]").fill(PASSWORD)
    page.locator("button.login-submit").click()
    page.wait_for_url(f"{FRONT}/", timeout=15_000)


def add_provider(page: Page, provider_id: str, model: str, is_default: bool) -> None:
    response = page.request.post(
        f"{BACK}/api/providers",
        data=json.dumps({
            "id": provider_id,
            "name": provider_id,
            "base_url": "http://127.0.0.1:5050/v1",
            "api_key": "mock",
            "model": model,
            "is_default": is_default,
        }),
        headers={"Content-Type": "application/json"},
    )
    assert response.ok, f"failed to add {provider_id}: {response.status} {response.text()}"


def selected_model(page: Page) -> str:
    page.wait_for_selector(".chat-composer .model-pill-input, .chat-composer .model-pill-name")
    input_box = page.locator(".chat-composer .model-pill-input")
    if input_box.count():
        return input_box.input_value()
    return page.locator(".chat-composer .model-pill-name").inner_text()


def main() -> None:
    provider_a = f"provider-a-{USERNAME}"
    provider_b = f"provider-b-{USERNAME}"
    model_a = "model-a"
    model_b = "model-b"

    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 1440, "height": 900})
        try:
            register(page)
            add_provider(page, provider_a, model_a, is_default=True)
            add_provider(page, provider_b, model_b, is_default=False)

            page.goto(f"{FRONT}/paper/1706.03762", wait_until="domcontentloaded")
            page.wait_for_function("() => document.querySelector('.chat-composer') !== null")
            assert selected_model(page) == model_a

            # PaperView intentionally collapses the sidebar. Its fourth icon
            # is Settings; clicking it keeps the SPA store (and empty thread)
            # alive, unlike a browser refresh.
            page.locator("aside.sidebar-collapsed .icon-btn").nth(3).click()
            page.wait_for_url(f"{FRONT}/settings", timeout=10_000)
            provider_b_card = page.locator(".provider-item", has_text=provider_b)
            provider_b_card.get_by_role("button", name="set default").click()
            page.wait_for_timeout(250)

            providers = page.request.get(f"{BACK}/api/providers").json()
            assert next(p for p in providers if p["id"] == provider_b)["is_default"] is True

            page.go_back(wait_until="domcontentloaded")
            page.wait_for_url("**/paper/1706.03762**", timeout=10_000)
            page.wait_for_function(
                "model => { const input = document.querySelector('.chat-composer .model-pill-input'); "
                "const label = document.querySelector('.chat-composer .model-pill-name'); "
                "return input?.value === model || label?.textContent === model; }",
                arg=model_b,
                timeout=10_000,
            )
            assert selected_model(page) == model_b
            print("PAPER DEFAULT PROVIDER SYNC OK")
        finally:
            browser.close()


if __name__ == "__main__":
    main()
