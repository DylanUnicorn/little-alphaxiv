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
