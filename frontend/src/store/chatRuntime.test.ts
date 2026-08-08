import { beforeEach, describe, expect, it, vi } from "vitest";
import { EMPTY_CHAT_TURN, useChatRuntime } from "./chatRuntime";

describe("conversation-scoped chat runtime", () => {
  beforeEach(() => {
    useChatRuntime.getState().resetForTests();
  });

  it("starts one turn per conversation while allowing other conversations to run", () => {
    const controllerA = new AbortController();
    const controllerB = new AbortController();

    expect(useChatRuntime.getState().startTurn("branch-a", controllerA)).toBe(true);
    expect(useChatRuntime.getState().startTurn("branch-a", new AbortController())).toBe(false);
    expect(useChatRuntime.getState().startTurn("branch-b", controllerB)).toBe(true);

    const state = useChatRuntime.getState();
    expect(state.turns["branch-a"]?.busy).toBe(true);
    expect(state.turns["branch-b"]?.busy).toBe(true);
    expect([...state.generatingIds]).toEqual(["branch-a", "branch-b"]);
  });

  it("keeps streaming and reasoning updates scoped to their owning controller", () => {
    const owner = new AbortController();
    const stale = new AbortController();
    useChatRuntime.getState().startTurn("branch-a", owner);

    useChatRuntime.getState().updateTurn("branch-a", owner, {
      streaming: "partial answer",
      status: "Generating…",
    });
    useChatRuntime.getState().appendReasoning("branch-a", owner, "reason ");
    useChatRuntime.getState().appendReasoning("branch-a", stale, "wrong");
    useChatRuntime.getState().updateTurn("branch-b", owner, { streaming: "leak" });

    expect(useChatRuntime.getState().turns["branch-a"]).toMatchObject({
      streaming: "partial answer",
      reasoning: "reason ",
      status: "Generating…",
    });
    expect(useChatRuntime.getState().turns["branch-b"]).toBeUndefined();
  });

  it("stops only the requested conversation", () => {
    const controllerA = new AbortController();
    const controllerB = new AbortController();
    const abortA = vi.spyOn(controllerA, "abort");
    const abortB = vi.spyOn(controllerB, "abort");
    useChatRuntime.getState().startTurn("branch-a", controllerA);
    useChatRuntime.getState().startTurn("branch-b", controllerB);

    useChatRuntime.getState().stopTurn("branch-a");

    expect(abortA).toHaveBeenCalledOnce();
    expect(abortB).not.toHaveBeenCalled();
  });

  it("does not let stale completion clear a newer owner", () => {
    const oldController = new AbortController();
    const newController = new AbortController();
    useChatRuntime.getState().startTurn("branch-a", oldController);
    useChatRuntime.getState().finishTurn("branch-a", oldController);
    useChatRuntime.getState().startTurn("branch-a", newController);

    useChatRuntime.getState().finishTurn("branch-a", oldController);

    expect(useChatRuntime.getState().turns["branch-a"]?.controller).toBe(newController);
    expect(useChatRuntime.getState().generatingIds.has("branch-a")).toBe(true);
  });

  it("keeps an idle notice scoped to one conversation", () => {
    useChatRuntime.getState().setNotice("branch-b", "No provider configured.");

    expect(useChatRuntime.getState().turns["branch-b"]?.status).toBe("No provider configured.");
    expect(useChatRuntime.getState().turns["branch-b"]?.busy).toBe(false);
    expect(useChatRuntime.getState().turns["branch-a"] ?? EMPTY_CHAT_TURN).toBe(EMPTY_CHAT_TURN);
  });
});
