# Loopback Origin Unification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop `localhost:5173` vs `127.0.0.1:5173` from looking like data loss: redirect empty `127.0.0.1` to `localhost`, and show a dismissible recovery banner on empty `localhost` pointing at the sibling host.

**Architecture:** Pure decision logic in `lib/origin.ts` (unit-tested). A new `hasHistory` flag on the conversations store (set once at `load()` from the IDB result, unaffected by the in-memory empty chat `ensureRootChat` creates) is the single "does real history exist here?" signal. `App.tsx` reads that flag after load and either `location.replace()`s to the canonical host or renders a new `<OriginBanner>` component. Dev-only: gated on `hostname ∈ {localhost, 127.0.0.1}` + `http:`.

**Tech Stack:** TypeScript, React 18, Zustand, Vitest. No new deps. No DB schema change.

## Global Constraints

- **Dev-only gating:** every redirect/banner decision requires `isLoopbackDevOrigin(hostname, protocol)` true, i.e. `protocol === "http:" && (hostname === "localhost" || hostname === "127.0.0.1")`. Real production domains never fire either mechanism.
- **One-directional redirect only:** redirect fires `127.0.0.1 → localhost`, never the reverse, and only from an empty origin. Never strand data on the wrong origin.
- **Canonical host is `localhost`** (matches what `vite` prints).
- **No `db.ts` / schema changes.** No version bump. Storage layer untouched.
- **No cross-origin data migration.** No iframe, no postMessage. Banner links are plain `<a href>` navigations.
- **localStorage dismissal key:** `lax-origin-banner-dismissed`, per-origin (dismissing on `localhost` does NOT dismiss on `127.0.0.1`).
- **Redirect marker param:** `?laxredir=1`, stripped from the URL via `history.replaceState` after `localhost` reads it.
- **`hasHistory` is read-only after `load()`** — no setter; reflects "did persisted history exist at load time." Computed from IDB result, not from in-memory `conversations` (which `ensureRootChat` mutates).
- **Theme variables** (from `index.css`): `--bg-2`, `--border`, `--text`, `--text-dim`, `--accent`, `--accent-contrast`, `--accent-soft`. Banner must reuse these, not hardcode colors (multi-theme app).
- **Type gate is `npm run typecheck`** (`tsc --noEmit`). There is no lint script. Test gate is `npm test` (Vitest).
- **React.StrictMode is disabled** (`main.tsx`) — do not re-enable.

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `frontend/src/lib/origin.ts` | Create | Pure decision helpers: `CANONICAL_HOST`, `siblingHost`, `isLoopbackDevOrigin`, `redirectTargetForCanonicalHost`, `shouldShowOriginBanner`, `siblingOriginUrl`. Zero DOM/store deps. |
| `frontend/src/lib/origin.test.ts` | Create | Vitest unit tests for every `lib/origin.ts` branch. |
| `frontend/src/store/conversations.ts` | Modify | Add `hasHistory: boolean` to state; set it in `load()` from the IDB result. |
| `frontend/src/components/OriginBanner.tsx` | Create | Dismissible top banner. Reads sibling URL, owns its dismiss button, persists `lax-origin-banner-dismissed`. |
| `frontend/src/App.tsx` | Modify | After `load()`: compute redirect → `location.replace`, else maybe render `<OriginBanner>`; strip `?laxredir=1`. |
| `frontend/src/index.css` | Modify | Add `.origin-banner` styles using theme variables. |

---

### Task 1: Pure origin decision helpers (`lib/origin.ts`) — TDD

**Files:**
- Create: `frontend/src/lib/origin.ts`
- Test: `frontend/src/lib/origin.test.ts`

