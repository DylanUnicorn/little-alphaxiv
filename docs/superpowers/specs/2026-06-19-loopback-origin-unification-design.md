# Loopback Origin Unification — Design Spec

**Date:** 2026-06-19
**Status:** Approved (pending implementation plan)
**Author:** Liudingai

## Problem

Little Alphaxiv stores all state (conversations + papers in IndexedDB, provider/API-key settings in localStorage) in the browser, **per origin**. An origin is `protocol + host + port`, so `http://localhost:5173` and `http://127.0.0.1:5173` are **two different origins** with two fully isolated storage scopes — even though both loop back to the same machine and serve the same Vite dev server.

Observed failure: a user with history under `127.0.0.1:5173` opened `localhost:5173` and saw an empty app (no conversations, no providers). This is **indistinguishable from total data loss** — the app gives zero feedback that the data exists under a sibling address. The Vite dev server prints `http://localhost:5173/` as canonical, but nothing stops the user from typing `127.0.0.1` (or vice-versa), and the two origins silently diverge.

This is a **dev-only** problem: in production the frontend and backend are served from a single real origin. The split only bites the local dev server, where `localhost` and `127.0.0.1` are both reachable.

## Goal

Make the wrong-origin failure **loud** instead of silent, and consolidate new usage onto one canonical host — without ever stranding existing data on the wrong origin, and without moving data across origins (which the same-origin policy forbids from JS).

## Core invariant

> *Land the user on whichever loopback origin holds their data; if neither does, prefer `localhost`.*

Two mechanisms enforce it. They are **asymmetric by design**, because cross-origin IndexedDB is unreadable from JS: we can safely detect "this origin is empty" but never "the sibling origin has data."

## Mechanism 1 — Canonical redirect (127.0.0.1 → localhost, conditional)

On app mount, after `load()` resolves:

- **If** `location.hostname === "127.0.0.1"`
- **and** `location.protocol === "http:"`
- **and** the IDB conversations store held **no** history (no conversation with ≥1 message, see State below)

→ `location.replace()` to the same path/port/hash on `localhost`, appending a `?laxredir=1` marker.

Properties:

- **Safe by construction:** redirect fires only from an *empty* `127.0.0.1`, so nothing is stranded. If the user's data lives at `127.0.0.1`, they are left alone (they are on their data).
- **Recovers the common case:** if data is at `localhost` but the user typed `127.0.0.1` (empty there), they are bounced straight to `localhost` — recovered automatically, no banner needed.
- **`replace()`** (not `assign()`): the back button cannot bounce back into a redirect loop.
- **One-directional:** redirects go only `127.0.0.1 → localhost`, never the reverse. Redirecting *away from* `localhost` would be unsafe (we cannot prove `127.0.0.1` is non-empty).

## Mechanism 2 — Recovery banner (localhost empty → suggest 127.0.0.1)

On `localhost` (http), after `load()`:

- **If** no history
- **and** no `?laxredir=1` marker in the URL (so we never tell the user to go back to the origin we just redirected them *from*)
- **and** the banner has not been previously dismissed (per-origin localStorage flag)

→ show a dismissible top banner:

> *No history found at this address. If you've used Little Alphaxiv before, your conversations may be stored under another local address.* **[Open 127.0.0.1:<port>]** **[Dismiss]**

Properties:

- The link is a plain anchor (`<a href>`) to `http://127.0.0.1:<same-port>/` — a full navigation to the sibling origin.
- Dismissal persists per-origin in `localStorage` under key `lax-origin-banner-dismissed` (set to the dismiss timestamp). A user who dismisses it stays dismissed until they clear that key.
- Hedged wording ("may be stored under another local address") so a genuine first-time user on `localhost` — who legitimately has no history — is not told their data is definitely elsewhere.

## Mechanism 3 — URL cleanup

After `localhost` load reads the `?laxredir=1` marker (to suppress the banner for that arrival), strip it from the URL via `history.replaceState`. The URL the user sees stays clean; no lingering redirect param.

## State & code shape

### `store/conversations.ts` — new `hasHistory` flag

`load()` sets a new stable boolean `hasHistory` on the store: `true` iff IDB holds **any** persisted user data — a conversation with `messages.length > 0` (the same filter `load()` already applies before returning `conversations`), **OR** any annotations, **OR** any cached papers. (Broadened from conversations-only after final review: annotations persist to IDB immediately when a user annotates a PDF, so a conversations-only check would let the redirect fire *away* from an origin holding annotations but no chats — stranding them and producing a confusing bounce. `db.ts` gains two additive read helpers `countAnnotations()` / `countPapers()`; no schema change, no version bump.)

- Why a dedicated flag instead of `conversations.length > 0`: `App.tsx`'s `ensureRootChat` creates an in-memory empty general chat when there is no history. That makes `conversations.length` flip to 1 *without* real history existing, which would wrongly suppress the banner/redirect. `hasHistory` is set once at load from the IDB result and is not affected by the in-memory empty chat.
- `hasHistory` is read-only after `load()` completes (no setter); it reflects "did persisted history exist at load time."

### New `lib/origin.ts` — pure, testable helpers

All redirect/banner logic lives here as pure functions. `App.tsx` and the banner component stay thin.

