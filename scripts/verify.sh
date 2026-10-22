#!/usr/bin/env bash
# Atlas verification, run by the supervisor after every agent run.
# TRUSTED CONFIGURATION — protected from the agent (modifying it fails the run).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API="$ROOT/services/api"
WEB="$ROOT/apps/web"

echo "== backend: lint, format, types, unit tests =="
cd "$API"
.venv/bin/ruff check .
.venv/bin/ruff format --check .
.venv/bin/mypy
.venv/bin/python -m pytest tests/unit -q

# Integration tests: BLOCKED here — they require a real PostgreSQL (docs/TESTING.md).
# Enable once one is reachable by appending the full suite:
#   docker compose -f deploy/docker-compose.yml up -d db
#   cd services/api && TEST_DATABASE_URL=postgresql+psycopg://atlas:atlas@127.0.0.1:5432/atlas \
#     .venv/bin/python -m pytest -q

echo "== frontend: lint, types, tests =="
cd "$WEB"
npm run lint
npm run typecheck
npm run test

echo "verification: PASS"
