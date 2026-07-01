# Local Paper Upload + Zotero Reverse-Import — Design

**Date:** 2026-07-01
**Status:** Approved (user sign-off 2026-07-01), implementation in progress
**Worktree:** `feature-local-paper-upload`

## 1. Background & goal

Some PDFs the LLM surfaces in general chat are **paywalled** or otherwise unfetchable by the
arXiv/search tooling — so the user can never reach an in-app preview, and the model often goes
silent without explaining why. Two pain points:

1. No way to bring a locally-owned PDF (paywalled, off-arXiv, etc.) into the app.
2. Existing Zotero users have a library full of such PDFs but no bridge into Little Alphaxiv.

**Goal:** one unified "Open Local Paper" entry with two import sources — **file upload** and
**Zotero reverse-import** — sharing a single backend local-storage + serving mechanism. On
success the paper opens in the normal PaperView and runs the existing conversation / annotation
/ title-generation flow unchanged. As a top priority, teach the model to **proactively explain**
when it can't get a PDF, with UI-determined fallback buttons on the surfaced card.

## 2. Load-bearing decisions (all user-approved)

| # | Decision | Choice |
|---|---|---|
| D1 | Scope | One unified feature, two import sources, shared backend serve mechanism, one frontend entry |
| D2 | Data model | **Hybrid**: global `Paper` row holds shareable metadata (`full_text=NULL` for uploads); new user-scoped table holds private PDF bytes + `full_text` + upload facts |
| D3 | Upload metadata source | Instant PDF-embedded metadata fill + optional `[Try LLM enrichment]` / `[Try DOI lookup]` buttons |
| D4 | "Can't get PDF" 3-choice fallback | **UI-determined**: unfetchable PaperCard renders 3 buttons; system prompt adds a natural-language instruction for the model to explain |

## 3. Data model (D2, hybrid)

### 3.1 Reuse global `Paper` table for shareable metadata

An uploaded paper still gets a `Paper` row (so existing GET `/api/papers/{id}`, `PaperView`,
sidebar grouping, annotation keying all work with zero routing changes). The row is
metadata-only for uploads:

| `Paper` field | Value for an uploaded paper |
|---|---|
| `arxiv_id` (PK) | `doi:<doi>` if DOI known, else `sha256:<content_hash[:16]>` |
| `title` / `authors` / `abstract` | from PDF metadata / LLM / Crossref (D3) |
| `source` | new enum value `"upload"` or `"zotero"` |
| `full_text` | **`NULL`** — the extracted full text IS the paywalled content, so it is private; lives on the user-scoped row |
| `doi` / `pdf_url` / `abs_url` / `oa_pdf_url` / `external_url` | filled when known; `external_url` powers `[Open source page]` |

**Identifier scheme** reuses the existing precedent where non-arXiv papers already store
`doi:...` / URL stubs in the `arxiv_id` slot (`ChatPanel.tsx` → `resolvePaperId`). Cross-user
metadata dedup falls out for free: two users uploading the same paper (same DOI, or identical
bytes with no DOI) hit the same global `Paper` row.

### 3.2 New user-scoped table `UserPaperUpload`

| Column | Type | Notes |
|---|---|---|
| `id` | int, PK | server-generated |
| `user_id` | int, FK→user.id, indexed | owner |
| `paper_id` | str, FK→paper.arxiv_id | the global metadata row |
| `source` | str | `"upload"` \| `"zotero"` |
| `content_hash` | str | sha256 of PDF bytes; unique on `(user_id, content_hash)` for dedup |
| `stored_path` | str | relative path under per-user upload dir |
| `zotero_item_key` | str? | when `source="zotero"` |
| `zotero_attachment_key` | str? | the PDF attachment key |
| `full_text` | str? | extracted full text (private) |
| `byte_size` | int | |
| `uploaded_at` | int | epoch |

Composite unique `(user_id, content_hash)` → re-uploading the same PDF returns the existing
row instead of re-storing bytes.

### 3.3 PDF byte storage

Per-user subdir under the existing cache root: `deploy/data/pdf_cache/uploads/<user_id>/<content_hash>.pdf`
(local dev + Docker share the dir via `run.sh`/`run.bat`). Auth-gated on read.

### 3.4 `full_text` read/write routing

The extraction flow (`extract.ts` → `PaperView.onTextExtracted` → `db.savePaper` → `PUT /api/papers/{id}`)
stays unchanged on the frontend. The backend routes `full_text`:

- **GET `/api/papers/{id}`**: if a `UserPaperUpload` exists for `(current_user, id)`, merge its
  `full_text` into the returned `StoredPaper`; else return the global row as-is.
- **PUT `/api/papers/{id}`**: if a `UserPaperUpload` exists for `(current_user, id)`, write
  `full_text` to the user-scoped row (never the global); else to the global row (existing behavior).

This keeps `extract.ts` / `PaperView` byte-for-byte unchanged.

## 4. Serving path

