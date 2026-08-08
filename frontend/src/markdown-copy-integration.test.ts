// @vitest-environment jsdom
// @ts-expect-error Frontend sources intentionally omit Node typings; Vitest runs in Node.
import { readFileSync } from "node:fs";
import katex from "katex";
import "katex/contrib/copy-tex";
import { afterEach, describe, expect, it, vi } from "vitest";

const entrypoint = readFileSync("src/main.tsx", "utf8");

describe("KaTeX clipboard integration", () => {
  it("loads the official copy-tex extension after KaTeX styles", () => {
    const styles = entrypoint.indexOf('import "katex/dist/katex.min.css";');
    const copyTex = entrypoint.indexOf('import "katex/contrib/copy-tex";');

    expect(styles).toBeGreaterThanOrEqual(0);
    expect(copyTex).toBeGreaterThan(styles);
  });

  afterEach(() => {
    window.getSelection()?.removeAllRanges();
    document.body.replaceChildren();
  });

  it("copies a selection inside rendered math as TeX without duplicate DOM text", () => {
    document.body.innerHTML = katex.renderToString("q^T k / \\sqrt{d}");
    const visibleMath = document.querySelector<HTMLElement>(".katex-html");
    const selectedText = firstTextNode(visibleMath);
    expect(selectedText).not.toBeNull();

    const range = document.createRange();
    range.selectNodeContents(selectedText!);
    window.getSelection()!.addRange(range);

    const copied = new Map<string, string>();
    const setData = vi.fn((type: string, value: string) => copied.set(type, value));
    const event = copyEvent(setData);
    document.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(copied.get("text/plain")).toBe("$q^T k / \\sqrt{d}$");
    expect(copied.get("text/plain")).not.toContain("qTk/dq^T");
    expect(copied.get("text/html")).toContain("katex");
  });

  it("leaves ordinary prose copying to the browser", () => {
    document.body.textContent = "ordinary prose";
    const range = document.createRange();
    range.selectNodeContents(document.body);
    window.getSelection()!.addRange(range);

    const setData = vi.fn();
    const event = copyEvent(setData);
    document.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(setData).not.toHaveBeenCalled();
  });
});

function copyEvent(setData: (type: string, value: string) => void): ClipboardEvent {
  const event = new Event("copy", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", { value: { setData } });
  return event as ClipboardEvent;
}

function firstTextNode(root: Node | null): Text | null {
  if (!root) return null;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  return walker.nextNode() as Text | null;
}
