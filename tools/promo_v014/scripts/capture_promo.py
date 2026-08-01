"""Record deterministic Little Alphaxiv v0.1.4 feature clips.

The script uses a disposable local account, harmless seeded conversations, and
the real Docker-served frontend. It never reads existing accounts, providers,
cookies, or API keys. Raw WebM clips and the generated storage state are ignored
by git; only the reusable capture script is checked in.
"""

from __future__ import annotations

import json
import shutil
import time
from pathlib import Path
from typing import Callable

from playwright.sync_api import Browser, BrowserContext, Locator, Page, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "public" / "raw"
GENERATED = ROOT / "public" / "generated"
MANIFEST = ROOT / "src" / "capture-manifest.json"
FRONT = "http://127.0.0.1:8000"
BACK = FRONT
VIEWPORT = {"width": 1600, "height": 900}
PAPER_ID = "1706.03762"

RUN_ID = int(time.time())
USERNAME = f"promo_v014_{RUN_ID}"
PASSWORD = "promo-only-2026"
PROVIDER_ID = f"promo-provider-{RUN_ID}"
GENERAL_ID = f"promo-general-{RUN_ID}"
PAPER_ROOT_ID = f"promo-paper-root-{RUN_ID}"

CURSOR_SCRIPT = r"""
(() => {
  const install = () => {
    if (document.getElementById('promo-cursor')) return;
    const cursor = document.createElement('div');
    cursor.id = 'promo-cursor';
    Object.assign(cursor.style, {
      position: 'fixed', left: '0', top: '0', width: '22px', height: '22px',
      borderRadius: '50%', border: '3px solid #7c8cff', background: '#ffffff',
      boxShadow: '0 3px 14px rgba(18,22,44,.45)', pointerEvents: 'none',
      zIndex: '2147483647', transform: 'translate(-50%, -50%)',
      transition: 'width 100ms ease, height 100ms ease, background 100ms ease'
    });
    document.documentElement.appendChild(cursor);
    addEventListener('mousemove', (event) => {
      cursor.style.left = `${event.clientX}px`;
      cursor.style.top = `${event.clientY}px`;
    }, true);
    addEventListener('mousedown', (event) => {
      cursor.style.width = '17px'; cursor.style.height = '17px';
      cursor.style.background = '#dfe3ff';
      const ripple = document.createElement('div');
      Object.assign(ripple.style, {
        position: 'fixed', left: `${event.clientX}px`, top: `${event.clientY}px`,
        width: '18px', height: '18px', borderRadius: '50%',
        border: '3px solid rgba(124,140,255,.9)', pointerEvents: 'none',
        zIndex: '2147483646', transform: 'translate(-50%, -50%) scale(.4)',
        opacity: '1', transition: 'transform 520ms ease-out, opacity 520ms ease-out'
      });
      document.documentElement.appendChild(ripple);
      requestAnimationFrame(() => {
        ripple.style.transform = 'translate(-50%, -50%) scale(3.4)';
        ripple.style.opacity = '0';
      });
      setTimeout(() => ripple.remove(), 560);
    }, true);
    addEventListener('mouseup', () => {
      cursor.style.width = '22px'; cursor.style.height = '22px';
      cursor.style.background = '#ffffff';
    }, true);
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', install, {once: true});
  } else {
    install();
  }
})();
"""


def api_json(page: Page, method: str, path: str, payload: dict | None = None):
    kwargs = {"headers": {"Content-Type": "application/json"}}
    if payload is not None:
        kwargs["data"] = json.dumps(payload, ensure_ascii=False)
    response = getattr(page.request, method)(f"{BACK}{path}", **kwargs)
    if not response.ok:
        raise RuntimeError(f"{method.upper()} {path} -> {response.status}: {response.text()}")
    return response


