# Current Task

- Task ID: M3-04
- Status: IN_REVIEW

## Goal
Priorities, due dates and time zones (docs/ROADMAP.md M3-04): task priorities and due
dates handled timezone-correctly, including DST transitions.

## Plan
1. Read docs/DATA_MODEL.md and services/api/atlas/models/task.py.
2. Implement priority + due-date/time-zone handling with an injectable clock and explicit
   timezone conversion (no wall-clock sleeps in tests).
3. Add DB-free unit tests covering DST spring-forward/fall-back, UTC/local conversion and
   boundary dates.
4. Run: `services/api/.venv/bin/python -m pytest tests/unit -q` and `./scripts/verify.sh`.

## Acceptance
- Due dates are computed and compared timezone-correctly across DST changes.
- Unit tests (no database) cover DST and timezone edge cases, including failure paths.
- `./scripts/verify.sh` passes; no existing test weakened or removed.

## Implementation
- `services/api/atlas/tasks/timezones.py` (new): `to_utc`/`to_local`/`local_date`/`due_state`
  over `zoneinfo`; raises `NonexistentWallTimeError` for DST-gap wall times and
  `InvalidTimeZoneError` for unknown zones; overlap resolved by `fold`.
- `services/api/atlas/tasks/priority.py` (new): canonical `PRIORITY_ORDER` and `priority_rank`.
- `services/api/atlas/tasks/service.py`: normalizes naive `start_at`/`due_at` to UTC using the
  task's time zone (create) or its stored/updated zone (update).
- `services/api/atlas/api/schemas.py`: `time_zone` validated as a real IANA zone (`422` if unknown).
- `services/api/atlas/api/tasks.py`: handlers now pass real `datetime` objects to the service
  (previously JSON strings), so instants are stored correctly.
- `services/api/atlas/tasks/__init__.py`: exports the new helpers.
- `docs/DECISIONS.md`: ADR-0014 records the semantics.

## Evidence
- `cd services/api && .venv/bin/ruff check . && .venv/bin/ruff format --check . && .venv/bin/mypy`
  → "All checks passed!", "74 files already formatted", "Success: no issues found in 43 source files".
- `cd services/api && .venv/bin/python -m pytest tests/unit -q` → `125 passed` (19 new:
  `test_task_timezones.py` 13, `test_task_priority.py` 4, `test_tasks_api.py` +2).
- DST facts confirmed against `zoneinfo` (Europe/Amsterdam: gap 2026-03-29 02:30, overlap
  2026-10-25 02:30; winter 09:30→08:30Z, summer 09:30→07:30Z).
- Contract check: `TaskCreateRequest(...).model_dump()["due_at"]` is a `datetime`;
  `to_utc(due_at, "Europe/Amsterdam")` → `2026-01-02 08:30:00+00:00`.
- OpenAPI drift simulation → `PASS`; `./scripts/verify.sh` → `verification: PASS` (exit 0).

## Limitations / blocked
- No PostgreSQL here, so the HTTP-level due-date behaviour is unverified:
  `tests/integration/test_tasks_api.py` adds 4 due-date tests (`BLOCKED`). Run with:
  `TEST_DATABASE_URL=postgresql+psycopg://... .venv/bin/python -m pytest -q`.
- The `due_state` classifier is not yet surfaced as an endpoint/field (views arrive with M3-07).
- `priority_rank` is not yet used by a query; M3-08 filtering will consume it.

## Next task
- **M3-05 — Recurring tasks (RRULE)** or **M3-06 — Subtasks** (both depend on M3-03, `IN_REVIEW`).
