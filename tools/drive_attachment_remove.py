"""Focused regression for the attachment-remove × button.

Mounts ChatComposer via frontend/attachment-test.html (no backend/auth needed),
then verifies the bug is fixed:

  1. the × button exists as a DIRECT child of .composer-attachment (not wrapped
     in .tooltip-host — the root cause of the bug),
  2. hovering the thumbnail reveals the × (opacity transitions to 1),
  3. clicking the × removes the thumbnail.

Run with the frontend dev server already up on :5173.
"""

import sys

from playwright.sync_api import sync_playwright

URL = "http://127.0.0.1:5173/attachment-test.html"


def main() -> int:
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page()
        page.goto(URL, wait_until="domcontentloaded")

        # Capture console errors so an import/render failure fails the test
        # loudly instead of silently passing on a timeout.
        errors: list[str] = []
        page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
        page.on("pageerror", lambda e: errors.append(str(e)))

        page.wait_for_selector(".composer-attachment", timeout=10_000)

        # (1) Root-cause assertion: the remove button must NOT live inside a
        # .tooltip-host span — that host is position:relative + 0×0 (its only
        # children are absolute/fixed), so it pulled the button's absolute
        # anchor off the 56×56 .composer-attachment box and overflow:hidden
        # clipped it off-screen.
        host_wraps_btn = page.evaluate(
            """() => {
              const btn = document.querySelector('.composer-attachment-remove');
              if (!btn) return false;
              let n = btn.parentElement;
              while (n && n !== document.body) {
                if (n.classList && n.classList.contains('tooltip-host')) return true;
                n = n.parentElement;
              }
              return false;
            }"""
        )
        if host_wraps_btn:
            print("FAIL: remove button is still wrapped in .tooltip-host (root cause not fixed)")
            browser.close()
            return 1

        # (2) Hover the thumbnail → the × must become visible (opacity 1).
        page.locator(".composer-attachment").hover()
        page.wait_for_function(
            """() => {
              const e = document.querySelector('.composer-attachment-remove');
              if (!e) return false;
              return getComputedStyle(e).opacity === '1';
            }""",
            timeout=5_000,
        )

        # (3) Click × → the thumbnail must detach.
        page.locator(".composer-attachment-remove").click()
        page.wait_for_selector(".composer-attachment", state="detached", timeout=5_000)

        if errors:
            print(f"FAIL: console/page errors during run: {errors}")
            browser.close()
            return 1

        print("PASS: hover reveals × and clicking it removes the attachment")
        browser.close()
        return 0


if __name__ == "__main__":
    sys.exit(main())
