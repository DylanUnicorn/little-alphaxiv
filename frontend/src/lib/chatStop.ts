// Pure abort-detection helper. `send()` in ChatPanel creates an AbortController
// per turn and passes its signal to runConversation -> streamChat -> fetch.
// When the user clicks Stop, controller.abort() makes the in-flight fetch reject.
// We need to tell a *user-initiated* stop apart from a *real* network/upstream
// error, because the UI treatment differs: a stop keeps the partial reply and
// marks it "已停止" (dim), whereas an error keeps the existing red "interrupted"
// marker. Extracted into a pure module so it can be unit-tested in the repo's
// node-only Vitest harness (there is no jsdom/component test setup).
//
// Two signals count as a user abort:
//   1. the controller we created for this turn was aborted (authoritative — the
//      abort originates here), OR
//   2. the thrown value is a DOMException named "AbortError" (what fetch throws
//      on abort; also covers cases where the signal is unavailable).

export function isAbortError(
  signal: AbortSignal | null | undefined,
  err: unknown
): boolean {
  if (signal?.aborted) return true;
  if (err && typeof err === "object" && "name" in err) {
    return (err as { name: unknown }).name === "AbortError";
  }
  return false;
}
