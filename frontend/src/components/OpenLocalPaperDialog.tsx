// "Open Local Paper" dialog — bring a paywalled / off-arXiv PDF into the app.
//
// Two tabs sharing one backend local-storage + serve mechanism:
//   - Upload: pick a PDF → pdf.js parses embedded metadata → review/edit form
//     → upload → PaperView. Optional [Try LLM enrichment] fills the form from
//     the first page's text via the configured provider.
//   - Zotero: search the user's Zotero library → pick an item → the backend
//     downloads its PDF attachment → PaperView. No-attachment items prompt
//     the user to fall back to manual upload.
//
// When opened from an unfetchable PaperCard, `preset` carries that paper's
// metadata (title/authors/doi/externalUrl) so the upload attaches bytes to the
// EXISTING global Paper row instead of creating a duplicate.

import { useState, useRef, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import * as pdfjsLib from "pdfjs-dist";
import PdfWorker from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { useUi } from "../store/ui";
import { useSettings } from "../store/settings";
import {
  uploadPaper,
  importFromZotero,
  zoteroSearchItems,
  completeChat,
  type UploadResult,
  type ZoteroItem,
} from "../lib/api";

import "./OpenLocalPaperDialog.css";

pdfjsLib.GlobalWorkerOptions.workerSrc = PdfWorker;

type Tab = "upload" | "zotero";

export function OpenLocalPaperDialog() {
  const dlg = useUi((s) => s.localPaperDialog);
  if (!dlg.open) return null;
  return <DialogBody initialTab={dlg.initialTab ?? "upload"} preset={dlg.preset} />;
}

function DialogBody({
  initialTab,
  preset,
}: {
  initialTab: Tab;
  preset?: import("../store/ui").LocalPaperPreset;
}) {
  const close = useUi((s) => s.closeLocalPaperDialog);
  const [tab, setTab] = useState<Tab>(initialTab);

  return (
    <div className="lpd-overlay" onClick={close}>
      <div className="lpd-card" onClick={(e) => e.stopPropagation()}>
        <div className="lpd-head">
          <span className="lpd-title">Open Paper</span>
          <button className="lpd-close" onClick={close}>×</button>
        </div>
        <div className="lpd-tabs">
          <button className={`lpd-tab ${tab === "upload" ? "active" : ""}`} onClick={() => setTab("upload")}>Upload Local PDF</button>
          <button className={`lpd-tab ${tab === "zotero" ? "active" : ""}`} onClick={() => setTab("zotero")}>Import from Zotero</button>
        </div>
        {tab === "upload" ? (
          <UploadTab preset={preset} onDone={close} />
        ) : (
          <ZoteroTab preset={preset} onDone={close} onSwitchToUpload={() => setTab("upload")} />
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Upload tab
// ---------------------------------------------------------------------------

interface Meta { title: string; authors: string; abstract: string; doi: string; }

function emptyMeta(preset?: import("../store/ui").LocalPaperPreset): Meta {
  return {
    title: preset?.title ?? "",
    authors: (preset?.authors ?? []).join("; "),
    abstract: "",
    doi: preset?.doi ?? "",
  };
}

function UploadTab({
  preset,
  onDone,
}: {
  preset?: import("../store/ui").LocalPaperPreset;
  onDone: () => void;
}) {
  const navigate = useNavigate();
  const provider = useSettings((s) => s.getProvider(null));
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [meta, setMeta] = useState<Meta>(() => emptyMeta(preset));
  const [editing, setEditing] = useState(false);
  const [parsing, setParsing] = useState(false);
  const [enriching, setEnriching] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function parsePdf(f: File) {
    setParsing(true);
    setError(null);
    try {
      const buf = await f.arrayBuffer();
      const doc = await pdfjsLib.getDocument({ data: buf }).promise;
      const md = await doc.getMetadata();
      const info = (md?.info ?? {}) as Record<string, unknown>;
      const next: Meta = { ...emptyMeta(preset) };
      // PDF Info dict: Title / Author / Subject. Academic PDFs often have a
      // Title (sometimes wrong) but rarely an abstract in Subject.
      const t = str(info.Title);
      if (t && !next.title) next.title = t;
      const a = str(info.Author);
      if (a && !next.authors) next.authors = a;
      const s = str(info.Subject);
      if (s && !next.abstract) next.abstract = s;
      // DOI: publisher/arXiv PDFs often embed it in the Info dict (as a URL).
      const doiRaw = str(info.DOI) || str(info.doi);
      if (doiRaw && !next.doi) {
        let d = doiRaw.trim().toLowerCase();
        for (const p of ["https://doi.org/", "http://doi.org/", "doi:"]) {
          if (d.startsWith(p)) { d = d.slice(p.length); break; }
        }
        if (d) next.doi = d;
      }
      // No DOI but an arXiv id -> synthesize the arXiv DOI (10.48550/arxiv.<id>).
      if (!next.doi) {
        const axRaw = str(info.arXivID) || str(info.arxiv_id) || str(info.arXiv);
        if (axRaw) {
          const m = axRaw.match(/(\d{4}\.\d{4,5})/);
          if (m) next.doi = `10.48550/arxiv.${m[1]}`;
        }
      }
      // Page-1 text: a second pass for DOI/abstract the Info dict lacks.
      // pdf.js already parsed the PDF here, so this is cheap and gives the user
      // real values immediately (no LLM round-trip needed for the common case).
      try {
        const page = await doc.getPage(1);
        const tc = await page.getTextContent();
        const pageText = tc.items
          .map((i) => ("str" in i ? i.str : ""))
          .join(" ")
          .replace(/\s+/g, " ");
        if (!next.doi) {
          const dm = pageText.match(/\b10\.\d{4,9}\/[^\s"<>]+/);
          if (dm) next.doi = dm[0].replace(/[.,;)\]]+$/, "");
        }
        if (!next.abstract) {
          const am = pageText.match(
            /(?:Abstract|ABSTRACT)\s*[:：]?\s*([\s\S]{40,2500}?)(?=\s*(?:Keywords|Index Terms|Introduction|1\.\s*Introduction|I\.\s*Introduction))/
          );
          if (am) next.abstract = am[1].trim().slice(0, 2000);
        }
      } catch {
        /* best-effort — page-1 text is optional */
      }
      // Filename stem is a decent last-resort title.
      if (!next.title) next.title = f.name.replace(/\.pdf$/i, "");
      setMeta(next);
    } catch {
      // Not a real PDF / pdf.js can't read it. Keep the form empty so the user
      // can still type metadata; the upload itself will reject a non-PDF.
      if (!meta.title) setMeta({ ...emptyMeta(preset), title: f.name.replace(/\.pdf$/i, "") });
    } finally {
      setParsing(false);
    }
  }

  function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    setFile(f);
    void parsePdf(f);
    e.target.value = "";
  }

  async function enrich() {
    if (!file || !provider) return;
    setEnriching(true);
    setError(null);
    try {
      const buf = await file.arrayBuffer();
      const doc = await pdfjsLib.getDocument({ data: buf }).promise;
      const page = await doc.getPage(1);
      const tc = await page.getTextContent();
      const pageText = tc.items.map((i) => ("str" in i ? i.str : "")).join(" ").slice(0, 3000);
      const raw = await completeChat({
        provider,
        messages: [
          { role: "system", content: "Extract paper metadata from the given first-page text. Respond with ONLY a JSON object (no markdown fences, no prose): {\"title\": string, \"authors\": string[], \"abstract\": string, \"doi\": string}. Omit a field if not present." },
          { role: "user", content: `First page text:\n${pageText}` },
        ],
      });
      // LLMs often wrap JSON in ```json fences or add surrounding prose; extract
      // the {...} substring before parsing so a fenced reply doesn't crash this.
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      const parsed = (jsonMatch ? JSON.parse(jsonMatch[0]) : JSON.parse(raw)) as Partial<Meta>;
      setMeta((m) => ({
        title: parsed.title || m.title,
        authors: Array.isArray(parsed.authors) ? parsed.authors.join("; ") : m.authors,
        abstract: parsed.abstract || m.abstract,
        doi: parsed.doi || m.doi,
      }));
    } catch (e) {
      setError(
        `LLM enrichment failed: ${(e as Error).message || "unknown error"}. You can edit the metadata by hand.`
      );
    } finally {
      setEnriching(false);
    }
  }

  async function upload() {
    if (!file) { setError("Pick a PDF first."); return; }
    setUploading(true);
    setError(null);
    try {
      const r: UploadResult = await uploadPaper({
        file,
        title: meta.title || undefined,
        authors: meta.authors ? meta.authors.split(";").map((s) => s.trim()).filter(Boolean) : undefined,
        abstract: meta.abstract || undefined,
        doi: meta.doi || undefined,
      });
      onDone();
      navigate(`/paper/${encodeURIComponent(r.paper_id)}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="lpd-body">
      <input ref={fileRef} type="file" accept="application/pdf" onChange={onPick} style={{ display: "none" }} />
      <button className="lpd-pick" onClick={() => fileRef.current?.click()} disabled={uploading}>
        {file ? `📄 ${file.name}` : "Choose PDF…"}
      </button>

      {file && (
        <>
          {parsing && <div className="lpd-hint">Reading PDF metadata…</div>}
          <div className="lpd-meta">
            <label>Title<input value={meta.title} disabled={!editing} onChange={(e) => setMeta({ ...meta, title: e.target.value })} /></label>
            <label>Authors (semicolon-separated)<input value={meta.authors} disabled={!editing} onChange={(e) => setMeta({ ...meta, authors: e.target.value })} /></label>
            <label>Abstract<textarea value={meta.abstract} disabled={!editing} rows={3} onChange={(e) => setMeta({ ...meta, abstract: e.target.value })} /></label>
            <label>DOI<input value={meta.doi} disabled={!editing} onChange={(e) => setMeta({ ...meta, doi: e.target.value })} /></label>
          </div>
          <div className="lpd-actions">
            <button className="lpd-btn" onClick={() => setEditing((v) => !v)} disabled={uploading || enriching}>
              {editing ? "Done editing" : "Edit metadata"}
            </button>
            <button className="lpd-btn" onClick={enrich} disabled={!provider || enriching || uploading}>
              {enriching ? "Enriching…" : "Try LLM enrichment"}
            </button>
            <button className="lpd-btn lpd-primary" onClick={upload} disabled={uploading || enriching}>
              {uploading ? "Uploading…" : "Looks good, open paper"}
            </button>
          </div>
          {!provider && <div className="lpd-hint">No default provider — LLM enrichment is unavailable. Add one in Settings.</div>}
        </>
      )}
      {error && <div className="lpd-error">{error}</div>}
    </div>
  );
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

// ---------------------------------------------------------------------------
// Zotero tab
// ---------------------------------------------------------------------------

function ZoteroTab({
  preset,
  onDone,
  onSwitchToUpload,
}: {
  preset?: import("../store/ui").LocalPaperPreset;
  onDone: () => void;
  onSwitchToUpload: () => void;
}) {
  const navigate = useNavigate();
  const zotero = useSettings((s) => s.zotero);
  const [query, setQuery] = useState(preset?.title ?? "");
  const [results, setResults] = useState<ZoteroItem[]>([]);
  const [searching, setSearching] = useState(false);
  const [importing, setImporting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [searched, setSearched] = useState(false);

  const configured = !!(zotero.userId && zotero.apiKey && zotero.mode);

  async function search(e?: React.FormEvent) {
    e?.preventDefault();
    if (!configured) { setError("Configure Zotero (mode/userId/apiKey) in Settings first."); return; }
    setSearching(true);
    setError(null);
    try {
      const r = await zoteroSearchItems({ mode: zotero.mode, userId: zotero.userId, apiKey: zotero.apiKey }, query, 25, "titleCreatorYear");
      setResults(r.results);
      setSearched(true);
    } catch (e2) {
      setError((e2 as Error).message);
    } finally {
      setSearching(false);
    }
  }

  // Auto-run the initial search when a preset title is provided.
  useEffect(() => {
    if (preset?.title && configured) void search();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function importItem(item: ZoteroItem) {
    setImporting(item.key);
    setError(null);
    try {
      const r = await importFromZotero(item.key);
      onDone();
      navigate(`/paper/${encodeURIComponent(r.paper_id)}`);
    } catch (e) {
      const msg = (e as Error).message;
      if (/no PDF attachment|400/i.test(msg)) {
        setError(`"${item.title}" has no PDF attachment. Try manual upload.`);
      } else {
        setError(msg);
      }
    } finally {
      setImporting(null);
    }
  }

  return (
    <div className="lpd-body">
      {!configured && (
        <div className="lpd-hint">Zotero isn't configured. Set mode/userId/apiKey in Settings first.</div>
      )}
      <form className="lpd-search" onSubmit={search}>
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search your Zotero library…" disabled={!configured || searching} />
        <button className="lpd-btn" type="submit" disabled={!configured || searching}>{searching ? "Searching…" : "Search"}</button>
      </form>
      <div className="lpd-results">
        {results.map((it) => (
          <div key={it.key} className="lpd-result">
            <div className="lpd-result-title">{it.title}</div>
            <div className="lpd-result-sub">{it.creators}{it.year ? ` (${it.year})` : ""}</div>
            <button className="lpd-btn lpd-primary" onClick={() => importItem(it)} disabled={importing !== null}>
              {importing === it.key ? "Importing…" : "Import PDF"}
            </button>
          </div>
        ))}
        {searched && results.length === 0 && !searching && (
          <div className="lpd-hint">No items matched. Try a different query.</div>
        )}
      </div>
      {error && (
        <div className="lpd-error">
          {error}{" "}
          {/no PDF attachment|manual upload/i.test(error) && (
            <button className="lpd-btn" onClick={onSwitchToUpload}>Go to Upload</button>
          )}
        </div>
      )}
    </div>
  );
}
