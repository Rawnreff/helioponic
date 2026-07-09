# =============================================================================
# Helioponic Backend — Dockerfile (Python FastAPI + MongoDB)
# =============================================================================
# Multi-stage build:
#   Stage: base  → Install system deps & Python packages
#   Stage: dev   → Development with hot-reload (uvicorn --reload)
#   Stage: prod  → Production with gunicorn + uvicorn workers
#
# Development build (default):
#   docker compose up -d --build backend
#
# Production build:
#   docker build --target prod -t helioponic-backend:prod ./helioponic-backend
#
# Or create a docker-compose.prod.yml override that sets build.target: prod.
# See guides/DOCKER_SETUP.md for details.
#
# Current docker-compose.yml has target: dev (hot-reload mode by default).
# =============================================================================

# ============================
# Stage 1: Base dependencies
# ============================
FROM python:3.12-slim AS base

WORKDIR /app

# Install system deps: build tools (gcc for bcrypt), SSL certs, health check
RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc \
    ca-certificates \
    wget \
    && rm -rf /var/lib/apt/lists/*

# Copy dependency file first for Docker layer caching
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# ============================
# Stage 2: Development (default target)
# ============================
FROM base AS dev

# Copy application code
COPY app/ ./app/

# Expose API port
EXPOSE 8000

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:8000/api/v1/health || exit 1

# Run with uvicorn in reload mode (source mounted via docker-compose volume)
ENTRYPOINT ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--reload"]

# ============================
# Stage 3: Production
# ============================
FROM base AS prod

# Copy application code
COPY app/ ./app/

# Expose API port
EXPOSE 8000

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:8000/api/v1/health || exit 1

# Run with gunicorn + uvicorn workers for production
ENTRYPOINT ["gunicorn", "app.main:app", \
            "--worker-class", "uvicorn.workers.UvicornWorker", \
            "--bind", "0.0.0.0:8000", \
            "--workers", "4", \
            "--max-requests", "10000", \
            "--max-requests-jitter", "1000", \
            "--timeout", "120", \
            "--keep-alive", "5", \
            "--log-level", "info"]
