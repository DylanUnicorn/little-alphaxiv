import { useEffect, useRef } from "react";
import { NodeViewWrapper, type NodeViewProps } from "@tiptap/react";
import { MathfieldElement } from "mathlive";
import "mathlive/fonts.css";

function moveEditorCaret(props: NodeViewProps, side: "before" | "after"): void {
  const position = props.getPos();
  if (typeof position !== "number") return;
  const target = side === "before" ? position : position + props.node.nodeSize;
  props.editor.chain().focus().setTextSelection(target).run();
}

export function MathNodeView(props: NodeViewProps) {
  const mathfieldRef = useRef<MathfieldElement | null>(null);
  const latex = String(props.node.attrs.latex ?? "");
  const display = Boolean(props.node.attrs.display);

  useEffect(() => {
    const mathfield = mathfieldRef.current;
    if (!mathfield) return;

    mathfield.mathVirtualKeyboardPolicy = "manual";
    mathfield.smartFence = true;
    mathfield.readOnly = !props.editor.isEditable;
    if (mathfield.getValue("latex") !== latex) {
      mathfield.setValue(latex, { silenceNotifications: true });
    }

    const handleInput = () => {
      props.updateAttributes({ latex: mathfield.getValue("latex") });
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        moveEditorCaret(props, "after");
        return;
      }
      if (event.key === "ArrowLeft" && mathfield.position === 0) {
        event.preventDefault();
        moveEditorCaret(props, "before");
        return;
      }
      if (event.key === "ArrowRight" && mathfield.position === mathfield.lastOffset) {
        event.preventDefault();
        moveEditorCaret(props, "after");
      }
    };

    mathfield.addEventListener("input", handleInput);
    mathfield.addEventListener("keydown", handleKeyDown);
    return () => {
      mathfield.removeEventListener("input", handleInput);
      mathfield.removeEventListener("keydown", handleKeyDown);
    };
  }, [latex, props]);

  return (
    <NodeViewWrapper
      as="span"
      className={`composer-math-node${display ? " is-display" : " is-inline"}`}
      data-display={String(display)}
      contentEditable={false}
    >
      {/** React 18 accepts standards-based custom elements through the string
       * overload. MathLive upgrades this element and uses its initial text as
       * a readable fallback before the upgrade completes. */}
      {MathfieldElement && (
        <math-field
          ref={(element) => {
            mathfieldRef.current = element;
          }}
          aria-label={display ? "Editable display formula" : "Editable inline formula"}
          class="composer-math-field"
        >
          {latex}
        </math-field>
      )}
    </NodeViewWrapper>
  );
}
