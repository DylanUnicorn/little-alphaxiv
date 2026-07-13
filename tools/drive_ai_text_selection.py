"""Playwright regression: selected PDF text can be sent to the active paper chat.

Run with backend (:8000), Vite (:5173), and tools/mock_llm.py (:5050) running.
"""

from __future__ import annotations

from drive import OUT, new_page, seed_provider


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

            def select_span() -> None:
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

            user_count = page.locator(".msg-user").count()
            answered_count = page.locator(".msg-assistant:not(.pending)", has_text="Key findings").count()
            select_span()
            page.wait_for_selector(".selected-text-ask-ai", timeout=5_000)
            page.locator(".selected-text-ask-ai").click()

            card = page.locator(".composer-selected-text")
            card.wait_for(state="visible", timeout=5_000)
            assert "Page 1:" in card.inner_text()
            assert page.locator(".msg-user").count() == user_count, "Ask AI submitted before explicit send"
            page.screenshot(path=str(OUT / "ai_text_context_card.png"), full_page=False)

            question = "What assumption is the author making?"
            page.locator(".composer-textarea").fill(question)
            page.locator(".composer-send-btn").click()
            page.wait_for_function(
                "expected => document.querySelectorAll('.msg-user').length === expected",
                arg=user_count + 1,
            )
            prompt = page.locator(".msg-user").last.inner_text()
            assert "Excerpt from page 1" in prompt
            assert question in prompt
            page.wait_for_function(
                """expected => [...document.querySelectorAll('.msg-assistant:not(.pending)')]
                    .filter(element => element.textContent.includes('Key findings')).length === expected""",
                arg=answered_count + 1,
                timeout=20_000,
            )

            select_span()
            page.wait_for_selector(".selected-text-ask-ai", timeout=5_000)
            page.locator(".selected-text-ask-ai").click()
            card.wait_for(state="visible", timeout=5_000)
            page.locator(".composer-selected-text-remove").click()
            card.wait_for(state="detached", timeout=5_000)
            assert page.locator(".msg-user").count() == user_count + 1
            assert not [entry for entry in page.logs if "[PAGEERROR]" in entry]  # type: ignore[attr-defined]
            print("AI text selection context card passed")
        finally:
            page._browser.close()  # type: ignore[attr-defined]


if __name__ == "__main__":
    main()
