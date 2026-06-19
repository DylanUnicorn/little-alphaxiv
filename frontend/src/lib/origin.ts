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
