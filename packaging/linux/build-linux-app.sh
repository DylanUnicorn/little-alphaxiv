#!/usr/bin/env bash
# Build a portable one-click Linux bundle for Little Alphaxiv.
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

ARCHIVE="$OUT_ROOT/${APP_NAME}-${VERSION}-linux-x86_64.tar.gz"

need_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "[build-linux-app] Missing required command: $1" >&2
    exit 1
  fi
}

pick_python() {
  if [ -n "${PYTHON:-}" ]; then
    printf '%s\n' "$PYTHON"
    return
  fi
  if command -v python3.12 >/dev/null 2>&1; then
    printf '%s\n' "python3.12"
    return
  fi
  printf '%s\n' "python3"
}

need_cmd npm
need_cmd tar

PYTHON_BIN="$(pick_python)"
need_cmd "$PYTHON_BIN"

"$PYTHON_BIN" - <<'PY'
import sys

if sys.version_info < (3, 10):
    raise SystemExit("Python 3.10+ is required")
PY

PY_MM="$("$PYTHON_BIN" - <<'PY'
import sys

print(f"{sys.version_info.major}.{sys.version_info.minor}")
PY
)"
PY_EXE="$("$PYTHON_BIN" - <<'PY'
import sys

print(sys.executable)
PY
)"
PY_STDLIB="$("$PYTHON_BIN" - <<'PY'
import sysconfig

print(sysconfig.get_path("stdlib"))
PY
)"

echo "[build-linux-app] Building frontend"
(
  cd "$ROOT/frontend"
  npm ci
  npm run build
)

echo "[build-linux-app] Creating bundle at $APP_DIR"
rm -rf "$APP_DIR"
mkdir -p "$APP_DIR/backend" "$APP_DIR/frontend" "$APP_DIR/data" "$APP_DIR/python/bin" "$APP_DIR/python/lib" "$OUT_ROOT"

cp -a "$ROOT/backend/app" "$APP_DIR/backend/app"
cp -a "$ROOT/backend/alembic" "$APP_DIR/backend/alembic"
cp "$ROOT/backend/alembic.ini" "$APP_DIR/backend/alembic.ini"
cp "$ROOT/backend/requirements.txt" "$APP_DIR/backend/requirements.txt"
cp -a "$ROOT/frontend/dist" "$APP_DIR/frontend/dist"
cp "$ROOT/LICENSE" "$APP_DIR/LICENSE"
cp "$ROOT/README.md" "$APP_DIR/README.md"
cp "$ROOT/README.zh-CN.md" "$APP_DIR/README.zh-CN.md"
cp "$ROOT/frontend/public/favicon.svg" "$APP_DIR/little-alphaxiv.svg"
cp "$SCRIPT_DIR/AppRun" "$APP_DIR/AppRun"
chmod +x "$APP_DIR/AppRun"

cat > "$APP_DIR/little-alphaxiv.desktop" <<'DESKTOP'
[Desktop Entry]
Type=Application
Name=Little Alphaxiv
Comment=Self-hosted arXiv paper reading workspace
Exec=AppRun
Icon=little-alphaxiv
Terminal=true
Categories=Office;Education;Science;
StartupNotify=false
DESKTOP
ln -sf little-alphaxiv.svg "$APP_DIR/.DirIcon"

cat > "$APP_DIR/install-desktop-entry.sh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail

APPDIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DESKTOP_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
ICON_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/icons/hicolor/scalable/apps"

mkdir -p "$DESKTOP_DIR" "$ICON_DIR"
cp "$APPDIR/little-alphaxiv.svg" "$ICON_DIR/little-alphaxiv.svg"

cat > "$DESKTOP_DIR/little-alphaxiv.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Little Alphaxiv
Comment=Self-hosted arXiv paper reading workspace
Exec=$APPDIR/AppRun
Icon=little-alphaxiv
Terminal=true
Categories=Office;Education;Science;
StartupNotify=false
EOF

chmod +x "$DESKTOP_DIR/little-alphaxiv.desktop"
if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database "$DESKTOP_DIR" >/dev/null 2>&1 || true
fi

echo "Installed desktop entry: $DESKTOP_DIR/little-alphaxiv.desktop"
SH
chmod +x "$APP_DIR/install-desktop-entry.sh"

cat > "$APP_DIR/README-linux-app.md" <<'MD'
# Little Alphaxiv Linux App

Run:

```bash
./AppRun
```

The launcher starts the bundled FastAPI server on `127.0.0.1:8000` and opens the browser.
If port 8000 is busy, it tries ports 8001-8020. To force a port:

```bash
LAX_PORT=8080 ./AppRun
```

Runtime data is stored in `data/` next to `AppRun` when that directory is writable.
If the app directory is read-only, the launcher falls back to
`$XDG_DATA_HOME/little-alphaxiv` or `~/.local/share/little-alphaxiv`.

Optional desktop integration:

```bash
./install-desktop-entry.sh
```
MD

echo "[build-linux-app] Bundling Python $PY_MM runtime"
cp "$PY_EXE" "$APP_DIR/python/bin/python$PY_MM"
ln -sf "python$PY_MM" "$APP_DIR/python/bin/python3"
ln -sf "python$PY_MM" "$APP_DIR/python/bin/python"
cp -a "$PY_STDLIB" "$APP_DIR/python/lib/python$PY_MM"
mkdir -p "$APP_DIR/python/lib/python$PY_MM/site-packages"
find "$APP_DIR/python/lib/python$PY_MM" -type d -name '__pycache__' -prune -exec rm -rf {} +
rm -rf \
  "$APP_DIR/python/lib/python$PY_MM/test" \
  "$APP_DIR/python/lib/python$PY_MM/idlelib" \
  "$APP_DIR/python/lib/python$PY_MM/tkinter" \
  "$APP_DIR/python/lib/python$PY_MM/turtledemo" \
  "$APP_DIR/python/lib/python$PY_MM/ensurepip"

echo "[build-linux-app] Installing Python dependencies into bundled runtime"
"$PYTHON_BIN" -m pip install --upgrade --target "$APP_DIR/python/lib/python$PY_MM/site-packages" -r "$ROOT/backend/requirements.txt"

echo "[build-linux-app] Creating archive $ARCHIVE"
rm -f "$ARCHIVE"
tar -C "$OUT_ROOT" -czf "$ARCHIVE" "$APP_NAME"

echo "[build-linux-app] Done"
echo "[build-linux-app] Bundle:  $APP_DIR"
echo "[build-linux-app] Archive: $ARCHIVE"
