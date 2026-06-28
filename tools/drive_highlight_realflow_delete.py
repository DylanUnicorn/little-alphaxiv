"""Reproduce the REAL user flow: toggle highlight ON -> drag-select -> pick color ->
then try to click-select the created highlight to delete it.

Tests the hypothesis that after the real creation flow, the highlight click-target
is NOT rendered (because AnnotLayer.tsx:257 gates it on `tool==='none' && !highlightOn`,
and highlightOn stays true after creation), so the user can never click to select
and Delete never fires.

Run (frontend :5175, backend :8000, mock :5050):
  APP_URL=http://127.0.0.1:5175 PYTHONUTF8=1 PYTHONIOENCODING=utf-8 \
    /c/Users/Delig/.conda/envs/Agent_env/python.exe tools/drive_highlight_realflow_delete.py
"""
import codecs, json, os, sys, time
from pathlib import Path
from playwright.sync_api import sync_playwright

sys.stdout = codecs.getwriter("utf-8")(sys.stdout.buffer, errors="replace")
sys.stderr = codecs.getwriter("utf-8")(sys.stderr.buffer, errors="replace")
APP = os.environ.get("APP_URL", "http://127.0.0.1:5175").rstrip("/")
PROV = {"name": "mock", "base_url": "http://127.0.0.1:5050/v1", "api_key": "mock", "model": "mock-model"}
SHOTS = Path(__file__).parent / "shots_highlight_realflow"
SHOTS.mkdir(exist_ok=True)
ARXIV = "1706.03762"


def seed(page):
    for _ in range(5):
        try:
            page.goto(f"{APP}/settings", wait_until="domcontentloaded", timeout=20000)
            break
        except Exception:  # noqa: BLE001
            time.sleep(1)
    prov_json = json.dumps(PROV)
    page.evaluate(
        """(pj)=>{
          const p=JSON.parse(pj);
          localStorage.setItem('little-alphaxiv-settings',
            JSON.stringify({state:{providers:[Object.assign({id:'r'},p,{is_default:true})],
                             defaultProviderId:'r',theme:'dark'},version:0}));
        }""",
        prov_json,
    )
    page.evaluate("""async ()=>{
      const req=indexedDB.deleteDatabase('little-alphaxiv');
      await new Promise(r=>{req.onsuccess=r;req.onerror=r;req.onblocked=r;});
    }""")


