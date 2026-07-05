import { describe, expect, it } from "vitest";
import { normalizeLatexMathDelimiters } from "./mathMarkdown";

describe("normalizeLatexMathDelimiters", () => {
  it("converts display delimiters used by LLM LaTeX output", () => {
    expect(normalizeLatexMathDelimiters("\\[\nt_{\\text{pad}} \\in \\mathbb{R}^C\n\\]"))
      .toBe("$$\nt_{\\text{pad}} \\in \\mathbb{R}^C\n$$");
  });

  it("converts inline delimiters", () => {
    expect(normalizeLatexMathDelimiters("where \\(x_i^2\\) is visible"))
      .toBe("where $x_i^2$ is visible");
  });

  it("does not rewrite delimiters inside code", () => {
    const source = "```tex\n\\[x\\]\n```\n\nUse \\(x\\).";
    expect(normalizeLatexMathDelimiters(source))
      .toBe("```tex\n\\[x\\]\n```\n\nUse $x$.");
  });
});
