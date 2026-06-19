/** Clamp a textarea's measured scrollHeight into [min, max].
 *
 *  Used by ChatComposer's auto-grow effect: the textarea is set to
 *  scrollHeight when content grows, but never below the 2-line minimum
 *  (empty input) and never above the cap (at which point the textarea's
 *  own overflow-y:auto takes over and the user scrolls natively). */
export function computeTextareaHeight(
  scrollHeight: number,
  min: number,
  max: number
): number {
  return Math.min(max, Math.max(min, scrollHeight));
}

/** Partition dragged/pasted files into images (kept) and non-images (rejected).
 *
 *  `image/*` MIME is the gate, matching the <input accept="image/*"> contract
 *  used by the attach button. Pure + synchronous so it is trivially unit-
 *  testable; the drag-drop handler in ChatComposer calls this to decide what
 *  to stage (images) vs. surface a "仅支持图片" toast for (rejected). */
export function pickImageFiles(
  files: File[]
): { images: File[]; rejected: File[] } {
  const images: File[] = [];
  const rejected: File[] = [];
  for (const f of files) {
    (f.type.startsWith("image/") ? images : rejected).push(f);
  }
  return { images, rejected };
}
