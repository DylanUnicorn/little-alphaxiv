import {
  InputRule,
  Node,
  mergeAttributes,
  type Editor,
  type InputRuleMatch,
} from "@tiptap/core";
import { ReactNodeViewRenderer } from "@tiptap/react";
import { MathNodeView } from "./MathNode";

export type TypedMathMatch = {
  fromOffset: number;
  latex: string;
  display: boolean;
};

function isEscaped(text: string, index: number): boolean {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === "\\"; cursor -= 1) {
    backslashes += 1;
  }
  return backslashes % 2 === 1;
}

/** Find a just-completed formula at the typing cursor. The function is pure so
 * IME and delimiter edge cases stay testable without a browser selection. */
export function findTypedMath(text: string, isComposing: boolean): TypedMathMatch | null {
  if (isComposing) return null;

  const candidates: Array<{ expression: RegExp; display: boolean }> = [
    { expression: /\$\$([\s\S]+)\$\$$/, display: true },
    { expression: /\\\[([\s\S]+)\\\]$/, display: true },
    { expression: /\$([^$\n]+)\$$/, display: false },
    { expression: /\\\(([^\n]+)\\\)$/, display: false },
  ];

  for (const candidate of candidates) {
    const match = candidate.expression.exec(text);
    if (!match || isEscaped(text, match.index)) continue;
    const latex = match[1].trim();
    if (!latex) continue;
    return { fromOffset: match.index, latex, display: candidate.display };
  }
  return null;
}

function focusAdjacentMath(direction: "left" | "right", editor: Editor): boolean {
  const { $from, empty } = editor.state.selection;
  if (!empty) return false;
  const node = direction === "left" ? $from.nodeBefore : $from.nodeAfter;
  if (node?.type.name !== "math") return false;
  const position = direction === "left" ? $from.pos - node.nodeSize : $from.pos;
  const dom = editor.view.nodeDOM(position);
  const mathfield = dom instanceof HTMLElement
    ? (dom.matches("math-field") ? dom : dom.querySelector("math-field"))
    : null;
  if (!(mathfield instanceof HTMLElement)) return false;
  mathfield.focus();
  const field = mathfield as HTMLElement & { position: number; lastOffset: number };
  field.position = direction === "left" ? field.lastOffset : 0;
  return true;
}

function deleteAdjacentMath(direction: "left" | "right", editor: Editor): boolean {
  const { $from, empty } = editor.state.selection;
  if (!empty) return false;
  const node = direction === "left" ? $from.nodeBefore : $from.nodeAfter;
  if (node?.type.name !== "math") return false;
  const from = direction === "left" ? $from.pos - node.nodeSize : $from.pos;
  editor.commands.deleteRange({ from, to: from + node.nodeSize });
  return true;
}

export const MathNodeExtension = Node.create({
  name: "math",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      latex: {
        default: "",
        parseHTML: (element) => element.getAttribute("data-latex") ?? "",
      },
      display: {
        default: false,
        parseHTML: (element) => element.getAttribute("data-display") === "true",
      },
    };
  },

  parseHTML() {
    return [{ tag: "span[data-composer-math]" }];
  },

  renderHTML({ HTMLAttributes, node }) {
    const latex = String(node.attrs.latex ?? "");
    const display = Boolean(node.attrs.display);
    return [
      "span",
      mergeAttributes(HTMLAttributes, {
        "data-composer-math": "",
        "data-display": String(display),
        "data-latex": latex,
      }),
      display ? `$$${latex}$$` : `$${latex}$`,
    ];
  },

  addNodeView() {
    return ReactNodeViewRenderer(MathNodeView, {
      as: "span",
      stopEvent: ({ event }) => (
        event.target instanceof Element && Boolean(event.target.closest("math-field"))
      ),
    });
  },

  addInputRules() {
    return [
      new InputRule({
        find: (text): InputRuleMatch | null => {
          const match = findTypedMath(text, this.editor.view.composing);
          if (!match) return null;
          return {
            index: match.fromOffset,
            text: text.slice(match.fromOffset),
            data: match,
          };
        },
        handler: ({ range, match, commands }) => {
          const data = match.data as TypedMathMatch | undefined;
          if (!data) return null;
          commands.insertContentAt(range, {
            type: this.name,
            attrs: { latex: data.latex, display: data.display },
          });
          return null;
        },
      }),
    ];
  },

  addKeyboardShortcuts() {
    return {
      ArrowLeft: () => focusAdjacentMath("left", this.editor),
      ArrowRight: () => focusAdjacentMath("right", this.editor),
      Backspace: () => deleteAdjacentMath("left", this.editor),
      Delete: () => deleteAdjacentMath("right", this.editor),
    };
  },
});
