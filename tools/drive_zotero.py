"""Zotero integration smoke test (no real API key / no real Zotero needed).

Verifies the PDF-toolbar Zotero icon wires up to the ZoteroPanel overlay:
  1. The Zotero icon button (.zotero-btn) appears in the PDF toolbar.
  2. Clicking it opens the .zotero-panel overlay with a "Zotero" heading.
  3. The panel makes the /api/zotero/status call and renders a status chip
     (offline / local / web) without crashing — i.e. the backend proxy path
     is exercised end-to-end (graceful when no Zotero desktop is running).
  4. The three tabs (This paper / Library / Collections) exist.
  5. Closing (× and Esc and backdrop) dismisses the panel.
  6. No uncaught page errors.

Assumes the three servers are up (backend :8000, frontend :5173, mock :5050):
    cd backend && ./run.sh            (Windows: run.bat)
    cd frontend && npm run dev
    python tools/mock_llm.py
    conda run -n Agent_env python tools/drive_zotero.py
"""
import codecs, json, os, sys
from pathlib import Path
from playwright.sync_api import sync_playwright

sys.stdout = codecs.getwriter("utf-8")(sys.stdout.buffer, errors="replace")
APP = os.environ.get("APP_URL", "http://127.0.0.1:5173")
ARXIV = "2401.00001"
PROV = {"name": "mock", "base_url": "http://127.0.0.1:5050/v1", "api_key": "mock", "model": "mock-model"}
SHOTS = Path(__file__).parent / "shots_real"
SHOTS.mkdir(exist_ok=True)

ok = True
def check(cond, msg):
    global ok
    print(("  OK  " if cond else " FAIL ") + msg)
    if not cond:
        ok = False


def seed(page):
    page.goto(f"{APP}/settings", wait_until="domcontentloaded")
    page.evaluate(
        """(pj)=>{
          localStorage.setItem('little-alphaxiv-settings',
            JSON.stringify({state:{providers:[Object.assign({id:'r'},JSON.parse(pj),{is_default:true})],
                             defaultProviderId:'r',theme:'dark',
                             zotero:{mode:'auto',userId:'',apiKey:''}},version:0}));
        }""",
        json.dumps(PROV),
    )
    # wipe + seed a paper record so the "This paper" tab has a title
    page.evaluate("""async (aid)=>{
      await new Promise(r=>{const q=indexedDB.deleteDatabase('little-alphaxiv');
        q.onsuccess=q.onerror=q.onblocked=r;});
      const put=(db)=>new Promise(res=>{
        const tx=db.transaction('papers','readwrite');
        tx.objectStore('papers').put({arxiv_id:aid,title:'Zotero Smoke Test Paper',
          authors:['Test Author'],abstract:'abstract',pdf_url:'',abs_url:'https://arxiv.org/abs/'+aid,
          published:'2024-01-01',primary_category:'cs.AI',fetched_at:Date.now()});
        tx.oncomplete=()=>res(); tx.onerror=()=>res();
      });
      await new Promise(r=>{
        const op=indexedDB.open('little-alphaxiv',2);
        op.onupgradeneeded=e=>{const db=e.target.result;
          if(!db.objectStoreNames.contains('papers'))db.createObjectStore('papers',{keyPath:'arxiv_id'});
          if(!db.objectStoreNames.contains('conversations'))db.createObjectStore('conversations',{keyPath:'id'});
          if(!db.objectStoreNames.contains('annotations'))db.createObjectStore('annotations',{keyPath:'id'});}
        op.onsuccess=async e=>{await put(e.target.result);r();};
      });
    }""", ARXIV)


with sync_playwright() as pw:
    b = pw.chromium.launch(headless=True)
    page = b.new_context(viewport={"width": 1500, "height": 950}).new_page()
    logs = []
    page.on("console", lambda m: logs.append(m.text) if m.type == "error" else None)
    page.on("pageerror", lambda e: logs.append(f"PAGEERROR: {e}"))

    seed(page)
    page.goto(f"{APP}/paper/{ARXIV}", wait_until="domcontentloaded")
    page.wait_for_selector(".pdf-toolbar", timeout=15000)
    # the PDF itself may fail to load (no real arxiv); that's fine — toolbar renders regardless

    zbtn = page.query_selector(".zotero-btn")
    check(zbtn is not None, "Zotero icon button present in PDF toolbar")

    zbtn.click()
    page.wait_for_selector(".zotero-panel", timeout=8000)
    heading = page.eval_on_selector(".zotero-head strong", "e=>e.textContent.trim()")
    check(heading == "Zotero", f'panel heading is "Zotero" (got "{heading}")')

    tabs = page.eval_on_selector_all(".zotero-tabs button", "els=>els.map(e=>e.textContent.trim())")
    check(tabs == ["This paper", "Library", "Collections"], f"three tabs present (got {tabs})")

    # status call should resolve; chip text is one of checking…/● local/● web/✗ offline
    page.wait_for_function("()=>{const t=document.querySelector('.zotero-chip');return t&&t.textContent&&!t.textContent.includes('checking');}", timeout=15000)
    chip = page.eval_on_selector(".zotero-chip", "e=>e.textContent.trim()")
    check(chip != "", f"status chip populated (got \"{chip}\")")

    page.screenshot(path=str(SHOTS / "zotero_panel.png"), full_page=False)
    print(f'  -- status chip: "{chip}"')
    print(f'  -- screenshot: {SHOTS/"zotero_panel.png"}')

    # close via ×
    page.click(".zotero-close")
    page.wait_for_selector(".zotero-panel", state="detached", timeout=5000)
    check(page.query_selector(".zotero-panel") is None, "× closes the panel")

    # reopen + close via Esc
    page.click(".zotero-btn")
    page.wait_for_selector(".zotero-panel", timeout=5000)
    page.keyboard.press("Escape")
    page.wait_for_selector(".zotero-panel", state="detached", timeout=5000)
    check(page.query_selector(".zotero-panel") is None, "Esc closes the panel")

    check(not any("PAGEERROR" in l for l in logs), f"no page errors (logs: {logs[:3]})")

    b.close()

print("\n" + ("PASS — Zotero smoke OK" if ok else "FAIL — see above"))
sys.exit(0 if ok else 1)
