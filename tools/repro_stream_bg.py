"""Reproduce the "stream interrupted when switching windows" bug.

Two scenarios against the running frontend (:5173) + backend (:8000):

  A) background — send a message, freeze/background the chat page mid-stream
     (via a second page + CDP lifecycle freeze), bring it back, assert the full
     answer rendered and no error appeared.
  B) drop — point at a mock that closes the connection mid-stream
     (MOCK_DROP_AFTER), assert what happens to the partial content the user was
     reading. Before the fix the partial buffer vanishes and a ⚠️ error replaces
     it; after the fix the partial content is preserved.

Starts the slow mock on :5051 itself. Assumes :5173 and :8000 are already up.

Usage:
  PYTHONUTF8=1 PYTHONIOENCODING=utf-8 \
    /c/Users/Delig/.conda/envs/Agent_env/python.exe tools/repro_stream_bg.py [A|B|AB]
"""
from __future__ import annotations

import codecs
import os
import subprocess
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

sys.stdout = codecs.getwriter("utf-8")(sys.stdout.buffer, errors="replace")
sys.stderr = codecs.getwriter("utf-8")(sys.stderr.buffer, errors="replace")

APP = os.environ.get("APP_URL", "http://127.0.0.1:5173")
PY = r"C:\Users\Delig\.conda\envs\Agent_env\python.exe"
OUT = Path(__file__).parent / "shots" / "repro"
OUT.mkdir(parents=True, exist_ok=True)

# The tail of the mock's turn-2 answer — must be present if the full stream
# rendered, absent if it was interrupted/truncated.
ANSWER_TAIL = "must survive window switching"


def seed_provider(page, base_url: str):
    page.goto(f"{APP}/settings", wait_until="networkidle")
    page.evaluate(
        """(base_url) => {
      const key = 'little-alphaxiv-settings';
      const cur = JSON.parse(localStorage.getItem(key) || '{}');
      cur.state = cur.state || {};
      cur.state.providers = [{ id: 'mock-prov', name: 'Mock', base_url: base_url, api_key: 'mock', model: 'mock-model', is_default: true }];
      cur.state.defaultProviderId = 'mock-prov';
      localStorage.setItem(key, JSON.stringify(cur));
    }""",
        base_url,
    )


def send_message(page):
    page.goto(APP, wait_until="networkidle")
    page.wait_for_timeout(800)
    page.locator("textarea").first.fill("find me papers on vision transformers")
    page.locator("button:has-text('Send')").click()


def scenario_background(pw):
    print("\n=== SCENARIO A: background page mid-stream ===")
    browser = pw.chromium.launch(headless=True)
    ctx = browser.new_context(viewport={"width": 1440, "height": 900})
    page = ctx.new_page()
    logs: list[str] = []
    page.on("console", lambda m: logs.append(f"[{m.type}] {m.text}"))
    page.on("pageerror", lambda e: logs.append(f"[PAGEERROR] {e}"))

    seed_provider(page, "http://127.0.0.1:5051/v1")
    send_message(page)
    # Wait for streaming to begin (pending assistant bubble), then background.
    page.wait_for_timeout(1500)
    vis_before = page.evaluate("document.visibilityState")
    # Open a second page and bring it to front -> first page should go hidden.
    page2 = ctx.new_page()
    page2.goto("about:blank")
    page2.bring_to_front()
    page.wait_for_timeout(500)
    vis_hidden = page.evaluate("document.visibilityState")
    # Also freeze via CDP to emulate a real backgrounded/frozen tab.
    try:
        sess = ctx.new_cdp_session(page)
        sess.send("Page.enable")
        sess.send("Page.setWebLifecycleState", {"state": "frozen"})
        page.wait_for_timeout(1500)
        sess.send("Page.setWebLifecycleState", {"state": "active"})
    except Exception as e:  # noqa: BLE001
        print("  (CDP freeze unavailable:", e, ")")
    # Bring the chat page back to front.
    page.bring_to_front()
    page.wait_for_timeout(2000)
    page.screenshot(path=str(OUT / "A_background.png"), full_page=False)

    body = page.locator(".chat-messages").inner_text()
    has_tail = ANSWER_TAIL in body
    has_error = "⚠️" in body or "error" in body.lower()
    print(f"  visibility before/after bg: {vis_before} / {vis_hidden}")
    print(f"  full answer tail present: {has_tail}")
    print(f"  error shown: {has_error}")
    print("  --- last 12 console logs ---")
    for ln in logs[-12:]:
        print("   ", ln)
    browser.close()
    return has_tail, has_error


