const CODE_SPAN_OR_BLOCK_RE = /(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`)/g;

/** Convert common LaTeX math delimiters that remark-math does not parse.
 *
 * LLMs often emit display math as ``\[...\]`` and inline math as ``\(...\)``.
 * Markdown treats those backslashes as escapes, leaving visible square or
 * round brackets. Convert only non-code regions to the dollar delimiters that
 * remark-math + KaTeX already render.
 */
export function normalizeLatexMathDelimiters(markdown: string): string {
  return markdown
    .split(CODE_SPAN_OR_BLOCK_RE)
    .map((part, index) => (index % 2 === 1 ? part : normalizeTextMath(part)))
    .join("");
}

function normalizeTextMath(text: string): string {
  return text
    .replace(/\\\[/g, () => "$$")
    .replace(/\\\]/g, () => "$$")
    .replace(/\\\(/g, () => "$")
    .replace(/\\\)/g, () => "$");
}
