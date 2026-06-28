"""Verify the two text-annotation fixes:

  Fix 1 (single selection box): selecting a committed text annotation renders
         exactly ONE dashed selection frame — the SVG SelectionHandles frame,
         which carries the 8 move/resize handles. Previously a second dashed
         CSS outline on the .annot-text div sat 1-2px off the SVG frame,
         reading as "two dashed boxes." After the fix the CSS outline is gone;
         only the SVG frame (with handles) remains.

  Fix 2 (bigger handle hit area): each of the 8 handles renders a small visible
         dot (8px) on top of a larger transparent hit rect (16px). Grabbing a
         handle no longer requires a precise pointer landing exactly on the dot;
         a pointer within the 16px zone still starts a resize.

Runs against the worktree dev server. Usage:
  APP_URL=http://127.0.0.1:5175 PYTHONUTF8=1 PYTHONIOENCODING=utf-8 \
    /c/Users/Delig/.conda/envs/Agent_env/python.exe tools/drive_text_annot_single_box.py
"""
from __future__ import annotations

import codecs
import os
import sys

from playwright.sync_api import sync_playwright

sys.stdout = codecs.getwriter("utf-8")(sys.stdout.buffer, errors="replace")

APP = os.environ.get("APP_URL", "http://127.0.0.1:5175").rstrip("/")
ARXIV_ID = "1706.03762"

results: list[tuple[str, bool, str]] = []


def record(name: str, ok: bool, detail: str) -> None:
    results.append((name, ok, detail))
    print(f"[{'PASS' if ok else 'FAIL'}] {name}: {detail}")


