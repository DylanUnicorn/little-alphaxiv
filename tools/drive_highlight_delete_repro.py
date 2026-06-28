"""Reproduce: highlight (划词) cannot be selected/deleted in default mode.

Hypothesis (systematic-debugging Phase 1):
  .annot-layer has pointer-events:none in default mode (AnnotLayer.tsx:194
  `pointerEvents: interactive ? "auto" : "none"`, and index.css:1042). CSS rule:
  a parent with pointer-events:none disables hit-testing for its ENTIRE subtree,
  including SVG <rect> children that set pointer-events:"all" themselves. The
  highlight click-targets (AnnotLayer.tsx:257-274) are such SVG rects — so they
  can never receive the click that would call select(a.id), and Delete can't fire.

This driver gathers evidence WITHOUT relying on button[title=...] (those attrs
moved to Tooltip wrappers in commit 2cda451). It:
  1. seeds a provider + paper, waits for text layer
  2. toggles highlight via the store action (window.__laxAnnot)
  3. creates a highlight by calling addAnnot directly with a known rect
  4. reads back: is .highlight-rect present? is the SVG click-target <rect>
     present? what does elementFromPoint() return at the highlight center?
     what is the computed pointer-events of .annot-layer and the target rect?
  5. dispatches a real click at the highlight center; checks selectedId.
  6. presses Delete; checks the highlight is gone.

Run (frontend :5175, backend :8000, mock :5050):
  APP_URL=http://127.0.0.1:5175 PYTHONUTF8=1 PYTHONIOENCODING=utf-8 \
    /c/Users/Delig/.conda/envs/Agent_env/python.exe tools/drive_highlight_delete_repro.py
"""
import codecs, json, os, sys, time
from pathlib import Path
from playwright.sync_api import sync_playwright

