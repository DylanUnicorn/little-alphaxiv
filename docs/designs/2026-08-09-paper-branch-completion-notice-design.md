# Paper Branch Completion Notice Design

## Problem

Paper conversation branches now keep background generation attached to the branch that launched it. History shows a rotating ring while that turn is running. When the turn finishes, the runtime entry and ring disappear immediately. The completed branch then looks identical to every idle branch, so a user who continued reading elsewhere has to remember which branch was generating.

## Considered Approaches

1. Show a global toast when a response finishes. A toast is useful for immediate feedback, but it expires and does not remain attached to the branch the user needs to find.
2. Flash the branch node briefly. This is visually quiet, but it has the same timing problem and relies on motion.
3. Keep a branch-level “completed, not yet viewed” state. This preserves location, survives opening History later, and can be acknowledged by the natural action of opening the branch. This is the selected approach.

## Interaction and Visual Design

The runtime store gains a memory-only set of conversation ids whose turns completed while another branch was active. A generating id and a completed id are mutually exclusive. Starting a new turn clears an older completion marker for that conversation. Finishing a background turn removes its generating state and adds its id to the completed set. Opening that conversation acknowledges the state and removes the id.

The History tree renders the states with distinct visual grammar:

- Generating: the existing rotating accent ring, with a static dashed alternative under reduced motion.
- Completed and unviewed: a small, static accent badge at the node's upper-right edge. It does not use success-green because the state means “new result available,” not that the model's answer is correct.
- Viewed or idle: the existing node appearance.

The accessible node label appends “response ready, not viewed” for the completion state. The tree also exposes a data attribute for deterministic tests. No toast, sound, or persistent server field is added; this notification describes a browser-owned stream and therefore has the same page-lifetime boundary as the existing generation runtime.

## State Ownership and Edge Cases

`ChatPanel` keeps a ref to the currently selected conversation id. The async turn closure already captures the launch id. At finalization it asks the runtime store to create a completion notice only when those ids differ. This avoids a one-frame unread marker when the user watched the response finish in the active branch.

Selecting a branch clears its completion notice. Starting another turn in the same branch also clears it. Stale controllers cannot finish or mark a newer turn. A stopped or failed background turn still becomes “ready” because the branch contains the terminal result or interruption message and needs the same location cue; the badge deliberately does not claim success.

## Verification

- Store tests cover background completion, active completion, acknowledgement, restart clearing, and stale-controller protection.
- Tree tests cover the completion class, data attribute, badge, accessible label, and precedence of generating over completed.
- A component test verifies that changing the active conversation acknowledges its completion state.
- Run the complete frontend test suite, TypeScript check, and production build.
- Verify in a real browser: start a branch turn, switch branches, observe the spinner, wait for the static badge, open the completed branch, and confirm the badge clears.
