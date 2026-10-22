# Current Task

- Task ID: M3-01
- Status: IN_REVIEW

## Goal
Add the Task schema and its migration: the fields in `DATA_MODEL.md` §2.3, with a migration test.

## Plan
1. Model the task-side tables from §2.3 (`tasks`, `recurrence_series`, `task_tags`, `task_links`).
2. Add an Alembic migration (`down_revision` = the notes-index revision) and register the models.
3. Add tests: schema/metadata + offline migration rendering (no DB) and DB-backed integrity tests.
4. Verify with ruff, `ruff format --check`, `mypy`, offline Alembic SQL, and `./scripts/verify.sh`.

## Acceptance
- `tasks` (and the §2.3 task-side tables) exist per `DATA_MODEL.md` §2.3.
- The migration renders and is reversible.
- Migration test present and passing where a database is available.
- Static gates clean: ruff, format, mypy, `./scripts/verify.sh`.

## Implementation
- `services/api/atlas/models/task.py` (new): `Task`, `TaskStatus`, `TaskPriority`,
  `RecurrenceSeries`, `TaskLink`, `TaskTag`.
- `services/api/atlas/models/__init__.py`: registers the new models.
- `services/api/alembic/versions/51b31762f974_tasks_schema.py` (new): creates the four tables,
  their foreign keys (users CASCADE; `tasks` self-refs SET NULL; tags/notes CASCADE) and indexes.
- `services/api/tests/conftest.py`: added the new tables to the per-test `TRUNCATE` list.
- `services/api/tests/unit/test_task_schema.py` (new): 8 assertions over the ORM metadata and the
  offline-rendered migration SQL (upgrade + downgrade).
- `services/api/tests/integration/test_tasks_schema.py` (new): migration/model drift, DB defaults,
  optional-field round-trip, foreign-key failures and cascade deletion (needs PostgreSQL).

## Evidence
- `ruff check .` → "All checks passed!"; `ruff format --check .` → "59 files already formatted";
  `mypy` → "Success: no issues found in 35 source files".
- `.venv/bin/alembic upgrade head --sql` → renders `CREATE TABLE tasks` with all 22 columns,
  `pk_tasks`, `fk_tasks_user_id_users`, `fk_tasks_parent_task_id_tasks`,
  `fk_tasks_recurrence_parent_id_tasks` and the five `ix_tasks_*` indexes, plus
  `recurrence_series`, `task_tags`, `task_links`; `downgrade head:base --sql` drops them.
- The 8 `tests/unit/test_task_schema.py` assertions were executed directly with the venv Python
  (the pytest session fixtures require a database) → `ALL PASSED`. Failure path: renaming a
  migration column makes `test_migration_renders_the_task_schema` fail (`AssertionError:
  time_zone`), so the check is real; the change was reverted.
- `./scripts/verify.sh` → `verification: PASS` (exit 0).

## Limitations / blocked
- No PostgreSQL is reachable in this environment (no server, no Docker daemon, no local binaries),
  and the pytest fixtures are DB-only, so **all** backend tests are blocked here. The DB-backed
  `tests/integration/test_tasks_schema.py` (7 tests) is `BLOCKED`, not waived. Run with:
  `TEST_DATABASE_URL=postgresql+psycopg://... .venv/bin/python -m pytest -q`.
- `project_id` / `reminder_policy_id` are bare UUIDs; their FKs arrive with M4-01 (projects) and
  M8 (reminders).

## Next task
- **M3-02 — Task CRUD API + idempotency keys** (depends on M3-01, now `DONE`): create/read/update/
  delete with an `idempotency_key` so a retry returns the original result.
