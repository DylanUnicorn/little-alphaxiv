// Tests for the conversations store — specifically the empty-conversation reuse
// path, where a stale `updated_at` would land a just-clicked "+ New chat" (or a
// just-opened paper) under an old date-group header instead of "Today".
//
// Empty conversations are in-memory only (never persisted), so their `updated_at`
// is the moment they were CREATED. If the session lives across a day boundary,
// reusing one (create({ reuseEmpty: true })) used to return it with that stale
// `updated_at` — the sidebar then sorted/bucketed it into an old recency group.
// Reusing must refresh `updated_at` so the row sorts to the top and lands in
// "Today", while `created_at` (the true creation moment) is preserved.

import { describe, it, expect, beforeEach } from "vitest";
import { useConversations } from "./conversations";
import type { Conversation } from "../types";

const STALE_TS = 1_000_000; // epoch ms far in the past → would bucket as "January 1970"

function emptyGeneral(id: string, overrides: Partial<Conversation> = {}): Conversation {
  return {
    id,
    title: "New chat",
    type: "general",
    messages: [],
    created_at: STALE_TS,
    updated_at: STALE_TS,
    ...overrides,
  };
}

describe("create({ reuseEmpty: true })", () => {
  beforeEach(() => {
    useConversations.setState({ conversations: [], activeId: null });
  });

  it("reuses an existing empty conversation of the same type", async () => {
    const stale = emptyGeneral("stale-1");
    useConversations.setState({ conversations: [stale] });

    const reused = await useConversations.getState().create({
      type: "general",
      reuseEmpty: true,
    });

    expect(reused.id).toBe("stale-1"); // reused, not a brand-new uid
    expect(useConversations.getState().conversations).toHaveLength(1);
  });

  it("adopts the current default provider when reusing an empty paper conversation", async () => {
    const emptyPaper: Conversation = {
      id: "paper-empty-provider",
      title: "Paper discussion",
      type: "paper",
      paper_id: "2401.00001",
      provider_id: "provider-a",
      messages: [],
      created_at: STALE_TS,
      updated_at: STALE_TS,
    };
    useConversations.setState({ conversations: [emptyPaper] });

    const reused = await useConversations.getState().create({
      type: "paper",
      paperId: "2401.00001",
      providerId: "provider-b",
      reuseEmpty: true,
    });

    expect(reused.id).toBe("paper-empty-provider");
    expect(reused.provider_id).toBe("provider-b");
    expect(useConversations.getState().conversations[0].provider_id).toBe("provider-b");
  });

  it("refreshes updated_at on reuse so the row lands in Today, not a stale bucket", async () => {
    const stale = emptyGeneral("stale-2");
    useConversations.setState({ conversations: [stale] });

    const before = Date.now();
    const reused = await useConversations.getState().create({
      type: "general",
      reuseEmpty: true,
    });
    const after = Date.now();

    expect(reused.updated_at).toBeGreaterThanOrEqual(before);
    expect(reused.updated_at).toBeLessThanOrEqual(after);
    // created_at is the true creation moment and must NOT be bumped.
    expect(reused.created_at).toBe(STALE_TS);
  });

  it("moves the reused conversation to the front and reflects the refreshed updated_at in store state", async () => {
    // `other` is NON-empty, so reuseEmpty skips it and matches `stale-3`
    // (the only empty general chat) even though it sits at index 1.
    const stale = emptyGeneral("stale-3");
    const other = emptyGeneral("other", {
      id: "other",
      created_at: 2_000_000,
      updated_at: 2_000_000,
      messages: [{ role: "user", content: "hi" } as any],
    });
    useConversations.setState({ conversations: [other, stale] });

    const reused = await useConversations.getState().create({
      type: "general",
      reuseEmpty: true,
    });

    const convs = useConversations.getState().conversations;
    expect(convs[0].id).toBe("stale-3"); // moved to front
    expect(convs[0].updated_at).toBe(reused.updated_at); // refreshed value, not STALE_TS
    expect(convs).toHaveLength(2);
  });

  it("does not match an empty conversation of a different type (paper vs general)", async () => {
    const emptyPaper: Conversation = {
      id: "paper-empty",
      title: "Paper discussion",
      type: "paper",
      paper_id: "2401.00001",
      messages: [],
      created_at: STALE_TS,
      updated_at: STALE_TS,
    };
    useConversations.setState({ conversations: [emptyPaper] });

    const created = await useConversations.getState().create({
      type: "general",
      reuseEmpty: true,
    });

    // A new general chat is created; the empty paper chat is left alone.
    expect(created.id).not.toBe("paper-empty");
    expect(created.type).toBe("general");
    expect(useConversations.getState().conversations).toHaveLength(2);
  });
});

describe("syncEmptyProvider", () => {
  beforeEach(() => {
    useConversations.setState({ conversations: [], activeId: null });
  });

  it("updates an already-open empty paper conversation to the current default provider", () => {
    const emptyPaper: Conversation = {
      id: "active-empty-paper",
      title: "Paper discussion",
      type: "paper",
      paper_id: "2401.00001",
      provider_id: "provider-a",
      messages: [],
      created_at: STALE_TS,
      updated_at: STALE_TS,
    };
    useConversations.setState({ conversations: [emptyPaper], activeId: emptyPaper.id });

    useConversations.getState().syncEmptyProvider(emptyPaper.id, "provider-b");

    expect(useConversations.getState().conversations[0].provider_id).toBe("provider-b");
  });

  it("does not change a conversation after its first message", () => {
    const startedPaper: Conversation = {
      id: "started-paper",
      title: "Paper discussion",
      type: "paper",
      paper_id: "2401.00001",
      provider_id: "provider-a",
      messages: [{ role: "user", content: "Summarize this" }],
      created_at: STALE_TS,
      updated_at: STALE_TS,
    };
    useConversations.setState({ conversations: [startedPaper], activeId: startedPaper.id });

    useConversations.getState().syncEmptyProvider(startedPaper.id, "provider-b");

    expect(useConversations.getState().conversations[0].provider_id).toBe("provider-a");
  });
});
