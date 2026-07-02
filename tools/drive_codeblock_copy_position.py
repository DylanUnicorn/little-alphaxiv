"""Playwright layout test: code-block copy button + tooltip bubble placement.

Regression for TWO bugs in the code-block copy button:
  1. Copy button landed top-LEFT instead of top-right.
  2. The "Copy" tooltip bubble landed top-LEFT, detached from the button.

Root cause for both: the copy <button> is wrapped in <Tooltip>, whose host
span (.tooltip-host, inline-flex) ends up 0×0 because BOTH its children are
out-of-flow — the button is position:absolute, the bubble is position:fixed.
A 0×0 host (at the top-left of .code-block, where the first inline child
sits) is the source of both symptoms:
  • Button: with the host position:relative, the 0×0 host is the button's
    containing block → top:6px;right:6px resolves against a 0-width box at the
    top-left → button at top-left.
  • Bubble: Tooltip.tsx places the bubble via hostRef.getBoundingClientRect()
    → a 0×0 rect at the top-left → bubble computed to the top-left.

The fix moves the absolute positioning from the button to the HOST and lets
the button flow inside it (inline-flex shrink-wraps the button). Now the host
has a real on-screen rect at the top-right: the button sits there in-flow,
and the tooltip measures that real rect → bubble lands just below the button.

This script needs NO servers: it renders a static HTML fixture mirroring the
exact DOM + CSS from the app in real Chromium, then asserts:
  • Button anchors top-RIGHT (right gap ≈ 6px), inside the code box.
  • Host has a NON-zero size co-located with the button (the root-cause
    invariant — a 0×0 host is what sent the bubble to the top-left).
  • The tooltip bubble, placed via Tooltip.tsx's exact bottom-side math
    (copied verbatim), lands BELOW the button — not at the top-left.

It runs both the BUGGY CSS (base rules only) and the FIXED CSS (with the
override) to prove the override is what fixes it.

Usage:  python tools/drive_codeblock_copy_position.py
"""
from __future__ import annotations

import codecs
import sys

from playwright.sync_api import sync_playwright

sys.stdout = codecs.getwriter("utf-8")(sys.stdout.buffer, errors="replace")
sys.stderr = codecs.getwriter("utf-8")(sys.stderr.buffer, errors="replace")

failures: list[str] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    tag = "PASS" if ok else "FAIL"
    print(f"[{tag}] {name}{(' — ' + detail) if detail else ''}")
    if not ok:
        failures.append(name)


# CSS rules mirrored verbatim from frontend/src/index.css (relevant slices).
BASE_CSS = """
.code-block { position: relative; margin: 8px 0; }
.code-block-copy {
  position: absolute; top: 6px; right: 6px; z-index: 2;
  border: 1px solid #888; background: #222; color: #eee;
  border-radius: 4px; cursor: pointer; font-size: 12px; padding: 2px 6px;
  opacity: 1; transition: opacity 0.15s;
}
.code-block:hover .code-block-copy { opacity: 1; }
.tooltip-host { display: inline-flex; position: relative; flex-shrink: 0; max-width: 100%; }
.tooltip-bubble { position: fixed; top: 0; left: 0; max-width: 240px; padding: 4px 9px;
  background: #333; color: #eee; border-radius: 8px; }
.code-block pre {
  margin: 0; padding: 12px; overflow-x: auto;
  background: #1e1e1e; color: #eee; border: 1px solid #444; border-radius: 6px;
  font-size: 13px; line-height: 1.5;
}
"""
# The fix: host carries the absolute positioning; button flows inside it.
FIX_CSS = """
.code-block .tooltip-host { position: absolute; top: 6px; right: 6px; z-index: 2; }
.code-block .code-block-copy { position: static; }
"""

# DOM mirrors CodePre + Tooltip render: .code-block > .tooltip-host > button + bubble, + pre.
HTML_TMPL = """
<!doctype html><html><head><meta charset="utf-8">
<style>
  body {{ background:#fff; margin:0; padding:24px; font-family:sans-serif; }}
  {css}
</style></head><body>
<div class="code-block">
  <span class="tooltip-host">
    <button class="code-block-copy">⧉</button>
    <span class="tooltip-bubble">Copy</span>
  </span>
  <pre><code class="hljs">attn = softmax(Q @ K.T / sqrt(d)) @ V</code></pre>
</div>
</body></html>
"""

# Tooltip.tsx positioning constants (copied verbatim from Tooltip.tsx).
GAP = 8
VIEWPAD = 6


def clamp(start: float, size: float, vmax: float) -> float:
    lo = VIEWPAD
    hi = vmax - size - VIEWPAD
    if hi < lo:
        return max(0.0, (vmax - size) / 2)
    return min(hi, max(lo, start))


def tooltip_bubble_placement(hr, br, vw, vh, side="bottom"):
    """Replicate Tooltip.tsx's useLayoutEffect placement for `side` (no flip:
    the code block sits in the upper viewport, so bottom has room). Returns
    (top, left) viewport pixels the bubble would be set to."""
    room_bottom = vh - hr["bottom"] - br["height"] - GAP - VIEWPAD
    chosen = side if room_bottom >= 0 else "top"  # mirror auto-flip
    cx = hr["left"] + hr["width"] / 2
    if chosen == "top":
        top = hr["top"] - br["height"] - GAP
    else:  # bottom
        top = hr["bottom"] + GAP
    left = clamp(cx - br["width"] / 2, br["width"], vw)
    return top, left


