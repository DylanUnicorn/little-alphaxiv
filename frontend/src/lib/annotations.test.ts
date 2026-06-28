import { describe, it, expect } from "vitest";
import {
  PALETTE, normalizePoint, denormalizePoint,
  normalizeRect, denormalizeRect, rectsToNorm, newId,
  rectsOverlap, overlappingHighlightIds, fitHighlightRects,
} from "./annotations";
import type { Annotation } from "../types";

describe("PALETTE", () => {
  it("has exactly 6 colors", () => {
    expect(PALETTE).toHaveLength(6);
  });
});

describe("newId", () => {
  it("produces unique ids with a_ prefix", () => {
    expect(newId().startsWith("a_")).toBe(true);
    expect(newId()).not.toBe(newId());
  });
});

describe("normalizePoint / denormalizePoint round-trip", () => {
  const size = { w: 800, h: 1000 };
  it("round-trips a point", () => {
    const n = normalizePoint(120, 250, size);
    expect(n.x).toBeCloseTo(0.15);
    expect(n.y).toBeCloseTo(0.25);
    const p = denormalizePoint(n, size);
    expect(p.x).toBeCloseTo(120, 5);
    expect(p.y).toBeCloseTo(250, 5);
  });
  it("clamps to 0..1", () => {
    const n = normalizePoint(-50, 5000, size);
    expect(n.x).toBe(0);
    expect(n.y).toBe(1);
  });
});

describe("normalizeRect / denormalizeRect round-trip", () => {
  const size = { w: 800, h: 1000 };
  it("round-trips a rect", () => {
    const n = normalizeRect(100, 200, 300, 400, size);
    const p = denormalizeRect(n, size);
    expect(p.x).toBeCloseTo(100, 5);
    expect(p.y).toBeCloseTo(200, 5);
    expect(p.w).toBeCloseTo(300, 5);
    expect(p.h).toBeCloseTo(400, 5);
  });
});

describe("rectsToNorm", () => {
  const size = { w: 800, h: 1000 };
  it("converts DOMRect-like rects to normalized", () => {
    const out = rectsToNorm(
      [{ left: 80, top: 100, width: 240, height: 20 }, { left: 80, top: 120, width: 160, height: 20 }],
      size
    );
    expect(out).toHaveLength(2);
    expect(out[0].x).toBeCloseTo(0.1);
    expect(out[0].w).toBeCloseTo(0.3);
    expect(out[1].h).toBeCloseTo(0.02);
  });
});

// ---- highlight overlap dedup (one color per character) ----
// The bug: re-highlighting text that already has a highlight stacks a second
// color rect on top, and with mix-blend-mode:multiply the overlapping chars
// darken into an unreadable block. Fix: when creating a new highlight, drop
// any existing highlight on the same page whose rects overlap the new one, so
// each character carries at most one color.

describe("rectsOverlap", () => {
  it("returns true for partially overlapping rects", () => {
    expect(rectsOverlap(
      { x: 0.1, y: 0.1, w: 0.2, h: 0.2 },
      { x: 0.2, y: 0.15, w: 0.2, h: 0.2 }
    )).toBe(true);
  });
  it("returns true for fully contained rect", () => {
    expect(rectsOverlap(
      { x: 0.1, y: 0.1, w: 0.8, h: 0.8 },
      { x: 0.2, y: 0.2, w: 0.1, h: 0.1 }
    )).toBe(true);
  });
  it("returns false for disjoint rects (side by side)", () => {
    expect(rectsOverlap(
      { x: 0.1, y: 0.1, w: 0.1, h: 0.1 },
      { x: 0.3, y: 0.1, w: 0.1, h: 0.1 }
    )).toBe(false);
  });
  it("returns false for touching-but-not-overlapping (shared edge)", () => {
    // adjacent line rects share an edge but cover different chars
    expect(rectsOverlap(
      { x: 0.1, y: 0.1, w: 0.8, h: 0.05 },
      { x: 0.1, y: 0.15, w: 0.8, h: 0.05 }
    )).toBe(false);
  });
  it("returns false for zero-area rects", () => {
    expect(rectsOverlap(
      { x: 0.1, y: 0.1, w: 0, h: 0.2 },
      { x: 0.1, y: 0.1, w: 0.2, h: 0.2 }
    )).toBe(false);
  });
});

function hl(id: string, page: number, rects: { x: number; y: number; w: number; h: number }[], color = "#FFEB3B"): Annotation {
  return { id, arxiv_id: "p", page, type: "highlight", color, createdAt: 1, highlight: { rects } };
}