**Interfaces:**
- Consumes: nothing (pure functions, string in → string|null|boolean out).
- Produces (exact signatures later tasks import):
  - `export const CANONICAL_HOST = "localhost";`
  - `export function siblingHost(hostname: string): string | null`
  - `export function isLoopbackDevOrigin(hostname: string, protocol: string): boolean`
  - `export function redirectTargetForCanonicalHost(hostname: string, protocol: string, hasHistory: boolean, origin: string, pathname: string, search: string, hash: string): string | null`
  - `export function shouldShowOriginBanner(hostname: string, protocol: string, hasHistory: boolean, hasLaxredirParam: boolean, dismissed: boolean): boolean`
  - `export function siblingOriginUrl(hostname: string, protocol: string, port: string, pathname: string, search: string, hash: string): string | null`

- [ ] **Step 1: Write the failing test file**

Create `frontend/src/lib/origin.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  CANONICAL_HOST,
  siblingHost,
  isLoopbackDevOrigin,
  redirectTargetForCanonicalHost,
  shouldShowOriginBanner,
  siblingOriginUrl,
} from "./origin";

describe("isLoopbackDevOrigin", () => {
  it("true for localhost + http", () => {
    expect(isLoopbackDevOrigin("localhost", "http:")).toBe(true);
  });
  it("true for 127.0.0.1 + http", () => {
    expect(isLoopbackDevOrigin("127.0.0.1", "http:")).toBe(true);
  });
  it("false for localhost + https", () => {
    expect(isLoopbackDevOrigin("localhost", "https:")).toBe(false);
  });
  it("false for a real domain + https", () => {
    expect(isLoopbackDevOrigin("app.example.com", "https:")).toBe(false);
  });
});

describe("siblingHost", () => {
  it("maps 127.0.0.1 -> localhost", () => {
    expect(siblingHost("127.0.0.1")).toBe("localhost");
  });
  it("maps localhost -> 127.0.0.1", () => {
    expect(siblingHost("localhost")).toBe("127.0.0.1");
  });
  it("returns null for a non-loopback host", () => {
    expect(siblingHost("app.example.com")).toBeNull();
  });
});

describe("redirectTargetForCanonicalHost", () => {
  // Fires only from an EMPTY 127.0.0.1 over http. Never strands data.
  it("redirects empty 127.0.0.1 (http) to localhost with ?laxredir=1, port/path/hash preserved", () => {
    const target = redirectTargetForCanonicalHost(
      "127.0.0.1", "http:", /*hasHistory*/ false,
      "http://127.0.0.1:5173", "/paper/2401.00001", "?x=1", "#frag"
    );
    expect(target).toBe("http://localhost:5173/paper/2401.00001?x=1&laxredir=1#frag");
  });

  it("appends ?laxredir=1 when there is no existing query", () => {
    const target = redirectTargetForCanonicalHost(
      "127.0.0.1", "http:", false,
      "http://127.0.0.1:5174", "/", "", ""
    );
    expect(target).toBe("http://localhost:5174/?laxredir=1");
  });

  it("does NOT redirect when 127.0.0.1 HAS history (do not strand data)", () => {
    const target = redirectTargetForCanonicalHost(
      "127.0.0.1", "http:", /*hasHistory*/ true,
      "http://127.0.0.1:5173", "/", "", ""
    );
    expect(target).toBeNull();
  });

  it("does NOT redirect when already on localhost", () => {
    expect(
      redirectTargetForCanonicalHost("localhost", "http:", false, "http://localhost:5173", "/", "", "")
    ).toBeNull();
  });

  it("does NOT redirect over https", () => {
    expect(
      redirectTargetForCanonicalHost("127.0.0.1", "https:", false, "https://127.0.0.1:5173", "/", "", "")
    ).toBeNull();
  });

  it("does NOT redirect on a real domain", () => {
    expect(
      redirectTargetForCanonicalHost("app.example.com", "https:", false, "https://app.example.com", "/", "", "")
    ).toBeNull();
  });
});

describe("shouldShowOriginBanner", () => {
  it("shows banner on localhost (http) with no history, no laxredir, not dismissed", () => {
    expect(shouldShowOriginBanner("localhost", "http:", false, false, false)).toBe(true);
  });

  it("suppresses when hasHistory is true", () => {
    expect(shouldShowOriginBanner("localhost", "http:", true, false, false)).toBe(false);
  });

  it("suppresses when arriving via our own redirect (?laxredir=1)", () => {
    expect(shouldShowOriginBanner("localhost", "http:", false, true, false)).toBe(false);
  });

  it("suppresses when previously dismissed", () => {
    expect(shouldShowOriginBanner("localhost", "http:", false, false, true)).toBe(false);
  });

  it("never shows on 127.0.0.1 (redirect handles it, not the banner)", () => {
    expect(shouldShowOriginBanner("127.0.0.1", "http:", false, false, false)).toBe(false);
  });

  it("never shows on a real domain", () => {
    expect(shouldShowOriginBanner("app.example.com", "https:", false, false, false)).toBe(false);
  });
});

describe("siblingOriginUrl", () => {
  it("builds a full URL to the sibling loopback host, preserving port/path/hash", () => {
    const url = siblingOriginUrl("localhost", "http:", "5173", "/paper/2401.00001", "", "#frag");
    expect(url).toBe("http://127.0.0.1:5173/paper/2401.00001#frag");
  });

  it("returns null when not on a loopback dev origin", () => {
    expect(siblingOriginUrl("app.example.com", "https:", "443", "/", "", "")).toBeNull();
  });

  // Banner link deliberately carries NO laxredir so the sibling's own load()
  // treats it as a normal arrival (it may have data to show).
  it("never appends laxredir (target is a fresh arrival at the sibling)", () => {
    const url = siblingOriginUrl("localhost", "http:", "5173", "/", "?a=1", "");
    expect(url).toBe("http://127.0.0.1:5173/?a=1");
    expect(url).not.toContain("laxredir");
  });
});

describe("CANONICAL_HOST", () => {
  it("is localhost (matches what vite prints)", () => {
    expect(CANONICAL_HOST).toBe("localhost");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/lib/origin.test.ts`
