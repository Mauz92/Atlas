#!/usr/bin/env bash
# Atlas verification, run by the supervisor after every agent run.
# TRUSTED CONFIGURATION — protected from the agent (modifying it fails the run).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API="$ROOT/services/api"
WEB="$ROOT/apps/web"

echo "== backend: lint, format, types =="
cd "$API"
.venv/bin/ruff check .
.venv/bin/ruff format --check .
.venv/bin/mypy

# Backend tests: BLOCKED in this environment — they require a real PostgreSQL
# (docs/TESTING.md), and no database is reachable. Enable once one is:
#   docker compose -f deploy/docker-compose.yml up -d db
#   cd services/api && TEST_DATABASE_URL=postgresql+psycopg://atlas:atlas@127.0.0.1:5432/atlas \
#     .venv/bin/python -m pytest -q
# Then replace this comment with those two commands; do not weaken it.

echo "== frontend: lint, types, tests =="
cd "$WEB"
npm run lint
npm run typecheck
npm run test

echo "verification: PASS"
