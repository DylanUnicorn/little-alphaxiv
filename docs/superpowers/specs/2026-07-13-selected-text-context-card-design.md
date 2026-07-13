# Selected PDF text context card design

## Goal

Change the paper-reader selection flow from immediate submission to a reversible
composer attachment. After selecting text and choosing `Ask AI`, the active paper
conversation shows one compact context card above the textarea. The user can add
their own question, remove the card, or send the excerpt by itself.

## Interaction

- `Ask AI` captures normalized text and its one-based PDF page number.
- The composer shows one card with `Page N:`, a two-line excerpt preview, and a
  keyboard-accessible remove button.
- The textarea remains focused and keeps any draft text already present.
- A later PDF selection in the same conversation replaces the previous card.
  Multiple quote cards are intentionally out of scope.
- The send button is enabled when the composer contains typed text, image
  attachments, or a selected-text card.
- Sending clears the typed draft, image attachments, and selected-text card only
  after the user message has been appended successfully.
- Switching paper threads keeps the card bound to the thread where it was added.
  It is visible again if the user returns to that thread.
- Enabling highlight mode removes the floating `Ask AI` action as before.

## Message format

The selected text remains a UI attachment while composing. At send time it is
serialized into the persisted user message so conversation history and model
input remain backward-compatible:

```text
Excerpt from page 4:

> selected PDF text

What assumption is the author making here?
```

When the textarea is empty, the final line is `Please explain this excerpt.`.
Multiline excerpts are rendered as Markdown blockquotes line by line.

## Architecture

`SelectedTextAskAi` emits the structured `SelectedPdfTextPayload` instead of a
prebuilt prompt string. `PaperView` stores a conversation-bound payload.
`ChatPanel` owns send semantics and passes the matching payload to
`ChatComposer`. `ChatComposer` only renders the card and reports removal;
pure helpers create the persisted message text and determine send eligibility.

No backend or database schema change is needed because messages remain strings
inside the existing JSON conversation payload.

## Alternatives considered

1. Put the excerpt directly into the textarea. This is simple but mixes quoted
   evidence with the user's editable question and makes accidental deletion easy.
2. Keep immediate submission and add an optional follow-up. This preserves the
   current behavior but does not solve the user's need to refine the prompt first.
3. Use a dedicated context card. This matches the supplied reference, preserves
   the draft, and makes removal and replacement explicit. This is the chosen path.

## Visual system and accessibility

The card uses existing theme tokens: `--bg-3`, `--text`, `--text-dim`, and
`--accent`. It is a quiet inset surface, not a nested decorative card: 10px
radius, no wide shadow, a slim semantic accent marker, compact spacing, and a
visible focus ring on the remove button. The preview truncates visually without
truncating the actual text sent to the model. The card remains readable in all
themes and collapses cleanly in narrow paper-chat columns.

## Testing

Unit tests cover message serialization, multiline quoting, empty custom prompts,
thread matching, and send eligibility. Existing selection tests continue to cover
single-page validation and disabled state. The Playwright regression changes from
asserting immediate submission to asserting: card appears, no message is sent
before explicit send, custom text is accepted, and the resulting message contains
both page provenance and the custom question.
