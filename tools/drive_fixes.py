"""Verify the conversation/UX fixes (no real API key needed; uses mock_llm.py).

Checks:
  1. Empty-conversation spam: clicking "+ New chat" repeatedly yields ONE conv.
  2. Question-based title: first user message renames the conv to the question.
  3. Paper threads grouped in sidebar: one entry per paper, titled by question.
  4. History panel: toggling ☰ shows the paper's threads; new-conv reuses empty.
  5. Theme: light/dark toggles set <html data-theme>.
  6. No page errors.

Run:
    python tools/mock_llm.py &   # :5050
    conda run -n Agent_env python tools/drive_fixes.py
"""
import codecs, json, os, sys, time
from pathlib import Path
from playwright.sync_api import sync_playwright

sys.stdout = codecs.getwriter("utf-8")(sys.stdout.buffer, errors="replace")
APP = os.environ.get("APP_URL", "http://127.0.0.1:5173")
PROV = {
    "name": "mock",
    "base_url": "http://127.0.0.1:5050/v1",
    "api_key": "mock",
    "model": "mock-model",
}
SHOTS = Path(__file__).parent / "shots_real"
SHOTS.mkdir(exist_ok=True)


def seed(page):
    page.goto(f"{APP}/settings", wait_until="networkidle")
    prov_json = json.dumps(PROV)
    page.evaluate(
        """(pj)=>{
          const p=JSON.parse(pj);
          localStorage.setItem('little-alphaxiv-settings',
            JSON.stringify({state:{providers:[Object.assign({id:'r'},p,{is_default:true})],
                             defaultProviderId:'r',theme:'dark'},version:0}));
        }""",
        prov_json,
    )
    # wipe IDB conversations store so we start clean
    page.evaluate("""async ()=>{
      const req=indexedDB.deleteDatabase('little-alphaxiv');
      await new Promise(r=>{req.onsuccess=r;req.onerror=r;req.onblocked=r;});
    }""")


def conv_items(page):
    return page.evaluate(
        """()=>[...document.querySelectorAll('.sidebar:not(.sidebar-collapsed) .conv-item')]
               .map(e=>e.querySelector('.conv-title')?.textContent.trim())"""
    )


with sync_playwright() as pw:
    b = pw.chromium.launch(headless=True)
    page = b.new_context(viewport={"width": 1500, "height": 950}).new_page()
    logs = []
    page.on("pageerror", lambda e: logs.append(str(e)))

    # ---------- 1. empty-conv spam ----------
    seed(page)
    page.goto(APP, wait_until="networkidle")
    page.wait_for_timeout(1200)
    before = len(conv_items(page))
    # click "+ New chat" several times
    for _ in range(4):
        page.locator(".new-chat-btn").click()
        page.wait_for_timeout(250)
    after_spam = conv_items(page)
    print("STEP1_BEFORE_NEWCHAT:", before)
    print("STEP1_AFTER_SPAM_NEWCHAT:", after_spam, "COUNT:", len(after_spam))
    page.screenshot(path=str(SHOTS / "fix_step1_spam.png"))

    # ---------- 2. question-based title ----------
    # We are on an empty general chat. Type a distinctive question + send.
    q = "What is the core idea of vision transformers?"
    page.locator("textarea").first.fill(q)
    page.locator("button:has-text('Send')").click()
    # rename happens right after appendMessages, before the LLM answers.
    renamed = False
    deadline = time.time() + 15
    while time.time() < deadline:
        titles = conv_items(page)
        if titles and q[:20] in titles[0]:
            renamed = True
            break
        page.wait_for_timeout(400)
    print("STEP2_RENAMED_TO_QUESTION:", renamed, "TITLES:", conv_items(page))

    # ---------- 3. paper thread grouping ----------
    page.goto(f"{APP}/paper/1706.03762", wait_until="networkidle")
    page.wait_for_timeout(2500)  # let PaperView create the paper thread
    # expand the (auto-collapsed) sidebar to inspect entries
    page.locator(".sidebar-collapsed .icon-btn[title='Expand sidebar']").click()
    page.wait_for_timeout(400)
    before_new = conv_items(page)
    print("STEP3_SIDEBAR_BEFORE_PAPERQ:", before_new)

    # ask a question in the paper chat to title the thread
    try:
        page.locator(".chat-col textarea").first.fill("Explain the attention mechanism in one sentence")
        page.locator(".chat-col button:has-text('Send')").click()
    except Exception as e:
        print("STEP3_paper_send_err:", e)
    prename = False
    deadline = time.time() + 15
    while time.time() < deadline:
        titles = conv_items(page)
        if any("attention" in t.lower() for t in titles):
            prename = True
            break
        page.wait_for_timeout(500)
    print("STEP3_PAPER_THREAD_TITLED:", prename, "TITLES:", conv_items(page))

    # ---------- 4. history panel + new-conv reuse ----------
    # create several "new conversations" -> should reuse empty, 1 group still
    for _ in range(3):
        page.locator(".chat-toolbar button[title='New conversation']").click()
        page.wait_for_timeout(200)
    # collapse sidebar back, then toggle history panel
    page.locator(".sidebar .icon-btn[title='Collapse sidebar']").click()
    page.wait_for_timeout(200)
    page.locator(".chat-toolbar button[title='Conversation history']").click()
    page.wait_for_timeout(400)
    hist = page.evaluate(
        """()=>({
             open: !!document.querySelector('.history-panel'),
             items: [...document.querySelectorAll('.history-item')].map(e=>e.querySelector('.history-item-title')?.textContent.trim()),
           })"""
    )
    print("STEP4_HISTORY_PANEL:", hist)
    page.screenshot(path=str(SHOTS / "fix_step4_history.png"))

    # ---------- 5. theme ----------
    # open settings dropdown in toolbar, click Light
    page.locator(".chat-toolbar button[title='Chat settings']").click()
    page.wait_for_timeout(300)
    page.locator(".settings-menu .style-preset-btn:has-text('Light')").click()
    page.wait_for_timeout(300)
    light_theme = page.evaluate("()=>document.documentElement.getAttribute('data-theme')")
    page.locator(".settings-menu .style-preset-btn:has-text('Dark')").click()
    page.wait_for_timeout(300)
    dark_theme = page.evaluate("()=>document.documentElement.getAttribute('data-theme')")
    print("STEP5_THEME_LIGHT:", light_theme, "DARK:", dark_theme)
    page.screenshot(path=str(SHOTS / "fix_step5_theme.png"))

    print("PAGEERRORS:", logs)
    b.close()
