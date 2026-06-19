"""Diagnostic driver using the REAL provider (ppio/glm) — no mock.

Reproduces the user's reported bugs:
  1. left sidebar can't be collapsed/expanded reliably
  2. right chat panel breaks (input box disappears) after sending a msg
  3. PDF can't select text

Run:  python tools/drive_real.py
"""

import codecs
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

sys.stdout = codecs.getwriter("utf-8")(sys.stdout.buffer, errors="replace")
sys.stderr = codecs.getwriter("utf-8")(sys.stderr.buffer, errors="replace")

OUT = Path(__file__).parent / "shots_real"
OUT.mkdir(exist_ok=True)
APP = "http://127.0.0.1:5173"

REAL_PROVIDER = {
    "name": "ppio-glm",
    "base_url": "https://api.ppio.com/openai/v1",
    "api_key": "sk_FwuagHFdkC_UxM75YOZkZ6Aetu-9JulmUpmnHYgz6A0",
    "model": "zai-org/glm-5.2",
}


def new_page(pw):
    browser = pw.chromium.launch(headless=True)
    ctx = browser.new_context(viewport={"width": 1500, "height": 950})
    page = ctx.new_page()
    logs = []
    page.on("console", lambda m: logs.append(f"[{m.type}] {m.text}"))
    page.on("pageerror", lambda e: logs.append(f"[PAGEERROR] {e}"))
    page.on("requestfailed", lambda r: logs.append(f"[REQFAIL] {r.url} {r.failure}"))
    page.logs = logs  # type: ignore
    page._browser = browser  # type: ignore
    return page


def seed_provider(page):
    page.goto(f"{APP}/settings", wait_until="networkidle")
    page.evaluate(
        """(prov) => {
      const key = 'little-alphaxiv-settings';
      localStorage.setItem(key, JSON.stringify({
        state: { providers: [{ id: 'real-prov', ...prov, is_default: true }],
                 defaultProviderId: 'real-prov', sidebarCollapsed: false },
        version: 0
      }));
    }""",
        REAL_PROVIDER,
    )


def dump_chat_state(page, tag):
    info = page.evaluate(
        """() => {
      const msgs = [...document.querySelectorAll('.msg')];
      return {
        textarea: document.querySelectorAll('textarea').length,
        sendBtn: [...document.querySelectorAll('button')].filter(b=>/Send|…/.test(b.textContent)).length,
        msgCount: msgs.length,
        msgRoles: msgs.map(m => m.className),
        errors: [...document.querySelectorAll('.msg-error, .chat-error-boundary pre')].map(e=>e.textContent.slice(0,200)),
        bodyHeight: document.body.scrollHeight,
        chatPanelH: (document.querySelector('.chat-panel')||{}).offsetHeight,
        chatMessagesH: (document.querySelector('.chat-messages')||{}).offsetHeight,
      };
    }"""
    )
    print(f"=== {tag} ===")
    for k, v in info.items():
        print(f"  {k}: {v}")


def run_chat(page):
    seed_provider(page)
    page.goto(APP, wait_until="networkidle")
    page.wait_for_timeout(1000)
    page.screenshot(path=str(OUT / "01_chat_landed.png"))

    # Sidebar collapse/expand test
    has_collapse_btn = page.evaluate(
        """() => [...document.querySelectorAll('.sidebar .icon-btn, .sidebar button')].filter(b=>/«|»/.test(b.textContent)).length"""
    )
    print(f"SIDEBAR: collapse/expand buttons found = {has_collapse_btn}")

    ta = page.locator("textarea").first
    ta.fill("找一些 vision transformer 相关的论文")
    page.screenshot(path=str(OUT / "02_typed.png"))
    page.locator(".composer-send-btn").click()

    # poll for paper cards or final answer, up to 60s
    deadline = time.time() + 60
    got_cards = False
    while time.time() < deadline:
        cards = page.locator(".paper-card").count()
        if cards:
            got_cards = True
            break
        page.wait_for_timeout(1000)
    print(f"CHAT: paper cards appeared = {got_cards}")
    page.wait_for_timeout(6000)  # let final answer stream
    page.screenshot(path=str(OUT / "03_chat_answered.png"))
    dump_chat_state(page, "AFTER CHAT")

    # try to scroll the chat messages to bottom
    page.evaluate("() => { const el=document.querySelector('.chat-messages'); if(el) el.scrollTop=el.scrollHeight; }")
    page.wait_for_timeout(500)
    page.screenshot(path=str(OUT / "04_chat_scrolled.png"))
    dump_chat_state(page, "AFTER SCROLL")
    return got_cards


def run_paper(page, arxiv_id="1706.03762"):
    page.goto(f"{APP}/paper/{arxiv_id}", wait_until="networkidle")
    page.wait_for_selector(".pdf-page-canvas-wrap canvas", timeout=25000)
    page.wait_for_timeout(5000)
    page.evaluate("() => { const el=document.querySelector('.pdf-scroll'); if(el) el.scrollTop=900; }")
    page.wait_for_timeout(3000)
    page.screenshot(path=str(OUT / "10_paper.png"))

    pdf_info = page.evaluate(
        """() => {
      const spans = [...document.querySelectorAll('.pdf-textlayer span')];
      const withText = spans.filter(s=>(s.textContent||'').trim());
      const withSize = withText.filter(s => s.getBoundingClientRect().width>0);
      const tl = document.querySelector('.pdf-textlayer');
      const cs = tl ? getComputedStyle(tl) : null;
      return {
        totalSpans: spans.length,
        spansWithText: withText.length,
        spansWithWidth: withSize.length,
        scaleFactor: cs ? cs.getPropertyValue('--scale-factor') : 'NO TL',
        sampleText: withSize.slice(0,3).map(s=>s.textContent.slice(0,40)),
        canvasW: (document.querySelector('.pdf-page-canvas-wrap canvas')||{}).width,
        tlW: tl ? tl.offsetWidth : 0,
        sidebarCollapsed: document.querySelectorAll('.sidebar-collapsed').length,
        chatTextarea: document.querySelectorAll('.chat-col textarea').length,
      };
    }"""
    )
    print("=== PDF INFO ===")
    for k, v in pdf_info.items():
        print(f"  {k}: {v}")

    # attempt an actual text selection by dragging across the text layer
    sel_info = page.evaluate(
        """() => {
      const span = document.querySelector('.pdf-textlayer span');
      if(!span) return {selected:'', ok:false};
      const r = span.getBoundingClientRect();
      return {rect:[r.x,r.y,r.width,r.height]};
    }"""
    )
    print(f"  firstSpanRect: {sel_info}")
    dump_chat_state(page, "PAPER CHAT")
    page.wait_for_timeout(500)
    page.screenshot(path=str(OUT / "11_paper_chat.png"))
    return pdf_info


def main():
    with sync_playwright() as pw:
        page = new_page(pw)
        try:
            run_chat(page)
            run_paper(page)
        finally:
            print("\n=== CONSOLE LOGS ===")
            print("\n".join(page.logs))  # type: ignore
            page._browser.close()  # type: ignore


if __name__ == "__main__":
    main()
