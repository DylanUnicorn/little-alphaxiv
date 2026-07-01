// Pure helpers for multi-source paper results: stable opaque-id resolution,
// the 3-way click-routing decision, and building the LLM tool list from the
// user's enabled search sources. All side-effect-free so they're unit-testable.

import type { Paper, ToolDef } from "../types";
import { extractArxivId } from "./arxiv";

/** Stable opaque id used as IDB key + route param + React key. arXiv id wins
 *  (it opens the existing /api/pdf path); else DOI; else the unique landing-page
 *  URL (so distinct no-id/no-DOI OA papers don't collide); else a source stub. */
export function resolvePaperId(p: Paper): string {
  if (p.arxiv_id) return p.arxiv_id;
  if (p.doi) return `doi:${p.doi}`;
  if (p.external_url) return p.external_url;
  return `${p.source ?? "paper"}:`;
}

export type OpenTarget =
  | { kind: "arxiv"; id: string }
  | { kind: "oa"; id: string; url: string }
  | { kind: "external"; url: string }
  | { kind: "unfetchable"; id: string; externalUrl?: string };

/** Decide what happens when the user clicks a paper card:
 *  - arXiv id present  -> open the existing in-app PDF preview
 *  - has an OA PDF URL -> open via the /api/pdf-url open proxy
 *  - otherwise         -> UNFETCHABLE in-app: the card renders a 3-button
 *    fallback (Upload Local PDF / Import from Zotero / Open source page) so
 *    the user can bring a paywalled/off-arXiv PDF in themselves. The card
 *    body click does nothing; the buttons drive the dialog / an external tab.
 *    externalUrl falls back to doi.org when only a DOI is known. */
export function openTarget(p: Paper): OpenTarget {
  if (p.arxiv_id) return { kind: "arxiv", id: p.arxiv_id };
  if (p.oa_pdf_url) return { kind: "oa", id: resolvePaperId(p), url: p.oa_pdf_url };
  const externalUrl = p.external_url || (p.doi ? `https://doi.org/${p.doi}` : "");
  return { kind: "unfetchable", id: resolvePaperId(p), externalUrl: externalUrl || undefined };
}

/** Which PDF endpoint should PdfViewer load this paper from?
 *  - `default` → the arXiv /api/pdf path (also the safe fallback when the
 *                record isn't cached yet — a bare arXiv id always lands here)
 *  - `oa`      → a non-arXiv open-access PDF via the /api/pdf-url proxy
 *  - `upload`  → the user's uploaded / Zotero-imported PDF via /api/paper-upload
 *
 *  Returning `default` is load-bearing: it is what CLEARS a stale override when
 *  switching from an uploaded/OA paper to a normal arXiv paper. PaperView maps
 *  `default` → `undefined` (no override), so PdfViewer falls back to /api/pdf/<id>.
 *  Without this branch the previous paper's override URL stuck around and
 *  PdfViewer kept rendering the WRONG paper — decoupling the PDF from the chat
 *  + annotation store and saving highlights to the wrong paper_id (ghost
 *  annotations appearing on blank areas of the real paper). */
export type PdfSource =
  | { kind: "default" }
  | { kind: "oa"; url: string }
  | { kind: "upload" };

export function resolvePdfSource(p: Paper | null | undefined): PdfSource {
  if (p?.oa_pdf_url) return { kind: "oa", url: p.oa_pdf_url };
  if (p?.source === "upload" || p?.source === "zotero") return { kind: "upload" };
  return { kind: "default" };
}

/** A single web_search (anysearch) result, as returned by the backend
 *  /api/websearch endpoint (parsed from anysearch's markdown). */
export interface WebSearchResult {
  rank?: number;
  title: string;
  url: string;
  snippet: string;
}

/** Snippet abstract cap — mirrors the PaperCard preview (240) + ellipsis. */
const WEB_SNIPPET_CAP = 240;

/** Convert web_search results into Paper objects so they render as PaperCards.
 *  Non-arXiv results have no arxiv_id and no OA PDF, so openTarget() classifies
 *  them as "unfetchable" -> the 3-button card (Upload Local PDF / Import from
 *  Zotero / Open source page). DOI is extracted from doi.org/<doi> or
 *  <host>/doi/<doi> URLs when present. arXiv URLs are promoted to fetchable
 *  in-app cards. Results with no usable URL are dropped (a card with no link
 *  has nowhere to send the user). */