def measure(page, css: str):
    page.set_content(HTML_TMPL.format(css=css), wait_until="load")
    page.wait_for_timeout(50)
    return page.evaluate(
        """() => {
      const cb = document.querySelector('.code-block').getBoundingClientRect();
      const btn = document.querySelector('.code-block-copy').getBoundingClientRect();
      const host = document.querySelector('.tooltip-host').getBoundingClientRect();
      const bub = document.querySelector('.tooltip-bubble').getBoundingClientRect();
      return {
        cb: {left: cb.left, right: cb.right, top: cb.top, bottom: cb.bottom, width: cb.width, height: cb.height},
        btn: {left: btn.left, right: btn.right, top: btn.top, bottom: btn.bottom, width: btn.width, height: btn.height},
        host: {left: host.left, right: host.right, top: host.top, bottom: host.bottom, width: host.width, height: host.height},
        bub: {left: bub.left, top: bub.top, width: bub.width, height: bub.height},
        vw: window.innerWidth, vh: window.innerHeight,
      };
    }"""
    )


def main():
    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True)
        page = browser.new_context(viewport={"width": 1200, "height": 800}).new_page()
        try:
            # ---------------- BUGGY CSS: base only (no override) ----------------
            b = measure(page, BASE_CSS)
            b_btn_right_gap = b["cb"]["right"] - b["btn"]["right"]
            # Button lands near the LEFT (containing block = 0×0 host at top-left).
            check(
                "buggy: button lands near LEFT (repro)",
                b["btn"]["left"] - b["cb"]["left"] < b["cb"]["width"] / 2,
                f"btn_left={b['btn']['left']:.1f} cb_left={b['cb']['left']:.1f} "
                f"right_gap={b_btn_right_gap:.1f}px (large = button at left)",
            )
            # Host is 0×0 (root-cause invariant in the buggy state).
            check(
                "buggy: host is 0x0 (root cause present)",
                b["host"]["width"] < 2 and b["host"]["height"] < 2,
                f"host={b['host']['width']:.1f}x{b['host']['height']:.1f}",
            )
            # Bubble, placed via Tooltip math, lands at the top-LEFT.
            bt, bl = tooltip_bubble_placement(b["host"], b["bub"], b["vw"], b["vh"])
            check(
                "buggy: bubble computed to top-LEFT (above button, not below)",
                bt < b["btn"]["bottom"] and bl < b["cb"]["width"] / 2,
                f"bubble_top={bt:.1f} btn_bottom={b['btn']['bottom']:.1f} "
                f"bubble_left={bl:.1f}",
            )

            # ---------------- FIXED CSS: host carries the positioning ----------------
            f = measure(page, BASE_CSS + FIX_CSS)
            f_btn_right_gap = f["cb"]["right"] - f["btn"]["right"]
            # Button anchors top-RIGHT (right gap ≈ 6px), inside the code box.
            check(
                "fixed: button anchors top-RIGHT (right gap ~ 6px)",
                abs(f_btn_right_gap - 6) < 3,
                f"right_gap={f_btn_right_gap:.1f}px (want ~6) "
                f"btn_top={f['btn']['top']:.1f} cb_top={f['cb']['top']:.1f}",
            )
            check(
                "fixed: button top ~ 6px from code-block top (inside the box)",
                abs(f["btn"]["top"] - f["cb"]["top"] - 6) < 3,
                f"btn_top={f['btn']['top']:.1f} cb_top={f['cb']['top']:.1f}",
            )
            # Host has a real (non-zero) size — the root-cause fix.
            check(
                "fixed: host has non-zero size (root cause fixed)",
                f["host"]["width"] > 2 and f["host"]["height"] > 2,
                f"host={f['host']['width']:.1f}x{f['host']['height']:.1f}",
            )
            # Host is co-located with the button (same top, same right edge),
            # so the tooltip measures the button's actual on-screen position.
            check(
                "fixed: host co-located with button (~ same rect)",
                abs(f["host"]["top"] - f["btn"]["top"]) < 2
                and abs(f["host"]["right"] - f["btn"]["right"]) < 2
                and abs(f["host"]["width"] - f["btn"]["width"]) < 2,
                f"host_top={f['host']['top']:.1f} btn_top={f['btn']['top']:.1f} "
                f"host_right={f['host']['right']:.1f} btn_right={f['btn']['right']:.1f}",
            )
            # Bubble, placed via Tooltip math, lands BELOW the button and
            # horizontally near it — not at the top-left.
            ft, fl = tooltip_bubble_placement(f["host"], f["bub"], f["vw"], f["vh"])
            check(
                "fixed: bubble lands BELOW the button",
                ft > f["btn"]["bottom"],
                f"bubble_top={ft:.1f} btn_bottom={f['btn']['bottom']:.1f}",
            )
            check(
                "fixed: bubble horizontally near the button (not top-left)",
                abs(fl + f["bub"]["width"] / 2 - (f["btn"]["left"] + f["btn"]["width"] / 2)) < 4,
                f"bubble_left={fl:.1f} bubble_center={fl + f['bub']['width']/2:.1f} "
                f"btn_center={f['btn']['left'] + f['btn']['width']/2:.1f}",
            )
        finally:
            browser.close()

    n = len(failures)
    print(f"\n{'PASS' if n == 0 else 'FAIL'}: {n} check(s) failed"
          + ("" if not failures else " — " + ", ".join(failures)))
    sys.exit(1 if n else 0)


if __name__ == "__main__":
    main()