sys.stdout = codecs.getwriter("utf-8")(sys.stdout.buffer, errors="replace")
sys.stderr = codecs.getwriter("utf-8")(sys.stderr.buffer, errors="replace")
APP = os.environ.get("APP_URL", "http://127.0.0.1:5175").rstrip("/")
PROV = {"name": "mock", "base_url": "http://127.0.0.1:5050/v1", "api_key": "mock", "model": "mock-model"}
SHOTS = Path(__file__).parent / "shots_highlight_delete"
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
        # The app redirects localhost<->127.0.0.1 (loopback-origin unification);
        # first navigation can ERR_ABORTED mid-redirect. Retry a few times.
        last_err = None
        for _ in range(5):
            try:
                page.goto(f"{APP}/paper/{ARXIV}", wait_until="domcontentloaded", timeout=20000)
                last_err = None
                break
            except Exception as e:  # noqa: BLE001
                last_err = e
                time.sleep(1)
        if last_err:
            raise last_err
        page.wait_for_selector(".pdf-textlayer span", timeout=30000)
        page.wait_for_timeout(1500)
        # Expose the store so we can drive it directly (bypass UI button selectors).
        page.evaluate(
            """async ()=>{
              const mod = await import('/src/store/annotations.ts');
              window.__laxAnnot = mod.useAnnotations;
              // helper to read the public state we need
              window.__laxState = () => {
                const s = mod.useAnnotations.getState();
                return {tool:s.tool, highlightOn:s.highlightOn, selectedId:s.selectedId,
                        annotCount:s.annots.length,
                        highlights: s.annots.filter(a=>a.type==='highlight').map(a=>({id:a.id,page:a.page,rects:(a.highlight&&a.highlight.rects||[]).length}))};
              };
            }"""
        )

        st = page.evaluate("()=>window.__laxState()")
        print("STEP0_store_state:", json.dumps(st))

        # Create a highlight directly via the store on page 1, a wide rect in the
        # upper-middle of the page (normalized). We use page 1's pixel size to make
        # a rect that is well inside the visible viewport.
        created = page.evaluate(
            """()=>{
              const s = window.__laxAnnot.getState();
              if(!s.arxivId) return {error:'no arxivId', state: window.__laxState()};
              window.__laxAnnot.getState().addAnnot({
                type:'highlight', page:1, color:'#FFEB3B',
                highlight:{ rects:[{x:0.15,y:0.12,w:0.5,h:0.02}] }
              });
              return window.__laxState();
            }"""
        )
        print("STEP1_after_addAnnot:", json.dumps(created))
        page.screenshot(path=str(SHOTS / "01_highlight_created.png"))

        # Inspect the rendered DOM + computed styles + hit-test.
        diag = page.evaluate(
            """()=>{
              const out={};
              const hl = document.querySelector('.highlight-layer .highlight-rect');
              out.highlight_rect_present = !!hl;
              // The click-target is an SVG <rect> with fill transparent inside .annot-svg
              const targets=[...document.querySelectorAll('.annot-svg rect')].filter(r=>r.getAttribute('fill')==='transparent');
              out.click_target_count = targets.length;
              const layer=document.querySelector('.annot-layer');
              out.annot_layer_pe = layer?getComputedStyle(layer).pointerEvents:'n/a';
              out.annot_layer_z  = layer?getComputedStyle(layer).zIndex:'n/a';
              const tl=document.querySelector('.pdf-textlayer');
              out.textlayer_pe = tl?getComputedStyle(tl).pointerEvents:'n/a';
              if(hl){
                const r=hl.getBoundingClientRect();
                const cx=r.left+r.width/2, cy=r.top+r.height/2;
                out.hl_rect={left:r.left,top:r.top,w:r.width,h:r.height};
                out.center={x:cx,y:cy};
                const el=document.elementFromPoint(cx,cy);
                out.under_center = el? (el.tagName+'.'+(el.getAttribute('class')||'')):'null';
                out.under_is_textlayer = !!(el && el.closest && el.closest('.pdf-textlayer'));
                out.under_is_annot_svg = !!(el && el.closest && el.closest('.annot-svg'));
              }
              if(targets.length){
                const t=targets[0]; const r=t.getBoundingClientRect();
                out.target_rect={left:r.left,top:r.top,w:r.width,h:r.height};
                out.target_pe = getComputedStyle(t).pointerEvents;
                out.target_visible = !!(r.width>0 && r.height>0);
                const cx=r.left+r.width/2, cy=r.top+r.height/2;
                const el=document.elementFromPoint(cx,cy);
                out.under_target = el?(el.tagName+'.'+(el.getAttribute('class')||'')):'null';
              }
              return out;
            }"""
        )
        print("STEP2_dom_diag:", json.dumps(diag))

        # Try a REAL click at the highlight center, then read selectedId.
        center = diag.get("center")
        if center:
            page.mouse.click(center["x"], center["y"])
            page.wait_for_timeout(200)
            st2 = page.evaluate("()=>window.__laxState()")
            print("STEP3_after_click_selectedId:", st2["selectedId"], "full:", json.dumps(st2))
            page.screenshot(path=str(SHOTS / "02_after_click.png"))

            # Press Delete and see if the highlight is removed.
            page.keyboard.press("Delete")
            page.wait_for_timeout(200)
            st3 = page.evaluate("()=>window.__laxState()")
            print("STEP4_after_delete:", json.dumps(st3))
            page.screenshot(path=str(SHOTS / "03_after_delete.png"))

        print("PAGEERRORS:", logs)
        b.close()

    print("\n=== interpretation ===")
    if not diag.get("highlight_rect_present"):
        print("FAIL: highlight-rect not rendered -> creation path broken")
        return 1
    if diag.get("click_target_count", 0) == 0:
        print("FAIL: no transparent SVG click-target rendered -> AnnotLayer not drawing targets in this mode")
        return 1
    print(f"annot-layer pointer-events = {diag.get('annot_layer_pe')!r}  (expected 'none' in default mode)")
    print(f"click-target pointer-events = {diag.get('target_pe')!r}  (expected 'all')")
    print(f"elementFromPoint @ target center = {diag.get('under_target')!r}")
    print(f"elementFromPoint @ highlight center = {diag.get('under_center')!r}")
    if diag.get("under_is_annot_svg"):
        print("RESULT: click-target IS hit-testable -> selection should work. Bug may differ from hypothesis.")
        return 0
    else:
        print("RESULT: click-target is NOT hit-testable (something above it, or parent pe:none shadows it).")
        print("        -> This is the root cause: highlight cannot be selected -> Delete cannot fire.")
        return 0


if __name__ == "__main__":
    sys.exit(main())
