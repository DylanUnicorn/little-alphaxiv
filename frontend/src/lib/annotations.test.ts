import { describe, it, expect } from "vitest";
import {
  PALETTE, normalizePoint, denormalizePoint,
  normalizeRect, denormalizeRect, rectsToNorm, fitHighlightRects, newId,
  rectsOverlap, overlappingHighlightIds, deoverlapPixelRects,
  migrateAnnotation,
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
    // height 20, TOP_INSET 0.18 -> topCut 3.6, BOTTOM_INSET 0.10 -> botCut 2.0
    const out = fitHighlightRects([{ left: 80, top: 100, width: 240, height: 20 }]);
    expect(out).toHaveLength(1);
    expect(out[0].left).toBe(80);
    expect(out[0].width).toBe(240);
    expect(out[0].top).toBeCloseTo(103.6, 5);   // 100 + 3.6
    expect(out[0].height).toBeCloseTo(14.4, 5); // 20 - 3.6 - 2.0
  });

  it("aggressive insets eliminate overlap without needing trim step", () => {
    // Two 20px-tall lines whose raw tops are only 15px apart (overlap by 5px).
    // With TOP_INSET=0.18 / BOTTOM_INSET=0.10:
    //   upper: top=103.6, h=14.4 → bottom=118.0
    //   lower: top=118.6, h=14.4 → bottom=133.0
    // Lower inset top (118.6) is already BELOW upper bottom (118.0) — no trim.
    const out = fitHighlightRects([
      { left: 80, top: 100, width: 240, height: 20 },
      { left: 80, top: 115, width: 240, height: 20 },
    ]);
    expect(out).toHaveLength(2);
    const upperBottom = out[0].top + out[0].height;
    expect(out[1].top).toBeGreaterThanOrEqual(upperBottom);
    // Both rects keep their full inset dimensions (no trim fired)
    expect(out[1].top + out[1].height).toBeCloseTo(133.0, 5);
  });

  it("leaves non-overlapping rects alone (beyond the inset)", () => {
    const out = fitHighlightRects([
      { left: 80, top: 100, width: 240, height: 20 },
      { left: 80, top: 200, width: 240, height: 20 },
    ]);
    expect(out[1].top).toBeCloseTo(203.6, 5); // only the 18% inset, no trim
  });

  it("does not trim same-line rects (near-equal tops)", () => {
    const out = fitHighlightRects([
      { left: 80, top: 100, width: 100, height: 20 },
      { left: 200, top: 100.5, width: 100, height: 20 },
    ]);
    expect(out[0].top).toBeCloseTo(103.6, 5);  // 100 + 3.6
    expect(out[1].top).toBeCloseTo(104.1, 5); // 100.5 + 3.6, not trimmed
  });

  it("does not mutate the input array", () => {
    const input = [{ left: 80, top: 100, width: 240, height: 20 }];
    const inputCopy = { ...input[0] };
    fitHighlightRects(input);
    expect(input[0]).toEqual(inputCopy);
  });
});

