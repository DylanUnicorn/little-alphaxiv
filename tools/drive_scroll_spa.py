"""Playwright E2E regression: PDF scroll-position memory survives SPA navigation.

The bug this guards against: the unmount save read degenerate (zero-height)
rects during SPA navigation (the .pdf-scroll container has already collapsed
by React-cleanup time), so computeScrollPos returned {page: numPages, frac: 0},
overwriting the real position — and restore jumped to the LAST page every time.

Flow: register → open a real multi-page arXiv paper → scroll with real mouse
wheel to a mid-doc page → click Settings (SPA nav) → browser-back (SPA nav) →
assert the restored scroll position is mid-doc, NOT the last page.

Requires: backend :8000 up, frontend :5173 up (serves the real PdfViewer), and
arXiv reachable (the /api/pdf proxy fetches + caches the PDF). No mock LLM
needed (this exercises the PDF viewer, not chat).

Run: conda run -n Agent_env python tools/drive_scroll_spa.py
Exits 0 on pass, 1 on fail (last-page regression).
"""
from __future__ import annotations
import codecs, os, sys, time
from playwright.sync_api import sync_playwright

sys.stdout = codecs.getwriter("utf-8")(sys.stdout.buffer, errors="replace")
sys.stderr = codecs.getwriter("utf-8")(sys.stderr.buffer, errors="replace")

FRONT = os.environ.get("LAX_FRONT", "http://127.0.0.1:5173")
BACK = os.environ.get("LAX_BACK", "http://127.0.0.1:8000")
ARXIV = "1706.03762"  # Attention Is All You Need — 15 pages, reliably on arXiv

def main():
    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True)
        ctx = browser.new_context(viewport={"width": 1440, "height": 900})
        page = ctx.new_page()
        u = f"scrolle2e_{int(time.time())%100000}"
        r = page.request.post(f"{BACK}/api/auth/register",
            data={"username": u, "email": f"{u}@example.com", "password": "testtest123"})
        assert r.ok, f"register failed: {r.status} {r.text()}"

        page.goto(f"{FRONT}/paper/{ARXIV}", wait_until="domcontentloaded")
        page.wait_for_selector(".pdf-page-wrap", timeout=45000)
        page.wait_for_selector('.pdf-page-wrap[data-rendered="1"]', timeout=45000)
        n = page.eval_on_selector_all(".pdf-scroll .pdf-page-wrap", "els => els.length")
        print(f"PDF loaded: {n} pages")

        # Scroll with real wheel events to land mid-doc (page ~12 of 15).
        box = page.eval_on_selector(".pdf-scroll", "el => { const r = el.getBoundingClientRect(); return {x: r.x + r.width/2, y: r.y + r.height/2}; }")
        page.mouse.move(box["x"], box["y"])
        for _ in range(40):
            page.mouse.wheel(0, 300)
        page.wait_for_timeout(900)
        scroll_after = page.evaluate("document.querySelector('.pdf-scroll').scrollTop")
        saved_after = page.evaluate(f"localStorage.getItem('lax-pdf-scroll:{ARXIV}')")
        print(f"AFTER WHEEL SCROLL: scrollTop={scroll_after:.0f} saved={saved_after}")

        # SPA nav to Settings (sidebar is collapsed in paper view; the 4th
        # .icon-btn is the ⚙ settings button: » + 📂 ⚙).
        page.locator(".icon-btn").nth(3).click()
        page.wait_for_timeout(500)
        saved_settings = page.evaluate(f"localStorage.getItem('lax-pdf-scroll:{ARXIV}')")
        print(f"AT SETTINGS: saved={saved_settings}")

        # SPA nav back via browser history (React Router handles it in-app).
        page.go_back()
        page.wait_for_selector(".pdf-page-wrap", timeout=45000)
        page.wait_for_selector('.pdf-page-wrap[data-rendered="1"]', timeout=45000)
        page.wait_for_timeout(3000)
        restored = page.evaluate("document.querySelector('.pdf-scroll').scrollTop")
        maxst = page.evaluate("(()=>{const c=document.querySelector('.pdf-scroll');return c.scrollHeight-c.clientHeight;})()")
        print(f"AFTER SPA BACK: scrollTop={restored:.0f} (max ~{maxst:.0f})")

        # ASSERT: restored position must be mid-doc, NOT the last page.
        # The bug would push scrollTop to within ~50px of max (last page).
        is_last = restored >= maxst - 50
        if is_last:
            print(f"FAIL: restore jumped to the last page (scrollTop {restored:.0f} ≈ max {maxst:.0f})")
            browser.close()
            sys.exit(1)
        # And the saved value must not have been corrupted to the last page.
        import json
        saved_obj = json.loads(saved_settings) if saved_settings else {}
        if saved_obj.get("page") == n:
            print(f"FAIL: saved page corrupted to last page ({saved_obj})")
            browser.close()
            sys.exit(1)
        print(f"PASS: restored mid-doc (page {saved_obj.get('page')} of {n}), not the last page")
        browser.close()

if __name__ == "__main__":
    main()
