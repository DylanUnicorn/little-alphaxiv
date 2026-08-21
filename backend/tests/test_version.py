"""Runtime application-version contract."""
from __future__ import annotations

import json
import re
from pathlib import Path

from app.main import app
from app.version import APP_VERSION, read_version


ROOT = Path(__file__).resolve().parents[2]


def test_version_file_is_the_release_source_of_truth() -> None:
    version = (ROOT / "VERSION").read_text(encoding="utf-8").strip()
    package = json.loads((ROOT / "frontend" / "package.json").read_text(encoding="utf-8"))

    assert re.fullmatch(r"\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?", version)
    assert package["version"] == version
    assert APP_VERSION == version
    assert app.version == version


def test_read_version_falls_back_for_missing_or_blank_files(tmp_path: Path) -> None:
    assert read_version(tmp_path / "missing") == "unknown"

    blank = tmp_path / "VERSION"
    blank.write_text("  \n", encoding="utf-8")
    assert read_version(blank) == "unknown"


def test_release_packaging_includes_the_version_file() -> None:
    dockerfile = (ROOT / "deploy" / "Dockerfile").read_text(encoding="utf-8")
    linux_builder = (ROOT / "packaging" / "linux" / "build-linux-run.sh").read_text(
        encoding="utf-8"
    )

    assert "COPY VERSION /app/VERSION" in dockerfile
    assert 'cp "$VERSION_FILE" "$APP_DIR/VERSION"' in linux_builder


async def test_version_endpoint_returns_runtime_version(client) -> None:
    response = await client.get("/api/version")

    assert response.status_code == 200
    assert response.json() == {"version": APP_VERSION}
