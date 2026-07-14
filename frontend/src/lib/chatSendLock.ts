export interface SendLockRef {
  current: boolean;
}

/**
 * Acquire a chat turn synchronously, before React can commit its next render.
 * `busy` remains presentation state; this ref is the single-flight invariant.
 */
export function tryAcquireSendLock(lock: SendLockRef): boolean {
  if (lock.current) return false;
  lock.current = true;
  return true;
}

export function releaseSendLock(lock: SendLockRef): void {
  lock.current = false;
}
