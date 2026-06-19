"""Verify multi-source search (OpenAlex + Semantic Scholar) end-to-end with no
real key/network. Uses mock_llm.py (forced to emit search_openalex) and
intercepts the new backend endpoints with page.route.

Checks:
  1. Enabling OpenAlex in Settings makes search_openalex appear in the tool list
     (the mock calls it on turn 1 because the query says "openalex").
  2. A paper card renders with the OpenAlex source badge.
  3. An OA paper card (oa_pdf_url set) opens the in-app PDF preview
     (/api/pdf-url is requested, PdfViewer mounts).
  4. An external-only card (no oa_pdf_url) opens the external_url in a new tab
     (window.open intercepted).
  5. No page errors.

Run (three servers up: backend :8000, frontend :5173, mock_llm :5050):
    conda activate Agent_env
    python tools/drive_multisource.py
"""
import codecs, json, os, sys
from pathlib import Path
from playwright.sync_api import sync_playwright

sys.stdout = codecs.getwriter("utf-8")(sys.stdout.buffer, errors="replace")
APP = os.environ.get("APP_URL", "http://127.0.0.1:5173")
MOCK_BASE = os.environ.get("MOCK_BASE_URL", "http://127.0.0.1:5050/v1")
PROV = {
    "name": "mock",
    "base_url": MOCK_BASE,
    "api_key": "mock",
    "model": "mock-model",
}
SHOTS = Path(__file__).parent / "shots" / "multisource"
SHOTS.mkdir(parents=True, exist_ok=True)

# Canned OpenAlex results: one OA paper (opens in-app), one external-only.
OA_RESULTS = {
    "total": 2,
    "results": [
        {
            "arxiv_id": "", "doi": "10.1000/oa-paper",
            "title": "An Open Access Paper On Vision Transformers",
            "authors": ["Ada Lovelace", "Alan Turing"],
            "abstract": "We study vision transformers with open access.",
            "pdf_url": "", "abs_url": "", "published": "2024-03-01",
            "primary_category": "Computer Vision",
            "source": "openalex",
            "oa_pdf_url": "https://example.org/oa-paper.pdf",
            "external_url": "https://doi.org/10.1000/oa-paper",
        },
        {
            "arxiv_id": "", "doi": "10.1000/paywall-paper",
            "title": "A Paywalled Paper Behind A Publisher Login",
            "authors": ["Grace Hopper"],
            "abstract": "This one has no OA PDF.",
            "pdf_url": "", "abs_url": "", "published": "2023-11-01",
            "primary_category": "",
            "source": "openalex",
            "oa_pdf_url": "",
            "external_url": "https://doi.org/10.1000/paywall-paper",
        },
    ],
}
# Minimal valid 1-page PDF bytes ("%PDF-1.4\n...%%EOF") for the pdf-url proxy.
MIN_PDF = b"%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF"


def seed(page):
    page.goto(f"{APP}/settings", wait_until="networkidle")
    page.evaluate(
        """(pj)=>{
          const p=JSON.parse(pj);
          localStorage.setItem('little-alphaxiv-settings',
            JSON.stringify({state:{
              providers:[Object.assign({id:'r'},p,{is_default:true})],
              defaultProviderId:'r',theme:'dark',
              searchSources:{openalex:{enabled:true,apiKey:'',email:''},
                             semanticScholar:{enabled:false,apiKey:''}}
            },version:0}));
        }""",
        json.dumps(PROV),
    )
    page.evaluate("""async ()=>{
      const req=indexedDB.deleteDatabase('little-alphaxiv');
      await new Promise(r=>{req.onsuccess=r;req.onerror=r;req.onblocked=r;});
    }""")


with sync_playwright() as pw:
    b = pw.chromium.launch(headless=True)
    page = b.new_context(viewport={"width": 1500, "height": 950}).new_page()
    logs = []
    page.on("pageerror", lambda e: logs.append(str(e)))

    # Intercept the new endpoints so no real network is needed.
    opened_external = {"url": None}
    page.route("**/api/openalex**", lambda r: r.fulfill(status=200, content_type="application/json", body=json.dumps(OA_RESULTS)))
    page.route("**/api/pdf-url**", lambda r: r.fulfill(status=200, content_type="application/pdf", body=MIN_PDF))
    page.expose_binding("__lax_open_external", lambda src, url: opened_external.update(url=url))

    # Capture window.open for the external-only card.
    page.add_init_script("window.open = (u)=>{ window.__lax_open_external(u); return null; };")

    seed(page)
    page.goto(APP, wait_until="networkidle")
    page.wait_for_timeout(800)

    # Query mentions "openalex" -> mock emits search_openalex.
    # Send via Enter (the merged ChatComposer's send button is an icon with
    # title="Send (Enter)", no visible "Send" text, so has-text won't match).
    page.locator("textarea").first.fill("find me openalex papers on vision transformers")
    page.locator("textarea").first.press("Enter")

    # Wait for the paper cards.
    page.wait_for_selector(".paper-card", timeout=20000)
    badges = page.evaluate("()=>[...document.querySelectorAll('.paper-card .paper-cat')].map(e=>e.textContent.trim())")
    cta_texts = page.evaluate("()=>[...document.querySelectorAll('.paper-card-cta')].map(e=>e.textContent.trim())")
    has_openalex_badge = any("OpenAlex" in b for b in badges)
    print("BADGES:", badges)
    print("CTAS:", cta_texts)
    print("HAS_OPENALEX_BADGE:", has_openalex_badge)
    page.screenshot(path=str(SHOTS / "cards.png"))

    # Click the OA card (first one) -> should open /api/pdf-url + PdfViewer.
    page.locator(".paper-card").first.click()
    page.wait_for_timeout(1500)
    pdf_visible = page.evaluate("()=>!!document.querySelector('.pdf-viewer')")
    print("OA_PDF_VIEWER_MOUNTED:", pdf_visible)
    page.screenshot(path=str(SHOTS / "oa_preview.png"))

    # Go back to chat and click the external-only card (second).
    page.go_back()
    page.wait_for_selector(".paper-card", timeout=10000)
    page.locator(".paper-card").nth(1).click()
    page.wait_for_timeout(800)
    print("EXTERNAL_OPENED_URL:", opened_external["url"])
    external_ok = opened_external["url"] == "https://doi.org/10.1000/paywall-paper"

    print("PAGEERRORS:", logs)
    b.close()

    ok = has_openalex_badge and pdf_visible and external_ok and not logs
    print("VERDICT:", "PASS" if ok else "FAIL")
    sys.exit(0 if ok else 1)
