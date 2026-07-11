import { describe, expect, it } from "vitest";
import { buildSelectedTextPrompt, findSelectedPdfPage, normalizeSelectedText, selectedPdfTextPayload } from "./selectedTextAskAi";

describe("selected PDF text prompts", () => {
  it("normalizes a PDF excerpt and limits its length", () => {
    expect(normalizeSelectedText("  A\n\n  B\tC  ", 100)).toBe("A B C");
    expect(normalizeSelectedText("abcdefgh", 5)).toBe("abcde…");
  });

  it("builds a page-grounded question with a quoted excerpt", () => {
    expect(buildSelectedTextPrompt("a useful result", 4)).toBe(
      "Please explain this excerpt from page 4 of the paper:\n\n> a useful result"
    );
  });

  it("accepts text inside a numbered PDF page and rejects other elements", () => {
    expect(findSelectedPdfPage({ closest: () => ({ dataset: { pageNumber: "7" } }) } as unknown as Element)).toBe(7);
    expect(findSelectedPdfPage({ closest: () => null } as unknown as Element)).toBeNull();
  });

  it("keeps only a non-empty selection from one PDF page", () => {
    expect(selectedPdfTextPayload("  useful\ntext ", 3, 3)).toEqual({ text: "useful text", pageNumber: 3 });
    expect(selectedPdfTextPayload("useful text", 3, 4)).toBeNull();
    expect(selectedPdfTextPayload("   ", 3, 3)).toBeNull();
  });
});
