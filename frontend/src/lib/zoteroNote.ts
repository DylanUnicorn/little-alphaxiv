// Build a Zotero child note from a paper's PDF annotations, and locate the
// paper's Zotero item. Used by the "Create Note from Annotations" sync engine
// (hooks/useZoteroNoteSync) which continuously pushes the user's highlights +
// text notes to a single child note under the paper in Zotero (web mode only).

import type { Annotation, NormRect, Paper } from "../types";
import { zoteroSearchItems, type ZoteroCreds } from "./api";

/** Fixed tag stamped on the annotations note so we can rediscover it across
 *  sessions (and avoid clobbering the user's other notes, or the provenance
 *  card that "Add to Zotero" attaches). Must match the backend default. */
export const ANNOT_NOTE_TAG = "little-alphaxiv-annotations";

/** A text resolver recovers the text under a page-normalized rect list (used
 *  as a fallback for highlights created before this feature stored selected
 *  text, and for rect annotations). Defined here as the canonical type;
 *  lib/highlightRecovery implements it over pdf.js. */
export type TextResolver = (page: number, rects: NormRect[]) => Promise<string>;

/** Strip a trailing version so 2401.07041v1 matches 2401.07041. */
export function normArxiv(id: string): string {
  return (id || "").trim().replace(/v\d+$/, "").toLowerCase();
}

function escapeHtml(s: string): string {
  return (s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Find the Zotero item key for an arXiv paper: search the library for the
 *  arxiv id and match on the normalized id, falling back to an exact title
 *  match. Returns "" if not found. Mirrors ZoteroPanel.findCurrentPaper but
 *  returns just the key for the sync engine. */
export async function findZoteroPaperKey(
  creds: ZoteroCreds,
  arxivId: string,
  title = ""
): Promise<string> {
  if (!arxivId) return "";
  try {
    const r = await zoteroSearchItems(creds, arxivId, 25);
    const byId = r.results.filter((it) => normArxiv(it.arxivId) === normArxiv(arxivId));
    if (byId[0]?.key) return byId[0].key;
  } catch {
    /* fall through to title search */
  }
  if (title) {
    try {
      const r = await zoteroSearchItems(creds, title.slice(0, 80), 25);
      const byTitle = r.results.filter(
        (it) => it.title.trim().toLowerCase() === title.trim().toLowerCase()
      );
      if (byTitle[0]?.key) return byTitle[0].key;
    } catch {
      /* give up */
    }
  }
  return "";
}

/** A single note-ready annotation: the text to show + enough to sort/place it. */
export interface NoteEntry {
  page: number;
  color: string;
  text: string;
  kind: "highlight" | "text" | "rect";
  createdAt: number;
  /** vertical position (0..1) on the page, for reading-order sort. */
  top: number;
}

/** Rects whose text a resolver should recover, per annotation type. */
function annotRects(a: Annotation): NormRect[] {
  if (a.type === "highlight") return a.highlight?.rects ?? [];
  if (a.type === "rect" && a.rect) return [a.rect];
  return [];
}

/** Resolve the text for a single annotation. Text annotations use their
 *  `content` directly; highlights prefer their captured `content` (set at
 *  creation); highlights/rects without captured text fall back to `resolver`.
 *  Returns "" if nothing recoverable. */
async function resolveText(a: Annotation, resolver: TextResolver): Promise<string> {
  if (a.type === "text") return (a.text?.content || "").trim();
  const captured = (a.highlight?.content || "").trim();
  if (captured) return captured;
  const rects = annotRects(a);
  if (rects.length === 0) return "";
  try {
    return (await resolver(a.page, rects)).trim();
  } catch {
    return "";
  }
}

/** Gather note-ready entries from annotations, recovering text for highlights/
 *  rects that lack a captured `content`. Draw annotations are skipped (no
 *  meaningful text region). Entries with no recoverable text are skipped.
 *  Sorted in reading order: page, then vertical position, then creation time. */
export async function gatherNoteEntries(
  annots: Annotation[],
  resolver: TextResolver
): Promise<NoteEntry[]> {
  const out: NoteEntry[] = [];
  for (const a of annots) {
    if (a.type === "draw") continue;
    const text = await resolveText(a, resolver);
    if (!text) continue;
    const top =
      a.type === "highlight"
        ? a.highlight?.rects?.[0]?.y ?? 0
        : a.type === "rect"
          ? a.rect?.y ?? 0
          : a.text?.y ?? 0;
    out.push({
      page: a.page,
      color: a.color,
      text,
      kind: a.type,
      createdAt: a.createdAt,
      top,
    });
  }
  out.sort((a, b) => a.page - b.page || a.top - b.top || a.createdAt - b.createdAt);
  return out;
}

/** Render the annotations note as Zotero-note HTML (a child note's `note`
 *  field). Groups entries by page with colored blockquotes (highlights/rects)
 *  and note paragraphs (text annotations). Pure + synchronous for testability.
 *  `paper` is the cached IDB record (may be a bare-id stub). */
export function renderNoteHtml(
  paper: (Paper & { full_text?: string; fetched_at: number }) | null | undefined,
  entries: NoteEntry[],
  now: number
): string {
  const arxivId = paper?.arxiv_id || "";
  const title =
    paper?.title && paper.title !== arxivId
      ? paper.title
      : arxivId
        ? `arXiv:${arxivId}`
        : "Untitled";
  const stamp = new Date(now).toISOString().slice(0, 16).replace("T", " ");
  const parts: string[] = [
    "<!-- little-alphaxiv-annotations-note -->",
    `<h1>Annotations — ${escapeHtml(title)}</h1>`,
    `<p><i>Auto-generated from Little Alphaxiv · ${
      arxivId ? `arXiv:${escapeHtml(arxivId)} · ` : ""
    }${entries.length} annotation${entries.length === 1 ? "" : "s"} · updated ${stamp}</i></p>`,
  ];
  let lastPage = -1;
  for (const e of entries) {
    if (e.page !== lastPage) {
      parts.push(`<h2>Page ${e.page}</h2>`);
      lastPage = e.page;
    }
    const body = escapeHtml(e.text);
    if (e.kind === "text") {
      parts.push(
        `<p style="margin:6px 0;padding:4px 8px;border-left:4px solid ${escapeHtml(
          e.color
        )};"><b>📝 Note:</b> ${body}</p>`
      );
    } else {
      parts.push(
        `<blockquote style="margin:6px 0;padding:2px 8px;border-left:4px solid ${escapeHtml(
          e.color
        )};">${body}</blockquote>`
      );
    }
  }
  if (entries.length === 0) {
    parts.push("<p><i>No annotations yet.</i></p>");
  }
  return parts.join("");
}
