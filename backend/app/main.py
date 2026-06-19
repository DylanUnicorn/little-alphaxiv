"""Little Alphaxiv — stateless CORS proxy backend.

Zero storage, no user concept. Exists ONLY to bypass browser CORS for:
  - OpenAI-compatible LLM chat completions (no CORS headers from gateways)
  - arXiv search API (arxiv.org sends no Access-Control-Allow-Origin)
  - arXiv PDF files (no CORS headers, pdf.js can't render)

The LLM api key / base_url are sent per-request from the browser (stored in
the user's own localStorage). This server never persists anything.
"""
from __future__ import annotations

import os

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from .routers import llm, search, pdf, websearch, models, semantic_scholar, openalex

app = FastAPI(title="Little Alphaxiv Proxy", version="0.1.0")

# Stateless proxy: the browser is the only client. Allow all origins so a dev
# Vite server (http://localhost:5173) can call us. No credentials/keys are
# persisted server-side, so permissive CORS is acceptable here.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["*"],
)

app.include_router(llm.router, prefix="/api")
app.include_router(search.router, prefix="/api")
app.include_router(pdf.router, prefix="/api")
app.include_router(websearch.router, prefix="/api")
app.include_router(models.router, prefix="/api")
app.include_router(semantic_scholar.router, prefix="/api")
app.include_router(openalex.router, prefix="/api")


@app.get("/api/health")
async def health() -> dict:
    return {"status": "ok"}
