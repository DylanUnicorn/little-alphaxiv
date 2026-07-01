// Shared markdown renderer for chat messages.
//
// Wraps react-markdown with GFM + math + theme-aware code blocks (CodeBlock),
// and rewrites arXiv links + DOI/publisher links in assistant text into
// in-app cards:
//   - arXiv.org link -> inline preview card (click -> /paper/<id>)
//   - DOI link (doi.org/<doi> or <host>/doi/<doi>, e.g. ACM/IEEE/Springer) ->
//     inline UNFETCHABLE card with 3 buttons (Upload Local PDF / Import from
//     Zotero / Open source page). The model often cites paywalled non-arXiv
//     papers by writing their DOI/ACM URL as plain text (no tool call), so we
//     turn those links into the same 3-button fallback here, UI-determined
//     rather than relying on the model surfacing a structured Paper object.
//   - anything else -> plain external <a target="_blank">

import type { ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import { useNavigate } from "react-router-dom";
import { extractArxivId } from "../lib/arxiv";
import { extractDoiFromUrl } from "../lib/paperSource";
import { markdownCodeComponents } from "./CodeBlock";
import { Tooltip } from "./Tooltip";
import { rehypeCjkEmphasis } from "../lib/remark-cjk-emphasis";
import { useUi } from "../store/ui";

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
          const url = href ?? "";
          const id = extractArxivId(url);
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
          const doi = extractDoiFromUrl(url);
          if (doi) {
            return <DoiInlineCard doi={doi} href={url} linkText={textOf(children)} />;
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

/** Inline 3-button card for a DOI/publisher link the model wrote as text.
 *  Mirrors the PaperCard unfetchable fallback but compact (inline in prose).
 *  Upload/Zotero open the Open Local Paper dialog pre-seeded with this paper's
 *  metadata (so the upload attaches bytes to the EXISTING global Paper row);
 *  Open source page opens the landing URL the model cited (ACM/IEEE/etc.). */
function DoiInlineCard({ doi, href, linkText }: { doi: string; href: string; linkText: string }) {
  const openDialog = useUi((s) => s.openLocalPaperDialog);
  const title =
    linkText && !/^https?:\/\//i.test(linkText) && linkText.toLowerCase() !== doi.toLowerCase()
      ? linkText
      : `Paper (DOI ${doi})`;
  const preset = {
    paperId: `doi:${doi}`,
    title,
    authors: [] as string[],
    doi,
    externalUrl: href,
  };
  return (
    <span className="doi-inline-card">
      <span className="doi-inline-head">
        <span className="arxiv-inline-icon">📄</span>
        <span className="arxiv-inline-body">
          <span className="arxiv-inline-title">{title}</span>
          <span className="arxiv-inline-id">DOI: {doi}</span>
        </span>
      </span>
      <span className="doi-inline-actions">
        <button type="button" className="paper-action" onClick={() => openDialog({ preset, tab: "upload" })}>
          📤 Upload Local PDF
        </button>
        <button type="button" className="paper-action" onClick={() => openDialog({ preset, tab: "zotero" })}>
          📥 Import from Zotero
        </button>
        <button
          type="button"
          className="paper-action"
          onClick={() => window.open(href, "_blank", "noopener,noreferrer")}
        >
          ↗ Open source page
        </button>
      </span>
    </span>
  );
}

/** Flatten link children to a plain string (for title inference). */
function textOf(children: ReactNode): string {
  if (typeof children === "string") return children;
  if (Array.isArray(children)) return children.map((c) => (typeof c === "string" ? c : "")).join("");
  return "";
}

/** Pick a card title from the link's text. Falls back to a generic label when
 *  the text is empty or just the bare URL/id (models sometimes do this). */
function titleFor(children: ReactNode, id: string): string {
  const t = textOf(children).trim();
  if (!t || /^https?:\/\//i.test(t) || t.toLowerCase() === id.toLowerCase()) {
    return `arXiv paper ${id}`;
  }
  return t;
}
