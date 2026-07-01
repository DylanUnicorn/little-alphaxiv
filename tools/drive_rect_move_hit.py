"""Reproduce: a placed Rectangle annotation can only be grabbed by its thin
border, not its body — so clicking the rect's CENTER (default tool) fails to
select it for move/delete.

Flow:
  1. Open paper 1706.03762, activate the Rectangle tool.
  2. Drag a rect over the middle of page 1.
  3. Switch back to default tool (click the toolbar Rectangle button again —
     one-shot tool auto-resets, but we ensure tool==='none').
  4. Click the rect's CENTER (well inside the border, on the translucent fill).
  5. Assert the rect became selected (a SelectionHandles dashed frame exists,
     OR the store's selectedId === the placed rect's id).

Before the fix the rect renders pointer-events:stroke + strokeWidth 1.5, so only
the 1.5px border is hittable — a center click passes through to the textlayer
and selects nothing. After the fix the fill is also hittable (pointer-events
covers the body), so the center click selects the rect.

Run:
  "C:/Users/Delig/.conda/envs/Agent_env/python.exe" tools/drive_rect_move_hit.py
"""
import codecs, json, os, sys, time
from pathlib import Path
from playwright.sync_api import sync_playwright

sys.stdout = codecs.getwriter("utf-8")(sys.stdout.buffer, errors="replace")
APP = os.environ.get("APP_URL", "http://127.0.0.1:5173").rstrip("/")
PROV = {"name": "mock", "base_url": "http://127.0.0.1:5050/v1", "api_key": "mock", "model": "mock-model"}
SHOTS = Path(__file__).parent / "shots_rect_move_hit"
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
        errs = []
        page.on("pageerror", lambda e: errs.append(str(e)))
        seed(page)
        for _ in range(5):
            try:
                page.goto(f"{APP}/paper/{ARXIV}", wait_until="domcontentloaded", timeout=20000); break
            except Exception:
                time.sleep(1)
        page.wait_for_selector(".pdf-textlayer span", timeout=30000)
        page.wait_for_timeout(1500)

        # Page geometry for drawing a rect in the middle of page 1.
        geo = page.evaluate(
            """()=>{const wrap=[...document.querySelectorAll('.pdf-page-canvas-wrap')][0];
            const r=wrap.getBoundingClientRect();
            return {left:r.left, top:r.top, w:r.width, h:r.height};}"""
        )
        print("page1 wrap:", json.dumps({k: round(v) for k, v in geo.items()}))

        # Activate Rectangle tool.
        page.locator('button[aria-label="Rectangle"]').click()
        page.wait_for_timeout(150)

        # Draw a ~220x90 rect centered on the page middle.
        cx = geo["left"] + geo["w"] / 2
        cy = geo["top"] + geo["h"] / 2
        x0, y0 = cx - 110, cy - 45
        x1, y1 = cx + 110, cy + 45
        page.mouse.move(x0, y0)
        page.mouse.down()
        page.mouse.move(x1, y1, steps=12)
        page.wait_for_timeout(80)
        page.mouse.up()
        page.wait_for_timeout(250)

        # The rect tool is one-shot: pointerup resets tool to "none". Confirm a
        # rect was actually placed by counting filled .annot-svg rects (the placed
        # rect has fill=color + fillOpacity; selection handles are fill=none/
        # transparent). We do NOT rely on any JS store bridge.
        placed = page.evaluate(
            """()=>{const svg=document.querySelector('.annot-svg');
            if(!svg) return {svg:false};
            const rects=[...svg.querySelectorAll('rect')];
            // a placed rect body: has a non-"none"/non-"transparent" fill attr
            const bodies=rects.filter(r=>{const f=(r.getAttribute('fill')||'').toLowerCase();return f && f!=='none' && f!=='transparent';});
            return {svg:true, total:rects.length, bodies:bodies.length};}"""
        )
        print("placed rect:", json.dumps(placed))
        if not placed.get("svg") or placed.get("bodies", 0) == 0:
            print("FAIL: no rect placed — cannot test move-hit"); page.screenshot(path=str(SHOTS / "no_rect.png")); b.close(); sys.exit(2)

        # Sanity: before selecting, no resize handles (8 transparent HIT rects)
        # should be present.
        handles_before = page.evaluate(
            """()=>[...document.querySelectorAll('.annot-svg rect')].filter(r=>(r.getAttribute('fill')||'').toLowerCase()==='transparent').length"""
        )

        # Now click the rect's CENTER — strictly inside, far from the border.
        page.mouse.move(cx, cy)
        page.mouse.down()
        page.wait_for_timeout(40)
        page.mouse.up()
        page.wait_for_timeout(250)

        page.screenshot(path=str(SHOTS / "after_center_click.png"))

        # Selection signal: SelectionHandles renders exactly 8 transparent HIT
        # rects (the resize handles) iff selectedId===this rect && tool==='none'.
        # No bridge needed — pure DOM. handles_before was ~0; after a successful
        # center-click it must jump to 8.
        handles_after = page.evaluate(
            """()=>[...document.querySelectorAll('.annot-svg rect')].filter(r=>(r.getAttribute('fill')||'').toLowerCase()==='transparent').length"""
        )
        print(f"transparent HIT rects: before={handles_before} after={handles_after} (want after==8)")

        ok = handles_after == 8
        print("\nRESULT:", "CENTER CLICK SELECTS RECT (fixed)" if ok else "CENTER CLICK MISSES — bug reproduced (only border hittable)")
        print("PAGEERRORS:", errs)
        b.close()
        sys.exit(0 if ok else 1)


if __name__ == "__main__":
    sys.exit(main())
