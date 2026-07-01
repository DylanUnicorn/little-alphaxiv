"""Verify highlights no longer stack on the same characters (one color per char).

Reproduce the original bug:
  1. highlight a span of text with color A -> N highlight-rects appear
  2. re-highlight the SAME span with color B
     BUG (before fix): rects stack -> A+B rects overlap the same chars and
        mix-blend-mode:multiply darkens them into an unreadable block;
        total rect count grows with each re-highlight.
     FIX (after fix): the new highlight REPLACES the overlapping old one, so
        the rect set for those chars is exactly color B (one color per char),
        and the page's total highlight-rect count does NOT grow unboundedly.

Assertions:
  - After re-highlighting the same span with a different color, every
    .highlight-rect covering the selection's bbox is the new color (no old
    color rects remain on those chars).
  - Total highlight-rect count after a 2nd re-highlight of the same span stays
    equal to (not greater than) the count after the 1st highlight.

Run (backend :8000, frontend :5180 [worktree], mock_llm :5050):
    conda run -n Agent_env python tools/drive_highlight_nostack.py
"""
import codecs, json, os, sys, time
from pathlib import Path
from playwright.sync_api import sync_playwright

sys.stdout = codecs.getwriter("utf-8")(sys.stdout.buffer, errors="replace")
APP = os.environ.get("APP_URL", "http://127.0.0.1:5180")
PROV = {"name": "mock", "base_url": "http://127.0.0.1:5050/v1", "api_key": "mock", "model": "mock-model"}
SHOTS = Path(__file__).parent / "shots_highlight_nostack"
SHOTS.mkdir(exist_ok=True)
ARXIV = "1706.03762"
YELLOW = "#ffeb3b"   # palette index 0
GREEN = "#a5f3a0"    # palette index 1


def seed(page):
    page.goto(f"{APP}/settings", wait_until="networkidle")
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


def all_rect_colors(page):
    """Background colors of every .highlight-rect on the page."""
    return page.eval_on_selector_all(
        ".highlight-rect",
        "els=>els.map(e=>getComputedStyle(e).backgroundColor)",
    )


def select_span_range(page, a, c):
    page.mouse.move(a["x"], a["y"])
    page.mouse.down()
    page.mouse.move(c["x"], c["y"], steps=12)
    page.mouse.up()
    page.wait_for_timeout(350)


def pick_swatch(page, index):
    # The bubble's swatches are in PALETTE order; click by index.
    page.evaluate(
        """(i)=>{
          const sws=[...document.querySelectorAll('.highlight-bubble-swatch')];
          if(sws[i]) sws[i].dispatchEvent(new MouseEvent('mousedown',{bubbles:true,cancelable:true,button:0}));
        }""",
        index,
    )
    page.wait_for_timeout(350)


with sync_playwright() as pw:
    b = pw.chromium.launch(headless=True)
    page = b.new_context(viewport={"width": 1500, "height": 950}).new_page()
    logs = []
    page.on("pageerror", lambda e: logs.append(str(e)))

    seed(page)
    page.goto(f"{APP}/paper/{ARXIV}", wait_until="domcontentloaded")
    page.wait_for_selector(".pdf-textlayer span", timeout=30000)
    page.wait_for_timeout(1500)

    spans = page.evaluate(
        """()=>{const s=[...document.querySelectorAll('.pdf-page-wrap .pdf-textlayer span')];
        return s.slice(0,8).map(e=>{const r=e.getBoundingClientRect();return {text:e.textContent, x:r.left+r.width/2, y:r.top+r.height/2, w:r.width, h:r.height};});}"""
    )
    print("first_spans:", json.dumps(spans[:4]))
    if len(spans) < 6:
        print("FAIL: not enough textlayer spans; aborting"); b.close(); sys.exit(1)
    a = spans[1]
    c = spans[5]

    # Turn highlight ON (🖍️ button). The Tooltip wrapper sets aria-label
    # (not native title=, which the speech-bubble tooltip replaced), so we
    # target by aria-label. Clicking toggles highlightOn.
    page.locator('button[aria-label="Highlight (toggle)"]').click()
    page.wait_for_timeout(200)

    # 1st highlight: yellow (swatch index 0).
    select_span_range(page, a, c)
    if page.eval_on_selector_all(".highlight-bubble-swatch", "els=>els.length") == 0:
        print("FAIL: no bubble appeared on 1st select; pageerrors:", logs); b.close(); sys.exit(1)
    pick_swatch(page, 0)
    n1 = page.eval_on_selector_all(".highlight-rect", "els=>els.length")
    colors1 = all_rect_colors(page)
    page.screenshot(path=str(SHOTS / "01_after_yellow.png"))
    print("after_1st_highlight(rect_count, colors):", n1, json.dumps(colors1))

    # 2nd highlight: SAME span, green (swatch index 1).
    select_span_range(page, a, c)
    if page.eval_on_selector_all(".highlight-bubble-swatch", "els=>els.length") == 0:
        print("FAIL: no bubble appeared on 2nd select; pageerrors:", logs); b.close(); sys.exit(1)
    pick_swatch(page, 1)
    n2 = page.eval_on_selector_all(".highlight-rect", "els=>els.length")
    colors2 = all_rect_colors(page)
    page.screenshot(path=str(SHOTS / "02_after_green_rehighlight.png"))
    print("after_2nd_highlight(rect_count, colors):", n2, json.dumps(colors2))

    # 3rd highlight: SAME span, yellow again (swatch index 0) — to confirm no growth.
    select_span_range(page, a, c)
    pick_swatch(page, 0)
    n3 = page.eval_on_selector_all(".highlight-rect", "els=>els.length")
    colors3 = all_rect_colors(page)
    page.screenshot(path=str(SHOTS / "03_after_yellow_rehighlight.png"))
    print("after_3rd_highlight(rect_count, colors):", n3, json.dumps(colors3))

    # ---- assertions ----
    ok = True
    # After re-highlighting green, every highlight rect on the page should be
    # green (the old yellow rects were removed — one color per character).
    distinct2 = set(colors2)
    if distinct2 != {"rgb(165, 243, 160)"}:  # green
        print(f"FAIL: after re-highlight, rect colors = {distinct2} (expected only green) — old color rects not removed")
        ok = False
    else:
        print("PASS: re-highlighted chars carry only the new color (no stacking)")

    # Rect count must not grow unboundedly with each re-highlight of the same span.
    if n2 > n1:
        print(f"FAIL: rect count grew on re-highlight ({n1} -> {n2}) — old rects not removed")
        ok = False
    else:
        print(f"PASS: rect count did not grow on re-highlight ({n1} -> {n2})")
    if n3 > n2:
        print(f"FAIL: rect count grew on 3rd re-highlight ({n2} -> {n3})")
        ok = False

    print("PAGEERRORS:", logs)
    print("RESULT:", "PASS" if ok else "FAIL")
    b.close()
    sys.exit(0 if ok else 1)