describe("deoverlapPixelRects", () => {
  it("returns input as-is for 0 or 1 rect", () => {
    expect(deoverlapPixelRects([])).toEqual([]);
    const single = [{ x: 10, y: 20, w: 100, h: 15 }];
    expect(deoverlapPixelRects(single)).toEqual(single);
  });

  it("pushes overlapping lower rect down to upper rect's bottom", () => {
    // Two lines where lower overlaps upper by 8px
    const out = deoverlapPixelRects([
      { x: 80, y: 100, w: 240, h: 18 },  // bottom = 118
      { x: 80, y: 110, w: 240, h: 18 },  // top 110 < 118 → overlap
    ]);
    expect(out[1].y).toBe(118); // pushed to upper's bottom
    expect(out[1].h).toBe(10);  // 128 - 118, original bottom preserved
  });

  it("preserves non-overlapping rects unchanged", () => {
    const out = deoverlapPixelRects([
      { x: 80, y: 100, w: 240, h: 18 },
      { x: 80, y: 200, w: 240, h: 18 }, // far below, no overlap
    ]);
    expect(out[1].y).toBe(200);
    expect(out[1].h).toBe(18);
  });

  it("leaves same-line rects (tops within 4px) untouched even if they overlap vertically", () => {
    const out = deoverlapPixelRects([
      { x: 80, y: 100, w: 100, h: 18 },
      { x: 200, y: 102, w: 100, h: 18 }, // top within 4px of prev → same line
    ]);
    expect(out[0]).toEqual({ x: 80, y: 100, w: 100, h: 18 });
    expect(out[1]).toEqual({ x: 200, y: 102, w: 100, h: 18 });
  });

  it("handles three-line cascade (middle pushes bottom, which also needed push)", () => {
    const out = deoverlapPixelRects([
      { x: 80, y: 100, w: 240, h: 18 },  // bottom = 118
      { x: 80, y: 110, w: 240, h: 18 },  // pushed to y=118, h=10, bottom=128
      { x: 80, y: 125, w: 240, h: 18 },  // 125 > 118+4=122 → distinct; 125 < 128 → push
    ]);
    expect(out[1].y).toBe(118);
    expect(out[2].y).toBe(128);
    for (let i = 1; i < out.length; i++) {
      expect(out[i].y).toBeGreaterThanOrEqual(out[i - 1].y + out[i - 1].h);
    }
  });

  it("does not mutate input array", () => {
    const input = [
      { x: 80, y: 100, w: 240, h: 18 },
      { x: 80, y: 110, w: 240, h: 18 },
    ];
    const inputCopy = input.map((r) => ({ ...r }));
    deoverlapPixelRects(input);
    expect(input).toEqual(inputCopy);
  });

  it("handles degenerate case where overlap consumes entire rect (gives 1px height)", () => {
    const out = deoverlapPixelRects([
      { x: 80, y: 100, w: 240, h: 50 },  // bottom = 150
      { x: 80, y: 110, w: 240, h: 5 },   // entirely inside upper
    ]);
    expect(out[1].y).toBe(150); // pushed to upper bottom
    expect(out[1].h).toBe(1);    // degenerate
  });
});

describe("migrateAnnotation", () => {
  it("passes non-draw annotations through unchanged", () => {
    const rect = { id: "a1", arxiv_id: "x", page: 1, type: "rect", color: "#FFEB3B", createdAt: 1, rect: { x: 0, y: 0, w: 0.1, h: 0.1 } };
    expect(migrateAnnotation(rect as never)).toEqual(rect);
  });

  it("converts legacy single-stroke draw.points to draw.strokes", () => {
    const legacy = {
      id: "a2", arxiv_id: "x", page: 1, type: "draw", color: "#F9A8D4", createdAt: 2,
      draw: { points: [{ x: 0.1, y: 0.2 }, { x: 0.3, y: 0.4 }], width: 0.0025 },
    };
    expect(migrateAnnotation(legacy as never).draw).toEqual({
      strokes: [[{ x: 0.1, y: 0.2 }, { x: 0.3, y: 0.4 }]], width: 0.0025,
    });
  });

  it("is idempotent on the new strokes shape", () => {
    const fresh = {
      id: "a3", arxiv_id: "x", page: 1, type: "draw", color: "#F9A8D4", createdAt: 3,
      draw: { strokes: [[{ x: 0.1, y: 0.2 }], [{ x: 0.5, y: 0.6 }]], width: 0.0025 },
    };
    expect(migrateAnnotation(fresh as never)).toEqual(fresh);
  });

  it("leaves a draw with neither field unchanged (defensive)", () => {
    const bare = { id: "a4", arxiv_id: "x", page: 1, type: "draw", color: "#F9A8D4", createdAt: 4, draw: { width: 0.0025 } };
    expect(migrateAnnotation(bare as never)).toEqual(bare);
  });
});
