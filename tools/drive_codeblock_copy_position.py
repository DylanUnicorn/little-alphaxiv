"""Playwright layout test: code-block copy button anchors top-RIGHT.

Regression for the bug where the copy button on assistant code blocks jumped
to the top-LEFT corner. Root cause: the copy button is wrapped in <Tooltip>,
whose host span (`.tooltip-host`) is `position: relative`. That 0-sized host
(its only children are out-of-flow — the button is absolute, the bubble is
fixed) became the button's containing block, so `top:6px; right:6px` resolved
against a 0x0 box at the top-left of `.code-block` and dumped the button there.

The fix: `.code-block .tooltip-host { position: static; }` — neutralizes the
host inside code blocks so `.code-block` (position: relative) stays the
containing block. The tooltip bubble is position:fixed (viewport-relative,
placed via the host's getBoundingClientRect), so it is unaffected.

This script needs NO servers: it renders a static HTML fixture that mirrors
the exact DOM + CSS rules from the app in real Chromium and asserts the
button's right edge sits ~6px from the code-block's right edge (top-right),
not at the left edge (top-left). It runs both the BUGGY CSS (no override) and
the FIXED CSS (with override) to prove the override is what fixes it.

Usage:  python tools/drive_codeblock_copy_position.py
"""
from __future__ import annotations

import codecs
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

sys.stdout = codecs.getwriter("utf-8")(sys.stdout.buffer, errors="replace")
sys.stderr = codecs.getwriter("utf-8")(sys.stderr.buffer, errors="replace")

failures: list[str] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    tag = "PASS" if ok else "FAIL"
    print(f"[{tag}] {name}{(' — ' + detail) if detail else ''}")
    if not ok:
        failures.append(name)


# CSS rules mirrored verbatim from frontend/src/index.css (the relevant slices).
BASE_CSS = """
.code-block { position: relative; margin: 8px 0; }
.code-block-copy {
  position: absolute; top: 6px; right: 6px; z-index: 2;
  border: 1px solid #888; background: #222; color: #eee;
  border-radius: 4px; cursor: pointer; font-size: 12px; padding: 2px 6px;
  opacity: 1; transition: opacity 0.15s;
}
.tooltip-host { display: inline-flex; position: relative; flex-shrink: 0; max-width: 100%; }
.code-block pre {
  margin: 0; padding: 12px; overflow-x: auto;
  background: #1e1e1e; color: #eee; border: 1px solid #444; border-radius: 6px;
  font-size: 13px; line-height: 1.5;
}
"""
FIX_CSS = ".code-block .tooltip-host { position: static; }"

# DOM mirrors CodePre's render: .code-block > .tooltip-host > button + bubble, + pre.
HTML_TMPL = """
<!doctype html><html><head><meta charset="utf-8">
<style>
  body {{ background:#fff; margin:0; padding:24px; font-family:sans-serif; }}
  {css}
</style></head><body>
<div class="code-block">
  <span class="tooltip-host">
    <button class="code-block-copy">⧉</button>
    <span class="tooltip-bubble" data-show="false">Copy</span>
  </span>
  <pre><code class="hljs">attn = softmax(Q @ K.T / sqrt(d)) @ V</code></pre>
</div>
</body></html>
"""


def measure(page, css: str) -> dict:
    page.set_content(HTML_TMPL.format(css=css), wait_until="load")
    page.wait_for_timeout(50)
    return page.evaluate(
        """() => {
      const cb = document.querySelector('.code-block').getBoundingClientRect();
      const btn = document.querySelector('.code-block-copy').getBoundingClientRect();
      const host = document.querySelector('.tooltip-host').getBoundingClientRect();
      return {
        cb_right: cb.right, cb_left: cb.left, cb_top: cb.top, cb_width: cb.width,
        btn_right: btn.right, btn_left: btn.left, btn_top: btn.top, btn_width: btn.width,
        host_width: host.width, host_height: host.height,
      };
    }"""
    )


def main():
    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True)
        page = browser.new_context(viewport={"width": 1200, "height": 800}).new_page()
        try:
            # ---- BUGGY CSS: no override → host is the containing block (0x0) ----
            b = measure(page, BASE_CSS)
            # In the buggy state the host collapses toward 0 width and the button
            # sits at the LEFT edge of the code-block (its right edge far from the
            # code-block's right edge).
            buggy_right_gap = b["cb_right"] - b["btn_right"]
            buggy_left_gap = b["btn_left"] - b["cb_left"]
            check(
                "buggy: button lands near LEFT (repro)",
                b["btn_left"] - b["cb_left"] < b["cb_width"] / 2,
                f"btn_left={b['btn_left']:.1f} cb_left={b['cb_left']:.1f} "
                f"right_gap={buggy_right_gap:.1f}px (should be large)",
            )

            # ---- FIXED CSS: host neutralized → .code-block is the containing block ----
            f = measure(page, BASE_CSS + FIX_CSS)
            fixed_right_gap = f["cb_right"] - f["btn_right"]
            fixed_left_gap = f["btn_left"] - f["cb_left"]
            # The button's right edge should be ~6px (right:6px) from the code-block's
            # right edge, and its top ~6px (top:6px) from the code-block's top — i.e.
            # top-RIGHT, not top-left.
            check(
                "fixed: button anchors top-RIGHT (right gap ≈ 6px)",
                abs(fixed_right_gap - 6) < 3,
                f"right_gap={fixed_right_gap:.1f}px (want ~6) "
                f"left_gap={fixed_left_gap:.1f}px (want large)",
            )
            check(
                "fixed: button top ≈ 6px from code-block top",
                abs(f["btn_top"] - f["cb_top"] - 6) < 3,
                f"btn_top={f['btn_top']:.1f} cb_top={f['cb_top']:.1f}",
            )
        finally:
            browser.close()

    n = len(failures)
    print(f"\n{'PASS' if n == 0 else 'FAIL'}: {n} check(s) failed"
          + ("" if not failures else " — " + ", ".join(failures)))
    sys.exit(1 if n else 0)


if __name__ == "__main__":
    main()
