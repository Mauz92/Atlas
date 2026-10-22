# Current Task

- Task ID: M3-04
- Status: READY

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

## Evidence
Pending.
