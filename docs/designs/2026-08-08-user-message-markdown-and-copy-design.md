# User Message Markdown And Copy Design

## Problem

Assistant messages render Markdown and KaTeX, but sent user messages are emitted as plain text. Copying a rendered assistant formula also lets the browser serialize KaTeX's visual and accessibility DOM into `text/plain`, producing duplicated symbols and line breaks when pasted into the composer.

## Chosen interaction

Keep the composer as a controlled plain `<textarea>`. While editing, users see and edit the Markdown source. After sending, user messages use the existing shared `Markdown` renderer, including GFM, normalized LaTeX delimiters, and KaTeX. Attachments retain their current placement and behavior.

KaTeX's official `copy-tex` extension handles copied selections containing formulas. It clones the selected DOM, replaces KaTeX's parallel MathML/HTML trees with the embedded TeX annotation, and writes `$...$` or `$$...$$` to `text/plain`. It preserves `text/html` for rich editors and leaves selections without formulas to the browser's normal copy path. A selection that starts or ends inside a formula expands to the formula boundary, avoiding broken half-formulas.

## Scope and constraints

- No live Markdown preview in the composer.
- No `contenteditable` or rich-text editor.
- User messages do not gain assistant-only arXiv/DOI card behavior; links remain ordinary links.
- Copy rewriting engages only when a copied selection contains KaTeX; ordinary prose copying stays native.
- Existing `MessageRow` memoization must continue to prevent historical Markdown/KaTeX rerenders on draft edits.

## Verification

- Component tests prove user content reaches the shared Markdown renderer and remains memoized during draft edits.
- An integration test locks the official KaTeX copy extension into the app entry point; browser verification covers partial formula selection and ordinary-copy fallback.
- Typecheck, full Vitest, build, and `git diff --check` pass.
- Browser verification covers send/render and copy/paste behavior with an inline and display formula.
