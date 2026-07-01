// Pure helpers for multi-source paper results: stable opaque-id resolution,
// the 3-way click-routing decision, and building the LLM tool list from the
// user's enabled search sources. All side-effect-free so they're unit-testable.

import type { Paper, ToolDef } from "../types";

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

/** Build the LLM tool list for the current turn. arXiv is always present;
 *  OpenAlex / Semantic Scholar tools appear only when the user enabled them. */
export function buildSearchTools(sources: {
  openalex: boolean;
  s2: boolean;
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
        "Non-arXiv links open externally (no in-app PDF preview); cite results by URL.",
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

  return tools;
}
