"""Playwright E2E: the PDF actually switches when you switch papers (SPA nav).

Regression for the stale-`pdfUrlOverride` bug in PaperView. The override that
tells PdfViewer which endpoint to load a non-arXiv PDF from (uploaded / Zotero /
OA) was never CLEARED when switching to a plain arXiv paper (the if/else had no
`default` branch). So after viewing an uploaded paper X and then switching to an
arXiv paper A, PdfViewer kept loading X's PDF — the PDF no longer matched the
chat / annotation store, and highlights drawn on the wrong PDF got saved to A's
paper_id with X's coordinates (ghost annotations on blank areas of the real A).

A full page.goto can't reproduce this: a fresh load resets `pdfUrlOverride` to
undefined, so there's no stale value to leak. The bug only fires on an IN-APP
(SPA) paper switch, where the previous paper's override survives the route
change. So this driver MUST navigate via pushState+popstate (synthetic SPA nav),
exactly the lesson from drive_scroll_spa.py — goto-based tests falsely pass.

Flow:
  1. Generate a 1-page PDF (pypdf), register + log in (cookie set).
  2. Upload the PDF via the API → uploaded paper X (source="upload",
     paper_id `sha256:<hash>`). Loading X serves X's 1-page PDF.
  3. goto /paper/X (full load) → pagecount settles at 1. The live React state now
     holds pdfUrlOverride = paperUploadUrl(X).
  4. SPA-navigate to /paper/1706.03762 (pushState + popstate → React Router).
     - BUG: override never cleared → PdfViewer loads X again → pagecount stays 1.
     - FIX: override cleared (resolvePdfSource default branch) + the pdfUrlForId
       guard waits for the resolution → loads the real arXiv PDF → pagecount > 1.
  5. Assert pagecount becomes a number != 1 (the PDF actually switched).
  6. SPA-navigate back to /paper/X → pagecount returns to 1 (round-trip).

Needs: backend :8000, frontend :5173, arXiv reachable (PDF proxy fetches it),
Agent_env (pypdf). No mock LLM (no chat). Exits 0 on pass, 1 on regression.
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

OUT = Path(__file__).parent / "shots_pdf_switch"
OUT.mkdir(exist_ok=True)

FRONT = os.environ.get("LAX_FRONT", "http://127.0.0.1:5173")
BACK = os.environ.get("LAX_BACK", "http://127.0.0.1:8000")

USERNAME = f"e2e_{int(time.time()) % 100000}"
PASSWORD = "testtest123"

# "Attention Is All You Need" — stable on arXiv, ~15 pages (>1 so the assertion
# "pagecount != 1" is meaningful). Any reliably-fetchable arXiv paper works.
ARXIV_ID = "1706.03762"


def make_one_page_pdf() -> bytes:
    """A minimal valid 1-page PDF so the uploaded paper has a distinct page
    count from the arXiv paper (1 vs ~15)."""
    from pypdf import PdfWriter
    w = PdfWriter()
    w.add_blank_page(width=200, height=200)
    import io
    buf = io.BytesIO()
    w.write(buf)
    return buf.getvalue()


def register_and_login(page):
    page.goto(f"{FRONT}/login", wait_until="domcontentloaded")
    page.wait_for_selector("input", timeout=10000)
    # Register mode (registration requires a valid email — added with the
    # password-recovery feature; the older drive_auth_persistence.py predates it).
    page.locator("text=Need an account? Register").click()
    page.locator("input[type=text]").fill(USERNAME)
    page.locator("input[type=email]").fill(f"{USERNAME}@example.com")
    page.locator("input[type=password]").fill(PASSWORD)
    page.locator("button.login-submit").click()
    # The login page hard-navigates to "/" on success; wait for the app.
    page.wait_for_url(f"{FRONT}/", timeout=15000)
    page.wait_for_selector(".app-main, .chat-empty, textarea", timeout=15000)
    print(f"REGISTER+LOGIN OK as {USERNAME}")


def upload_paper(page, pdf_bytes):
    """Upload via the API; the browser context carries the session cookie.
    Returns the uploaded paper's id (`sha256:<hex>`)."""
    resp = page.request.post(
        f"{BACK}/api/paper-upload",
        multipart={
            "file": {"name": "e2e.pdf", "mimeType": "application/pdf", "buffer": pdf_bytes},
            "title": "E2E Upload Test",
        },
    )
    assert resp.ok, f"upload failed: {resp.status} {resp.text()}"
    data = resp.json()
    pid = data["paper_id"]
    print(f"UPLOAD OK -> paper_id={pid} source={data.get('source')}")
    return pid


