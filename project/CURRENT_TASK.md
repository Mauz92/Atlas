# Current Task

- Task ID: M3-02
- Status: IN_REVIEW

## Goal
Task CRUD API + idempotency keys (see docs/ROADMAP.md M3-02 and docs/DATA_MODEL.md).
Create/read/update/delete tasks over the API; a repeated create with the same idempotency
key must return the original result rather than creating a duplicate.

## Plan
1. Read docs/DATA_MODEL.md and the M3-01 schema (services/api/atlas/models/task.py).
2. Implement the CRUD endpoints and idempotency handling.
3. Add tests. The DB-backed integration test needs PostgreSQL (currently BLOCKED here), so
   ALSO add DB-free unit tests that exercise the idempotency/validation logic directly.
4. Run: `services/api/.venv/bin/python -m pytest tests/unit -q` and `./scripts/verify.sh`.

## Acceptance
- Task CRUD works; a duplicate idempotency key returns the original result, not a new row.
- Unit tests (no database) cover the idempotency and validation logic.
- `./scripts/verify.sh` passes; no existing test weakened or removed.
- DB-backed integration tests may be recorded BLOCKED if no PostgreSQL is reachable.

## Implementation
- `services/api/atlas/tasks/service.py` (+ `atlas/tasks/__init__.py`): `TasksService` CRUD —
  soft delete (tombstone), revision bump on every change, optional `base_revision` → `409`,
  parent-task validation.
- `services/api/atlas/idempotency.py`: `fingerprint`, `is_replay`, and `IdempotencyStore`
  (reserve key with `INSERT … ON CONFLICT DO NOTHING`, replay stored response, remember it).
- `services/api/atlas/models/idempotency.py` + migration `f403c1b05be3`: `idempotency_keys`
  table (per-user key, operation, request hash, stored response), unique `(user_id, key)`.
- `services/api/atlas/api/tasks.py`: `POST`/`GET`/`GET {id}`/`PATCH`/`DELETE` `/api/tasks`,
  optional `Idempotency-Key` header on mutations; registered in `api/__init__.py` + `main.py`.
- `services/api/atlas/api/schemas.py`: `TaskCreateRequest`, `TaskUpdateRequest`, `TaskOut`,
  `TaskListOut`.
- `apps/web/src/api/schema.d.ts`: regenerated from the OpenAPI contract.
- Fixed an opt-in-fixture regression: `tests/integration/test_jobs.py` and
  `tests/integration/test_tasks_schema.py` now request `_db` (schema + per-test truncation).

## Evidence
- `cd services/api && .venv/bin/ruff check . && .venv/bin/ruff format --check . && .venv/bin/mypy`
  → "All checks passed!", "68 files already formatted", "Success: no issues found in 40 source files".
- `cd services/api && .venv/bin/python -m pytest tests/unit -q` → `84 passed` (13 new: idempotency,
  task API contract/validation, idempotency-table migration render).
- OpenAPI + TS types: regenerated `openapi.json` (build artifact) and `schema.d.ts`; CI drift
  simulation (`cp …; npm run gen:api; diff`) → **PASS**; `npm run typecheck` and `npm run build` clean.
- `./scripts/verify.sh` → `verification: PASS` (exit 0).

## Limitations / blocked
- No PostgreSQL in this environment, so all DB-backed tests are `BLOCKED`, including the new
  `tests/integration/test_tasks_api.py` (9 tests: CRUD, idempotent create replay, key reuse → 409,
  stale revision → 409, soft delete + idempotent delete replay, CSRF/401, validation). Run with:
  `TEST_DATABASE_URL=postgresql+psycopg://... .venv/bin/python -m pytest -q`.
- The live idempotency replay path (concurrent reservation via `ON CONFLICT DO NOTHING`) is
  unverified here; only the pure helpers are exercised without a database.

## Next task
- **M3-03 — Task state machine + transitions** (depends on M3-02): allow only valid status
  transitions and set `completed_at` when a task reaches `completed`.
