"""Playwright E2E regression: PDF scroll-position memory.

Guards two bugs (both shipped 2026-07-01 and fixed same day):
  1. The unmount save read degenerate (zero-height) rects during SPA
     navigation → computeScrollPos returned {page: numPages, frac: 0} →
     restore jumped to the last page. (Fixed by caching lastPosRef.)
  2. Stale {page: lastPage} entries written by bug #1 persisted in
     localStorage; the unmount-cache fix couldn't clear them, so opening a
     previously-broken paper STILL jumped to the last page. (Fixed by
     stamping a schema version `v:1` on saves; loadPdfScroll ignores
     versionless stale entries, auto-clearing them on first load.)

Flow per case: register → open a real multi-page arXiv paper → (optionally
seed stale data) → scroll with real mouse wheel to mid-doc → click Settings
(SPA nav) → browser-back (SPA nav) → assert restored position is mid-doc,
NOT the last page.

Requires: backend :8000 up, frontend :5173 up, arXiv reachable (PDF proxy).
Run: conda run -n Agent_env python tools/drive_scroll_spa.py
Exits 0 on pass, 1 on regression.
"""
from __future__ import annotations
import codecs, os, sys, time, json
from playwright.sync_api import sync_playwright

sys.stdout = codecs.getwriter("utf-8")(sys.stdout.buffer, errors="replace")
sys.stderr = codecs.getwriter("utf-8")(sys.stderr.buffer, errors="replace")

FRONT = os.environ.get("LAX_FRONT", "http://127.0.0.1:5173")
BACK = os.environ.get("LAX_BACK", "http://127.0.0.1:8000")
ARXIV = "1706.03762"  # Attention Is All You Need — 15 pages
KEY = f"lax-pdf-scroll:{ARXIV}"

def case(pw, label, seed_stale=None):
    browser = pw.chromium.launch(headless=True)
    ctx = browser.new_context(viewport={"width": 1440, "height": 900})
    page = ctx.new_page()
    u = f"scrolle2e_{int(time.time())%100000}_{label}"
    r = page.request.post(f"{BACK}/api/auth/register",
        data={"username": u, "email": f"{u}@example.com", "password": "testtest123"})
    assert r.ok, f"register failed: {r.status} {r.text()}"
    print(f"\n=== CASE {label} ===")

    # Seed stale data BEFORE opening the paper so PdfViewer's restore reads it.
    # (localStorage is per-origin; set it on the frontend origin first.)
    if seed_stale is not None:
        page.goto(FRONT, wait_until="domcontentloaded")
        page.evaluate(f"localStorage.setItem({KEY!r}, {json.dumps(json.dumps(seed_stale))})")
        print(f"  seeded stale: {seed_stale}")

    page.goto(f"{FRONT}/paper/{ARXIV}", wait_until="domcontentloaded")
    page.wait_for_selector(".pdf-page-wrap", timeout=45000)
    page.wait_for_selector('.pdf-page-wrap[data-rendered="1"]', timeout=45000)
    n = page.eval_on_selector_all(".pdf-scroll .pdf-page-wrap", "els => els.length")
    print(f"  PDF loaded: {n} pages")

    # If we seeded stale last-page data, assert the restore did NOT jump there.
    if seed_stale is not None:
        page.wait_for_timeout(2500)
        st = page.evaluate("document.querySelector('.pdf-scroll').scrollTop")
        maxst = page.evaluate("(()=>{const c=document.querySelector('.pdf-scroll');return c.scrollHeight-c.clientHeight;})()")
        is_last = st >= maxst - 200
        print(f"  after stale-restore: scrollTop={st:.0f} (max~{maxst:.0f}) >>> {'LAST PAGE (stale not cleared!)' if is_last else 'cleared/ignored stale'}")
        if is_last:
            browser.close(); return False

    # Scroll with real wheel events to land mid-doc (page ~12 of 15).
    box = page.eval_on_selector(".pdf-scroll", "el => { const r = el.getBoundingClientRect(); return {x: r.x + r.width/2, y: r.y + r.height/2}; }")
    page.mouse.move(box["x"], box["y"])
    for _ in range(40):
        page.mouse.wheel(0, 300)
    page.wait_for_timeout(900)
    saved = page.evaluate(f"localStorage.getItem({KEY!r})")
    print(f"  after wheel scroll: saved={saved}")

    # SPA nav to Settings (sidebar collapsed in paper view; 4th .icon-btn = ⚙).
    page.locator(".icon-btn").nth(3).click()
    page.wait_for_timeout(500)
    # SPA nav back via browser history.
    page.go_back()
    page.wait_for_selector(".pdf-page-wrap", timeout=45000)
    page.wait_for_selector('.pdf-page-wrap[data-rendered="1"]', timeout=45000)
    page.wait_for_timeout(3000)
    restored = page.evaluate("document.querySelector('.pdf-scroll').scrollTop")
    maxst = page.evaluate("(()=>{const c=document.querySelector('.pdf-scroll');return c.scrollHeight-c.clientHeight;})()")
    is_last = restored >= maxst - 50
    print(f"  after SPA settings+back: scrollTop={restored:.0f} (max~{maxst:.0f}) >>> {'LAST PAGE (REGRESSION)' if is_last else 'mid-doc OK'}")
    browser.close()
    return not is_last

def main():
    with sync_playwright() as pw:
        ok = True
        # Case 1: fresh, scroll, SPA — the original unmount-bug regression.
        ok &= case(pw, "fresh_scroll_spa", seed_stale=None)
        # Case 2: stale {page: lastPage} from the buggy version — must be
        # ignored (not restored to the last page).
        ok &= case(pw, "stale_ignored", seed_stale={"page": 15, "frac": 0})
    print("\n" + ("ALL PASS" if ok else "FAIL"))
    sys.exit(0 if ok else 1)

if __name__ == "__main__":
    main()