Expected: FAIL — `Failed to resolve import "./origin"` (module does not exist yet).

- [ ] **Step 3: Write minimal implementation**

Create `frontend/src/lib/origin.ts`:

```ts
// Pure decision helpers for the loopback-origin unification feature.
//
// Problem: http://localhost:5173 and http://127.0.0.1:5173 are different
// browser origins (host differs) with isolated IndexedDB/localStorage.
// Landing on the "wrong" one shows an empty app indistinguishable from data
// loss. These helpers decide, given the current origin + a "does real
// history exist here?" flag, whether to (a) redirect to the canonical host
// or (b) show a recovery banner. Both are dev-only (loopback + http).
//
// Asymmetry: redirect goes only 127.0.0.1 -> localhost (never the reverse,
// never from a data-bearing origin). Cross-origin IDB is unreadable from JS,
// so we can detect "this origin is empty" but never "the sibling has data";
// on localhost the banner does the recovery instead of an unsafe redirect.

/** Canonical host Vite prints; new empty users consolidate here. */
export const CANONICAL_HOST = "localhost";

/** The sibling loopback host, or null if `hostname` isn't a loopback dev host. */
export function siblingHost(hostname: string): string | null {
  if (hostname === "127.0.0.1") return "localhost";
  if (hostname === "localhost") return "127.0.0.1";
  return null;
}

/** True only for the loopback dev origins this feature targets. */
export function isLoopbackDevOrigin(hostname: string, protocol: string): boolean {
  return protocol === "http:" && (hostname === "localhost" || hostname === "127.0.0.1");
}

/**
 * Decide whether to redirect to the canonical host (localhost).
 * Fires ONLY from an empty 127.0.0.1 over http — never strands data.
 * Returns the target URL to location.replace() to, or null to stay.
 *
 * `origin` is `location.origin` (e.g. "http://127.0.0.1:5173"); we rebuild
 * the target from it so the port (5173, or 5174/5175 when 5173 is taken)
 * is preserved exactly.
 */
export function redirectTargetForCanonicalHost(
  hostname: string,
  protocol: string,
  hasHistory: boolean,
  origin: string,
  pathname: string,
  search: string,
  hash: string
): string | null {
  if (hostname !== "127.0.0.1" || protocol !== "http:" || hasHistory) return null;

  // Swap the host inside location.origin (keeps protocol + port).
  const targetOrigin = origin.replace("//127.0.0.1", "//localhost");

  // Append ?laxredir=1 so the localhost arrival knows it came from our
  // redirect and suppresses the banner. Merge with any existing query.
  const sep = search.length > 0 ? (search.endsWith("?") ? "" : "&") : "?";
  const mergedSearch = `${search}${sep}laxredir=1`;

  return `${targetOrigin}${pathname}${mergedSearch}${hash}`;
}

/**
 * Decide whether to show the "your data may be elsewhere" banner.
 * Fires only on localhost over http, only when empty, only when NOT arriving
 * via our own redirect (no ?laxredir=1), and only if not dismissed.
 */
export function shouldShowOriginBanner(
  hostname: string,
  protocol: string,
  hasHistory: boolean,
  hasLaxredirParam: boolean,
  dismissed: boolean
): boolean {
  if (hostname !== "localhost" || protocol !== "http:") return false;
  if (hasHistory) return false;
  if (hasLaxredirParam) return false;
  if (dismissed) return false;
  return true;
}

/**
 * Build the full URL the banner link points to (the sibling loopback origin).
 * Preserves port/path/hash. Carries NO laxredir — the sibling is a fresh
 * arrival that may have real data to show. Returns null off loopback/http.
 */
export function siblingOriginUrl(
  hostname: string,
  protocol: string,
  port: string,
  pathname: string,
  search: string,
  hash: string
): string | null {
  const sibling = siblingHost(hostname);
  if (!sibling || protocol !== "http:") return null;
  const portPart = port ? `:${port}` : "";
  return `${protocol}//${sibling}${portPart}${pathname}${search}${hash}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/lib/origin.test.ts`
