#!/usr/bin/env bash
# Run the Little Alphaxiv backend proxy.
# Usage: ./run.sh   (activates Agent_env if available, installs deps if missing)
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Point local dev at the SAME data dir Docker uses (../deploy/data/), so the
# native dev server and the container share one DB + PDF cache + secret key
# (no data fork). Only set if the operator hasn't configured their own — an
# explicit LAX_DATABASE_URL / LAX_PDF_CACHE always wins.
DEPLOY_DATA="$SCRIPT_DIR/../deploy/data"
if [ -z "${LAX_DATABASE_URL:-}" ]; then
  export LAX_DATABASE_URL="sqlite:///$DEPLOY_DATA/little_alphaxiv.db"
fi
if [ -z "${LAX_PDF_CACHE:-}" ]; then
  export LAX_PDF_CACHE="$DEPLOY_DATA/pdf_cache"
fi
mkdir -p "$DEPLOY_DATA" 2>/dev/null || true

# Activate Agent_env if conda is present (per global Python env rule).
if command -v conda >/dev/null 2>&1; then
  if conda env list | grep -q "Agent_env"; then
    # shellcheck disable=SC1091
    source "$(conda info --base)/etc/profile.d/conda.sh"
    conda activate Agent_env
  fi
fi

# Guard: backend uses Python 3.10+ syntax (PEP 604 `X | None`). Older Pythons
# (e.g. WSL's system Python 3.8) blow up with a cryptic pydantic traceback when
# FastAPI evaluates route annotations — refuse fast with a clear message instead.
# On Windows, prefer run.bat (it never touches WSL).
if ! python -c "import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)" 2>/dev/null; then
  echo "[run.sh] ERROR: Python 3.10+ required (found $(python --version 2>&1))." >&2
  echo "[run.sh] The backend uses PEP 604 union syntax unsupported below Python 3.10." >&2
  echo "[run.sh] Fix: run under the conda 'Agent_env' env (Python 3.10)." >&2
  echo "[run.sh]   Windows CMD: use 'run.bat' (avoids WSL's Python 3.8)." >&2
  echo "[run.sh]   Or:  conda activate Agent_env && uvicorn app.main:app --host 127.0.0.1 --port 8000 --reload" >&2
  exit 1
fi

# Install deps if fastapi isn't importable.
python -c "import fastapi" 2>/dev/null || pip install -r requirements.txt

# Run uvicorn. Backend dir is parent of app/ package, so module is app.main.
exec uvicorn app.main:app --host 127.0.0.1 --port 8000 --reload
