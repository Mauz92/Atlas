#!/usr/bin/env bash
# Atlas verification, run by the supervisor after every agent run.
# TRUSTED CONFIGURATION — protected from the agent (modifying it fails the run).
#
# Scope: static quality gates (currently green). The test suites are NOT wired in
# yet: the backend suite needs a real PostgreSQL and the frontend vitest suite has
# a pre-existing failure. Add them here once green — see docs/TESTING.md.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API="$ROOT/services/api"
WEB="$ROOT/apps/web"

echo "== backend: lint, format, types =="
cd "$API"
.venv/bin/ruff check .
.venv/bin/ruff format --check .
.venv/bin/mypy

echo "== frontend: lint, types =="
cd "$WEB"
npm run lint
npm run typecheck

echo "verification: PASS"
