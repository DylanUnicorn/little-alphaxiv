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

export function ChatView() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const conversations = useConversations((s) => s.conversations);
  const loaded = useConversations((s) => s.loaded);

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
        <ChatPanel conversationId={id} systemPrompt={GENERAL_SYSTEM_PROMPT} />
      </div>
    </main>
  );
}

export const GENERAL_SYSTEM_PROMPT = `You are a helpful research assistant integrated into a paper-reading app.
Help the user find academic papers on arXiv using the search_arxiv tool.
When the user asks for papers on a topic, call search_arxiv with concise keywords.
After results return, summarize the most relevant ones in 1-2 sentences each and let the user click to preview.
You can also use web_search for non-academic questions.
Be concise. Prefer calling search_arxiv over answering from memory when the user wants papers.
Any arxiv.org links you write render as in-app preview cards the user can click to read the paper — so citing a paper by its arXiv link is fine and never opens an external site.`;
