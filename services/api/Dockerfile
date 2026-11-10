# Atlas backend image — shared by the `api` and `worker` services.
FROM python:3.13-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1

# Create the data directories owned by the runtime user so that a fresh named volume
# mounted at these paths inherits the correct ownership (Docker copies image directory
# ownership into an empty named volume).
RUN useradd --create-home --uid 10001 atlas \
    && mkdir -p /data/atlas/notes /data/atlas/backups /data/atlas/exports \
    && chown -R atlas:atlas /data/atlas
WORKDIR /app

# The PostgreSQL client tools (pg_dump) run the backup job (M9-01) from this image.
RUN apt-get update \
    && apt-get install -y --no-install-recommends postgresql-client \
    && rm -rf /var/lib/apt/lists/*

COPY pyproject.toml ./
COPY atlas ./atlas
COPY alembic.ini ./
COPY alembic ./alembic

RUN pip install --no-cache-dir . && chown -R atlas:atlas /app
# Set by the release workflow; read by atlas.__version__ and checked by the host updater after an update.
ARG ATLAS_VERSION=""
ENV ATLAS_VERSION=${ATLAS_VERSION}
USER atlas

EXPOSE 8000
CMD ["uvicorn", "atlas.main:app", "--host", "0.0.0.0", "--port", "8000"]
