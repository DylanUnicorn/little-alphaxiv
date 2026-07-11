# AI text selection design

## Goal

In a paper view, selecting readable PDF text exposes a small `Ask AI` control.
Activating it adds the selected excerpt, with its PDF page number, to the active
paper conversation and sends the question immediately. This implements GitHub
issue #2 without changing annotations, saved highlights, or general chat.

## Chosen approach

The implementation attaches selection handling to `PdfViewer`, where page
containers and the rendered PDF text layer are both available. A small,
independent `SelectedTextAskAi` component owns the floating-control lifecycle:
it validates that a browser selection belongs to exactly one PDF text layer,
captures a normalized excerpt and page number, and positions the control beside
the selection. `PdfViewer` passes the confirmed payload up to `PaperView`.

`PaperView` keeps one pending prompt. It provides that prompt to `ChatPanel`,
which consumes it through the existing `send()` path. The prompt is not merely
prefilled: it is sent as the next user message so the action has a predictable
result and cannot be lost if focus moves away from the composer.

The emitted user message is intentionally plain text, for example:

```text
Please explain this excerpt from page 4 of the paper:

> selected PDF text
```

The existing paper system prompt and full-text context remain the authoritative
context; page metadata improves grounding and makes the transcript legible.

## Considered alternatives

1. Pass the browser selection through a global store. This adds shared,
   ephemeral state and stale-selection cleanup paths without benefiting other
   views.
2. Pre-fill the composer and wait for a second send click. This allows editing
   but makes the explicit `Ask AI` action ambiguous and can overwrite a draft.
3. Chosen: a local, event-driven callback through `PdfViewer -> PaperView ->
   ChatPanel`, followed by the existing send flow. It is scoped to paper chat,
   avoids new persistence, and preserves conversation semantics.

## Interaction and failure behavior

- The control appears only after a non-empty text selection wholly inside one
  `.pdf-textlayer` page. It is dismissed by Escape, clicking elsewhere, a new
  selection, paper change, or a selection that crosses pages.
- The control uses pointer-down prevention so clicking it does not clear the
  browser selection before its text is captured.
- A busy conversation does not show an actionable control. The selection is
  left alone and the user can try again when generation ends.
- Selection text is whitespace-normalized and capped before adding it to the
  prompt, protecting the provider context budget while retaining enough local
  evidence for a useful explanation.
- No annotations are created or modified. Existing highlight selection and
  toolbar behavior continue to work.

## Testing

Pure helper tests cover eligible selection extraction, page-number discovery,
whitespace normalization, caps, and prompt construction. Component wiring is
kept deliberately thin and is checked by TypeScript plus the existing frontend
test suite. A manual browser check verifies the PDF text layer, floating control,
and streamed answer together.

## Scope

This release does not add multi-page selection support, editable prefill mode,
selection history, or a new backend endpoint. Those would change the interaction
contract and can be designed separately if needed.
