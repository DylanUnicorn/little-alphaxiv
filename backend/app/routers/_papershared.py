"""Pure helpers shared by the OpenAlex and Semantic Scholar search routers.

Kept side-effect-free and import-light so tools/verify_papershared.py can unit
test them without standing up the FastAPI app.
"""
from __future__ import annotations

import ipaddress
import socket
from urllib.parse import urlparse


def normalize_doi(raw: str | None) -> str:
    """Lowercase a DOI and strip any URL/prefix wrapper. '' for falsy."""
    if not raw:
        return ""
    d = raw.strip().lower()
    for prefix in ("https://doi.org/", "http://doi.org/", "doi:", "doi "):
        if d.startswith(prefix):
            d = d[len(prefix):]
            break
    return d.strip()


def arxiv_id_from_doi(doi: str) -> str | None:
    """OpenAlex indexes arXiv preprints with DOI prefix 10.48550/arxiv.<id>.
    Return the bare arXiv id, or None if this DOI isn't an arXiv preprint."""
    d = normalize_doi(doi)
    if not d.startswith("10.48550/arxiv."):
        return None
    tail = d[len("10.48550/arxiv."):]
    return tail or None


def abstract_from_inverted_index(inv: dict | None) -> str:
    """OpenAlex stores abstracts as {word: [positions]}. Reconstruct the text
    in position order. '' for falsy/empty input."""
    if not inv:
        return ""
    max_pos = 0
    for positions in inv.values():
        for p in positions:
            if p > max_pos:
                max_pos = p
    words: list[str] = [""] * (max_pos + 1)
    for word, positions in inv.items():
        for p in positions:
            if 0 <= p <= max_pos:
                words[p] = word
    # Drop empty slots (OpenAlex leaves gaps where stop-words were removed) so
    # join doesn't emit doubled spaces.
    return " ".join(w for w in words if w).strip()


def is_safe_external_url(url: str) -> tuple[bool, str]:
    """SSRF guard for the open PDF proxy. Returns (ok, reason).
    Rejects non-http(s) schemes, unparseable URLs, and hosts that resolve to
    private / loopback / link-local / multicast / reserved / unspecified IPs."""
    if not url:
        return False, "empty url"
    try:
        parsed = urlparse(url)
    except ValueError as exc:
        return False, f"unparseable: {exc}"
    if parsed.scheme not in ("http", "https"):
        return False, f"unsupported scheme: {parsed.scheme}"
    host = parsed.hostname
    if not host:
        return False, "no host"
    # Resolve and check every returned address — one unsafe IP fails the URL.
    try:
        infos = socket.getaddrinfo(host, None)
    except socket.gaierror as exc:
        return False, f"dns resolution failed: {exc}"
    for info in infos:
        ip_str = info[4][0]
        try:
            ip = ipaddress.ip_address(ip_str)
        except ValueError:
            continue
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_multicast or ip.is_reserved or ip.is_unspecified:
            return False, f"host resolves to non-public ip: {ip}"
    return True, "ok"
