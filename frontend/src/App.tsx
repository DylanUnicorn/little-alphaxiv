// App shell: sidebar + routed main pane. Loads conversations on mount.

import { useEffect } from "react";
import { Routes, Route, Navigate, useNavigate } from "react-router-dom";
import { Sidebar } from "./components/Sidebar";
import { OriginBanner } from "./components/OriginBanner";
import { ChatView } from "./views/ChatView";
import { PaperView } from "./views/PaperView";
import { SettingsView } from "./views/SettingsView";
import { useConversations } from "./store/conversations";
import { useSettings } from "./store/settings";
import { redirectTargetForCanonicalHost } from "./lib/origin";

export default function App() {
  const load = useConversations((s) => s.load);
  const create = useConversations((s) => s.create);
  const setActive = useConversations((s) => s.setActive);
  const conversations = useConversations((s) => s.conversations);
  const loaded = useConversations((s) => s.loaded);
  const hasHistory = useConversations((s) => s.hasHistory);
  const navigate = useNavigate();
  const defaultProviderId = useSettings((s) => s.defaultProviderId);

  useEffect(() => {
    load();
  }, [load]);

  // Loopback-origin unification: localhost and 127.0.0.1 are different browser
  // origins with isolated storage. An EMPTY 127.0.0.1 is safe to redirect to
  // the canonical localhost (never strands data); this is the only redirect
  // direction. Runs once after load() completes.
  useEffect(() => {
    if (!loaded) return;
    const target = redirectTargetForCanonicalHost(
      location.hostname,
      location.protocol,
      hasHistory,
      location.origin,
      location.pathname,
      location.search,
      location.hash
    );
    if (target) location.replace(target);
  }, [loaded, hasHistory]);

  // If we arrived on localhost via our own redirect, strip the ?laxredir=1
  // marker so the URL stays clean. The banner reads its presence to suppress
  // itself for this arrival (see OriginBanner / shouldShowOriginBanner).
  useEffect(() => {
    if (!loaded) return;
    if (location.hostname !== "localhost" || location.protocol !== "http:") return;
    const params = new URLSearchParams(location.search);
    if (!params.has("laxredir")) return;
    params.delete("laxredir");
    const qs = params.toString();
    const cleanSearch = qs ? `?${qs}` : "";
    if (cleanSearch !== location.search) {
      history.replaceState(null, "", `${location.pathname}${cleanSearch}${location.hash}`);
    }
  }, [loaded]);

  // On the root path: open the most recent conversation, or create a fresh
  // general chat. Empty chats are never persisted, so after a reload there are
  // no leftover empty "New chat" rows.
  async function ensureRootChat() {
    if (conversations.length > 0) {
      const first = conversations[0];
      setActive(first.id);
      navigate(first.type === "paper" ? `/paper/${first.paper_id}/${first.id}` : `/chat/${first.id}`);
      return;
    }
    const c = await create({ type: "general", providerId: defaultProviderId ?? undefined });
    setActive(c.id);
    navigate(`/chat/${c.id}`);
  }

  return (
    <div className="app">
      <OriginBanner />
      <div className="app-main">
        <Sidebar />
        <Routes>
          <Route path="/" element={<RootLanding loaded={loaded} onMount={ensureRootChat} />} />
          <Route path="/chat/:id" element={<ChatView />} />
          <Route path="/paper/:arxivId" element={<PaperView />} />
          <Route path="/paper/:arxivId/:convId" element={<PaperView />} />
          <Route path="/settings" element={<SettingsView />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </div>
    </div>
  );
}

function RootLanding({ loaded, onMount }: { loaded: boolean; onMount: () => void }) {
  useEffect(() => {
    if (!loaded) return;
    onMount();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded]);
  return <main className="main-pane"><div className="chat-empty">Starting…</div></main>;
}
