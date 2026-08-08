# WYSIWYG Math Composer Design

## Goal

Replace the separate read-only formula preview with a single hybrid composer. Ordinary prose remains lightweight plain text, while complete LaTeX expressions become editable visual formula nodes in the same surface. Users can click into fractions, roots, superscripts, and subscripts without editing raw delimiters.

## Editing model

The composer uses a small Tiptap document with text, hard breaks, and custom inline or display math nodes. Math nodes render a MathLive `math-field`, so the formula owns its internal structured caret while Tiptap owns selection, prose, undo/redo, and IME behavior around it.

Closed `$...$`, `$$...$$`, `\(...\)`, and `\[...\]` expressions are converted when an external draft is loaded or mixed Markdown is pasted. During direct typing, conversion happens only after the closing delimiter is entered and never during an active IME composition. Incomplete or invalid expressions remain literal text. Inline formulas participate in the prose line; display formulas occupy their own visual row.

The separate Preview section and its styles are removed. The composer retains the current compact chrome, theme tokens, attachment behavior, selected-text context, model selector, search toggle, send/stop button, drag-and-drop handling, and height cap.

## Data contract

The application-wide message contract remains a string. A pure codec converts Markdown to the editor document and serializes the document back to Markdown. Formula nodes serialize to `$latex$` or a canonical `$$\nlatex\n$$` block. Newlines, ordinary Markdown characters, code spans, and escaped dollar signs remain text.

`ChatComposer` keeps the external `value` prop synchronized without replacing the editor document when the serialized content already matches. This prevents caret jumps and avoids feedback loops. Switching conversations or receiving a genuinely different external value replaces the editor content without emitting another update. Sending, title generation, persistence, and LLM requests therefore require no backend or store changes.

## Interaction and fallback

Enter sends; Shift+Enter inserts a newline. Clicking a formula enters MathLive editing. Escape returns focus to the surrounding composer. Arrow keys can cross formula boundaries, and Backspace/Delete at the adjacent boundary removes the formula as one node. Clipboard text containing formulas is inserted as mixed text and math nodes; image clipboard data continues through the existing attachment path.

If MathLive cannot upgrade its web component, the formula node exposes its LaTeX source as readable fallback text and continues to serialize correctly. Invalid LaTeX stays editable in the math field rather than being discarded. The editor is disabled while a response is busy, while the stop action remains available.

## Verification

Pure codec tests cover inline/display delimiters, multiline input, escaped dollars, code regions, incomplete formulas, and exact Markdown round trips. Component tests cover removal of Preview, external synchronization, formula editing updates, send/newline behavior, paste, busy state, and historical-message render isolation. Browser testing covers Chinese IME, fraction/root/superscript editing, keyboard boundary navigation, mixed paste, undo/redo, send, refresh persistence, narrow paper view, and light/dark themes. The full frontend gates, backend tests, PR CI, merged-main Docker rebuild, container health, and HTTP health endpoint remain required.
