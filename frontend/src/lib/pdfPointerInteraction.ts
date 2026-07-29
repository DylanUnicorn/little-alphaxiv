export function shouldKeepPdfPointerInteraction(target: Element | null): boolean {
  if (!target) return false;
  const el = target as HTMLElement;
  if (
    el.tagName === "INPUT" ||
    el.tagName === "TEXTAREA" ||
    el.isContentEditable
  ) {
    return true;
  }
  // Keep normal text selection when the press starts on actual pdf.js text.
  if (target.closest(".pdf-textlayer span")) return true;
  // The floating selection action is a real button inside the scroll container.
  // Let it receive its click instead of starting zoomed PDF panning and moving
  // pointer capture to `.pdf-scroll`.
  if (target.closest(".selected-text-ask-ai")) return true;
  // Annotation handles/text/rects own their pointer gestures.
  if (target.closest(".annot-svg, .annot-text, .annot-text-input")) return true;
  return false;
}
