# Composer Math Preview Design

## Problem

Sent user messages now render through Markdown and KaTeX, and copied assistant formulas paste as LaTeX. The composer itself remains a plain textarea, so a pasted formula still appears as raw `$$...$$` while the user is editing. This makes the feature look broken before send and forces users to mentally parse multiline LaTeX.

## Interaction

Keep the controlled textarea as the source editor. When the draft contains a closed math expression using `$...$`, `$$...$$`, `\(...\)`, or `\[...\]`, show a compact rendered preview directly below the textarea and above attachments/actions. The preview renders the entire draft so surrounding prose and formula placement remain understandable. It is labeled `Preview`, uses the existing Markdown renderer with assistant-only paper cards disabled, and is read-only.

The preview is absent for empty drafts, ordinary prose, unmatched delimiters, and dollar signs inside fenced or inline code. It has a maximum height with internal scrolling so long pasted answers do not consume the paper/chat workspace. Display math scrolls horizontally when necessary.

Clipboard output commonly uses loose display delimiters such as `$$\frac...` and `...theta.$$`. Before Markdown parsing, complete loose pairs are canonicalized to delimiters on their own lines. The source textarea is not rewritten; only the render input is normalized. This same normalization benefits composer previews, sent user bubbles, and assistant messages.

## Performance and accessibility

The textarea remains immediate and controlled. The preview reads a `useDeferredValue` of the draft, allowing React to prioritize typing and IME updates over KaTeX work without introducing a timer or visible-input debounce. Historical message rows keep their existing memo boundary and must not rerender during draft edits.

The preview is a labeled `section` with `aria-live="polite"` and `aria-atomic="true"`. It is not focusable and adds no new controls. Existing theme tokens provide background, border, text, and accent colors across all themes.

## Verification

- Unit tests cover math detection, code exclusions, and incomplete delimiters.
- Component tests confirm preview visibility and rendering without historical rerenders.
- Browser verification pastes the reported multiline expression and confirms visible KaTeX before send.
- Typecheck, full Vitest, production build, CI, merge, and Docker health verification remain required.
