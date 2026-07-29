import { describe, expect, it } from "vitest";
import { shouldKeepPdfPointerInteraction } from "./pdfPointerInteraction";

function targetInside(classSelector: string): Element {
  return {
    tagName: "BUTTON",
    isContentEditable: false,
    closest: (selector: string) => selector.includes(classSelector) ? {} : null,
  } as unknown as Element;
}

describe("zoomed PDF pointer interactions", () => {
  it("keeps PDF text selection and annotation gestures", () => {
    expect(shouldKeepPdfPointerInteraction(targetInside(".pdf-textlayer span"))).toBe(true);
    expect(shouldKeepPdfPointerInteraction(targetInside(".annot-text"))).toBe(true);
  });

  it("keeps the floating Ask AI button clickable", () => {
    expect(shouldKeepPdfPointerInteraction(targetInside(".selected-text-ask-ai"))).toBe(true);
  });

  it("leaves blank PDF content available for panning", () => {
    expect(shouldKeepPdfPointerInteraction(targetInside(".pdf-page-canvas-wrap"))).toBe(false);
  });
});