def page_count(page):
    """Current PdfViewer page count, or 0 while loading (shows '…')."""
    try:
        txt = page.locator(".pdf-pagecount").inner_text(timeout=3000)
    except Exception:
        return 0
    m = re.search(r"(\d+)", txt)
    return int(m.group(1)) if m else 0


def wait_for_count(page, want=None, *, not_val=None, timeout=60.0, stable_for=1.0):
    """Poll pagecount until it equals `want` (if given) AND != `not_val` (if
    given), stable for `stable_for` seconds. Returns the stable count."""
    t0 = time.time()
    last = 0
    stable_since = 0.0
    while time.time() - t0 < timeout:
        n = page_count(page)
        now = time.time()
        ok = n > 0
        if want is not None and n != want:
            ok = False
        if not_val is not None and n == not_val:
            ok = False
        if ok:
            if n == last:
                if now - stable_since >= stable_for:
                    return n
            else:
                last = n
                stable_since = now
        else:
            last = 0
            stable_since = now
        time.sleep(0.4)
    raise AssertionError(
        f"pagecount never settled to want={want} not_val={not_val} within {timeout}s "
        f"(last={page_count(page)})"
    )


def spa_navigate(page, path):
    """In-app SPA navigation: pushState + a synthetic popstate. React Router v6
    BrowserRouter listens to popstate, so this re-renders the route WITHOUT a
    full page load — which is exactly what preserves the stale pdfUrlOverride
    and reproduces the bug. (page.goto would reset state and hide the bug.)"""
    page.evaluate(
        """(p) => {
            window.history.pushState({}, '', p);
            window.dispatchEvent(new PopStateEvent('popstate'));
        }""",
        path,
    )


def main():
    pdf_bytes = make_one_page_pdf()

    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True)
        ctx = browser.new_context(viewport={"width": 1440, "height": 900})
        page = ctx.new_page()
        logs: list[str] = []
        page.on("console", lambda m: logs.append(f"[{m.type}] {m.text}"))
        page.on("pageerror", lambda e: logs.append(f"[PAGEERROR] {e}"))

        register_and_login(page)
        x_id = upload_paper(page, pdf_bytes)

        # 3. Full-load the uploaded paper. Pagecount must settle at 1.
        page.goto(f"{FRONT}/paper/{x_id}", wait_until="domcontentloaded")
        n_x = wait_for_count(page, want=1, timeout=60.0)
        print(f"STEP 3 OK: uploaded paper X pagecount={n_x}")
        page.screenshot(path=str(OUT / "01_upload_paper.png"), full_page=False)

        # 4. SPA-navigate to the arXiv paper (NO full load — preserves stale
        #    override). The fix must load the real arXiv PDF (pagecount > 1);
        #    the bug keeps loading X (pagecount stays 1).
        spa_navigate(page, f"/paper/{ARXIV_ID}")
        try:
            n_a = wait_for_count(page, not_val=1, timeout=90.0)
        except AssertionError:
            page.screenshot(path=str(OUT / "02_arxiv_FAIL.png"), full_page=False)
            print("REGRESSION: after SPA switch to arXiv paper, pagecount stayed at 1")
            print("(PdfViewer loaded the previous uploaded paper's PDF — stale override)")
            print("--- browser logs ---")
            for ln in logs[-30:]:
                print(ln)
            return 1
        if n_a == 1:
            page.screenshot(path=str(OUT / "02_arxiv_FAIL.png"), full_page=False)
            print("REGRESSION: arXiv paper pagecount is 1 (== uploaded paper's) — PDF did not switch")
            return 1
        print(f"STEP 4 OK: SPA switch to arXiv paper loaded a different PDF, pagecount={n_a}")
        page.screenshot(path=str(OUT / "02_arxiv_paper.png"), full_page=False)

        # 5. SPA-navigate back to the uploaded paper. Round-trip must also work
        #    (override re-resolves to upload → loads X → 1 page).
        spa_navigate(page, f"/paper/{x_id}")
        n_x2 = wait_for_count(page, want=1, timeout=60.0)
        print(f"STEP 5 OK: SPA switch back to uploaded paper, pagecount={n_x2}")
        page.screenshot(path=str(OUT / "03_back_to_upload.png"), full_page=False)

        print("PASS: PDF switched correctly across SPA paper switches (no stale override)")
        return 0


if __name__ == "__main__":
    sys.exit(main())
