"""E2E: register → upload a local PDF → PaperView → chat with the mock LLM.

Verifies the Open Local Paper flow end-to-end: the sidebar button opens the
dialog, a PDF upload creates a user-private paper, PaperView loads it, and a
chat turn gets a mock-LLM reply. Needs all three servers up (backend :8000,
frontend :5173, mock LLM :5050).

Usage: python drive_local_paper_upload.py
"""
from __future__ import annotations

import codecs
import json
import sys
import tempfile
from pathlib import Path

from playwright.sync_api import sync_playwright

# Force UTF-8 stdout so emoji/CJK in console logs don't crash GBK on Windows.
sys.stdout = codecs.getwriter("utf-8")(sys.stdout.buffer, errors="replace")
sys.stderr = codecs.getwriter("utf-8")(sys.stderr.buffer, errors="replace")

OUT = Path(__file__).parent / "shots"
OUT.mkdir(exist_ok=True)

APP = "http://127.0.0.1:5173"
BACK = "http://127.0.0.1:8000"
E2E_USER = "e2e_localpaper"
E2E_PASS = "testtest123"
MOCK_PROVIDER = {
    "name": "Mock",
    "base_url": "http://127.0.0.1:5050/v1",
    "api_key": "mock",
    "model": "mock-model",
}

# Minimal 1-page PDF. pdf.js tolerates a rough xref via recovery, so this is
# enough for getDocument() to succeed and PdfViewer to render a blank page.
MINIMAL_PDF = (
    b"%PDF-1.4\n"
    b"1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n"
    b"2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n"
    b"3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>endobj\n"
    b"xref\n0 4\n0000000000 65535 f \n0000000010 00000 n \n"
    b"0000000053 00000 n \n0000000096 00000 n \n"
    b"trailer<</Size 4/Root 1 0 R>>\nstartxref 0\n%%EOF"
)


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


def seed(page):
    """Register + login the e2e user and add the mock provider via the API."""
    page.request.post(
        f"{BACK}/api/auth/register",
        data=json.dumps({
            "username": E2E_USER,
            "email": f"{E2E_USER}@example.com",
            "password": E2E_PASS,
        }),
        headers={"Content-Type": "application/json"},
    )
    page.request.post(
        f"{BACK}/api/auth/login",
        data=json.dumps({"username": E2E_USER, "password": E2E_PASS}),
        headers={"Content-Type": "application/json"},
    )
    page.request.post(
        f"{BACK}/api/providers",
        data=json.dumps({"id": "mock-prov-localpaper", **MOCK_PROVIDER, "is_default": True}),
        headers={"Content-Type": "application/json"},
    )


def main():
    with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as f:
        f.write(MINIMAL_PDF)
        pdf_path = f.name
    with sync_playwright() as pw:
        page = new_page(pw, headless=True)
        try:
            seed(page)
            page.goto(APP, wait_until="domcontentloaded")
            page.wait_for_timeout(800)

            # Open the dialog from the sidebar.
            page.locator("text=Open Local Paper").first.click()
            page.wait_for_selector(".lpd-card", timeout=5000)
            page.screenshot(path=str(OUT / "lpd_01_dialog.png"))

            # Upload the PDF (set on the hidden file input directly — Playwright
            # can't drive the native file dialog, but set_input_files dispatches
            # the change event the React onChange listens for).
            page.set_input_files("input[type=file]", pdf_path)
            page.wait_for_selector(".lpd-meta", timeout=10000)
            page.screenshot(path=str(OUT / "lpd_02_meta.png"))

            # Looks good -> PaperView.
            page.locator("text=Looks good, open paper").click()
            page.wait_for_url(lambda u: "/paper/" in u, timeout=15000)
            page.wait_for_timeout(2500)
            page.screenshot(path=str(OUT / "lpd_03_paperview.png"))

            # A chat turn against the mock LLM.
            ta = page.locator("textarea").first
            ta.fill("What is this paper about?")
            page.locator(".composer-send-btn").click()
            page.wait_for_timeout(3000)
            page.screenshot(path=str(OUT / "lpd_04_replied.png"))

            print(f"URL: {page.url}")
            print(f"LOGS:\n" + "\n".join(page.logs))  # type: ignore
        finally:
            page._browser.close()  # type: ignore
            Path(pdf_path).unlink(missing_ok=True)


if __name__ == "__main__":
    main()
