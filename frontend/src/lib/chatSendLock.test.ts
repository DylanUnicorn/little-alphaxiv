import { describe, expect, it } from "vitest";
import { releaseSendLock, tryAcquireSendLock } from "./chatSendLock";

describe("chat send single-flight lock", () => {
  it("rejects a second send until the active turn releases the lock", () => {
    const lock = { current: false };

    expect(tryAcquireSendLock(lock)).toBe(true);
    expect(tryAcquireSendLock(lock)).toBe(false);

    releaseSendLock(lock);
    expect(tryAcquireSendLock(lock)).toBe(true);
  });
});
