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
