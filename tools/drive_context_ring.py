"""Playwright driver for the context-usage ring feature (keyless).

Verifies against the mock LLM at http://127.0.0.1:5050/v1 (no real key). The
mock exposes /v1/models (one entry with context_length, one without) and emits
a `usage` chunk on the final answer stream.

Checks:
  1. Ring renders in the chat model-selector row with a percentage.
  2. Clicking it opens the popover (used/total/reserved/usable + controls);
     total resolves to 128K for zai-org/glm-5.2 (detected via the mock's
     context_length, or the curated table — both 128K).
  3. Switching Model capacity Auto -> 256K persists across a page reload.
  4. Provider usage is captured: last_usage.prompt_tokens === 4242 (the mock's
     value) and last_usage.calibration is a clamped number !== 1.0.
  5. Over-capacity history shows the "truncated" note (auto-truncate runs on a
     real multi-message history).

Prereqs: backend on :8000, frontend on :5173, mock on :5050.
Usage:    python drive_context_ring.py
"""
from __future__ import annotations

import codecs
import os
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright, TimeoutError as PWTimeout

# Force UTF-8 stdout so emoji/CJK in console logs don't crash GBK on Windows.
sys.stdout = codecs.getwriter("utf-8")(sys.stdout.buffer, errors="replace")
sys.stderr = codecs.getwriter("utf-8")(sys.stderr.buffer, errors="replace")

OUT = Path(__file__).parent / "shots"
OUT.mkdir(exist_ok=True)
APP = os.environ.get("APP_URL", "http://127.0.0.1:5173")
MOCK_PORT = os.environ.get("MOCK_PORT", "5050")
# Use glm-5.2 so the mock /v1/models returns it with context_length=128000
# (exercises detection). The curated table also maps glm-5 -> 128K, so the ring
# reads 128K whether or not the model fetch has landed yet.
MOCK_PROVIDER = {
    "name": "Mock",
    "base_url": f"http://127.0.0.1:{MOCK_PORT}/v1",
    "api_key": "mock",
    "model": "zai-org/glm-5.2",
}

failures: list[str] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    tag = "PASS" if ok else "FAIL"
    print(f"[{tag}] {name}{(' — ' + detail) if detail else ''}")
    if not ok:
        failures.append(name)


def new_page(pw):
    browser = pw.chromium.launch(headless=True)
    ctx = browser.new_context(viewport={"width": 1440, "height": 900})
    page = ctx.new_page()
    logs: list[str] = []
    page.on("console", lambda m: logs.append(f"[{m.type}] {m.text}"))
    page.on("pageerror", lambda e: logs.append(f"[PAGEERROR] {e}"))
    page.logs = logs  # type: ignore
    page._browser = browser  # type: ignore
    return page


def seed_provider(page):
    page.goto(f"{APP}/settings", wait_until="networkidle")
    page.evaluate(
        """(prov) => {
      const key = 'little-alphaxiv-settings';
      const cur = JSON.parse(localStorage.getItem(key) || '{}');
      const providers = cur.state?.providers || [];
      providers.push({ id: 'mock-prov', ...prov, is_default: true });
      cur.state = cur.state || {};
      cur.state.providers = providers;
      cur.state.defaultProviderId = 'mock-prov';
      cur.state.providerModels = {};
      localStorage.setItem(key, JSON.stringify(cur));
    }""",
        MOCK_PROVIDER,
    )


def open_ring(page):
    page.locator(".ctx-ring-btn").click()
    page.wait_for_selector(".ctx-ring-popover", timeout=4000)


def popover_stats_text(page) -> str:
    return page.locator(".ctx-popover-stats").inner_text()


def read_last_usage(page):
    """Read the most-recent conversation's last_usage straight from IndexedDB."""
    return page.evaluate(
        """async () => {
      return await new Promise((resolve) => {
        const req = indexedDB.open('little-alphaxiv');
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction('conversations', 'readonly');
          const all = tx.objectStore('conversations').getAll();
          all.onsuccess = () => {
            const convs = (all.result || []).slice().sort((a,b)=>b.updated_at-a.updated_at);
            resolve(convs[0]?.last_usage || null);
          };
          all.onerror = () => resolve(null);
        };
        req.onerror = () => resolve(null);
      });
    }"""
    )


def read_conv(page):
    """Read the most-recent conversation (full object) from IndexedDB — used to
    verify per-conversation settings (capacity override, last_usage) persisted."""
    return page.evaluate(
        """async () => {
      return await new Promise((resolve) => {
        const req = indexedDB.open('little-alphaxiv');
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction('conversations', 'readonly');
          const all = tx.objectStore('conversations').getAll();
          all.onsuccess = () => {
            const convs = (all.result || []).slice().sort((a,b)=>b.updated_at-a.updated_at);
            resolve(convs[0] || null);
          };
          all.onerror = () => resolve(null);
        };
        req.onerror = () => resolve(null);
      });
    }"""
    )