Expected: PASS — all tests green.

- [ ] **Step 5: Commit**

```bash
cd frontend && git add src/lib/origin.ts src/lib/origin.test.ts
git commit -m "feat(origin): pure loopback-origin redirect/banner decision helpers"
```

---

### Task 2: `hasHistory` flag on the conversations store

**Files:**
- Modify: `frontend/src/store/conversations.ts`

**Interfaces:**
- Consumes: `db.listConversations()` (already imported).
- Produces: `useConversations` state gains `hasHistory: boolean`. `load()` sets it `true` iff IDB returned ≥1 conversation with `messages.length > 0`. Read-only after load (no setter). Later tasks read it via `useConversations((s) => s.hasHistory)`.

- [ ] **Step 1: Add `hasHistory` to the `ConvState` interface**

In `frontend/src/store/conversations.ts`, in the `interface ConvState` block, add `hasHistory` next to the other state fields. Replace:

```ts
interface ConvState {
  conversations: Conversation[];
  activeId: string | null;
  loading: boolean;
  loaded: boolean;
```

with:

```ts
interface ConvState {
  conversations: Conversation[];
  activeId: string | null;
  loading: boolean;
  loaded: boolean;
  // True iff IDB held >=1 conversation with messages at load() time. Read-only
  // after load (no setter). Reflects persisted history, NOT in-memory state —
  // ensureRootChat creates an empty in-memory general chat that would falsely
  // flip conversations.length > 0, so the origin-redirect/banner logic reads
  // this flag instead.
  hasHistory: boolean;
```

- [ ] **Step 2: Initialize `hasHistory: false` in the store factory**

Replace:

```ts
  conversations: [],
  activeId: null,
  loading: false,
  loaded: false,
```

