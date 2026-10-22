#!/usr/bin/env bash
# Atlas verification, run by the supervisor after every agent run.
# TRUSTED CONFIGURATION — protected from the agent (modifying it fails the run).
#
# Requires a reachable PostgreSQL (docker compose -f deploy/docker-compose.yml up -d db),
# pointed at by TEST_DATABASE_URL. A dedicated test database is used, never the app's.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API="$ROOT/services/api"
WEB="$ROOT/apps/web"

echo "== backend: lint, format, types, tests (unit + integration) =="
cd "$API"
.venv/bin/ruff check .
.venv/bin/ruff format --check .
.venv/bin/mypy
export TEST_DATABASE_URL="${TEST_DATABASE_URL:-postgresql+psycopg://atlas:atlas@127.0.0.1:5432/atlas_test}"
.venv/bin/python -m pytest -q

echo "== frontend: lint, types, tests =="
cd "$WEB"
npm run lint
npm run typecheck
npm run test

echo "verification: PASS"