### 4.1 New backend endpoint `GET /api/paper-upload/{paper_id}`

- Auth-gated (`current_user`). Looks up `UserPaperUpload` by `(user.id, paper_id)`.
- 404 if no row OR not owned by the caller (same response — no ID enumeration leak).
- Serves bytes with HTTP `Range` support by reusing `pdf.py::_serve_bytes`.
- Sets `Content-Type: application/pdf`, `Content-Disposition: inline`.

### 4.2 Frontend wiring (no PdfViewer change)

`PdfViewer` already accepts a `pdfUrlOverride` (used today for OA papers via `pdfUrlForOa`).
For an uploaded paper (`paper.source ∈ {"upload","zotero"}`), `PaperView` sets
`pdfUrlOverride = paperUploadUrl(paperId)` → `/api/paper-upload/${encodeURIComponent(paperId)}`.
`pdf.js` loads it transparently; `extract.ts` walks text as usual.

## 5. Import dialog (frontend)

### 5.1 Entry point

New `+ Open Local Paper` button in the left sidebar, directly below `+ New Chat`. Opens an
`OpenLocalPaperDialog` modal with two tabs: **Upload Local PDF** | **Import from Zotero**.

### 5.2 Upload tab

1. File picker (`accept=.pdf`). Frontend computes `sha256(fileBytes)` via `crypto.subtle`.
2. `POST /api/paper-upload` (multipart: `file` + `content_hash` + any user-edited metadata):
   - Backend stores bytes to per-user dir, computes its own hash to verify, creates the global
     `Paper` row (metadata, `source="upload"`, `full_text=NULL`) + `UserPaperUpload` row.
   - Backend also extracts PDF `Info`/XMP metadata server-side (see §5.4) and returns it.
   - If `(user_id, content_hash)` already exists → return existing `paper_id` (dedup, no re-store).
3. Modal shows the parsed metadata form: Title / Authors / Abstract / DOI / Published.
   Buttons: `[Looks good, open paper]` · `[Edit metadata]` · `[Try LLM enrichment]` ·
   `[Try DOI lookup]`.
4. `[Edit metadata]` → form editable; on save, `PUT /api/papers/{id}` updates the global row.
5. `[Try LLM enrichment]` → frontend extracts page-1 text via pdf.js, calls `completeChat`
   (non-streaming, same path as title-gen) with an extraction prompt → fills the form.
6. `[Try DOI lookup]` → if a DOI is present, calls the existing OpenAlex/Crossref router →
   fills the form.
7. `[Looks good, open paper]` → `navigate(/paper/{paperId})`.

### 5.3 Zotero tab

1. Search box (+ optional collection dropdown). Calls existing `GET /api/zotero/items?q=…`.
2. User picks an item. Frontend calls **new** `GET /api/zotero/items/{key}/attachments` →
   lists the item's attachment children (`itemType=attachment`, `contentType=application/pdf`).