def seed_demo(browser: Browser) -> Path:
    context = browser.new_context(viewport=VIEWPORT)
    page = context.new_page()
    try:
        page.goto(f"{FRONT}/login", wait_until="domcontentloaded")
        api_json(
            page,
            "post",
            "/api/auth/register",
            {
                "username": USERNAME,
                "email": f"{USERNAME}@example.com",
                "password": PASSWORD,
            },
        )
        api_json(
            page,
            "post",
            "/api/providers",
            {
                "id": PROVIDER_ID,
                "name": "Research Gateway",
                "base_url": "https://api.example.com/v1",
                "api_key": "promo-key-not-a-secret",
                "model": "gpt-5-mini",
                "api_format": "responses",
                "is_default": True,
            },
        )
        api_json(
            page,
            "patch",
            "/api/settings",
            {
                "theme": "tokyo-night",
                "aiOutputFormat": {
                    "fontSize": 16,
                    "lineHeight": 1.68,
                    "paragraphSpacing": 12,
                    "mathScale": 1.08,
                    "enableMathType": True,
                },
            },
        )

        now = int(time.time() * 1000)
        general = {
            "id": GENERAL_ID,
            "history_id": GENERAL_ID,
            "title": "Transformer 架构演进",
            "type": "general",
            "provider_id": PROVIDER_ID,
            "messages": [
                {
                    "role": "user",
                    "content": "帮我找几篇关于 Transformer 架构演进的代表性论文，并比较它们的核心创新。",
                },
                {
                    "role": "assistant",
                    "content": None,
                    "tool_calls": [
                        {
                            "id": "promo-arxiv",
                            "type": "function",
                            "function": {
                                "name": "search_arxiv",
                                "arguments": json.dumps({"query": "Transformer architecture evolution", "max_results": 8}),
                            },
                        },
                        {
                            "id": "promo-openalex",
                            "type": "function",
                            "function": {
                                "name": "search_openalex",
                                "arguments": json.dumps({"query": "vision transformer hierarchical attention"}),
                            },
                        },
                    ],
                },
                {
                    "role": "tool",
                    "name": "search_arxiv",
                    "tool_call_id": "promo-arxiv",
                    "content": json.dumps([
                        {"title": "Attention Is All You Need"},
                        {"title": "An Image is Worth 16x16 Words"},
                        {"title": "Swin Transformer"},
                        {"title": "BERT"},
                    ]),
                },
                {
                    "role": "tool",
                    "name": "search_openalex",
                    "tool_call_id": "promo-openalex",
                    "content": json.dumps([
                        {"title": "Transformers in Vision: A Survey"},
                        {"title": "Efficient Attention Mechanisms"},
                    ]),
                },
                {
                    "role": "assistant",
                    "content": (
                        "### 三条关键演进路线\n\n"
                        "1. **通用序列建模** — [Attention Is All You Need](https://arxiv.org/abs/1706.03762)\n"
                        "2. **从语言走向视觉** — [An Image is Worth 16x16 Words](https://arxiv.org/abs/2010.11929)\n"
                        "3. **层级化视觉表示** — [Swin Transformer](https://arxiv.org/abs/2103.14030)\n\n"
                        "它们共同的主线，是让注意力从一种模块变成可扩展的通用计算骨架。"
                    ),
                },
            ],
            "created_at": now - 1000,
            "updated_at": now,
        }
        api_json(page, "put", f"/api/conversations/{GENERAL_ID}", general)

        paper_root = {
            "id": PAPER_ROOT_ID,
            "history_id": PAPER_ROOT_ID,
            "parent_id": None,
            "branch_from_message_index": None,
            "branch_excerpt": None,
            "title": "理解自注意力机制",
            "type": "paper",
            "paper_id": PAPER_ID,
            "provider_id": PROVIDER_ID,
            "messages": [
                {"role": "user", "content": "这篇论文真正解决了什么问题？"},
                {
                    "role": "assistant",
                    "content": (
                        "它把序列建模从循环结构中解放出来。**自注意力让每个位置直接建模与其它位置的关系**，"
                        "因此训练可以高度并行，同时仍能表达长距离依赖。\n\n"
                        "> 关键变化不是单个公式，而是把注意力提升为整个网络的主干。"
                    ),
                },
            ],
            "created_at": now,
            "updated_at": now,
        }
        api_json(page, "put", f"/api/conversations/{PAPER_ROOT_ID}", paper_root)

        state_path = GENERATED / "storage-state.json"
        context.storage_state(path=str(state_path))
        return state_path
    finally:
        context.close()


