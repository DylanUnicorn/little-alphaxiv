"""Verify the pure helpers in backend/app/routers/_papershared.py.

No server needed — imports the module directly and asserts behavior. Run with
the Agent_env interpreter:

    conda activate Agent_env
    python tools/verify_papershared.py
"""
from __future__ import annotations

import codecs
import sys
from pathlib import Path

sys.stdout = codecs.getwriter("utf-8")(sys.stdout.buffer, errors="replace")
sys.stderr = codecs.getwriter("utf-8")(sys.stderr.buffer, errors="replace")

# Make backend importable without running the server.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from backend.app.routers._papershared import (  # noqa: E402
    normalize_doi,
    arxiv_id_from_doi,
    abstract_from_inverted_index,
    is_safe_external_url,
)

errors: list[str] = []


def check(label: str, got, want):
    ok = got == want
    print(f"{'PASS' if ok else 'FAIL'} {label}: got={got!r} want={want!r}")
    if not ok:
        errors.append(label)


# --- normalize_doi ---
check("normalize_doi url", normalize_doi("https://doi.org/10.48550/arXiv.2401.12345"), "10.48550/arxiv.2401.12345")
check("normalize_doi prefix", normalize_doi("DOI: 10.1000/xyz"), "10.1000/xyz")
check("normalize_doi none", normalize_doi(None), "")
check("normalize_doi empty", normalize_doi(""), "")

# --- arxiv_id_from_doi ---
check("arxiv_doi new", arxiv_id_from_doi("10.48550/arxiv.2401.12345"), "2401.12345")
check("arxiv_doi case", arxiv_id_from_doi("10.48550/ARXIV.2401.12345"), "2401.12345")
check("arxiv_doi nonarxiv", arxiv_id_from_doi("10.1000/xyz"), None)
check("arxiv_doi empty", arxiv_id_from_doi(""), None)

# --- abstract_from_inverted_index ---
inv = {"hello": [0], "world": [1], "pdf": [3]}
check("inverted_index basic", abstract_from_inverted_index(inv), "hello world pdf")
check("inverted_index none", abstract_from_inverted_index(None), "")
check("inverted_index empty", abstract_from_inverted_index({}), "")

# --- is_safe_external_url ---
check("safe https", is_safe_external_url("https://arxiv.org/pdf/2401.12345")[0], True)
check("unsafe http-not-scheme", is_safe_external_url("ftp://example.org/x")[0], False)
check("unsafe no-scheme", is_safe_external_url("example.org/x")[0], False)
check("unsafe loopback", is_safe_external_url("http://127.0.0.1/x")[0], False)
check("unsafe private", is_safe_external_url("http://10.0.0.1/x")[0], False)
check("unsafe unspecified", is_safe_external_url("http://0.0.0.0/x")[0], False)
check("unsafe empty", is_safe_external_url("")[0], False)

print(f"\nVERDICT: {'PASS' if not errors else 'FAIL'} ({len(errors)} failures)")
sys.exit(0 if not errors else 1)
