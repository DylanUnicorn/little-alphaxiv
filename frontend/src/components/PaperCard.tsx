// Clickable paper card rendered from a search tool result. arXiv and
// open-access results open the in-app preview; non-previewable results open
// their external landing page.

import type { Paper } from "../types";
import { openTarget } from "../lib/paperSource";

const SOURCE_BADGE: Record<string, string> = {
  arxiv: "arXiv",
  openalex: "OpenAlex",
  s2: "S2",
};

export function PaperCard({ paper, onClick }: { paper: Paper; onClick: () => void }) {
  const target = openTarget(paper);
  const previewable = target.kind === "arxiv" || target.kind === "oa";
  const badge = paper.source ? SOURCE_BADGE[paper.source] ?? paper.source : "arXiv";
  return (
    <button className="paper-card" onClick={onClick}>
      <div className="paper-card-title">{paper.title}</div>
      <div className="paper-card-authors">{paper.authors.slice(0, 4).join(", ")}{paper.authors.length > 4 ? " et al." : ""}</div>
      <div className="paper-card-meta">
        <span className="paper-id">{paper.arxiv_id || paper.doi || ""}</span>
        <span className="paper-cat">{badge}</span>
        {paper.primary_category && <span className="paper-cat">{paper.primary_category}</span>}
        {paper.published && (
          <span className="paper-date">{paper.published.slice(0, 7)}</span>
        )}
      </div>
      <div className="paper-card-abstract">{paper.abstract.slice(0, 240)}{paper.abstract.length > 240 ? "…" : ""}</div>
      <div className="paper-card-cta">{previewable ? "Click to preview PDF →" : "Open externally →"}</div>
    </button>
  );
}
