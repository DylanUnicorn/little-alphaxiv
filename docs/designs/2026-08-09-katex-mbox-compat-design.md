# KaTeX `\mbox` Compatibility Design

## Problem

Some AI responses emit legacy TeX such as `W\mbox{-MSA Block}` or
`\operatorname{signed\mbox{-}log}`. KaTeX does not support `\mbox` in the
current renderer configuration, so `throwOnError: false` exposes the unknown
command in red inside otherwise valid formulas.

## Design

Extend the existing math normalization stage to rewrite `\mbox{...}` as
KaTeX-supported `\text{...}`. The rewrite is applied only inside complete
`$...$` or `$$...$$` expressions after `\(...\)` and `\[...\]` have been
canonicalized. Fenced code, inline code, ordinary prose, and unmatched formulas
remain byte-for-byte unchanged.

This keeps the stored assistant message and LLM transcript untouched; only the
render-time Markdown passed to remark-math/KaTeX is normalized. Existing
formula copy behavior consequently exports the normalized, renderable TeX.

## Verification

- Render the screenshot's two MSA equations and assert there is no KaTeX error.
- Cover nested `\operatorname{signed\mbox{-}log}`.
- Prove code spans, fenced code, prose, and incomplete formulas are unchanged.
- Run the full frontend suite, production build, CI, and a deployed browser
  check against the exact MSA formula.
