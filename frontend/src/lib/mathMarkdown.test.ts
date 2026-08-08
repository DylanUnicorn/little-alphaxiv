import { describe, expect, it } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkMath from "remark-math";
import { hasRenderableMath, normalizeLatexMathDelimiters } from "./mathMarkdown";

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

  it("canonicalizes pasted multiline display math with loose dollar delimiters", () => {
    const source = "那么：\n$$\\frac{q^\\top k}{\\sqrt d}\n= \\sqrt d\\cos\\theta.$$";
    const normalized = normalizeLatexMathDelimiters(source);

    expect(normalized).toBe(
      "那么：\n$$\n\\frac{q^\\top k}{\\sqrt d}\n= \\sqrt d\\cos\\theta.\n$$",
    );
    const html = renderToStaticMarkup(
      React.createElement(ReactMarkdown, {
        remarkPlugins: [remarkMath],
        rehypePlugins: [rehypeKatex],
        children: normalized,
      }),
    );
    expect(html).toContain("katex-display");
  });

  it("separates display delimiters from prose on both sides", () => {
    const source = "粘贴测试：$$\n\\frac{q^\\top k}{\\sqrt d}\n$$结束";
    const normalized = normalizeLatexMathDelimiters(source);

    expect(normalized).toBe(
      "粘贴测试：\n$$\n\\frac{q^\\top k}{\\sqrt d}\n$$\n结束",
    );
    const html = renderToStaticMarkup(
      React.createElement(ReactMarkdown, {
        remarkPlugins: [remarkMath],
        rehypePlugins: [rehypeKatex],
        children: normalized,
      }),
    );
    expect(html).toContain("katex-display");
    expect(html).toContain("粘贴测试：");
    expect(html).toContain("结束");
  });
});

describe("hasRenderableMath", () => {
  it.each([
    "where $x_i^2$ is visible",
    "$$\\frac{q^T k}{\\sqrt d}$$",
    "$$\\frac{q^T k}{\\sqrt d}\n= \\cos \\theta.$$",
    "use \\(x_i^2\\) here",
    "\\[\\frac{q^T k}{\\sqrt d}\\]",
  ])("detects closed math in %j", (source) => {
    expect(hasRenderableMath(source)).toBe(true);
  });

  it.each([
    "ordinary prose costs $5",
    "unfinished $x_i",
    "escaped \\$x_i$ text",
    "`$x_i$`",
    "```tex\n$$x_i$$\n```",
  ])("ignores non-renderable math in %j", (source) => {
    expect(hasRenderableMath(source)).toBe(false);
  });
});