export function webToPapers(results: WebSearchResult[]): Paper[] {
  const out: Paper[] = [];
  for (const r of results) {
    const url = (r.url || "").trim();
    if (!url) continue;
    const arxivId = extractArxivId(url);
    const doi = extractDoi(url);
    const snippet = (r.snippet || "").trim();
    const abstract =
      snippet.length > WEB_SNIPPET_CAP ? `${snippet.slice(0, WEB_SNIPPET_CAP)}…` : snippet;
    out.push({
      arxiv_id: arxivId ?? "",
      title: (r.title || "").trim() || url,
      authors: [],
      abstract,
      pdf_url: "",
      abs_url: "",
      published: "",
      primary_category: "",
      source: "web",
      ...(doi ? { doi } : {}),
      // Keep the landing URL even when a DOI is extracted, so the "Open source
      // page" button goes to the page the user actually saw (ACM/IEEE/etc.),
      // not a bare doi.org redirect.
      external_url: url,
    });
  }
  return out;
}

/** Extract a lowercased DOI from a URL. Matches doi.org/<doi> and the common
 *  publisher path /doi/<doi> (ACM, IEEE, Springer). Strips a trailing query
 *  string / fragment. Returns null when no DOI is present. */
function extractDoi(url: string): string | undefined {
  const m = url.match(/(?:doi\.org\/|\/doi\/)(10\.\d{4,9}\/[^\s?#]+)/i);
  if (!m) return undefined;
  return m[1].replace(/\/+$/, "").toLowerCase();
}

/** Build the LLM tool list for the current turn. arXiv is always present;
 *  anysearch (web_search) is 2nd, on by default (anonymous works, rate-limited);
 *  OpenAlex / Semantic Scholar appear only when the user enabled them. */
export function buildSearchTools(sources: {
  openalex: boolean;
  s2: boolean;
  anysearch: boolean;
}): ToolDef[] {
  const tools: ToolDef[] = [
    {
      type: "function",
      function: {
        name: "search_arxiv",
        description:
          "Search arXiv for academic preprints by keyword, topic, or author. " +
          "Returns matching papers with title, authors, abstract, and a clickable link to preview the PDF in-app. " +
          "Always available. Use this when the user wants preprints / arXiv papers.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "Search terms for arXiv. Concise keywords work best." },
            max_results: { type: "number", description: "Max papers to return (default 8)." },
          },
          required: ["query"],
        },
      },
    },
  ];

  if (sources.anysearch) {
    tools.push({
      type: "function",
      function: {
        name: "web_search",
        description:
          "General web search (via anysearch). Returns titles, URLs, and snippets. " +
          "Use it as a FALLBACK when the academic paper-search tools (search_arxiv / " +
          "search_openalex / search_semantic_scholar) return nothing or can't find the " +
          "paper the user asked about — e.g. IEEE, ACM, Springer, paywalled, or other " +
          "non-arXiv papers, or when the user only has a DOI or a partial title. " +
          "Also use it for non-academic questions (news, blogs, people, products). " +
          "Each result surfaces as a paper card the user can act on: arXiv URLs open the " +
          "in-app preview, every other result shows Upload Local PDF / Import from Zotero / " +
          "Open source page buttons. Summarize the most relevant results in 1-2 sentences " +
          "each; you do NOT need to repeat the URLs in your text.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "Web search query — concise keywords, a DOI, or a title." },
            max_results: { type: "number", description: "Max results to return (default 8)." },
          },
          required: ["query"],
        },
      },
    });
  }

  if (sources.openalex) {
    tools.push({
      type: "function",
      function: {
        name: "search_openalex",
        description:
          "Search OpenAlex, a broad open catalog of scholarly works across all fields " +
          "(journals, conferences, preprints — not just arXiv). Best for published, peer-reviewed literature " +
          "and broader coverage than arXiv. Open-access results can be previewed in-app; others open externally.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "Search terms for OpenAlex." },
            max_results: { type: "number", description: "Max papers to return (default 8)." },
          },
          required: ["query"],
        },
      },
    });
  }

  if (sources.s2) {
    tools.push({
      type: "function",
      function: {
        name: "search_semantic_scholar",
        description:
          "Search Semantic Scholar's academic graph (214M papers across all fields). " +
          "Good for citation-rich discovery and works indexed from many publishers. " +
          "Open-access results can be previewed in-app; others open externally.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "Search terms for Semantic Scholar." },
            max_results: { type: "number", description: "Max papers to return (default 8)." },
          },
          required: ["query"],
        },
      },
    });
  }

  return tools;
}
