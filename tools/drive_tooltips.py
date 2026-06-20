"""Playwright driver for the speech-bubble tooltip overhaul (keyless).

Verifies against the mock LLM at http://127.0.0.1:5050/v1 (no real key).

The native `title=` hover boxes are gone app-wide; every icon/button hover now
shows a `.tooltip-bubble` (position:fixed speech bubble) the instant the cursor
enters the trigger. This driver exercises the user's named example (the gear
icon in the collapsed sidebar → "Settings") plus a representative spread
(new-chat / expand in the collapsed strip, the composer attach button, the
context ring), then re-runs the gear check under the light theme to confirm the
bubble picks up theme tokens.

Prereqs: backend on :8000, frontend on :5173, mock on :5050.
Usage:    python drive_tooltips.py
"""
from __future__ import annotations

import codecs
import os
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright, TimeoutError as PWTimeout

# Force UTF-8 stdout so emoji/CJK in console logs don't crash GBK on Windows.
# Guarded: under `conda run` stdout may already be a raw buffer with no .buffer.
def _utf8(stream):
    try:
        return codecs.getwriter("utf-8")(stream.buffer, errors="replace")
    except (AttributeError, ValueError):
        return stream


sys.stdout = _utf8(sys.stdout)
sys.stderr = _utf8(sys.stderr)

OUT = Path(__file__).parent / "shots"
OUT.mkdir(exist_ok=True)
APP = os.environ.get("APP_URL", "http://127.0.0.1:5173")
MOCK_PORT = os.environ.get("MOCK_PORT", "5050")
MOCK_PROVIDER = {
    "name": "Mock",
    "base_url": f"http://127.0.0.1:{MOCK_PORT}/v1",
    "api_key": "mock",
    "model": "zai-org/glm-5.2",
}

failures: list[str] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    tag = "PASS" if ok else "FAIL"
    print(f"[{tag}] {name}{(' — ' + detail) if detail else ''}")
    if not ok:
        failures.append(name)


def new_page(pw):
    browser = pw.chromium.launch(headless=True)
    ctx = browser.new_context(viewport={"width": 1440, "height": 900})
    page = ctx.new_page()
    logs: list[str] = []
    page.on("console", lambda m: logs.append(f"[{m.type}] {m.text}"))
    page.on("pageerror", lambda e: logs.append(f"[PAGEERROR] {e}"))
    page.logs = logs  # type: ignore
    page._browser = browser  # type: ignore
    return page


def seed_provider(page, theme: str = "dark"):
    page.goto(f"{APP}/settings", wait_until="domcontentloaded")
    page.evaluate(
        """([prov, theme]) => {
      const key = 'little-alphaxiv-settings';
      const cur = JSON.parse(localStorage.getItem(key) || '{}');
      const providers = cur.state?.providers || [];
      providers.push({ id: 'mock-prov', ...prov, is_default: true });
      cur.state = cur.state || {};
      cur.state.providers = providers;
      cur.state.defaultProviderId = 'mock-prov';
      cur.state.providerModels = {};
      cur.state.theme = theme;
      localStorage.setItem(key, JSON.stringify(cur));
    }""",
        [MOCK_PROVIDER, theme],
    )


def active_bubble_text(page) -> str:
    """Text of the one visible (data-show=true) tooltip bubble."""
    return page.locator(".tooltip-bubble[data-show='true']").first.inner_text().strip()


def hover_check(page, name: str, selector: str, expected: str, shot: str, idx: int = 0):
    try:
        page.locator(selector).nth(idx).hover()
        page.wait_for_selector(".tooltip-bubble[data-show='true']", timeout=2500)
        page.wait_for_timeout(120)  # let the 80ms fade + paint settle
        txt = active_bubble_text(page)
        side = page.locator(".tooltip-bubble[data-show='true']").first.get_attribute("data-side")
        ok = expected in txt
        check(name, ok, f"got='{txt}' side={side}")
        page.screenshot(path=str(OUT / shot))
    except Exception as e:  # noqa: BLE001
        check(name, False, f"exc={e!r}")
    # Move the cursor off the trigger so the bubble hides before the next check.
    page.mouse.move(1, 1)
    page.wait_for_timeout(120)


def collapse_sidebar(page):
    page.locator(".icon-btn.head-collapse").first.click()
    page.wait_for_selector(".sidebar-collapsed", timeout=3000)
    page.wait_for_timeout(150)


def main():
    with sync_playwright() as pw:
        page = new_page(pw)
        try:
            # ---- Dark theme pass ----
            seed_provider(page, "dark")
            page.goto(APP, wait_until="domcontentloaded")
            page.wait_for_selector(".ctx-ring-btn", timeout=10000)
            page.wait_for_timeout(400)

            collapse_sidebar(page)

            # The user's named example: gear icon → "Settings".
            hover_check(page, "1 gear → Settings (dark)", ".sidebar-collapsed .icon-btn", "Settings", "tip_01_gear_dark.png", idx=2)
            hover_check(page, "2 new-chat → New chat", ".sidebar-collapsed .icon-btn", "New chat", "tip_02_newchat.png", idx=1)
            hover_check(page, "3 expand → Expand sidebar", ".sidebar-collapsed .icon-btn", "Expand sidebar", "tip_03_expand.png", idx=0)

            # Composer + context ring (still rendered with the sidebar collapsed).
            hover_check(page, "4 attach → Attach image", ".composer-attach-btn", "Attach image", "tip_04_attach.png")
            hover_check(page, "5 ctx-ring → Context usage", ".ctx-ring-btn", "Context usage:", "tip_05_ctxring.png")

            # ---- Light theme pass (confirm the bubble picks up light tokens) ----
            page.evaluate(
                """() => {
      const key = 'little-alphaxiv-settings';
      const cur = JSON.parse(localStorage.getItem(key) || '{}');
      cur.state = cur.state || {};
      cur.state.theme = 'light';
      localStorage.setItem(key, JSON.stringify(cur));
    }"""
            )
            page.reload(wait_until="domcontentloaded")
            page.wait_for_selector(".ctx-ring-btn", timeout=10000)
            page.wait_for_timeout(400)
            collapse_sidebar(page)
            hover_check(page, "6 gear → Settings (light)", ".sidebar-collapsed .icon-btn", "Settings", "tip_06_gear_light.png", idx=2)

            print("\n--- console logs (tail) ---")
            print("\n".join(page.logs[-20:]))  # type: ignore
        finally:
            page._browser.close()  # type: ignore

    n_fail = len(failures)
    print(f"\n{'PASS' if n_fail == 0 else 'FAIL'}: {n_fail} check(s) failed{'' if not failures else ' — ' + ', '.join(failures)}")
    sys.exit(1 if n_fail else 0)


if __name__ == "__main__":
    main()
