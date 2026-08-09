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

/** Whether non-code Markdown contains at least one complete math expression.
 * Used to avoid showing composer preview chrome for ordinary prose or while a
 * user is still typing an unmatched delimiter. */
export function hasRenderableMath(markdown: string): boolean {
  return markdown
    .split(CODE_SPAN_OR_BLOCK_RE)
    .some((part, index) => index % 2 === 0 && hasClosedDollarMath(normalizeTextMath(part)));
}

function hasClosedDollarMath(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== "$" || isEscaped(text, index)) continue;

    if (text.startsWith("$$", index)) {
      const close = findDelimiter(text, index + 2, "$$", true);
      if (close >= 0 && text.slice(index + 2, close).trim()) return true;
      index += 1;
      continue;
    }

    // The second character in an unescaped `$$` pair is not an inline opener.
    if (index > 0 && text[index - 1] === "$" && !isEscaped(text, index - 1)) continue;
    const close = findDelimiter(text, index + 1, "$", false);
    if (close >= 0 && text.slice(index + 1, close).trim()) return true;
  }
  return false;
}

function findDelimiter(
  text: string,
  start: number,
  delimiter: "$" | "$$",
  allowNewlines: boolean,
): number {
  for (let index = start; index < text.length; index += 1) {
    if (!allowNewlines && text[index] === "\n") return -1;
    if (!text.startsWith(delimiter, index) || isEscaped(text, index)) continue;
    if (delimiter === "$" && text[index + 1] === "$") {
      index += 1;
      continue;
    }
    return index;
  }
  return -1;
}

function isEscaped(text: string, index: number): boolean {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === "\\"; cursor -= 1) {
    backslashes += 1;
  }
  return backslashes % 2 === 1;
}

function normalizeTextMath(text: string): string {
  const normalizedDelimiters = text
    .replace(/\\\[/g, () => "$$")
    .replace(/\\\]/g, () => "$$")
    .replace(/\\\(/g, () => "$")
    .replace(/\\\)/g, () => "$");

  // `remark-math` reliably treats `$$` as display math when both delimiters
  // occupy their own lines. Clipboard selections often attach content to the
  // same lines (`$$\\frac...` and `...theta.$$`), so canonicalize complete
  // unescaped pairs before parsing. Code regions have already been split out.
  const canonicalDisplayMath = normalizedDelimiters.replace(
    /(^|[^\\])\$\$([\s\S]*?)\$\$/g,
    (match, prefix: string, content: string, offset: number, source: string) => {
      const trimmed = content.trim();
      if (!trimmed) return match;
      const before = prefix && prefix !== "\n" ? `${prefix}\n` : prefix;
      const end = offset + match.length;
      const after = end < source.length && source[end] !== "\n" ? "\n" : "";
      return `${before}$$\n${trimmed}\n$$${after}`;
    },
  );

  return normalizeLegacyCommandsInMath(canonicalDisplayMath);
}

/** Normalize legacy TeX commands only inside complete math ranges.
 *
 * Keeping this delimiter-aware prevents prose, code (already split by the
 * caller), and a formula that is still being typed from being rewritten.
 */
function normalizeLegacyCommandsInMath(text: string): string {
  let result = "";
  let cursor = 0;

  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== "$" || isEscaped(text, index)) continue;

    const isDisplay = text.startsWith("$$", index);
    if (!isDisplay && index > 0 && text[index - 1] === "$" && !isEscaped(text, index - 1)) {
      continue;
    }

    const delimiter: "$" | "$$" = isDisplay ? "$$" : "$";
    const bodyStart = index + delimiter.length;
    const close = findDelimiter(text, bodyStart, delimiter, isDisplay);
    if (close < 0) {
      if (isDisplay) index += 1;
      continue;
    }

    const body = text.slice(bodyStart, close).replace(
      /\\mbox(?=\s*\{)/g,
      (command, offset: number, source: string) =>
        isEscaped(source, offset) ? command : "\\text",
    );
    const rangeEnd = close + delimiter.length;
    result += text.slice(cursor, bodyStart) + body + text.slice(close, rangeEnd);
    cursor = rangeEnd;
    index = rangeEnd - 1;
  }

  return result + text.slice(cursor);
}
