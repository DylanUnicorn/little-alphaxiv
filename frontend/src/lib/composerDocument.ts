import type { JSONContent } from "@tiptap/core";

const CODE_SPAN_OR_BLOCK_RE = /(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`)/g;

type MathDelimiter = {
  open: string;
  close: string;
  display: boolean;
  multiline: boolean;
};

const MATH_DELIMITERS: MathDelimiter[] = [
  { open: "$$", close: "$$", display: true, multiline: true },
  { open: "\\[", close: "\\]", display: true, multiline: true },
  { open: "\\(", close: "\\)", display: false, multiline: false },
  { open: "$", close: "$", display: false, multiline: false },
];

function isEscaped(text: string, index: number): boolean {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === "\\"; cursor -= 1) {
    backslashes += 1;
  }
  return backslashes % 2 === 1;
}

function findClosingDelimiter(
  text: string,
  start: number,
  delimiter: MathDelimiter,
): number {
  for (let index = start; index < text.length; index += 1) {
    if (!delimiter.multiline && text[index] === "\n") return -1;
    if (!text.startsWith(delimiter.close, index) || isEscaped(text, index)) continue;
    if (delimiter.close === "$" && text[index + 1] === "$") {
      index += 1;
      continue;
    }
    return index;
  }
  return -1;
}

function appendText(content: JSONContent[], text: string): void {
  if (!text) return;
  const lines = text.split("\n");
  lines.forEach((line, index) => {
    if (line) {
      const previous = content.at(-1);
      if (previous?.type === "text") previous.text = `${previous.text ?? ""}${line}`;
      else content.push({ type: "text", text: line });
    }
    if (index < lines.length - 1) content.push({ type: "hardBreak" });
  });
}

function appendParsedText(content: JSONContent[], text: string): void {
  let plainStart = 0;
  let index = 0;

  while (index < text.length) {
    const delimiter = MATH_DELIMITERS.find(({ open }) => (
      text.startsWith(open, index) && !isEscaped(text, index)
    ));
    if (!delimiter) {
      index += 1;
      continue;
    }

    // Do not interpret the second dollar in an unescaped display opener as an
    // inline formula opener.
    if (
      delimiter.open === "$" &&
      index > 0 &&
      text[index - 1] === "$" &&
      !isEscaped(text, index - 1)
    ) {
      index += 1;
      continue;
    }

    const contentStart = index + delimiter.open.length;
    const close = findClosingDelimiter(text, contentStart, delimiter);
    if (close < 0) {
      index += delimiter.open.length;
      continue;
    }

    const latex = text.slice(contentStart, close).trim();
    if (!latex) {
      index = close + delimiter.close.length;
      continue;
    }

    appendText(content, text.slice(plainStart, index));
    content.push({ type: "math", attrs: { latex, display: delimiter.display } });
    index = close + delimiter.close.length;
    plainStart = index;
  }

  appendText(content, text.slice(plainStart));
}

/** Convert the string message contract into the deliberately small composer
 * document. Ordinary Markdown remains literal text; only complete math outside
 * inline/fenced code becomes a structured node. */
export function markdownToComposerDocument(markdown: string): JSONContent {
  const content: JSONContent[] = [];
  markdown.split(CODE_SPAN_OR_BLOCK_RE).forEach((part, index) => {
    if (index % 2 === 1) appendText(content, part);
    else appendParsedText(content, part);
  });

  return {
    type: "doc",
    content: [{ type: "paragraph", ...(content.length > 0 ? { content } : {}) }],
  };
}

function serializeNode(node: JSONContent): string {
  if (node.type === "text") return node.text ?? "";
  if (node.type === "hardBreak") return "\n";
  if (node.type === "math") {
    const latex = String(node.attrs?.latex ?? "");
    return node.attrs?.display ? `$$\n${latex.trim()}\n$$` : `$${latex}$`;
  }
  return (node.content ?? []).map(serializeNode).join("");
}

/** Serialize the composer document back to the unchanged string message
 * contract consumed by stores, persistence, title generation, and the LLM. */
export function composerDocumentToMarkdown(document: JSONContent): string {
  return (document.content ?? []).map(serializeNode).join("\n");
}

/** Parse clipboard text into content that can be inserted at a Tiptap cursor. */
export function composerDocumentToInlineContent(markdown: string): JSONContent[] {
  return markdownToComposerDocument(markdown).content?.[0].content ?? [];
}
