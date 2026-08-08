# Paper Branch Background Generation Design

## Problem

`ChatPanel` owns `busy`, `status`, `streaming`, `reasoning`, the abort controller, and the send lock as component-local state. In paper view, changing `conversationId` reuses the same component instance. An in-flight turn therefore keeps painting its local streaming buffer after the user selects another branch, even though its callbacks correctly persist completed messages to the conversation that launched the turn.

The visible result is misleading: branch B appears to receive branch A's tokens, then those tokens disappear when branch A's completed message is persisted.

## Considered Approaches

1. Cancel the request when the user switches branches. This prevents visual leakage but discards useful work and does not match the requested background-generation behavior.
2. Key `ChatPanel` by conversation id. This isolates local rendering, but unmounting loses access to partial output and provides no shared state for History. It also makes stop and resume visibility awkward when the user returns to the generating branch.
3. Store ephemeral turn state by conversation id. This keeps each request attached to its launch conversation, lets the selected panel subscribe only to its own stream, and gives History a stable set of generating ids. This is the selected approach.

## Architecture and Data Flow

Add a small, non-persisted Zustand runtime store. Each entry is keyed by conversation id and contains `busy`, `status`, `streaming`, `reasoning`, and the current `AbortController`. Starting a turn is an atomic operation that rejects a duplicate send for the same conversation. Every callback updates the entry captured for the launch conversation, never the currently selected conversation. Completion clears that entry only if its controller still owns it.

`ChatPanel` reads the runtime entry for its `conversationId`. Switching from branch A to B immediately changes the subscribed entry, so A's partial text is no longer rendered. A's async task continues and persists messages through the existing conversation store using A's captured id. Returning to A while it is still running restores its partial text and Stop control.

The runtime store also exposes a `generatingIds` set that changes only when a turn starts or ends. `HistoryPanel` and the toolbar quick-history popover pass this set to `ConversationTree`. A generating node renders an accent-colored outer progress ring and announces `generating response` in its accessible label. The ring is theme-token based. Under `prefers-reduced-motion`, it becomes a static dashed ring rather than disappearing.

Composer draft and attachments reset when the selected conversation changes so input from one branch is not shown in another. The generation runtime remains independent of that reset.

## Failure and Edge Behavior

- Stream, tool, retry, image-fallback, and title-generation behavior remain unchanged; only their UI state destination changes.
- Stop targets only the selected conversation's controller.
- A branch can generate while another branch is viewed or starts its own turn.
- If persistence fails before the request begins, the runtime entry is released and the error remains scoped to the launch conversation.
- The store is intentionally memory-only. Reloading still ends browser-owned streams, matching current behavior.

## Verification

- Unit-test runtime ownership, duplicate-send rejection, scoped updates, stop, and stale-controller protection.
- Component-test that switching `ChatPanel` from A to B hides A's stream and switching back restores it.
- Component-test ConversationTree generating classes, data attributes, and accessible labels.
- Run the complete frontend Vitest suite, TypeScript gate, and production build.
- Exercise the paper History flow in a browser: start on a branch, switch while streaming, confirm the current transcript stays clean, confirm the original node spins, then return and observe its partial/final answer.
