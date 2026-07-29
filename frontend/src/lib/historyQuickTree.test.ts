import { describe, expect, it } from "vitest";
import { quickHistoryPopoverMetrics } from "./historyQuickTree";

const viewport = { width: 400, height: 300 };

describe("quickHistoryPopoverMetrics", () => {
  it("keeps a single-node tree compact", () => {
    expect(quickHistoryPopoverMetrics({
      anchor: { left: 260, right: 340, top: 12, bottom: 48 },
      tree: { width: 48, height: 48 },
      viewport,
    })).toEqual({ left: 248, top: 56, width: 92, height: 64 });
  });

  it("caps large trees and keeps them inside the right viewport edge", () => {
    expect(quickHistoryPopoverMetrics({
      anchor: { left: 350, right: 399, top: 12, bottom: 48 },
      tree: { width: 520, height: 420 },
      viewport,
    })).toEqual({ left: 72, top: 56, width: 320, height: 236 });
  });

  it("clamps the popover to the left viewport gutter", () => {
    expect(quickHistoryPopoverMetrics({
      anchor: { left: 8, right: 56, top: 12, bottom: 48 },
      tree: { width: 120, height: 72 },
      viewport,
    })).toEqual({ left: 8, top: 56, width: 136, height: 88 });
  });

  it("shrinks the maximum width on narrow viewports", () => {
    expect(quickHistoryPopoverMetrics({
      anchor: { left: 120, right: 180, top: 12, bottom: 48 },
      tree: { width: 400, height: 80 },
      viewport: { width: 200, height: 300 },
    })).toEqual({ left: 8, top: 56, width: 184, height: 96 });
  });
});
