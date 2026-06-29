// App shell: sidebar + routed main pane. Boot authenticates via /api/auth/me;
// unauthenticated users are redirected to /login, authenticated users hydrate
// the stores (settings + conversations + zotero-note-sync) then open a chat.

import { useEffect, useState } from "react";
import { Routes, Route, Navigate, useNavigate } from "react-router-dom";
import { Sidebar } from "./components/Sidebar";
import { ChatView } from "./views/ChatView";
import { PaperView } from "./views/PaperView";
import { SettingsView } from "./views/SettingsView";
import Login from "./pages/Login";
import ForgotPassword from "./pages/ForgotPassword";
import ResetPassword from "./pages/ResetPassword";
import { useConversations } from "./store/conversations";
import { useSettings } from "./store/settings";
import { useZoteroNoteSyncStore } from "./store/zoteroNoteSync";
import * as api from "./lib/api";
import { hasLocalDataToMigrate, importLocalData } from "./lib/migrate";

type BootState = "checking" | "unauthenticated" | "authenticated";

export default function App() {
  const navigate = useNavigate();
  const [boot, setBoot] = useState<BootState>("checking");
  const [migrateOffer, setMigrateOffer] = useState(false);
  const loadConversations = useConversations((s) => s.load);
  const create = useConversations((s) => s.create);
  const setActive = useConversations((s) => s.setActive);
  const conversations = useConversations((s) => s.conversations);
  const loaded = useConversations((s) => s.loaded);
  const defaultProviderId = useSettings((s) => s.defaultProviderId);

  // Boot: authenticate, then hydrate stores.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const me = await api.getMe();
      if (cancelled) return;
      if (!me) {
        setBoot("unauthenticated");
        return;
      }
      await Promise.all([
        useSettings.getState().load(),
        loadConversations(),
        useZoteroNoteSyncStore.getState().load(),
      ]);
      if (cancelled) return;
      setBoot("authenticated");
      // Offer to import any leftover browser data once.
      hasLocalDataToMigrate().then((has) => { if (!cancelled) setMigrateOffer(has); });
    })();
    return () => { cancelled = true; };
  }, [loadConversations]);

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

  if (boot === "checking") {
    return <div className="app"><main className="main-pane"><div className="chat-empty">Loading…</div></main></div>;
  }

  if (boot === "unauthenticated") {
    return (
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/forgot" element={<ForgotPassword />} />
        <Route path="/reset" element={<ResetPassword />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    );
  }

  return (
    <div className="app">
      {migrateOffer && (
        <MigratePrompt
          onImport={async () => {
            try {
              const r = await importLocalData();
              alert(`Imported: ${JSON.stringify(r.imported)}. Reloading…`);
            } catch (e) {
              alert(`Import failed: ${(e as Error).message}`);
            } finally {
              setMigrateOffer(false);
              window.location.reload();
            }
          }}
          onDismiss={() => setMigrateOffer(false)}
        />
      )}
      <div className="app-main">
        <Sidebar />
        <Routes>
          <Route path="/" element={<RootLanding loaded={loaded} onMount={ensureRootChat} />} />
          <Route path="/chat/:id" element={<ChatView />} />
          <Route path="/paper/:arxivId" element={<PaperView />} />
          <Route path="/paper/:arxivId/:convId" element={<PaperView />} />
          <Route path="/settings" element={<SettingsView />} />
          <Route path="/login" element={<Navigate to="/" replace />} />
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
    // eslint-disable-line react-hooks/exhaustive-deps
  }, [loaded]);
  return <main className="main-pane"><div className="chat-empty">Starting…</div></main>;
}

function MigratePrompt({ onImport, onDismiss }: { onImport: () => void; onDismiss: () => void }) {
  return (
    <div className="migrate-prompt">
      <div className="migrate-prompt-card">
        <h3>Import your local browser data?</h3>
        <p>
          We found chat history, annotations, or settings saved in this browser.
          Import them into your account so they're preserved and available on
          other devices. (This runs once; re-importing is harmless.)
        </p>
        <div className="migrate-prompt-actions">
          <button className="login-submit" onClick={onImport}>Import</button>
          <button className="login-toggle" onClick={onDismiss}>Not now</button>
        </div>
      </div>
    </div>
  );
}