def move_to(page: Page, locator: Locator, *, pause: float = 0.35) -> None:
    locator.wait_for(state="visible", timeout=20_000)
    box = locator.bounding_box()
    if not box:
        raise RuntimeError("target has no bounding box")
    page.mouse.move(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2, steps=28)
    page.wait_for_timeout(int(pause * 1000))


def click_with_cursor(page: Page, locator: Locator, *, after: float = 0.7) -> None:
    move_to(page, locator)
    page.mouse.down()
    page.wait_for_timeout(90)
    page.mouse.up()
    page.wait_for_timeout(int(after * 1000))


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
            element.dispatchEvent(new MouseEvent('mouseup', {bubbles: true}));
            return selection.toString();
          }
          return '';
        }""",
        phrase,
    )
    if selected != phrase:
        raise RuntimeError(f"selection failed: {selected!r}")


def record_clip(
    browser: Browser,
    state_path: Path,
    name: str,
    route: str,
    ready: Callable[[Page], None],
    action: Callable[[Page], None],
) -> dict:
    context_started = time.perf_counter()
    context: BrowserContext = browser.new_context(
        viewport=VIEWPORT,
        storage_state=str(state_path),
        record_video_dir=str(RAW),
        record_video_size=VIEWPORT,
        color_scheme="dark",
    )
    context.add_init_script(CURSOR_SCRIPT)
    page = context.new_page()
    page_errors: list[str] = []
    page.on("pageerror", lambda error: page_errors.append(str(error)))
    page.goto(f"{FRONT}{route}", wait_until="domcontentloaded")
    ready(page)
    page.wait_for_timeout(450)
    action_started = time.perf_counter()
    action(page)
    page.wait_for_timeout(500)
    action_ended = time.perf_counter()
    video = page.video
    context.close()
    if video is None:
        raise RuntimeError("Playwright video recording was not initialized")
    source_path = Path(video.path())
    output_path = RAW / f"{name}.webm"
    if output_path.exists():
        output_path.unlink()
    shutil.move(str(source_path), output_path)
    if page_errors:
        raise RuntimeError(f"browser errors in {name}: {page_errors}")
    offset = action_started - context_started
    duration = action_ended - action_started
    item = {
        "name": name,
        "file": f"raw/{name}.webm",
        "trimStartSeconds": round(max(0.0, offset - 0.35), 3),
        "usableDurationSeconds": round(duration + 0.7, 3),
        "bytes": output_path.stat().st_size,
    }
    print(f"CAPTURED {name}: {output_path} ({item['bytes']} bytes)")
    return item


def ready_general(page: Page) -> None:
    page.wait_for_selector(".agent-activity", timeout=20_000)
    page.wait_for_selector(".arxiv-inline-card", timeout=20_000)


def action_general(page: Page) -> None:
    scroll = page.locator(".chat-messages")
    scroll.evaluate("element => { element.scrollTop = 0; }")
    page.wait_for_timeout(900)
    activity = page.locator(".agent-activity-summary")
    click_with_cursor(page, activity, after=1.2)
    page.mouse.wheel(0, 390)
    page.wait_for_timeout(1100)
    card = page.locator(".arxiv-inline-card").first
    move_to(page, card, pause=1.1)
    page.wait_for_timeout(1000)


def ready_paper(page: Page) -> None:
    page.wait_for_selector(".pdf-page-canvas-wrap canvas", timeout=45_000)
    page.wait_for_selector(".pdf-textlayer span", timeout=45_000)
    page.wait_for_selector(".msg-assistant", timeout=20_000)


def action_ask_ai(page: Page) -> None:
    zoom = page.locator(".pdf-toolbar button", has_text="+")
    click_with_cursor(page, zoom, after=0.8)
    click_with_cursor(page, zoom, after=0.9)
    span = page.locator(".pdf-textlayer span").filter(has_text="Attention").first
    if span.count() == 0:
        span = page.locator(".pdf-textlayer span").first
    move_to(page, span, pause=0.6)
    span.evaluate(
        """element => {
          const range = document.createRange();
          range.selectNodeContents(element);
          const selection = window.getSelection();
          selection.removeAllRanges();
          selection.addRange(range);
          document.dispatchEvent(new MouseEvent('mouseup', {bubbles: true}));
        }"""
    )
    ask = page.locator(".selected-text-ask-ai")
    ask.wait_for(state="visible", timeout=5_000)
    click_with_cursor(page, ask, after=0.9)
    composer = page.locator(".composer-selected-text")
    composer.wait_for(state="visible", timeout=5_000)
    textarea = page.locator(".composer-textarea")
    textarea.fill("这里为什么不再需要循环结构？")
    move_to(page, page.locator(".composer-send-btn"), pause=1.0)
    page.wait_for_timeout(1000)


def action_branch(page: Page) -> None:
    phrase = "自注意力让每个位置直接建模与其它位置的关系"
    reply = page.locator(".msg-assistant").filter(has_text=phrase)
    move_to(page, reply, pause=0.7)
    select_phrase(reply, phrase)
    branch = page.locator(".assistant-branch-action")
    branch.wait_for(state="visible", timeout=5_000)
    click_with_cursor(page, branch, after=0.8)
    quick = page.locator(".history-quick-popover")
    quick.wait_for(state="visible", timeout=8_000)
    quick.hover()
    page.wait_for_timeout(1800)
    selected = page.locator(".composer-selected-text")
    selected.wait_for(state="visible", timeout=5_000)
    move_to(page, selected, pause=1.1)
    page.wait_for_timeout(900)


def ready_settings(page: Page) -> None:
    page.wait_for_selector(".settings-shell", timeout=20_000)
    page.wait_for_selector(".theme-card", timeout=20_000)


def action_appearance(page: Page) -> None:
    nord = page.locator(".theme-card").filter(has_text="Nord")
    click_with_cursor(page, nord, after=1.0)
    tokyo = page.locator(".theme-card").filter(has_text="Tokyo Night")
    click_with_cursor(page, tokyo, after=1.0)
    sliders = page.locator('.format-slider-row input[type="range"]')
    count = sliders.count()
    if count:
        slider = sliders.nth(0)
        move_to(page, slider, pause=0.5)
        slider.press("ArrowRight")
        slider.press("ArrowRight")
    page.wait_for_timeout(1300)


def ready_provider(page: Page) -> None:
    page.wait_for_selector("#providers", timeout=20_000)
    page.wait_for_selector(".provider-item", timeout=20_000)


def action_provider(page: Page) -> None:
    provider = page.locator(".provider-item").filter(has_text="Research Gateway")
    move_to(page, provider, pause=1.0)
    edit = provider.locator("button").filter(has_text="edit")
    if edit.count() == 1:
        click_with_cursor(page, edit, after=0.9)
        form = page.locator(".provider-form")
        form.wait_for(state="visible", timeout=5_000)
        select = form.locator("select")
        if select.count():
            move_to(page, select.first, pause=0.8)
    page.wait_for_timeout(1500)


def main() -> None:
    RAW.mkdir(parents=True, exist_ok=True)
    GENERATED.mkdir(parents=True, exist_ok=True)
    health = None
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        try:
            check = browser.new_context().new_page()
            response = check.request.get(f"{BACK}/api/health")
            health = response.json()
            check.context.close()
            if health.get("status") != "ok":
                raise RuntimeError(f"unexpected health response: {health}")

            state_path = seed_demo(browser)
            clips = [
                record_clip(browser, state_path, "search", f"/chat/{GENERAL_ID}", ready_general, action_general),
                record_clip(browser, state_path, "ask-ai", f"/paper/{PAPER_ID}/{PAPER_ROOT_ID}", ready_paper, action_ask_ai),
                record_clip(browser, state_path, "branch", f"/paper/{PAPER_ID}/{PAPER_ROOT_ID}", ready_paper, action_branch),
                record_clip(browser, state_path, "appearance", "/settings", ready_settings, action_appearance),
                record_clip(browser, state_path, "provider", "/settings#providers", ready_provider, action_provider),
            ]
        finally:
            browser.close()

    manifest = {
        "capturedAt": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "front": FRONT,
        "viewport": VIEWPORT,
        "health": health,
        "demoUser": USERNAME,
        "clips": clips,
    }
    MANIFEST.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"MANIFEST {MANIFEST}")


if __name__ == "__main__":
    main()
