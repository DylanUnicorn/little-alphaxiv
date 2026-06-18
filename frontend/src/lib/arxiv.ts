// arXiv paper-id extraction from URLs and "arXiv:<id>" references.
//
// Used by the markdown renderer to turn arXiv links in assistant answers into
// in-app preview cards (navigating to /paper/<id>) instead of external
// arxiv.org links. We only match explicit arXiv references (arxiv.org URLs or
// an "arXiv:" prefix) plus bare new-style ids, so unrelated links and version
// strings don't get false-matched into paper routes.

// Matches arxiv.org/abs/<id> or arxiv.org/pdf/<id>, tolerating missing scheme.
const ARXIV_URL_RE = /arxiv\.org\/(?:abs|pdf)\/([^\s"'<>?#]+)/i;
// Matches an "arXiv:<id>" reference (e.g. as link text).
const ARXIV_PREFIX_RE = /arxiv:\s*([^\s"'<>]+)/i;
// Valid arXiv id shapes: new-style 2401.12345 (optional version vN), or
// old-style cs.LG/0701234 / cond-mat/0701001.
const ARXIV_ID_RE =
  /^(?:\d{4}\.\d{4,5}(?:v\d+)?|[a-z.-]+\/\d{7}(?:v\d+)?)$/i;

/** Strip a trailing .pdf / query / fragment and validate the id shape. */
function normalize(raw: string): string | null {
  let id = raw.trim().replace(/\.pdf$/i, "");
  id = id.split(/[?#]/)[0];
  return ARXIV_ID_RE.test(id) ? id : null;
}

/** Extract an arXiv paper id from a URL / "arXiv:<id>" string, or null when
 *  the input isn't an arXiv reference. */
export function extractArxivId(input: string): string | null {
  if (!input) return null;
  const url = input.match(ARXIV_URL_RE);
  if (url) return normalize(decodeURIComponent(url[1]));
  const prefix = input.match(ARXIV_PREFIX_RE);
  if (prefix) return normalize(prefix[1]);
  // Bare new-style id used directly as a href (rare).
  return normalize(input);
}