3. If a PDF attachment exists → **new** `POST /api/papers/import-from-zotero`:
   - Backend streams bytes from `GET https://api.zotero.org/users/{uid}/items/{attKey}/file`
     (`Zotero-API-Key` header, creds from `UserSettings.zotero_config`).
   - Stores bytes to per-user dir, hashes them, creates global `Paper` row (metadata from the
     Zotero item's `title`/`creators`/`abstractNote`, `source="zotero"`, `full_text=NULL`) +
     `UserPaperUpload` row (`zotero_item_key`, `zotero_attachment_key`).
   - Returns `{ paper_id, has_pdf: true }`.
4. No PDF attachment → modal shows "This item has no PDF attachment — try manual upload" with a
   button that flips to the Upload tab.
5. `has_pdf` → `navigate(/paper/{paperId})`.

Zotero creds: the zotero router currently takes `user_id`+`api_key` per-request even though
`settings.py` persists them encrypted. The new import endpoints will read creds from
`UserSettings` directly (resolving the stale per-request pattern for these paths; existing
endpoints stay per-request for now).

### 5.4 PDF metadata extraction (D3, "hybrid")

Backend gains a small PDF-Info/XMP metadata reader. Two options, decided in implementation:

- **(a)** Add `pypdf` (pure-Python, lightweight, parses `Info` dict + XMP) to `requirements.txt`.
- **(b)** No new dep — frontend pdf.js `getMetadata()` reads Info/XMP in-browser, sends the
  dict to the backend in the upload POST.

Recommended: **(b)** — pdf.js already opens the PDF for rendering/extraction in the browser,
and `getMetadata()` is one call. Avoids a new backend dep and keeps text extraction's
"frontend does PDF parsing" invariant (the backend never parses PDF content today). Backend
just stores the metadata dict the frontend sends.

The `[Try LLM enrichment]` button covers the gap when Info metadata is wrong/empty (common for
academic PDFs); `[Try DOI lookup]` covers the case where a DOI is embedded.

## 6. "Can't get PDF" fallback (D4, UI-determined)

### 6.1 Unfetchable PaperCard

`openTarget(paper)` (`paperSource.ts`) gains a new kind:

- `kind: "unfetchable"` when `paper` has **no `arxiv_id` AND no `oa_pdf_url`** (i.e. only an
  `external_url` landing page), OR has `arxiv_id` but arXiv fetch already 404'd at a prior click
  (tracked in a lightweight client-side set of "known-bad" ids).

An unfetchable card renders three buttons instead of the "Click to preview PDF →" CTA:

- `[Upload Local PDF]` → opens `OpenLocalPaperDialog` on the Upload tab, **pre-seeded with the
  surfaced paper's title/authors/doi/external_url** so the upload attaches bytes to the
  *existing* global `Paper` row (no new row, no duplicate id).
- `[Import from Zotero]` → opens the dialog on the Zotero tab with the search box pre-filled
  with the paper title.
- `[Open source page ↗]` → `window.open(external_url)` (existing external-open path).

Card body click does nothing (no PDF to navigate to) — the 3 buttons are the only actions.

### 6.2 System prompt change (general chat)

Add to the general-chat system prompt:

> If you surface a paper whose PDF you cannot open in-app (paywalled, non-arXiv without an
> open-access URL, or the download fails), say so explicitly in natural language and surface
> the paper so the user can use the Upload / Import / Open-source buttons on the card. If you
> find no relevant paper at all, say so and point the user to "+ Open Local Paper" in the sidebar.

No structured token, no new tool. Buttons are a UI consequence of unfetchability; the
explanation is the model's job (plays to its strength). The mock-LLM title-sniffing contract
(`"title generator"` / `"paper being discussed"`) is untouched — this instruction is additive
to the general prompt only.

## 7. Error handling

| Case | Behavior |
|---|---|
| Upload > size cap (50 MiB, matching `_OA_PDF_MAX_BYTES` order) | Reject at POST with 413 + clear message |
| Non-PDF / corrupt file | pdf.js `getDocument` fails in dialog → "couldn't read this PDF" |
| Re-upload same bytes (same user) | Return existing `paper_id`, no re-store |
| Same DOI, different users | Same global `Paper` row (metadata dedup), separate `UserPaperUpload` rows |
| Zotero item, multiple PDF attachments | v1: pick the largest; v2: let user choose |
| Zotero download fails (network / 403) | Fall back to "no PDF, try manual upload" message |
| Zotero creds not configured | Zotero tab shows "configure Zotero in Settings first" with link |
| LLM enrichment fails / no provider | Button shows error, keep the instant-parse result |
| Non-owner requests `GET /api/paper-upload/{id}` | 404 (no enumeration leak) |

## 8. Testing

**Backend (pytest, `Agent_env`):**
- `POST /api/paper-upload`: multipart, auth, dedup by hash, dedup by DOI, size cap, non-owner 404 on serve.
- `GET /api/paper-upload/{id}`: Range support, auth-gating, 404 for non-owner.
- `full_text` routing: upload `full_text` lands on user-scoped row, not global; GET merges.
- `POST /api/papers/import-from-zotero`: mock Zotero HTTP for attachment enumeration + file download; no-attachment case.
- Alembic migration for `UserPaperUpload` table.

**Frontend (Vitest):**
- `OpenLocalPaperDialog`: upload tab happy path, Zotero tab, metadata form, enrichment button wiring.
- `openTarget` new `"unfetchable"` kind → 3 buttons render.
- `paperSource` identifier resolution for `sha256:`/`doi:` ids.

**E2E (Playwright, `tools/`):**
- New `drive_local_paper_upload.py`: register → open dialog → upload a small test PDF → assert
  PaperView renders + a mock-LLM chat reply works. Uses the existing mock LLM (:5050).
- Zotero import path covered by backend tests with mocked Zotero HTTP (no E2E for v1 — no live Zotero in CI).

## 9. Scope & non-goals

**In scope (v1):** upload tab, Zotero tab (search + pick + import), unfetchable-card 3 buttons,
system-prompt instruction, `UserPaperUpload` table + migration, per-user serve endpoint,
`full_text` routing, backend + frontend + E2E tests.

**Non-goals (deferred):**
- Bulk Zotero import (whole library / collection at once) — v1 is one item at a time.
- "Remove from library" / delete an uploaded paper — uploads persist for now.
- Zotero attachment picker (choose among multiple PDFs) — v1 picks largest.
- Migrating the existing per-request Zotero cred pattern on legacy endpoints — only the new
  import endpoints read from `UserSettings`; legacy endpoints stay per-request.
- Shared/collaborative uploaded libraries — uploads stay strictly user-private.

## 10. Open implementation details (decide during build)

- Exact max upload size (proposed 50 MiB).
- Whether `[Try DOI lookup]` hits OpenAlex or Crossref first (OpenAlex already has a router).
- Whether the "known-bad arxiv id" client-side set persists across reloads (proposed: ephemeral
  in-memory; a reload re-attempts the fetch — cheap and self-healing).
