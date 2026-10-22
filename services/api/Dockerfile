# Atlas backend image — shared by the `api` and `worker` services.
FROM python:3.13-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1

# Create the data directories owned by the runtime user so that a fresh named volume
# mounted at these paths inherits the correct ownership (Docker copies image directory
# ownership into an empty named volume).
RUN useradd --create-home --uid 10001 atlas \
    && mkdir -p /data/atlas/notes /data/atlas/backups \
    && chown -R atlas:atlas /data/atlas
WORKDIR /app

COPY pyproject.toml ./
COPY atlas ./atlas
COPY alembic.ini ./
COPY alembic ./alembic

RUN pip install --no-cache-dir . && chown -R atlas:atlas /app
USER atlas

EXPOSE 8000
CMD ["uvicorn", "atlas.main:app", "--host", "0.0.0.0", "--port", "8000"]
