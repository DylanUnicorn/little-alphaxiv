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

import { createElement, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import type { PluggableList } from "unified";
import { useNavigate } from "react-router-dom";
import { extractArxivId } from "../lib/arxiv";
import { extractDoiFromUrl } from "../lib/paperSource";
import { markdownCodeComponents } from "./CodeBlock";
import { Tooltip } from "./Tooltip";
import { rehypeCjkEmphasis } from "../lib/remark-cjk-emphasis";
import { normalizeLatexMathDelimiters } from "../lib/mathMarkdown";
import { useUi } from "../store/ui";
import { useSettings } from "../store/settings";

const REMARK_PLUGINS: PluggableList = [remarkGfm, remarkMath];
const REHYPE_PLUGINS: PluggableList = [
  [rehypeKatex, { throwOnError: false, strict: "ignore" }],
  rehypeCjkEmphasis,
];

export function Markdown({ children }: { children: string }) {
  const navigate = useNavigate();
  const enableMathType = useSettings((s) => s.aiOutputFormat.enableMathType);
  const segments = enableMathType ? splitMathMlSegments(children) : [{ type: "markdown" as const, text: children }];

  const renderMarkdown = (text: string) => (
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
      {normalizeLatexMathDelimiters(text)}
    </ReactMarkdown>
  );

  return (
    <>
      {segments.map((segment, index) =>
        segment.type === "mathml" ? (
          <MathMl key={index} source={segment.source} display={segment.display} />
        ) : segment.text ? (
          <div key={index} className="markdown-segment">
            {renderMarkdown(segment.text)}
          </div>
        ) : null
      )}
    </>
  );
}

type MarkdownSegment =
  | { type: "markdown"; text: string }
  | { type: "mathml"; source: string; display: boolean };

const MATHML_RE = /<math\b[\s\S]*?<\/math>/gi;

function splitMathMlSegments(input: string): MarkdownSegment[] {
  const segments: MarkdownSegment[] = [];
  let lastIndex = 0;
  for (const match of input.matchAll(MATHML_RE)) {
    const source = match[0];
    const index = match.index ?? 0;
    if (index > lastIndex) {
      segments.push({ type: "markdown", text: input.slice(lastIndex, index) });
    }
    segments.push({
      type: "mathml",
      source,
      display: /\bdisplay\s*=\s*["']block["']/i.test(source) || isOwnLine(input, index, index + source.length),
    });
    lastIndex = index + source.length;
  }
  if (lastIndex < input.length) {
    segments.push({ type: "markdown", text: input.slice(lastIndex) });
  }
  return segments.length > 0 ? segments : [{ type: "markdown", text: input }];
}

function isOwnLine(input: string, start: number, end: number): boolean {
  const before = input.slice(Math.max(0, start - 2), start);
  const after = input.slice(end, end + 2);
  return /(^|\n)\s*$/.test(before) && /^\s*(\n|$)/.test(after);
}

const MATHML_TAGS = new Set([
  "math",
  "mrow",
  "mi",
  "mn",
  "mo",
  "ms",
  "mtext",
  "mspace",
  "mfrac",
  "msqrt",
  "mroot",
  "msup",
  "msub",
  "msubsup",
  "munder",
  "mover",
  "munderover",
  "mmultiscripts",
  "mprescripts",
  "none",
  "mtable",
  "mtr",
  "mtd",
  "maligngroup",
  "malignmark",
  "menclose",
  "mstyle",
  "mpadded",
  "mphantom",
  "mfenced",
  "semantics",
]);

const MATHML_ATTRS = new Set([
  "xmlns",
  "display",
  "dir",
  "mathvariant",
  "mathsize",
  "mathcolor",
  "mathbackground",
  "form",
  "fence",
  "separator",
  "stretchy",
  "symmetric",
  "maxsize",
  "minsize",
  "largeop",
  "movablelimits",
  "accent",
  "accentunder",
  "linethickness",
  "bevelled",
  "notation",
  "columnalign",
  "rowalign",
  "columnspacing",
  "rowspacing",
  "columnspan",
  "rowspan",
  "scriptlevel",
  "displaystyle",
  "depth",
  "height",
  "width",
  "lspace",
  "rspace",
  "voffset",
]);

function MathMl({ source, display }: { source: string; display: boolean }) {
  const rendered = renderMathMl(source);
  if (!rendered) {
    return <code className="mathml-fallback">{source}</code>;
  }
  return (
    <span className={display ? "mathml-block" : "mathml-inline"}>
      {rendered}
    </span>
  );
}

function renderMathMl(source: string): ReactNode | null {
  if (typeof DOMParser === "undefined") return null;
  const doc = new DOMParser().parseFromString(source, "application/xml");
  if (doc.getElementsByTagName("parsererror").length > 0) return null;
  const root = doc.documentElement;
  if (!root || root.localName.toLowerCase() !== "math") return null;
  return mathElementToReact(root, 0);
}

function mathElementToReact(node: ChildNode, key: number): ReactNode {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent;
  if (node.nodeType !== Node.ELEMENT_NODE) return null;
  const el = node as Element;
  const tag = el.localName.toLowerCase();
  if (tag === "annotation" || tag === "annotation-xml" || !MATHML_TAGS.has(tag)) {
    return null;
  }
  const attrs: Record<string, string | number> = {};
  for (const attr of Array.from(el.attributes)) {
    const name = attr.name.toLowerCase();
    if (
      name.startsWith("on") ||
      name.includes(":") ||
      name === "href" ||
      name === "src" ||
      name === "style" ||
      !MATHML_ATTRS.has(name)
    ) {
      continue;
    }
    attrs[name] = attr.value;
  }
  const children = Array.from(el.childNodes)
    .map((child, childIndex) => mathElementToReact(child, childIndex))
    .filter((child) => child !== null);
  return createElement(tag, { ...attrs, key }, children);
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
