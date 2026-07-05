#!/usr/bin/env bash
# Build a single-file self-extracting Linux app.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
APP_NAME="LittleAlphaxiv"
OUT_ROOT="$ROOT/app"
BUILD_ROOT="$OUT_ROOT/.build"
APP_DIR="$BUILD_ROOT/$APP_NAME"

if [ -n "${LAX_APP_VERSION:-}" ]; then
  VERSION="$LAX_APP_VERSION"
elif git -C "$ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  VERSION="$(git -C "$ROOT" describe --tags --always --dirty 2>/dev/null || git -C "$ROOT" rev-parse --short HEAD)"
else
  VERSION="$(date +%Y%m%d)"
fi

PAYLOAD="$BUILD_ROOT/${APP_NAME}-${VERSION}-payload.tar.gz"
RUNNER="$OUT_ROOT/${APP_NAME}-${VERSION}-x86_64.run"

need_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "[build-linux-run] Missing required command: $1" >&2
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
need_cmd sha256sum

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

echo "[build-linux-run] Building frontend"
(
  cd "$ROOT/frontend"
  npm ci
  npm run build
)

echo "[build-linux-run] Creating app payload"
rm -rf "$APP_DIR"
mkdir -p "$APP_DIR/backend" "$APP_DIR/frontend" "$APP_DIR/python/bin" "$APP_DIR/python/lib" "$BUILD_ROOT" "$OUT_ROOT"

cp -a "$ROOT/backend/app" "$APP_DIR/backend/app"
cp -a "$ROOT/backend/alembic" "$APP_DIR/backend/alembic"
cp "$ROOT/backend/alembic.ini" "$APP_DIR/backend/alembic.ini"
cp "$ROOT/backend/requirements.txt" "$APP_DIR/backend/requirements.txt"
cp -a "$ROOT/frontend/dist" "$APP_DIR/frontend/dist"
cp "$ROOT/LICENSE" "$APP_DIR/LICENSE"
cp "$ROOT/README.md" "$APP_DIR/README.md"
cp "$ROOT/README.zh-CN.md" "$APP_DIR/README.zh-CN.md"

cat > "$APP_DIR/launch.sh" <<'LAUNCH'
#!/usr/bin/env bash
set -euo pipefail

APPDIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PYTHON_BIN=""
PYTHONHOME_DIR=""

for candidate in "$APPDIR"/python/bin/python3.* "$APPDIR"/python/bin/python3 "$APPDIR"/python/bin/python; do
  if [ -x "$candidate" ]; then
    PYTHON_BIN="$candidate"
    PYTHONHOME_DIR="$APPDIR/python"
    break
  fi
done

if [ -z "$PYTHON_BIN" ]; then
  echo "[Little Alphaxiv] Missing bundled Python runtime." >&2
  exit 1
fi

export PYTHONHOME="$PYTHONHOME_DIR"
for site_packages in "$PYTHONHOME_DIR"/lib/python*/site-packages; do
  if [ -d "$site_packages" ]; then
    export PYTHONPATH="${site_packages}${PYTHONPATH:+:$PYTHONPATH}"
  fi
done

port_is_free() {
  "$PYTHON_BIN" - "$1" <<'PY'
import socket
import sys

port = int(sys.argv[1])
with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    try:
        s.bind(("127.0.0.1", port))
    except OSError:
        sys.exit(1)
sys.exit(0)
PY
}

health_ok() {
  "$PYTHON_BIN" - "$1" <<'PY'
import sys
import urllib.request

url = sys.argv[1].rstrip("/") + "/api/health"
try:
    with urllib.request.urlopen(url, timeout=1.5) as r:
        sys.exit(0 if r.status == 200 else 1)
except Exception:
    sys.exit(1)
PY
}

open_url() {
  local url="$1"
  if command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$url" >/dev/null 2>&1 &
  else
    echo "[Little Alphaxiv] Open this URL in your browser: $url"
  fi
}

HOST="${LAX_HOST:-127.0.0.1}"
PORT="${LAX_PORT:-8000}"
PORT_WAS_SET=0
if [ -n "${LAX_PORT:-}" ]; then
  PORT_WAS_SET=1
