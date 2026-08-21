"""Read the release version shipped with every Little Alphaxiv runtime."""
from __future__ import annotations

from pathlib import Path


# Source checkout: <repo>/backend/app/version.py -> <repo>/VERSION
# Docker/portable: /app/backend/app/version.py -> /app/VERSION
VERSION_FILE = Path(__file__).resolve().parents[2] / "VERSION"


def read_version(version_file: Path | None = None) -> str:
    """Return the packaged version, or a safe diagnostic fallback."""
    candidate = version_file or VERSION_FILE
    try:
        version = candidate.read_text(encoding="utf-8").strip()
    except (OSError, UnicodeError):
        return "unknown"
    return version or "unknown"


APP_VERSION = read_version()