describe("overlappingHighlightIds", () => {
  const newRects = [{ x: 0.1, y: 0.1, w: 0.2, h: 0.05 }];

  it("returns ids of same-page highlights whose rects overlap the new selection", () => {
    const existing: Annotation[] = [
      hl("h1", 1, [{ x: 0.15, y: 0.1, w: 0.2, h: 0.05 }]), // overlaps
      hl("h2", 1, [{ x: 0.5, y: 0.5, w: 0.1, h: 0.05 }]),   // disjoint
    ];
    expect(overlappingHighlightIds(existing, 1, newRects)).toEqual(["h1"]);
  });

  it("ignores highlights on other pages", () => {
    const existing: Annotation[] = [
      hl("h1", 2, [{ x: 0.15, y: 0.1, w: 0.2, h: 0.05 }]),
    ];
    expect(overlappingHighlightIds(existing, 1, newRects)).toEqual([]);
  });

  it("ignores non-highlight annotations on the same page", () => {
    const rect: Annotation = { id: "r1", arxiv_id: "p", page: 1, type: "rect", color: "#FFEB3B", createdAt: 1, rect: { x: 0.15, y: 0.1, w: 0.2, h: 0.05 } };
    expect(overlappingHighlightIds([rect], 1, newRects)).toEqual([]);
  });

  it("returns multiple ids when several existing highlights overlap a multi-line new selection", () => {
    const existing: Annotation[] = [
      hl("h1", 1, [{ x: 0.1, y: 0.1, w: 0.2, h: 0.05 }]),  // line 1 overlap
      hl("h2", 1, [{ x: 0.1, y: 0.2, w: 0.2, h: 0.05 }]),  // line 2 overlap
      hl("h3", 1, [{ x: 0.9, y: 0.9, w: 0.05, h: 0.05 }]), // disjoint
    ];
    const newMulti = [
      { x: 0.1, y: 0.1, w: 0.3, h: 0.05 },
      { x: 0.1, y: 0.2, w: 0.3, h: 0.05 },
    ];
    expect(overlappingHighlightIds(existing, 1, newMulti).sort()).toEqual(["h1", "h2"]);
  });

  it("returns empty when nothing overlaps", () => {
    const existing: Annotation[] = [hl("h1", 1, [{ x: 0.5, y: 0.5, w: 0.1, h: 0.05 }])];
    expect(overlappingHighlightIds(existing, 1, newRects)).toEqual([]);
  });
});

describe("fitHighlightRects", () => {
  it("returns [] for empty input", () => {
    expect(fitHighlightRects([])).toEqual([]);
  });

  it("insets a single rect vertically (top down, bottom up), keeps width/left", () => {
    // height 20, TOP_INSET 0.12 -> topCut 2.4, BOTTOM_INSET 0.06 -> botCut 1.2
    const out = fitHighlightRects([{ left: 80, top: 100, width: 240, height: 20 }]);
    expect(out).toHaveLength(1);
    expect(out[0].left).toBe(80);
    expect(out[0].width).toBe(240);
    expect(out[0].top).toBeCloseTo(102.4, 5);
    expect(out[0].height).toBeCloseTo(16.4, 5);
  });

  it("de-overlaps adjacent line rects: lower top pushed below upper bottom", () => {
    // Tight leading: two 20px-tall lines whose raw tops are only 15px apart
    // overlap by 5px. After inset (top 2.4 / bot 1.2 -> upper bottom 118.8),
    // the lower rect's inset top (117.4) still sits above 118.8, so the trim
    // pushes it down to 119.8 with a 1px gap.
    const out = fitHighlightRects([
      { left: 80, top: 100, width: 240, height: 20 },
      { left: 80, top: 115, width: 240, height: 20 },
    ]);
    expect(out).toHaveLength(2);
    const upperBottom = out[0].top + out[0].height;
    expect(out[1].top).toBeGreaterThanOrEqual(upperBottom);
    expect(out[1].top - upperBottom).toBeCloseTo(1, 5); // 1px gap
    // lower rect keeps its original bottom (inset), only the top moved
    expect(out[1].top + out[1].height).toBeCloseTo(133.8, 5);
  });

  it("leaves non-overlapping rects alone (beyond the inset)", () => {
    // 20px tall, tops 100 apart -> no overlap; second rect's inset top is
    // unchanged by the trim step.
    const out = fitHighlightRects([
      { left: 80, top: 100, width: 240, height: 20 },
      { left: 80, top: 200, width: 240, height: 20 },
    ]);
    expect(out[1].top).toBeCloseTo(202.4, 5); // only the 12% inset, no trim
  });

  it("does not trim same-line rects (near-equal tops)", () => {
    // Two rects on the same visual line (multi-column wrap): tops within 1px.
    // The trim must not fire — both keep their inset tops.
    const out = fitHighlightRects([
      { left: 80, top: 100, width: 100, height: 20 },
      { left: 200, top: 100.5, width: 100, height: 20 },
    ]);
    expect(out[0].top).toBeCloseTo(102.4, 5);
    expect(out[1].top).toBeCloseTo(102.9, 5); // 100.5 + 2.4 inset, not trimmed
  });

  it("does not mutate the input array", () => {
    const input = [{ left: 80, top: 100, width: 240, height: 20 }];
    const inputCopy = { ...input[0] };
    fitHighlightRects(input);
    expect(input[0]).toEqual(inputCopy);
  });
});