with:

```ts
  conversations: [],
  activeId: null,
  loading: false,
  loaded: false,
  hasHistory: false,
```

- [ ] **Step 3: Set `hasHistory` in `load()`**

Replace the `load:` arrow function body:

```ts
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
```

with:

```ts
  load: async () => {
    set({ loading: true });
    const all = await db.listConversations();
    // Purge any legacy empty conversations that previous versions may have
    // persisted, enforcing the invariant that IDB never holds 0-message convs.
    const empties = all.filter((c) => c.messages.length === 0);
    const conversations = all.filter((c) => c.messages.length > 0);
    await Promise.all(empties.map((c) => db.deleteConversation(c.id)));
    // hasHistory reflects persisted history (>=1 conv with messages), NOT the
    // in-memory list (ensureRootChat mutates that). Computed once at load.
    set({ conversations, loading: false, loaded: true, hasHistory: conversations.length > 0 });
  },
```

- [ ] **Step 4: Typecheck**

Run: `cd frontend && npm run typecheck`
Expected: PASS (no errors). `hasHistory` is now a valid state field read elsewhere.

- [ ] **Step 5: Commit**

```bash
cd frontend && git add src/store/conversations.ts
git commit -m "feat(store): expose hasHistory flag (persisted-history signal for origin logic)"
```

---

### Task 3: `<OriginBanner>` component + CSS

**Files:**
- Create: `frontend/src/components/OriginBanner.tsx`
- Modify: `frontend/src/index.css`

