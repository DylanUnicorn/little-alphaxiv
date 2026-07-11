"""Playwright regression: selected PDF text can be sent to the active paper chat.

Run with backend (:8000), Vite (:5173), and tools/mock_llm.py (:5050) running.
"""

from __future__ import annotations

from drive import new_page, seed_provider


def main() -> None:
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        page = new_page(pw)
        try:
            seed_provider(page)
            page.goto("http://127.0.0.1:5173/paper/1706.03762", wait_until="networkidle")
            assert "/login" not in page.url, f"unexpected auth redirect: {page.url}"
            page.wait_for_selector(".pdf-textlayer span", timeout=20_000)

            span = page.locator(".pdf-textlayer span").first
            span.evaluate(
                """element => {
                    const range = document.createRange();
                    range.selectNodeContents(element);
                    const selection = window.getSelection();
                    selection.removeAllRanges();
                    selection.addRange(range);
                    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
                }"""
            )
            page.wait_for_selector(".selected-text-ask-ai", timeout=5_000)
            page.locator(".selected-text-ask-ai").click()

            page.wait_for_selector(".msg-user", timeout=10_000)
            prompt = page.locator(".msg-user").last.inner_text()
            assert "page 1" in prompt
            assert "Please explain this excerpt" in prompt
            page.wait_for_selector(".msg-assistant:not(.pending)", timeout=20_000)
            assert not [entry for entry in page.logs if "[PAGEERROR]" in entry]  # type: ignore[attr-defined]
            print("AI text selection passed")
        finally:
            page._browser.close()  # type: ignore[attr-defined]


if __name__ == "__main__":
    main()
