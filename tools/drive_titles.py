"""Verify the LLM-summarized conversation titles + alphaxiv-style date groups
in the sidebar (no real API key needed; uses mock_llm.py).

Checks:
  1. General chat: after the first turn, the sidebar title becomes the LLM
     summary (mock returns "Vision transformer paper search"), NOT the
     truncated first question.
  2. Paper chat: same — first turn renames the thread to the LLM summary.
  3. Sidebar renders a "Today" date-group header over the entries.
  4. No page errors.

Depends on the mock's turn-1 search_arxiv tool_call resolving via the real
/api/search (arXiv), so the tool loop completes and the title-generation
turn fires — same arXiv dependency as drive_fixes.py / drive.py.

Run:
    python tools/mock_llm.py &                         # :5050
    (backend on :8000, frontend dev on :5173)
    /c/Users/Delig/.conda/envs/Agent_env/python.exe tools/drive_titles.py
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
MOCK_TITLE_GENERAL = "Vision transformer paper search"
MOCK_TITLE_PAPER = "Attention mechanism in transformers"
SHOTS = Path(__file__).parent / "shots_real"
SHOTS.mkdir(exist_ok=True)


def seed(page):
    page.goto(f"{APP}/settings", wait_until="networkidle")
    page.evaluate(
        """(pj)=>{
          const p=JSON.parse(pj);
          localStorage.setItem('little-alphaxiv-settings',
            JSON.stringify({state:{providers:[Object.assign({id:'r'},p,{is_default:true})],
                             defaultProviderId:'r',theme:'dark'},version:0}));
        }""",
        json.dumps(PROV),
    )
    page.evaluate("""async ()=>{
      const req=indexedDB.deleteDatabase('little-alphaxiv');
      await new Promise(r=>{req.onsuccess=r;req.onerror=r;req.onblocked=r;});
    }""")


def conv_titles(page):
    return page.evaluate(
        """()=>[...document.querySelectorAll('.sidebar:not(.sidebar-collapsed) .conv-item')]
               .map(e=>e.querySelector('.conv-title')?.textContent.trim())"""
    )


def group_labels(page):
    return page.evaluate(
        """()=>[...document.querySelectorAll('.sidebar:not(.sidebar-collapsed) .conv-group-label')]
               .map(e=>e.textContent.trim())"""
    )


def wait_for_title(page, needle, deadline_s=40):
    deadline = time.time() + deadline_s
    while time.time() < deadline:
        titles = conv_titles(page)
        if any(needle.lower() in (t or "").lower() for t in titles):
            return titles
        page.wait_for_timeout(500)
    return conv_titles(page)


with sync_playwright() as pw:
    b = pw.chromium.launch(headless=True)
    page = b.new_context(viewport={"width": 1500, "height": 950}).new_page()
    logs = []
    page.on("pageerror", lambda e: logs.append(str(e)))

    # ---------- 1. general chat: summarized title ----------
    seed(page)
    page.goto(APP, wait_until="networkidle")
    page.wait_for_timeout(1200)
    q = "What is the core idea of vision transformers?"
    page.locator("textarea").first.fill(q)
    page.locator("button:has-text('Send')").click()
    titles = wait_for_title(page, MOCK_TITLE_GENERAL)
    summarized = any(MOCK_TITLE_GENERAL.lower() in (t or "").lower() for t in titles)
    labels = group_labels(page)
    has_today = "Today" in labels
    print("STEP1_TITLES:", titles)
    print("STEP1_SUMMARIZED_TITLE:", summarized)
    print("STEP1_GROUP_LABELS:", labels)
    print("STEP1_HAS_TODAY_GROUP:", has_today)
    page.screenshot(path=str(SHOTS / "titles_step1_general.png"))

    # ---------- 2. paper chat: summarized thread title ----------
    page.goto(f"{APP}/paper/1706.03762", wait_until="networkidle")
    page.wait_for_timeout(2500)  # let PaperView create the paper thread
    # expand the auto-collapsed sidebar to inspect entries
    page.locator(".sidebar-collapsed .icon-btn[title='Expand sidebar']").click()
    page.wait_for_timeout(400)
    try:
        page.locator(".chat-col textarea").first.fill("Explain the attention mechanism in one sentence")
        page.locator(".chat-col button:has-text('Send')").click()
    except Exception as e:
        print("STEP2_paper_send_err:", e)
    titles = wait_for_title(page, MOCK_TITLE_PAPER, deadline_s=60)
    paper_summarized = any(MOCK_TITLE_PAPER.lower() in (t or "").lower() for t in titles)
    print("STEP2_TITLES:", titles)
    print("STEP2_PAPER_SUMMARIZED_TITLE:", paper_summarized)
    page.screenshot(path=str(SHOTS / "titles_step2_paper.png"))

    print("PAGEERRORS:", logs)
    b.close()

    ok = summarized and has_today and paper_summarized and not logs
    print("VERDICT:", "PASS" if ok else "FAIL")
    sys.exit(0 if ok else 1)
