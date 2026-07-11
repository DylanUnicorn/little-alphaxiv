// Conversations store, backed by the server DB (per-user). UI reads from this
// store; every mutation persists to the backend via /api/conversations — EXCEPT
// empty conversations.
//
// Empty-conversation rule (standard chat-app behavior):
//   - A brand-new conversation with 0 messages lives only in memory. It is NOT
//     sent to the backend, so reloading the page discards it.
//   - The first user message (appendMessages) persists the conversation.
//   - create({ reuseEmpty: true }) reuses an existing empty conversation of the
//     same type (+ same paper_id) instead of spawning duplicates, so clicking
//     "New chat" repeatedly never piles up empty conversations.

import { create } from "zustand";
import type { ChatMessage, Conversation, ConversationType } from "../types";
import * as api from "../lib/api";

interface ConvState {
  conversations: Conversation[];
  activeId: string | null;
  loading: boolean;
  loaded: boolean;
  // True iff IDB held any persisted user data at load() time — conversations
  // with messages, annotations, OR cached papers. Read-only after load (no
  // setter). Reflects persisted data, NOT in-memory state — ensureRootChat
  // creates an empty in-memory general chat that would falsely flip
  // conversations.length > 0, so the origin-redirect/banner logic reads this
  // flag instead. Broadened from conversations-only so the redirect never
  // fires away from an origin holding annotations/cached-papers (no stranding).
  hasHistory: boolean;
  load: () => Promise<void>;
  setActive: (id: string | null) => void;
  create: (opts: {
    type: ConversationType;
    title?: string;
    paperId?: string;
    providerId?: string;
    initialMessages?: ChatMessage[];
    reuseEmpty?: boolean;
  }) => Promise<Conversation>;
  syncEmptyProvider: (id: string, providerId?: string) => void;
  appendMessages: (id: string, msgs: ChatMessage[]) => Promise<void>;
  updateMessage: (
    id: string,
    index: number,
    patch: Partial<ChatMessage>
  ) => Promise<void>;
  rename: (id: string, title: string) => Promise<void>;
  updateSettings: (id: string, patch: {
    model?: string;
    style_preset?: import("../types").StylePreset;
    context_window?: number; // deprecated, kept for back-compat
    context_capacity_override?: number; // 0/undefined = Auto
    reserve_tokens?: number; // 0/undefined = auto default
    last_usage?: import("../types").TokenUsage & { calibration: number; ts: number };
  }) => Promise<void>;
  remove: (id: string) => Promise<void>;
  removeMany: (ids: string[]) => Promise<void>;
  getActive: () => Conversation | undefined;
}

function uid(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// Persist a conversation to the server only if it has at least one message.
// Empty conversations stay in-memory only.
async function persist(conv: Conversation): Promise<void> {
  if (conv.messages.length > 0) {
    await api.putConversation(conv);
  }
}

// Per-conversation write serialization. The store's mutations are called
// fire-and-forget from the chat loop (onAssistantMessage/onToolMessage append
// messages while onUsage writes last_usage, all in the same turn). Without
// serialization, each mutation reads an in-memory snapshot, persists it, then
// sets state — and concurrent persists race: the last IDB write wins, losing
// fields the other mutation added (notably last_usage, which loses to the
// round-2 answer's appendMessages). Serializing per-conversation means each
// mutation waits for the previous to finish (including its `set`), so the next
// reads a fresh in-memory snapshot and no update is lost.
const _convLocks: Record<string, Promise<void>> = {};
function withConvLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const prev = _convLocks[id] ?? Promise.resolve();
  const next = prev.then(fn, fn);
  _convLocks[id] = next.then(
    () => undefined,
    () => undefined
  );
  return next;
}

