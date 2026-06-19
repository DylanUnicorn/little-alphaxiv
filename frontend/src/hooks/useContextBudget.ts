// Memoized context-budget selector for the ContextRing. Reads the active
// conversation (messages, capacity/reserve overrides, last real usage, model)
// and the provider's cached model list (for a provider-reported context_length),
// then delegates the math to the pure lib/contextBudget.computeBudget.
//
// The effective system prompt is passed in by the caller (ChatPanel), since it
// already owns it — and in paper chats it carries the full PDF text, the
// dominant token consumer the ring must account for.

import { useMemo } from "react";
import { useConversations } from "../store/conversations";
import { useSettings } from "../store/settings";
import { computeBudget, type Budget } from "../lib/contextBudget";

export function useContextBudget(args: {
  conversationId: string;
  systemPrompt: string;
}): Budget | null {
  const conv = useConversations((s) =>
    s.conversations.find((c) => c.id === args.conversationId)
  );
  const provider = useSettings((s) =>
    s.getProvider(conv?.provider_id ?? null)
  );
  const cachedModels = useSettings((s) =>
    provider ? s.getCachedModels(provider.id) : []
  );

  return useMemo<Budget | null>(() => {
    if (!conv) return null;
    const effectiveModel = conv.model || provider?.model || "";
    // If the cached model list has an entry for this model, surface its
    // context_length so resolveCapacity can detect it; otherwise fall through
    // to the curated table / default.
    const modelInfo = cachedModels.find((m) => m.id === effectiveModel);
    return computeBudget({
      messages: conv.messages,
      systemPrompt: args.systemPrompt,
      model: { id: effectiveModel, context_length: modelInfo?.context_length },
      capacityOverride: conv.context_capacity_override,
      reserveOverride: conv.reserve_tokens,
      calibration: conv.last_usage?.calibration,
    });
    // Recompute when the inputs that change the estimate change. `conv.messages`
    // is a new array reference on every append (intentional — that's when used
    // moves); the scalar overrides and last_usage are stable between edits.
  }, [
    conv,
    provider?.model,
    cachedModels,
    args.systemPrompt,
  ]);
}