```ts
// Canonical host Vite prints; new empty users consolidate here.
export const CANONICAL_HOST = "localhost";

/** The sibling loopback host we suggest in the banner. */
export function siblingHost(hostname: string): string | null {
  if (hostname === "127.0.0.1") return "localhost";
  if (hostname === "localhost") return "127.0.0.1";
  return null; // not a loopback dev origin → no sibling concept
}

/** True only for the loopback dev origins this feature targets. */
export function isLoopbackDevOrigin(hostname: string, protocol: string): boolean {
  return protocol === "http:" && (hostname === "localhost" || hostname === "127.0.0.1");
}

/**
 * Decide whether to redirect to the canonical host (localhost).
 * Only fires from an EMPTY 127.0.0.1 — never strands data.
 * Returns the target URL to location.replace() to, or null.
 */
export function redirectTargetForCanonicalHost(
  hostname: string,
  protocol: string,
  hasHistory: boolean,
  origin: string,        // e.g. "http://127.0.0.1:5173"
  pathname: string,
  search: string,
  hash: string
): string | null;

/**
 * Decide whether to show the "your data may be elsewhere" banner.
 * Fires only on localhost, only when empty, only when not arriving via
 * our own redirect (no ?laxredir=1), and only if not dismissed.
 */
export function shouldShowOriginBanner(
  hostname: string,
  protocol: string,
  hasHistory: boolean,
  hasLaxredirParam: boolean,
  dismissed: boolean
): boolean;

/** Build the sibling-origin URL the banner link points to. */
export function siblingOriginUrl(
  hostname: string,
  protocol: string,
  port: string,
  pathname: string,
  search: string,
  hash: string
): string | null;
```

### `App.tsx` — orchestration

After `load()` resolves (inside the existing `useEffect` or a sibling one that runs when `loaded` becomes true):

1. Read `hasHistory` from the store.
2. If `redirectTargetForCanonicalHost(...)` returns a target → `location.replace(target)`. Stop.
3. Else if `shouldShowOriginBanner(...)` → render the `<OriginBanner>` at the top of the app shell.

The banner consumes `siblingOriginUrl(...)` for its link and reads/writes the `lax-origin-banner-dismissed` localStorage key for its own dismissal (the read result is passed into `shouldShowOriginBanner` as `dismissed`; the dismiss action sets the key and flips local component state to hide).

### `<OriginBanner>` component

New small component. Matches existing empty-state styling (`.chat-empty` / `.conv-empty` family). Fixed top banner, dismissible, anchor link to the sibling origin. No new toast/notification system is introduced (none exists today); a single purpose-built banner is cheaper than scaffolding one.

## Edge cases & safety

- **Dev-only gating:** both redirect and banner require `isLoopbackDevOrigin(hostname, protocol)`. On a real production domain (`https://app.example.com`) nothing fires — a first-time prod user never sees a misleading banner.
- **No back-button trap:** `replace()` + strictly one-directional redirect.
- **No stranding:** redirect fires only from an empty `127.0.0.1`; data-bearing origins are never left.
- **Port-aware:** uses `location.port`, so when Vite falls back to `5174`/`5175` (5173 taken) the redirect/banner still target the correct sibling port. Path and hash preserved so deep links (`/paper/<id>`) survive the redirect.
- **`?laxredir=1`** stripped from the URL via `history.replaceState` after `localhost` reads it.
- **localStorage dismissal** is per-origin, so dismissing on `localhost` does not dismiss on `127.0.0.1` (correct — they are genuinely different storage scopes).

## Testing (Vitest)

`lib/origin.ts` is pure, so it is exhaustively unit-tested. Each branch of the invariant gets a case:

1. `127.0.0.1` + http + no history → redirects to `localhost` (with `?laxredir=1`, port/path/hash preserved).
2. `127.0.0.1` + http + **has** history → no redirect (do not strand).
3. `127.0.0.1` + **https** → no redirect (not a dev origin).
4. `localhost` + http + no history + no `laxredir` + not dismissed → banner shown.
5. `localhost` + http + no history + **`laxredir=1`** → banner suppressed (we arrived via our own redirect).
6. `localhost` + http + no history + **dismissed** → banner suppressed.
7. `localhost` + http + **has** history → no banner.
8. Real domain (`app.example.com`) + https → no redirect, no banner (dev-only gate).
9. `siblingHost` symmetry; `siblingOriginUrl` port/path/hash preservation.
10. `hasHistory` semantics: `load()` sets it true iff IDB holds ≥1 conversation with messages, OR any annotations, OR any cached papers.

Decision logic is fully covered by pure-function tests (`origin.test.ts`, 24 tests). `App.tsx` wiring is verified by `npm run typecheck`. A Playwright smoke test additionally verifies the user-visible surface (banner renders full-width on an empty `localhost` origin; redirect fires from an empty `127.0.0.1`).

## Out of scope

- **Cross-origin data migration** (the iframe + `postMessage` import/export dance). Rejected during brainstorming: the banner+redirect recovers and prevents divergence without moving data, at far lower complexity and risk.
- **IPv6 `[::1]` loopback alias** — rare in this workflow; noted as a possible future extension (`siblingHost` would gain a third case).
- **`navigator.storage.persist()`** (best-effort eviction protection) — separate concern, not this bug. (Current app does not request persistence; noted for a future hardening pass.)

## Non-regression notes

- `store/conversations.ts`'s existing empty-conversation purge in `load()` is unchanged; `hasHistory` is computed from the post-purge, pre-empty-chat list.
- `db.ts` gains two additive read helpers (`countAnnotations`, `countPapers`) for the broadened `hasHistory`; no schema change, no version bump.
- The `?laxredir=1` param is internal and ephemeral; no router changes needed (React Router ignores unknown query params).
