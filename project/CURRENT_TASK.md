# Current Task

- Task ID: M3-02
- Status: READY

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

## Evidence
Pending.
