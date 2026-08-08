// @vitest-environment jsdom
import { generateHTML } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { describe, expect, it } from "vitest";
import { findTypedMath, MathNodeExtension } from "./mathNodeExtension";

describe("editable math node extension", () => {
  it("renders an inline formula with readable LaTeX fallback metadata", () => {
    const html = generateHTML(
      {
        type: "doc",
        content: [{
          type: "paragraph",
          content: [{ type: "math", attrs: { latex: "x^2", display: false } }],
        }],
      },
      [StarterKit, MathNodeExtension],
    );

    expect(html).toContain("data-composer-math");
    expect(html).toContain('data-display="false"');
    expect(html).toContain('data-latex="x^2"');
    expect(html).toContain("$x^2$");
  });

  it("marks display formulas independently from inline formulas", () => {
    const html = generateHTML(
      {
        type: "doc",
        content: [{
          type: "paragraph",
          content: [{ type: "math", attrs: { latex: "\\frac{a}{b}", display: true } }],
        }],
      },
      [StarterKit, MathNodeExtension],
    );

    expect(html).toContain('data-display="true"');
    expect(html).toContain("$$\\frac{a}{b}$$");
  });

  it("recognizes a complete formula only at the typing cursor", () => {
    expect(findTypedMath("问 $x^2$", false)).toEqual({
      fromOffset: 2,
      latex: "x^2",
      display: false,
    });
    expect(findTypedMath("$$\\sqrt{x}$$", false)).toEqual({
      fromOffset: 0,
      latex: "\\sqrt{x}",
      display: true,
    });
    expect(findTypedMath("$unfinished", false)).toBeNull();
    expect(findTypedMath("\\$5", false)).toBeNull();
  });

  it("does not transform delimiters while IME composition is active", () => {
    expect(findTypedMath("中文 $x$", true)).toBeNull();
  });
});
