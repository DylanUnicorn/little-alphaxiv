// General chat view (Flow A): chat with the assistant to find papers.
// The assistant surfaces clickable paper cards; clicking opens PaperView.
//
// If the URL id is stale (e.g. an un-persisted empty chat from a previous
// session that vanished on reload), redirect to root, which spins up a fresh
// general chat.

import { useEffect } from "react";
import { useParams, Navigate, useNavigate } from "react-router-dom";
import { ChatPanel } from "../components/ChatPanel";
import { useConversations } from "../store/conversations";
import { useSettings } from "../store/settings";

/** Build the general-chat system prompt from the user's enabled search sources.
 *  arXiv is always available; OpenAlex / Semantic Scholar tools appear only
 *  when enabled, so the prompt tells the model which sources it has. */
export function buildGeneralSystemPrompt(sources: { openalex: boolean; s2: boolean }): string {
  const extras: string[] = [];
  if (sources.openalex) extras.push("search_openalex (broad published literature across all fields)");
  if (sources.s2) extras.push("search_semantic_scholar (Semantic Scholar's 214M-paper graph)");
  const sourceLine = extras.length
    ? `You also have ${extras.join(" and ")} for broader or published-literature searches; prefer the most relevant source per query.`
    : "";
  return `You are a helpful research assistant integrated into a paper-reading app.
Help the user find academic papers using the search_arxiv tool (always available).
When the user asks for papers on a topic, call the most fitting search tool with concise keywords.
After results return, summarize the most relevant ones in 1-2 sentences each and let the user click to preview.
${sourceLine}
You also have web_search (general web search via anysearch) — use it as a FALLBACK when the paper-search tools return nothing or can't find the paper the user asked about (e.g. IEEE/ACM/Springer, paywalled, non-arXiv, or when the user only has a DOI or partial title). web_search returns titles, URLs, and snippets; non-arXiv links open externally, so cite them by URL. It also works for non-academic questions (news, blogs, people, products).
Be concise. Prefer calling a paper-search tool over answering from memory when the user wants papers.
Any arxiv.org links you write render as in-app preview cards the user can click to read the paper — so citing a paper by its arXiv link is fine and never opens an external site.
If you surface a paper whose PDF you cannot open in-app (paywalled, non-arXiv without an open-access URL, or the download fails), say so explicitly in natural language and surface the paper anyway — its card shows Upload Local PDF / Import from Zotero / Open source page buttons the user can use to bring it in. Don't go silent. If you find no relevant paper at all, say so and tell the user they can use "+ Open Local Paper" in the sidebar to bring a PDF in.`;
}

/** Backward-compatible default (no extra sources enabled). */
export const GENERAL_SYSTEM_PROMPT = buildGeneralSystemPrompt({ openalex: false, s2: false });

export function ChatView() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const conversations = useConversations((s) => s.conversations);
  const loaded = useConversations((s) => s.loaded);
  const ss = useSettings((s) => s.searchSources);
  const enabledSources = { openalex: ss.openalex.enabled, s2: ss.semanticScholar.enabled };
  const systemPrompt = buildGeneralSystemPrompt(enabledSources);

  useEffect(() => {
    if (!loaded || !id) return;
    if (!conversations.some((c) => c.id === id)) {
      navigate("/", { replace: true });
    }
  }, [loaded, id, conversations, navigate]);

  if (!id) return <Navigate to="/" replace />;
  return (
    <main className="main-pane">
      <div className="chat-shell">
        <ChatPanel conversationId={id} systemPrompt={systemPrompt} />
      </div>
    </main>
  );
}
