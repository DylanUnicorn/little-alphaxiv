"""Measure PDF-load perceived latency on /paper/<id>.

A/B rig: point APP_URL at the OLD-code origin (e.g. http://127.0.0.1:5173) and
the NEW-code origin (e.g. http://127.0.0.1:5180) and compare.

For each origin it runs a COLD visit (backend PDF cache + IDB cleared first)
then a WARM visit (reload, caches populated), and records three timings
relative to navigation start:

  loading_gone_ms  — ".pdf-loading" spinner disappeared
  first_canvas_ms   — first rendered <canvas> in the PDF column appeared
  status_gone_ms    — PaperView "Reading paper for context..." cleared
                      (proxy for chat-context full text being ready)

The OLD code clears `loading` only after full-text extraction of every page,
so on a WARM visit (text already cached in IDB) it STILL re-extracts and the
spinner stays up. The NEW code clears `loading` at getDocument resolve and
skips extraction when IDB has the text — so WARM should be near-instant.

Usage:
  APP_URL=http://127.0.0.1:5180 PYTHONUTF8=1 PYTHONIOENCODING=utf-8 \
    /c/Users/Delig/.conda/envs/Agent_env/python.exe tools/measure_pdf_load.py
"""
from __future__ import annotations

import os
import sys
import codecs
import time
import shutil
from pathlib import Path

from playwright.sync_api import sync_playwright

sys.stdout = codecs.getwriter("utf-8")(sys.stdout.buffer, errors="replace")
sys.stderr = codecs.getwriter("utf-8")(sys.stderr.buffer, errors="replace")

APP = os.environ.get("APP_URL", "http://127.0.0.1:5173").rstrip("/")
ARXIV_ID = "1706.03762"  # "Attention Is All You Need" — 15 pages, real arxiv fetch

# Backend on-disk PDF cache (same path as backend/app/routers/pdf.py default:
# backend/data/pdf_cache locally, /app/data/pdf_cache in Docker).
PDF_CACHE = Path(__file__).resolve().parent.parent / "backend" / "data" / "pdf_cache"


def clear_backend_pdf_cache(arxiv_id: str) -> None:
    p = PDF_CACHE / f"{arxiv_id}.pdf"
    if p.exists():
        p.unlink()


def clear_idb(page) -> None:
    """Delete the app's IndexedDB so no cached full_text / conversations remain."""
    page.goto(f"{APP}/", wait_until="domcontentloaded")
    page.evaluate(
        """() => new Promise((resolve) => {
            const req = indexedDB.deleteDatabase('little-alphaxiv');
            req.onsuccess = req.onerror = req.onblocked = () => resolve();
            setTimeout(resolve, 3000);
        })"""
    )


def measure_visit(page, label: str) -> dict:
    """Navigate to /paper/<id> and time the three UX milestones. Returns ms."""
    t0 = time.perf_counter()

    def ms() -> float:
        return round((time.perf_counter() - t0) * 1000)

    page.goto(f"{APP}/paper/{ARXIV_ID}", wait_until="domcontentloaded")

    # loading_gone: wait until the ".pdf-loading" spinner is absent from the DOM.
    try:
        page.wait_for_selector(".pdf-loading", state="detached", timeout=60000)
        loading_gone_ms = ms()
    except Exception:
        loading_gone_ms = -1  # never appeared / timed out

    # first_canvas: first rendered canvas inside the pdf column. We also wait
    # until it has a non-zero width so a placeholder doesn't count.
    try:
        page.wait_for_function(
            """() => {
                const c = document.querySelector('.pdf-page-canvas-wrap canvas');
                return c && c.width > 0 && c.height > 0;
            }""",
            timeout=60000,
        )
        first_canvas_ms = ms()
    except Exception:
        first_canvas_ms = -1

    # status_gone: PaperView's "Reading paper for context..." clears when the
    # chat-context full text is ready (cached hit or extraction done).
    try:
        page.wait_for_selector(".paper-status", state="detached", timeout=90000)
        status_gone_ms = ms()
    except Exception:
        status_gone_ms = -1

    result = {
        "label": label,
        "loading_gone_ms": loading_gone_ms,
        "first_canvas_ms": first_canvas_ms,
        "status_gone_ms": status_gone_ms,
    }
    print(f"  [{label}] {result}")
    return result


def main():
    print(f"APP_URL = {APP}  arxiv={ARXIV_ID}")
    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True)
        ctx = browser.new_context(viewport={"width": 1440, "height": 1000})
        page = ctx.new_page()
        logs: list[str] = []
        page.on("console", lambda m: logs.append(f"[{m.type}] {m.text}"))
        page.on("pageerror", lambda e: logs.append(f"[PAGEERROR] {e}"))

        # --- COLD: clear backend PDF cache + IDB, then measure ---
        clear_backend_pdf_cache(ARXIV_ID)
        clear_idb(page)
        cold = measure_visit(page, "COLD")

        # --- WARM: caches now populated (IDB has full_text, disk has PDF).
        # Reload and measure again. ---
        warm = measure_visit(page, "WARM")

        browser.close()

    print("\n=== SUMMARY ===")
    print(f"  cold: {cold}")
    print(f"  warm: {warm}")
    # Surface any page errors (e.g. pdf.js worker failures).
    errs = [l for l in logs if l.startswith("[PAGEERROR]") or "error" in l.lower()]
    if errs:
        print("\n=== CONSOLE ERRORS ===")
        for e in errs[:20]:
            print(" ", e)


if __name__ == "__main__":
    main()
