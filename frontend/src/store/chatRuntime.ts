import { create } from "zustand";

export interface ChatTurnRuntime {
  busy: boolean;
  status: string;
  streaming: string;
  reasoning: string;
  controller: AbortController | null;
}

type TurnPatch = Partial<Pick<ChatTurnRuntime, "status" | "streaming" | "reasoning">>;

interface ChatRuntimeState {
  turns: Record<string, ChatTurnRuntime>;
  generatingIds: ReadonlySet<string>;
  startTurn: (conversationId: string, controller: AbortController) => boolean;
  updateTurn: (
    conversationId: string,
    controller: AbortController,
    patch: TurnPatch,
  ) => void;
  appendReasoning: (
    conversationId: string,
    controller: AbortController,
    text: string,
  ) => void;
  setNotice: (conversationId: string, status: string) => void;
  stopTurn: (conversationId: string) => void;
  finishTurn: (conversationId: string, controller: AbortController) => void;
  resetForTests: () => void;
}

export const EMPTY_CHAT_TURN: ChatTurnRuntime = Object.freeze({
  busy: false,
  status: "",
  streaming: "",
  reasoning: "",
  controller: null,
});

function withoutKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  const next = { ...record };
  delete next[key];
  return next;
}

/**
 * Browser-only runtime for in-flight turns. Persisted chat data belongs in the
 * conversations store; partial output and AbortControllers deliberately do
 * not. Controller identity prevents a stale async callback from mutating a
 * newer turn for the same conversation.
 */
export const useChatRuntime = create<ChatRuntimeState>((set, get) => ({
  turns: {},
  generatingIds: new Set<string>(),

  startTurn: (conversationId, controller) => {
    if (get().turns[conversationId]?.busy) return false;
    set((state) => ({
      turns: {
        ...state.turns,
        [conversationId]: {
          busy: true,
          status: "Thinking…",
          streaming: "",
          reasoning: "",
          controller,
        },
      },
      generatingIds: new Set(state.generatingIds).add(conversationId),
    }));
    return true;
  },

  updateTurn: (conversationId, controller, patch) => set((state) => {
    const current = state.turns[conversationId];
    if (!current || current.controller !== controller) return state;
    return {
      turns: {
        ...state.turns,
        [conversationId]: { ...current, ...patch },
      },
    };
  }),

  appendReasoning: (conversationId, controller, text) => set((state) => {
    const current = state.turns[conversationId];
    if (!current || current.controller !== controller) return state;
    return {
      turns: {
        ...state.turns,
        [conversationId]: {
          ...current,
          reasoning: (current.reasoning + text).slice(-2000),
        },
      },
    };
  }),

  setNotice: (conversationId, status) => set((state) => {
    const current = state.turns[conversationId];
    if (current?.busy) {
      return {
        turns: {
          ...state.turns,
          [conversationId]: { ...current, status },
        },
      };
    }
    if (!status) {
      if (!current) return state;
      return { turns: withoutKey(state.turns, conversationId) };
    }
    return {
      turns: {
        ...state.turns,
        [conversationId]: { ...EMPTY_CHAT_TURN, status },
      },
    };
  }),

  stopTurn: (conversationId) => {
    get().turns[conversationId]?.controller?.abort();
  },

  finishTurn: (conversationId, controller) => set((state) => {
    const current = state.turns[conversationId];
    if (!current || current.controller !== controller) return state;
    const generatingIds = new Set(state.generatingIds);
    generatingIds.delete(conversationId);
    return {
      turns: withoutKey(state.turns, conversationId),
      generatingIds,
    };
  }),

  resetForTests: () => set({ turns: {}, generatingIds: new Set<string>() }),
}));
