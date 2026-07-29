# Ask AI context visibility design

## Problem

At PDF zoom levels above 100%, `PdfViewer` enables click-and-drag panning on the
scroll container. Its native `pointerdown` listener exempts PDF text and
annotation controls, but not the floating `Ask AI` button. A press on that
button therefore starts PDF panning, captures the pointer on the scroll
container, and prevents the React button click from firing. The selection and
floating button remain visible, while no context card reaches the composer.

## Decision

Treat the floating `Ask AI` button as an interactive PDF child, alongside text
spans and annotation controls. The panning listener must return without
preventing the pointer event or capturing the pointer when the press starts on
the button. Blank page presses continue to pan at zoom levels above 100%.

The selected text remains a reversible composer attachment. It is not submitted
until the user presses Send, and existing draft text, thread binding, replacement
semantics, and post-send cleanup remain unchanged.

## Alternatives

1. Raise the button z-index. This does not help because the button is already
   the pointer target; the ancestor's native panning listener still handles the
   bubbling event first.
2. Stop propagation only in the React handler. The native listener attached
   directly to `.pdf-scroll` runs before React's delegated handler, so this is
   too late.
3. Add the button to the panning exemption helper. This preserves every
   existing gesture and is the chosen approach.

## Verification

A pure unit test covers the panning exemption for the floating button while
keeping blank page targets pannable. The Playwright selection regression zooms
the PDF to 160%, selects text, clicks `Ask AI`, and asserts that the button and
selection disappear while the correct `Page N` context card appears without
sending a message. Frontend typecheck and Vitest remain required gates.