fi

URL="http://$HOST:$PORT"
if health_ok "$URL"; then
  echo "[Little Alphaxiv] Already running at $URL"
  open_url "$URL"
  exit 0
fi

if ! port_is_free "$PORT"; then
  if [ "$PORT_WAS_SET" -eq 1 ]; then
    echo "[Little Alphaxiv] Port $PORT is busy. Set LAX_PORT to another port." >&2
    exit 1
  fi

  found=""
  for candidate in $(seq 8001 8020); do
    if port_is_free "$candidate"; then
      found="$candidate"
      break
    fi
  done
  if [ -z "$found" ]; then
    echo "[Little Alphaxiv] No free port found in 8000-8020." >&2
    exit 1
  fi
  PORT="$found"
  URL="http://$HOST:$PORT"
fi

DATA_DIR="${LAX_DATA_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/little-alphaxiv}"
mkdir -p "$DATA_DIR" "$DATA_DIR/pdf_cache"

export LAX_DATABASE_URL="${LAX_DATABASE_URL:-sqlite:///$DATA_DIR/little_alphaxiv.db}"
export LAX_PDF_CACHE="${LAX_PDF_CACHE:-$DATA_DIR/pdf_cache}"
export LAX_ALLOWED_ORIGINS="${LAX_ALLOWED_ORIGINS:-http://127.0.0.1:$PORT,http://localhost:$PORT}"
export LAX_SECURE_COOKIES="${LAX_SECURE_COOKIES:-false}"

cd "$APPDIR/backend"

echo "[Little Alphaxiv] Data: $DATA_DIR"
echo "[Little Alphaxiv] URL:  $URL"

"$PYTHON_BIN" -m uvicorn app.main:app --host "$HOST" --port "$PORT" &
SERVER_PID="$!"

cleanup() {
  if kill -0 "$SERVER_PID" >/dev/null 2>&1; then
    kill "$SERVER_PID" >/dev/null 2>&1 || true
    wait "$SERVER_PID" >/dev/null 2>&1 || true
  fi
}
trap cleanup INT TERM EXIT

for _ in $(seq 1 80); do
  if health_ok "$URL"; then
    open_url "$URL"
    wait "$SERVER_PID"
    exit $?
  fi
  if ! kill -0 "$SERVER_PID" >/dev/null 2>&1; then
    wait "$SERVER_PID"
    exit $?
  fi
  sleep 0.25
done

echo "[Little Alphaxiv] Server did not become healthy in time." >&2
exit 1
LAUNCH
chmod +x "$APP_DIR/launch.sh"

echo "[build-linux-run] Bundling Python $PY_MM runtime"
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

echo "[build-linux-run] Installing Python dependencies"
"$PYTHON_BIN" -m pip install --upgrade --target "$APP_DIR/python/lib/python$PY_MM/site-packages" -r "$ROOT/backend/requirements.txt"

rm -f "$PAYLOAD"
tar -C "$BUILD_ROOT" -czf "$PAYLOAD" "$APP_NAME"
PAYLOAD_SHA="$(sha256sum "$PAYLOAD" | awk '{print $1}')"

echo "[build-linux-run] Creating $RUNNER"
cat > "$RUNNER" <<SH
#!/usr/bin/env bash
set -euo pipefail

APP_NAME="$APP_NAME"
PAYLOAD_SHA="$PAYLOAD_SHA"
BASE_DIR="\${XDG_CACHE_HOME:-\$HOME/.cache}/little-alphaxiv"
APPDIR="\$BASE_DIR/\$PAYLOAD_SHA/\$APP_NAME"
MARKER="__LITTLE_ALPHAXIV_PAYLOAD_BELOW__"

if [ ! -x "\$APPDIR/launch.sh" ]; then
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

exec "\$APPDIR/launch.sh" "\$@"

__LITTLE_ALPHAXIV_PAYLOAD_BELOW__
SH
cat "$PAYLOAD" >> "$RUNNER"
chmod +x "$RUNNER"

echo "[build-linux-run] Done"
echo "[build-linux-run] App: $RUNNER"