def main():
    with sync_playwright() as pw:
        b = pw.chromium.launch(headless=True)
        page = b.new_context(viewport={"width": 1500, "height": 950}).new_page()
        logs = []
        page.on("pageerror", lambda e: logs.append(str(e)))

        seed(page)
        for _ in range(5):
            try:
                page.goto(f"{APP}/paper/{ARXIV}", wait_until="domcontentloaded", timeout=20000)
                break
            except Exception:  # noqa: BLE001
                time.sleep(1)
        page.wait_for_selector(".pdf-textlayer span", timeout=30000)
        page.wait_for_timeout(1500)
        page.evaluate(
            """async ()=>{
              const mod = await import('/src/store/annotations.ts');
              window.__laxAnnot = mod.useAnnotations;
              window.__laxState = () => {
                const s = mod.useAnnotations.getState();
                return {tool:s.tool, highlightOn:s.highlightOn, selectedId:s.selectedId,
                        annotCount:s.annots.length,
                        highlights: s.annots.filter(a=>a.type==='highlight').map(a=>({id:a.id,page:a.page,rects:(a.highlight&&a.highlight.rects||[]).length}))};
              };
            }"""
        )
        print("STEP0_state:", json.dumps(page.evaluate("()=>window.__laxState()")))

        # Get spans to drag-select.
        span_info = page.evaluate(
            """()=>{const s=[...document.querySelectorAll('.pdf-page-wrap .pdf-textlayer span')];
            return s.slice(0,8).map(e=>{const r=e.getBoundingClientRect();return {text:e.textContent, x:r.left+r.width/2, y:r.top+r.height/2};});}"""
        )
        print("STEP1_spans:", json.dumps(span_info[:4]))
        if len(span_info) < 6:
            print("FAIL: not enough spans"); b.close(); return 1
        a = span_info[1]; c = span_info[5]

        # Toggle highlight ON via the store action (button[title] is stale post-Tooltip).
        page.evaluate("()=>window.__laxAnnot.getState().toggleHighlight()")
        page.wait_for_timeout(150)
        print("STEP2_highlightOn:", page.evaluate("()=>window.__laxState().highlightOn"))

        # Drag-select text a..c -> bubble -> click first swatch (real creation flow).
        page.mouse.move(a["x"], a["y"]); page.mouse.down()
        page.mouse.move(c["x"], c["y"], steps=12); page.mouse.up()
        page.wait_for_timeout(400)
        swatch_count = page.eval_on_selector_all(".highlight-bubble-swatch", "els=>els.length")
        print("STEP3_swatch_count:", swatch_count)
        if swatch_count == 0:
            print("FAIL: no bubble appeared in real flow"); b.close(); return 1
        page.locator(".highlight-bubble-swatch").first.click(timeout=3000)
        page.wait_for_timeout(400)
        st = page.evaluate("()=>window.__laxState()")
        print("STEP4_after_create_state:", json.dumps(st))
        page.screenshot(path=str(SHOTS / "01_after_create.png"))

        # NOW the user wants to delete. They click on a VISIBLE part of the
        # highlight (its widest rect) — pdf.js getClientRects can emit zero-width
        # phantom rects at line starts that have no hit area, so clicking the
        # first rect is not always meaningful.
        diag = page.evaluate(
            """()=>{
              const out={};
              const hls=[...document.querySelectorAll('.highlight-layer .highlight-rect')];
              out.highlight_rect_present = hls.length>0;
              out.hl_rect_count = hls.length;
              const targets=[...document.querySelectorAll('.annot-svg rect')].filter(r=>r.getAttribute('fill')==='transparent');
              out.click_target_count = targets.length;
              const layer=document.querySelector('.annot-layer');
              out.annot_layer_pe = layer?getComputedStyle(layer).pointerEvents:'n/a';
              let best=hls[0], bestW=-1;
              for(const el of hls){const r=el.getBoundingClientRect(); if(r.width>bestW){bestW=r.width;best=el;}}
              if(best){
                const r=best.getBoundingClientRect();
                const cx=r.left+r.width/2, cy=r.top+r.height/2;
                out.center={x:cx,y:cy};
                out.hl_box={left:r.left,top:r.top,w:r.width,h:r.height};
                const el=document.elementFromPoint(cx,cy);
                out.under_center = el?(el.tagName+'.'+(el.getAttribute('class')||'')):'null';
              }
              return out;
            }"""
        )
        print("STEP5_diag_after_create:", json.dumps(diag))

        # Click the highlight center, check selectedId.
        center = diag.get("center")
        if center:
            page.mouse.click(center["x"], center["y"])
            page.wait_for_timeout(200)
            st2 = page.evaluate("()=>window.__laxState()")
            print("STEP6_selectedId_after_click:", st2["selectedId"], "highlightOn:", st2["highlightOn"])
            page.keyboard.press("Delete")
            page.wait_for_timeout(200)
            st3 = page.evaluate("()=>window.__laxState()")
            print("STEP7_after_delete:", json.dumps(st3))
            page.screenshot(path=str(SHOTS / "02_after_delete.png"))

        # Now toggle highlight OFF and retry select+delete.
        page.evaluate("()=>window.__laxAnnot.getState().toggleHighlight()")
        page.wait_for_timeout(150)
        print("STEP8_highlightOff:", page.evaluate("()=>window.__laxState().highlightOn"))
        diag2 = page.evaluate(
            """()=>{
              const hl = document.querySelector('.highlight-layer .highlight-rect');
              const targets=[...document.querySelectorAll('.annot-svg rect')].filter(r=>r.getAttribute('fill')==='transparent');
              let out={highlight_rect_present:!!hl, click_target_count:targets.length};
              if(hl){const r=hl.getBoundingClientRect(); out.center={x:r.left+r.width/2,y:r.top+r.height/2};
                const el=document.elementFromPoint(out.center.x,out.center.y);
                out.under_center=el?(el.tagName+'.'+(el.getAttribute('class')||'')):'null';}
              return out;
            }"""
        )
        print("STEP9_diag_highlight_off:", json.dumps(diag2))
        if diag2.get("center"):
            page.mouse.click(diag2["center"]["x"], diag2["center"]["y"])
            page.wait_for_timeout(200)
            st4 = page.evaluate("()=>window.__laxState()")
            print("STEP10_selectedId_off:", st4["selectedId"])
            page.keyboard.press("Delete")
            page.wait_for_timeout(200)
            st5 = page.evaluate("()=>window.__laxState()")
            print("STEP11_after_delete_off:", json.dumps(st5))

        print("PAGEERRORS:", logs)
        b.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
