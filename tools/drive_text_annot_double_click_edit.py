"""Verify double-click-to-edit on a placed text annotation (regression for the
feature that was previously scaffolded but never wired).

  Check 1 (trigger + pre-fill): double-clicking a committed .annot-text swaps it
          for an .annot-text-input (contentEditable) that is pre-filled with the
          annotation's current content, focused, caret at end.

  Check 2 (commit edit): typing an addition + Enter commits an `edit` op — the
          .annot-text re-renders with the NEW content.

  Check 3 (no-op guard): opening the editor and pressing Enter WITHOUT changing
          the text does NOT consume an undo step (no redundant edit op).

  Check 4 (clear → remove): clearing all text + Enter removes the annotation.

Runs against the worktree dev server. Usage:
  APP_URL=http://127.0.0.1:5175 PYTHONUTF8=1 PYTHONIOENCODING=utf-8 \
    /c/Users/Delig/.conda/envs/Agent_env/python.exe tools/drive_text_annot_double_click_edit.py
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


def undo_depth(page) -> int:
    """Count undo steps by reading the store's undoStack length via the DOM
    bridge is not available, so we proxy it through the keyboard: we can't read
    state directly. Instead we detect whether Undo changes anything visible by
    snapshotting the text content before/after an Undo keypress."""
    # not used; kept for clarity. We use before/after content snapshots instead.
    return -1


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

        # --- Check 1: double-click opens a pre-filled editor ---
        txt = page.locator(".annot-text").first
        txt_box = txt.bounding_box()
        assert txt_box, "text annot has no box"
        # Double-click near the center of the text box.
        page.mouse.dblclick(txt_box["x"] + 30, txt_box["y"] + 8)
        page.wait_for_selector(".annot-text-input", timeout=5_000)
        # The static .annot-text should be gone while editing (swapped for input).
        static_visible = page.locator(".annot-text").count()
        prefill = page.locator(".annot-text-input").first.inner_text()
        record(
            "dblclick opens editor",
            static_visible == 0 and prefill.strip() == "hello",
            f"static_count={static_visible}, prefill={prefill!r} (want 0 / 'hello')",
        )
        # Focused + caret at end: appending " world" should produce "hello world".
        page.locator(".annot-text-input").type(" world", delay=15)

        # --- Check 2: Enter commits an edit op; .annot-text shows new text ---
        page.locator(".annot-text-input").press("Enter")
        page.wait_for_selector(".annot-text", timeout=5_000)
        new_content = page.locator(".annot-text").first.inner_text()
        record(
            "edit commits new text",
            new_content.strip() == "hello world",
            f".annot-text content = {new_content!r} (want 'hello world')",
        )

        # --- Check 3: no-op guard — open editor, change nothing, Enter ---
        txt = page.locator(".annot-text").first
        tb = txt.bounding_box()
        assert tb
        page.mouse.dblclick(tb["x"] + 30, tb["y"] + 8)
        page.wait_for_selector(".annot-text-input", timeout=5_000)
        before = page.locator(".annot-text").count()  # should be 0 (editing)
        page.locator(".annot-text-input").press("Enter")
        page.wait_for_selector(".annot-text", timeout=5_000)
        after_content = page.locator(".annot-text").first.inner_text()
        # The content must be unchanged, and pressing Undo once right now must
        # revert to "hello" (the pre-edit state). If a redundant no-op edit had
        # been pushed, Undo would land on the no-op (still "hello world"), and a
        # SECOND Undo would be needed to reach "hello".
        page.keyboard.press("Control+z")
        page.wait_for_timeout(120)
        after_undo = page.locator(".annot-text").first.inner_text()
        record(
            "no-op guard (no redundant undo step)",
            before == 0
            and after_content.strip() == "hello world"
            and after_undo.strip() == "hello",
            f"content_after_commit={after_content!r}, after_1_undo={after_undo!r} "
            f"(want 'hello world' then 'hello')",
        )

        # Undo back to "hello world" for the next check.
        page.keyboard.press("Control+y")
        page.wait_for_timeout(120)

        # --- Check 4: clear text + Enter removes the annotation ---
        txt = page.locator(".annot-text").first
        tb = txt.bounding_box()
        assert tb
        page.mouse.dblclick(tb["x"] + 30, tb["y"] + 8)
        page.wait_for_selector(".annot-text-input", timeout=5_000)
        # Select all + delete to empty the box.
        page.locator(".annot-text-input").press("Control+a")
        page.locator(".annot-text-input").press("Delete")
        page.locator(".annot-text-input").press("Enter")
        page.wait_for_timeout(150)
        remaining = page.locator(".annot-text").count()
        record(
            "clear → remove",
            remaining == 0,
            f".annot-text count after clear+Enter = {remaining} (want 0)",
        )

        browser.close()

    print("\n=== summary ===")
    passed = sum(1 for _, ok, _ in results if ok)
    print(f"{passed}/{len(results)} checks passed")
    return 0 if passed == len(results) else 1


if __name__ == "__main__":
    sys.exit(main())