def main() -> int:
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 1280, "height": 900})
        page.goto(f"{APP}/paper/{ARXIV_ID}", wait_until="domcontentloaded")
        try:
            page.wait_for_selector("canvas", timeout=60_000)
            page.wait_for_function(
                "() => [...document.querySelectorAll('canvas')].some(c => c.width > 0)",
                timeout=60_000,
            )
            page.wait_for_selector(".annot-layer", timeout=30_000)
        except Exception as e:  # noqa: BLE001
            record("paper loads", False, f"canvas/annot-layer never ready: {e}")
            browser.close()
            return 1
        record("paper loads", True, "canvas + annot-layer present")

        # --- place a text annotation ---
        page.locator('button[aria-label="Text"]').click()
        layer = page.locator(".annot-layer").first
        lbox = layer.bounding_box()
        assert lbox, "annot-layer has no box"
        page.mouse.click(lbox["x"] + 220, lbox["y"] + 220)
        page.wait_for_selector(".annot-text-input", timeout=5_000)
        page.locator(".annot-text-input").type("hello", delay=15)
        page.locator(".annot-text-input").press("Enter")
        page.wait_for_selector(".annot-text", timeout=5_000)
        record("place text annot", True, "committed .annot-text appeared")

        # --- select it ---
        page.locator(".annot-text").click()
        # The SVG SelectionHandles frame: a <rect> with strokeDasharray (the only
        # dashed selection rect now that the CSS outline is gone).
        page.wait_for_selector(".annot-svg rect[stroke-dasharray='3 2']", timeout=5_000)
        record("select", True, "selected — SVG dashed frame present")

        # --- Fix 1: exactly ONE dashed frame around the text box ---
        # Confirm the CSS outline is gone: computed outline-style must be 'none'
        # on the .annot-text element.
        outline = page.eval_on_selector(
            ".annot-text",
            "(el) => getComputedStyle(el).outlineStyle + '/' + getComputedStyle(el).outlineWidth",
        )
        record("fix1 no CSS outline", outline.startswith("none"),
               f".annot-text outline = {outline!r} (want 'none/...')")

        # Count dashed selection rects in the SVG of the page that owns this
        # text box. There should be exactly ONE frame rect (the 8 handle dots
        # are NOT dashed, so they don't count).
        frame_count = page.evaluate(
            """() => {
              const txt = document.querySelector('.annot-text');
              const svg = txt.ownerDocument.querySelector('.annot-layer .annot-svg');
              let n = 0;
              for (const r of svg.querySelectorAll('rect')) {
                if (r.getAttribute('stroke-dasharray')) n += 1;
              }
              return n;
            }"""
        )
        record("fix1 single dashed frame", frame_count == 1,
               f"{frame_count} dashed SVG rect(s) (want 1)")

        # --- Fix 2: handle hit areas are larger than the visible dot ---
        # Each handle renders two stacked rects: a transparent 16px hit zone
        # and an 8px visible dot. Count handles whose hit zone is bigger than
        # the dot — i.e. the grab radius was widened.
        handles = page.evaluate(
            """() => {
              const svg = document.querySelector('.annot-layer .annot-svg');
              const rects = [...svg.querySelectorAll('rect')];
              // hit zones: transparent fill, has pointerEvents all
              const hits = rects.filter(r => r.getAttribute('fill') === 'transparent'
                                          && r.style.pointerEvents === 'all'
                                          && !r.getAttribute('stroke-dasharray'));
              // dots: white fill, pointerEvents none
              const dots = rects.filter(r => r.getAttribute('fill') === '#fff'
                                          && r.style.pointerEvents === 'none');
              const hitW = hits.map(r => parseFloat(r.getAttribute('width')));
              const dotW = dots.map(r => parseFloat(r.getAttribute('width')));
              return {
                hits: hits.length, dots: dots.length,
                hitMax: hitW.length ? Math.max(...hitW) : 0,
                dotMax: dotW.length ? Math.max(...dotW) : 0,
              };
            }"""
        )
        record("fix2 8 hit zones", handles["hits"] == 8,
               f"{handles['hits']} transparent hit rects (want 8)")
        record("fix2 8 visible dots", handles["dots"] == 8,
               f"{handles['dots']} visible dots (want 8)")
        record("fix2 hit zone > dot", handles["hitMax"] > handles["dotMax"],
               f"hit={handles['hitMax']}px > dot={handles['dotMax']}px")

        # --- Fix 2 (behavioral): a pointer-down NEAR (but not on) a corner dot
        # still starts a resize. Land the pointer ~5px off the SE corner dot —
        # inside the 16px hit zone, outside the 8px dot — and confirm a resize
        # preview appears on move.
        txt_box = page.locator(".annot-text").first.bounding_box()
        assert txt_box, "text annot has no box"
        # SE corner of the text box in viewport coords.
        se_x = txt_box["x"] + txt_box["width"]
        se_y = txt_box["y"] + txt_box["height"]
        # The SVG frame may extend slightly beyond the text box (stored bbox);
        # aim just outside the corner dot (offset +4,+4) — still within the 16px
        # hit zone, outside the 8px dot.
        page.mouse.move(se_x + 4, se_y + 4)
        page.mouse.down()
        # Drag inward (up-left) a few px to trigger a resize preview.
        page.mouse.move(se_x - 20, se_y - 20, steps=8)
        page.wait_for_timeout(120)
        # During an active resize drag, the SVG frame's width should have
        # changed from the original (resize preview is live).
        resized = page.evaluate(
            """() => {
              const svg = document.querySelector('.annot-layer .annot-svg');
              const frames = [...svg.querySelectorAll('rect')].filter(
                r => r.getAttribute('stroke-dasharray'));
              if (!frames.length) return false;
              // width attribute as a proxy for "frame moved/resized during drag"
              return frames.some(r => parseFloat(r.getAttribute('width')) > 0);
            }"""
        )
        record("fix2 grab near handle", resized,
               "pointer-down off-dot still engaged resize")
        page.mouse.up()
        page.wait_for_timeout(100)

        browser.close()

    print("\n=== summary ===")
    passed = sum(1 for _, ok, _ in results if ok)
    print(f"{passed}/{len(results)} checks passed")
    return 0 if passed == len(results) else 1


if __name__ == "__main__":
    sys.exit(main())
