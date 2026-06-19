// Conversations store, backed by IndexedDB. UI reads from this store; every
// mutation persists to IDB — EXCEPT empty conversations.
//
// Empty-conversation rule (standard chat-app behavior):
//   - A brand-new conversation with 0 messages lives only in memory. It is NOT
//     written to IDB, so reloading the page discards it.
//   - The first user message (appendMessages) persists the conversation.
//   - create({ reuseEmpty: true }) reuses an existing empty conversation of the
//     same type (+ same paper_id) instead of spawning duplicates, so clicking
//     "New chat" repeatedly never piles up empty conversations.

import { create } from "zustand";
import type { ChatMessage, Conversation, ConversationType } from "../types";
import * as db from "../lib/db";

interface ConvState {
  conversations: Conversation[];
  activeId: string | null;
  loading: boolean;
  loaded: boolean;
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

// Persist a conversation to IDB only if it has at least one message.
// Empty conversations stay in-memory only.
async function persist(conv: Conversation): Promise<void> {
  if (conv.messages.length > 0) {
    await db.saveConversation(conv);
  }
}

export const useConversations = create<ConvState>((set, get) => ({
  conversations: [],
  activeId: null,
  loading: false,
  loaded: false,

  load: async () => {
    set({ loading: true });
    const all = await db.listConversations();
    // Purge any legacy empty conversations that previous versions may have
    // persisted, enforcing the invariant that IDB never holds 0-message convs.
    const empties = all.filter((c) => c.messages.length === 0);
    const conversations = all.filter((c) => c.messages.length > 0);
    await Promise.all(empties.map((c) => db.deleteConversation(c.id)));
    set({ conversations, loading: false, loaded: true });
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
        set((s) => ({
          conversations: [existing, ...s.conversations.filter((c) => c.id !== existing.id)],
          activeId: existing.id,
        }));
        return existing;
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

  appendMessages: async (id, msgs) => {
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
  },

  updateMessage: async (id, index, patch) => {
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
  },

  rename: async (id, title) => {
    const conv = get().conversations.find((c) => c.id === id);
    if (!conv) return;
    const updated = { ...conv, title, updated_at: Date.now() };
    await persist(updated);
    set((s) => ({
      conversations: s.conversations.map((c) => (c.id === id ? updated : c)),
    }));
  },

  updateSettings: async (id, patch) => {
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
  },

  remove: async (id) => {
    await db.deleteConversation(id); // no-op if it was never persisted
    set((s) => {
      const conversations = s.conversations.filter((c) => c.id !== id);
      const activeId = s.activeId === id ? null : s.activeId;
      return { conversations, activeId };
    });
  },

  removeMany: async (ids) => {
    await Promise.all(ids.map((id) => db.deleteConversation(id)));
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
