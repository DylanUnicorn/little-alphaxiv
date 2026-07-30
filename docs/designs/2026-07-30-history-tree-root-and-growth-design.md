# History Tree Root And Growth Design

## Goal

Make the paper-chat History tree readable without explanatory copy. A user should immediately recognize the root, understand that branches grow downward, and see where a newly created branch came from.

## Direction And Root Language

The tree keeps the conventional software-tree direction: parent above, children below. Reversing the layout would make the botanical metaphor literal, but it would conflict with the existing parent-to-child layout and common graph-reading habits.

The root receives a persistent visual marker independent of selection state: a restrained outer foundation ring around the node and a short stem extending downward toward its descendants. The marker uses existing theme tokens and appears in both the compact hover tree and the full History panel. The root button also exposes `data-root="true"` and an explicit accessible label. No visible text is added to the compact tree.

## New Branch Feedback

When a selection-created branch is accepted by the server and becomes the active paper conversation, the compact tree opens automatically for a short acknowledgement. The new edge draws from parent to child first, then the child node scales and fades into its final position with a brief accent pulse. The sequence stays below 450 ms and never blocks interaction. The popover remains visible long enough to understand the result, then closes unless the pointer enters it.

The toolbar detects only nodes added after its initial render, so hydration, reloads, and existing histories never replay the creation animation. A pending-node ref bridges the store update and route navigation whether React renders them together or separately.

## Accessibility And Performance

All motion uses bounded SVG stroke, opacity, and transform animation. `prefers-reduced-motion` disables drawing, scaling, and pulse effects while preserving the root marker and final branch state. Keyboard focus and node click behavior remain unchanged. The implementation uses the app's existing CSS theme tokens across all themes.

## Verification

Unit coverage verifies new-node detection semantics. Playwright verifies the root marker, top-to-bottom geometry, automatic reveal, new edge and node animation classes, pointer takeover, quick navigation, full History behavior, and reduced-motion fallback. Existing typecheck, Vitest, backend pytest, CI, Docker build, and health checks remain required.
