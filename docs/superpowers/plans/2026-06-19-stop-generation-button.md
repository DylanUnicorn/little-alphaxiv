# Stop-Generation Button (arrow ↔ square) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user abort an in-flight AI reply: the send button (➤) becomes a square stop button (■) while the assistant is responding; clicking it cancels the stream and keeps the partial reply with a "已停止" marker (not a red error). When generation ends, the button returns to the arrow.

**Architecture:** Add an `AbortController` in `ChatPanel.send()` and pass its `signal` to the already-signal-aware `runConversation`/`streamChat`. `ChatComposer` gains an `onStop` prop and toggles the single send button between send-mode (arrow) and stop-mode (square) based on `busy`. The `send()` catch block branches on user-abort (keep partial + `ui.stopped`) vs real error (keep existing red `ui.error`). A pure `isAbortError(...)` helper is extracted to `lib/chatStop.ts` so the abort-detection logic is unit-testable in the repo's existing node/`.ts` test harness (there is no jsdom/component test infra).

**Tech Stack:** React 18 (StrictMode disabled), TypeScript, Vite, Vitest (node env, `src/**/*.test.ts` only — no component tests), zustand. Frontend only; backend untouched.

## Global Constraints

- The gate is `npm run typecheck` (`tsc --noEmit`). **There is no lint script.** Every task ends green on typecheck.
- Tests run via `npm test` (Vitest, node env). Only `src/**/*.test.ts` files are collected — **do not create `.tsx` component tests** (they won't run). Test pure logic by extracting it into `lib/*.ts`.
- React.StrictMode is **disabled** (`src/main.tsx`) — do not re-enable.
- Mock-LLM title-sniffing contract: never remove the phrases `"title generator"` and `"paper being discussed"` from the title system/user prompt. (Unchanged by this feature — noted for safety.)
- `lib/llm.ts` and `lib/api.ts` are **not modified** by this plan — the `signal` plumbing already exists (`runConversation` `signal?: AbortSignal` → `streamChat` → `fetch`).
- All UI copy for this feature is Chinese ("已停止", "Stop generating" / "停止生成"). Match the existing app language (the chat status already shows English "Generating…"; keep button titles bilingual-safe — see Task 5 for the exact strings).
- Work in the worktree `E:/Hust/little_alphaxiv/.claude/worktrees/stop-generation-button` (branch `worktree-stop-generation-button`, already created from local `main` @ 38d754e). Commit per task.

---

## File Structure

- **`frontend/src/lib/chatStop.ts`** (NEW) — pure helper `isAbortError(signal, err): boolean`. Unit-tested. Keeps DOM-free logic testable given the no-component-test constraint.
- **`frontend/src/lib/chatStop.test.ts`** (NEW) — Vitest tests for `isAbortError`.
- **`frontend/src/types.ts`** (MODIFY) — add `stopped?: boolean` to `ChatMessage.ui` (closed object today).
- **`frontend/src/components/ChatComposer.tsx`** (MODIFY) — add `onStop` prop; toggle the single send button between arrow/send and square/stop based on `busy`.
- **`frontend/src/components/ChatPanel.tsx`** (MODIFY) — `abortRef`, `stop()`, pass `signal` to `runConversation`, catch-branch on abort, pass `onStop` to `ChatComposer`, render `ui.stopped` in `MessageRow`.
- **`frontend/src/index.css`** (MODIFY) — `.msg-stopped` marker + `.composer-send-btn.is-stop` square tweak.

Order rationale: Task 1 (pure helper + tests) and Task 2 (type) have no dependencies and can land first; Task 3 (`ChatComposer`) consumes the type; Task 4 (`ChatPanel`) consumes the helper + type + composer prop; Task 5 (CSS) is independent and last.

---

### Task 1: Pure `isAbortError` helper + tests

**Files:**
- Create: `frontend/src/lib/chatStop.ts`
- Test: `frontend/src/lib/chatStop.test.ts`

**Interfaces:**
- Produces: `export function isAbortError(signal: AbortSignal | null | undefined, err: unknown): boolean` — returns true when the abort originated from the user's stop (the controller we created was aborted) OR the thrown error is a DOMException named `"AbortError"`.

The repo's Vitest runs in `node` env with `include: ["src/**/*.test.ts"]`. `AbortController`/`AbortSignal`/`DOMException` are available as globals in Node ≥18 (the project uses Node for dev). This task extracts the abort-detection logic so it is testable without a React/jsdom harness (which doesn't exist here).

