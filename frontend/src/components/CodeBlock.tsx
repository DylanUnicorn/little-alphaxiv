// Markdown code renderer: syntax-highlight fenced code blocks with highlight.js.
// react-markdown v10 does NOT pass an `inline` prop to the `code` component
// (removed after v8), and it wraps block code in its own <pre>. So we override
// BOTH `pre` (adds copy button + .code-block wrapper) and `code` (highlights
// block code, leaves inline code plain). Block-vs-inline is detected in `code`
// via: has a language- class OR contains a newline (inline backtick code is
// always single-line with no language class). This avoids (a) misdetecting
// inline code as a block and (b) nesting a <pre> inside react-markdown's outer <pre>.
import { useMemo, useRef, useState } from "react";
import hljs from "highlight.js";

interface CodeProps {
  className?: string;
  children?: React.ReactNode;
}

export function CodeBlock({ className, children }: CodeProps) {
  const raw = String(children ?? "");
  const code = raw.replace(/\n$/, "");
  const lang = /language-(\w+)/.exec(className || "")?.[1];
  const isBlock = !!lang || raw.includes("\n");

  const html = useMemo(() => {
    if (!isBlock || !code) return null;
    try {
      if (lang && hljs.getLanguage(lang)) {
        return hljs.highlight(code, { language: lang }).value;
      }
      return hljs.highlightAuto(code).value;
    } catch {
      return null;
    }
  }, [isBlock, code, lang]);

  if (!isBlock) {
    return <code className={className}>{children}</code>;
  }
  return (
    <code
      className={lang ? `hljs language-${lang}` : "hljs"}
      dangerouslySetInnerHTML={html ? { __html: html } : undefined}
    >
      {html ? undefined : code}
    </code>
  );
}

interface PreProps {
  children?: React.ReactNode;
}

export function CodePre({ children }: PreProps) {
  const preRef = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);

  function copy() {
    const text = preRef.current?.textContent ?? "";
    navigator.clipboard?.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  return (
    <div className="code-block">
      <button className="code-block-copy" onClick={copy} title="Copy">
        {copied ? "✓" : "⧉"}
      </button>
      <pre ref={preRef}>{children}</pre>
    </div>
  );
}

export const markdownCodeComponents = { code: CodeBlock, pre: CodePre };
