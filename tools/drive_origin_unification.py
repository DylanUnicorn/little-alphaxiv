"""Playwright smoke test for the loopback-origin unification feature.

Verifies the user-visible surface that the pure-function unit tests can't:
  A. On an EMPTY localhost origin, the recovery banner renders and is a
     FULL-WIDTH top bar (not a squished left column) -- the layout bug the
     final whole-branch review caught.
  C. Dismissing the banner persists across a reload (localStorage key
     `lax-origin-banner-dismissed`).
  B. On an EMPTY 127.0.0.1 origin, the app redirects to localhost and the
     `?laxredir=1` marker is stripped from the final URL.

Run while the Vite dev server is up on :5173. Uses fresh browser contexts so
each origin starts with empty IndexedDB (the "no history" case). The
"no-redirect-when-data-exists" path is covered by lib/origin.test.ts (the
pure decision returns null when hasHistory is true), so it is not re-driven
here.

Usage (from the worktree root, Agent_env python):
    python tools/drive_origin_unification.py
"""
import os
import sys
import time

from playwright.sync_api import sync_playwright

# Port is configurable so the test can run against a worktree dev server on a
# non-default port (when :5173 is already taken by another dev server).
_PORT = os.environ.get("LAX_PORT", "5173")
DEV = f"http://localhost:{_PORT}"
SIBLING = f"http://127.0.0.1:{_PORT}"


def main() -> None:
    failures: list[str] = []
    with sync_playwright() as p:
        browser = p.chromium.launch()

        # --- Test A + C: banner on empty localhost, full-width, dismiss persists ---
        ctx = browser.new_context(viewport={"width": 1280, "height": 800})
        page = ctx.new_page()
        page.goto(DEV + "/", wait_until="domcontentloaded")
        try:
            page.wait_for_selector(".origin-banner", state="visible", timeout=8000)
        except Exception as e:  # noqa: BLE001
            failures.append(f"A: .origin-banner not visible on empty localhost: {e}")
        else:
            box = page.locator(".origin-banner").bounding_box()
            vw = page.viewport_size["width"]
            if not box:
                failures.append("A: banner has no bounding box")
            else:
                # Full-width top bar: width ~= viewport width, pinned near the top.
                # (The bug this guards against: banner as a row flex item -> a narrow
                # left column, width far below viewport width.)
                if box["width"] < vw - 20:
                    failures.append(
                        f"A: banner NOT full-width: width={box['width']} vw={vw}"
                    )
                if box["y"] > 60:
                    failures.append(f"A: banner not at top: y={box['y']}")
                if not failures:
                    print(
                        f"A OK: banner visible, "
                        f"{box['width']:.0f}x{box['height']:.0f}px at y={box['y']:.0f} "
                        f"(vw={vw})"
                    )
            # Test C: dismiss persists across reload.
            try:
                page.locator(".origin-banner-dismiss").click()
                page.wait_for_selector(".origin-banner", state="detached", timeout=4000)
                page.reload(wait_until="domcontentloaded")
                time.sleep(0.6)  # let load() + banner decision settle
                if page.locator(".origin-banner").count() > 0:
                    failures.append(
                        "C: banner reappeared after dismiss+reload "
                        "(dismissal not persisted in localStorage)"
                    )
                else:
                    print("C OK: dismiss persisted across reload")
            except Exception as e:  # noqa: BLE001
                failures.append(f"C: dismiss/reload flow failed: {e}")
        ctx.close()

        # --- Test B: empty 127.0.0.1 redirects to localhost, laxredir stripped ---
        ctx = browser.new_context(viewport={"width": 1280, "height": 800})
        page = ctx.new_page()
        page.goto(SIBLING + "/", wait_until="domcontentloaded")
        try:
            page.wait_for_url(lambda u: u.startswith(DEV), timeout=10000)
        except Exception as e:  # noqa: BLE001
            failures.append(
                f"B: did not redirect 127.0.0.1 -> localhost: {e}; url={page.url}"
            )
        else:
            # The strip effect removes ?laxredir=1 on the localhost arrival.
            page.wait_for_function(
                "() => !location.search.includes('laxredir')", timeout=8000
            )
            if "127.0.0.1" in page.url:
                failures.append(f"B: still on 127.0.0.1: {page.url}")
            elif "laxredir" in page.url:
                failures.append(f"B: laxredir not stripped: {page.url}")
            else:
                print(f"B OK: redirected to {page.url} (laxredir stripped)")
        ctx.close()

        browser.close()

    if failures:
        print("\nFAILURES:")
        for f in failures:
            print("  -", f)
        sys.exit(1)
    print("\nALL ORIGIN-UNIFICATION SMOKE TESTS PASSED")


if __name__ == "__main__":
    main()
