# Current Task

- Task ID: M3-03
- Status: IN_REVIEW

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

## Implementation
- `services/api/atlas/tasks/state.py` (new): the canonical `TRANSITIONS` table plus
  `allowed_transitions`, `can_transition`, `validate_transition` (raises
  `InvalidTaskTransitionError`) and `transition_fields` (completion-timestamp side effects).
- `services/api/atlas/tasks/service.py`: `TasksService` validates status changes on update
  (`validate_transition`) and maintains `completed_at` on create and update.
- `services/api/atlas/tasks/__init__.py`: exports the state-machine helpers/error.
- `services/api/atlas/api/tasks.py`: an invalid transition maps to `409` with
  `{message, current, requested, allowed}`; nothing is changed.
- `docs/DECISIONS.md`: ADR-0013 records the rule.

## Transition rules (canonical in `atlas/tasks/state.py`)
- `inbox` → `next`, `in_progress`, `completed`, `archived`
- `next` → `inbox`, `in_progress`, `completed`, `archived`
- `in_progress` → `inbox`, `next`, `completed`, `archived`
- `completed` → `in_progress`, `archived`
- `archived` → `inbox`, `next`
- any move to the current status is rejected; `completed_at` is non-null exactly when `completed`.

## Evidence
- `cd services/api && .venv/bin/ruff check . && .venv/bin/ruff format --check . && .venv/bin/mypy`
  → "All checks passed!", "70 files already formatted", "Success: no issues found in 41 source files".
- `cd services/api && .venv/bin/python -m pytest tests/unit -q` → `106 passed` (22 new in
  `tests/unit/test_task_state.py`: matrix, all allowed edges, self-transitions, disallowed/
  terminal moves, unknown status, error payload, completion-timestamp rules).
- `./scripts/verify.sh` → `verification: PASS` (exit 0).

## Limitations / blocked
- No PostgreSQL here, so HTTP-level enforcement is unverified: `tests/integration/test_tasks_api.py`
  adds 5 transition tests (`BLOCKED`). Run with:
  `TEST_DATABASE_URL=postgresql+psycopg://... .venv/bin/python -m pytest -q`.
- Design choice: a status write equal to the current status is *rejected* (409), not treated as a
  no-op, per the task brief; clients omit unchanged fields (`PATCH` uses `exclude_unset`).

## Next task
- **M3-04 — Priorities, due dates and time zones** (depends on M3-02): DST-correct due handling.
