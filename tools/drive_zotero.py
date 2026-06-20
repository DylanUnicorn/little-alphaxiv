"""Zotero integration smoke test (no real API key / no real Zotero needed).

Verifies the PDF-toolbar Zotero icon wires up to the ZoteroPanel overlay:
  1. The Zotero icon button (.zotero-btn) appears in the PDF toolbar.
  2. Clicking it opens the .zotero-panel overlay with a "Zotero" heading.
  3. The /api/zotero/status call resolves and the status chip populates
     (offline when no Zotero desktop is running) — backend proxy exercised.
  4. The three tabs (This paper / Library / Collections) exist.
  5. × and Esc close the panel.
  6. No uncaught page errors.

No localStorage/IDB seeding: the panel handles a null paper record (shows the
arxivId) and wait_for_selector survives the app's loopback-origin redirect,
whereas page.evaluate does not — so we avoid evaluate entirely.

Assumes the backend + frontend are up:
    cd backend && uvicorn app.main:app --host 127.0.0.1 --port 8000
    cd frontend && npm run dev
    conda run -n Agent_env python tools/drive_zotero.py
    # (or: APP_URL=http://localhost:5180 conda run -n Agent_env python tools/drive_zotero.py)
"""
import codecs, os, sys
from pathlib import Path
from playwright.sync_api import sync_playwright

sys.stdout = codecs.getwriter("utf-8")(sys.stdout.buffer, errors="replace")
APP = os.environ.get("APP_URL", "http://127.0.0.1:5173")
ARXIV = "2401.00001"
SHOTS = Path(__file__).parent / "shots_real"
SHOTS.mkdir(exist_ok=True)

ok = True
def check(cond, msg):
    global ok
    print(("  OK  " if cond else " FAIL ") + msg, flush=True)
    if not cond:
        ok = False


with sync_playwright() as pw:
    b = pw.chromium.launch(headless=True)
    page = b.new_context(viewport={"width": 1500, "height": 950}).new_page()
    logs = []
    page.on("console", lambda m: logs.append(m.text) if m.type == "error" else None)
    page.on("pageerror", lambda e: logs.append(f"PAGEERROR: {e}"))

    page.goto(f"{APP}/paper/{ARXIV}", wait_until="domcontentloaded")
    # Survives the loopback-origin redirect (waits across navigations).
    page.wait_for_selector(".pdf-toolbar", timeout=20000)

    zbtn = page.query_selector(".zotero-btn")
    check(zbtn is not None, "Zotero icon button present in PDF toolbar")

    zbtn.click()
    page.wait_for_selector(".zotero-panel", timeout=8000)
    heading = page.eval_on_selector(".zotero-head strong", "e=>e.textContent.trim()")
    check(heading == "Zotero", f'panel heading is "Zotero" (got "{heading}")')

    tabs = page.eval_on_selector_all(".zotero-tabs button", "els=>els.map(e=>e.textContent.trim())")
    check(tabs == ["This paper", "Library", "Collections"], f"three tabs present (got {tabs})")

    # status chip populates once /api/zotero/status resolves (offline is fine)
    page.wait_for_function(
        "()=>{const t=document.querySelector('.zotero-chip');return t&&t.textContent&&!t.textContent.includes('checking');}",
        timeout=20000,
    )
    chip = page.eval_on_selector(".zotero-chip", "e=>e.textContent.trim()")
    check(chip != "", f'status chip populated (got "{chip}")')

    page.screenshot(path=str(SHOTS / "zotero_panel.png"), full_page=False)
    print(f'  -- status chip: "{chip}"', flush=True)
    print(f'  -- screenshot: {SHOTS/"zotero_panel.png"}', flush=True)

    # close via ×
    page.click(".zotero-close")
    page.wait_for_selector(".zotero-panel", state="detached", timeout=5000)
    check(page.query_selector(".zotero-panel") is None, "x closes the panel")

    # reopen + close via Esc
    page.click(".zotero-btn")
    page.wait_for_selector(".zotero-panel", timeout=5000)
    page.keyboard.press("Escape")
    page.wait_for_selector(".zotero-panel", state="detached", timeout=5000)
    check(page.query_selector(".zotero-panel") is None, "Esc closes the panel")

    check(not any("PAGEERROR" in l for l in logs), f"no page errors (logs: {logs[:3]})")

    b.close()

print("\n" + ("PASS - Zotero smoke OK" if ok else "FAIL - see above"), flush=True)
sys.exit(0 if ok else 1)