**Interfaces:**
- Consumes: `shouldShowOriginBanner` + `siblingOriginUrl` from `lib/origin.ts` (Task 1); `useConversations((s) => s.hasHistory)` from the store (Task 2).
- Produces: component `<OriginBanner />` (named export, no props). **Self-gating:** reads `hasHistory` from the store, captures `arrivedViaRedirect` once at mount via a `useState` initializer (`new URLSearchParams(location.search).has("laxredir")` — stable, captured before App's `?laxredir=1` strip effect runs, since children mount before parent effects), reads `dismissed` from `localStorage["lax-origin-banner-dismissed"]`, and returns `null` unless `shouldShowOriginBanner(hostname, protocol, hasHistory, arrivedViaRedirect, dismissed)` is true. On dismiss, sets that localStorage key and flips local state. `App.tsx` (Task 4) renders `<OriginBanner />` unconditionally at the top of the shell; the component's own null-return hides it.

- [ ] **Step 1: Write the component**

Create `frontend/src/components/OriginBanner.tsx`:

```tsx
// Recovery banner shown on an empty localhost origin (that did NOT arrive via
// our own 127.0.0.1->localhost redirect) pointing at the sibling loopback host
// (127.0.0.1), where the user's data may live. Dismissible; dismissal persists
// per-origin in localStorage so it won't nag again until the key is cleared.
//
// Self-gating: returns null whenever shouldShowOriginBanner is false (has
// history, arrived via redirect, dismissed, or not a loopback dev origin), so
// App.tsx renders <OriginBanner /> unconditionally.

import { useState } from "react";
import { shouldShowOriginBanner, siblingOriginUrl } from "../lib/origin";
import { useConversations } from "../store/conversations";

const DISMISS_KEY = "lax-origin-banner-dismissed";

export function OriginBanner() {
  const hasHistory = useConversations((s) => s.hasHistory);
  // Capture once at mount, BEFORE App's ?laxredir=1 strip effect runs (child
  // mounts before parent effects). Stable for the page's lifetime, so the
  // banner stays suppressed for a redirect-arrival even after the URL is
  // cleaned and later re-renders occur.
  const [arrivedViaRedirect] = useState<boolean>(
    () => new URLSearchParams(location.search).has("laxredir")
  );
  const [dismissed, setDismissed] = useState<boolean>(
    () => localStorage.getItem(DISMISS_KEY) !== null
  );

  if (
    !shouldShowOriginBanner(
      location.hostname,
      location.protocol,
      hasHistory,
      arrivedViaRedirect,
      dismissed
    )
  ) {
    return null;
  }

  const url = siblingOriginUrl(
    location.hostname,
    location.protocol,
    location.port,
    location.pathname,
    location.search,
    location.hash
  );
  // shouldShowOriginBanner already guarantees loopback/http; url is non-null.
  if (!url) return null;

  const dismiss = () => {
    localStorage.setItem(DISMISS_KEY, String(Date.now()));
    setDismissed(true);
  };

  return (
    <div className="origin-banner" role="status">
      <div className="origin-banner-text">
        No history found at this address. If you&rsquo;ve used Little Alphaxiv before,
        your conversations may be stored under another local address.
      </div>
      <div className="origin-banner-actions">
        <a className="origin-banner-link" href={url}>
          Open {location.hostname === "localhost" ? "127.0.0.1" : "localhost"}
        </a>
        <button className="origin-banner-dismiss" onClick={dismiss} aria-label="Dismiss">
          Dismiss
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Add the CSS**

Append to `frontend/src/index.css` (add at end of file). Uses only theme variables so it adapts to every theme:

```css
/* Loopback-origin recovery banner (origin-mismatch warning). */
.origin-banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 10px 16px;
  background: var(--bg-2);
  border-bottom: 1px solid var(--border);
  color: var(--text-dim);
  font-size: 13px;
  line-height: 1.5;
}
.origin-banner-text { flex: 1; min-width: 0; }
.origin-banner-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}
.origin-banner-link {
  color: var(--accent);
  text-decoration: none;
  font-weight: 600;
  white-space: nowrap;
}
.origin-banner-link:hover { text-decoration: underline; }
.origin-banner-dismiss {
  background: transparent;
  border: 1px solid var(--border);
  color: var(--text-dim);
  border-radius: 6px;
  padding: 3px 10px;
  font-size: 12px;
  cursor: pointer;
  white-space: nowrap;
}
.origin-banner-dismiss:hover {
  border-color: var(--border-strong);
  color: var(--text);
}
```

- [ ] **Step 3: Typecheck**

Run: `cd frontend && npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
cd frontend && git add src/components/OriginBanner.tsx src/index.css
git commit -m "feat(ui): dismissible loopback-origin recovery banner"
```

---

### Task 4: Wire redirect + banner into `App.tsx`

**Files:**
- Modify: `frontend/src/App.tsx`

**Interfaces:**
- Consumes: `useConversations((s) => s.hasHistory)` + `s.loaded` (Task 2); `redirectTargetForCanonicalHost` from `lib/origin.ts` (Task 1); `<OriginBanner />` (Task 3).
- Produces: on `localhost:5173`/`127.0.0.1:5173` dev origins, after load: empty `127.0.0.1` `location.replace()`s to `localhost`; empty `localhost` (non-redirect arrival) renders the banner. `?laxredir=1` is stripped from the URL on localhost.

- [ ] **Step 1: Add the imports**

In `frontend/src/App.tsx`, replace the existing import block:

```tsx
import { Sidebar } from "./components/Sidebar";
import { ChatView } from "./views/ChatView";
import { PaperView } from "./views/PaperView";
import { SettingsView } from "./views/SettingsView";
import { useConversations } from "./store/conversations";
import { useSettings } from "./store/settings";
```

with:

```tsx
import { Sidebar } from "./components/Sidebar";
import { OriginBanner } from "./components/OriginBanner";
import { ChatView } from "./views/ChatView";
import { PaperView } from "./views/PaperView";
import { SettingsView } from "./views/SettingsView";
import { useConversations } from "./store/conversations";
import { useSettings } from "./store/settings";
import { redirectTargetForCanonicalHost } from "./lib/origin";
```

- [ ] **Step 2: Add the `hasHistory` selector and the redirect effect**

Replace:

```tsx
  const load = useConversations((s) => s.load);
  const create = useConversations((s) => s.create);
  const setActive = useConversations((s) => s.setActive);
  const conversations = useConversations((s) => s.conversations);
  const loaded = useConversations((s) => s.loaded);
  const navigate = useNavigate();
  const defaultProviderId = useSettings((s) => s.defaultProviderId);

  useEffect(() => {
    load();
  }, [load]);
