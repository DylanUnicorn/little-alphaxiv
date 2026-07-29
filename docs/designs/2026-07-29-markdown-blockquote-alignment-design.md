# Markdown Blockquote Alignment Design

## Problem

Assistant blockquotes have only 3px of vertical padding, while their final
Markdown paragraph keeps the global paragraph bottom margin. The extra space
exists only below the text, so the content looks top-aligned inside the tinted
quote surface.

## Design

Keep the semantic `blockquote` and its existing theme-aware colors. Give the
surface symmetric 8px vertical padding from the project's 4px spacing scale,
then remove only the first and last child margins inside the quote. Interior
paragraph, list, and heading spacing remains unchanged, so multi-block quotes
retain readable rhythm while single-block quotes become optically centered.

## Verification

Add a focused stylesheet regression test for symmetric padding and normalized
edge margins. Run the frontend typecheck and complete Vitest suite, then render
a representative multiline quote in the browser and compare its top and bottom
spacing across dark and light themes.
