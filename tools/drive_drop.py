"""Verify drag-and-drop image upload onto the chat composer (no real API key needed).

Stages images purely client-side (React state -> thumbnail), so this needs only the
frontend dev server (vite :5173) — no backend or mock LLM. It dispatches synthetic
DragEvents on `.chat-composer` with a DataTransfer carrying a tiny inline PNG (image)
and a .txt (non-image), and asserts:
  1. Dropping an image stages a `.composer-attachment` thumbnail.
  2. The `drag-active` class appears on `.chat-composer` during drag-over.
  3. Dropping a non-image shows the `.chat-composer-reject-toast` ("仅支持图片")
     and stages NO thumbnail.

Run: conda run -n Agent_env python tools/drive_drop.py
(assumes `cd frontend && npm run dev` is already serving on http://localhost:5173)
"""
from playwright.sync_api import sync_playwright
import sys

# 1x1 transparent PNG.
PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="

URL = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:5173"


def drop_files(page, files_js: str):
    """Dispatch dragenter -> dragover -> drop on .chat-composer.

    `files_js` is a JS expression evaluating to an array of File objects, built
    inside page.evaluate so the File/DataTransfer objects live in the page context.
    """
    page.evaluate(
        """(filesJs) => {
            const files = eval(filesJs);
            const dt = new DataTransfer();
            for (const f of files) dt.items.add(f);
            const el = document.querySelector(".chat-composer");
            const opts = { dataTransfer: dt, bubbles: true, cancelable: true };
            el.dispatchEvent(new DragEvent("dragenter", opts));
            el.dispatchEvent(new DragEvent("dragover", opts));
            el.dispatchEvent(new DragEvent("drop", opts));
        }""",
        files_js,
    )


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page()
        page.goto(URL, wait_until="domcontentloaded")
        # The composer renders on the general-chat landing route.
        page.wait_for_selector(".chat-composer", timeout=15000)

        # --- Check 2: drag-active class appears on drag-over ---
        page.evaluate(
            """(pngB64) => {
                const bytes = Uint8Array.from(atob(pngB64), c => c.charCodeAt(0));
                const file = new File([bytes], "drop.png", { type: "image/png" });
                const dt = new DataTransfer(); dt.items.add(file);
                const el = document.querySelector(".chat-composer");
                el.dispatchEvent(new DragEvent("dragenter", { dataTransfer: dt, bubbles: true, cancelable: true }));
            }""",
            PNG_B64,
        )
        cls = page.get_attribute(".chat-composer", "class") or ""
        assert "drag-active" in cls, f"expected drag-active on dragenter, got class={cls!r}"
        print("OK: drag-active class set on dragenter")

        # --- Check 1: dropping an image stages a thumbnail ---
        drop_files(
            page,
            f"""(function() {{
                const bytes = Uint8Array.from(atob({PNG_B64!r}), c => c.charCodeAt(0));
                return [new File([bytes], "drop.png", {{ type: "image/png" }})];
            }})()""",
        )
        page.wait_for_selector(".composer-attachment", timeout=3000)
        n = page.locator(".composer-attachment").count()
        assert n >= 1, f"expected >=1 staged attachment, got {n}"
        print(f"OK: dropped image staged as .composer-attachment (count={n})")

        # --- Check 3: dropping a non-image shows the reject toast, stages nothing ---
        before = page.locator(".composer-attachment").count()
        drop_files(page, """[new File(["x"], "note.txt", { type: "text/plain" })]""")
        page.wait_for_selector(".chat-composer-reject-toast", timeout=3000)
        toast = page.locator(".chat-composer-reject-toast").inner_text()
        assert "仅支持图片" in toast, f"expected 仅支持图片 toast, got {toast!r}"
        after = page.locator(".composer-attachment").count()
        assert after == before, f"non-image drop should not stage; before={before} after={after}"
        print(f"OK: non-image drop shows '仅支持图片' toast and stages nothing (count stays {after})")

        browser.close()
        print("\nALL CHECKS PASSED")


if __name__ == "__main__":
    main()
