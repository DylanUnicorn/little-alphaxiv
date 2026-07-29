"""Playwright E2E for selection-created conversation History branches.

Run with an isolated backend, frontend, and ``tools/mock_llm.py``. Environment
variables ``LAX_FRONT`` and ``LAX_BACK`` override the default dev URLs.
"""
from __future__ import annotations

import codecs
import json
import os
import sys
import time
from pathlib import Path

from playwright.sync_api import Page, sync_playwright

sys.stdout = codecs.getwriter("utf-8")(sys.stdout.buffer, errors="replace")
sys.stderr = codecs.getwriter("utf-8")(sys.stderr.buffer, errors="replace")

FRONT = os.environ.get("LAX_FRONT", "http://127.0.0.1:5173")
BACK = os.environ.get("LAX_BACK", "http://127.0.0.1:8000")
MOCK = os.environ.get("LAX_MOCK", "http://127.0.0.1:5050/v1")
OUT = Path(__file__).parent / "shots_branches"
OUT.mkdir(exist_ok=True)

USERNAME = f"branch_e2e_{int(time.time()) % 1_000_000}"
PASSWORD = "testtest123"
ROOT_ID = f"branch-root-{int(time.time())}"
PROVIDER_ID = f"mock-{USERNAME}"


def post_json(page: Page, url: str, payload: dict):
    return page.request.post(
        url,
        data=json.dumps(payload),
        headers={"Content-Type": "application/json"},
    )


def put_json(page: Page, url: str, payload: dict):
    return page.request.put(
        url,
        data=json.dumps(payload),
        headers={"Content-Type": "application/json"},
    )


def seed_account_and_history(page: Page) -> dict:
    registered = post_json(
        page,
        f"{BACK}/api/auth/register",
        {
            "username": USERNAME,
            "email": f"{USERNAME}@example.com",
            "password": PASSWORD,
        },
    )
    assert registered.status == 201, registered.text()
    direct_me = page.request.get(f"{BACK}/api/auth/me")
    print("AUTH", {"direct": direct_me.status})
    assert direct_me.status == 200, direct_me.text()

    provider = post_json(
        page,
        f"{BACK}/api/providers",
        {
            "id": PROVIDER_ID,
            "name": "Branch mock",
            "base_url": MOCK,
            "api_key": "mock",
            "model": "mock-model",
            "is_default": True,
        },
    )
    assert provider.status == 201, provider.text()

    now = int(time.time() * 1000)
    root = {
        "id": ROOT_ID,
        "history_id": ROOT_ID,
        "parent_id": None,
        "branch_from_message_index": None,
        "branch_excerpt": None,
        "title": "Branching root",
        "type": "general",
        "provider_id": PROVIDER_ID,
        "messages": [
            {"role": "user", "content": "Explain training failures."},
            {
                "role": "assistant",
                "content": None,
                "tool_calls": [
                    {
                        "id": "seed-tool",
                        "type": "function",
                        "function": {"name": "search_arxiv", "arguments": "{}"},
                    }
                ],
            },
            {
                "role": "tool",
                "content": "[]",
                "name": "search_arxiv",
                "tool_call_id": "seed-tool",
            },
            {
                "role": "assistant",
                "content": (
                    "A useful warning is representation collapse, where distinct "
                    "inputs map to nearly identical embeddings. This deserves a closer look."
                ),
            },
            {"role": "user", "content": "Now move on to optimization."},
            {"role": "assistant", "content": "This later answer must stay out of the branch."},
        ],
        "created_at": now,
        "updated_at": now,
    }
    seeded = put_json(page, f"{BACK}/api/conversations/{ROOT_ID}", root)
    assert seeded.status == 200, seeded.text()
    return root


def select_phrase(page: Page, message_index: int, phrase: str) -> None:
    host = page.locator(f'.msg-assistant[data-message-index="{message_index}"]')
    host.wait_for(state="visible", timeout=15_000)
    selected = host.evaluate(
        """(element, phrase) => {
          const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
          let node;
          while ((node = walker.nextNode())) {
            const start = node.textContent.indexOf(phrase);
            if (start < 0) continue;
            const range = document.createRange();
            range.setStart(node, start);
            range.setEnd(node, start + phrase.length);
            const selection = window.getSelection();
            selection.removeAllRanges();
            selection.addRange(range);
            element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
            return selection.toString();
          }
          return '';
        }""",
        phrase,
    )
    assert selected == phrase, f"selection failed: {selected!r}"


