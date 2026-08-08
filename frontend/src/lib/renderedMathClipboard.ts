type ClipboardTextWriter = Pick<DataTransfer, "setData">;

type RecoverableMath = {
  root: Element;
  latex: string;
  display: boolean;
};

function recoverMath(root: Element): RecoverableMath | null {
  const annotation = root.querySelector(
    'annotation[encoding="application/x-tex"]',
  );
  const latex = annotation?.textContent?.trim() ?? "";
  if (!latex) return null;

  const math = root.querySelector("math");
  return {
    root,
    latex,
    display: Boolean(root.closest(".katex-display")) || math?.getAttribute("display") === "block",
  };
}

function delimit({ latex, display }: RecoverableMath): string {
  return display ? `\n$$\n${latex}\n$$\n` : `$${latex}$`;
}

function closestMathRoot(node: Node): Element | null {
  const element = node.nodeType === Node.ELEMENT_NODE
    ? node as Element
    : node.parentElement;
  return element?.closest(".katex") ?? null;
}

/**
 * Write a browser selection containing rendered KaTeX as canonical Markdown.
 * Returns false when the browser should keep its normal copy behavior.
 */
export function writeRenderedMathSelection(
  selection: Selection | null,
  clipboard: ClipboardTextWriter | null,
): boolean {
  if (!selection || selection.isCollapsed || selection.rangeCount === 0 || !clipboard) {
    return false;
  }

  // A visible drag can begin inside `.katex-html`, while the original TeX lives
  // in the sibling `.katex-mathml`. Expand only formula-contained boundaries so
  // a partial visual selection still has the complete accessibility annotation.
  const range = selection.getRangeAt(0).cloneRange();
  const startMath = closestMathRoot(range.startContainer);
  const endMath = closestMathRoot(range.endContainer);
  if (startMath) range.setStartBefore(startMath);
  if (endMath) range.setEndAfter(endMath);

  const fragment = range.cloneContents();
  const mathRoots = Array.from(fragment.querySelectorAll(".katex"));
  if (mathRoots.length === 0) return false;

  const recovered = mathRoots.map(recoverMath);
  if (recovered.some((math) => math === null)) return false;

  const htmlContainer = fragment.ownerDocument.createElement("div");
  htmlContainer.append(fragment.cloneNode(true));

  recovered.forEach((math) => {
    math!.root.replaceWith(fragment.ownerDocument.createTextNode(delimit(math!)));
  });

  const markdown = (fragment.textContent ?? "")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!markdown) return false;

  clipboard.setData("text/plain", markdown);
  clipboard.setData("text/html", htmlContainer.innerHTML);
  return true;
}
