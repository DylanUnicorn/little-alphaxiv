# PDF Page Zoom Race Design

## Problem

Each visible PDF page starts an asynchronous pdf.js canvas render whenever the
zoom or container width changes. The current cleanup marks the old effect as
cancelled but leaves its `RenderTask` running. A newer render can therefore
race the old task for the same canvas. If the newer task fails while the old
task later paints, one page remains at the stale scale until another zoom
change retries it.

## Approach

Treat each `PdfPage` effect as the owner of both its canvas `RenderTask` and its
text-layer task. Cleanup cancels both tasks. Every asynchronous boundary checks
the effect's cancelled flag before updating rendered state, page dimensions,
layers, or cleaning the shared `PDFPageProxy`. This preserves lazy rendering
and only redraws pages that are already visible.

Alternatives rejected:

- Debouncing zoom input leaves the underlying stale-task race in place.
- Re-rendering every page after each zoom avoids some stale pages but defeats
  lazy rendering and adds unnecessary work on long papers.

## Verification

Add jsdom component regressions for zoom changes during both canvas and text
rendering. Assert that old tasks are cancelled, cannot win, and cannot clean up
the page proxy while a successor owns it.
Run the focused test, full frontend tests, typecheck, build, and a browser PDF
zoom check.