- [ ] **Step 1: Write the failing test**

Create `frontend/src/lib/chatStop.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { isAbortError } from "./chatStop";

describe("isAbortError", () => {
  it("returns true when the passed signal was aborted", () => {
    const c = new AbortController();
    c.abort();
    expect(isAbortError(c.signal, new Error("anything"))).toBe(true);
  });

  it("returns true when the error is a DOMException named AbortError, even with a non-aborted signal", () => {
    const c = new AbortController();
    // signal NOT aborted — simulate a fetch that threw AbortError for another reason
    const err = new DOMException("aborted", "AbortError");
    expect(isAbortError(c.signal, err)).toBe(true);
  });

  it("returns false for an unrelated error and a non-aborted signal", () => {
    const c = new AbortController();
    expect(isAbortError(c.signal, new Error("network down"))).toBe(false);
  });

  it("returns false when signal is null and error is not an AbortError", () => {
    expect(isAbortError(null, new Error("upstream 500"))).toBe(false);
  });

  it("returns true when signal is null but error is an AbortError DOMException", () => {
    expect(isAbortError(null, new DOMException("aborted", "AbortError"))).toBe(true);
  });

  it("does not throw on non-error / undefined thrown values", () => {
    expect(isAbortError(undefined, undefined)).toBe(false);
    expect(isAbortError(undefined, "string thrown")).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/lib/chatStop.test.ts`
Expected: FAIL — `isAbortError` is not exported / module not found.

- [ ] **Step 3: Write minimal implementation**

Create `frontend/src/lib/chatStop.ts`:

```ts
// Pure abort-detection helper. `send()` in ChatPanel creates an AbortController
// per turn and passes its signal to runConversation -> streamChat -> fetch.
// When the user clicks Stop, controller.abort() makes the in-flight fetch reject.
// We need to tell a *user-initiated* stop apart from a *real* network/upstream
// error, because the UI treatment differs: a stop keeps the partial reply and
// marks it "已停止" (dim), whereas an error keeps the existing red "interrupted"
// marker. Extracted into a pure module so it can be unit-tested in the repo's
// node-only Vitest harness (there is no jsdom/component test setup).
//
// Two signals count as a user abort:
//   1. the controller we created for this turn was aborted (authoritative — the
//      abort originates here), OR
//   2. the thrown value is a DOMException named "AbortError" (what fetch throws
//      on abort; also covers cases where the signal is unavailable).

export function isAbortError(
  signal: AbortSignal | null | undefined,
  err: unknown
): boolean {
  if (signal?.aborted) return true;
  if (err && typeof err === "object" && "name" in err) {
    return (err as { name: unknown }).name === "AbortError";
  }
  return false;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/lib/chatStop.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/chatStop.ts frontend/src/lib/chatStop.test.ts
git commit -m "feat(chat): add isAbortError helper + tests"
```

---

### Task 2: Add `stopped` to `ChatMessage.ui`

**Files:**
- Modify: `frontend/src/types.ts:38-42` (the `ui?` object on `ChatMessage`)

**Interfaces:**
- Produces: `ChatMessage["ui"]` now includes optional `stopped?: boolean`. Consumed by Task 4 (`ChatPanel.send()` sets `ui: { stopped: true }` on the kept partial reply; `MessageRow` renders it) and by Task 3 (no direct use, but the type must be valid before Task 4 writes it).

- [ ] **Step 1: Edit the `ui` object**

In `frontend/src/types.ts`, change the `ui?` block from:

```ts
  ui?: {
    papers?: Paper[]; // papers surfaced from a search_arxiv tool result
    pending?: boolean; // assistant message still streaming
    error?: string;
  };
```

to:

```ts
  ui?: {
    papers?: Paper[]; // papers surfaced from a search_arxiv tool result
    pending?: boolean; // assistant message still streaming
    error?: string;
    stopped?: boolean; // user clicked Stop mid-reply; partial content kept, "已停止" marker
  };
```

