#!/usr/bin/env bash
# Build a single-file self-extracting Linux runner.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
APP_NAME="LittleAlphaxiv"
OUT_ROOT="$ROOT/dist/linux"

if [ -n "${LAX_APP_VERSION:-}" ]; then
  VERSION="$LAX_APP_VERSION"
elif git -C "$ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  VERSION="$(git -C "$ROOT" describe --tags --always --dirty 2>/dev/null || git -C "$ROOT" rev-parse --short HEAD)"
else
  VERSION="$(date +%Y%m%d)"
fi

ARCHIVE="$OUT_ROOT/${APP_NAME}-${VERSION}-linux-x86_64.tar.gz"
RUNNER="$OUT_ROOT/${APP_NAME}-${VERSION}-x86_64.run"

if ! command -v sha256sum >/dev/null 2>&1; then
  echo "[build-linux-run] Missing required command: sha256sum" >&2
  exit 1
fi

LAX_APP_VERSION="$VERSION" "$SCRIPT_DIR/build-linux-app.sh"
PAYLOAD_SHA="$(sha256sum "$ARCHIVE" | awk '{print $1}')"

echo "[build-linux-run] Creating $RUNNER"
cat > "$RUNNER" <<SH
#!/usr/bin/env bash
set -euo pipefail

APP_NAME="$APP_NAME"
PAYLOAD_SHA="$PAYLOAD_SHA"
BASE_DIR="\${XDG_CACHE_HOME:-\$HOME/.cache}/little-alphaxiv"
APPDIR="\$BASE_DIR/\$PAYLOAD_SHA/\$APP_NAME"
MARKER="__LITTLE_ALPHAXIV_PAYLOAD_BELOW__"

if [ ! -x "\$APPDIR/AppRun" ]; then
  TMP_DIR="\$BASE_DIR/\$PAYLOAD_SHA.tmp.\$\$"
  rm -rf "\$TMP_DIR"
  mkdir -p "\$TMP_DIR" "\$BASE_DIR"
  PAYLOAD_LINE="\$(awk -v marker="\$MARKER" '\$0 == marker { print NR + 1; exit }' "\$0")"
  if [ -z "\$PAYLOAD_LINE" ]; then
    echo "[Little Alphaxiv] Corrupt runner: payload marker not found." >&2
    exit 1
  fi
  tail -n +"\$PAYLOAD_LINE" "\$0" | tar -xzf - -C "\$TMP_DIR"
  rm -rf "\$BASE_DIR/\$PAYLOAD_SHA"
  mv "\$TMP_DIR" "\$BASE_DIR/\$PAYLOAD_SHA"
fi

export LAX_DATA_DIR="\${LAX_DATA_DIR:-\${XDG_DATA_HOME:-\$HOME/.local/share}/little-alphaxiv}"
exec "\$APPDIR/AppRun" "\$@"

__LITTLE_ALPHAXIV_PAYLOAD_BELOW__
SH
cat "$ARCHIVE" >> "$RUNNER"
chmod +x "$RUNNER"

echo "[build-linux-run] Done"
echo "[build-linux-run] Runner: $RUNNER"
