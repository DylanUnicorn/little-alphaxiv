import { describe, expect, it } from "vitest";
import { buildSelectedTextPrompt, normalizeSelectedText } from "./selectedTextAskAi";

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
});
