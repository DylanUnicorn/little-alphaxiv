// Shared markdown renderer for chat messages.
//
// Wraps react-markdown with GFM + math + theme-aware code blocks (CodeBlock),
// and rewrites arXiv links in assistant text into in-app preview
// cards: clicking navigates to /paper/<id> (the two-panel preview mode)
// instead of opening arxiv.org externally. So when the model cites a paper by
// URL, the user gets the same clickable "preview box" they'd get from a
// search_arxiv tool result — not an external link.

import type { ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import { useNavigate } from "react-router-dom";
import { extractArxivId } from "../lib/arxiv";
import { markdownCodeComponents } from "./CodeBlock";
import { Tooltip } from "./Tooltip";
import { rehypeCjkEmphasis } from "../lib/remark-cjk-emphasis";

const REMARK_PLUGINS = [remarkGfm, remarkMath];
const REHYPE_PLUGINS = [rehypeKatex, rehypeCjkEmphasis];

export function Markdown({ children }: { children: string }) {
  const navigate = useNavigate();

  return (
    <ReactMarkdown
      remarkPlugins={REMARK_PLUGINS}
      rehypePlugins={REHYPE_PLUGINS}
      components={{
        ...markdownCodeComponents,
        a({ href, children }) {
          const id = href ? extractArxivId(href) : null;
          if (id) {
            return (
              <Tooltip label={`Open arXiv ${id} in-app`} side="top" block>
                <button
                  type="button"
                  className="arxiv-inline-card"
                  onClick={() => navigate(`/paper/${id}`)}
                >
                  <span className="arxiv-inline-icon">📄</span>
                  <span className="arxiv-inline-body">
                    <span className="arxiv-inline-title">{titleFor(children, id)}</span>
                    <span className="arxiv-inline-id">{id}</span>
                  </span>
                  <span className="arxiv-inline-cta">Preview →</span>
                </button>
              </Tooltip>
            );
          }
          return (
            <a href={href} target="_blank" rel="noreferrer noopener">
              {children}
            </a>
          );
        },
      }}
    >
      {children}
    </ReactMarkdown>
  );
}

/** Pick a card title from the link's text. Falls back to a generic label when
 *  the text is empty or just the bare URL/id (models sometimes do this). */
function titleFor(children: ReactNode, id: string): string {
  const raw =
    typeof children === "string"
      ? children
      : Array.isArray(children)
        ? children.map((c) => (typeof c === "string" ? c : "")).join("")
        : "";
  const t = raw.trim();
  if (!t || /^https?:\/\//i.test(t) || t.toLowerCase() === id.toLowerCase()) {
    return `arXiv paper ${id}`;
  }
  return t;
}