def main() -> None:
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        context = browser.new_context(viewport={"width": 1440, "height": 900})
        # Keep this run isolated even if a developer already has a different
        # backend on :8000. Vite's proxy is bypassed only inside this browser
        # context; production code still issues normal same-origin /api calls.
        context.route(
            f"{FRONT}/api/**",
            lambda route: route.continue_(
                url=route.request.url.replace(FRONT, BACK, 1)
            ),
        )
        page = context.new_page()
        page_errors: list[str] = []
        page.on("pageerror", lambda error: page_errors.append(str(error)))
        try:
            root = seed_account_and_history(page)
            page.goto(f"{FRONT}/chat/{ROOT_ID}", wait_until="domcontentloaded")
            page.wait_for_timeout(1_000)
            print(
                "BOOT",
                {"url": page.url, "cookies": [cookie["name"] for cookie in context.cookies()]},
            )
            if page_errors:
                print("BOOT PAGE ERRORS", page_errors)
            page.wait_for_selector("textarea", timeout=15_000)
            page.wait_for_selector('.msg-assistant[data-message-index="3"]', timeout=15_000)

            phrase = "representation collapse"
            select_phrase(page, 3, phrase)
            branch_action = page.locator(".assistant-branch-action")
            branch_action.wait_for(state="visible", timeout=5_000)
            branch_action.click()
            page.wait_for_function(
                "rootId => location.pathname.startsWith('/chat/') && !location.pathname.endsWith(rootId)",
                arg=ROOT_ID,
                timeout=15_000,
            )
            child_id = page.url.rsplit("/", 1)[-1]
            assert child_id != ROOT_ID

            selected_chip = page.locator(".composer-selected-text")
            selected_chip.wait_for(state="visible", timeout=10_000)
            assert "Selected reply" in selected_chip.inner_text()
            assert phrase in selected_chip.inner_text()
            assert page.get_by_text("This later answer must stay out of the branch.").count() == 0

            child_before = page.request.get(f"{BACK}/api/conversations/{child_id}")
            assert child_before.status == 200, child_before.text()
            child_json = child_before.json()
            assert child_json["parent_id"] == ROOT_ID
            assert child_json["history_id"] == ROOT_ID
            assert child_json["branch_from_message_index"] == 3
            assert child_json["messages"] == root["messages"][:4]

            page.locator("textarea").fill("How does this happen?")
            page.locator(".composer-send-btn").click()
            page.get_by_text("How does this happen?", exact=False).wait_for(timeout=10_000)
            page.get_by_text("Key findings:", exact=False).last.wait_for(timeout=20_000)

            root_after = page.request.get(f"{BACK}/api/conversations/{ROOT_ID}").json()
            assert root_after["messages"] == root["messages"], "parent branch was mutated"

            history_row = page.locator('.conv-item:has-text("Branching root")').first
            history_row.hover()
            popover = page.locator(".conversation-tree-popover")
            popover.wait_for(state="visible", timeout=5_000)
            assert popover.locator(".conversation-tree-node").count() == 2
            assert popover.locator(
                f'.conversation-tree-node[data-node-id="{child_id}"][data-active="true"]'
            ).count() == 1
            page.screenshot(path=str(OUT / "01_dark_active_branch.png"), full_page=False)

            popover.locator(f'.conversation-tree-node[data-node-id="{ROOT_ID}"]').click()
            page.wait_for_url(f"{FRONT}/chat/{ROOT_ID}", timeout=10_000)

            # Add a second child under the same root so the visual regression
            # exercises an actual fork, not just a two-node vertical path.
            sibling_id = f"branch-sibling-{int(time.time() * 1000)}"
            sibling = {
                **root,
                "id": sibling_id,
                "history_id": ROOT_ID,
                "parent_id": ROOT_ID,
                "branch_from_message_index": 3,
                "branch_excerpt": "distinct inputs map to identical embeddings",
                "title": "Sibling branch",
                "messages": root["messages"][:4],
                "created_at": int(time.time() * 1000),
                "updated_at": int(time.time() * 1000),
            }
            sibling_saved = put_json(page, f"{BACK}/api/conversations/{sibling_id}", sibling)
            assert sibling_saved.status == 200, sibling_saved.text()
            page.reload(wait_until="domcontentloaded")
            page.wait_for_selector("textarea", timeout=15_000)

            page.locator("#sb-theme").select_option("light")
            page.wait_for_function("document.documentElement.dataset.theme === 'light'")
            page.wait_for_timeout(350)
            history_row = page.locator('.conv-item:has-text("Branching root")').first
            history_row.hover()
            popover.wait_for(state="visible", timeout=5_000)
            assert popover.locator(".conversation-tree-node").count() == 3
            assert popover.locator(
                f'.conversation-tree-node[data-node-id="{ROOT_ID}"][data-active="true"]'
            ).count() == 1
            child_box = popover.locator(
                f'.conversation-tree-node[data-node-id="{child_id}"]'
            ).bounding_box()
            sibling_box = popover.locator(
                f'.conversation-tree-node[data-node-id="{sibling_id}"]'
            ).bounding_box()
            assert child_box and sibling_box and abs(child_box["x"] - sibling_box["x"]) > 20
            page.screenshot(path=str(OUT / "02_light_active_root.png"), full_page=False)

            popover.locator(f'.conversation-tree-node[data-node-id="{child_id}"]').hover()
            page.once("dialog", lambda dialog: dialog.accept())
            popover.locator(".conversation-tree-delete").click()
            page.wait_for_timeout(500)
            assert popover.locator(".conversation-tree-node").count() == 2
            assert page.request.get(f"{BACK}/api/conversations/{child_id}").status == 404
            popover.locator(f'.conversation-tree-node[data-node-id="{sibling_id}"]').hover()
            page.once("dialog", lambda dialog: dialog.accept())
            popover.locator(".conversation-tree-delete").click()
            page.wait_for_timeout(500)
            assert popover.locator(".conversation-tree-node").count() == 1
            assert page.request.get(f"{BACK}/api/conversations/{sibling_id}").status == 404
            assert page.request.get(f"{BACK}/api/conversations/{ROOT_ID}").status == 200
            page.screenshot(path=str(OUT / "03_branch_deleted.png"), full_page=False)

            assert not page_errors, "Browser errors:\n" + "\n".join(page_errors)
            print(f"BRANCH E2E PASSED root={ROOT_ID} child={child_id}")
            print(f"Screenshots: {OUT}")
        finally:
            context.close()
            browser.close()


if __name__ == "__main__":
    main()