```

with:

```tsx
  const load = useConversations((s) => s.load);
  const create = useConversations((s) => s.create);
  const setActive = useConversations((s) => s.setActive);
  const conversations = useConversations((s) => s.conversations);
  const loaded = useConversations((s) => s.loaded);
  const hasHistory = useConversations((s) => s.hasHistory);
  const navigate = useNavigate();
  const defaultProviderId = useSettings((s) => s.defaultProviderId);

  useEffect(() => {
    load();
  }, [load]);

  // Loopback-origin unification: localhost and 127.0.0.1 are different browser
  // origins with isolated storage. An EMPTY 127.0.0.1 is safe to redirect to
  // the canonical localhost (never strands data); this is the only redirect
  // direction. Runs once after load() completes.
  useEffect(() => {
    if (!loaded) return;
    const target = redirectTargetForCanonicalHost(
      location.hostname,
      location.protocol,
      hasHistory,
      location.origin,
      location.pathname,
      location.search,
      location.hash
    );
    if (target) location.replace(target);
  }, [loaded, hasHistory]);

  // If we arrived on localhost via our own redirect, strip the ?laxredir=1
  // marker so the URL stays clean. The banner reads its presence to suppress
  // itself for this arrival (see OriginBanner / shouldShowOriginBanner).
  useEffect(() => {
    if (!loaded) return;
    if (location.hostname !== "localhost" || location.protocol !== "http:") return;
    const params = new URLSearchParams(location.search);
    if (!params.has("laxredir")) return;
    params.delete("laxredir");
    const qs = params.toString();
    const cleanSearch = qs ? `?${qs}` : "";
    if (cleanSearch !== location.search) {
      history.replaceState(null, "", `${location.pathname}${cleanSearch}${location.hash}`);
    }
  }, [loaded]);