def scenario_drop(pw):
    print("\n=== SCENARIO B: dropped stream mid-response (clean close) ===")
    # The slow mock was started with MOCK_DROP_AFTER in env.
    browser = pw.chromium.launch(headless=True)
    ctx = browser.new_context(viewport={"width": 1440, "height": 900})
    page = ctx.new_page()
    logs: list[str] = []
    page.on("console", lambda m: logs.append(f"[{m.type}] {m.text}"))
    page.on("pageerror", lambda e: logs.append(f"[PAGEERROR] {e}"))

    seed_provider(page, "http://127.0.0.1:5051/v1")
    send_message(page)
    # Let the dropped stream settle (mock closes after DROP_AFTER chunks).
    page.wait_for_timeout(4000)
    page.screenshot(path=str(OUT / "B_drop.png"), full_page=False)

    body = page.locator(".chat-messages").inner_text()
    has_tail = ANSWER_TAIL in body
    has_error = "⚠️" in body
    has_partial = "Vision Transformers" in body or "Key findings" in body
    print(f"  full answer tail present: {has_tail}")
    print(f"  partial content preserved: {has_partial}")
    print(f"  error (⚠️) shown: {has_error}")
    print("  --- last 12 console logs ---")
    for ln in logs[-12:]:
        print("   ", ln)
    browser.close()
    return has_tail, has_partial, has_error


def scenario_autoscroll(pw):
    print("\n=== SCENARIO D: auto-scroll respects user scrolling up ===")
    # Slow mock, full stream (no drop/error). While streaming, scroll UP and
    # verify the view is not yanked back to the bottom on the next token; then
    # scroll back to the bottom and verify auto-follow resumes.
    browser = pw.chromium.launch(headless=True)
    ctx = browser.new_context(viewport={"width": 1440, "height": 900})
    page = ctx.new_page()
    logs: list[str] = []
    page.on("console", lambda m: logs.append(f"[{m.type}] {m.text}"))
    page.on("pageerror", lambda e: logs.append(f"[PAGEERROR] {e}"))

    seed_provider(page, "http://127.0.0.1:5051/v1")
    send_message(page)
    cm = page.locator(".chat-messages")

    def state():
        return cm.evaluate("el => ({ top: el.scrollTop, h: el.scrollHeight, ch: el.clientHeight })")

    # Poll until the streaming answer overflows the scroll container.
    overflowed = False
    for _ in range(40):  # up to ~10s
        s = state()
        if s["h"] - s["ch"] > 150:
            overflowed = True
            break
        page.wait_for_timeout(250)
    s0 = state()
    print(f"  overflowed={overflowed} scrollHeight={s0['h']} clientHeight={s0['ch']} (overflow={s0['h'] - s0['ch']})")
    if not overflowed:
        print("  ! container never overflowed; cannot test auto-scroll. Aborting D.")
        browser.close()
        return None, None

    # Scroll UP to read earlier content.
    cm.evaluate("el => el.scrollTop = 0")
    page.wait_for_timeout(1500)  # several more tokens stream in
    s_after_scroll_up = state()
    dist_from_bottom_up = s_after_scroll_up["h"] - s_after_scroll_up["top"] - s_after_scroll_up["ch"]
    up_respected = dist_from_bottom_up > 200  # still near top, NOT yanked to bottom

    # Scroll back to bottom -> auto-follow should resume.
    cm.evaluate("el => el.scrollTop = el.scrollHeight")
    page.wait_for_timeout(1500)
    s_after_scroll_down = state()
    dist_from_bottom_down = s_after_scroll_down["h"] - s_after_scroll_down["top"] - s_after_scroll_down["ch"]
    down_following = dist_from_bottom_down < 80  # back to following the bottom

    page.screenshot(path=str(OUT / "D_autoscroll.png"), full_page=False)
    print(f"  after scrolling up, dist-from-bottom = {dist_from_bottom_up:.0f}px (up-respected={up_respected})")
    print(f"  after scrolling back down, dist-from-bottom = {dist_from_bottom_down:.0f}px (following={down_following})")
    browser.close()
    return up_respected, down_following


