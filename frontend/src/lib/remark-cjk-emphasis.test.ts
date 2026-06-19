// Regression tests for the rehype CJK-emphasis post-pass.
//
// These render markdown through the EXACT production plugin chain used by
// components/Markdown.tsx (remark-gfm + remark-math, then rehype-katex +
// rehypeCjkEmphasis) via react-dom/server, and assert on the resulting HTML.
//
// Why a runtime test (not typecheck): a unified rehype plugin must be shaped as
// (options) => transformer. If it is accidentally written as
// () => (tree) => {...} (one `() =>` too many), the "transformer" returns the
// inner function instead of mutating/returning the tree, unified then replaces
// the whole tree with that function, and react-markdown renders NOTHING. The
// TypeScript types do NOT catch this (a `() => Transformer` is assignable to
// `Transformer` because fewer parameters are allowed), so only a runtime render
// can. That shape bug previously blanked all assistant markdown — including the
// `---` horizontal rule — so the gradient divider "disappeared".
import { describe, it, expect } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import { rehypeCjkEmphasis } from "./remark-cjk-emphasis";

/** Render markdown through the production plugin chain → static HTML. */
function render(md: string): string {
  return renderToStaticMarkup(
    React.createElement(ReactMarkdown, {
      remarkPlugins: [remarkGfm, remarkMath],
      rehypePlugins: [rehypeKatex, rehypeCjkEmphasis],
      children: md,
    })
  );
}

describe("rehypeCjkEmphasis (production plugin chain)", () => {
  it("renders markdown `---` as <hr> (plugin must not blank the tree)", () => {
    const html = render("before\n\n---\n\nafter");
    expect(html).toContain("<hr");
    expect(html).toContain("before");
    expect(html).toContain("after");
  });

  it("renders a list, `---`, then a code block (mock-LLM payload shape)", () => {
    const html = render("1. a\n2. b\n3. c\n\n---\n\n```python\nx = 1\n```");
    expect(html).toContain("<ol");
    expect(html).toContain("<hr");
    expect(html).toContain("<pre");
  });

  it("converts **bold** in the CJK/paren flanking edge case", () => {
    const html = render("(中文)**bold**中文 rest");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).not.toContain("**");
  });

  it("renders plain text and basic bold (plugin must not drop all content)", () => {
    const html = render("normal **bold** text");
    expect(html).toContain("normal");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("text");
  });
});
