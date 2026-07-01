import { describe, it, expect } from "vitest";
import { resolvePaperId, openTarget, buildSearchTools, webToPapers, resolvePdfSource } from "./paperSource";
import type { Paper } from "../types";

function p(over: Partial<Paper> = {}): Paper {
  return {
    arxiv_id: "",
    title: "",
    authors: [],
    abstract: "",
    pdf_url: "",
    abs_url: "",
    published: "",
    primary_category: "",
    ...over,
  };
}

describe("resolvePaperId", () => {
  it("uses the bare arXiv id when present", () => {
    expect(resolvePaperId(p({ arxiv_id: "2401.12345" }))).toBe("2401.12345");
  });
  it("falls back to doi:<doi> when no arXiv id but a DOI exists", () => {
    expect(resolvePaperId(p({ arxiv_id: "", doi: "10.1000/xyz" }))).toBe("doi:10.1000/xyz");
  });
  it("falls back to <source>:<arxiv_id-shape> otherwise", () => {
    expect(resolvePaperId(p({ arxiv_id: "", source: "s2", doi: "" }))).toBe("s2:");
  });
});

describe("openTarget", () => {
  it("routes arXiv-id papers to the arXiv in-app path", () => {
    expect(openTarget(p({ arxiv_id: "2401.12345" }))).toEqual({ kind: "arxiv", id: "2401.12345" });
  });
  it("routes non-arXiv OA papers to the OA proxy path", () => {
    const r = openTarget(p({ arxiv_id: "", doi: "10.1000/xyz", oa_pdf_url: "https://example.org/a.pdf", source: "openalex" }));
    expect(r.kind).toBe("oa");
    if (r.kind === "oa") {
      expect(r.id).toBe("doi:10.1000/xyz");
      expect(r.url).toBe("https://example.org/a.pdf");
    }
  });
  it("routes papers with neither arXiv id nor OA to the unfetchable 3-button fallback, deriving a doi.org source link", () => {
    const r = openTarget(p({ arxiv_id: "", doi: "10.1000/xyz", source: "s2" }));
    expect(r.kind).toBe("unfetchable");
    if (r.kind === "unfetchable") {
      expect(r.id).toBe("doi:10.1000/xyz");
      expect(r.externalUrl).toBe("https://doi.org/10.1000/xyz");
    }
  });
  it("keeps an explicit external_url as the unfetchable source link", () => {
    const r = openTarget(p({ arxiv_id: "", external_url: "https://pub.example/p", source: "s2" }));
    expect(r.kind).toBe("unfetchable");
    if (r.kind === "unfetchable") expect(r.externalUrl).toBe("https://pub.example/p");
  });
  it("has no externalUrl when neither DOI nor landing page is known", () => {
    const r = openTarget(p({ arxiv_id: "", source: "s2" }));
    expect(r.kind).toBe("unfetchable");
    if (r.kind === "unfetchable") expect(r.externalUrl).toBeUndefined();
  });
});

describe("buildSearchTools", () => {
  it("returns only arXiv when nothing enabled (web_search gated on anysearch)", () => {
    const names = buildSearchTools({ openalex: false, s2: false, anysearch: false }).map((t) => t.function.name);
    expect(names).toEqual(["search_arxiv"]);
  });
  it("places web_search 2nd (after arXiv) when anysearch enabled alone", () => {
    const names = buildSearchTools({ openalex: false, s2: false, anysearch: true }).map((t) => t.function.name);
    expect(names).toEqual(["search_arxiv", "web_search"]);
  });
  it("includes search_openalex when openalex enabled", () => {
    const names = buildSearchTools({ openalex: true, s2: false, anysearch: false }).map((t) => t.function.name);
    expect(names).toEqual(["search_arxiv", "search_openalex"]);
  });
  it("includes search_semantic_scholar when s2 enabled", () => {
    const names = buildSearchTools({ openalex: false, s2: true, anysearch: false }).map((t) => t.function.name);
    expect(names).toEqual(["search_arxiv", "search_semantic_scholar"]);
  });
  it("orders arXiv → web_search → openalex → s2 when all enabled", () => {
    const names = buildSearchTools({ openalex: true, s2: true, anysearch: true }).map((t) => t.function.name);
    expect(names).toEqual(["search_arxiv", "web_search", "search_openalex", "search_semantic_scholar"]);
  });
});