- [ ] **Step 2: Run typecheck**

Run: `cd frontend && npm run typecheck`
Expected: PASS (no errors — additive optional field).

- [ ] **Step 3: Commit**

```bash
git add frontend/src/types.ts
git commit -m "feat(chat): add stopped flag to ChatMessage.ui"
```

---

### Task 3: `ChatComposer` arrow ↔ square toggle

**Files:**
- Modify: `frontend/src/components/ChatComposer.tsx` (Props interface ~line 7-23; send button ~line 139-148)

**Interfaces:**
- Consumes: `onStop: () => void` (provided by `ChatPanel` in Task 4).
- Produces: a send button that, while `busy`, calls `onStop`, shows a square glyph `■`, is enabled, has class `composer-send-btn is-stop`, and title "Stop generating". While idle, behaves exactly as today (`onSend`, `➤`, `disabled={!canSend}`, title "Send (Enter)").

There is no component-test infra, so verification is typecheck + manual/E2E. The toggle is trivial enough to be visually verified; the E2E driver in Task 6 exercises it end-to-end.

- [ ] **Step 1: Add `onStop` to the Props interface**

In `frontend/src/components/ChatComposer.tsx`, in the `interface Props` block, add `onStop` after `onSend`:

```ts
interface Props {
  value: string;
  onValueChange: (v: string) => void;
  onSend: () => void;
  onStop: () => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
```

- [ ] **Step 2: Destructure `onStop` in the component params**

In the `export function ChatComposer({ … })` destructure (currently starts with `value,` `onValueChange,` `onSend,` `onKeyDown,`), add `onStop` right after `onSend`:

```ts
export function ChatComposer({
  value,
  onValueChange,
  onSend,
  onStop,
  onKeyDown,
  onPaste,
  onAttach,
  busy,
```

- [ ] **Step 3: Replace the send button with the state-driven toggle**

Find the send button (currently):

```tsx
          <button
            type="button"
            className="composer-icon-btn composer-send-btn"
            title="Send (Enter)"
            onClick={onSend}
            disabled={!canSend}
          >
            {/* paper-plane / up arrow */}
            <span className="composer-send-glyph" aria-hidden>➤</span>
          </button>
```

Replace it with:

```tsx
          <button
            type="button"
            className={`composer-icon-btn composer-send-btn${busy ? " is-stop" : ""}`}
            title={busy ? "Stop generating" : "Send (Enter)"}
            onClick={busy ? onStop : onSend}
            disabled={busy ? false : !canSend}
          >
            {/* arrow = send, square = stop (visible while assistant is replying) */}
            <span className="composer-send-glyph" aria-hidden>{busy ? "■" : "➤"}</span>
          </button>
```

Note: while `busy`, the button is `disabled={false}` — that is the point (the user must be able to click Stop). The textarea remains `disabled={busy}` (out of scope to change).

- [ ] **Step 4: Run typecheck**

Run: `cd frontend && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/ChatComposer.tsx
git commit -m "feat(chat): toggle send button to stop square while busy"
```

---

### Task 4: `ChatPanel` abort wiring + catch branch + `MessageRow` marker

**Files:**
- Modify: `frontend/src/components/ChatPanel.tsx` (import `isAbortError`; `abortRef` near other refs ~line 107-108; `send()` abort creation + signal pass ~line 255-305; catch block ~line 321-342; `<ChatComposer …/>` props ~line 394-410; `MessageRow` assistant branch ~line 458-465)

**Interfaces:**
- Consumes: `isAbortError` (Task 1), `ChatMessage.ui.stopped` (Task 2), `ChatComposer`'s `onStop` prop (Task 3).
- Produces: a working stop button. While replying, `stop()` calls `abortRef.current?.abort()`; the in-flight `streamChat` `fetch` rejects; the catch keeps partial `buf` (if any) as `{ role: "assistant", content: buf, ui: { stopped: true } }`, or appends nothing if `buf` is empty (stopped before any text). Real errors keep the existing red behavior.

- [ ] **Step 1: Add the import**

At the top of `frontend/src/components/ChatPanel.tsx`, alongside the other `lib/` imports, add:

```ts
import { isAbortError } from "../lib/chatStop";
```

