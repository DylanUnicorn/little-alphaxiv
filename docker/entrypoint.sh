#!/bin/sh
# Little Alphaxiv container entrypoint.
#
# Ensures LAX_SECRET_KEY is available and STABLE across container recreations.
# Resolution order:
#   1. LAX_SECRET_KEY env var (set by the operator via compose/env_file) — respected as-is.
#   2. /app/data/.lax_secret_key  (the mounted data volume) — reused.
#   3. generated once on first run → written to /app/data/.lax_secret_key.
#
# Why persist it: LAX_SECRET_KEY encrypts every stored API key (Fernet) and signs
# every session cookie. If it changes, all encrypted keys + active sessions are
# orphaned. Generating it into the data volume (not the ephemeral image layer)
# keeps it stable across `docker compose down/up` and image rebuilds.
set -e

DATA_DIR="/app/data"
KEY_FILE="${DATA_DIR}/.lax_secret_key"

if [ -z "${LAX_SECRET_KEY:-}" ]; then
  mkdir -p "$DATA_DIR"
  if [ -s "$KEY_FILE" ]; then
    LAX_SECRET_KEY="$(cat "$KEY_FILE")"
    echo "[lax] reusing LAX_SECRET_KEY from $KEY_FILE"
  else
    # cryptography is installed (it's in requirements.txt), so generate a real Fernet key.
    LAX_SECRET_KEY="$(python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())")"
    printf '%s' "$LAX_SECRET_KEY" > "$KEY_FILE"
    chmod 600 "$KEY_FILE"
    echo "[lax] generated LAX_SECRET_KEY into $KEY_FILE (persists in the data volume)"
  fi
  export LAX_SECRET_KEY
fi

exec "$@"
