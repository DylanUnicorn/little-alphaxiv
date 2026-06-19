"""Verify the vision-model auto-fallback (no real API key; uses mock_llm.py).

Scenario:
  - Seed a provider whose main `model` is "mock-model" (non-vision per the
    VISION_CAPABLE table) and whose `vision_model` is "gpt-4o" (vision-capable).
  - Attach a tiny PNG to the composer's hidden file input.
  - Type a prompt and send.
  - Intercept the FIRST /api/llm POST (the image turn) and assert its
    payload.model is "gpt-4o" — i.e. the auto-fallback routed the image turn
    to the configured vision model, NOT the non-vision "mock-model".

We only inspect the first /api/llm request's model: the mock's turn-1 always
emits a search_arxiv tool_call (which resolves via real arXiv), but the model
id of that first request is exactly what proves the swap fired — and it's set
before any tool resolution, so no arXiv dependency is needed for the assertion.

Run:
    python tools/mock_llm.py &                         # :5050
    (backend on :8000, frontend dev on :5173)
    /c/Users/Delig/.conda/envs/Agent_env/python.exe tools/drive_vision_fallback.py
"""
import base64
import codecs
import json
import os
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

sys.stdout = codecs.getwriter("utf-8")(sys.stdout.buffer, errors="replace")
APP = os.environ.get("APP_URL", "http://127.0.0.1:5173")

PROV = {
    "name": "mock",
    "base_url": "http://127.0.0.1:5050/v1",
    "api_key": "mock",
    "model": "mock-model",  # non-vision per VISION_CAPABLE table
    "vision_model": "gpt-4o",  # vision-capable per VISION_CAPABLE table
}

# 1x1 transparent PNG (base64). data_url form expected by the attachment flow.
_PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="
PNG_DATA_URL = "data:image/png;base64," + _PNG_B64

SHOTS = Path(__file__).parent / "shots_vision"
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


def attach_image_via_setter(page):
    """The attach button triggers a hidden <input type=file>. Playwright can't
    set a data URL on a real file input, so we attach the image by calling the
    React attachment setter directly: dispatch a synthetic FileReader result
    is unnecessary — instead we push the attachment into the composer by
    calling the same path the paste handler uses. Simplest robust approach:
    set the file input's files via a real Blob is not possible for data URLs.

    So we instead drive the clipboard-paste path: evaluate JS that synthesizes
    a paste event carrying the image as a File, which ChatComposer's onPaste
    (handlePaste) reads into attachments."""
    page.evaluate(
        """(dataUrl)=>{
          // Build a File from the data URL, then synthesize a paste event
          // targeting the textarea so handlePaste picks it up.
          const arr = dataUrl.split(',');
          const mime = (arr[0].match(/data:(.*?);/) || [,'image/png'])[1];
          const bstr = atob(arr[1]);
          const u8 = new Uint8Array(bstr.length);
          for (let i=0;i<bstr.length;i++) u8[i]=bstr.charCodeAt(i);
          const file = new File([u8], 'probe.png', {type: mime});
          const dt = new DataTransfer();
          dt.items.add(file);
          const ta = document.querySelector('.composer-textarea');
          const ev = new ClipboardEvent('paste', {clipboardData: dt, bubbles: true, cancelable: true});
          ta.dispatchEvent(ev);
        }""",
        PNG_DATA_URL,
    )


with sync_playwright() as pw:
    b = pw.chromium.launch(headless=True)
    page = b.new_context(viewport={"width": 1500, "height": 950}).new_page()
    logs = []
    page.on("pageerror", lambda e: logs.append(str(e)))

    # Capture the model id of every /api/llm POST.
    llm_models = []

    def on_request(req):
        if req.method == "POST" and "/api/llm" in req.url:
            try:
                body = json.loads(req.post_data or "{}")
                llm_models.append(body.get("payload", {}).get("model"))
            except Exception:
                llm_models.append(None)

    page.on("request", on_request)

    seed(page)
    page.goto(APP, wait_until="networkidle")
    page.wait_for_timeout(1200)

    # Attach an image via the paste path, then send.
    attach_image_via_setter(page)
    page.wait_for_timeout(300)
    # Confirm an attachment preview rendered.
    n_att = page.evaluate(
        """()=>document.querySelectorAll('.composer-attachment').length"""
    )
    print("ATTACHMENT_PREVIEWS:", n_att)

    page.locator(".composer-textarea").first.fill("What is in this image?")
    page.locator(".composer-send-btn").first.click()

    # Wait for at least one /api/llm request (the image turn).
    deadline = 30
    import time as _t
    end = _t.time() + deadline
    while _t.time() < end and not llm_models:
        page.wait_for_timeout(300)

    first_model = llm_models[0] if llm_models else None
    print("FIRST_LLM_REQUEST_MODEL:", first_model)
    print("ALL_LLM_REQUEST_MODELS:", llm_models)
    page.screenshot(path=str(SHOTS / "vision_fallback.png"))
    print("PAGEERRORS:", logs)

    # ---------- idempotency: a follow-up text-only turn stays on gpt-4o ----------
    # The swap persisted c.model = "gpt-4o", so a text turn should NOT re-fire
    # the swap and should request gpt-4o again. We snapshot the request count,
    # clear it, send a plain text message, and check the next /api/llm model.
    before = len(llm_models)
    page.locator(".composer-textarea").first.fill("Thanks, any follow-up notes?")
    page.locator(".composer-send-btn").first.click()
    end2 = _t.time() + 30
    while _t.time() < end2 and len(llm_models) <= before:
        page.wait_for_timeout(300)
    followup_models = llm_models[before:]
    print("FOLLOWUP_LLM_REQUEST_MODELS:", followup_models)
    followup_stays_vision = any(m == "gpt-4o" for m in followup_models)

    swapped = first_model == "gpt-4o"
    has_attachment = n_att and n_att > 0
    no_page_errors = not logs
    ok = swapped and has_attachment and no_page_errors and followup_stays_vision
    print("VERDICT:", "PASS" if ok else "FAIL")
    b.close()
    sys.exit(0 if ok else 1)