```

- [ ] **Step 3: Render the banner at the top of the shell**

Replace:

```tsx
  return (
    <div className="app">
      <Sidebar />
      <Routes>
```

with:

```tsx
  return (
    <div className="app">
      <OriginBanner />
      <Sidebar />
      <Routes>
```

(`OriginBanner` is rendered unconditionally; it self-gates via `shouldShowOriginBanner` and returns `null` when there's nothing to show — see Task 3.)

- [ ] **Step 4: Typecheck**

Run: `cd frontend && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Run the full test suite (regression)**

Run: `cd frontend && npm test`
Expected: PASS — all existing tests + the new `origin.test.ts` green.

- [ ] **Step 6: Commit**

```bash
cd frontend && git add src/App.tsx
git commit -m "feat(app): redirect empty 127.0.0.1 to localhost + show recovery banner on empty localhost"
```

---

### Task 5: Manual verification against the real two-origin scenario

**Files:** none (verification only — the two-live-origins case is awkward to drive in Playwright, so logic is covered by Task 1's pure-function tests; this task confirms the wiring against real browser origins).

- [ ] **Step 1: Start the dev server**

Run: `cd frontend && npm run dev`
Note the printed URL (expect `http://localhost:5173/`). Leave it running.

- [ ] **Step 2: Confirm recovery banner on an empty localhost**

In a browser **with cleared site data for localhost** (DevTools → Application → Storage → Clear site data), open `http://localhost:5173/`.
Expected: the recovery banner appears at the top, link reads "Open 127.0.0.1", with a "Dismiss" button. (Your real data lives at 127.0.0.1; this is the "wrong origin, looks empty" case the banner exists for.)

- [ ] **Step 3: Confirm banner dismissal persists**

Click "Dismiss". Reload the page.
Expected: banner does not reappear (dismissal persisted in `localStorage["lax-origin-banner-dismissed"]`).

- [ ] **Step 4: Confirm redirect from empty 127.0.0.1**

In DevTools → Application → IndexedDB, **delete** the `little-alphaxiv` database under the `127.0.0.1:5173` origin (or use a fresh browser profile with no data there). Open `http://127.0.0.1:5173/`.
Expected: the page immediately `location.replace()`s to `http://localhost:5173/?laxredir=1`, then the `?laxredir=1` is stripped from the URL bar. On localhost, the banner does **not** show for this arrival (suppressed by `laxredir`).

- [ ] **Step 5: Confirm NO redirect when 127.0.0.1 has data**

Open `http://127.0.0.1:5173/` in the browser profile where your real history lives (the one that originally had the data).
Expected: **no redirect** — you stay on `127.0.0.1` and see your conversations (redirect only fires from an empty origin; data is never stranded).

- [ ] **Step 6: Confirm production domains are unaffected (static check)**

Open `http://localhost:5173/` → DevTools → Console, run:
```js
location.hostname
```
Confirm it returns `"localhost"` (sanity). Then reason about the gate: `isLoopbackDevOrigin` requires `protocol === "http:"` and host in `{localhost, 127.0.0.1}` — a deployed `https://app.example.com` matches neither, so neither redirect nor banner fires. No action needed beyond confirming the logic in `lib/origin.ts` matches Step 6 (already covered by Task 1 tests 1.4 and the "real domain" cases).

- [ ] **Step 7: Commit any fixups (if verification surfaced a wiring bug)**

If a step failed and required a code change, fix it, re-run `npm run typecheck && npm test`, and:
```bash
cd frontend && git add -A && git commit -m "fix(origin): <what verification surfaced>"
```
If all steps passed with no code changes, nothing to commit — mark this task complete.

---

## Self-Review

**1. Spec coverage** — checking each spec section:
- Mechanism 1 (canonical redirect, conditional, `replace()`, `?laxredir=1`) → Task 1 `redirectTargetForCanonicalHost` + Task 4 effect. ✓
- Mechanism 2 (recovery banner, dismissible, per-origin localStorage, hedged wording, suppressed by `laxredir`) → Task 3 component + Task 1 `shouldShowOriginBanner`. ✓
- Mechanism 3 (URL cleanup via `history.replaceState`) → Task 4 second effect. ✓
- State/code shape: `hasHistory` flag (Task 2), `lib/origin.ts` pure helpers (Task 1), `App.tsx` thin orchestration (Task 4). ✓
- Edge cases: dev-only gate, no back-button trap (`replace()`), no stranding, port-aware (uses `location.origin`/`location.port`), `?laxredir=1` stripped → all in Task 1 tests + Task 4. ✓
- Testing: Vitest pure-function tests for every branch (Task 1), typecheck gate (Tasks 2-4), no E2E (Task 5 manual). ✓
- Out of scope respected: no `db.ts` change, no migration, no `navigator.storage.persist()`. ✓

**2. Placeholder scan** — no TBD/TODO; every code step has full code; every test step has full test code. ✓

**3. Type consistency** — `hasHistory: boolean` defined in Task 2, read in Task 4 as `useConversations((s) => s.hasHistory)` ✓. `redirectTargetForCanonicalHost` signature in Task 1 matches the call in Task 4 (hostname, protocol, hasHistory, origin, pathname, search, hash) ✓. `siblingOriginUrl` signature in Task 1 matches the call in Task 3 (hostname, protocol, port, pathname, search, hash) ✓. `CANONICAL_HOST` exported and tested ✓. `DISMISS_KEY = "lax-origin-banner-dismissed"` matches the Global Constraints value ✓.

No issues found. Plan is complete.
