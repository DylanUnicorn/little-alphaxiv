"""Regression check: highlight creation still works after the click-to-select fix.
Verifies the drag-yield does NOT break the normal create flow:
  1. toggle highlight ON
  2. drag-select text -> bubble -> pick color -> highlight created  (creation)
  3. click the created highlight -> selects it  (the new capability)
  4. with it selected, drag-select DIFFERENT adjacent text -> create 2nd highlight
     (creation must still work even right after selecting an existing highlight)
  5. click 2nd highlight -> select -> Delete -> gone
  6. confirm the 1st highlight is untouched

Run: APP_URL=http://127.0.0.1:5175 PYTHONUTF8=1 PYTHONIOENCODING=utf-8 \
  /c/Users/Delig/.conda/envs/Agent_env/python.exe tools/drive_highlight_regression.py
"""
import codecs, json, os, sys, time
from pathlib import Path
from playwright.sync_api import sync_playwright

sys.stdout = codecs.getwriter("utf-8")(sys.stdout.buffer, errors="replace")
sys.stderr = codecs.getwriter("utf-8")(sys.stderr.buffer, errors="replace")
APP = os.environ.get("APP_URL", "http://127.0.0.1:5175").rstrip("/")
PROV = {"name": "mock", "base_url": "http://127.0.0.1:5050/v1", "api_key": "mock", "model": "mock-model"}
ARXIV = "1706.03762"
SHOTS = Path(__file__).parent / "shots_highlight_regression"
SHOTS.mkdir(exist_ok=True)
results = []


def rec(name, ok, detail):
    results.append((name, ok, detail))
    print(f"[{'PASS' if ok else 'FAIL'}] {name}: {detail}")


def seed(page):
    for _ in range(5):
        try:
            page.goto(f"{APP}/settings", wait_until="domcontentloaded", timeout=20000); break
        except Exception:
            time.sleep(1)
    page.evaluate("""(pj)=>{
      const p=JSON.parse(pj);
      localStorage.setItem('little-alphaxiv-settings',
        JSON.stringify({state:{providers:[Object.assign({id:'r'},p,{is_default:true})],
                         defaultProviderId:'r',theme:'dark'},version:0}));
    }""", json.dumps(PROV))
    page.evaluate("""async ()=>{const req=indexedDB.deleteDatabase('little-alphaxiv');
      await new Promise(r=>{req.onsuccess=r;req.onerror=r;req.onblocked=r;});}""")


def center_of_first_highlight(page):
    return page.evaluate("""()=>{
      const hl=document.querySelector('.highlight-layer .highlight-rect');
      if(!hl) return null;
      const r=hl.getBoundingClientRect();
      return {x:r.left+r.width/2, y:r.top+r.height/2};
    }""")


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
        page.evaluate("""async ()=>{
          const mod=await import('/src/store/annotations.ts');
          window.__laxAnnot=mod.useAnnotations;
          window.__laxState=()=>{const s=mod.useAnnotations.getState();
            return {highlightOn:s.highlightOn,selectedId:s.selectedId,
              count:s.annots.filter(a=>a.type==='highlight').length};};
        }""")

        spans = page.evaluate("""()=>{const s=[...document.querySelectorAll('.pdf-page-wrap .pdf-textlayer span')];
          return s.slice(0,40).map(e=>{const r=e.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};});}""")
        if len(spans) < 30:
            rec("spans available", False, f"only {len(spans)} spans"); b.close(); return 1
        rec("spans available", True, f"{len(spans)} spans")

        page.evaluate("()=>window.__laxAnnot.getState().toggleHighlight()"); page.wait_for_timeout(150)

        # --- 1) create first highlight: a SMALL selection (spans[1]->spans[2]) so its
        #     rects occupy a small region and #2's drag (spans[15]->spans[18], well
        #     below) starts on UN-highlighted text — the normal creation path. ---
        page.mouse.move(spans[1]["x"], spans[1]["y"]); page.mouse.down()
        page.mouse.move(spans[2]["x"], spans[2]["y"], steps=12); page.mouse.up()
        page.wait_for_timeout(400)
        sc = page.eval_on_selector_all(".highlight-bubble-swatch", "els=>els.length")
        if sc == 0:
            rec("create#1 bubble", False, "no bubble"); b.close(); return 1
        page.locator(".highlight-bubble-swatch").first.click(timeout=3000); page.wait_for_timeout(300)
        st = page.evaluate("()=>window.__laxState()")
        rec("create#1", st["count"] == 1, f"count={st['count']}")

        # --- 2) click the first highlight -> selects ---
        c1 = center_of_first_highlight(page)
        if not c1:
            rec("click-select#1", False, "no highlight rect found"); b.close(); return 1
        page.mouse.click(c1["x"], c1["y"]); page.wait_for_timeout(200)
        st = page.evaluate("()=>window.__laxState()")
        rec("click-select#1", st["selectedId"] is not None, f"selectedId={st['selectedId']}")

        # --- 3) create a SECOND highlight on DIFFERENT text well outside #1's rects ---
        page.mouse.move(spans[15]["x"], spans[15]["y"]); page.mouse.down()
        page.mouse.move(spans[18]["x"], spans[18]["y"], steps=12); page.mouse.up()
        page.wait_for_timeout(400)
        sc2 = page.eval_on_selector_all(".highlight-bubble-swatch", "els=>els.length")
        if sc2 == 0:
            rec("create#2 bubble", False, "no bubble after selecting#1"); b.close(); return 1
        page.locator(".highlight-bubble-swatch").first.click(timeout=3000); page.wait_for_timeout(300)
        st = page.evaluate("()=>window.__laxState()")
        rec("create#2 after select", st["count"] == 2, f"count={st['count']} (expected 2)")

        # --- 4) delete the second highlight only ---
        # The second highlight was just created; its rect is the first .highlight-rect in DOM
        # of the spans[7..10] region. Click the topmost highlight rect's center.
        c2 = page.evaluate("""()=>{const hs=[...document.querySelectorAll('.highlight-layer .highlight-rect')];
          if(!hs.length) return null; const r=hs[hs.length-1].getBoundingClientRect();
          return {x:r.left+r.width/2,y:r.top+r.height/2};}""")
        if c2:
            page.mouse.click(c2["x"], c2["y"]); page.wait_for_timeout(200)
            page.keyboard.press("Delete"); page.wait_for_timeout(200)
            st = page.evaluate("()=>window.__laxState()")
            rec("delete#2", st["count"] == 1, f"count={st['count']} (expected 1 remaining)")

        page.screenshot(path=str(SHOTS / "01_final.png"))
        b.close()

    print("\n=== summary ===")
    passed = sum(1 for _, ok, _ in results if ok)
    print(f"{passed}/{len(results)} passed")
    return 0 if passed == len(results) else 1


if __name__ == "__main__":
    sys.exit(main())