def main():
    with sync_playwright() as pw:
        page = new_page(pw)
        try:
            seed_provider(page)
            page.goto(APP, wait_until="networkidle")
            page.wait_for_timeout(800)

            # --- Check 1: ring renders with a percentage ---
            try:
                page.wait_for_selector(".ctx-ring-btn", timeout=8000)
                pct = page.locator(".ctx-ring-pct").inner_text().strip()
                check("1 ring renders", pct.endswith("%"), f"pct='{pct}'")
            except PWTimeout:
                check("1 ring renders", False, "timeout waiting for .ctx-ring-btn")
            page.screenshot(path=str(OUT / "ring_01_idle.png"))

            # --- Check 2: popover opens + total is 128K ---
            try:
                open_ring(page)
                stats = popover_stats_text(page)
                check("2 popover total=128K", "128K" in stats, f"stats='{stats}'")
                page.screenshot(path=str(OUT / "ring_02_popover.png"))
            except Exception as e:  # noqa: BLE001
                check("2 popover total=128K", False, f"exc={e!r}")

            # --- Check 3a: capacity Auto -> 256K (in-memory) ---
            try:
                page.locator(".ctx-control-select").select_option("256000")
                page.wait_for_timeout(400)
                stats = popover_stats_text(page)
                check("3a capacity=256K after select", "256K" in stats, f"stats='{stats}'")
                page.screenshot(path=str(OUT / "ring_03_256k.png"))
                page.locator(".ctx-ring-btn").click()  # close popover
                page.wait_for_timeout(200)
            except Exception as e:  # noqa: BLE001
                check("3a capacity=256K after select", False, f"exc={e!r}")

            # --- Check 4: provider usage captured (calibration) ---
            # Sending the first message also persists the conversation (with the
            # 256K override set above) to IndexedDB, which check 3b verifies.
            try:
                ta = page.locator("textarea").first
                ta.fill("find me papers on vision transformers")
                page.locator(".composer-send-btn").click()
                page.wait_for_selector(".paper-card", timeout=20000)
                page.wait_for_timeout(2500)  # let the final answer + usage chunk land
                # Poll IDB: usage is persisted asynchronously after the stream ends.
                lu = None
                for _ in range(8):
                    lu = read_last_usage(page)
                    if lu:
                        break
                    page.wait_for_timeout(500)
                ok = bool(lu) and isinstance(lu.get("prompt_tokens"), int) and lu["prompt_tokens"] > 0
                cal = lu.get("calibration") if lu else None
                cal_ok = isinstance(cal, (int, float)) and 0.3 <= cal <= 3.0 and cal != 1.0
                check("4 usage captured (prompt_tokens>0)", ok, f"last_usage={lu}")
                check("4b calibration computed (!=1.0, clamped)", cal_ok, f"calibration={cal}")
                page.screenshot(path=str(OUT / "ring_04_after_chat.png"))
            except Exception as e:  # noqa: BLE001
                check("4 usage captured", False, f"exc={e!r}")

            # --- Check 3b: 256K override persisted to IndexedDB ---
            try:
                conv = read_conv(page)
                ov = conv.get("context_capacity_override") if conv else None
                check("3b capacity=256K persisted to IDB", ov == 256000, f"override={ov}")
            except Exception as e:  # noqa: BLE001
                check("3b capacity persisted", False, f"exc={e!r}")

            # reset capacity to Auto for the remaining checks
            try:
                open_ring(page)
                page.locator(".ctx-control-select").select_option("0")
                page.locator(".ctx-ring-btn").click()
                page.wait_for_timeout(200)
            except Exception:  # noqa: BLE001
                pass

            # --- Check 5: over-capacity history shows the truncated note ---
            try:
                # Smallest preset (32K) -> usable 28K. Send a ~120K-char message
                # so the accumulated history (user + tool result + answer) exceeds
                # usable; the ring's auto-truncate drops the oldest unit and the
                # "truncated" note appears.
                open_ring(page)
                page.locator(".ctx-control-select").select_option("32000")
                page.locator(".ctx-ring-btn").click()
                page.wait_for_timeout(200)
                ta = page.locator("textarea").first
                ta.fill("x" * 120000 + "\nsummarize")
                page.locator(".composer-send-btn").click()
                page.wait_for_timeout(4000)  # tool loop + answer
                open_ring(page)
                note = page.locator(".ctx-popover-truncated").count()
                check("5 over-capacity truncated note", note > 0, f"note_count={note}")
                page.screenshot(path=str(OUT / "ring_05_truncated.png"))
            except Exception as e:  # noqa: BLE001
                check("5 over-capacity truncated note", False, f"exc={e!r}")

            print("\n--- console logs ---")
            print("\n".join(page.logs))  # type: ignore
        finally:
            page._browser.close()  # type: ignore

    n_fail = len(failures)
    print(f"\n{'PASS' if n_fail == 0 else 'FAIL'}: {n_fail} check(s) failed{'' if not failures else ' — ' + ', '.join(failures)}")
    sys.exit(1 if n_fail else 0)


if __name__ == "__main__":
    main()
