// Paper view (Flow B): two-panel layout with a draggable divider.
// left -> PdfViewer, right -> ChatToolbar + (ChatPanel | HistoryPanel)
//
// Conversation model:
//   - A paper can have many threads (sub-conversations). They all group into
//     ONE left-sidebar entry per paper (see Sidebar).
//   - Threads are managed here via the HistoryPanel (toggle from the toolbar),
//     not as separate sidebar rows.
//   - Empty threads live in memory only; the first message persists them and
//     re-titles them to the user's question. "New conversation" reuses an
//     existing empty thread instead of stacking empties.

import { useCallback, useEffect, useRef, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { PdfViewer } from "../components/PdfViewer";
import { ChatPanel } from "../components/ChatPanel";
import { ChatToolbar } from "../components/ChatToolbar";
import { HistoryPanel } from "../components/HistoryPanel";
import { useConversations } from "../store/conversations";
import { useSettings } from "../store/settings";
import { useUi } from "../store/ui";
import { useAnnotations } from "../store/annotations";
import { pdfUrlForOa, paperUploadUrl } from "../lib/api";
import * as db from "../lib/db";
import { ensurePaperMeta, hasRealTitle } from "../lib/paperMeta";
import type { StylePreset } from "../types";

export function PaperView() {
  const { arxivId, convId } = useParams<{ arxivId: string; convId?: string }>();
  const navigate = useNavigate();
  const conversations = useConversations((s) => s.conversations);
  const loaded = useConversations((s) => s.loaded);
  const create = useConversations((s) => s.create);
  const setActive = useConversations((s) => s.setActive);
  const updateSettings = useConversations((s) => s.updateSettings);
  const defaultProviderId = useSettings((s) => s.defaultProviderId);
  const collapseSidebar = useUi((s) => s.collapseSidebar);
  const [convIdState, setConvId] = useState<string | null>(convId ?? null);
  const [fullText, setFullText] = useState<string | null>(null);
  const [extracting, setExtracting] = useState(true);
  const [pdfUrlOverride, setPdfUrlOverride] = useState<string | undefined>(undefined);
  const [showHistory, setShowHistory] = useState(false);
  const initRef = useRef<string | null>(null);

  useEffect(() => { collapseSidebar(); }, [collapseSidebar]);

  useEffect(() => {
    if (!arxivId) return;
    let cancelled = false;
    db.getPaper(arxivId).then(async (p) => {
      if (cancelled) return;
      if (p?.full_text) { setFullText(p.full_text); setExtracting(false); }
      if (p?.oa_pdf_url) setPdfUrlOverride(pdfUrlForOa(p.oa_pdf_url));
      else if (p?.source === "upload" || p?.source === "zotero")
        // User-private PDF (uploaded or Zotero-imported): serve via the
        // auth-gated per-user upload endpoint instead of arXiv/pdf-url.
        setPdfUrlOverride(paperUploadUrl(arxivId));
      // Direct-URL navigation (bookmark / refresh / external link) can leave a
      // bare-id stub: title = arxivId, no authors/abstract/DOI. Fetch the real
      // arXiv metadata so the chat-title context, sidebar, and Zotero "add"
      // all see the actual paper instead of the bare id. Best-effort.
      if (!hasRealTitle(p, arxivId)) await ensurePaperMeta(arxivId);
    });
    return () => { cancelled = true; };
  }, [arxivId]);

  const loadAnnots = useAnnotations((s) => s.load);
  useEffect(() => {
    if (!arxivId) return;
    loadAnnots(arxivId);
  }, [arxivId, loadAnnots]);

  // Resolve which thread to show once data is loaded (or on paper change).
  // Uses a ref guard so message appends / thread switches don't re-trigger.
  useEffect(() => {
    if (!arxivId || !loaded) return;
    if (initRef.current === arxivId) return;
    initRef.current = arxivId;

    // Validate the URL's convId (it may be stale if it was an un-persisted
    // empty thread from a previous session).
    if (convId) {
      const c = conversations.find(
        (x) => x.id === convId && x.type === "paper" && x.paper_id === arxivId
      );
      if (c) { setActive(convId); setConvId(convId); return; }
    }
    // Pick the most-recently-touched thread for this paper.
    const threads = conversations
      .filter((c) => c.type === "paper" && c.paper_id === arxivId)
      .sort((a, b) => b.updated_at - a.updated_at);
    if (threads[0]) {
      setActive(threads[0].id);
      setConvId(threads[0].id);
      navigate(`/paper/${arxivId}/${threads[0].id}`, { replace: true });
      return;
    }
    // No thread yet — create an empty one (in-memory until first message).
    create({
      type: "paper",
      paperId: arxivId,
      title: `📄 ${arxivId}`,
      reuseEmpty: true,
      providerId: defaultProviderId ?? undefined,
    }).then((c) => {
      setActive(c.id);
      setConvId(c.id);
      navigate(`/paper/${arxivId}/${c.id}`, { replace: true });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [arxivId, loaded]);

  // Keep local state in sync when the URL convId changes (history panel nav).
  useEffect(() => {
    if (convId && convId !== convIdState) setConvId(convId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [convId]);

  const onTextExtracted = useCallback((text: string) => {
    setFullText(text); setExtracting(false);
    if (!arxivId) return;
    void (async () => {
      // Ensure real metadata (fetches from arXiv if this is a bare-id stub),
      // then persist the freshly extracted full_text on top. Never fall back to
      // `title = arxivId` — that was the bug that made Zotero items (and the
      // sidebar) show the bare id instead of the paper's real title.
      const enriched = await ensurePaperMeta(arxivId);
      if (enriched) {
        await db.savePaper({ ...enriched, full_text: text, fetched_at: Date.now() });
      } else {
        // Nothing cached and arXiv unreachable — store the text in a minimal
        // record; the Zotero backend re-fetches metadata at add-time anyway.
        await db.savePaper({ arxiv_id: arxivId, title: "", authors: [], abstract: "", pdf_url: "", abs_url: "", published: "", primary_category: "", full_text: text, fetched_at: Date.now() });
      }
    })();
  }, [arxivId]);

  const systemPrompt = fullText
    ? PAPER_SYSTEM_PREAMBLE(arxivId!) + `\n\n=== PAPER FULL TEXT ===\n${fullText}\n=== END ===`
    : PAPER_SYSTEM_PREAMBLE(arxivId!) + `\n\n[Note: full paper text is still loading; answer based on what you can.]`;

  function handleNewConversation() {
    if (!arxivId) return;
    create({
      type: "paper",
      paperId: arxivId,
      title: `📄 ${arxivId}`,
      reuseEmpty: true, // reuse an existing empty thread if present
      providerId: defaultProviderId ?? undefined,
    }).then((c) => {
      setActive(c.id);
      setConvId(c.id);
      navigate(`/paper/${arxivId}/${c.id}`, { replace: true });
      setShowHistory(false);
    });
  }

  function handleSelectConversation(id: string) {
    setActive(id);
    setConvId(id);
    if (arxivId) navigate(`/paper/${arxivId}/${id}`, { replace: true });
    setShowHistory(false);
  }

  if (!arxivId) return null;

  return (
    <main className="main-pane paper-view">
      <ResizablePanels
        left={<PdfViewer arxivId={arxivId} pdfUrlOverride={pdfUrlOverride} onTextExtracted={onTextExtracted} />}
        right={
          <div className="chat-col-inner">
            {convIdState && (
              <ChatToolbar
                conversationId={convIdState}
                arxivId={arxivId}
                showHistory={showHistory}
                onToggleHistory={() => setShowHistory((v) => !v)}
                onNewConversation={handleNewConversation}
                onStyleChange={(s: StylePreset) => updateSettings(convIdState, { style_preset: s })}
              />
            )}
            {showHistory ? (
              <HistoryPanel
                arxivId={arxivId}
                activeId={convIdState}
                onSelect={handleSelectConversation}
                onNew={handleNewConversation}
                onClose={() => setShowHistory(false)}
              />
            ) : (
              <>
                {extracting && <div className="paper-status">Reading paper for context...</div>}
                {convIdState ? (
                  <ChatPanel conversationId={convIdState} systemPrompt={systemPrompt} showPaperLinks={false} />
                ) : (
                  <div className="chat-shell"><div className="chat-empty">Starting discussion...</div></div>
                )}
              </>
            )}
          </div>
        }
      />
    </main>
  );
}

function ResizablePanels({ left, right }: { left: React.ReactNode; right: React.ReactNode }) {
  const [ratio, setRatio] = useState<number>(() => {
    const saved = Number(localStorage.getItem("lax-paper-ratio"));
    return saved > 0.1 && saved < 0.9 ? saved : 0.58;
  });
  const containerRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const lastX = useRef(0);
  const rafId = useRef<number | null>(null);

  // Drag listeners attach ONCE (no ratio dep) so we don't tear down and
  // re-add them on every mousemove. During drag we mutate the --paper-ratio
  // CSS variable directly (coalesced to one update per animation frame), which
  // resizes both columns with zero React re-renders. The final ratio is
  // committed to state on mouseup for persistence + a single re-render.
  useEffect(() => {
    function apply() {
      rafId.current = null;
      const el = containerRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const r = Math.max(0.2, Math.min(0.8, (lastX.current - rect.left) / rect.width));
      el.style.setProperty("--paper-ratio", String(r));
    }
    function onMove(e: MouseEvent) {
      if (!dragging.current) return;
      lastX.current = e.clientX;
      if (rafId.current == null) rafId.current = requestAnimationFrame(apply);
    }
    function onUp() {
      if (!dragging.current) return;
      dragging.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      if (rafId.current != null) { cancelAnimationFrame(rafId.current); rafId.current = null; }
      const el = containerRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const r = Math.max(0.2, Math.min(0.8, (lastX.current - rect.left) / rect.width));
      setRatio(r);
      localStorage.setItem("lax-paper-ratio", String(r));
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      if (rafId.current != null) cancelAnimationFrame(rafId.current);
    };
  }, []);

  return (
    <div
      className="resizable-panels"
      ref={containerRef}
      style={{ "--paper-ratio": ratio } as React.CSSProperties}
    >
      <div className="pdf-col">{left}</div>
      <div
        className="panel-divider"
        onMouseDown={() => {
          dragging.current = true;
          document.body.style.cursor = "col-resize";
          document.body.style.userSelect = "none";
        }}
      >
        <div className="panel-divider-grip" />
      </div>
      <div className="chat-col">{right}</div>
    </div>
  );
}

function PAPER_SYSTEM_PREAMBLE(paperId: string): string {
  return `You are a research assistant helping the user read and understand the paper ${paperId}.
The user can see the PDF on the left and is chatting with you on the right.
The full text of the paper is provided below. Answer questions about its content - methods, datasets, results, limitations, related work - grounded in the provided text.
If the user asks something not covered in the paper, say so. Be concise and precise. Format answers with markdown.
You have paper-search tools (search_arxiv, and optionally search_openalex / search_semantic_scholar) if the user wants to find related papers. If those don't surface what the user needs, fall back to web_search (general web search via anysearch) — useful for related IEEE/ACM/Springer papers, paywalled work, or a DOI/title-only lookup; non-arXiv results cite by URL and open externally.`;
}
