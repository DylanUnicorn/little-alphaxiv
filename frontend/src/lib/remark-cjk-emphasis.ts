/**
 * remark-cjk-emphasis — workaround for micromark's CJK emphasis parsing edge case.
 *
 * Problem: micromark (remark-parse) fails to parse **bold** when:
 *   1. Bold content contains parentheses () or （)
 *   2. The closing ** is immediately followed by a CJK character (no space)
 *
 * Root cause: CommonMark delimiter flanking rules. The closing ** is preceded
 * by punctuation (the )/）) and followed by non-whitespace/non-punctuation (a
 * CJK character), making it "not right-flanking". Micromark rejects it as an
 * emphasis closer, leaving raw **text** in the output.
 *
 * Fix: a rehype plugin that walks the hast (HTML) tree after parsing, finds
 * text nodes still containing literal **…** patterns, and splits them into
 * proper <strong> elements. This runs after mdast→hast conversion so it
 * works on the final HTML AST without needing raw HTML injection.
 *
 * Only handles `**...**` (strong). Does NOT touch `*...*` (emphasis) since that
 * edge case hasn't been observed in practice.
 */

import type { Plugin } from "unified";
import type { Node } from "unist";

/** Match **content** where inner content has no unpaired asterisks. */
const STRONG_RE = /\*\*([^*]+?)\*\*/g;

/**
 * Rehype plugin: fix unparsed **bold** in text nodes of the hast tree.
 *
 * This is a rehype (not remark) plugin — it runs on the HTML AST after
 * markdown→HTML conversion, so it can directly produce <strong> elements.
 *
 * Shape: a standard unified plugin is `(options) => transformer`. The binding
 * itself is the plugin, so `rehypePlugins: [rehypeCjkEmphasis]` has unified
 * call `rehypeCjkEmphasis()` to obtain the transformer `(tree) => void`. An
 * earlier version wrapped this as `function rehypeCjkEmphasis(): Plugin {
 * return () => (tree) => … }` — a factory returning a plugin — which added an
 * extra call layer: unified's "transformer" returned the inner function
 * instead of mutating the tree, so unified replaced the whole tree with that
 * function and react-markdown rendered nothing (blanking ALL assistant
 * markdown, including the `---` horizontal rule). TypeScript did not catch it
 * (a `() => Transformer` is assignable to `Transformer`), so the regression is
 * pinned by a runtime render test — see remark-cjk-emphasis.test.ts.
 */
export const rehypeCjkEmphasis: Plugin = () => (tree: Node) => {
  if (!tree) return;
  walk(tree as unknown as Record<string, unknown>);

  function walk(node: Record<string, unknown>): void {
    if (!node || typeof node !== "object") return;

    // hast text node: { type: 'text', value: string }
    if (
      node.type === "text" &&
      typeof node.value === "string" &&
      node.value.includes("**")
    ) {
      const text = node.value as string;
      const children: Array<Record<string, unknown>> = [];
      let lastEnd = 0;
      let match: RegExpExecArray | null;
      STRONG_RE.lastIndex = 0;

      while ((match = STRONG_RE.exec(text)) !== null) {
        // Literal text before this bold match
        if (match.index > lastEnd) {
          children.push({ type: "text", value: text.slice(lastEnd, match.index) });
        }
        // <strong> element
        children.push({
          type: "element",
          tagName: "strong",
          properties: {},
          children: [{ type: "text", value: match[1] }],
        });
        lastEnd = match.index + match[0].length;
      }

      // Trailing literal text after last match
      if (lastEnd < text.length) {
        children.push({ type: "text", value: text.slice(lastEnd) });
      }

      // If we found and converted at least one **...** pattern,
      // replace this text node in its parent's children array.
      if (children.length > 1) {
        const parent = node.parent as Record<string, unknown> | undefined;
        if (parent && Array.isArray(parent.children)) {
          const idx = parent.children.indexOf(node);
          if (idx >= 0) {
            parent.children.splice(idx, 1, ...children);
          }
        }
      }
    }

    // Recurse into element children
    const childs = node.children;
    if (Array.isArray(childs)) {
      for (const child of childs) {
        (child as Record<string, unknown>).parent = node;
        walk(child as Record<string, unknown>);
      }
    }
  }
};
