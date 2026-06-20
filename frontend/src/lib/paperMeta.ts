// Ensure a cached Paper record carries real arXiv metadata (title, authors,
// abstract, DOI, published, primary category) — not a bare-id stub.
//
// Why this exists: a paper opened by *direct URL navigation* (a bookmark, a
// refresh, an external link) has no search-result record to seed IndexedDB
// with. PaperView's text-extraction path used to fall back to
// `title = arxivId` with empty authors/abstract/DOI, and that stub is what the
// Zotero "Add to Zotero" flow then sent on — producing a Zotero item whose
// title was the arxiv id and every other field blank. `ensurePaperMeta` fetches
// the real metadata from arXiv (via /api/paper) and merges it into the cached
// record, preserving any already-extracted full_text / oa_pdf_url.
//
// Used by PaperView (load + text-extract) and ZoteroPanel (before adding), so
// the fix is shared instead of duplicated. Best-effort: on any fetch failure
// the existing cached record is returned unchanged.

import * as db from "./db";
import { fetchPaperMeta } from "./api";
import type { Paper } from "../types";

/** The shape persisted in the `papers` IDB store (Paper + extracted full text). */
export type StoredPaper = Paper & { full_text?: string; fetched_at: number };

/** True if a cached record has a real title (not empty, not the bare arxiv id). */
export function hasRealTitle(p: { title?: string } | null | undefined, arxivId: string): boolean {
  const t = (p?.title ?? "").trim();
  return !!t && t !== arxivId;
}

/** Ensure the cached Paper record for `arxivId` has real arXiv metadata. If it
 *  already does, returns it unchanged. Otherwise fetches metadata from arXiv,
 *  merges it into IDB (preserving full_text / oa_pdf_url / existing non-empty
 *  fields), and returns the merged record. On fetch failure, returns the
 *  existing cached record (possibly the stub) unchanged — callers proceed. */
export async function ensurePaperMeta(arxivId: string): Promise<StoredPaper | undefined> {
  const cached = await db.getPaper(arxivId);
  if (cached && hasRealTitle(cached, arxivId)) return cached;

  let fetched: Paper;
  try {
    fetched = await fetchPaperMeta(arxivId);
  } catch {
    // arXiv unreachable / not found — keep what we have.
    return cached;
  }

  // Re-read in case PaperView's text-extraction wrote full_text concurrently;
  // prefer its full_text / oa_pdf_url over the (possibly stale) cached snapshot.
  const cur = (await db.getPaper(arxivId)) ?? cached;
  const merged: StoredPaper = {
    arxiv_id: arxivId,
    title: fetched.title || cur?.title || arxivId,
    authors: fetched.authors?.length ? fetched.authors : (cur?.authors ?? []),
    abstract: fetched.abstract || cur?.abstract || "",
    pdf_url: fetched.pdf_url || cur?.pdf_url || "",
    abs_url: fetched.abs_url || cur?.abs_url || "",
    published: fetched.published || cur?.published || "",
    primary_category: fetched.primary_category || cur?.primary_category || "",
    ...(fetched.doi ? { doi: fetched.doi } : cur?.doi ? { doi: cur.doi } : {}),
    source: cur?.source ?? "arxiv",
    ...(cur?.oa_pdf_url ? { oa_pdf_url: cur.oa_pdf_url } : {}),
    full_text: cur?.full_text,
    fetched_at: Date.now(),
  };
  await db.savePaper(merged);
  return merged;
}
