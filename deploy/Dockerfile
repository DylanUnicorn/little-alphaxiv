#
# Little Alphaxiv — single-image build.
#
# Stage 1 builds the React/Vite frontend into static assets.
# Stage 2 runs the FastAPI backend and serves those assets same-origin at "/"
# (see backend/app/main.py — frontend/dist is mounted last, after /api/*).
#
# Build:  cd deploy && docker compose build
# Run:    cd deploy && docker compose up -d
# Open:   http://127.0.0.1:8000  → redirected to /login → Register.
#
# This Dockerfile lives in deploy/ but the build context is the repo root
# (set in docker-compose.yml: context = ..), so COPY paths are relative to
# the repo root (frontend/, backend/, deploy/entrypoint.sh).

# ─────────────────────────── Stage 1: frontend ───────────────────────────
FROM node:20-alpine AS frontend-builder
WORKDIR /app/frontend

# Install deps first (cached unless package*.json changes)
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci

# Build the SPA → /app/frontend/dist
COPY frontend/ ./
RUN npm run build

# ─────────────────────────── Stage 2: runtime ─────────────────────────────
FROM python:3.12-slim AS runtime

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    LAX_DATABASE_URL=sqlite:////app/data/little_alphaxiv.db \
    LAX_PDF_CACHE=/app/data/pdf_cache

WORKDIR /app/backend

# Python deps (all ship manylinux wheels — no build toolchain needed)
COPY backend/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# Backend source
COPY backend/app ./app
COPY backend/alembic ./alembic
COPY backend/alembic.ini ./

# Built frontend, served same-origin by FastAPI
COPY --from=frontend-builder /app/frontend/dist /app/frontend/dist

# Entrypoint: auto-generates + persists LAX_SECRET_KEY into the data volume on
# first run (so `docker compose up -d` works with zero config), then execs uvicorn.
COPY deploy/entrypoint.sh /entrypoint.sh
# Strip any CRLF in case the file was checked out on Windows without .gitattributes.
RUN sed -i 's/\r$//' /entrypoint.sh && chmod +x /entrypoint.sh

# Persistent runtime data (SQLite db + PDF cache) — mount as a volume.
RUN mkdir -p /app/data

EXPOSE 8000
ENTRYPOINT ["/entrypoint.sh"]
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
