#!/usr/bin/env bash
# Build a single-file AppImage from the portable Linux bundle.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
APP_NAME="LittleAlphaxiv"
OUT_ROOT="$ROOT/dist/linux"
APP_DIR="$OUT_ROOT/$APP_NAME"

if [ -n "${LAX_APP_VERSION:-}" ]; then
  VERSION="$LAX_APP_VERSION"
elif git -C "$ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  VERSION="$(git -C "$ROOT" describe --tags --always --dirty 2>/dev/null || git -C "$ROOT" rev-parse --short HEAD)"
else
  VERSION="$(date +%Y%m%d)"
fi

APPIMAGE="$OUT_ROOT/${APP_NAME}-${VERSION}-x86_64.AppImage"
TOOL="${APPIMAGETOOL:-$OUT_ROOT/appimagetool-x86_64.AppImage}"
TOOL_URL="${APPIMAGETOOL_URL:-https://github.com/AppImage/AppImageKit/releases/download/continuous/appimagetool-x86_64.AppImage}"

if [ "$(uname -m)" != "x86_64" ]; then
  echo "[build-appimage] This script currently builds x86_64 AppImages only." >&2
  exit 1
fi

if [ "${LAX_SKIP_APPDIR_BUILD:-0}" != "1" ]; then
  "$SCRIPT_DIR/build-linux-app.sh"
elif [ ! -x "$APP_DIR/AppRun" ]; then
  "$SCRIPT_DIR/build-linux-app.sh"
fi

if [ ! -x "$TOOL" ]; then
  mkdir -p "$OUT_ROOT"
  echo "[build-appimage] Downloading appimagetool"
  curl -L "$TOOL_URL" -o "$TOOL"
  chmod +x "$TOOL"
fi

echo "[build-appimage] Building $APPIMAGE"
rm -f "$APPIMAGE"
ARCH=x86_64 APPIMAGE_EXTRACT_AND_RUN=1 "$TOOL" "$APP_DIR" "$APPIMAGE"
chmod +x "$APPIMAGE"

echo "[build-appimage] Done"
echo "[build-appimage] AppImage: $APPIMAGE"
