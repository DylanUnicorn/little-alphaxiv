"""Focused: full chat round-trip (wait for final answer) + paper chat send + PDF select."""
import codecs, sys, time
from pathlib import Path
from playwright.sync_api import sync_playwright
sys.stdout = codecs.getwriter("utf-8")(sys.stdout.buffer, errors="replace")
APP = "http://127.0.0.1:5173"
PROV = {"name":"ppio-glm","base_url":"https://api.ppio.com/openai/v1","api_key":"sk_FwuagHFdkC_UxM75YOZkZ6Aetu-9JulmUpmnHYgz6A0","model":"zai-org/glm-5.2"}

import json
def seed(page):
    page.goto(f"{APP}/settings", wait_until="networkidle")
    prov_json = json.dumps(PROV)
    page.evaluate("""(pj)=>{const p=JSON.parse(pj);localStorage.setItem('little-alphaxiv-settings',JSON.stringify({state:{providers:[Object.assign({id:'r'},p,{is_default:true})],defaultProviderId:'r',sidebarCollapsed:false},version:0}))}""", prov_json)

with sync_playwright() as pw:
    b = pw.chromium.launch(headless=True)
    page = b.new_context(viewport={"width":1500,"height":950}).new_page()
    logs=[]; page.on("pageerror", lambda e: logs.append(str(e)))
    # chat
    seed(page); page.goto(APP, wait_until="networkidle"); page.wait_for_timeout(1200)
    page.locator("textarea").first.fill("找 vision transformer 论文")
    page.locator(".composer-send-btn").click()
    # wait up to 90s for final assistant text (non-pending) — GLM is slow with reasoning
    deadline=time.time()+90; done=False
    while time.time()<deadline:
        n = page.evaluate("""()=>[...document.querySelectorAll('.msg-assistant:not(.pending)')].filter(m=>m.textContent.trim()).length""")
        if n>=2:  # tool-call assistant + final answer assistant
            done=True; break
        page.wait_for_timeout(1500)
    print("FINAL_ANSWER_DONE:", done)
    page.wait_for_timeout(1000)
    state = page.evaluate("""()=>({msgs:[...document.querySelectorAll('.msg')].map(m=>m.className), ta:document.querySelectorAll('textarea').length, cards:document.querySelectorAll('.paper-card').length, finalText:(document.querySelectorAll('.msg-assistant:not(.pending)')[1]||{}).textContent?.slice(0,120)})""")
    print("CHAT_STATE:", state)
    page.screenshot(path=str(Path(__file__).parent/"shots_real"/"final_chat.png"))
    # paper chat: click first card -> paper view, send a question, wait for answer
    page.locator(".paper-card").first.click()
    page.wait_for_selector(".pdf-page-canvas-wrap canvas", timeout=30000)
    page.wait_for_timeout(6000)
    # type a question about the paper
    ta = page.locator(".chat-col textarea").first
    ta.fill("这篇论文的核心贡献是什么?一句话总结")
    page.locator(".chat-col .composer-send-btn").click()
    deadline=time.time()+90; pdone=False
    while time.time()<deadline:
        n = page.evaluate("""()=>document.querySelectorAll('.chat-col .msg-assistant:not(.pending)').length""")
        if n>=1: pdone=True; break
        page.wait_for_timeout(1500)
    print("PAPER_CHAT_ANSWER:", pdone)
    page.wait_for_timeout(800)
    pstate = page.evaluate("""()=>({ta:document.querySelectorAll('.chat-col textarea').length, msgs:document.querySelectorAll('.chat-col .msg').length, answer:(document.querySelector('.chat-col .msg-assistant:not(.pending)')||{}).textContent?.slice(0,150)})""")
    print("PAPER_CHAT_STATE:", pstate)
    # PDF selection test: drag-select across the text layer
    sel = page.evaluate("""()=>{const s=document.querySelector('.pdf-textlayer span'); if(!s)return null; const r=s.getBoundingClientRect(); return {x:r.x,y:r.y,w:r.width,h:r.height};}""")
    print("FIRST_SPAN:", sel)
    if sel:
        page.mouse.move(sel["x"]+10, sel["y"]+sel["h"]/2)
        page.mouse.down()
        page.mouse.move(sel["x"]+sel["w"]-5, sel["y"]+sel["h"]/2, steps=8)
        page.mouse.up()
        page.wait_for_timeout(300)
        got = page.evaluate("""()=>window.getSelection().toString()""")
        print("SELECTED_TEXT:", repr(got)[:80])
    page.screenshot(path=str(Path(__file__).parent/"shots_real"/"paper_chat.png"))
    print("PAGEERRORS:", logs)
    b.close()