export const useConversations = create<ConvState>((set, get) => ({
  conversations: [],
  activeId: null,
  loading: false,
  loaded: false,
  hasHistory: false,

  load: async () => {
    set({ loading: true });
    // The sidebar list endpoint omits messages (too heavy); fetch each
    // conversation's full body so the in-memory store keeps messages hot (the
    // chat loop reads getActive().messages directly). LAN-scale, so N small
    // GETs are fine.
    const summaries = await api.listConversations();
    const conversations = await Promise.all(
      summaries.map((s) => api.getConversation(s.id).catch(() => ({ ...s, messages: [] })))
    );
    // Defensive: drop any 0-message rows the server might hold (legacy).
    const nonEmpty = conversations.filter((c) => c.messages.length > 0);
    set({
      conversations: nonEmpty,
      loading: false,
      loaded: true,
      // hasHistory is set by the boot sequence from /api/auth/me.hasData; keep
      // it consistent here too (any persisted conversation counts).
      hasHistory: get().hasHistory || nonEmpty.length > 0,
    });
  },

  setActive: (id) => set({ activeId: id }),

  create: async (opts) => {
    // Reuse an existing empty conversation of the same shape instead of
    // creating a duplicate (prevents empty-conversation spam).
    if (opts.reuseEmpty) {
      const existing = get().conversations.find(
        (c) =>
          c.type === opts.type &&
          c.messages.length === 0 &&
          (opts.type !== "paper" || c.paper_id === opts.paperId)
      );
      if (existing) {
        // Refresh updated_at so the reused empty chat sorts to the top of the
        // sidebar and lands in the "Today" date group. Without this, a long-
        // lived session reusing an empty chat created days ago would file that
        // just-clicked "+ New chat" (or just-opened paper) under a stale
        // recency header. created_at stays put (true creation moment). Not
        // persisted: empty conversations remain in-memory until first message.
        const refreshed: Conversation = {
          ...existing,
          // Empty threads have not started a provider-bound exchange yet. When
          // Settings changes the default, reusing one must pick up that new
          // default instead of retaining the provider selected at its original
          // creation time. Persisted/non-empty threads stay pinned as-is.
          provider_id: opts.providerId,
          updated_at: Date.now(),
        };
        set((s) => ({
          conversations: [refreshed, ...s.conversations.filter((c) => c.id !== refreshed.id)],
          activeId: refreshed.id,
        }));
        return refreshed;
      }
    }

    const now = Date.now();
    const conv: Conversation = {
      id: uid(),
      title: opts.title || (opts.type === "paper" ? "Paper discussion" : "New chat"),
      type: opts.type,
      paper_id: opts.paperId,
      provider_id: opts.providerId,
      messages: opts.initialMessages ?? [],
      created_at: now,
      updated_at: now,
    };
    // Empty conversations are NOT persisted yet (see rule above).
    await persist(conv);
    set((s) => ({ conversations: [conv, ...s.conversations], activeId: conv.id }));
    return conv;
  },

  syncEmptyProvider: (id, providerId) =>
    set((s) => ({
      conversations: s.conversations.map((c) =>
        c.id === id && c.messages.length === 0
          ? { ...c, provider_id: providerId }
          : c
      ),
    })),

  appendMessages: async (id, msgs) =>
    withConvLock(id, async () => {
      const conv = get().conversations.find((c) => c.id === id);
      if (!conv) return;
      const updated: Conversation = {
        ...conv,
        messages: [...conv.messages, ...msgs],
        updated_at: Date.now(),
      };
      await persist(updated); // first message persists a previously-empty conv
      set((s) => ({
        conversations: s.conversations.map((c) => (c.id === id ? updated : c)),
      }));
    }),

  updateMessage: async (id, index, patch) =>
    withConvLock(id, async () => {
      const conv = get().conversations.find((c) => c.id === id);
      if (!conv) return;
      const messages = conv.messages.map((m, i) =>
        i === index ? { ...m, ...patch } : m
      );
      const updated: Conversation = {
        ...conv,
        messages,
        updated_at: Date.now(),
      };
      await persist(updated);
      set((s) => ({
        conversations: s.conversations.map((c) => (c.id === id ? updated : c)),
      }));
    }),

  rename: async (id, title) =>
    withConvLock(id, async () => {
      const conv = get().conversations.find((c) => c.id === id);
      if (!conv) return;
      const updated = { ...conv, title, updated_at: Date.now() };
      await persist(updated);
      set((s) => ({
        conversations: s.conversations.map((c) => (c.id === id ? updated : c)),
      }));
    }),

  updateSettings: async (id, patch) =>
    withConvLock(id, async () => {
      const conv = get().conversations.find((c) => c.id === id);
      if (!conv) return;
      const updated = {
        ...conv,
        ...(patch.model !== undefined ? { model: patch.model } : {}),
        ...(patch.style_preset !== undefined ? { style_preset: patch.style_preset } : {}),
        ...(patch.context_window !== undefined ? { context_window: patch.context_window } : {}),
        ...(patch.context_capacity_override !== undefined
          ? { context_capacity_override: patch.context_capacity_override }
          : {}),
        ...(patch.reserve_tokens !== undefined ? { reserve_tokens: patch.reserve_tokens } : {}),
        ...(patch.last_usage !== undefined ? { last_usage: patch.last_usage } : {}),
        updated_at: Date.now(),
      };
      // If the conv is still empty, settings live in memory only and will be
      // persisted together with the first message.
      await persist(updated);
      set((s) => ({
        conversations: s.conversations.map((c) => (c.id === id ? updated : c)),
      }));
    }),

  remove: async (id) => {
    await api.deleteConversation(id); // no-op if it was never persisted (404 tolerated server-side)
    set((s) => {
      const conversations = s.conversations.filter((c) => c.id !== id);
      const activeId = s.activeId === id ? null : s.activeId;
      return { conversations, activeId };
    });
  },

  removeMany: async (ids) => {
    await Promise.all(ids.map((id) => api.deleteConversation(id)));
    const kill = new Set(ids);
    set((s) => ({
      conversations: s.conversations.filter((c) => !kill.has(c.id)),
      activeId: kill.has(s.activeId ?? "") ? null : s.activeId,
    }));
  },

  getActive: () => {
    const { conversations, activeId } = get();
    return conversations.find((c) => c.id === activeId);
  },
}));