(Place it near `import { truncateToFit, resolveForConv, … } from "../lib/contextBudget";` for grouping.)

- [ ] **Step 2: Add the `abortRef`**

Near the other refs (`const scrollRef = useRef…` / `const fileInputRef = useRef…`, ~line 107-108), add:

```ts
  // AbortController for the current in-flight turn, if any. Null when idle.
  // Clicking Stop aborts the streaming fetch (runConversation already threads
  // the signal through to fetch); the catch block distinguishes that user abort
  // from a real network/upstream error.
  const abortRef = useRef<AbortController | null>(null);
```

- [ ] **Step 3: Create the controller in `send()` and pass `signal`**

In `send()`, immediately before `setBusy(true);` (currently ~line 244), insert the controller creation:

```ts
    const controller = new AbortController();
    abortRef.current = controller;
    setBusy(true);
    setStatus("Thinking…");
```

Then in the `runConversation({ … })` call, add `signal: controller.signal,` to the options object. The call currently begins:

```ts
      const { newMessages } = await runConversation({
        provider,
        messages: history,
        systemPrompt: effectiveSystemPrompt,
        model: c.model,
        callbacks: {
```

Change to:

```ts
      const { newMessages } = await runConversation({
        provider,
        messages: history,
        systemPrompt: effectiveSystemPrompt,
        model: c.model,
        signal: controller.signal,
        callbacks: {
```

- [ ] **Step 4: Add `stop()`**

Add a `stop` function just before `send` (or just after `onKey`; placement near `send` is clearest). Put it directly above `async function send(override?: string) {`:

```ts
  function stop() {
    abortRef.current?.abort();
  }

  async function send(override?: string) {
```

- [ ] **Step 5: Rewrite the catch block to branch on abort**

Replace the entire current catch block:

```ts
    } catch (e: any) {
      const errMsg = e?.message || "error";
      setStreaming("");
      setReasoning("");
      // Preserve whatever had already streamed before the error so the user
      // doesn't lose the in-progress answer when a stream is interrupted (e.g.
      // the connection dropped while the tab was backgrounded). Previously the
      // partial buffer was discarded and replaced with a bare error message,
      // so the output the user was reading would vanish mid-reply.
      if (buf.trim()) {
        await appendMessages(c.id, [
          { role: "assistant", content: buf, ui: { error: `Response interrupted: ${errMsg}` } },
        ]);
      } else {
        await appendMessages(c.id, [
          { role: "assistant", content: `⚠️ ${errMsg}`, ui: { error: String(errMsg) } },
        ]);
      }
      setStatus("");
    } finally {
      setBusy(false);
    }
```

with:

```ts
    } catch (e: any) {
      setStreaming("");
      setReasoning("");
      if (isAbortError(controller.signal, e)) {
        // User clicked Stop. Keep whatever already streamed this round and mark
        // it "已停止" (dim, not red). If nothing streamed yet (stopped during a
        // search/tool phase before any assistant text), append nothing — the
        // turn just ends cleanly and the next send works normally.
        if (buf.trim()) {
          await appendMessages(c.id, [
            { role: "assistant", content: buf, ui: { stopped: true } },
          ]);
        }
      } else {
        // Real error (network / upstream). Preserve whatever had already
        // streamed before the error so the user doesn't lose the in-progress
        // answer when a stream is interrupted (e.g. the connection dropped
        // while the tab was backgrounded). Previously the partial buffer was
        // discarded and replaced with a bare error message, so the output the
        // user was reading would vanish mid-reply.
        const errMsg = e?.message || "error";
        if (buf.trim()) {
          await appendMessages(c.id, [
            { role: "assistant", content: buf, ui: { error: `Response interrupted: ${errMsg}` } },
          ]);
        } else {
          await appendMessages(c.id, [
            { role: "assistant", content: `⚠️ ${errMsg}`, ui: { error: String(errMsg) } },
          ]);
        }
      }
      setStatus("");
    } finally {
      abortRef.current = null;
      setBusy(false);
    }
```

Note `controller` is in `send()`'s scope, so the catch closes over the correct controller. `maybeSummarizeTitle` sits in the `try` after `runConversation`, so it is skipped on abort — the instant truncated-first-message title stays as the fallback (a stopped partial reply shouldn't drive the title).

