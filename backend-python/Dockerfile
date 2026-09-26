# DaivikPooja — FastAPI backend image (the repo-root Dockerfile stays the Node one).
#
# The build context is the REPO ROOT (render.yaml: dockerContext: .) because the
# app reads two paths outside backend-python/ at runtime:
#   server/data/catalog.json — catalogue seed loaded on boot
#   public/                  — the vanilla-JS SPA served at "/"
# Local test:  docker build -f backend-python/Dockerfile -t daivikpooja-api .
#              docker run -p 8000:8000 -e JWT_SECRET=... daivikpooja-api
# Render:      wired up automatically by render.yaml.

# ---- stage 1: build wheels (the toolchain never reaches the final image) ----
FROM python:3.12-slim AS build

ENV PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

RUN apt-get update \
 && apt-get install -y --no-install-recommends gcc build-essential \
 && rm -rf /var/lib/apt/lists/*

COPY backend-python/requirements.txt /tmp/requirements.txt
RUN pip wheel --wheel-dir /wheels -r /tmp/requirements.txt

# ---- stage 2: runtime --------------------------------------------------------
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    UPLOAD_DIR=/data/uploads \
    DATABASE_URL=sqlite+aiosqlite:////data/app.db

WORKDIR /app/backend-python

COPY backend-python/requirements.txt /tmp/requirements.txt
COPY --from=build /wheels /wheels
RUN pip install --no-cache-dir --no-index --find-links=/wheels -r /tmp/requirements.txt \
 && rm -rf /wheels

# App code + Alembic migrations
COPY backend-python/alembic.ini ./
COPY backend-python/migrations ./migrations
COPY backend-python/app ./app

# Repo-root assets the app serves/reads from outside backend-python/
COPY server/data/catalog.json ../server/data/catalog.json
COPY public ../public

# Persistent state: uploaded media (always) and the SQLite file when
# DATABASE_URL is not overridden (Render/Supabase override it with Postgres).
RUN mkdir -p /data/uploads && chown -R nobody:nogroup /data
VOLUME /data

# Render injects PORT; plain docker runs default to 8000.
CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port \"${PORT:-8000}\""]

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD python -c 'import httpx, os; r = httpx.get("http://127.0.0.1:" + os.environ.get("PORT", "8000") + "/api/health", timeout=4); r.raise_for_status()'
