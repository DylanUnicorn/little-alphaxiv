// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { composerDocumentToInlineContent } from "./composerDocument";
import { writeRenderedMathSelection } from "./renderedMathClipboard";

function selectContents(element: HTMLElement): Selection {
  const range = document.createRange();
  range.selectNodeContents(element);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  return selection;
}

function katex(latex: string, display = false): string {
  return `${display ? '<span class="katex-display">' : ""}<span class="katex"><span class="katex-mathml"><math${display ? ' display="block"' : ""}><semantics><mrow><mi>x</mi></mrow><annotation encoding="application/x-tex">${latex}</annotation></semantics></math></span><span class="katex-html" aria-hidden="true">duplicated visual glyphs</span></span>${display ? "</span>" : ""}`;
}

describe("rendered math clipboard", () => {
  beforeEach(() => {
    document.body.replaceChildren();
    window.getSelection()?.removeAllRanges();
  });

  it("copies mixed prose and inline KaTeX as canonical Markdown", () => {
    const source = document.createElement("div");
    source.innerHTML = `变化量 ${katex("\\widehat{\\Delta x}")} 先做变换`;
    document.body.append(source);
    const setData = vi.fn();

    const handled = writeRenderedMathSelection(selectContents(source), { setData });

    expect(handled).toBe(true);
    expect(setData).toHaveBeenCalledTimes(2);
    expect(setData).toHaveBeenCalledWith(
      "text/plain",
      expect.stringContaining("变化量 $\\widehat{\\Delta x}$ 先做变换"),
    );
    expect(setData).toHaveBeenCalledWith("text/html", expect.stringContaining('class="katex"'));
    const plainTextCall = setData.mock.calls.find(([type]) => type === "text/plain")!;
    expect(plainTextCall[1]).not.toContain("duplicated visual glyphs");
  });

  it("keeps multiple display equations separated and delimited", () => {
    const source = document.createElement("div");
    source.innerHTML = `<p>作者先做有符号对数变换：</p>
      ${katex("\\widehat{\\Delta x}=\\operatorname{sign}(\\Delta x)\\log(1+|\\Delta x|)", true)}
      ${katex("\\widehat{\\Delta y}=\\operatorname{sign}(\\Delta y)\\log(1+|\\Delta y|)", true)}
      <p>再送入 MLP：</p>`;
    document.body.append(source);
    const setData = vi.fn();

    expect(writeRenderedMathSelection(selectContents(source), { setData })).toBe(true);

    const copied = setData.mock.calls[0][1] as string;
    expect(copied).toContain("$$\n\\widehat{\\Delta x}=\\operatorname{sign}(\\Delta x)\\log(1+|\\Delta x|)\n$$");
    expect(copied).toContain("$$\n\\widehat{\\Delta y}=\\operatorname{sign}(\\Delta y)\\log(1+|\\Delta y|)\n$$");
    expect(copied).toContain("再送入 MLP：");
    expect(composerDocumentToInlineContent(copied).filter((node) => node.type === "math"))
      .toHaveLength(2);
  });

  it("recovers the whole formula when selection starts inside its visual layer", () => {
    const source = document.createElement("div");
    source.innerHTML = katex("\\frac{q^\\top k}{\\sqrt d}", true);
    document.body.append(source);
    const visualLayer = source.querySelector<HTMLElement>(".katex-html")!;
    const setData = vi.fn();

    expect(writeRenderedMathSelection(selectContents(visualLayer), { setData })).toBe(true);
    expect(setData).toHaveBeenCalledWith(
      "text/plain",
      "$$\n\\frac{q^\\top k}{\\sqrt d}\n$$",
    );
  });

  it("leaves ordinary selections to the browser", () => {
    const source = document.createElement("p");
    source.textContent = "plain text";
    document.body.append(source);
    const setData = vi.fn();

    expect(writeRenderedMathSelection(selectContents(source), { setData })).toBe(false);
    expect(setData).not.toHaveBeenCalled();
  });

  it("does not guess when a KaTeX fragment lacks its TeX annotation", () => {
    const source = document.createElement("div");
    source.innerHTML = '<span class="katex"><span class="katex-html">x visual</span></span>';
    document.body.append(source);
    const setData = vi.fn();

    expect(writeRenderedMathSelection(selectContents(source), { setData })).toBe(false);
    expect(setData).not.toHaveBeenCalled();
  });
});