- [ ] **Step 6: Pass `onStop` to `ChatComposer`**

In the `<ChatComposer …/>` JSX (currently ~line 394-410), add `onStop={() => stop()}` next to `onSend={() => send()}`:

```tsx
      <ChatComposer
        value={input}
        onValueChange={setInput}
        onSend={() => send()}
        onStop={() => stop()}
        onKeyDown={onKey}
```

- [ ] **Step 7: Render the "已停止" marker in `MessageRow`**

In the `MessageRow` assistant branch (currently):

```tsx
  // assistant
  return (
    <div className="msg msg-assistant">
      {msg.content ? (
        <Markdown>{msg.content}</Markdown>
      ) : (
        ""
      )}
      {msg.ui?.error && <div className="msg-error">{msg.ui.error}</div>}
    </div>
  );
```

add the stopped marker after the error line:

```tsx
  // assistant
  return (
    <div className="msg msg-assistant">
      {msg.content ? (
        <Markdown>{msg.content}</Markdown>
      ) : (
        ""
      )}
      {msg.ui?.error && <div className="msg-error">{msg.ui.error}</div>}
      {msg.ui?.stopped && <div className="msg-stopped">已停止</div>}
    </div>
  );
```

- [ ] **Step 8: Run typecheck + existing tests**

Run: `cd frontend && npm run typecheck && npm test`
Expected: typecheck PASS; all Vitest tests PASS (the new `chatStop.test.ts` from Task 1 plus existing suites).

- [ ] **Step 9: Commit**

```bash
git add frontend/src/components/ChatPanel.tsx
git commit -m "feat(chat): wire AbortController stop + keep partial reply marked 已停止"
```

---

### Task 5: CSS — `.msg-stopped` marker + `.is-stop` square

**Files:**
- Modify: `frontend/src/index.css` (`.composer-send-glyph` line ~435; `.msg-error` line ~351)

**Interfaces:** None (presentation only). `.msg-stopped` mirrors `.msg-error`'s layout but uses `--text-dim` (dim, not red). `.composer-send-btn.is-stop` keeps the accent fill so the square reads as an active stop target.

- [ ] **Step 1: Add `.msg-stopped`**

In `frontend/src/index.css`, find:

```css
.msg-error { color: var(--danger); font-size: 12px; margin-top: 6px; }
```

Add directly after it:

```css
.msg-stopped { color: var(--text-dim); font-size: 12px; margin-top: 6px; }
```

- [ ] **Step 2: Add `.composer-send-btn.is-stop`**

In `frontend/src/index.css`, find:

```css
.composer-send-btn:hover:not(:disabled) { filter: brightness(1.08); background: var(--accent-2); }
.composer-attach-glyph, .composer-send-glyph { line-height: 1; }
```

Add directly after it:

```css
/* Stop state: square glyph, same accent fill so it reads as an active target. */
.composer-send-btn.is-stop { background: var(--accent-2); border-color: transparent; }
.composer-send-btn.is-stop:hover { filter: brightness(1.08); }
.composer-send-btn.is-stop .composer-send-glyph { font-size: 13px; }
```

- [ ] **Step 3: Run typecheck (sanity — CSS doesn't typecheck, but confirms no incidental TS drift)**

Run: `cd frontend && npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/index.css
git commit -m "style(chat): 已停止 marker + stop-button square state"
```

---

### Task 6: E2E verification (Playwright + mock LLM)

**Files:**
- No source changes. Uses the existing rig: backend `:8000`, frontend `:5173`, mock LLM `:5050` (`tools/mock_llm.py`), and a Playwright driver. The mock streams fast; to reproduce a mid-stream stop, the driver sends a message and clicks the (square) stop button immediately, OR a tiny per-chunk delay is added to the mock's stream branch temporarily for the test (revert before committing — do not change `mock_llm.py`'s shipped behavior or its title-sniffing phrases).

**Goal:** prove the button toggles ➤→■→➤, partial content is kept with "已停止", and a subsequent send works. Also prove stop-during-search ends cleanly with valid history.

- [ ] **Step 1: Ensure all three servers can run (verify rig)**

