# Rendered Math Copy Design

## Problem

Copying a mixed prose-and-formula selection from a rendered chat message can put
KaTeX's accessibility and visual layers into `text/plain`. The resulting text
contains the visual glyphs, the original LaTeX annotation, and sometimes a
second fallback representation without `$...$` delimiters. The composer then
correctly treats that malformed payload as prose, so commands such as
`\widehat{}` and `\operatorname{}` remain visible source text.

## Chosen approach

Canonicalize the selection at the source, on `copy`, instead of guessing on
`paste`. When a selection inside chat history contains KaTeX, clone the selected
DOM fragment, replace each selected KaTeX root with the original TeX stored in
its MathML `<annotation encoding="application/x-tex">`, wrap it in `$...$` or
`$$...$$` according to display mode, and write that canonical Markdown to
`text/plain`.

Selections without KaTeX retain the browser's normal copy behavior. The
composer's existing Markdown parser therefore remains the only formula parser,
and ordinary backslashes, code, and non-math text are not reclassified.

## Failure behavior

If there is no active selection, no writable clipboard, no complete KaTeX root,
or no TeX annotation, the handler does nothing and the browser performs its
default copy. Partial selections that do not include a recoverable annotation
are intentionally left untouched rather than guessed.

## Verification

- Unit-test inline and display KaTeX replacement, mixed Chinese prose, multiple
  equations, ordinary-copy fallback, and missing-annotation fallback.
- Integration-test that the canonical copied text is accepted by the existing
  composer paste path as editable math nodes.
- Run typecheck, the focused Vitest files, the full frontend suite, and build.
- Browser-test copy from a deployed assistant message and paste into the visual
  composer, then verify editable formula nodes and Markdown serialization.

