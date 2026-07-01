"""E2E: a MULTI-LINE highlight selection must put the bubble at the selection,
not at the page's top-left corner.

Root cause: pdf.js Range.getClientRects() on a multi-line selection emits
zero-width phantom rects at left=0 near the page top; fitHighlightRects sorted
them first, so clientRects[0] was the phantom and the bubble landed top-left.

This driver does a real multi-line drag and asserts the bubble is near the real
selection's first line (NOT at page top-left). Run against both old (5173) and
fixed (5180) servers to show the contrast:
  "C:/Users/Delig/.conda/envs/Agent_env/python.exe" tools/drive_highlight_bubble_topleft.py
"""
import codecs, json, os, sys, time
from pathlib import Path
from playwright.sync_api import sync_playwright

sys.stdout = codecs.getwriter("utf-8")(sys.stdout.buffer, errors="replace")
APP = os.environ.get("APP_URL", "http://127.0.0.1:5173").rstrip("/")
PROV = {"name": "mock", "base_url": "http://127.0.0.1:5050/v1", "api_key": "mock", "model": "mock-model"}
SHOTS = Path(__file__).parent / "shots_bubble_topleft"
SHOTS.mkdir(exist_ok=True)
ARXIV = "1706.03762"


def seed(page):
    for _ in range(5):
        try:
            page.goto(f"{APP}/settings", wait_until="domcontentloaded", timeout=20000); break
        except Exception:
            time.sleep(1)
    page.evaluate("(pj)=>{const p=JSON.parse(pj);localStorage.setItem('little-alphaxiv-settings',JSON.stringify({state:{providers:[Object.assign({id:'r'},p,{is_default:true})],defaultProviderId:'r',theme:'dark'},version:0}));}", json.dumps(PROV))
    page.evaluate("""async ()=>{const req=indexedDB.deleteDatabase('little-alphaxiv');await new Promise(r=>{req.onsuccess=r;req.onerror=r;req.onblocked=r;});}""")


def main():
    with sync_playwright() as pw:
        b = pw.chromium.launch(headless=True)
        page = b.new_context(viewport={"width": 1500, "height": 950}).new_page()
        page.on("pageerror", lambda e: print("PAGEERROR:", e))
        seed(page)
        for _ in range(5):
            try:
                page.goto(f"{APP}/paper/{ARXIV}", wait_until="domcontentloaded", timeout=20000); break
            except Exception:
                time.sleep(1)
        page.wait_for_selector(".pdf-textlayer span", timeout=30000)
        page.wait_for_timeout(1500)
        page.locator('button[aria-label="Highlight (toggle)"]').click()
        page.wait_for_timeout(250)

        spans = page.evaluate(
            """()=>{const s=[...document.querySelectorAll('.pdf-page-wrap')[0].querySelectorAll('.pdf-textlayer span')].filter(e=>e.getBoundingClientRect().width>30);
            return s.map(e=>{const r=e.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};});}"""
        )
        # Multi-line drag: span[2] -> span[8] (this is the scenario that emits
        # the left=0 phantom rects per the phantom2 investigation).
        a, c = spans[2], spans[8]
        page.mouse.move(a["x"], a["y"]); page.mouse.down()
        page.mouse.move(c["x"], c["y"], steps=14); page.wait_for_timeout(80); page.mouse.up()
        page.wait_for_timeout(500)

        diag = page.evaluate(
            """()=>{
              const out={};
              const sel=window.getSelection();
              if(!sel||sel.isCollapsed||!sel.rangeCount){out.error='no selection';return out;}
              const range=sel.getRangeAt(0);
              const rects=Array.from(range.getClientRects()).filter(r=>r.width>0);
              const first=rects.slice().sort((a,b)=>a.top-b.top||a.left-b.left)[0];
              out.real_first_rect={left:first.left,top:first.top};
              let n=range.commonAncestorContainer; if(n.nodeType!==1)n=n.parentElement;
              const pw=n.closest('.pdf-page-canvas-wrap'); const pr=pw.getBoundingClientRect();
              out.page_wrap_rect={left:pr.left,top:pr.top};
              const bub=document.querySelector('.highlight-bubble');
              if(!bub){out.bubble_found=false;return out;}
              out.bubble_found=true;
              const br=bub.getBoundingClientRect();
              out.bubble_rect={left:br.left,top:br.top,w:br.width,h:br.height};
              return out;
            }"""
        )
        page.screenshot(path=str(SHOTS / "multiline_bubble.png"))
        print("APP:", APP)
        print(json.dumps(diag, indent=2))

        if not diag.get("bubble_found") or diag.get("error"):
            print("RESULT: no bubble/selection"); b.close(); sys.exit(1)
        bub = diag["bubble_rect"]; sel = diag["real_first_rect"]; pw = diag["page_wrap_rect"]
        dx = abs(bub["left"] - sel["left"])
        gap = sel["top"] - (bub["top"] + bub["h"])
        at_topleft = abs(bub["left"] - pw["left"]) < 30 and abs(bub["top"] - pw["top"]) < 30
        print(f"\nbubble_left={bub['left']:.0f} sel_left={sel['left']:.0f} dx={dx:.0f}")
        print(f"gap(bubble_bottom->sel_top)={gap:.0f}  at_page_topleft={at_topleft}")
        ok = dx < 80 and -40 < gap < 80 and not at_topleft
        print("RESULT:", "BUBBLE AT SELECTION (fixed)" if ok else "BUBBLE AT TOP-LEFT (bug)")
        b.close()
        sys.exit(0 if ok else 1)


if __name__ == "__main__":
    sys.exit(main())