This follows the documented verify-setup memory. Confirm (in `Agent_env`):
- Backend: `cd backend && ./run.sh` → `curl -s -o /dev/null -w "be=%{http_code}\n" http://127.0.0.1:8000/api/health`
- Frontend: `cd frontend && npm run dev` → `curl -s -o /dev/null -w "fe=%{http_code}\n" http://127.0.0.1:5173/`
- Mock LLM: `python tools/mock_llm.py` (port 5050)

Expected: be=200, fe=200, mock listening. Configure the frontend to point at `http://127.0.0.1:5050` with any dummy key (the Settings panel / localStorage provider). The mock auto-answers; for non-title requests it streams a short reply (see `tools/mock_llm.py`).

- [ ] **Step 2: Manual mid-stream stop (fastest signal)**

With servers up and a provider pointing at the mock:
1. Open the app, start a new chat, send any message.
2. While "Generating…" shows, click the send button — it should now be a square `■`.
3. Assert: generation stops; the button returns to `➤`; the kept partial text (if any streamed) shows a dim "已停止" line under it; the input re-enables.
4. Send a second message — assert it streams normally (history is valid; no broken tool_calls).

If the mock streams too fast to click mid-stream, temporarily add `time.sleep(0.2)` inside the mock's SSE chunk loop for the test run only, then revert it. Do not commit any change to `tools/mock_llm.py`.

- [ ] **Step 3: Stop during a search (arXiv tool call)**

1. Send a message that triggers `search_arxiv` (e.g. "Find papers on vision transformers"). The mock may or may not emit tool_calls — if the mock does, click `■` while "Searching arXiv…" shows.
2. Assert: the turn ends cleanly; no orphaned `tool_calls` without a result (the search finishes, then the next streamChat rejects on the aborted signal); a follow-up send works.

If the mock never emits tool_calls, this step is best-effort — note that in the result and rely on the unit test + code review for the search-phase path (the safety argument: `runConversation` appends the tool result before the next round, so a round-2 abort can't orphan a tool_call).

- [ ] **Step 4: Run the full Vitest suite + typecheck one more time**

Run: `cd frontend && npm run typecheck && npm test`
Expected: all green.

- [ ] **Step 5: Report results**

Summarize: which asserts passed, anything that couldn't be reproduced (e.g. fast mock streaming), and confirm no `tools/mock_llm.py` changes were committed. No commit step here unless a test driver file is added (optional; the plan does not require shipping a new driver).

---

## Self-Review

**1. Spec coverage:**
- AbortController + `stop()` in ChatPanel + signal into runConversation → Task 4 steps 2,3,4. ✓
- ChatComposer arrow↔square + `onStop` prop → Task 3. ✓
- Catch block user-abort vs real-error branch → Task 4 step 5. ✓
- `MessageRow` renders `ui.stopped` "已停止" → Task 4 step 7. ✓
- `ChatMessage.ui.stopped` type → Task 2. ✓
- CSS `.msg-stopped` + `.is-stop` → Task 5. ✓
- `lib/llm.ts` / `lib/api.ts` unchanged → Global Constraints + noted; no task touches them. ✓
- Edge cases (stop mid-search, double-click, re-entry, empty buf) → handled by Task 4 step 5 logic + verified in Task 6 step 3. ✓
- Mock-LLM contract untouched → Global Constraints + Task 6 step 2 warns not to commit mock changes. ✓
- Verification (typecheck + E2E rig) → Tasks 1/4/6. ✓

**2. Placeholder scan:** No TBD/TODO/"add error handling". Every code step shows full code. The only conditional ("if the mock streams too fast") has a concrete fallback (add a temporary sleep, revert). ✓

**3. Type consistency:** `isAbortError(signal: AbortSignal | null | undefined, err: unknown): boolean` (Task 1) — called in Task 4 step 5 as `isAbortError(controller.signal, e)`; `controller.signal` is `AbortSignal`. ✓ `onStop: () => void` (Task 3) — passed as `onStop={() => stop()}` (Task 4 step 6); `stop()` is `function stop()` returning void. ✓ `ui: { stopped: true }` (Task 4) matches `stopped?: boolean` (Task 2). ✓ `composer-send-btn is-stop` class (Task 3) matches `.composer-send-btn.is-stop` selector (Task 5). ✓

No gaps. Plan is ready.
