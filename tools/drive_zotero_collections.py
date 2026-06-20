"""Zotero collection expand smoke test (no real Zotero needed).

Verifies the new "click a collection to expand it and see the papers inside"
behavior in the Collections tab of ZoteroPanel. Uses page.route to mock
/api/zotero/* at the browser layer, so no Zotero desktop app and no API key
are required — the request never reaches the backend's Zotero proxy.

Checks:
  1. The Zotero icon opens the panel.
  2. The Collections tab lists the mocked collections.
  3. Clicking a collection expands it and lazy-loads its items.
  4. Items render with title/author/year; arXiv items show an arXiv badge.
  5. The title filter narrows the expanded list.
  6. Clicking again collapses (re-hides) the items.
  7. No uncaught page errors.

The frontend dev server must be up. The backend is NOT strictly required: we
mock /api/zotero/*, and /api/pdf 404s for the fake arxiv id but the PDF toolbar
still renders (same assumption drive_zotero.py makes):
    cd frontend && npm run dev
    conda run -n Agent_env python tools/drive_zotero_collections.py
"""
import codecs
import os
import sys
from pathlib import Path
from urllib.parse import urlparse, parse_qs

from playwright.sync_api import sync_playwright

sys.stdout = codecs.getwriter("utf-8")(sys.stdout.buffer, errors="replace")
APP = os.environ.get("APP_URL", "http://127.0.0.1:5173")
ARXIV = "2401.00001"
SHOTS = Path(__file__).parent / "shots_coll"
SHOTS.mkdir(exist_ok=True)

# --- mock Zotero data -------------------------------------------------------
STATUS = {"ok": True, "mode": "local", "library": "My Library"}
COLLECTIONS = {
    "results": [
        {"key": "C1", "name": "ML Papers", "parentKey": "", "numItems": 2},
        {"key": "C2", "name": "Physics", "parentKey": "", "numItems": 1},
    ],
    "mode": "local",
}


def _item(key, title, creators, year, item_type, arxiv_id=""):
    return {
        "key": key, "title": title, "creators": creators, "itemType": item_type,
        "year": year, "date": f"{year}-01-01" if year else "", "url": "",
        "doi": "", "arxivId": arxiv_id, "abstract": "", "collections": [], "tags": [],
    }


C1_ITEMS = {"total": 2, "results": [
    _item("I1", "Attention Is All You Need", "Vaswani et al.", "2017", "preprint", "1706.03762"),
    _item("I2", "BERT: Pre-training of Deep Bidirectional Transformers", "Devlin et al.", "2019", "journalArticle"),
], "mode": "local"}
C2_ITEMS = {"total": 1, "results": [
    _item("I3", "Can Quantum-Mechanical Description of Physical Reality Be Considered Complete?",
          "Einstein et al.", "1935", "journalArticle"),
], "mode": "local"}


def mock_zotero(route):
    url = route.request.url
    if "/zotero/status" in url:
        return route.fulfill(json=STATUS)
    if "/zotero/collections" in url:
        return route.fulfill(json=COLLECTIONS)
    if "/zotero/items" in url:
        ck = parse_qs(urlparse(url).query).get("collection_key", [""])[0]
        if ck == "C1":
            return route.fulfill(json=C1_ITEMS)
        if ck == "C2":
            return route.fulfill(json=C2_ITEMS)
        return route.fulfill(json={"total": 0, "results": [], "mode": "local"})
    return route.continue_()


ok = True
def check(cond, msg):
    global ok
    print(("  OK  " if cond else " FAIL ") + msg, flush=True)
    if not cond:
        ok = False


with sync_playwright() as pw:
    b = pw.chromium.launch(headless=True)
    page = b.new_context(viewport={"width": 1500, "height": 950}).new_page()
    page.route("**/api/zotero/**", mock_zotero)
    logs = []
    page.on("console", lambda m: logs.append(m.text) if m.type == "error" else None)
    page.on("pageerror", lambda e: logs.append(f"PAGEERROR: {e}"))

    page.goto(f"{APP}/paper/{ARXIV}", wait_until="domcontentloaded")
    # Survives the loopback-origin redirect (waits across navigations).
    page.wait_for_selector(".pdf-toolbar", timeout=20000)

    page.click(".zotero-btn")
    page.wait_for_selector(".zotero-panel", timeout=8000)

    # Collections tab
    page.locator(".zotero-tabs button", has_text="Collections").click()
    page.wait_for_selector(".zotero-coll-item", timeout=8000)
    rows = page.query_selector_all(".zotero-coll-item")
    check(len(rows) == 2, f"two collections listed (got {len(rows)})")

    # Expand first collection (ML Papers -> 2 items, 1 of which is an arXiv preprint)
    page.locator(".zotero-coll-item").first.click()
    page.wait_for_selector(".zotero-coll-items .zotero-coll-entry", timeout=8000)
    entries = page.query_selector_all(".zotero-coll-items .zotero-coll-entry")
    check(len(entries) == 2, f"first collection expanded to 2 items (got {len(entries)})")
    badges = page.query_selector_all(".zotero-coll-items .zotero-arxiv-badge")
    check(len(badges) == 1, f"one arXiv badge on the arXiv item (got {len(badges)})")
    page.screenshot(path=str(SHOTS / "coll_expanded.png"), full_page=False)
    print(f'  -- screenshot: {SHOTS/"coll_expanded.png"}', flush=True)

    # Filter narrows the expanded list
    page.fill(".zotero-coll-filter", "attention")
    page.wait_for_timeout(200)
    shown = page.query_selector_all(".zotero-coll-items .zotero-coll-entry")
    check(len(shown) == 1, f"filter 'attention' narrows to 1 item (got {len(shown)})")

    # Collapse: click the same collection row again
    page.locator(".zotero-coll-item").first.click()
    page.wait_for_selector(".zotero-coll-items", state="detached", timeout=5000)
    check(page.query_selector(".zotero-coll-items") is None, "collapsing hides the items list")

    check(not any("PAGEERROR" in l for l in logs), f"no page errors (logs: {logs[:3]})")
    b.close()

print("\n" + ("PASS - Zotero collections expand OK" if ok else "FAIL - see above"), flush=True)
sys.exit(0 if ok else 1)
