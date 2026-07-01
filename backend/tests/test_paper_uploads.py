"""User-private PDF upload + serve tests.

Covers: upload creates a sha256-keyed paper, per-user hash dedup, DOI-keyed
uploads, size cap, auth-gated serve with Range, non-owner 404 (no enumeration
leak), and full_text routing to the user-scoped row (global row stays NULL so
paywalled text never leaks cross-user).
"""
from __future__ import annotations

import io
import json

from sqlmodel import select

from app import db as dbmod
from app.models import PaperRow, UserPaperUpload

# A minimal valid-enough PDF byte string (pdf.js only needs *some* bytes here;
# the serve path round-trips whatever was uploaded, so we assert byte equality).
PDF_BYTES = (
    b"%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n"
    b"2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n"
    b"3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>endobj\n"
    b"xref\n0 4\ntrailer<</Root 1 0 R>>\n%%EOF"
)


async def _register(client, username="alice", password="password123"):
    r = await client.post(
        "/api/auth/register",
        json={
            "username": username,
            "email": f"{username}@example.com",
            "password": password,
        },
    )
    assert r.status_code == 201, r.text


async def _upload(
    client,
    data=PDF_BYTES,
    title="A Paper",
    authors=None,
    abstract="abs",
    doi=None,
):
    form: dict[str, str] = {"title": title, "abstract": abstract}
    if authors is not None:
        form["authors_json"] = json.dumps(authors)
    if doi is not None:
        form["doi"] = doi
    return await client.post(
        "/api/paper-upload",
        files={"file": ("paper.pdf", io.BytesIO(data), "application/pdf")},
        data=form,
    )


async def test_upload_creates_sha256_paper(client, tmp_path, monkeypatch):
    monkeypatch.setenv("LAX_PDF_CACHE", str(tmp_path / "pdf_cache"))
    await _register(client)
    r = await _upload(client, authors=["Alice A.", "Bob B."])
    assert r.is_success, r.text
    body = r.json()
    assert body["paper_id"].startswith("sha256:")
    assert body["is_new"] is True
    assert body["source"] == "upload"
    assert body["title"] == "A Paper"
    assert body["authors"] == ["Alice A.", "Bob B."]
    assert body["full_text"] is None  # private; not surfaced here
    # Global paper row exists but full_text is NULL (paywalled text is private).
    pr = await client.get(f"/api/papers/{body['paper_id']}")
    assert pr.is_success
    assert pr.json()["full_text"] is None


async def test_upload_dedup_by_hash(client, tmp_path, monkeypatch):
    monkeypatch.setenv("LAX_PDF_CACHE", str(tmp_path / "pdf_cache"))
    await _register(client)
    r1 = await _upload(client)
    r2 = await _upload(client)  # identical bytes
    assert r1.json()["paper_id"] == r2.json()["paper_id"]
    assert r2.json()["is_new"] is False


async def test_upload_with_doi_uses_doi_key(client, tmp_path, monkeypatch):
    monkeypatch.setenv("LAX_PDF_CACHE", str(tmp_path / "pdf_cache"))
    await _register(client)
    r = await _upload(client, doi="10.1000/xyz")
    assert r.is_success, r.text
    assert r.json()["paper_id"] == "doi:10.1000/xyz"
    assert r.json()["doi"] == "10.1000/xyz"


async def test_upload_too_large_rejected(client, tmp_path, monkeypatch):
    monkeypatch.setenv("LAX_PDF_CACHE", str(tmp_path / "pdf_cache"))
    # Shrink the cap so the test doesn't allocate 50 MiB.
    monkeypatch.setattr("app.routers.paper_uploads._MAX_UPLOAD_BYTES", 100)
    await _register(client)
    r = await _upload(client, data=b"x" * 101)
    assert r.status_code == 413


async def test_serve_returns_uploaded_bytes(client, tmp_path, monkeypatch):
    monkeypatch.setenv("LAX_PDF_CACHE", str(tmp_path / "pdf_cache"))
    await _register(client)
    pid = (await _upload(client)).json()["paper_id"]
    r = await client.get(f"/api/paper-upload/{pid}")
    assert r.status_code == 200
    assert r.headers["content-type"] == "application/pdf"
    assert r.content == PDF_BYTES


async def test_serve_range_support(client, tmp_path, monkeypatch):
    monkeypatch.setenv("LAX_PDF_CACHE", str(tmp_path / "pdf_cache"))
    await _register(client)
    pid = (await _upload(client)).json()["paper_id"]
    r = await client.get(
        f"/api/paper-upload/{pid}", headers={"Range": "bytes=0-9"}
    )
    assert r.status_code == 206
    assert r.headers["content-range"] == f"bytes 0-9/{len(PDF_BYTES)}"
    assert r.content == PDF_BYTES[:10]


async def test_serve_requires_auth(client):
    r = await client.get("/api/paper-upload/sha256:deadbeef")
    assert r.status_code == 401


async def test_serve_non_owner_returns_404(client, tmp_path, monkeypatch):
    monkeypatch.setenv("LAX_PDF_CACHE", str(tmp_path / "pdf_cache"))
    await _register(client, "alice")
    pid = (await _upload(client)).json()["paper_id"]  # alice's upload
    # Register bob — the cookie jar flips to bob (register issues a session).
    await _register(client, "bob")
    r = await client.get(f"/api/paper-upload/{pid}")
    # 404 for "not yours" — same as "not found", so no cross-user enumeration.
    assert r.status_code == 404


async def test_full_text_routed_to_user_scoped_row(client, tmp_path, monkeypatch):
    monkeypatch.setenv("LAX_PDF_CACHE", str(tmp_path / "pdf_cache"))
    await _register(client)
    pid = (await _upload(client)).json()["paper_id"]
    # The extract.ts path PUTs full_text through the normal papers endpoint.
    base = (await client.get(f"/api/papers/{pid}")).json()
    base["full_text"] = "EXTRACTED FULL TEXT"
    pr = await client.put(f"/api/papers/{pid}", json=base)
    assert pr.is_success, pr.text
    assert pr.json()["full_text"] == "EXTRACTED FULL TEXT"
    # Global PaperRow.full_text stays None (paywalled text never leaks).
    async with dbmod.async_session_factory() as s:
        prow = (
            await s.exec(select(PaperRow).where(PaperRow.arxiv_id == pid))
        ).first()
        up = (
            await s.exec(
                select(UserPaperUpload).where(UserPaperUpload.paper_id == pid)
            )
        ).first()
    assert prow.full_text is None
    assert up.full_text == "EXTRACTED FULL TEXT"
