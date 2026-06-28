"""Smoke check that the SelectionHandles change (bigger hit area, single frame)
didn't regress rect annotations — which share SelectionHandles with text."""
from __future__ import annotations
import codecs, os, sys
from playwright.sync_api import sync_playwright

sys.stdout = codecs.getwriter("utf-8")(sys.stdout.buffer, errors="replace")
APP = os.environ.get("APP_URL", "http://127.0.0.1:5175").rstrip("/")
ARXIV_ID = "1706.03762"
ok = True

with sync_playwright() as p:
    b = p.chromium.launch()
    pg = b.new_page(viewport={"width": 1280, "height": 900})
    pg.goto(f"{APP}/paper/{ARXIV_ID}", wait_until="domcontentloaded")
    pg.wait_for_selector(".annot-layer", timeout=30_000)

    # draw a rect
    pg.locator('button[aria-label="Rectangle"]').click()
    lb = pg.locator(".annot-layer").first.bounding_box()
    pg.mouse.move(lb["x"] + 100, lb["y"] + 120)
    pg.mouse.down()
    pg.mouse.move(lb["x"] + 260, lb["y"] + 220, steps=10)
    pg.mouse.up()
    pg.wait_for_timeout(150)
    # rect committed -> an SVG rect with fill+stroke (not transparent, not dashed-frame)
    n = pg.eval_on_selector_all(
        ".annot-layer .annot-svg rect",
        "(rs) => rs.filter(r => r.getAttribute('fill') !== 'transparent' && r.getAttribute('fill') !== 'none' && !r.getAttribute('stroke-dasharray')).length",
    )
    print(f"[{'PASS' if n>=1 else 'FAIL'}] rect committed: {n} solid rect(s)")
    ok = ok and n >= 1

    # select the rect by clicking its right edge; expect dashed frame + 8 handles.
    # The rect's pointer-events is "stroke" (only the 1.5px border is hit-testable,
    # not the fill), so click on the right border, not the center fill.
    pg.mouse.click(lb["x"] + 260, lb["y"] + 170)
    pg.wait_for_timeout(150)
    sel = pg.evaluate(
        """() => {
          const svg = document.querySelector('.annot-layer .annot-svg');
          const frames = [...svg.querySelectorAll('rect')].filter(r => r.getAttribute('stroke-dasharray'));
          const hits = [...svg.querySelectorAll('rect')].filter(r => r.getAttribute('fill')==='transparent' && r.style.pointerEvents==='all' && !r.getAttribute('stroke-dasharray'));
          const dots = [...svg.querySelectorAll('rect')].filter(r => r.getAttribute('fill')==='#fff' && r.style.pointerEvents==='none');
          return {frames: frames.length, hits: hits.length, dots: dots.length};
        }"""
    )
    print(f"[{'PASS' if sel['frames']==1 and sel['hits']==8 and sel['dots']==8 else 'FAIL'}] rect selection: frame={sel['frames']} hits={sel['hits']} dots={sel['dots']} (want 1/8/8)")
    ok = ok and sel['frames']==1 and sel['hits']==8 and sel['dots']==8

    b.close()

print("\n=== " + ("ALL PASS" if ok else "FAILURES") + " ===")
sys.exit(0 if ok else 1)
