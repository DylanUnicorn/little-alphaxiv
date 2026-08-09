import { act, create } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import { InlineUserMessageEditor, shouldCancelInlineEdit } from "./InlineUserMessageEditor";

describe("InlineUserMessageEditor", () => {
  it("cancels only for an outside target when not submitting", () => {
    const insideTarget = {} as EventTarget;
    const outsideTarget = {} as EventTarget;
    const container = {
      contains: (target: Node | null) => target === insideTarget,
    };

    expect(shouldCancelInlineEdit(container, insideTarget, false)).toBe(false);
    expect(shouldCancelInlineEdit(container, outsideTarget, false)).toBe(true);
    expect(shouldCancelInlineEdit(container, null, false)).toBe(true);
    expect(shouldCancelInlineEdit(container, outsideTarget, true)).toBe(false);
  });

  it("keeps plain Enter for newlines and uses Ctrl/Cmd+Enter to resend", async () => {
    const onSubmit = vi.fn(async () => undefined);
    const tree = create(
      <InlineUserMessageEditor
        initialText="line one"
        initialAttachments={[]}
        submitting={false}
        onCancel={vi.fn()}
        onSubmit={onSubmit}
      />,
    );
    const textarea = tree.root.findByType("textarea");
    const preventDefault = vi.fn();

    act(() => textarea.props.onKeyDown({
      key: "Enter", ctrlKey: false, metaKey: false, nativeEvent: { isComposing: false }, preventDefault,
    }));
    expect(preventDefault).not.toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();

    await act(async () => textarea.props.onKeyDown({
      key: "Enter", ctrlKey: true, metaKey: false, nativeEvent: { isComposing: false }, preventDefault,
    }));
    expect(preventDefault).toHaveBeenCalled();
    expect(onSubmit).toHaveBeenCalledWith({ text: "line one", attachments: [] });
  });

  it("cancels on Escape and prevents empty resends", () => {
    const onCancel = vi.fn();
    const onSubmit = vi.fn();
    const tree = create(
      <InlineUserMessageEditor
        initialText=""
        initialAttachments={[]}
        submitting={false}
        onCancel={onCancel}
        onSubmit={onSubmit}
      />,
    );
    const textarea = tree.root.findByType("textarea");
    const preventDefault = vi.fn();

    act(() => textarea.props.onKeyDown({ key: "Escape", preventDefault }));

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(tree.root.findByProps({ children: "Resend" }).props.disabled).toBe(true);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("can remove an existing attachment without mutating the input array", () => {
    const attachments = [{ type: "image" as const, data_url: "data:image/png;base64,abc", name: "plot.png" }];
    const tree = create(
      <InlineUserMessageEditor
        initialText="question"
        initialAttachments={attachments}
        submitting={false}
        onCancel={vi.fn()}
        onSubmit={vi.fn()}
      />,
    );

    act(() => tree.root.findByProps({ "aria-label": "Remove attachment" }).props.onClick());

    expect(tree.root.findAllByProps({ alt: "plot.png" })).toHaveLength(0);
    expect(attachments).toHaveLength(1);
  });
});
