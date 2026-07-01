// Clickable paper card rendered from a search tool result. arXiv and
// open-access results open the in-app preview; non-previewable results render
// a 3-button fallback (Upload Local PDF / Import from Zotero / Open source
// page) so the user can bring a paywalled/off-arXiv PDF in themselves.

import type { Paper } from "../types";
import { openTarget, resolvePaperId } from "../lib/paperSource";
import { useUi } from "../store/ui";

const SOURCE_BADGE: Record<string, string> = {
  arxiv: "arXiv",
  openalex: "OpenAlex",
  s2: "S2",
  upload: "Upload",
  zotero: "Zotero",
};

export function PaperCard({ paper, onClick }: { paper: Paper; onClick: () => void }) {
  const target = openTarget(paper);
  const openDialog = useUi((s) => s.openLocalPaperDialog);
  const badge = paper.source ? SOURCE_BADGE[paper.source] ?? paper.source : "arXiv";
  const authors = `${paper.authors.slice(0, 4).join(", ")}${paper.authors.length > 4 ? " et al." : ""}`;
  const idLabel = paper.arxiv_id || paper.doi || "";

  const meta = (
    <div className="paper-card-meta">
      <span className="paper-id">{idLabel}</span>
      <span className="paper-cat">{badge}</span>
      {paper.primary_category && <span className="paper-cat">{paper.primary_category}</span>}
      {paper.published && <span className="paper-date">{paper.published.slice(0, 7)}</span>}
    </div>
  );
  const abstract = (
    <div className="paper-card-abstract">
      {paper.abstract.slice(0, 240)}{paper.abstract.length > 240 ? "…" : ""}
    </div>
  );

  // Unfetchable in-app: paywalled / off-arXiv / no OA URL. The card body has no
  // click handler; the three action buttons drive the Open Local Paper dialog
  // (pre-seeded with this paper's metadata so the upload attaches bytes to the
  // EXISTING global Paper row) or open the external landing page.
  if (target.kind === "unfetchable") {
    const preset = {
      paperId: paper.arxiv_id || resolvePaperId(paper),
      title: paper.title,
      authors: paper.authors,
      ...(paper.doi ? { doi: paper.doi } : {}),
      ...(target.externalUrl ? { externalUrl: target.externalUrl } : {}),
    };
    return (
      <div className="paper-card paper-card-unfetchable">
        <div className="paper-card-title">{paper.title}</div>
        <div className="paper-card-authors">{authors}</div>
        {meta}
        {abstract}
        <div className="paper-card-actions">
          <button className="paper-action" onClick={() => openDialog({ preset, tab: "upload" })}>
            📤 Upload Local PDF
          </button>
          <button className="paper-action" onClick={() => openDialog({ preset, tab: "zotero" })}>
            📥 Import from Zotero
          </button>
          {target.externalUrl && (
            <button
              className="paper-action"
              onClick={() => window.open(target.externalUrl, "_blank", "noopener,noreferrer")}
            >
              ↗ Open source page
            </button>
          )}
        </div>
      </div>
    );
  }

  const previewable = target.kind === "arxiv" || target.kind === "oa";
  return (
    <button className="paper-card" onClick={onClick}>
      <div className="paper-card-title">{paper.title}</div>
      <div className="paper-card-authors">{authors}</div>
      {meta}
      {abstract}
      <div className="paper-card-cta">{previewable ? "Click to preview PDF →" : "Open externally →"}</div>
    </button>
  );
}
