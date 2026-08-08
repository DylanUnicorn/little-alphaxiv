import { describe, expect, it } from "vitest";
import {
  markdownToComposerDocument,
  composerDocumentToMarkdown,
  composerDocumentToInlineContent,
} from "./composerDocument";

describe("composer document codec", () => {
  it("keeps ordinary Markdown and exact newlines as plain editable content", () => {
    const source = "第一行 **粗体**\n\n- 第三行";
    const document = markdownToComposerDocument(source);

    expect(document.content?.[0].content).toEqual([
      { type: "text", text: "第一行 **粗体**" },
      { type: "hardBreak" },
      { type: "hardBreak" },
      { type: "text", text: "- 第三行" },
    ]);
    expect(composerDocumentToMarkdown(document)).toBe(source);
  });

  it("turns inline and display delimiters into editable math nodes", () => {
    const source = "注意 $x^2 + y^2$。\n$$\n\\frac{a}{\\sqrt b}\n$$";
    const document = markdownToComposerDocument(source);

    expect(document.content?.[0].content).toEqual([
      { type: "text", text: "注意 " },
      { type: "math", attrs: { latex: "x^2 + y^2", display: false } },
      { type: "text", text: "。" },
      { type: "hardBreak" },
      { type: "math", attrs: { latex: "\\frac{a}{\\sqrt b}", display: true } },
    ]);
    expect(composerDocumentToMarkdown(document)).toBe(source);
  });

  it("accepts alternate LaTeX delimiters and serializes canonical Markdown", () => {
    const source = "inline \\(a_1\\)\n\\[\\sum_i x_i\\]";
    expect(composerDocumentToMarkdown(markdownToComposerDocument(source))).toBe(
      "inline $a_1$\n$$\n\\sum_i x_i\n$$",
    );
  });

  it("does not convert escaped dollars, incomplete expressions, or code", () => {
    const source = "price \\$5 and $unfinished\n`$code$`\n```tex\n$$block$$\n```";
    const document = markdownToComposerDocument(source);

    expect(document.content?.[0].content?.some((node) => node.type === "math")).toBe(false);
    expect(composerDocumentToMarkdown(document)).toBe(source);
  });

  it("handles loose multiline display math without leaking its line breaks", () => {
    const source = "那么：$$\\frac{q^\\top k}{\\sqrt d}\n= \\sqrt d \\cos\\theta.$$结束";
    const document = markdownToComposerDocument(source);
    const math = document.content?.[0].content?.find((node) => node.type === "math");

    expect(math).toEqual({
      type: "math",
      attrs: { latex: "\\frac{q^\\top k}{\\sqrt d}\n= \\sqrt d \\cos\\theta.", display: true },
    });
    expect(composerDocumentToMarkdown(document)).toBe(
      "那么：$$\n\\frac{q^\\top k}{\\sqrt d}\n= \\sqrt d \\cos\\theta.\n$$结束",
    );
  });

  it("returns insertable inline content for mixed clipboard text", () => {
    expect(composerDocumentToInlineContent("A $x$\nB")).toEqual([
      { type: "text", text: "A " },
      { type: "math", attrs: { latex: "x", display: false } },
      { type: "hardBreak" },
      { type: "text", text: "B" },
    ]);
  });

  it("always emits a valid empty paragraph", () => {
    const document = markdownToComposerDocument("");
    expect(document).toEqual({ type: "doc", content: [{ type: "paragraph" }] });
    expect(composerDocumentToMarkdown(document)).toBe("");
  });
});