def scenario_error(pw):
    print("\n=== SCENARIO C: hard error mid-stream (SSE error event) ===")
    # The slow mock was started with MOCK_ERROR_AFTER in env. This triggers the
    # client's parseSSE throw -> send() catch. Before the fix the partial buffer
    # the user was reading vanishes and a ⚠️ error replaces it; after the fix
    # the partial content is preserved.
    browser = pw.chromium.launch(headless=True)
    ctx = browser.new_context(viewport={"width": 1440, "height": 900})
    page = ctx.new_page()
    logs: list[str] = []
    page.on("console", lambda m: logs.append(f"[{m.type}] {m.text}"))
    page.on("pageerror", lambda e: logs.append(f"[PAGEERROR] {e}"))

    seed_provider(page, "http://127.0.0.1:5051/v1")
    send_message(page)
    page.wait_for_timeout(4000)
    page.screenshot(path=str(OUT / "C_error.png"), full_page=False)

    body = page.locator(".chat-messages").inner_text()
    has_partial = "Vision Transformers" in body or "Key findings" in body
    has_error = "⚠️" in body or "interrupted" in body.lower()
    print(f"  partial content preserved: {has_partial}")
    print(f"  error/notice shown: {has_error}")
    print("  --- last 8 console logs ---")
    for ln in logs[-8:]:
        print("   ", ln)
    browser.close()
    return has_partial, has_error


def start_mock(env_extra: dict | None = None):
    env = dict(os.environ)
    if env_extra:
        env.update(env_extra)
    return subprocess.Popen([PY, str(Path(__file__).parent / "mock_llm_slow.py")], env=env)


def main():
    which = sys.argv[1] if len(sys.argv) > 1 else "C"

    def kill_mocks():
        # Kill any orphaned mock_llm_slow.py processes (a crashed prior run can
        # leave one holding :5051, which makes the new mock fail to bind silently
        # and the test ends up talking to the stale mock with wrong env).
        subprocess.run(
            ["powershell", "-NoProfile", "-Command",
             "Get-CimInstance Win32_Process -Filter \"Name='python.exe'\" | "
             "Where-Object { $_.CommandLine -like '*mock_llm_slow*' } | "
             "ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"],
            capture_output=True)

    def run_with_mock(env_extra, fn):
        kill_mocks()
        time.sleep(0.5)
        mock = start_mock(env_extra or None)
        try:
            time.sleep(2.0)  # let uvicorn bind
            with sync_playwright() as pw:
                fn(pw)
        finally:
            # taskkill /T kills the whole process tree (terminate() leaves
            # uvicorn children orphaned on Windows).
            subprocess.run(["taskkill", "/F", "/T", "/PID", str(mock.pid)],
                           capture_output=True)
            time.sleep(0.5)

    if "A" in which:
        run_with_mock(None, scenario_background)
    if "B" in which:
        run_with_mock({"MOCK_DROP_AFTER": "10"}, scenario_drop)
    if "C" in which:
        run_with_mock({"MOCK_ERROR_AFTER": "10"}, scenario_error)
    if "D" in which:
        run_with_mock({"MOCK_NO_TOOL": "1"}, scenario_autoscroll)



if __name__ == "__main__":
    main()
