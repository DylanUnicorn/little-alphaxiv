import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  scrollKey,
  clamp01,
  computeScrollPos,
  computeFracDelta,
  loadPdfScroll,
  savePdfScroll,
} from "./pdfScrollMemory";

describe("clamp01", () => {
  it("clamps below 0 to 0 and above 1 to 1", () => {
    expect(clamp01(-0.5)).toBe(0);
    expect(clamp01(1.5)).toBe(1);
    expect(clamp01(0)).toBe(0);
    expect(clamp01(1)).toBe(1);
    expect(clamp01(0.3)).toBe(0.3);
  });
});

describe("scrollKey", () => {
  it("is namespaced per arxivId", () => {
    expect(scrollKey("2401.12345")).toBe("lax-pdf-scroll:2401.12345");
  });

  it("preserves slashes/colons in uploaded-paper ids (doi:…)", () => {
    // Uploaded/Zotero paper ids look like "doi:10.1/x" — they contain '/' and
    // ':'. localStorage keys are arbitrary strings, so no encoding is needed,
    // and the key must round-trip verbatim.
    const id = "doi:10.1/x/y";
    expect(scrollKey(id)).toBe(`lax-pdf-scroll:${id}`);
  });
});

describe("computeScrollPos", () => {
  const H = 800; // page height
  const CONTAINER_TOP = 0; // viewport top at y=0 for simplicity

  it("returns null for empty rects", () => {
    expect(computeScrollPos([], CONTAINER_TOP)).toBeNull();
  });

  it("page 1 with no scroll → page 1, frac 0", () => {
    // Three pages stacked starting at y=0; container top at 0.
    const rects = [
      { top: 0, height: H },
      { top: H, height: H },
      { top: 2 * H, height: H },
    ];
    expect(computeScrollPos(rects, CONTAINER_TOP)).toEqual({ page: 1, frac: 0 });
  });

  it("scrolled halfway through page 2 → page 2, frac ~0.5", () => {
    // Container top at H + H/2 = 1.5H. Page 2 spans [H, 2H]; its top (H) is
    // above the container top, page 3's top (2H) is below → topmost = page 2.
    // scrolledPast = containerTop - page2.top = 1.5H - H = 0.5H → frac 0.5.
    const rects = [
      { top: 0, height: H },
      { top: H, height: H },
      { top: 2 * H, height: H },
    ];
    const pos = computeScrollPos(rects, H + H / 2);
    expect(pos).toEqual({ page: 2, frac: 0.5 });
  });

  it("at a page boundary → picks the page whose top is at the container top", () => {
    // Container top exactly at page 3's top (2H): page 3's top (2H) is
    // <= containerTop (2H) so it's the topmost → page 3, frac 0.
    const rects = [
      { top: 0, height: H },
      { top: H, height: H },
      { top: 2 * H, height: H },
    ];
    expect(computeScrollPos(rects, 2 * H)).toEqual({ page: 3, frac: 0 });
  });

  it("scrolled past the last page → clamps frac at 1 on the last page", () => {
    // Container top well beyond the last page; scrolledPast > height → clamp.
    const rects = [
      { top: 0, height: H },
      { top: H, height: H },
    ];
    expect(computeScrollPos(rects, 10 * H)).toEqual({ page: 2, frac: 1 });
  });

  it("handles variable page heights", () => {
    // Page 1 height 1000 (placeholder), page 2 height 600. Container top at
    // 1000 + 300 = 1300 → topmost page 2, scrolledPast = 1300-1000 = 300,
    // frac = 300/600 = 0.5.
    const rects = [
      { top: 0, height: 1000 },
      { top: 1000, height: 600 },
    ];
    expect(computeScrollPos(rects, 1300)).toEqual({ page: 2, frac: 0.5 });
  });

  it("zero-height page → frac 0 (no NaN)", () => {
    const rects = [{ top: 0, height: 0 }];
    expect(computeScrollPos(rects, 0)).toEqual({ page: 1, frac: 0 });
  });
});

describe("computeFracDelta", () => {
  it("right after scrollIntoView (scrolledPast≈0) → delta = frac * height", () => {
    // After scrollIntoView({block:start}) the target page top aligns with the
    // container top: scrolledPast = containerTop - targetTop = 0.
    const target = { top: 100, height: 800 };
    const containerTop = 100;
    // frac 0.5 → 0.5*800 - 0 = 400.
    expect(computeFracDelta(target, containerTop, 0.5)).toBe(400);
  });

  it("self-corrects for residual container-top padding", () => {
    // .pdf-scroll has 12px top padding, so after scrollIntoView the target top
    // may sit 12px ABOVE the container top (scrolledPast = 12). The delta must
    // subtract that residual so frac lands inside the page, not 12px past it.
    const target = { top: 88, height: 800 };
    const containerTop = 100; // scrolledPast = 100 - 88 = 12
    // frac 0.5 → 0.5*800 - 12 = 388.
    expect(computeFracDelta(target, containerTop, 0.5)).toBe(388);
  });

  it("frac 0 → delta cancels any residual offset back to page top", () => {
    const target = { top: 88, height: 800 };
    const containerTop = 100; // residual 12px above
    expect(computeFracDelta(target, containerTop, 0)).toBe(-12);
  });
});

// In-memory localStorage stub (the repo's vitest runs in the node env — no
// jsdom — so provide a minimal store for the load/save round-trip + version
// tests). Scoped per-test via beforeEach reset.
function makeStore() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string) => { m.set(k, String(v)); },
    removeItem: (k: string) => { m.delete(k); },
    clear: () => m.clear(),
  } as unknown as Storage;
}

describe("loadPdfScroll / savePdfScroll (schema versioning)", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", makeStore());
  });

  it("round-trips a position and stamps the schema version", () => {
    savePdfScroll("2401.12345", { page: 7, frac: 0.42 });
    // The raw entry must carry v:1 so future loads accept it.
    const raw = localStorage.getItem(scrollKey("2401.12345"));
    expect(JSON.parse(raw!).v).toBe(1);
    expect(loadPdfScroll("2401.12345")).toEqual({ page: 7, frac: 0.42 });
  });

  it("rejects stale entries written by the buggy v1 (no version field)", () => {
    // This is the regression: the v1 unmount bug wrote {page: lastPage, frac:0}
    // with NO version. Such entries must be ignored so restore doesn't jump to
    // the last page forever.
    localStorage.setItem(scrollKey("2401.12345"), JSON.stringify({ page: 15, frac: 0 }));
    expect(loadPdfScroll("2401.12345")).toBeNull();
  });

  it("rejects entries with a wrong (future/incompatible) version", () => {
    localStorage.setItem(scrollKey("2401.12345"), JSON.stringify({ page: 3, frac: 0.5, v: 99 }));
    expect(loadPdfScroll("2401.12345")).toBeNull();
  });

  it("rejects corrupt (non-JSON / bad fields) entries", () => {
    localStorage.setItem(scrollKey("2401.12345"), "{not json");
    expect(loadPdfScroll("2401.12345")).toBeNull();
    localStorage.setItem(scrollKey("2401.12345"), JSON.stringify({ page: 0, frac: 0.5, v: 1 }));
    expect(loadPdfScroll("2401.12345")).toBeNull(); // page < 1
  });

  it("returns null when no entry exists", () => {
    expect(loadPdfScroll("nope")).toBeNull();
  });
});

