"""Playwright driver: screenshot every interface theme on chat + paper views.

Reuses the mock LLM at http://127.0.0.1:5050/v1 (no real key). Run with the
Agent_env interpreter and UTF-8 forced (see project memory):

    PYTHONUTF8=1 PYTHONIOENCODING=utf-8 \\
      /c/Users/Delig/.conda/envs/Agent_env/python.exe tools/drive_themes.py

Prereqs: backend on :8000 (backend/run.sh), frontend dev on :5173 (npm run dev),
mock LLM on :5050 (tools/mock_llm.py).

Output: tools/shots/themes/<theme>-{chat,paper}.png

The theme id list must stay in sync with frontend/src/themes.ts THEMES.
"""
from __future__ import annotations

import sys
import os
import codecs
from pathlib import Path

from playwright.sync_api import sync_playwright

# Force UTF-8 stdout so emoji/CJK in console logs don't crash GBK on Windows.
sys.stdout = codecs.getwriter("utf-8")(sys.stdout.buffer, errors="replace")
sys.stderr = codecs.getwriter("utf-8")(sys.stderr.buffer, errors="replace")

OUT = Path(__file__).parent / "shots" / "themes"
OUT.mkdir(parents=True, exist_ok=True)

# Override with APP_URL when running the worktree's vite on a non-default port
# (e.g. APP_URL=http://127.0.0.1:5174 python tools/drive_themes.py).
APP = os.environ.get("APP_URL", "http://127.0.0.1:5173")
MOCK_PROVIDER = {
    "name": "Mock",
    "base_url": os.environ.get("MOCK_URL", "http://127.0.0.1:5050/v1"),
    "api_key": "mock",
    "model": "mock-model",
}

# Keep in sync with frontend/src/themes.ts.
THEMES = [
    "dark", "light", "nord", "tokyo-night", "gruvbox-dark",
    "catppuccin-mocha", "solarized-dark", "solarized-light",
    "sepia", "dracula", "rose-pine",
]


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


def seed_provider(page):
    """Inject the mock provider into localStorage before app loads."""
    page.goto(f"{APP}/settings", wait_until="networkidle")
    page.evaluate(
        """(prov) => {
      const key = 'little-alphaxiv-settings';
      const cur = JSON.parse(localStorage.getItem(key) || '{}');
      const providers = cur.state?.providers || [];
      providers.push({ id: 'mock-prov', ...prov, is_default: true });
      cur.state = cur.state || {};
      cur.state.providers = providers;
      cur.state.defaultProviderId = 'mock-prov';
      localStorage.setItem(key, JSON.stringify(cur));
    }""",
        MOCK_PROVIDER,
    )


def set_theme(page, theme_id: str):
    """Persist the theme and apply it instantly via the data-theme attribute.
    Setting the attribute directly re-themes via CSS variables without a
    reload; the app's main.tsx only re-applies on store change, so this
    sticks across in-page navigation."""
    page.evaluate(
        """(t) => {
      const key = 'little-alphaxiv-settings';
      const cur = JSON.parse(localStorage.getItem(key) || '{}');
      cur.state = cur.state || {};
      cur.state.theme = t;
      localStorage.setItem(key, JSON.stringify(cur));
      document.documentElement.setAttribute('data-theme', t);
    }""",
        theme_id,
    )


def main():
    errors: list[str] = []
    with sync_playwright() as pw:
        page = new_page(pw, headless=True)
        try:
            # --- Seed provider + drive one chat to populate paper cards ---
            seed_provider(page)
            page.goto(APP, wait_until="networkidle")
            page.wait_for_timeout(800)
            ta = page.locator("textarea").first
            ta.fill("find me papers on vision transformers")
            page.locator("button:has-text('Send')").click()
            try:
                page.wait_for_selector(".paper-card", timeout=20000)
            except Exception:
                errors.append("chat: .paper-card never appeared (mock LLM down?)")
            page.wait_for_timeout(2500)  # let final markdown stream in

            # --- Sweep themes on the chat view ---
            for t in THEMES:
                set_theme(page, t)
                page.wait_for_timeout(450)  # let color transition settle
                page.screenshot(path=str(OUT / f"{t}-chat.png"), full_page=False)
                print(f"chat  : {t}")

            # --- Open the paper view once, then sweep themes ---
            page.goto(f"{APP}/paper/1706.03762", wait_until="networkidle")
            try:
                page.wait_for_selector(".pdf-page-canvas-wrap canvas", timeout=20000)
            except Exception:
                errors.append("paper: PDF canvas never appeared")
            page.wait_for_timeout(4000)  # let a few pages render + text extraction
            page.evaluate(
                "() => { const el = document.querySelector('.pdf-scroll'); if (el) el.scrollTop = 1600; }"
            )
            page.wait_for_timeout(2500)
            for t in THEMES:
                set_theme(page, t)
                page.wait_for_timeout(450)
                page.screenshot(path=str(OUT / f"{t}-paper.png"), full_page=False)
                canvases = page.locator(".pdf-page-canvas-wrap canvas").count()
                print(f"paper : {t}  (canvases={canvases})")

            # Surface any page errors captured during the run.
            page_errors = [l for l in page.logs if l.startswith("[PAGEERROR]")]  # type: ignore
            if page_errors:
                errors.extend(page_errors)
        finally:
            page._browser.close()  # type: ignore

    print(f"\nTHEMES_SHOT: {len(THEMES)} themes x 2 views = {len(THEMES) * 2} screenshots in {OUT}")
    if errors:
        print("ERRORS:")
        for e in errors:
            print(f"  - {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()
