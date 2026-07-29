# History Hover Quick Tree Design

## Goal

In the paper preview's right-hand chat toolbar, hovering near `History` opens a compact branch tree for the active History. The user can jump to any node with one click without opening the full History management panel. Clicking `History` still opens the existing full panel for switching roots, reading branch details, creating new roots, and deleting nodes.

General chat remains flat and has no branch UI.

## Interaction

The quick tree opens when the pointer enters the `History` button and stays open while the pointer crosses into the popover. A short close delay absorbs the physical gap between the button and popover. Leaving both regions closes it. Clicking a node navigates to that paper conversation and closes the popover. Clicking the `History` button closes the popover before toggling the full panel, so the two surfaces never overlap.

The quick popover contains only tree lines and node buttons. The active node keeps the existing accent fill and glow. There are no visible titles, excerpts, counts, group headers, or delete controls. Accessible node labels remain available to assistive technology. The button keeps an `aria-label`; its redundant hover tooltip is removed because the tree itself now appears on hover.

Touch devices continue to use the full panel through a click. Reduced-motion preferences disable the quick popover transition.

## Architecture

`ChatToolbar` derives the active History from paper conversations already held in the Zustand store. It renders a portal-backed `HistoryQuickTreePopover` anchored to the History button. The popover reuses `ConversationTree` in a new `compact` mode that omits the detail footer and visible node titles while preserving the same deterministic layout, active-node state, and click callback.

The portal uses fixed positioning and viewport clamping, which prevents clipping by the chat column. Its width follows the active tree up to a compact maximum; larger trees scroll inside the popover.

## Verification

Unit tests cover viewport clamping and compact sizing. Existing tree tests continue to cover deterministic node layout. Playwright verifies that hover opens a tree-only popover, the current node is highlighted, clicking a node navigates immediately, clicking History still opens the full management panel, and the compact popover exposes no detail or delete controls. Full TypeScript, Vitest, backend pytest, Docker build, and health checks remain required.
