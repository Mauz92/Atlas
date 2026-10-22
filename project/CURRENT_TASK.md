# Current Task

- Task ID: M3-03
- Status: READY

## Goal
Task state machine and transitions (see docs/ROADMAP.md M3-03): only valid task status
transitions are allowed; invalid ones are rejected.

## Plan
1. Read docs/DATA_MODEL.md and services/api/atlas/models/task.py (TaskStatus) and the M3-02 service.
2. Implement an explicit transition table/validator used by the task service.
3. Add DB-free unit tests covering every valid transition and a representative set of
   invalid ones (including self-transitions and terminal states).
4. Run: `services/api/.venv/bin/python -m pytest tests/unit -q` and `./scripts/verify.sh`.

## Acceptance
- Only valid transitions are accepted; invalid transitions are rejected with a clear error.
- Unit tests (no database) cover valid and invalid transitions, including failure paths.
- `./scripts/verify.sh` passes; no existing test weakened or removed.

## Evidence
Pending.