describe("webToPapers", () => {
  it("maps a plain non-arXiv web result (title/url/snippet) to an unfetchable Paper with external_url + snippet abstract", () => {
    const papers = webToPapers([
      { rank: 1, title: "A Survey of 5G", url: "https://dl.acm.org/doi/10.1109/COMST.2016.2532458", snippet: "Comprehensive survey…" },
    ]);
    expect(papers).toHaveLength(1);
    const p0 = papers[0];
    expect(p0.title).toBe("A Survey of 5G");
    expect(p0.arxiv_id).toBe("");
    expect(p0.source).toBe("web");
    expect(p0.external_url).toBe("https://dl.acm.org/doi/10.1109/COMST.2016.2532458");
    expect(p0.abstract).toBe("Comprehensive survey…");
    // DOI was extracted from the /doi/<doi> path and lowercased.
    expect(p0.doi).toBe("10.1109/comst.2016.2532458");
    // No OA PDF -> unfetchable 3-button card, source link = the landing url.
    const t = openTarget(p0);
    expect(t.kind).toBe("unfetchable");
    if (t.kind === "unfetchable") expect(t.externalUrl).toBe("https://dl.acm.org/doi/10.1109/COMST.2016.2532458");
  });

  it("extracts a bare doi.org DOI", () => {
    const [p0] = webToPapers([{ rank: 1, title: "X", url: "https://doi.org/10.1000/abc", snippet: "s" }]);
    expect(p0.doi).toBe("10.1000/abc");
  });

  it("leaves doi undefined when the URL has no DOI", () => {
    const [p0] = webToPapers([{ rank: 1, title: "Blog post", url: "https://example.com/blog/5g", snippet: "s" }]);
    expect(p0.doi).toBeUndefined();
    expect(p0.external_url).toBe("https://example.com/blog/5g");
  });

  it("promotes an arXiv web result to a fetchable in-app card (arxiv_id set)", () => {
    const [p0] = webToPapers([{ rank: 1, title: "Cool paper", url: "https://arxiv.org/abs/2401.12345", snippet: "s" }]);
    expect(p0.arxiv_id).toBe("2401.12345");
    expect(openTarget(p0).kind).toBe("arxiv");
  });

  it("strips a trailing query/fragment from an extracted DOI", () => {
    const [p0] = webToPapers([{ rank: 1, title: "X", url: "https://doi.org/10.1000/abc?ref=foo", snippet: "s" }]);
    expect(p0.doi).toBe("10.1000/abc");
  });

  it("drops results with no usable URL", () => {
    expect(webToPapers([{ rank: 1, title: "X", url: "", snippet: "s" }])).toHaveLength(0);
    expect(webToPapers([{ rank: 1, title: "X", url: "   ", snippet: "s" }])).toHaveLength(0);
  });

  it("caps the snippet abstract length", () => {
    const long = "x".repeat(500);
    const [p0] = webToPapers([{ rank: 1, title: "X", url: "https://example.com/p", snippet: long }]);
    expect(p0.abstract.length).toBeLessThanOrEqual(243); // 240 + ellipsis
    expect(p0.abstract.endsWith("…")).toBe(true);
  });
});

describe("resolvePdfSource", () => {
  it("returns default for a normal arXiv paper (the branch that clears a stale override)", () => {
    expect(resolvePdfSource(p({ arxiv_id: "2401.12345", source: "arxiv" }))).toEqual({ kind: "default" });
  });

  it("returns default when the record is not cached yet (null / undefined)", () => {
    expect(resolvePdfSource(null)).toEqual({ kind: "default" });
    expect(resolvePdfSource(undefined)).toEqual({ kind: "default" });
  });

  it("returns default for a bare web result with no OA PDF and no upload source", () => {
    expect(resolvePdfSource(p({ source: "web" }))).toEqual({ kind: "default" });
  });

  it("routes an OA paper to the pdf-url proxy with its oa_pdf_url", () => {
    expect(resolvePdfSource(p({ source: "openalex", oa_pdf_url: "https://example.org/a.pdf" }))).toEqual({
      kind: "oa",
      url: "https://example.org/a.pdf",
    });
  });

  it("routes an uploaded paper to the per-user upload endpoint", () => {
    expect(resolvePdfSource(p({ source: "upload" }))).toEqual({ kind: "upload" });
  });

  it("routes a Zotero-imported paper to the per-user upload endpoint", () => {
    expect(resolvePdfSource(p({ source: "zotero" }))).toEqual({ kind: "upload" });
  });

  it("prefers oa_pdf_url over source when both are set (OA paper tagged with a non-upload source)", () => {
    expect(resolvePdfSource(p({ source: "openalex", oa_pdf_url: "https://x/y.pdf" }))).toEqual({
      kind: "oa",
      url: "https://x/y.pdf",
    });
  });

  it("documents the precedence order: oa_pdf_url > source(upload|zotero) > default", () => {
    // source=upload with no oa_pdf_url → upload (source wins over default).
    expect(resolvePdfSource(p({ arxiv_id: "2401.1", source: "upload" }))).toEqual({ kind: "upload" });
    // source=arxiv (or anything else) with no oa_pdf_url → default.
    expect(resolvePdfSource(p({ arxiv_id: "2401.1", source: "arxiv" }))).toEqual({ kind: "default" });
  });
});
