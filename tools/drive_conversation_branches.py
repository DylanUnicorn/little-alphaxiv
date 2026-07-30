"""Playwright E2E for paper-preview-only conversation branches.

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

from playwright.sync_api import Locator, Page, sync_playwright

sys.stdout = codecs.getwriter("utf-8")(sys.stdout.buffer, errors="replace")
sys.stderr = codecs.getwriter("utf-8")(sys.stderr.buffer, errors="replace")

FRONT = os.environ.get("LAX_FRONT", "http://127.0.0.1:5173")
BACK = os.environ.get("LAX_BACK", "http://127.0.0.1:8000")
MOCK = os.environ.get("LAX_MOCK", "http://127.0.0.1:5050/v1")
OUT = Path(__file__).parent / "shots_branches"
OUT.mkdir(exist_ok=True)

USERNAME = f"paper_branch_e2e_{int(time.time()) % 1_000_000}"
PASSWORD = "testtest123"
GENERAL_ID = f"general-root-{int(time.time())}"
PAPER_ID = "1706.03762"
ROOT_ID = f"paper-branch-root-{int(time.time())}"
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


def seed_account_and_histories(page: Page) -> dict:
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
    assert page.request.get(f"{BACK}/api/auth/me").status == 200

    provider = post_json(
        page,
        f"{BACK}/api/providers",
        {
            "id": PROVIDER_ID,
            "name": "Paper branch mock",
            "base_url": MOCK,
            "api_key": "mock",
            "model": "mock-model",
            "is_default": True,
        },
    )
    assert provider.status == 201, provider.text()

    now = int(time.time() * 1000)
    general = {
        "id": GENERAL_ID,
        "history_id": GENERAL_ID,
        "title": "Flat general chat",
        "type": "general",
        "provider_id": PROVIDER_ID,
        "messages": [
            {"role": "user", "content": "Explain ordinary chat behavior."},
            {
                "role": "assistant",
                "content": "General chat selection must never create a conversation branch.",
            },
        ],
        "created_at": now - 1_000,
        "updated_at": now - 1_000,
    }
    saved_general = put_json(page, f"{BACK}/api/conversations/{GENERAL_ID}", general)
    assert saved_general.status == 200, saved_general.text()

    paper = {
        "arxiv_id": PAPER_ID,
        "title": "Attention Is All You Need",
        "authors": ["Ashish Vaswani"],
        "abstract": "A transformer architecture paper used by the branch E2E.",
        "pdf_url": f"https://arxiv.org/pdf/{PAPER_ID}",
        "abs_url": f"https://arxiv.org/abs/{PAPER_ID}",
        "published": "2017-06-12",
        "primary_category": "cs.CL",
        "full_text": "Transformers use self-attention to model token relationships.",
        "fetched_at": now,
    }
    saved_paper = put_json(page, f"{BACK}/api/papers/{PAPER_ID}", paper)
    assert saved_paper.status == 200, saved_paper.text()

    root = {
        "id": ROOT_ID,
        "history_id": ROOT_ID,
        "parent_id": None,
        "branch_from_message_index": None,
        "branch_excerpt": None,
        "title": "Paper branching root",
        "type": "paper",
        "paper_id": PAPER_ID,
        "provider_id": PROVIDER_ID,
        "messages": [
            {"role": "user", "content": "Explain training failures in this paper."},
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
    saved_root = put_json(page, f"{BACK}/api/conversations/{ROOT_ID}", root)
    assert saved_root.status == 200, saved_root.text()
    return root


def select_phrase(host: Locator, phrase: str) -> None:
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


def open_history(page: Page) -> Locator:
    page.locator(".toolbar-action-btn").filter(has_text="History").click()
    panel = page.locator(".history-panel")
    panel.wait_for(state="visible", timeout=5_000)
    return panel


def hover_quick_history(page: Page) -> Locator:
    page.locator('button[aria-label="Conversation history"]').hover()
    popover = page.locator(".history-quick-popover")
    popover.wait_for(state="visible", timeout=5_000)
    return popover


def main() -> None:
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        context = browser.new_context(viewport={"width": 1440, "height": 900})
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
            root = seed_account_and_histories(page)

            # General chat stays flat and never exposes the Branch selection action.
            page.goto(f"{FRONT}/chat/{GENERAL_ID}", wait_until="domcontentloaded")
            page.wait_for_selector("textarea", timeout=15_000)
            general_phrase = "never create a conversation branch"
            general_reply = page.locator(".msg-assistant").filter(has_text=general_phrase)
            select_phrase(general_reply, general_phrase)
            page.wait_for_timeout(250)
            assert page.locator(".assistant-branch-action").count() == 0
            assert page.locator(".conversation-tree").count() == 0
            assert page.locator(".conv-tree-open").count() == 0
            print("GENERAL CHAT SCOPE OK")

            # Paper preview sub-chat exposes the selection-created branch flow.
            page.goto(
                f"{FRONT}/paper/{PAPER_ID}/{ROOT_ID}",
                wait_until="domcontentloaded",
            )
            page.wait_for_selector("textarea", timeout=15_000)
            paper_reply = page.locator('.msg-assistant[data-message-index="3"]')

            quick = hover_quick_history(page)
            assert quick.locator(".conversation-tree-node").count() == 1
            assert quick.locator(
                f'.conversation-tree-node[data-node-id="{ROOT_ID}"][data-active="true"]'
            ).count() == 1
            root_node = quick.locator(
                f'.conversation-tree-node[data-node-id="{ROOT_ID}"][data-root="true"]'
            )
            assert root_node.count() == 1
            assert "History root" in (root_node.get_attribute("aria-label") or "")
            assert root_node.locator(".conversation-tree-root-marker").count() == 1
            assert quick.locator(".conversation-tree-detail").count() == 0
            assert quick.locator(".conversation-tree-delete").count() == 0
            assert quick.inner_text().strip() == ""
            paper_reply.hover()
            quick.wait_for(state="hidden", timeout=5_000)

            phrase = "representation collapse"
            select_phrase(paper_reply, phrase)
            branch_action = page.locator(".assistant-branch-action")
            branch_action.wait_for(state="visible", timeout=5_000)
            branch_action.click()
            page.wait_for_function(
                "rootId => location.pathname.startsWith('/paper/') && !location.pathname.endsWith(rootId)",
                arg=ROOT_ID,
                timeout=15_000,
            )
            child_id = page.url.rsplit("/", 1)[-1]
            assert child_id != ROOT_ID

            auto_quick = page.locator(".history-quick-popover")
            auto_quick.wait_for(state="visible", timeout=5_000)
            auto_quick.hover()
            revealed_node = auto_quick.locator(
                f'.conversation-tree-node[data-node-id="{child_id}"][data-revealed="true"]'
            )
            revealed_edge = auto_quick.locator(
                f'.conversation-tree-lines path[data-revealed="true"]'
            )
            assert revealed_node.count() == 1
            assert revealed_edge.count() == 1
            assert "conversation-branch-node-arrive" in revealed_node.evaluate(
                "node => getComputedStyle(node).animationName"
            )
            assert "conversation-branch-edge-grow" in revealed_edge.evaluate(
                "edge => getComputedStyle(edge).animationName"
            )
            root_box = auto_quick.locator(
                f'.conversation-tree-node[data-node-id="{ROOT_ID}"]'
            ).bounding_box()
            child_box = revealed_node.bounding_box()
            assert root_box and child_box and root_box["y"] < child_box["y"]
            assert auto_quick.locator(".conversation-tree-root-marker").count() == 1

            page.emulate_media(reduced_motion="reduce")
            assert revealed_node.evaluate(
                "node => getComputedStyle(node).animationName"
            ) == "none"
            assert revealed_edge.evaluate(
                "edge => getComputedStyle(edge).animationName"
            ) == "none"
            page.emulate_media(reduced_motion="no-preference")
            page.wait_for_timeout(1_500)
            assert auto_quick.is_visible(), "hover should take ownership of the auto-reveal"
            page.screenshot(
                path=str(OUT / "00_paper_dark_new_branch_growth.png"),
                full_page=False,
            )
            paper_reply.hover()
            auto_quick.wait_for(state="hidden", timeout=5_000)

            selected_chip = page.locator(".composer-selected-text")
            selected_chip.wait_for(state="visible", timeout=10_000)
            assert "Selected reply" in selected_chip.inner_text()
            assert phrase in selected_chip.inner_text()
            assert page.get_by_text("This later answer must stay out of the branch.").count() == 0

            child_before = page.request.get(f"{BACK}/api/conversations/{child_id}")
            assert child_before.status == 200, child_before.text()
            child_json = child_before.json()
            assert child_json["type"] == "paper"
            assert child_json["paper_id"] == PAPER_ID
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

            quick = hover_quick_history(page)
            assert quick.locator(".conversation-tree-node").count() == 2
            assert quick.locator(
                f'.conversation-tree-node[data-node-id="{child_id}"][data-active="true"]'
            ).count() == 1
            assert quick.locator(".conversation-tree-detail").count() == 0
            assert quick.locator(".conversation-tree-delete").count() == 0
            page.screenshot(
                path=str(OUT / "00_paper_dark_quick_history.png"),
                full_page=False,
            )

            quick.locator(f'.conversation-tree-node[data-node-id="{ROOT_ID}"]').click()
            page.wait_for_url(f"{FRONT}/paper/{PAPER_ID}/{ROOT_ID}", timeout=10_000)
            quick = hover_quick_history(page)
            quick.locator(f'.conversation-tree-node[data-node-id="{child_id}"]').click()
            page.wait_for_url(f"{FRONT}/paper/{PAPER_ID}/{child_id}", timeout=10_000)

            panel = open_history(page)
            assert page.locator(".history-quick-popover").count() == 0
            assert panel.locator(".conversation-tree-node").count() == 2
            assert panel.locator(".conversation-tree-root-marker").count() == 1
            assert panel.locator(".conversation-tree-detail").count() == 1
            print("HISTORY HOVER QUICK TREE OK")
            assert panel.locator(
                f'.conversation-tree-node[data-node-id="{child_id}"][data-active="true"]'
            ).count() == 1
            page.screenshot(path=str(OUT / "01_paper_dark_active_branch.png"), full_page=False)

            panel.locator(f'.conversation-tree-node[data-node-id="{ROOT_ID}"]').click()
            page.wait_for_url(f"{FRONT}/paper/{PAPER_ID}/{ROOT_ID}", timeout=10_000)

            sibling_id = f"paper-branch-sibling-{int(time.time() * 1000)}"
            sibling = {
                **root,
                "id": sibling_id,
                "history_id": ROOT_ID,
                "parent_id": ROOT_ID,
                "branch_from_message_index": 3,
                "branch_excerpt": "distinct inputs map to identical embeddings",
                "title": "Sibling paper branch",
                "messages": root["messages"][:4],
                "created_at": int(time.time() * 1000),
                "updated_at": int(time.time() * 1000),
            }
            sibling_saved = put_json(page, f"{BACK}/api/conversations/{sibling_id}", sibling)
            assert sibling_saved.status == 200, sibling_saved.text()
            page.reload(wait_until="domcontentloaded")
            page.wait_for_selector("textarea", timeout=15_000)

            page.locator('button[aria-label="Chat settings"]').click()
            page.locator(".settings-select").select_option("light")
            page.wait_for_function("document.documentElement.dataset.theme === 'light'")
            page.locator('button[aria-label="Chat settings"]').click()
            quick = hover_quick_history(page)
            assert quick.locator(".conversation-tree-node").count() == 3
            assert quick.locator(
                f'.conversation-tree-node[data-node-id="{ROOT_ID}"][data-active="true"]'
            ).count() == 1
            page.screenshot(
                path=str(OUT / "04_paper_light_quick_history.png"),
                full_page=False,
            )
            panel = open_history(page)
            assert panel.locator(".conversation-tree-node").count() == 3
            assert panel.locator(
                f'.conversation-tree-node[data-node-id="{ROOT_ID}"][data-active="true"]'
            ).count() == 1
            child_box = panel.locator(
                f'.conversation-tree-node[data-node-id="{child_id}"]'
            ).bounding_box()
            sibling_box = panel.locator(
                f'.conversation-tree-node[data-node-id="{sibling_id}"]'
            ).bounding_box()
            assert child_box and sibling_box and abs(child_box["x"] - sibling_box["x"]) > 20
            page.screenshot(path=str(OUT / "02_paper_light_active_root.png"), full_page=False)

            panel.locator(f'.conversation-tree-node[data-node-id="{child_id}"]').hover()
            page.once("dialog", lambda dialog: dialog.accept())
            panel.locator(".conversation-tree-delete").click()
            page.wait_for_timeout(500)
            assert panel.locator(".conversation-tree-node").count() == 2
            assert page.request.get(f"{BACK}/api/conversations/{child_id}").status == 404

            panel.locator(f'.conversation-tree-node[data-node-id="{sibling_id}"]').hover()
            page.once("dialog", lambda dialog: dialog.accept())
            panel.locator(".conversation-tree-delete").click()
            page.wait_for_timeout(500)
            assert panel.locator(".conversation-tree-node").count() == 1
            assert page.request.get(f"{BACK}/api/conversations/{sibling_id}").status == 404
            assert page.request.get(f"{BACK}/api/conversations/{ROOT_ID}").status == 200
            page.screenshot(path=str(OUT / "03_paper_branches_deleted.png"), full_page=False)

            assert not page_errors, "Browser errors:\n" + "\n".join(page_errors)
            print(f"PAPER-ONLY BRANCH E2E PASSED root={ROOT_ID} child={child_id}")
            print(f"Screenshots: {OUT}")
        finally:
            context.close()
            browser.close()


if __name__ == "__main__":
    main()
