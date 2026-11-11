# Atlas — Acceptance Record

**Status:** Active (Milestone 9)
**Last updated:** 2026-11-03

Records verification evidence for milestone gates. A milestone is not complete until its criteria
are marked `PASS` here with evidence, or explicitly recorded as `BLOCKED`/`NOT RUN`.

Evidence vocabulary: `PASS`, `FAIL`, `BLOCKED`, `NOT RUN`.

**Environment note (2026-10-27).** The reproducible test environment in this repository is
**PostgreSQL 17.11** (`deploy/docker-compose.yml` → `postgres:17-alpine`), Python 3.14, Node 26 and
Chromium (Playwright). Some earlier entries record the environment as observed when they were written
(an earlier host reported PostgreSQL 18.6); the suites run against the container above. The exact
commands and results in each entry are the evidence, not the version string.

---

## M0 — Discovery and Architecture

| Criterion | Result | Evidence |
|---|---|---|
| Core architecture documented | `PASS` | `ARCHITECTURE.md` drafted (components, ownership, flows) |
| Every important requirement has an implementation strategy | `PASS` | `PRODUCT_SPEC.md` §3, §5 |
| Unresolved technical risks visible | `PASS` | `RISKS.md` (R-01…R-19) |
| Dependency licences checked | `PASS` | Inventory in `docs/DEPENDENCIES.md` (M0-08) |
| No production features built prematurely | `PASS` | No application code exists; docs only |
| Repository skeleton + CI | `PASS` | Layout, per-area READMEs and `.github/workflows/ci.yml` authored (M0-07) |

**Gate:** architecture + backlog approved by product owner — **APPROVED 2026-10-20**.

---

## M1 — Foundation and Secure Deployment

Verified 2026-10-20 on Linux with Python 3.14, Node 26, PostgreSQL 18.6 and Docker 29.9.

| Criterion | Result | Evidence |
|---|---|---|
| Clean install starts from documented steps | `PASS` | `docker compose -p atlas -f deploy/docker-compose.yml up --build -d` → `db` healthy, `api` healthy, `worker` up, `web` up; web UI on :8081 returns HTTP 200 |
| Persistent data survives restart | `PASS` | `docker compose down` (volumes kept) then `up` → pre-restart account still logs in; `setup_required:false` |
| Unauthenticated users cannot access protected data | `PASS` | `pytest`: `test_me_requires_authentication` → 401; `test_csrf_required_for_authenticated_writes` → 403. Also verified live: `GET /api/auth/me` → 401 without a session |
| Migrations run reproducibly on a clean DB | `PASS` | `alembic upgrade head` on fresh PostgreSQL 18.6; `alembic check` → "No new upgrade operations detected"; container `api` runs `atlas-migrate` on start and creates the schema |
| No real secrets required in source control | `PASS` | `.env.example` placeholders only; `Settings.validate_for_runtime()` rejects placeholders when `ATLAS_ENV=production` |

**Test evidence (commands actually run):**

- `cd services/api && .venv/bin/python -m pytest -q` → `36 passed` (against a real PostgreSQL).
- `cd services/api && .venv/bin/ruff check . && ruff format --check .` → clean.
- `cd services/api && .venv/bin/mypy` → `Success: no issues found in 26 source files`.
- `cd apps/web && npm run lint && npm run typecheck && npm run test && npm run build` → clean;
  `vitest` 1 passed; Vite build produced `dist/`.
- Containerised end-to-end: signup via the web container (`POST /api/auth/setup` through nginx →
  api → db) → 201; `GET /api/auth/me` → 200 with session, → 401 without; `POST /api/auth/logout`
  → 204.
- Containerised worker: `noop` job enqueued inside the `api` container reached `status=succeeded`
  (attempts=1) by the `worker` container.

**Unverified:** a live GitHub Actions run — there is no remote to push to. Mitigation: the whole
workflow was executed locally with `nektos/act` (Docker) and every job passed:

- `hygiene` → docs present, no `.env` tracked, `docker compose config -q` OK.
- `backend` → ruff, `ruff format --check`, mypy, `pytest` (50 passed), `pip-audit`, OpenAPI export,
  artifact upload.
- `frontend` → artifact download, `npm ci`, API-type drift check, eslint, tsc, vitest,
  `npm audit` (0 vulnerabilities), production build.
- `containers` → all three images built via `docker compose build`.

The gate was also shown to be real: a deliberately failing test made the `backend` job exit
non-zero (`❌ Failure - Main Tests`), and the failure was reverted.

**Security baseline review (M1-11):** performed and recorded in `docs/SECURITY.md` §11. All
M1-applicable threat-model controls verified; four issues found and fixed (log redaction, login
timing enumeration, dependency advisories, production API docs), with residual risks R-SEC-1…4
recorded.

---

## M2 — Markdown Notes

Verified 2026-10-20 on Linux with Python 3.14, Node 26, PostgreSQL 18.6 and Docker 29.9.

| Criterion | Result | Evidence |
|---|---|---|
| Notes are actual `.md` files | `PASS` | `test_create_note_writes_a_real_markdown_file`; verified inside the container volume (`cat /data/atlas/notes/Inbox/Hello.md`) |
| Files readable in an ordinary editor | `PASS` | Content is written verbatim as UTF-8; no proprietary wrapper or metadata is added to the file |
| Unicode / special characters preserved | `PASS` | `test_unicode_and_special_characters_survive`, `test_unicode_content_round_trips_through_the_api` |
| Path traversal prevented | `PASS` | `tests/unit/test_note_paths.py` (traversal, absolute, reserved dir, symlink escape) and `test_path_traversal_is_rejected` → `400` |
| Concurrent edits do not silently overwrite | `PASS` | Stale revision → `409`; external file change detected by hash → `409`; `test_conflict_copy_preserves_both_versions` keeps both files |
| Create / edit / retrieve work via API | `PASS` | `tests/integration/test_notes_api.py` (16 tests) |

**Also verified for this milestone.** Renaming a note or folder preserves note identity and keeps
wiki links/backlinks intact; full-text search returns ranked matches; tags and unresolved links are
reported; reconciliation picks up externally added/changed/deleted files
(`tests/integration/test_notes_reconcile.py`, and `POST /api/notes/reconcile` → `{"added":1,...}` in
the running stack).

**Test evidence (commands actually run):**

- `cd services/api && pytest -q` → `105 passed` (unit + integration against real PostgreSQL).
- `cd apps/web && npm run lint && npm run typecheck && npm run test && npm run build` → clean;
  `vitest` 7 passed.
- Full CI workflow via `act`: `hygiene`, `backend` (105 passed), `frontend` (7 passed),
  `containers` — all four jobs succeeded.

**Not run (recorded, not waived):** Playwright end-to-end tests. The frontend is covered by
component tests and the API by integration tests, but no browser-driven journey is executed yet.

---

## Defect Fixes

### SUP-001 — Frontend test suite (`React.act is not a function`)

Verified 2026-10-22 on Linux with Node 26, React/React-DOM 19.3.1, `@testing-library/react` 16.3.3.

| Criterion | Result | Evidence |
|---|---|---|
| `cd apps/web && npm run test` exits 0, all tests pass | `PASS` | `Test Files 4 passed (4)`, `Tests 8 passed (8)` |
| No tests removed, skipped or weakened | `PASS` | Diff adds one guard test only; existing assertions unchanged; no `it.skip`/`test.skip` |
| Failing tests now pass for a real reason | `PASS` | Root cause fixed (inherited `NODE_ENV=production` → React production build with no `act`); guard fails when the fix is removed |

**Root cause.** The runner shell exported `NODE_ENV=production`. Vitest only defaults `NODE_ENV`
to `test` when unset, so React 19 resolved its production build, which does not export `act`
(`react.development.js` does). `@testing-library/react` fell back to the deprecated
`react-dom/test-utils` shim and threw `TypeError: React.act is not a function` on every render.

**Fix.** `apps/web/vite.config.ts` pins `test.env = { NODE_ENV: "test" }` (test-scoped, does not
affect `npm run build`); `apps/web/src/test/environment.test.tsx` is a regression guard.

**Commands run.**

- `cd apps/web && npm run test` → before: 7 failed; after: 8 passed.
- `cd apps/web && env -u NODE_ENV npm run test` (CI-like) → 8 passed.
- Failure path: with the `env` line removed the new guard fails; restored it passes.
- `cd apps/web && npm run lint && npm run typecheck && npm run build` → clean.

**Not changed:** `scripts/verify.sh` (trusted/protected). It still runs only lint/typecheck for
the frontend; wiring `npm run test` in is a follow-up for the maintainer.

---

## Full-suite verification (2026-10-22)

Ran the complete backend suite against PostgreSQL 17.11 in Docker, on a dedicated `atlas_test`
database (never the application's): **194 passed** (125 unit + 69 integration); migrations
executed cleanly (downgrade base -> upgrade head). Two defects were found and fixed:

- `tests/unit/test_tasks_api.py` and `tests/integration/test_tasks_api.py` shared a basename and
  aborted pytest collection ("import file mismatch"); fixed with package `__init__.py` files.
- `tests/integration/test_notes_reconcile.py` was missing the `_db` fixture marker, leaking rows
  into later tests (`409 "Application already initialised"`); marker added.

`scripts/verify.sh` now runs the full suite (backend lint/format/types + 194 tests; frontend
lint/types + 8 tests).

---

## M3 — Core Task Management

### M3-01 — Task schema + migration

Verified 2026-10-22 on Linux with Python 3.14, SQLAlchemy 2.x, Alembic 1.x. PostgreSQL 17.11 was available on 2026-10-22, so the DB-backed checks below were executed and passed.

| Criterion | Result | Evidence |
|---|---|---|
| `tasks` has the fields in `DATA_MODEL.md` §2.3 | `PASS` | `tests/unit/test_task_schema.py::test_tasks_table_has_the_documented_columns` (22 columns) |
| Required columns are `NOT NULL`; status/priority/revision have defaults | `PASS` | `test_required_task_columns_are_not_nullable`, `test_task_status_and_priority_defaults` |
| Foreign keys and indexes match the model | `PASS` | `test_task_foreign_keys_and_indexes` (`users` CASCADE; self-refs SET NULL; 5 indexes) |
| Migration renders the schema and is reversible | `PASS` | `test_migration_renders_the_task_schema`, `test_migration_is_reversible` (offline SQL) |
| Migration matches the models on a real DB | `PASS` | `tests/integration/test_tasks_schema.py::test_migrations_match_models` against PostgreSQL 17.11 |
| DB defaults / FK / cascade enforced on a real DB | `PASS` | `tests/integration/test_tasks_schema.py` (6 tests) against PostgreSQL 17.11 |
| Lint, format and types clean | `PASS` | `services/api`: `ruff check .`, `ruff format --check .`, `mypy` → clean (35 files) |

**Commands run.**

- `cd services/api && .venv/bin/ruff check . && .venv/bin/ruff format --check . && .venv/bin/mypy` → clean.
- `cd services/api && .venv/bin/alembic upgrade head --sql` → renders `CREATE TABLE tasks …`
  with all columns, `pk_tasks`, `fk_tasks_user_id_users`, `fk_tasks_parent_task_id_tasks` and the
  `ix_tasks_*` indexes, plus `recurrence_series`, `task_tags`, `task_links`.
- The eight `tests/unit/test_task_schema.py` assertions were executed directly (bypassing the
  DB-only pytest fixtures) → all passed; the migration-render test was shown to fail when a column
  is renamed, so it is not a no-op.
- `./scripts/verify.sh` → `verification: PASS` (exit 0).

**Commands run against PostgreSQL 17.11 (2026-10-22).**

```
docker compose -f deploy/docker-compose.yml up -d db
cd services/api && TEST_DATABASE_URL=postgresql+psycopg://atlas:atlas@127.0.0.1:5432/atlas_test \
  .venv/bin/python -m pytest -q   # 194 passed
```

**Scope note.** `project_id` and `reminder_policy_id` are stored as bare UUIDs; their foreign keys
are added with the `projects` (M4-01) and reminder-policy (M8) tables. `recurrence_series`,
`task_tags` and `task_links` (all in §2.3) are created here; their behaviour arrives with M3-05,
M3-08 and the note-link work respectively.

### M3-02 — Task CRUD API + idempotency keys

Verified 2026-10-22 on Linux with Python 3.14, FastAPI/SQLAlchemy 2.x, Alembic 1.x. No PostgreSQL
was reachable, so the DB-backed checks are `BLOCKED` (see below).

| Criterion | Result | Evidence |
|---|---|---|
| Task CRUD endpoints exist (`POST`/`GET`/`GET {id}`/`PATCH`/`DELETE`) | `PASS` | `tests/unit/test_tasks_api.py::test_task_routes_are_registered` (OpenAPI) |
| Mutations accept an `Idempotency-Key` header | `PASS` | `test_mutations_accept_an_idempotency_key_header` |
| Request validation (empty title, unknown priority, negative revision) | `PASS` | `test_create_requires_a_non_empty_title`, `test_create_rejects_an_unknown_priority`, `test_update_rejects_a_negative_base_revision`, `test_create_defaults_status_and_priority` |
| Idempotency fingerprint/decision logic | `PASS` | `tests/unit/test_idempotency.py` (7 tests, incl. payload mismatch → conflict) |
| Migration adds `idempotency_keys` | `PASS` | `test_migration_adds_the_idempotency_table` (offline SQL, upgrade + downgrade) |
| Duplicate key returns the original result (live) | `PASS` | `tests/integration/test_tasks_api.py::test_create_is_idempotent_for_the_same_key` — PostgreSQL 18, 2026-10-26 |
| CRUD, soft delete, stale-revision `409`, CSRF | `PASS` | `tests/integration/test_tasks_api.py` — PostgreSQL 18, 2026-10-26 |
| OpenAPI contract and TS types in sync | `PASS` | `openapi.json` regenerated; `npm run gen:api`; CI drift diff → in sync |
| Lint, format, types, unit suite | `PASS` | `ruff check .`, `ruff format --check .`, `mypy` clean; `pytest tests/unit -q` → `84 passed` |

**Commands run.**

- `cd services/api && .venv/bin/ruff check . && .venv/bin/ruff format --check . && .venv/bin/mypy` → clean (40 files).
- `cd services/api && .venv/bin/python -m pytest tests/unit -q` → `84 passed` (no database).
- `cd services/api && .venv/bin/python -c "import json; from atlas.main import app; open('openapi.json','w').write(json.dumps(app.openapi()))"` then `cd apps/web && npm run gen:api` → `schema.d.ts` regenerated; `npm run typecheck` and `npm run build` clean.
- CI drift simulation (`cp schema.d.ts /tmp; npm run gen:api; diff`) → **PASS** (types in sync).
- `./scripts/verify.sh` → `verification: PASS` (exit 0; backend lint/format/mypy/`pytest tests/unit`, frontend lint/typecheck/tests).

**Commands run against PostgreSQL 17.11 (2026-10-22).**

```
docker compose -f deploy/docker-compose.yml up -d db
cd services/api && TEST_DATABASE_URL=postgresql+psycopg://atlas:atlas@127.0.0.1:5432/atlas_test \
  .venv/bin/python -m pytest -q   # 194 passed
```

**Regression fixed.** Commit `70ed410` made the DB fixtures opt-in but left `test_jobs.py` and
`test_tasks_schema.py` requesting them; both now declare `pytestmark = pytest.mark.usefixtures("_db")`
so they still get schema setup and per-test truncation.

**Scope note.** Idempotency is generic (`idempotency_keys`, keyed per user, storing the response),
so later mutations can reuse it. `status`/`priority` are validated as enums here; the transition
rules and `completed_at` semantics are M3-03.

### M3-03 — Task state machine + transitions

Verified 2026-10-22 on Linux with Python 3.14. The rules are pure and covered without a database;
the DB-backed HTTP checks are `BLOCKED` (no PostgreSQL).

| Criterion | Result | Evidence |
|---|---|---|
| Every status has a defined transition set | `PASS` | `tests/unit/test_task_state.py::test_every_status_has_an_entry`, `test_transition_matrix_matches_the_documented_rules` |
| Every allowed transition is accepted | `PASS` | `test_every_allowed_transition_is_accepted` (parametrized over all 17 edges) |
| Self-transitions are rejected | `PASS` | `test_a_status_is_never_its_own_successor` (all 5 statuses) |
| Disallowed / terminal transitions are rejected | `PASS` | `test_disallowed_transitions_are_rejected` (`completed→inbox`, `completed→next`, `archived→in_progress`, `archived→completed`) |
| Unknown status has no transitions | `PASS` | `test_unknown_status_has_no_transitions` |
| Error carries current/requested/allowed | `PASS` | `test_error_reports_the_allowed_targets`, `test_disallowed_transitions_are_rejected` |
| `completed_at` set exactly when completed | `PASS` | `test_entering_completed_records_the_time`, `test_leaving_completed_clears_the_time`, `test_other_transitions_have_no_side_effects`, `test_creating_a_completed_task_records_the_time` |
| Enforcement over HTTP (`409`, nothing changes) | `PASS` | `tests/integration/test_tasks_api.py` (5 transition tests) — PostgreSQL 18, 2026-10-26 |
| Lint, format, types, unit suite | `PASS` | `ruff check .`, `ruff format --check .`, `mypy` clean; `pytest tests/unit -q` → `106 passed` |

**Commands run.**

- `cd services/api && .venv/bin/ruff check . && .venv/bin/ruff format --check . && .venv/bin/mypy` → clean (41 files).
- `cd services/api && .venv/bin/python -m pytest tests/unit -q` → `106 passed` (22 new state-machine tests).
- `./scripts/verify.sh` → `verification: PASS` (exit 0).

**Commands run against PostgreSQL 17.11 (2026-10-22).**

```
docker compose -f deploy/docker-compose.yml up -d db
cd services/api && TEST_DATABASE_URL=postgresql+psycopg://atlas:atlas@127.0.0.1:5432/atlas_test \
  .venv/bin/python -m pytest -q   # 194 passed
```

**Scope note.** The transition table is the canonical source (`atlas/tasks/state.py`, ADR-0013);
board columns (M4) must reuse it. A status write equal to the current status is rejected by design
(clients omit unchanged fields; our `PATCH` uses `exclude_unset`).

### M3-04 — Priorities, due dates, time zones

Verified 2026-10-22 on Linux with Python 3.14 (`zoneinfo`, 598 zones available). The rules are pure
and covered without a database; the DB-backed checks are `BLOCKED` (no PostgreSQL).

| Criterion | Result | Evidence |
|---|---|---|
| Wall-clock → UTC uses the correct standard/daylight offset | `PASS` | `tests/unit/test_task_timezones.py::test_winter_wall_time_converts_with_the_standard_offset`, `test_summer_wall_time_converts_with_the_daylight_offset` |
| Aware input → UTC; naive (no zone) → UTC | `PASS` | `test_aware_input_is_converted_to_utc`, `test_naive_input_without_a_zone_is_utc` |
| DST spring-forward gap rejected | `PASS` | `test_dst_spring_forward_gap_is_rejected` (`NonexistentWallTimeError`) |
| DST fall-back overlap resolved deterministically | `PASS` | `test_dst_fall_back_overlap_resolves_deterministically` (fold 0/1), `test_ordinary_times_are_not_ambiguous` |
| Round-trip across a DST change | `PASS` | `test_round_trip_across_a_dst_change` (47 h over two calendar days) |
| Invalid IANA zone rejected | `PASS` | `test_invalid_time_zone_is_rejected`, `test_an_unknown_time_zone_is_rejected` (schema → `422`) |
| Calendar-day ("today") is zone-correct | `PASS` | `test_local_date_uses_the_zone_calendar_day`, `test_due_state_today_depends_on_the_zone_calendar_day` |
| `due_state` none/overdue/today/upcoming | `PASS` | `test_due_state_without_a_due_date`, `test_due_state_overdue_today_and_upcoming` |
| Priority ordering | `PASS` | `tests/unit/test_task_priority.py` (4 tests) |
| Naive due date stored in the task's zone over HTTP | `PASS` | `tests/integration/test_tasks_api.py` (4 due-date tests) — PostgreSQL 18, 2026-10-26 |
| Lint, format, types, unit suite | `PASS` | `ruff check .`, `ruff format --check .`, `mypy` clean; `pytest tests/unit -q` → `125 passed` |

**Commands run.**

- `cd services/api && .venv/bin/ruff check . && .venv/bin/ruff format --check . && .venv/bin/mypy` → clean (43 files).
- `cd services/api && .venv/bin/python -m pytest tests/unit -q` → `125 passed` (19 new).
- Contract check: `TaskCreateRequest(...).model_dump()` keeps `due_at` as a `datetime` and `status`
  as `TaskStatus`; `to_utc(due_at, "Europe/Amsterdam")` → `2026-01-02 08:30:00+00:00`.
- OpenAPI drift simulation → **PASS** (no contract change); `npm run typecheck`/`build` unaffected.
- `./scripts/verify.sh` → `verification: PASS` (exit 0).

**Commands run against PostgreSQL 17.11 (2026-10-22).**

```
docker compose -f deploy/docker-compose.yml up -d db
cd services/api && TEST_DATABASE_URL=postgresql+psycopg://atlas:atlas@127.0.0.1:5432/atlas_test \
  .venv/bin/python -m pytest -q   # 194 passed
```

**Scope note.** Deterministic zone rules live in `atlas/tasks/timezones.py`; the API stores UTC
instants and validates `time_zone` at the boundary (ADR-0014). Handling also fixed the M3-02
handlers to pass real `datetime` objects to the service (they previously passed JSON strings).

---

## M3 — DB-backed verification (2026-10-26)

Re-ran the previously-`BLOCKED` M3-02/03/04 integration checks against PostgreSQL 18 in Docker,
on the dedicated `atlas_test` database (never the application's).

**Commands run.**

```
docker compose -f deploy/docker-compose.yml up -d db
cd services/api && TEST_DATABASE_URL=postgresql+psycopg://atlas:atlas@127.0.0.1:5432/atlas_test \
  .venv/bin/python -m pytest -q                          # 194 passed
cd services/api && TEST_DATABASE_URL=postgresql+psycopg://atlas:atlas@127.0.0.1:5432/atlas_test \
  .venv/bin/python -m pytest tests/integration/test_tasks_api.py tests/integration/test_tasks_schema.py -q   # 26 passed
```

Result: the M3-02 (idempotent create, CRUD, soft delete, stale-revision `409`, CSRF), M3-03
(HTTP status-transition enforcement) and M3-04 (naive due date stored as UTC via the task's zone
over HTTP) criteria are now `PASS`; M3-02/03/04 are `DONE`.

---

## M3-05 — Recurring tasks (RRULE)

Verified 2026-10-26 on Linux with Python 3.14 against PostgreSQL 18 in Docker (dedicated
`atlas_test` database, never the application's). The recurrence engine is pure and covered without
a database; the completion semantics and idempotency are also covered over HTTP.

The series head is the task that first carries the RRULE and is itself the first occurrence; every
occurrence points back at the head via `recurrence_parent_id`. Completing an occurrence advances
the series by exactly one step and nothing else (ADR-0015).

| Criterion | Result | Evidence |
|---|---|---|
| Creating a recurring task creates the series row | `PASS` | `tests/integration/test_tasks_recurrence.py::test_creating_a_recurring_task_creates_the_series` |
| Completing an occurrence completes only it, creates the next, keeps the series + head | `PASS` | `test_completing_an_occurrence_creates_the_next_and_keeps_the_series` |
| Other occurrences (incl. the head) are never completed/deleted/rewound | `PASS` | `test_completing_an_occurrence_leaves_earlier_occurrences_untouched`, `test_reopening_an_occurrence_keeps_the_generated_next`, `test_the_series_is_not_mutated_by_reading_it` |
| Completing the final occurrence stops the series (no successor) | `PASS` | `test_completing_the_final_occurrence_stops_the_series`, `test_completing_the_final_occurrence_stops_the_series` (unit) |
| `COUNT` bound terminates the series | `PASS` | `test_count_is_mirrored_from_the_rule`, `test_count_and_end_date_whichever_comes_first_wins`, integration COUNT tests |
| `UNTIL` / `end_date` bound terminates the series | `PASS` | `test_until_terminates_the_series`, `test_end_date_terminates_the_series`, `test_until_bounds_terminate_the_series` |
| Occurrence times are DST-correct (spring-forward) | `PASS` | `test_dst_spring_forward_keeps_the_local_wall_clock`, `test_a_weekly_cadence_spans_dst_without_drifting`, `test_the_next_occurrence_is_timezone_and_dst_correct` |
| Occurrence times are DST-correct (fall-back) | `PASS` | `test_dst_fall_back_keeps_the_local_wall_clock` |
| Naive vs aware `dtstart`; naive interpreted in the series zone | `PASS` | `test_a_naive_dtstart_is_interpreted_in_the_series_zone`, `test_an_aware_dtstart_is_converted_into_the_series_zone`, `test_a_naive_dtstart_without_a_zone_is_utc` |
| A naive `dtstart` in the DST gap is rejected | `PASS` | `test_a_naive_dtstart_in_the_dst_gap_is_rejected` |
| RRULE expansion (daily; weekly `BYDAY`) | `PASS` | `test_daily_count_expands_to_the_expected_instants`, `test_weekly_byday_expands_on_the_selected_weekdays` |
| Invalid/unknown RRULE rejected at the API boundary (`422`) | `PASS` | `test_invalid_rules_are_rejected` (parametrized, unit), `test_an_invalid_recurrence_rule_is_rejected` (HTTP) |
| A recurring task requires an anchor (`400`) | `PASS` | `test_a_recurring_task_requires_an_anchor` |
| Retried completion with the same idempotency key does not duplicate | `PASS` | `test_retrying_a_completion_with_the_same_key_does_not_duplicate` |
| A recurrence can be added/removed via update | `PASS` | `test_a_recurrence_rule_can_be_added_on_update_and_then_advances`, `test_removing_the_rule_deletes_the_series` |
| Lint, format, types, unit suite | `PASS` | `ruff check .`, `ruff format --check .`, `mypy` clean; `pytest tests/unit -q` → `158 passed` (33 new) |
| Full suite (unit + integration) | `PASS` | `pytest -q` against PostgreSQL 18 → `240 passed` |
| OpenAPI / TS types in sync | `PASS` | fresh `app.openapi()` diffed against `services/api/openapi.json` → no drift; `apps/web/src/api/schema.d.ts` unchanged |

**Commands run.**

```
cd services/api && .venv/bin/ruff check . && .venv/bin/ruff format --check . && .venv/bin/mypy
    # clean (44 source files)
cd services/api && .venv/bin/python -m pytest tests/unit -q
    # 158 passed
cd services/api && TEST_DATABASE_URL=postgresql+psycopg://atlas:atlas@127.0.0.1:5432/atlas_test \
  .venv/bin/python -m pytest tests/integration/test_tasks_recurrence.py -q
    # 13 passed
cd services/api && TEST_DATABASE_URL=postgresql+psycopg://atlas:atlas@127.0.0.1:5432/atlas_test \
  .venv/bin/python -m pytest -q
    # 240 passed
cd /home/kim/Documents/Atlas && ./scripts/verify.sh
    # verification: PASS (exit 0)
```

**Scope note.** RRULE semantics come from `python-dateutil` (`dateutil.rrule`); no custom
recurrence engine (AGENTS.md §7.5). New occurrences inherit the completed occurrence's
title/description/priority/project/zone and start as `inbox`. Manual edits to an occurrence's due
date are not re-synchronised with the sequence (recorded as a limitation in `CURRENT_TASK.md`).

---

## M3-06 — Subtasks

Verified 2026-10-26 on Linux with Python 3.14 against PostgreSQL 18 in Docker (dedicated
`atlas_test` database, never the application's). The parent/child rules are pure and covered
without a database; their enforcement, the rollup and the recurrence interaction are also covered
over HTTP. Rules: ADR-0016; `parent_task_id → tasks.id` `ON DELETE SET NULL` (M3-01).

| Criterion | Result | Evidence |
|---|---|---|
| A subtask is created and listed on its parent | `PASS` | `tests/integration/test_tasks_subtasks.py::test_a_subtask_is_created_and_listed_on_its_parent` |
| Listing subtasks of an unknown parent → `404` | `PASS` | `test_listing_subtasks_of_a_missing_parent_is_not_found` |
| A task cannot be its own parent (nothing changes) | `PASS` | `test_a_task_cannot_be_its_own_parent` |
| A direct cycle is rejected (nothing changes) | `PASS` | `test_a_direct_cycle_is_rejected_without_changing_state` |
| A cycle at depth > 1 is rejected | `PASS` | `test_a_cycle_at_depth_greater_than_one_is_rejected` |
| Cross-user parenting is rejected | `PASS` | `test_a_task_cannot_be_parented_under_another_users_task` |
| A missing / soft-deleted parent is rejected | `PASS` | `test_a_soft_deleted_parent_is_rejected`, `test_parent_task_must_exist` (M3-02) |
| A subtask inherits the parent's project | `PASS` | `test_a_subtask_inherits_the_parents_project` |
| A conflicting project is rejected | `PASS` | `test_a_subtask_with_a_conflicting_project_is_rejected` |
| Rollup formula: `subtasks_done`/`subtasks_total`, never completing the parent | `PASS` | `test_the_rollup_tracks_the_subtasks_without_completing_the_parent`; unit rollup tests |
| Soft-deleting a parent promotes its subtasks (no orphans) | `PASS` | `test_soft_deleting_a_parent_promotes_its_subtasks` |
| A recurring occurrence does not clone the parent's subtasks | `PASS` | `test_completing_a_recurring_task_does_not_clone_its_subtasks`; unit `test_a_generated_occurrence_is_top_level_and_copies_no_subtask` |
| Pure rules: self, cycle (depth > 1), cross-user, missing, inheritance, rollup | `PASS` | `tests/unit/test_task_subtasks.py` (20 tests) |
| API contract: `parent_task_id` query param + rollup fields | `PASS` | unit OpenAPI tests; `schema.d.ts` regenerated (CI drift check passes) |
| No existing test removed, skipped or weakened | `PASS` | the prior 240 tests still pass; total **272 passed** |
| Lint, format, types, unit suite | `PASS` | `ruff check .`, `ruff format --check .`, `mypy` clean; `pytest tests/unit -q` → **178 passed** (20 new) |
| Full suite (unit + integration) | `PASS` | `pytest -q` against PostgreSQL 18 → **272 passed** (12 new subtask integration tests) |
| `./scripts/verify.sh` | `PASS` | `verification: PASS` (exit 0) |

**Commands run.**

```
cd services/api && .venv/bin/ruff check . && .venv/bin/ruff format --check . && .venv/bin/mypy
    # clean (45 source files)
cd services/api && .venv/bin/python -m pytest tests/unit -q
    # 178 passed
cd services/api && TEST_DATABASE_URL=postgresql+psycopg://atlas:atlas@127.0.0.1:5432/atlas_test \
  .venv/bin/python -m pytest tests/integration/test_tasks_subtasks.py -q
    # 12 passed
cd services/api && TEST_DATABASE_URL=postgresql+psycopg://atlas:atlas@127.0.0.1:5432/atlas_test \
  .venv/bin/python -m pytest -q
    # 272 passed
cd services/api && .venv/bin/python -c "import json; from atlas.main import app; \
  open('openapi.json','w').write(json.dumps(app.openapi()))"   # then:
cd apps/web && npm run gen:api     # schema.d.ts regenerated; CI drift simulation → in sync
cd /home/kim/Documents/Atlas && ./scripts/verify.sh
    # verification: PASS (exit 0)
```

**Scope note.** Only subtask listing is added — the generic task filters/search (M3-08), views
(M3-07) and the change log (M3-09) are untouched. Cross-user parenting and a missing parent return
the same `400` message so task ids cannot be probed across users. The database cannot express
acyclicity for a self-referential FK; the service is the only writer.

---

## M3-07 — Inbox / Today / Upcoming views

Verified 2026-10-26 on Linux with Python 3.14, Node 26 and PostgreSQL 18 in Docker (dedicated
`atlas_test` database, never the application's). Views are server-authoritative: the client asks
for a view and renders the API response (ADR-0012, ADR-0017).

| Criterion | Result | Evidence |
|---|---|---|
| **Today** is the landing page; **Inbox** and **Upcoming** are reachable from primary navigation | `PASS` | `apps/web/src/App.tsx` routes `/`, `/inbox`, `/upcoming` to `Today`/`Inbox`/`Upcoming`; `Layout.tsx` `NAV_ITEMS` links them (`/` uses `end` matching) |
| Each view renders from the API (server-authoritative) | `PASS` | `hooks/useTaskView.ts` calls `tasksApi.list({view, tz})`; grouping uses the server's `due_state` — `pages/Today.test.tsx`, `pages/Inbox.test.tsx`, `pages/Upcoming.test.tsx` |
| Quick capture works with a title only | `PASS` | `components/QuickCapture.tsx` (single title field); `components/QuickCapture.test.tsx` (empty submit ignored, trimmed title sent); Today/Inbox view tests assert `tasksApi.create(title)` |
| Today shows Overdue and Due-today grouped sensibly | `PASS` | `lib/tasks.ts::groupToday` + `pages/Today.tsx`; `lib/tasks.test.ts`; server classification unit/integration tests |
| Upcoming groups by the day a task is due | `PASS` | `lib/tasks.ts::groupUpcomingByDay`; `lib/tasks.test.ts`; `pages/Upcoming.test.tsx` |
| Useful empty states and clear errors | `PASS` | Empty-state text asserted per view; `LoadError` (role=`alert`) with a retry that reloads — asserted in the three view tests |
| Time-zone correct "today", reusing `due_state`/`timezones` (no new date logic) | `PASS` | `atlas/tasks/views.py` delegates to `atlas/tasks/timezones.py`; boundary case (23:30 UTC = "today" in UTC, "upcoming" in Europe/Amsterdam) in `tests/unit/test_task_views.py` and `tests/integration/test_tasks_views.py` |
| Server-side view filter over HTTP (`view`/`tz`) | `PASS` | `tests/integration/test_tasks_views.py` (11 tests: inbox/today/upcoming, completed/archived/undated exclusion, caller-zone and task-zone precedence, `due_state` present) |
| Boundary validation (`422` unknown view/zone, `400` `view`+`parent_task_id`) | `PASS` | `tests/integration/test_tasks_views.py`; `tests/unit/test_task_views.py` (OpenAPI query parameters) |
| Existing behaviour preserved (default listing unchanged) | `PASS` | `test_the_default_listing_and_order_are_unchanged`; prior 272 tests still pass |
| API contract regenerated and in sync | `PASS` | `openapi.json` regenerated from `app.openapi()`; `npm run gen:api`; committed `schema.d.ts` regenerated (drift diff empty) |
| No existing test removed, skipped or weakened | `PASS` | total rises 272 → 299 (backend) and 8 → 25 (frontend); no `skip`/`xfail` added |
| Lint, format, types, unit suite | `PASS` | `ruff check .`, `ruff format --check .`, `mypy` clean; `pytest tests/unit -q` → **194 passed** (16 new); `npm run lint`/`typecheck` clean |
| Frontend component suite and production build | `PASS` | `npm run test` → 25 passed (17 new); `npm run build` → success |
| Full backend suite (unit + integration) | `PASS` | `pytest -q` against PostgreSQL 18 → **299 passed** (11 new view integration tests) |
| `./scripts/verify.sh` | `PASS` | `verification: PASS` (exit 0) |
| **Browser E2E journey (Playwright)** | `NOT RUN` | Playwright is not set up in this repository; no browser-driven journey is executed. Recorded honestly, not waived (consistent with M2/M3 notes) |

**Commands run.**

```
cd services/api && .venv/bin/ruff check . && .venv/bin/ruff format --check . && .venv/bin/mypy
    # clean (46 source files)
cd services/api && .venv/bin/python -m pytest tests/unit -q
    # 194 passed
cd services/api && TEST_DATABASE_URL=postgresql+psycopg://atlas:atlas@127.0.0.1:5432/atlas_test \
  .venv/bin/python -m pytest tests/integration/test_tasks_views.py -q
    # 11 passed
cd services/api && TEST_DATABASE_URL=postgresql+psycopg://atlas:atlas@127.0.0.1:5432/atlas_test \
  .venv/bin/python -m pytest -q
    # 299 passed
cd services/api && .venv/bin/python -c "import json; from atlas.main import app; \
  open('openapi.json','w').write(json.dumps(app.openapi()))"   # then:
cd apps/web && npm run gen:api     # schema.d.ts regenerated; drift diff → in sync
cd apps/web && npm run lint && npm run typecheck && npm run test && npm run build
    # clean; vitest 25 passed; build produced dist/
cd /home/kim/Documents/Atlas && ./scripts/verify.sh
    # verification: PASS (exit 0)
```

**Scope note.** Only the primary views and the query surface they need are added — the generic task
filters/search (M3-08), the task change log (M3-09) and projects (M4) are untouched. Quick capture
sends a title only; other task fields keep their existing defaults. Business logic stays out of the
components: fetching lives in `useTaskView`, grouping/formatting in `lib/tasks.ts`, and the view
rules on the server.

**Decision.** How the view query and "today" resolve is recorded in `docs/DECISIONS.md` ADR-0017.

---

## M3-08 — Task search and filters

Verified 2026-10-26 on Linux with Python 3.14, Node 26 and PostgreSQL 18 in Docker (dedicated
`atlas_test` database, never the application's). `GET /api/tasks` gains validated, composable
filters and a bounded text search; the contract is recorded in ADR-0018.

| Criterion | Result | Evidence |
|---|---|---|
| Filter by `status` (repeated and/or comma-separated) | `PASS` | `tests/integration/test_tasks_filters.py::test_status_filter_accepts_repeated_and_comma_separated_values`; unit `test_status_is_accepted_repeated_or_comma_separated` |
| Filter by `priority` | `PASS` | `test_priority_filter_matches_one_priority` |
| Date range on `due_at` (`due_from`/`due_to`, inclusive) | `PASS` | `test_due_range_filter_is_inclusive_and_excludes_undated_tasks`; a date-only `_to` bound covers the whole day (`tests/unit/test_task_filters.py::test_a_date_only_upper_bound_covers_the_whole_day`) |
| Date range on `start_at` (`start_from`/`start_to`, inclusive) | `PASS` | `test_start_range_filter_selects_scheduled_work` |
| Filter by `project_id` | `PASS` | `test_project_filter_selects_one_project` (a well-formed id with no tasks returns an empty list — see limitation below) |
| Filters compose (status + priority + date + project) | `PASS` | `test_status_priority_date_and_project_filters_compose` |
| Filters compose with `view`/`tz` (M3-07) | `PASS` | `test_filters_compose_with_a_view`; the 11 M3-07 view tests still pass unchanged |
| Filters compose with `parent_task_id` (M3-06) | `PASS` | `test_filters_compose_with_parent_task_id`; the 12 M3-06 subtask tests still pass |
| Text search `q` over title **and** description, case-insensitive | `PASS` | `test_search_matches_title_and_description_case_insensitively`, `test_search_terms_are_trimmed` |
| Search matches correctly (match / no match / quotes / non-ASCII) | `PASS` | `test_search_handles_quotes_and_non_ascii_text`; `test_search_matches_...` asserts the no-match case |
| Search is parameterised and cannot alter the statement (no SQL injection) | `PASS` | `test_search_is_parameterised_and_cannot_alter_the_statement` (payload `Robert'); DROP TABLE tasks;--` matches its own task and leaves the table and its rows intact); the term is passed through `ilike(pattern, escape="\\")` as a bound parameter |
| `%`/`_` are literal, not wildcards | `PASS` | `test_search_escapes_like_metacharacters`; unit `test_the_like_pattern_escapes_wildcards_and_the_escape_character` |
| Search input is bounded (max length) | `PASS` | over-long term → `422` (`test_an_over_long_search_term_is_rejected`, `test_an_empty_search_term_is_rejected`); OpenAPI `maxLength == 200`, `minLength == 1` (`tests/unit/test_task_filters.py`) |
| Result size is bounded by a sane limit | `PASS` | `test_limit_bounds_the_result_size`; OpenAPI `limit` `ge=1`, `le=500`, default 200 |
| Deterministic ordering reusing `priority_rank` + due date | `PASS` | `test_a_filtered_listing_is_ordered_by_priority_then_due_date`; the SQL rank is a `CASE` built from `PRIORITY_ORDER` (`atlas/tasks/service.py`) |
| Soft-deleted tasks are excluded from filtered listings | `PASS` | `test_a_filtered_listing_excludes_soft_deleted_tasks` |
| The default listing and order are unchanged | `PASS` | `test_the_default_listing_and_order_are_unchanged` (this file) and the identically named M3-07 test; capture order is kept when no filter is set |
| Unknown status / priority rejected without side effects | `PASS` | `test_an_unknown_status_is_rejected`, `test_an_unknown_priority_is_rejected`, `test_a_rejected_filter_creates_and_changes_nothing` (`422`) |
| Malformed / inverted date bounds rejected | `PASS` | `test_a_malformed_date_bound_is_rejected`, `test_an_inverted_range_is_rejected` (`422`) |
| Malformed `project_id` / out-of-range `limit` rejected | `PASS` | `test_a_malformed_project_id_is_rejected`, `test_an_out_of_range_limit_is_rejected` (`422`) |
| Incompatible combinations still rejected | `PASS` | `test_view_and_parent_task_id_are_still_incompatible` (`400`), `test_an_unknown_view_is_still_rejected_with_filters` (`422`) |
| Validation errors leave the data untouched | `PASS` | `test_a_rejected_filter_creates_and_changes_nothing` compares the full listing before/after every rejected request; `_assert_rejected` does the same per case |
| No migration required | `PASS` | no schema change: the existing `user_id`, `status`, `priority` and `due_at` indexes cover the filters at the intended personal scale (ADR-0018). `test_migrations_match_models` still reports no drift |
| API contract regenerated and in sync | `PASS` | `openapi.json` regenerated from `app.openapi()`; `npm run gen:api`; re-running produces a byte-identical `schema.d.ts` (drift diff empty) |
| Unit tests for the pure helpers | `PASS` | `tests/unit/test_task_filters.py` (28 tests: status/priority/date/search parsing, `LIKE` escaping, filter composition, OpenAPI parameter bounds) |
| Integration tests over HTTP against PostgreSQL | `PASS` | `tests/integration/test_tasks_filters.py` (28 tests) |
| No existing test removed, skipped or weakened | `PASS` | the prior 299 tests still pass untouched; total **355 passed**; no `skip`/`xfail` added |
| Lint, format, types, unit suite | `PASS` | `ruff check .`, `ruff format --check .`, `mypy` clean; `pytest tests/unit -q` → **222 passed** (28 new) |
| Full backend suite (unit + integration) | `PASS` | `pytest -q` against PostgreSQL 18 → **355 passed** (28 new filter/search integration tests) |
| Frontend lint, types and component suite | `PASS` | `npm run lint`, `npm run typecheck`, `npm run test` → 27 passed (unchanged) |
| `./scripts/verify.sh` | `PASS` | `verification: PASS` (exit 0) |
| **Browser E2E journey (Playwright)** | `NOT RUN` | Playwright is not set up in this repository; no browser-driven journey is executed. Recorded honestly, not waived (consistent with M2/M3 notes) |

**Commands run.**

```
cd services/api && .venv/bin/ruff check . && .venv/bin/ruff format --check . && .venv/bin/mypy
    # clean (47 source files)
cd services/api && .venv/bin/python -m pytest tests/unit -q
    # 222 passed
cd services/api && TEST_DATABASE_URL=postgresql+psycopg://atlas:atlas@127.0.0.1:5432/atlas_test \
  .venv/bin/python -m pytest tests/integration/test_tasks_filters.py -q
    # 28 passed
cd services/api && TEST_DATABASE_URL=postgresql+psycopg://atlas:atlas@127.0.0.1:5432/atlas_test \
  .venv/bin/python -m pytest -q
    # 355 passed
cd services/api && .venv/bin/python -c "import json; from atlas.main import app; \
  open('openapi.json','w').write(json.dumps(app.openapi()))"   # then:
cd apps/web && npm run gen:api     # schema.d.ts regenerated; re-running → byte-identical (in sync)
cd apps/web && npm run lint && npm run typecheck && npm run test
    # clean; vitest 27 passed
cd /home/kim/Documents/Atlas && ./scripts/verify.sh
    # verification: PASS (exit 0)
```

**Scope note.** Only the listing filters and the text search are added — the task change log
(M3-09), projects (M4), Kanban and calendar features are untouched, and no migration was needed.
Business logic stays in the pure `atlas/tasks/filters.py`; the HTTP layer only validates and
translates errors, and the SQL stays in `atlas/tasks/service.py`.

**Limitation.** Projects are a M4 entity, so `project_id` cannot yet be checked for existence: a
malformed id is rejected (`422`), while a well-formed id that matches no task returns an empty
list. Existence validation and a `project_id` index arrive with M4.

**Decision.** The filter/search contract is recorded in `docs/DECISIONS.md` ADR-0018.

---

## M3-09 — Change log for tasks (client pull)

Verified 2026-10-26 on Linux with Python 3.14, Node 26 and PostgreSQL 18 in Docker (dedicated
`atlas_test` database, never the application's). `GET /api/tasks/changes?since=<revision>&limit=<n>`
returns the calling user's tasks changed after the cursor — including soft-deleted tombstones — with
a new high-water mark (`next_since`) and `has_more` for gap-free paging. The contract is recorded in
ADR-0019.

| Criterion | Result | Evidence |
|---|---|---|
| Empty change set for a new user | `PASS` | `tests/integration/test_tasks_changes.py::test_the_change_set_is_empty_for_a_new_user` (`tasks == []`, `next_since == 0`, `has_more == false`) |
| Create then pull returns the tasks, ordered by revision | `PASS` | `test_creating_tasks_then_pulling_returns_them` |
| Only tasks with `revision > since` are returned | `PASS` | `test_a_cursor_at_the_high_water_mark_returns_nothing` (a pull at/above the high-water mark is empty) |
| An update bumps revision and the task re-appears once at the higher revision | `PASS` | `test_an_update_bumps_the_revision_and_reappears_once` (two bumps between pulls → one item at `revision 3`) |
| Soft-deleted tasks appear as tombstones | `PASS` | `test_a_soft_delete_appears_as_a_tombstone` (`deleted_at` non-null, `revision == 2`) |
| Results are ordered by `revision` ascending | `PASS` | the integration paging helper asserts each page is sorted; the query orders by `(revision, id)` (`atlas/tasks/service.py::TasksService.changes`) |
| Paging across a limit boundary is complete and duplicate-free | `PASS` | `test_paging_is_complete_and_duplicate_free_across_revision_ties` (drains the change set at limits 1/2/3/4/200, mixing revision-1 and revision-2 ties; every id seen exactly once); unit simulation `tests/unit/test_task_changes.py::test_paging_covers_every_revision_once_with_no_gaps_or_duplicates` |
| A page never splits a run of equal revisions (no cursor gap) | `PASS` | unit `test_a_page_never_splits_a_run_of_equal_revisions`; `plan_change_page` delivers whole revision groups |
| A single revision group larger than `limit` still makes progress | `PASS` | `test_a_single_revision_group_larger_than_the_limit_is_returned_whole`; unit `test_a_single_continuing_run_larger_than_the_limit_is_delivered_whole` |
| `since`/`limit` validated at the boundary with no side effects | `PASS` | `test_an_invalid_cursor_or_limit_is_rejected_without_side_effects` (`since` `-1`/`> 2 147 483 647`/non-integer, `limit` `0`/`501`/non-integer → `422`; the full feed is byte-identical before/after) |
| Endpoint is read-only | `PASS` | it is `GET` only; a rejected request leaves the feed unchanged and no mutation is reachable |
| Strictly user-scoped (no leak of another user's tasks) | `PASS` | `test_changes_are_strictly_user_scoped` (another user's revision-9 tombstone is absent; `next_since == 1`) |
| Authentication required | `PASS` | `test_changes_require_authentication` (`401`) |
| Unit tests for the pure cursor/limit parsing and page planner | `PASS` | `tests/unit/test_task_changes.py` (22 tests: `parse_since`, `parse_change_limit`, `plan_change_page`, a paging simulation, and the OpenAPI surface) |
| Integration tests over HTTP against PostgreSQL | `PASS` | `tests/integration/test_tasks_changes.py` (10 tests) |
| No migration required | `PASS` | no schema change: `user_id` is already indexed and the query runs per user at personal scale (ADR-0019); `test_migrations_match_models` still reports no drift |
| API contract regenerated and in sync | `PASS` | `openapi.json` regenerated from `app.openapi()`; `npm run gen:api`; `apps/web/src/api/schema.d.ts` updated with `/api/tasks/changes` + `TaskChangesOut`/`TaskChangeOut` |
| No existing test removed, skipped or weakened | `PASS` | the prior 355 tests still pass untouched; total **387 passed**; no `skip`/`xfail` added |
| Lint, format, types, unit suite | `PASS` | `ruff check .`, `ruff format --check .`, `mypy` clean; `pytest tests/unit -q` → **244 passed** (22 new) |
| Full backend suite (unit + integration) | `PASS` | `pytest -q` against PostgreSQL 18 → **387 passed** (32 new) |
| Frontend lint, types and component suite | `PASS` | `npm run lint`, `npm run typecheck`, `npm run test` → 27 passed (unchanged) |
| `./scripts/verify.sh` | `PASS` | `verification: PASS` (exit 0) |
| **Browser E2E journey (Playwright)** | `NOT RUN` | Playwright is not set up in this repository; no browser-driven journey is executed. Recorded honestly, not waived (consistent with M2/M3 notes) |

**Commands run.**

```
cd services/api && .venv/bin/ruff check . && .venv/bin/ruff format --check . && .venv/bin/mypy
    # clean (48 source files)
cd services/api && .venv/bin/python -m pytest tests/unit -q
    # 244 passed
cd services/api && TEST_DATABASE_URL=postgresql+psycopg://atlas:atlas@127.0.0.1:5432/atlas_test \
  .venv/bin/python -m pytest tests/integration/test_tasks_changes.py -q
    # 10 passed
cd services/api && TEST_DATABASE_URL=postgresql+psycopg://atlas:atlas@127.0.0.1:5432/atlas_test \
  .venv/bin/python -m pytest -q
    # 387 passed
cd services/api && .venv/bin/python -c "import json; from atlas.main import app; \
  open('openapi.json','w').write(json.dumps(app.openapi()))"   # then:
cd apps/web && npm run gen:api     # schema.d.ts regenerated with the new route/schemas
cd apps/web && npm run lint && npm run typecheck && npm run test
    # clean; vitest 27 passed
cd /home/kim/Documents/Atlas && ./scripts/verify.sh
    # verification: PASS (exit 0)
```

**Scope note.** Only the incremental task change feed is added — full client sync / offline queue
(M7), the notes change feed, projects (M4) and Kanban are untouched, and no migration was needed.
Business logic stays in the pure `atlas/tasks/changes.py`; the SQL lives in
`atlas/tasks/service.py`; the HTTP layer only validates and translates errors.

**Limitation.** Tombstones are retained indefinitely, so a client may resync from `since=0` at any
time; a bounded retention window for devices offline longer than the window is M7-02 (ADR-0019).
Because a page never splits a run of equal revisions, a client must page on `next_since`/`has_more`
and must not assume `len(tasks) == limit`.

**Decision.** The change-feed/pull contract is recorded in `docs/DECISIONS.md` ADR-0019.

---

## M3 — Gate (exit criteria)

Verified 2026-10-26 on Linux with Python 3.14, Node 26 and PostgreSQL 18 in Docker. All M3 tasks
(M3-01…M3-09) are `DONE`; this is the explicit milestone-gate journey.

| Criterion | Result | Evidence |
|---|---|---|
| Tasks persist across restarts | `PASS` | A task written to a migrated database survived a real `docker restart atlas-db-1` with identical id/title/status/revision (disposable `atlas_gate` database, dropped afterwards) |
| Recurring completion behaves correctly | `PASS` | M3-05 — series preserved, next occurrence generated, future occurrences untouched |
| Due dates + time zones correct | `PASS` | M3-04 DST unit tests + the HTTP round-trip tests in the journey below |
| Mutations transactional; retries do not duplicate | `PASS` | Idempotency replay tests (M3-02 create, M3-05 completion) inside the journey |
| Essential workflows work with calendar disconnected | `PASS` | 93 integration tests over HTTP against PostgreSQL; the codebase contains no calendar integration |
| Cross-device convergence | `NOT RUN` | M7-01/M7-02 — recorded, not waived |

**Commands run.**

```
./scripts/verify.sh
    # verification: PASS — backend 387 passed; frontend 27 passed

cd services/api && TEST_DATABASE_URL=postgresql+psycopg://atlas:atlas@127.0.0.1:5432/atlas_test \
  .venv/bin/python -m pytest tests/integration/test_tasks_api.py \
    tests/integration/test_tasks_views.py tests/integration/test_tasks_filters.py \
    tests/integration/test_tasks_recurrence.py tests/integration/test_tasks_subtasks.py \
    tests/integration/test_tasks_changes.py -q
    # 93 passed

# restart persistence (disposable DB; the application database is never touched)
docker exec atlas-db-1 psql -U atlas -c "CREATE DATABASE atlas_gate;"
cd services/api && DATABASE_URL=postgresql+psycopg://atlas:atlas@127.0.0.1:5432/atlas_gate \
  .venv/bin/alembic upgrade head            # migrations apply cleanly to a fresh DB
# insert a user + task, then:
docker restart atlas-db-1                    # → row still present, fields identical
docker exec atlas-db-1 psql -U atlas -c "DROP DATABASE atlas_gate;"
```

**Gate:** tasks usable as a standalone daily tool — **APPROVED 2026-10-26**. Browser E2E
(Playwright not set up) and cross-device convergence (M7) are recorded as `NOT RUN`, not waived.

---

## M4 — Projects and Planning

### M4-01 — Project schema + CRUD

Verified 2026-10-26 on Linux with Python 3.14 and PostgreSQL 18 in Docker (test database
`atlas_test`; the application `atlas` database was never touched).

| Acceptance criterion | Result | Evidence |
|---|---|---|
| `projects` has exactly the DATA_MODEL §2.3 fields | `PASS` | `tests/unit/test_project_schema.py::test_projects_table_has_the_documented_columns` (exact column set); DB column/nullability/default dump below |
| Required columns `NOT NULL`, defaults and indexes correct | `PASS` | `test_required_project_columns_are_not_nullable`, `test_project_status_default_and_revision`; DB dump shows `status 'active'`, `revision '1'`, `created_at/updated_at now()` |
| `user_id` FK `CASCADE` | `PASS` | `test_project_foreign_keys_and_indexes`; `tests/integration/test_projects_schema.py::test_deleting_a_user_cascades_to_projects` |
| Migration renders the schema and is reversible | `PASS` | `test_migration_renders_the_project_schema`, `test_migration_is_reversible` (offline DDL); live `alembic downgrade base → upgrade head → downgrade -1 → upgrade head` |
| Migration matches the models on a real DB | `PASS` | `tests/integration/test_tasks_schema.py::test_migrations_match_models` (empty `compare_metadata` diff) |
| `tasks.project_id` FK exists with the documented ON DELETE behaviour | `PASS` | `pg_constraint` (`fk_tasks_project_id_projects`, `confdeltype='n'` = SET NULL); `test_tasks_project_id_references_projects`; `test_deleting_a_project_sets_its_tasks_project_to_null` |
| CRUD endpoints exist | `PASS` | `POST`/`GET`/`GET {id}`/`PATCH`/`DELETE` at `/api/projects`; 15 HTTP integration tests in `tests/integration/test_projects_api.py` |
| Soft delete (tombstone) | `PASS` | `test_delete_is_soft_and_hides_the_project`, `test_delete_with_an_idempotency_key_replays` |
| Stale `base_revision` → `409` | `PASS` | `test_stale_base_revision_is_rejected_without_changing_state` |
| `Idempotency-Key` replay returns the original result | `PASS` | `test_create_is_idempotent_for_the_same_key`, `test_reusing_a_key_with_a_different_payload_is_rejected` |
| Validation errors rejected with no side effects | `PASS` | `test_validation_errors_are_rejected_without_side_effects`, `test_an_update_cannot_store_an_inverted_date_range` |
| Strict user scoping | `PASS` | `test_projects_are_strictly_user_scoped` (another user's project → `404` on GET/PATCH/DELETE, absent from the list) |
| Integration + unit tests added; no existing test weakened or removed | `PASS` | 32 new tests; the four M3 task tests that set an arbitrary `project_id` now create a real project first (they assert the same behaviour against the new foreign key) |
| `ruff` / `ruff format --check` / `mypy` / full suite / `verify.sh` | `PASS` | commands below |

**Commands run.**

```
cd services/api
.venv/bin/ruff check .                      # All checks passed!
.venv/bin/ruff format --check .             # 101 files already formatted
.venv/bin/mypy                              # Success: no issues found in 52 source files
.venv/bin/python -m pytest tests/unit -q    # 258 passed
TEST_DATABASE_URL=postgresql+psycopg://atlas:atlas@127.0.0.1:5432/atlas_test \
  .venv/bin/python -m pytest -q             # 419 passed
TEST_DATABASE_URL=postgresql+psycopg://atlas:atlas@127.0.0.1:5432/atlas_test \
  .venv/bin/python -m pytest tests/unit/test_project_schema.py tests/unit/test_projects_api.py \
    tests/integration/test_projects_api.py tests/integration/test_projects_schema.py -q   # 32 passed

# migration on a real (test) database
DATABASE_URL=postgresql+psycopg://atlas:atlas@127.0.0.1:5432/atlas_test \
  .venv/bin/alembic downgrade base && .venv/bin/alembic upgrade head \
  && .venv/bin/alembic downgrade -1 && .venv/bin/alembic upgrade head   # each step clean; `current` = 8f1c2a7d5e04 (head)

# contract regeneration
.venv/bin/python -c "import json; from atlas.main import app; open('openapi.json','w').write(json.dumps(app.openapi()))"
cd apps/web && npm run gen:api && npm run typecheck && npm run lint && npm run test   # 27 passed; re-running gen:api is byte-identical

cd /home/kim/Documents/Atlas && ./scripts/verify.sh   # verification: PASS
```

**Schema dump (atlas_test).**

```
id          NO   (uuid)          user_id   NO   (uuid)   name   NO   (varchar 512)
description YES  (text)          status    NO   'active'  revision NO  1
start_date  YES  (date)          target_date YES (date)   created_at/updated_at NO now()
deleted_at  YES  (timestamptz)
pg_constraint: fk_tasks_project_id_projects on tasks (project_id) → projects(id), confdeltype='n'
  (n = ON DELETE SET NULL)
```

**Limitations recorded, not waived.** Task↔project association semantics (assigning tasks to a
project, and what a project tombstone means for its tasks) and all other M4 scope are deferred to
M4-02…M4-07. No browser E2E exists (Playwright not set up) — the project surface is API-only in this
task.

---

### M4-02 — Task↔project association

Verified 2026-10-26 on Linux with Python 3.14 and PostgreSQL 18 in Docker (test database
`atlas_test`; the application `atlas` database was never touched). No migration was required — the
schema from M4-01 already supports membership (`project_id` nullable, FK `ON DELETE SET NULL`).

| Acceptance criterion | Result | Evidence |
|---|---|---|
| A task can be assigned to a project on create | `PASS` | `tests/integration/test_project_tasks.py::test_a_task_can_be_created_in_a_project` (`201`, `project_id` set, listed under the project) |
| A task can move between projects via `PATCH` | `PASS` | `test_a_task_can_move_between_projects` (new `project_id`, `revision` +1, gone from the old project, present in the new) |
| Membership can be cleared (`project_id: null`) | `PASS` | `test_membership_can_be_cleared_and_is_optional`; `tests/unit/test_tasks_api.py::test_update_distinguishes_an_omitted_project_from_an_explicit_null` (pure schema check) |
| Membership is optional — a task with no project is unaffected | `PASS` | `test_membership_can_be_cleared_and_is_optional`, `tests/unit/test_tasks_api.py::test_a_task_can_be_created_without_a_project`; `project_id` is unchanged/`null` and the task keeps its title, status and listing |
| A project's tasks can be listed | `PASS` | `GET /api/projects/{id}/tasks` — `test_a_projects_tasks_are_listed_and_match_the_project_filter`; `tests/unit/test_projects_api.py::test_a_projects_tasks_are_exposed_as_a_read_only_sub_resource`, `..._takes_a_project_id_and_a_bounded_limit`, `..._returns_the_task_list_shape` |
| Filtering by project still works, with unchanged M3-08 semantics | `PASS` | `test_a_projects_tasks_are_listed_and_match_the_project_filter` (identical ids/ordering to the endpoint); existing `tests/integration/test_tasks_filters.py::test_project_filter_selects_one_project` (unknown-but-well-formed id matches nothing) unchanged and passing |
| The listing is strictly user-scoped | `PASS` | `test_a_foreign_projects_tasks_are_invisible`, `test_a_project_listing_reports_unknown_and_foreign_projects_as_missing` (foreign project → `404`; its project id matches no tasks) |
| Assigning an unknown/foreign project is rejected with no side effects | `PASS` | `test_creating_with_an_unknown_project_is_rejected_without_side_effects` (task list byte-identical), `test_moving_to_an_unknown_or_foreign_project_is_rejected_without_side_effects` (`400`; `project_id` and `revision` unchanged) |
| Project soft-delete behaviour for its tasks is documented | `PASS` | `DECISIONS.md` ADR-0021; `DATA_MODEL.md` §2.3 and §5 |
| …and implemented exactly as documented (tasks preserved; live tasks un-filed) | `PASS` | `test_deleting_a_project_unfiles_its_live_tasks` (task row kept, `project_id` NULL, `revision` +1), `test_deleting_a_project_leaves_already_deleted_tasks_untouched` (tombstone row byte-identical) |
| The un-filing propagates to offline clients | `PASS` | `test_the_unfiling_appears_in_the_change_feed` (one non-tombstone change with `project_id: null` at the bumped revision) |
| A deleted project can no longer be assigned | `PASS` | `test_a_task_cannot_be_moved_into_a_deleted_project` (`400`, membership stays cleared) |
| No regression of subtasks / recurrence | `PASS` | `test_a_subtask_cannot_be_moved_to_another_project` (ADR-0016 rule intact); `test_a_recurring_task_keeps_its_project_across_occurrences` (M3-05: the next occurrence inherits the project and is un-filed too); the M3-06/M3-05 suites are unmodified and green |
| Integration tests added; no existing test weakened or removed | `PASS` | 15 integration + 5 unit tests added (`tests/integration/test_project_tasks.py`, `tests/unit/test_tasks_api.py`, `tests/unit/test_projects_api.py`); no existing test edited |
| `ruff` / `ruff format --check` / `mypy` / full suite / frontend / `verify.sh` | `PASS` | commands below |

**Commands run.**

```
cd services/api
.venv/bin/ruff check .                      # All checks passed!
.venv/bin/ruff format --check .             # 102 files already formatted
.venv/bin/mypy                              # Success: no issues found in 52 source files
.venv/bin/python -m pytest tests/unit -q    # 263 passed
TEST_DATABASE_URL=postgresql+psycopg://atlas:atlas@127.0.0.1:5432/atlas_test \
  .venv/bin/python -m pytest -q             # 439 passed
TEST_DATABASE_URL=postgresql+psycopg://atlas:atlas@127.0.0.1:5432/atlas_test \
  .venv/bin/python -m pytest tests/integration/test_project_tasks.py -q   # 15 passed

# contract regeneration (openapi.json is git-ignored; schema.d.ts is committed)
SECRET_KEY=… SESSION_SECRET=… TOKEN_ENCRYPTION_KEY=… ATLAS_ENV=test .venv/bin/python -c \
  "import json; from atlas.main import app; open('openapi.json','w').write(json.dumps(app.openapi()))"
cd apps/web && npm run gen:api              # delta vs. the pre-M4-02 schema: the one new path + operation
npm run lint && npm run typecheck && npm run test   # 27 passed

cd /home/kim/Documents/Atlas && ./scripts/verify.sh   # verification: PASS
```

**Note.** No migration was added (none is required). The change feed, views, filters, subtask and
recurrence suites were not modified, and M4-03…M4-07 (board columns, derived progress, note links,
planning, export) were not started.

---

### M4-03 — Kanban board (columns from task status)

Verified 2026-10-26 on Linux with Python 3.14 / Node and PostgreSQL 18 in Docker (test database
`atlas_test`; the application `atlas` database was never touched). Frontend-only change — **no API,
schema or migration change**, so no backend test was added and OpenAPI / `schema.d.ts` were not
regenerated.

| Acceptance criterion | Result | Evidence |
|---|---|---|
| A board renders one column per status with the corresponding tasks | `PASS` | `apps/web/src/components/Board.test.tsx` ("renders one column per status with the tasks that belong to it"), `apps/web/src/pages/Board.test.tsx` ("renders one column per status with the tasks returned by the API") — all five headings present, tasks in the right column |
| The columns are exactly the server's canonical statuses (none invented) | `PASS` | `apps/web/src/lib/taskStatus.test.ts` ("has exactly the server's five statuses, in column order"); the table mirrors `services/api/atlas/tasks/state.py::TRANSITIONS` (asserted per status) |
| Moving a task between columns persists through `PATCH` with `base_revision` | `PASS` | `apps/web/src/api/client.test.ts::tasksApi.setStatus` ("PATCHes the task status together with its `base_revision`" — body `{status, base_revision}` for `/api/tasks/t1`); `apps/web/src/pages/Board.test.tsx` ("persists a valid move and re-renders the card in its new column") |
| The change is reflected in the UI (success path) | `PASS` | `apps/web/src/pages/Board.test.tsx` — after the move the card is in the new column and gone from the old one |
| A rejected transition (`409`) is surfaced, not silently ignored, and the card does not move | `PASS` | `apps/web/src/pages/Board.test.tsx` ("surfaces a stale (409) rejection and leaves the card where it was" — `role="alert"` shown, card still in Inbox), ("reports an invalid transition the server rejects" — server reason surfaced) |
| Disallowed moves are prevented/flagged consistently with `state.py` | `PASS` | `apps/web/src/components/Board.test.tsx` ("refuses a drop into a column the state machine forbids"), ("offers a keyboard alternative that only enables allowed targets" — forbidden `<option>`s disabled) |
| Keyboard-accessible alternative to drag | `PASS` | per-card status `<select>`; `apps/web/src/components/Board.test.tsx` and `apps/web/src/pages/Board.test.tsx` exercise it via `getByLabelText("Move …")` |
| Empty states / empty columns | `PASS` | `apps/web/src/components/Board.test.tsx` and `pages/Board.test.tsx` ("shows a useful empty state with every column present" — a hint plus five "No tasks" placeholders) |
| Light/dark themes | `PASS` | new styles use the existing `--surface`/`--border`/`--text`/`--accent` variables, so both themes are covered (CSS only) |
| Business logic out of components | `PASS` | status model/rules in `apps/web/src/lib/taskStatus.ts`, data + persistence in `apps/web/src/hooks/useBoard.ts`; `components/Board.tsx` renders props only |
| No new heavy dependency (native drag-and-drop) | `PASS` | native HTML5 `draggable`/`dataTransfer`; `apps/web/package.json` unchanged, `docs/DEPENDENCIES.md` unchanged (recorded in ADR-0022) |
| Component tests added; no existing test weakened or removed | `PASS` | 20 new tests across 4 files; baseline 27 → 47 frontend tests, all passing; existing suites untouched |
| `ruff` / `ruff format --check` / `mypy` / full suite / frontend / `verify.sh` | `PASS` | commands below |
| Browser E2E (drag end-to-end) | `NOT RUN` | Playwright is not set up in this repository; no E2E harness exists |

**Commands run.**

```
cd apps/web
npm run lint                                # clean
npm run typecheck                           # clean
npm run test                                # 47 passed (was 27; +20 new)
npm run build                               # built in ~1.5s, no errors

cd services/api                             # unchanged; run to prove no regression
.venv/bin/ruff check .                      # All checks passed!
.venv/bin/ruff format --check .             # 102 files already formatted
.venv/bin/mypy                              # Success: no issues found in 52 source files
.venv/bin/python -m pytest tests/unit -q    # 263 passed
TEST_DATABASE_URL=postgresql+psycopg://atlas:atlas@127.0.0.1:5432/atlas_test \
  .venv/bin/python -m pytest -q             # 439 passed

cd /home/kim/Documents/Atlas && ./scripts/verify.sh   # verification: PASS
```

**Files added.** `apps/web/src/lib/taskStatus.ts` (+ `.test.ts`), `apps/web/src/hooks/useBoard.ts`,
`apps/web/src/components/Board.tsx` (+ `.test.tsx`), `apps/web/src/pages/Board.tsx` (+ `.test.tsx`),
`apps/web/src/api/client.test.ts`. **Modified.** `apps/web/src/api/client.ts` (task `list` filters +
`setStatus`), `apps/web/src/App.tsx` (`/board` route), `apps/web/src/components/Layout.tsx` ("Board"
nav item), `apps/web/src/styles.css` (board styles).

**Limitations recorded, not waived.** The board is global (no project-scoped board route yet — the
project detail view does not exist); a project-scoped board can reuse the same component via
`useBoard(projectId)`. The listing is a single `GET /api/tasks` (default `limit` 200), so a board of
more than 200 tasks is truncated until pagination/`limit` handling is added. No browser E2E exists.
M4-04…M4-07 were not touched.

---

### M4-04 — Derived progress calculation

Verified 2026-10-26 on Linux with Python 3.14 and PostgreSQL 18 in Docker (test database `atlas_test`;
the application `atlas` database was never touched). **No migration** — progress is derived, not
stored. **API change:** every project response gains a `progress` object, so OpenAPI and
`apps/web/src/api/schema.d.ts` were regenerated.

| Acceptance criterion | Result | Evidence |
|---|---|---|
| The formula is documented exactly as implemented | `PASS` | `DECISIONS.md` ADR-0023; `PRODUCT_SPEC.md` §5.3; `DATA_MODEL.md` §2.3; module docstring of `atlas/projects/progress.py` |
| `total` = non-archived, non-deleted tasks; `completed` = status `completed` | `PASS` | `atlas/projects/progress.py` (`progress_from_status_counts`, `project_progress`); `tests/unit/test_project_progress.py` |
| Zero-task case defined (0/0, 0%) | `PASS` | `test_no_tasks_is_zero_and_never_complete`, `test_a_project_with_no_tasks_is_zero`; integration `test_a_new_project_reports_zero_progress` |
| Some completed / all completed correct | `PASS` | `test_some_completed` (3→1, 33%), `test_all_completed` (4→4, 100%); integration `test_progress_counts_completed_tasks_of_the_project`, `test_all_completed_is_one_hundred_percent` |
| Archived tasks excluded | `PASS` | `test_archived_tasks_are_excluded`, `test_a_project_of_only_archived_tasks_has_no_progress`; integration `test_archived_deleted_and_unfiled_tasks_are_excluded`, `test_archiving_a_completed_task_stops_it_counting` |
| Tombstoned (deleted) tasks excluded | `PASS` | `test_deleted_and_non_project_tasks_never_count`; integration `test_archived_deleted_and_unfiled_tasks_are_excluded`, `test_deleting_a_task_lowers_the_progress` |
| A non-project task is not counted | `PASS` | `test_deleted_and_non_project_tasks_never_count` (a task with `project_id=None`, and one in another project); integration `test_archived_deleted_and_unfiled_tasks_are_excluded` |
| Progress exposed on the project API (create / get / update / list) | `PASS` | `tests/integration/test_project_progress.py` (`_progress`, the list and create tests); response schema `ProjectProgressOut` |
| No N+1 in the list endpoint (one grouped query for N projects) | `PASS` | `test_progress_runs_one_grouped_query_for_many_projects` (a single `execute` for three projects); `ProjectsService.progress` runs `GROUP BY project_id, status` |
| Progress is strictly the caller's tasks (user-scoped) | `PASS` | `test_progress_ignores_another_users_tasks_even_if_they_reference_the_project` |
| Unit + integration tests added; no existing test weakened or removed | `PASS` | 12 new unit tests, 9 new integration tests; existing suites untouched (439 → 460) |
| OpenAPI / `schema.d.ts` regenerated and in sync | `PASS` | `npm run gen:api`; delta = `progress` on `ProjectOut` + the new `ProjectProgressOut` schema |
| `ruff` / `ruff format --check` / `mypy` / full suite / frontend / `verify.sh` | `PASS` | commands below |
| Browser E2E | `NOT RUN` | Playwright is not set up in this repository |

**Commands run.**

```
cd services/api
.venv/bin/ruff check .                      # All checks passed!
.venv/bin/ruff format --check .             # 105 files already formatted
.venv/bin/mypy                              # Success: no issues found in 53 source files
.venv/bin/python -m pytest tests/unit -q    # 275 passed
TEST_DATABASE_URL=postgresql+psycopg://atlas:atlas@127.0.0.1:5432/atlas_test \
  .venv/bin/python -m pytest -q             # 460 passed
TEST_DATABASE_URL=postgresql+psycopg://atlas:atlas@127.0.0.1:5432/atlas_test \
  .venv/bin/python -m pytest tests/integration/test_project_progress.py -q   # 9 passed

# contract regeneration (openapi.json is git-ignored; schema.d.ts is committed)
SECRET_KEY=… SESSION_SECRET=… TOKEN_ENCRYPTION_KEY=… ATLAS_ENV=test .venv/bin/python -c \
  "import json; from atlas.main import app; open('openapi.json','w').write(json.dumps(app.openapi()))"
cd apps/web && npm run gen:api              # delta vs. the pre-M4-04 schema: progress + ProjectProgressOut
npm run lint && npm run typecheck && npm run test   # 47 passed

cd /home/kim/Documents/Atlas && ./scripts/verify.sh   # verification: PASS
```

**Files added.** `services/api/atlas/projects/progress.py`,
`services/api/tests/unit/test_project_progress.py`,
`services/api/tests/integration/test_project_progress.py`. **Modified.**
`services/api/atlas/projects/__init__.py`, `services/api/atlas/projects/service.py`,
`services/api/atlas/api/projects.py`, `services/api/atlas/api/schemas.py`,
`services/api/atlas/models/project.py` (docstring only), `apps/web/src/api/schema.d.ts`.

**Limitations recorded, not waived.** `percent` is a convenience rounding of `completed / total`; the
canonical data remain `total`/`completed`, so a client can render its own fraction. No project detail
UI consumes `progress` yet (that is M4-06). Browser E2E is `NOT RUN`. No migration was added and
M4-05…M4-07 were not touched.

---

### M4-05 — Note↔project links

Verified 2026-10-26 on Linux with Python 3.14 and PostgreSQL 18 in Docker (test database `atlas_test`;
the application `atlas` database was never touched). **One reversible migration** adds the
`note_projects` association. **API change:** three new paths/operations plus the `ProjectNotesOut`
schema, so OpenAPI and `apps/web/src/api/schema.d.ts` were regenerated.

| Acceptance criterion | Result | Evidence |
|---|---|---|
| A note can be linked to a project | `PASS` | `tests/integration/test_note_projects.py::test_a_note_can_be_linked_to_a_project_and_listed_both_ways` (`PUT …/notes/{id}` → `204`, row stored) |
| A note can be unlinked from a project | `PASS` | `test_unlinking_removes_the_association_and_is_idempotent` |
| A project's notes are listable | `PASS` | `GET /api/projects/{id}/notes` → `ProjectNotesOut` (`NoteSummaryOut[]`, path order): `test_a_note_can_be_linked_to_a_project_and_listed_both_ways`, `test_a_project_can_list_several_notes_in_path_order`; contract in `tests/unit/test_note_projects_api.py::test_the_project_notes_listing_returns_the_note_summary_shape` |
| A note's projects are listable | `PASS` | `GET /api/notes/{id}/projects` → `ProjectListOut` (with derived `progress`): `test_a_note_can_be_linked_to_a_project_and_listed_both_ways`, `test_a_note_can_be_linked_to_several_projects`; contract in `…::test_the_note_projects_listing_reuses_the_project_list_shape` |
| Links are optional (a note/project with no links is unaffected) | `PASS` | Nothing requires a link; listings are empty by default and existing notes/projects are untouched — `test_unknown_and_foreign_targets_are_rejected_without_side_effects` shows an empty listing when no link exists |
| Linking is idempotent | `PASS` | `test_linking_the_same_note_twice_is_idempotent` (two `204`s, exactly one row, one listing entry); `ON CONFLICT DO NOTHING` on the composite key |
| Unlinking is idempotent | `PASS` | `test_unlinking_removes_the_association_and_is_idempotent` (deleting a missing link → `204`) |
| **The association survives a note rename** | `PASS` | `test_the_link_survives_a_note_rename` — link, rename via `POST /api/notes/{id}/move`, then the project's notes list the note with its **new path** and same id, and the note's projects still resolve; schema-level `tests/integration/test_note_projects_schema.py::test_a_link_survives_the_note_id_with_a_rename_path_change`; structural `tests/unit/test_note_project_schema.py::test_the_association_references_the_note_id_not_its_path` (no `path` column) |
| Note delete has a documented, tested effect on the link (no orphan) | `PASS` | `test_deleting_a_note_removes_its_links` (link rows = 0, project's notes empty, note no longer addressable); `NotesService.delete`; `DATA_MODEL.md` §5; `DECISIONS.md` ADR-0024 |
| Project delete has a documented, tested effect on the link (no orphan; note kept) | `PASS` | `test_deleting_a_project_removes_its_links_but_keeps_the_notes` (link rows = 0, note still `200`, old project `404`, note's projects empty); `ProjectsService.delete`; ADR-0024 |
| No orphans on the hard-delete paths (FK `ON DELETE CASCADE`) | `PASS` | `test_deleting_a_note_row_cascades_to_its_links`, `test_deleting_a_project_row_cascades_to_its_links`, `test_deleting_a_user_cascades_to_its_links` |
| Unique per `(note_id, project_id)` | `PASS` | `tests/unit/test_note_project_schema.py::test_the_pair_is_unique_via_the_composite_primary_key`; `tests/integration/test_note_projects_schema.py::test_the_composite_key_rejects_a_duplicate_link` |
| Unknown / foreign / tombstoned targets rejected with **no side effects** | `PASS` | `test_unknown_and_foreign_targets_are_rejected_without_side_effects` (all `404`, zero rows, listings unchanged), `test_unlinking_with_unknown_or_foreign_targets_is_rejected`, `test_a_tombstoned_project_cannot_be_linked_or_listed`, `test_a_tombstoned_note_cannot_be_linked_or_listed` |
| Strictly user-scoped | `PASS` | `test_the_endpoints_are_strictly_user_scoped` (another user's note/project → `404`; only the caller's association is listed), `test_the_endpoints_require_authentication` (`401`) |
| Migration renders the schema, is reversible and matches the models | `PASS` | `tests/unit/test_note_project_schema.py` (`CREATE TABLE note_projects`, both CASCADE FKs, PK, index; `DROP TABLE` on downgrade); `tests/integration/test_tasks_schema.py::test_migrations_match_models` (empty `compare_metadata` diff, now including `note_projects`); real-DB `upgrade`/`downgrade` check below |
| Unit + integration tests added; no existing test weakened or removed | `PASS` | 12 new unit tests (`test_note_project_schema.py`, `test_note_projects_api.py`) and 20 new integration tests (`test_note_projects.py`, `test_note_projects_schema.py`); existing suites untouched (460 → 492); `conftest.py`'s truncate list gains `note_projects` (additive only) |
| OpenAPI / `schema.d.ts` regenerated and in sync | `PASS` | `npm run gen:api`; delta = `/api/projects/{id}/notes`, `/api/projects/{id}/notes/{note_id}` (put/delete), `/api/notes/{id}/projects` + `ProjectNotesOut`; a second `gen:api` is byte-identical |
| `ruff` / `ruff format --check` / `mypy` / full suite / frontend / `verify.sh` | `PASS` | commands below |
| Browser E2E | `NOT RUN` | Playwright is not set up in this repository; M4-05 is API-only (no link UI was in scope) |

**Commands run.**

```
cd services/api
.venv/bin/ruff check .                      # All checks passed!
.venv/bin/ruff format --check .             # 111 files already formatted
.venv/bin/mypy                              # Success: no issues found in 54 source files
.venv/bin/python -m pytest tests/unit -q    # 287 passed
TEST_DATABASE_URL=postgresql+psycopg://atlas:atlas@127.0.0.1:5432/atlas_test \
  .venv/bin/python -m pytest -q             # 492 passed
TEST_DATABASE_URL=postgresql+psycopg://atlas:atlas@127.0.0.1:5432/atlas_test \
  .venv/bin/python -m pytest tests/integration/test_note_projects.py \
    tests/integration/test_note_projects_schema.py -q   # 20 passed

# migration on a real (test) database
DATABASE_URL=postgresql+psycopg://atlas:atlas@127.0.0.1:5432/atlas_test \
  .venv/bin/alembic downgrade base && .venv/bin/alembic upgrade head \
  && .venv/bin/alembic downgrade -1 && .venv/bin/alembic upgrade head   # each step clean; `current` = f2a9c7d14b60 (head)

# contract regeneration (openapi.json is git-ignored; schema.d.ts is committed)
ATLAS_ENV=test SECRET_KEY=… SESSION_SECRET=… TOKEN_ENCRYPTION_KEY=… .venv/bin/python -c \
  "import json; from atlas.main import app; open('openapi.json','w').write(json.dumps(app.openapi()))"
cd apps/web && npm run gen:api              # delta = the 3 new paths/operations + ProjectNotesOut
npm run lint && npm run typecheck && npm run test   # 47 passed; a second gen:api is byte-identical (md5 unchanged)

cd /home/kim/Documents/Atlas && ./scripts/verify.sh   # verification: PASS
```

**Schema dump (atlas_test).**

```
note_projects: note_id NO (uuid), project_id NO (uuid), created_at NO now()
  pk_note_projects            PRIMARY KEY (note_id, project_id)
  fk_note_projects_note_id_notes           note_id → notes(id)        ON DELETE CASCADE
  fk_note_projects_project_id_projects     project_id → projects(id)  ON DELETE CASCADE
  ix_note_projects_project_id (project_id)
```

**Files added.** `services/api/alembic/versions/f2a9c7d14b60_note_projects.py`,
`services/api/atlas/projects/links.py`, `services/api/tests/unit/test_note_project_schema.py`,
`services/api/tests/unit/test_note_projects_api.py`,
`services/api/tests/integration/test_note_projects.py`,
`services/api/tests/integration/test_note_projects_schema.py`. **Modified.**
`services/api/atlas/models/project.py` (+`NoteProject`), `services/api/atlas/models/__init__.py`,
`services/api/atlas/projects/__init__.py`, `services/api/atlas/projects/service.py` (delete clears
links), `services/api/atlas/notes/service.py` (delete clears links),
`services/api/atlas/api/projects.py`, `services/api/atlas/api/notes.py`,
`services/api/atlas/api/schemas.py` (`ProjectNotesOut`), `services/api/tests/conftest.py` (truncate
list), `apps/web/src/api/schema.d.ts`.

**Limitations recorded, not waived.** The link surface is API-only: no project/notes UI to link or
unlink a note yet, and the links are not embedded in `NoteDetailOut`/`ProjectOut` (dedicated
endpoints are used). Reviving a deleted note (re-creating its path) does **not** restore its links.
Browser E2E is `NOT RUN`. M4-06 (planning views) and M4-07 (export) had not been started when this
record was written; M4-06 is recorded in the next section.

### M4-06 — Daily/weekly planning views

Verified 2026-10-26 on Linux with Node/vitest for the views and Python 3.14 / PostgreSQL 18 in Docker
for the untouched backend (test database `atlas_test`; the application `atlas` database was never
touched). **Frontend-only change — no API, schema or migration change**, so no backend test was added,
OpenAPI / `apps/web/src/api/schema.d.ts` were not regenerated, and the backend suites are expected to
be unchanged (they are: 287 unit / 492 total).

| Acceptance criterion | Result | Evidence |
|---|---|---|
| A **Day** view exists and is navigable | `PASS` | route `/day` (`apps/web/src/App.tsx`), navigation item "Day" (`apps/web/src/components/Layout.tsx`); `apps/web/src/pages/Day.test.tsx` ("opens on today using the server's today view…", "loads another local day from the due window and can return to today" — *Next day* → *Today*) |
| A **Week** view exists and is navigable | `PASS` | route `/week`, navigation item "Week"; `apps/web/src/pages/Week.test.tsx` ("navigates to another week and back" — *Next week* → *This week*) |
| The Day view renders from the API, with the current day taken from the server's `today` view | `PASS` | `listMock` called with `{view: "today"}`; overdue and due-today groups split with the existing `groupToday` helper (`pages/Day.test.tsx`); any other day is requested as a `due_from`/`due_to` window |
| The Week view renders from the API as one due window | `PASS` | `pages/Week.test.tsx` asserts `{dueFrom, dueTo, status: ["inbox","next","in_progress"]}` from `weekWindow`, and that the application's own `due_from`/`due_to` parameters are correct (`api/client.test.ts` — "forwards a planning window and several statuses as query parameters") |
| Tasks are grouped by **local** day (day grouping renders the correct tasks) | `PASS` | `apps/web/src/lib/planning.test.ts` ("keeps the tasks due on the given local day, soonest first, and drops undated ones", "always renders the seven local days, in order, including empty ones", "places each task on its own day, and never places an undated task"); end-to-end placement in `pages/Day.test.tsx` ("shows only the tasks that fall on the selected local day" — the task due at the closing midnight belongs to the next day) |
| Week grouping across days | `PASS` | `lib/planning.test.ts` ("places each task on its own day…"); `pages/Week.test.tsx` ("renders the week as seven local days and places tasks on theirs" — each task appears exactly once, inside its own day's section, and empty days still render with a hint) |
| **Time-zone-correct placement** (a UTC instant that falls on a different local day) | `PASS` | `lib/planning.test.ts` ("places a UTC instant on the viewer's local day, not the UTC one" — 2026-10-26T23:30Z is *not* on Oct 26 for `Europe/Berlin` and *is* on Oct 27); the window itself is asserted to be a local day's boundaries converted to UTC instants ("spans exactly one local day: its midnight to the next", "expresses the window as UTC instants") |
| Grouping reuses the existing helpers; no new date logic beyond the boundary conversion | `PASS` | `lib/planning.ts` delegates to `groupUpcomingByDay`/`byDue` (`lib/tasks.ts`) and to `Intl.DateTimeFormat`; the only arithmetic is a local day/week boundary → ISO instant for the existing `due_from`/`due_to` filter (no re-derivation of `due_state`, which still comes from the server). Recorded in ADR-0025 |
| Project context is shown where it helps (name, and the M4-04 derived `progress`) | `PASS` | `components/TaskList.tsx` project tag + `components/ProjectSummary.tsx`; `pages/Day.test.tsx` ("shows the project context (name and derived progress) of the planned tasks" — tag **and** `3/5 · 60%`), `pages/Week.test.tsx` ("shows the project context and derived progress for the week" — `1/4 · 25%`), `components/ProjectSummary.test.tsx` (a project with no countable tasks shows `0/0 · 0%`, never complete) |
| Project context is non-fatal; failures are surfaced, never silent | `PASS` | `pages/Day.test.tsx` ("keeps the plan visible when project context fails to load" — task still rendered, `role="status"` message), `pages/Week.test.tsx` (same) |
| A plan shows open work only (the server's own active-status rule) | `PASS` | the window request carries `status=["inbox","next","in_progress"]` (`pages/Day.test.tsx`, `pages/Week.test.tsx`, `api/client.test.ts`), matching the server's Today/Upcoming rule (`atlas/tasks/views.py::INACTIVE_STATUSES`) |
| Useful empty states | `PASS` | `pages/Day.test.tsx` ("shows a useful empty state for a day with nothing planned"), `pages/Week.test.tsx` ("…for a week with nothing planned"); empty days inside a week show a hint (`pages/Week.test.tsx`) |
| Clear errors (+ retry) | `PASS` | `pages/Day.test.tsx` and `pages/Week.test.tsx` ("shows a clear error and can retry" — `role="alert"` with the server message, then recovery via *Try again*); `usePlanning` also reports a failed completion as `actionError` (`pages/Day.test.tsx`, "surfaces a completion failure without losing the plan") |
| Keyboard-accessible | `PASS` | navigation is plain `<button>`s inside a labelled `<nav>`; the day legend is an `aria-live="polite"` region; task rows keep the labelled *Complete* button; links are the existing `NavLink`s. No interaction requires a pointer |
| Responsive | `PASS` | `styles.css`: `.week-days` is a 7-column grid that scrolls horizontally below 1100 px and collapses to one column at ≤720 px; `.planning-header` stacks at ≤720 px (CSS only) |
| Light/dark themes | `PASS` | the new rules use only existing variables (`--surface`, `--border`, `--text`, `--muted`, `--accent`, `--space`, `--radius`) (CSS only) |
| Business logic out of components | `PASS` | day/week windows, keys, labels and grouping in `apps/web/src/lib/planning.ts`; data loading in `apps/web/src/hooks/usePlanning.ts`; `pages/Day.tsx`, `pages/Week.tsx`, `components/ProjectSummary.tsx` and `components/TaskList.tsx` render props only |
| Today stays simple; shared components/hooks reused, not duplicated | `PASS` | `pages/Today.tsx` is unchanged (it keeps `useTaskView("today")` + `groupToday` + `TaskList` + `LoadError`); the Day view reuses `groupToday`, `TaskList`, `LoadError`, `quickCapture`-free simple layout, and the Week view reuses the Upcoming view's grouping helper rather than a new one |
| No new dependency | `PASS` | `apps/web/package.json` unchanged; `docs/DEPENDENCIES.md` unchanged; `Intl`/native buttons/Hooks only |
| Component tests added; no existing test weakened or removed | `PASS` | 30 new tests (`lib/planning.test.ts` 11, `pages/Day.test.tsx` 9, `pages/Week.test.tsx` 6, `components/ProjectSummary.test.tsx` 2, `api/client.test.ts` +2); baseline 47 → **77 passed**; no existing test file was modified except the additive `api/client.test.ts` cases and the additive `makeProject` fixture in `src/test/tasks.ts` |
| Backend unchanged (no API change ⇒ no backend test required) | `PASS` | this task modified **no** file under `services/api/` and did not regenerate `apps/web/src/api/schema.d.ts` (the backend files shown as modified in the working tree are the pre-existing, uncommitted M3/M4 changes); `ruff`/`mypy` clean; `pytest tests/unit` → 287 passed and the full suite → 492 passed (both identical to the M4-05 baseline) |
| `ruff` / `ruff format --check` / `mypy` / full suite / frontend / `verify.sh` | `PASS` | commands below |
| Browser E2E (navigate day/week in a real browser) | `NOT RUN` | Playwright is not set up in this repository (no E2E harness exists); the criterion is recorded as not run, not as passing |

**Commands run.**

```
cd services/api
.venv/bin/ruff check .                      # All checks passed!
.venv/bin/ruff format --check .             # 111 files already formatted
.venv/bin/mypy                              # Success: no issues found in 54 source files
.venv/bin/python -m pytest tests/unit -q    # 287 passed
TEST_DATABASE_URL=postgresql+psycopg://atlas:atlas@127.0.0.1:5432/atlas_test \
  .venv/bin/python -m pytest -q             # 492 passed

cd apps/web
npm run lint                                # clean (eslint)
npm run typecheck                           # clean (tsc --noEmit)
npm run test                                # 77 passed (17 files)
npm run build                               # clean (tsc --noEmit && vite build)

cd /home/kim/Documents/Atlas && ./scripts/verify.sh   # verification: PASS
```

**Files added.** `apps/web/src/lib/planning.ts`, `apps/web/src/lib/planning.test.ts`,
`apps/web/src/hooks/usePlanning.ts`, `apps/web/src/components/ProjectSummary.tsx`,
`apps/web/src/components/ProjectSummary.test.tsx`, `apps/web/src/pages/Day.tsx`,
`apps/web/src/pages/Day.test.tsx`, `apps/web/src/pages/Week.tsx`, `apps/web/src/pages/Week.test.tsx`.
**Modified.** `apps/web/src/App.tsx` (routes), `apps/web/src/components/Layout.tsx` (navigation),
`apps/web/src/components/TaskList.tsx` (optional project tag),
`apps/web/src/api/client.ts` (`dueFrom`/`dueTo`, multi-status forwarding, `projectsApi.list`),
`apps/web/src/api/client.test.ts` (additive cases), `apps/web/src/test/tasks.ts` (additive
`makeProject` fixture), `apps/web/src/styles.css` (planning styles). **This task changed no file under
`services/api/` and did not regenerate `apps/web/src/api/schema.d.ts`.**

**Limitations recorded, not waived.** Overdue carry-over is shown on the current day (the server's
`today` view) but not on an arbitrary future day, which lists only what is due on it. A plan is
bounded by the task listing's `limit` (200), so a very busy week is truncated until pagination
exists. Placement uses the viewer's zone (as the Upcoming view already did), so a task that declares
its own zone is displayed on the *viewer's* day even though the server classified its `due_state` in
the task's zone. `weekDayGroups`/`tasksForDay` assume the zone they are given is the zone the date
values were constructed in — always true in the app, where both come from the browser. Browser E2E is
`NOT RUN`.

---

### M4-07 — Project export

Verified 2026-10-26 on Linux with Python 3.14 and PostgreSQL 18 in Docker (test database `atlas_test`;
the application `atlas` database was never touched). **No migration** — the export is read-only.
**API change:** two new paths/operations plus the `ProjectExportOut`/`ProjectExportTaskOut`/
`ProjectsExportOut` schemas, so OpenAPI and `apps/web/src/api/schema.d.ts` were regenerated.

| Acceptance criterion | Result | Evidence |
|---|---|---|
| A user can export **one** project in a documented open format | `PASS` | `GET /api/projects/{id}/export` returns the versioned document with exactly one entry in `projects` (`tests/integration/test_project_export.py::test_a_project_with_its_tasks_exports_in_the_open_format`) |
| A user can export **all** their projects | `PASS` | `GET /api/projects/export` (`…::test_all_projects_export_groups_tasks_by_project_and_skips_unfiled_work`) |
| The document is versioned and identifies itself | `PASS` | `format: "atlas.project-export"`, `version: 1`, `generated_at`, `truncated` (`tests/unit/test_project_export.py::test_the_document_is_versioned_and_open`); response schema `ProjectsExportOut` |
| Documented project fields present (name, description, status, dates, revision, timestamps) | `PASS` | `…::test_a_project_document_carries_the_documented_fields_and_progress`; integration fidelity vs. `GET /api/projects/{id}` |
| Documented **task** fields present (``DATA_MODEL`` §2.3), stored values only | `PASS` | `…::test_a_task_document_carries_the_documented_fields`; integration `test_the_export_matches_the_project_and_task_endpoints` (asserts no `due_state`/`subtasks_*`/`deleted_at`) |
| Stable ids (UUID strings) | `PASS` | `test_a_task_document_carries_the_documented_fields` (`id`/`project_id` are the row UUIDs as strings) |
| Timestamps are ISO-8601 **UTC** instants; calendar days are `YYYY-MM-DD` | `PASS` | `…::test_absent_optional_values_stay_null`, `…::test_the_document_is_versioned_and_open`; integration `test_the_exported_instants_are_iso_8601_utc` |
| The derived `progress` is included | `PASS` | `…::test_a_project_with_no_tasks_reports_zero_progress`; integration `test_a_project_with_its_tasks_exports_in_the_open_format` (`{"total":2,"completed":1,"percent":50}`) |
| Note↔project links included; survive a rename | `PASS` | integration `test_linked_notes_are_included_and_follow_a_rename` |
| Faithful (export equals the live endpoints) | `PASS` | integration `test_the_export_matches_the_project_and_task_endpoints` |
| **Self-consistent / no torn read** (single consistent snapshot) | `PASS` | the whole document is read in one `REPEATABLE READ` transaction (`ProjectsService.begin_consistent_read`); integration `test_the_export_reads_one_repeatable_read_snapshot` asserts PostgreSQL reports `repeatable read` for the export's transaction. No concurrent-write race test (would be non-deterministic) — the guarantee is structural |
| Strictly user-scoped (another user's data absent; 404 on a foreign single-project export) | `PASS` | integration `test_the_export_is_strictly_user_scoped`, `test_a_single_project_export_reports_unknown_and_foreign_as_missing`, `test_the_exports_require_authentication` (`401`) |
| Empty state handled | `PASS` | integration `test_an_empty_export_is_well_formed` (`projects: []`, well-formed document); unit `test_the_document_is_empty_but_well_formed_with_no_projects` |
| Scale: bounded, with truncation reported honestly | `PASS` | `limit` (1…500, default 200) bounds projects; `truncated` = `true` when more exist (integration `test_the_project_export_is_bounded_and_reports_truncation`); tasks/notes fetched one query each for all selected projects (no N+1) |
| An out-of-range `limit` is rejected without side effects | `PASS` | integration `test_the_export_limit_is_validated_without_side_effects` (`422`) |
| Only live rows exported (tombstoned project/task/note excluded) | `PASS` | integration `test_soft_deleted_rows_are_excluded`, `test_a_tombstoned_project_cannot_be_exported` |
| `archived` tasks are exported as data but excluded from `progress` | `PASS` | integration `test_archived_tasks_are_exported_but_not_counted_in_progress` (canonical formula, ADR-0023) |
| The format + version are documented as a stable contract | `PASS` | `DECISIONS.md` ADR-0026; module docstring of `services/api/atlas/projects/export.py`; `PRODUCT_SPEC.md` §5.8 (REQ-015) |
| No migration (read-only) | `PASS` | no file added under `services/api/alembic/versions/`; the schema-drift test is unchanged |
| Unit + integration tests added; no existing test weakened or removed | `PASS` | 12 new unit (`tests/unit/test_project_export.py`) + 15 new integration (`tests/integration/test_project_export.py`); existing suites untouched (287 → 299 unit; 492 → 519 total) |
| OpenAPI / `schema.d.ts` regenerated and in sync | `PASS` | `npm run gen:api`; delta = `/api/projects/export`, `/api/projects/{id}/export` + the three export schemas; a second `gen:api` is byte-identical |
| `ruff` / `ruff format --check` / `mypy` / full suite / frontend / `verify.sh` | `PASS` | commands below |
| Browser E2E (download an export in a real browser) | `NOT RUN` | Playwright is not set up in this repository; M4-07 is API-only (no export UI was in scope) |

**Commands run.**

```
cd services/api
.venv/bin/ruff check .                      # All checks passed!
.venv/bin/ruff format --check .             # 114 files already formatted
.venv/bin/mypy                              # Success: no issues found in 55 source files
.venv/bin/python -m pytest tests/unit -q    # 299 passed
TEST_DATABASE_URL=postgresql+psycopg://atlas:atlas@127.0.0.1:5432/atlas_test \
  .venv/bin/python -m pytest -q             # 519 passed
TEST_DATABASE_URL=postgresql+psycopg://atlas:atlas@127.0.0.1:5432/atlas_test \
  .venv/bin/python -m pytest tests/integration/test_project_export.py -q   # 15 passed
# M4 gate journey (projects + tasks + boards + progress + note links + export):
TEST_DATABASE_URL=postgresql+psycopg://atlas:atlas@127.0.0.1:5432/atlas_test \
  .venv/bin/python -m pytest tests/integration/test_projects_api.py \
    tests/integration/test_project_tasks.py tests/integration/test_project_progress.py \
    tests/integration/test_note_projects.py tests/integration/test_project_export.py -q   # 65 passed

# contract regeneration (openapi.json is git-ignored; schema.d.ts is committed)
ATLAS_ENV=test SECRET_KEY=… SESSION_SECRET=… TOKEN_ENCRYPTION_KEY=… .venv/bin/python -c \
  "import json; from atlas.main import app; open('openapi.json','w').write(json.dumps(app.openapi()))"
cd apps/web && npm run gen:api              # delta = the 2 new paths + ProjectExportOut/ProjectExportTaskOut/ProjectsExportOut
npm run lint && npm run typecheck && npm run test && npm run build   # 77 passed; build clean

cd /home/kim/Documents/Atlas && ./scripts/verify.sh   # verification: PASS
```

**Files added.** `services/api/atlas/projects/export.py`,
`services/api/tests/unit/test_project_export.py`,
`services/api/tests/integration/test_project_export.py`. **Modified.**
`services/api/atlas/projects/service.py` (`begin_consistent_read`, `export`, `_export_tasks`,
`_export_notes`), `services/api/atlas/projects/__init__.py`, `services/api/atlas/api/schemas.py`
(`ProjectExportTaskOut`, `ProjectExportOut`, `ProjectsExportOut`),
`services/api/atlas/api/projects.py` (the two export endpoints), `apps/web/src/api/schema.d.ts`.

**Limitations recorded, not waived.** The export is a JSON document bounded by the project `limit`
(default 200); a larger account is exported in pages (the document is not streamed). Note **content**
is not included — note content lives on disk (Markdown is already portable) and belongs to the M9-03
full export, as does the notes-tab export. Tombstones (soft-deleted rows) are not exported (they
remain available through the M3-09 change feed). No export UI is added (the endpoint is the contract).
The "no torn read" property is guaranteed by a single REPEATABLE READ transaction and verified by
inspecting the transaction isolation, not by a concurrent-write race test (which would be
non-deterministic). Browser E2E is `NOT RUN`.

---

## M4 — Gate (exit criteria)

Verified 2026-10-26 on Linux with Python 3.14, Node 26 and PostgreSQL 18 in Docker. All M4 tasks
(M4-01…M4-07) are `DONE`; this is the explicit milestone-gate journey.

| Criterion | Result | Evidence |
|---|---|---|
| Tasks can be organised without forcing project membership | `PASS` | M4-02 — membership is optional and single-valued (ADR-0021) |
| Board changes persist and sync | `PASS` | M4-03 — move persists via `PATCH /api/tasks/{id}` + `base_revision` and reaches offline clients via the M3-09 change feed. Cross-*device* convergence is M7 (recorded, not waived) |
| Progress is derived consistently (documented formula + tests) | `PASS` | M4-04 / ADR-0023 — `completed / total` excluding archived & deleted; single grouped query |
| Today stays simple and responsive | `PASS` | M4-06 — `Today.tsx` unchanged; new Day/Week views reuse its components. Not benchmarked (no regression introduced; frontend tests/build pass) |
| Project data exports | `PASS` | M4-07 / ADR-0026 — versioned open JSON export (`GET /api/projects/export`, `…/{id}/export`), single REPEATABLE READ snapshot |
| Browser E2E (Playwright) | `NOT RUN` | Playwright not set up in the repository — recorded honestly, not waived |

**Commands run.**

```
./scripts/verify.sh
    # verification: PASS — backend 519 passed; frontend 77 passed

cd services/api && TEST_DATABASE_URL=postgresql+psycopg://atlas:atlas@127.0.0.1:5432/atlas_test \
  .venv/bin/python -m pytest tests/integration/test_projects_api.py \
    tests/integration/test_project_tasks.py tests/integration/test_project_progress.py \
    tests/integration/test_note_projects.py tests/integration/test_project_export.py -q
    # 65 passed
```

**Gate:** notes, tasks and projects form one coherent workflow — **APPROVED 2026-10-26**. Cross-device
convergence (M7) and browser E2E are recorded as `NOT RUN`, not waived.

---

## M5 — Unified Read-Only Calendar

### M5-01 — OAuth credential store (encrypted)

Verified 2026-10-26 on Linux with Python 3.14 and PostgreSQL in Docker (test database `atlas_test`;
the application `atlas` database was never touched). **No provider is contacted** — M5-00 (real-account
validation) is `BLOCKED` (AR-001), so this task is built and tested with fakes. **API change:** a new
`/api/calendar` router (three paths/operations) plus the `ProviderCredential*` schemas, so OpenAPI and
`apps/web/src/api/schema.d.ts` were regenerated.

| Acceptance criterion | Result | Evidence |
|---|---|---|
| Credentials are stored **encrypted at rest** (ciphertext in the DB; plaintext token not recoverable without the key) | `PASS` | integration `test_database_stores_ciphertext_not_the_plaintext_token` (raw `SELECT ciphertext` contains neither the access nor the refresh token nor the key material) |
| Encryption uses a **maintained AEAD library**, not custom crypto | `PASS` | `cryptography`'s `AESGCM` (AES-256-GCM) — `services/api/atlas/calendar/crypto.py`; ADR-0027; `DEPENDENCIES.md` |
| The key comes from settings/env, is **never stored in the DB, returned by an API, or logged** | `PASS` | key derived from `Settings.token_encryption_key`; not a column; `ProviderCredentialOut` is metadata only; the key string is absent from the stored row (`…test_database_stores_ciphertext_not_the_plaintext_token`) and from responses (`test_store_read_and_metadata_never_expose_tokens`) |
| A `key_id`/version is recorded so **rotation is feasible** | `PASS` | `key_id` column; migration `c7d18e93a4f2`; rotation demonstrated by `tests/unit/test_token_crypto.py::test_previous_keys_still_decrypt_their_rows_during_rotation` and integration `test_a_row_sealed_with_a_previous_key_is_still_readable` (refresh re-seals with the active key) |
| **Encryption round-trip** | `PASS` | `tests/unit/test_token_crypto.py::test_round_trip_returns_the_original_plaintext`; integration read-back via the service |
| **Tamper/wrong-key detection — decryption fails safely** | `PASS` | unit `test_tampering_is_detected_and_fails_closed`, `test_a_different_key_cannot_decrypt`, `test_an_unknown_key_id_fails_closed`, `test_mismatched_associated_data_fails_closed`, `test_a_truncated_blob_fails_closed`; integration `test_tampered_ciphertext_fails_safely_without_leaking` (`500`, generic message, no token echoed) |
| The key never appears in the ciphertext | `PASS` | `tests/unit/test_token_crypto.py::test_ciphertext_does_not_contain_the_plaintext_or_the_key` |
| **Scopes/expiry persistence** | `PASS` | integration `test_store_read_and_metadata_never_expose_tokens`, `test_expiry_and_scopes_round_trip_through_the_database` (`text[]` scopes and both `timestamptz` expiry instants) |
| **Redaction** of token material in repr/logs/errors | `PASS` | `tests/unit/test_credential_tokens.py::test_bundle_repr_and_str_redact_tokens`, `test_metadata_holds_no_token_material`; errors carry no token (`atlas/calendar/errors.py`); the `422` handler strips `input` on credential paths — integration `test_validation_errors_do_not_echo_token_material`; logger already redacts `access_token`/`refresh_token` (`tests/unit/test_logging.py`) |
| The service **rejects cross-user access** | `PASS` | integration `test_service_rejects_cross_user_access` (`CredentialNotFoundError` on read/delete, empty listing) and `test_credentials_are_strictly_user_scoped` (two rows in the DB, the caller sees one) |
| **Upsert / read / refresh / delete** work; **one credential per user+provider** | `PASS` | integration `test_store_read_and_metadata_never_expose_tokens` (store+read), `test_refresh_updates_tokens_and_expiry`, `test_delete_removes_the_credential`, `test_upsert_replaces_and_keeps_exactly_one_row_per_provider`; unique constraint (`tests/integration/test_provider_credentials_schema.py::test_a_user_and_provider_pair_is_unique`) |
| Typed, user-scoped table with the documented shape; strict user scoping | `PASS` | `provider_credentials` (`id`,`user_id`,`provider`,`key_id`,`ciphertext`,`scopes`,`access_expires_at`,`refresh_expires_at`,`created_at`,`updated_at`); FK `user_id → users.id ON DELETE CASCADE` — `tests/unit/test_provider_credential_schema.py`, `tests/integration/test_provider_credentials_schema.py` |
| Migration renders the schema, is **reversible** and **matches the models** on a real DB | `PASS` | `tests/unit/test_provider_credential_schema.py::test_migration_renders_the_credential_schema` / `test_migration_is_reversible`; `tests/integration/test_provider_credentials_schema.py::test_migrations_match_models` (`compare_metadata` diff empty); upgrade/downgrade commands below |
| Unit tests (round-trips, tamper, key handling, redaction) + integration over HTTP; **no existing test weakened or removed** | `PASS` | 31 new unit (`tests/unit/test_token_crypto.py`, `test_credential_tokens.py`, `test_provider_credential_schema.py`) + 20 new integration (`tests/integration/test_provider_credentials_api.py`, `test_provider_credentials_schema.py`); existing suites unchanged (299 → 330 unit; 519 → 570 total) |
| New dependency reviewed, licensed and audited | `PASS` | `cryptography` (Apache-2.0/BSD) in `DEPENDENCIES.md`; `pyproject.toml` bounded `>=50,<51`; `.venv/bin/pip-audit` → **No known vulnerabilities found** |
| OpenAPI / `schema.d.ts` regenerated and in sync | `PASS` | `npm run gen:api`; delta = `/api/calendar/credentials`, `/api/calendar/credentials/{provider}`, `/api/calendar/credentials/{provider}/refresh` + the four `ProviderCredential*` schemas; a second `gen:api` is byte-identical |
| `ruff` / `ruff format --check` / `mypy` / full suite / `verify.sh` | `PASS` | commands below |
| Real Google/Microsoft OAuth exchange (adapter + real account) | `NOT RUN` — `BLOCKED` | M5-00 is blocked (AR-001); out of scope for M5-01 (no adapter is built) |

**Commands run.**

```
cd services/api
.venv/bin/ruff check .                      # All checks passed!
.venv/bin/ruff format --check .             # 127 files already formatted
.venv/bin/mypy                              # Success: no issues found in 62 source files
.venv/bin/python -m pytest tests/unit -q    # 330 passed
TEST_DATABASE_URL=postgresql+psycopg://atlas:atlas@127.0.0.1:5432/atlas_test \
  .venv/bin/python -m pytest -q             # 570 passed
TEST_DATABASE_URL=postgresql+psycopg://atlas:atlas@127.0.0.1:5432/atlas_test \
  .venv/bin/python -m pytest tests/integration/test_provider_credentials_api.py \
    tests/integration/test_provider_credentials_schema.py -q   # 20 passed
.venv/bin/pip-audit --progress-spinner off  # No known vulnerabilities found

# migration upgrade/downgrade on a real DB (test database only)
DATABASE_URL=postgresql+psycopg://atlas:atlas@127.0.0.1:5432/atlas_test .venv/bin/alembic downgrade base
DATABASE_URL=postgresql+psycopg://atlas:atlas@127.0.0.1:5432/atlas_test .venv/bin/alembic upgrade head
DATABASE_URL=postgresql+psycopg://atlas:atlas@127.0.0.1:5432/atlas_test .venv/bin/alembic current   # c7d18e93a4f2 (head)
DATABASE_URL=postgresql+psycopg://atlas:atlas@127.0.0.1:5432/atlas_test .venv/bin/alembic downgrade -1
DATABASE_URL=postgresql+psycopg://atlas:atlas@127.0.0.1:5432/atlas_test .venv/bin/alembic upgrade head

# contract regeneration (openapi.json is git-ignored; schema.d.ts is committed)
ATLAS_ENV=test SECRET_KEY=… SESSION_SECRET=… TOKEN_ENCRYPTION_KEY=… .venv/bin/python -c \
  "import json; from atlas.main import app; open('openapi.json','w').write(json.dumps(app.openapi()))"
cd apps/web && npm run gen:api              # delta = the 3 new paths + ProviderCredential* schemas

cd /home/kim/Documents/Atlas && ./scripts/verify.sh   # verification: PASS (backend 570; frontend 77)
```

**Files added.** `services/api/atlas/calendar/{__init__,crypto,tokens,errors,credentials}.py`,
`services/api/atlas/models/credential.py`, `services/api/atlas/api/calendar.py`,
`services/api/alembic/versions/c7d18e93a4f2_provider_credentials.py`,
`services/api/tests/unit/{test_token_crypto,test_credential_tokens,test_provider_credential_schema}.py`,
`services/api/tests/integration/{test_provider_credentials_api,test_provider_credentials_schema}.py`.
**Modified.** `services/api/atlas/models/__init__.py`, `services/api/atlas/api/{__init__,schemas}.py`,
`services/api/atlas/main.py` (router + credential `422` redaction), `services/api/atlas/config.py`
(`token_encryption_key_id`, `token_encryption_previous_keys`), `services/api/pyproject.toml`
(`cryptography`), `services/api/tests/conftest.py` (truncate list), `.env.example`,
`apps/web/src/api/schema.d.ts`.

**Limitations recorded, not waived.** No real Google/Microsoft OAuth exchange is exercised — the
adapters that would perform it are M5-03/M5-04 and M5-00 is `BLOCKED` (AR-001). The credential store
is verified with fakes; its **compatibility with real-provider tokens** (JWT/opaque shapes, real
scope strings) is unverified until then. `TOKEN_ENCRYPTION_KEY` becomes load-bearing (losing it makes
credentials unreadable) and must be backed up separately. Key rotation is *supported* (a key id per
row + a rotating key set) but no automatic re-encryption job exists yet. No connect/disconnect UI
(M5-05) or adapter (M5-02) is built. Browser E2E is `NOT RUN` (Playwright is not set up).

---

### M5-02 — Provider adapter interface

Verified 2026-10-27 on Linux with Python 3.14 and PostgreSQL in Docker (test database `atlas_test`;
the application `atlas` database was never touched). **No provider is contacted** — M5-00
(real-account validation) is `BLOCKED` (AR-001), so this task is built and tested with an in-memory
fake. **No API change** (no endpoint, no schema, so OpenAPI/`schema.d.ts` are untouched) and **no new
dependency** (no provider SDK).

| Acceptance criterion | Result | Evidence |
|---|---|---|
| A single provider-neutral adapter interface exists covering calendars, event listing with pagination and incremental cursors, and deletions/tombstones | `PASS` | `atlas/calendar/adapter.py::CalendarAdapter` (`list_calendars()`; `list_events(calendar_id, *, cursor, page_token, page_size)`; `provider`; `cursor_type`); `atlas/calendar/types.py` (`Calendar`, `Event`, `EventDeletion`, `EventPage`, `EventStatus`, `CursorType`) |
| A **provider-neutral event/page model** (id, calendar id, summary, start/end instants + IANA zone + all-day flag, recurrence id, status, etag/version, updated) | `PASS` | `tests/unit/test_calendar_adapter.py::test_neutral_event_carries_all_day_zone_recurrence_and_etag` (all-day, `time_zone`, `recurrence_id`, `recurrence_rule`, `etag`, `status`, `updated`); event validation (`test_neutral_event_rejects_naive_instants`, `test_neutral_event_rejects_an_end_before_the_start`) |
| No **provider SDK type** appears in the interface or the neutral model | `PASS` | `tests/unit/test_calendar_adapter.py::test_the_contract_modules_import_no_provider_sdk` — AST-scans `atlas/calendar/{adapter,types,fake}.py` for `google`/`msgraph`/`microsoft` imports (none) |
| A **fake adapter** implements the interface and is exercised by unit tests | `PASS` | `atlas/calendar/fake.py::FakeCalendarAdapter`; `test_fake_satisfies_the_adapter_contract` (`isinstance(fake, CalendarAdapter)`); `test_list_calendars_returns_seeded_calendars` |
| **Pagination** walks all events without gaps or duplicates | `PASS` | `test_paging_walks_every_event_without_gaps_or_duplicates` (5 events, `page_size=2`, one event each); `test_only_the_final_page_carries_the_durable_cursor` |
| **Incremental cursor** yields only changes since the cursor | `PASS` | `test_incremental_cursor_returns_only_changes_since_the_cursor` (create+update+delete → only those); `test_incremental_cursor_does_not_repeat_an_unchanged_event` |
| A change made **during a paging pass is never skipped** (cursor safety) | `PASS` | `test_a_change_made_during_paging_is_deferred_not_skipped` (the pass returns the revision it started at; the new event is picked up by the next pass) |
| **Deletions are surfaced** as tombstones | `PASS` | `test_deletions_are_surfaced_as_tombstones` (`EventDeletion` with id/calendar/provider/recurrence id) |
| A **registry/factory** selects an adapter by provider name; unknown provider → clear error | `PASS` | `atlas/calendar/adapter.py::AdapterRegistry`/`build_adapter`; `test_registry_returns_the_adapter_registered_for_a_provider`, `test_registry_rejects_an_unknown_provider` (`UnknownProviderError` naming the known providers), `test_an_empty_registry_rejects_every_provider`, `test_registry_canonicalises_provider_names`, `test_registry_refuses_to_silently_replace_a_registration`, `test_build_adapter_uses_an_explicit_registry` |
| The **error taxonomy** maps to the documented retry classes (auth-expired/reauth, rate-limited + retry-after, transient, permanent) | `PASS` | `atlas/calendar/errors.py` (`AuthExpiredError`=`reauth`, `RateLimitedError`=`retry_after`, `TransientProviderError`=`retry_backoff`, `PermanentProviderError`=`permanent`); `tests/unit/test_calendar_provider_errors.py` (`test_every_error_class_maps_to_one_of_the_documented_retry_classes`, `test_transient_errors_back_off_and_grow_with_attempts`, `test_rate_limited_honours_the_provider_retry_after`, `test_auth_expired_and_permanent_errors_are_never_retried`) |
| Unit tests added; **no existing test weakened or removed** | `PASS` | 38 new unit tests (`tests/unit/test_calendar_adapter.py`, `test_calendar_provider_errors.py`); existing suites unchanged (330 → 368 unit; 570 → 608 total) |
| `ruff` / `ruff format --check` / `mypy` / full suite / `verify.sh` | `PASS` | commands below |
| Real Google/Microsoft adapter (M5-03/M5-04) and sync/projection store (M5-06) | `NOT RUN` — out of scope | M5-00 is `BLOCKED` (AR-001); this task builds only the contract, neutral types, registry and fake |

**Commands run.**

```
cd services/api
.venv/bin/ruff check .                      # All checks passed!
.venv/bin/ruff format --check .             # 132 files already formatted
.venv/bin/mypy                              # Success: no issues found in 65 source files
.venv/bin/python -m pytest tests/unit -q    # 368 passed
TEST_DATABASE_URL=postgresql+psycopg://atlas:atlas@127.0.0.1:5432/atlas_test \
  .venv/bin/python -m pytest -q             # 608 passed

cd /home/kim/Documents/Atlas && ./scripts/verify.sh   # verification: PASS (backend 608; frontend 77)
```

**Files added.** `services/api/atlas/calendar/{types,adapter,fake}.py`,
`services/api/tests/unit/{test_calendar_adapter,test_calendar_provider_errors}.py`.
**Modified.** `services/api/atlas/calendar/{__init__,errors}.py`.

**Limitations recorded, not waived.** No real Google/Microsoft adapter exists yet (M5-03/M5-04) and no
provider is contacted, so the *contract* is verified with the fake only; its **compatibility with the
real provider APIs** (Google `syncToken`/`etag`, Graph `deltaLink`/`changeKey` shapes and the exact
HTTP status → error-class mapping) is unverified until M5-00 unblocks. The fake's cursor never expires;
real providers return a `410 Gone`/`400` for an invalid/expired sync token, which M5-03/M5-04 must map
to a full-resync path (the neutral `PermanentProviderError` is the current hook). The projection store
and cursor persistence are M5-06; no UI (M5-05/M5-07) is built.

---

### M5-06 — Event projection store + sync cursors

**Verified** 2026-10-27 against the M5-02 `FakeCalendarAdapter` and a real PostgreSQL (no provider
contacted; M5-00 is `BLOCKED` — AR-001). `DEPENDS ON` M5-02 (`DONE`), M1-08 (`DONE`).

| # | Acceptance criterion | Result | Evidence |
|---|---|---|---|
| 1 | A projection table persists provider events and a per-`(user, provider, calendar)` cursor table exists | `PASS` | `atlas/models/calendar.py` (`ExternalEvent`, `SyncCursor`); migration `9d2f4b6a1c37`; `tests/unit/test_calendar_projection_schema.py` |
| 2 | The projection is **unique per (user, provider, external event id)**; no duplicate projections | `PASS` | unique constraint `uq_external_events_user_provider_external_event_id`; `tests/integration/test_calendar_sync.py::test_re_sync_is_idempotent_with_no_duplicate_projections`; `tests/integration/test_calendar_projection_schema.py::test_a_projection_is_unique_per_user_provider_and_event` |
| 3 | The cursor **advances only after** the covered changes commit; a failure between apply and commit leaves it unchanged and a re-sync skips nothing | `PASS` | `atlas/calendar/sync.py::CalendarSyncService.sync_calendar` (apply + `_advance_cursor` + one `commit`, rollback on error); `test_a_failure_between_apply_and_commit_leaves_the_cursor_unchanged`; `test_a_fetch_failure_records_the_error_and_leaves_the_cursor_unchanged` |
| 4 | Incremental sync fetches **only changes since the cursor** | `PASS` | `test_incremental_sync_returns_only_changes_since_the_cursor` (`events_seen == 2`, `deletions_seen == 1`) |
| 5 | First sync (no cursor) establishes a **baseline** | `PASS` | `test_first_sync_establishes_a_baseline_and_records_the_cursor` (`cursor_before is None`, cursor persisted == adapter cursor) |
| 6 | A deletion is applied as a **tombstone**, never a hard delete of the user's data | `PASS` | `_apply` marks `deleted_at`; `test_a_deletion_becomes_a_tombstone_and_never_loses_the_row`, `test_a_tombstoned_event_is_revived_when_it_reappears` |
| 7 | A change during paging is **deferred, not skipped**; the cursor is persisted only from a final page | `PASS` | `test_cursor_advances_only_on_the_final_page_and_defers_a_mid_page_change` (cursor == start-of-pass revision; next pass applies the change) |
| 8 | Strict **user scoping** (projections and cursors) | `PASS` | every query filters `user_id`; `test_projections_and_cursors_are_strictly_user_scoped` |
| 9 | Migration **renders the schema, is reversible and matches the models** | `PASS` | offline render + reversibility in `tests/unit/test_calendar_projection_schema.py`; `tests/integration/test_calendar_projection_schema.py::test_migrations_match_models`; CLI upgrade/downgrade below |
| 10 | Pure apply/merge logic unit-tested | `PASS` | `tests/unit/test_calendar_projection.py` (10 tests over `projected_values`/`merge_event_row`/`event_is_unchanged`) |
| 11 | No existing test weakened or removed | `PASS` | unit 368 → **386**; full suite 608 → **642** (34 new: 18 unit + 16 integration) |
| 12 | `ruff` / `ruff format --check` / `mypy` / full suite / `verify.sh` | `PASS` | commands below |
| 13 | Real Google/Microsoft adapters (M5-03/M5-04), notifications (M5-09), reconciliation (M5-10), UI (M5-05/M5-07) | `NOT RUN` — out of scope | M5-00 is `BLOCKED` (AR-001) |

**Commands run.**

```
cd services/api
.venv/bin/ruff check .                       # All checks passed!
.venv/bin/ruff format --check .              # formatted
.venv/bin/mypy                               # Success: no issues found in 68 source files
.venv/bin/python -m pytest tests/unit -q     # 386 passed
TEST_DATABASE_URL=postgresql+psycopg://atlas:atlas@127.0.0.1:5432/atlas_test \
  .venv/bin/python -m pytest -q              # 642 passed
# migration on the test DB: downgrade base → upgrade head → downgrade -1 → upgrade head
DATABASE_URL=…atlas_test .venv/bin/python -c "…downgrade('base'); upgrade('head'); downgrade('-1'); upgrade('head')…"
#   base: None → head: 9d2f4b6a1c37 → -1: c7d18e93a4f2 → head: 9d2f4b6a1c37

cd /home/kim/Documents/Atlas && ./scripts/verify.sh   # verification: PASS (backend 642; frontend 77)
```

**Files added.** `services/api/atlas/models/calendar.py`, `services/api/atlas/calendar/projection.py`,
`services/api/atlas/calendar/sync.py`,
`services/api/alembic/versions/9d2f4b6a1c37_calendar_projections.py`,
`services/api/tests/unit/{test_calendar_projection,test_calendar_projection_schema}.py`,
`services/api/tests/integration/{test_calendar_sync,test_calendar_projection_schema}.py`.
**Modified.** `services/api/atlas/calendar/__init__.py`, `services/api/atlas/models/__init__.py`,
`services/api/tests/conftest.py` (truncate list).

**Limitations recorded, not waived.** The sync is verified against the deterministic fake and a real
database only; no provider is contacted, so real `syncToken`/`deltaLink` expiry semantics (a `410`/
`400` → full resync) and the exact provider field mapping remain unverified until M5-00 unblocks and
M5-03/M5-04 land. The cursor is persisted as an opaque string from the adapter's final page; the fake
never expires a cursor. No notifications/reconciliation (M5-09/M5-10) or UI (M5-05/M5-07) exist, and
there is no API surface for sync yet (M5-08 will surface the cursor's last success/error state).

---

### M5-08 — Sync status + error surface

**Verified** 2026-10-27 against the M5-02 `FakeCalendarAdapter` and a real PostgreSQL (no provider
contacted; M5-00 is `BLOCKED` — AR-001). `DEPENDS ON` M5-06 (`DONE`).

| # | Acceptance criterion | Result | Evidence |
|---|---|---|---|
| 1 | A typed, **user-scoped** sync-status read reports last success, state and last error per provider/calendar | `PASS` | `atlas/calendar/status.py::SyncStatusService` + `GET /api/calendar/sync-status`; `tests/integration/test_calendar_sync_status_api.py::test_status_reflects_a_successful_sync`, `test_a_connected_provider_without_a_sync_is_never_synced` |
| 2 | The status is **derived from the M5-06 cursor rows** — no parallel source of truth | `PASS` | `classify_cursor`/`rollup_provider` are pure functions of `sync_cursors`; no new table/column; `tests/unit/test_calendar_status.py` (9 tests) |
| 3 | Errors surfaced with a **safe message**; never token material, ciphertext or a raw cursor value | `PASS` | `test_error_state_records_a_safe_message_and_leaks_no_secret` (asserts `ACCESS`/`REFRESH`/`ciphertext`/`rev:` absent); responses carry counts + the bounded M5-06 message (ADR-0030) |
| 4 | Empty state before anything is connected | `PASS` | `test_status_is_empty_before_anything_is_connected` (`{"providers": []}`) |
| 5 | A successful sync sets `last_success_at` and `state == idle`, `cursor_health == ok` | `PASS` | `test_status_reflects_a_successful_sync` |
| 6 | A **user-scoped, idempotent** manual trigger over the registry/fake seam | `PASS` | `ProviderSyncService` + `POST /api/calendar/providers/{provider}/sync`; `test_manual_sync_is_idempotent` (re-baseline → `created == 0`, one projection) |
| 7 | Strict user scoping of the read | `PASS` | `test_status_is_strictly_user_scoped` (another user's cursor invisible; both rows exist) |
| 8 | Boundary validation with no side effects | `PASS` | unknown provider `422`; unconnected provider `409`; no adapter built `503`; `test_manual_sync_rejects_an_unknown_provider`, `test_manual_sync_without_a_connection_is_a_conflict`, `test_manual_sync_without_an_adapter_is_unavailable` |
| 9 | Auth + CSRF enforced | `PASS` | `test_status_and_trigger_require_authentication` (401), `test_trigger_requires_csrf` (403) |
| 10 | Frontend surface renders status/last-sync with loading/empty/error + a retry affordance | `PASS` | `components/SyncStatus.tsx` + `components/SyncStatus.test.tsx` (7), `pages/Calendar.test.tsx` (5), `lib/syncStatus.test.ts` (10) |
| 11 | OpenAPI + `schema.d.ts` regenerated and in sync | `PASS` | `services/api/openapi.json` re-exported; `cd apps/web && npm run gen:api` (idempotent) |
| 12 | No existing test weakened or removed | `PASS` | unit 386 → **395**; full suite 642 → **662** (20 new: 9 unit + 11 integration); frontend 77 → **101** |
| 13 | `ruff` / `ruff format --check` / `mypy` / full suite / `verify.sh` | `PASS` | commands below |
| 14 | Browser E2E (Playwright) for the surface | `NOT RUN` | Playwright is not set up in this repository (as recorded for M3-07/M4-03/M4-06) |
| 15 | Real Google/Microsoft adapters (M5-03/M5-04), event views (M5-05/M5-07), notifications/reconciliation (M5-09/M5-10) | `NOT RUN` — out of scope | M5-00 is `BLOCKED` (AR-001) |

**Commands run.**

```
cd services/api
.venv/bin/ruff check .                       # All checks passed!
.venv/bin/ruff format --check .              # 69 files already formatted
.venv/bin/mypy                               # Success: no issues found in 69 source files
.venv/bin/python -m pytest tests/unit -q     # 395 passed
TEST_DATABASE_URL=postgresql+psycopg://atlas:atlas@127.0.0.1:5432/atlas_test \
  .venv/bin/python -m pytest -q              # 662 passed

# OpenAPI snapshot + generated TS types
.venv/bin/python -c "import json; from atlas.main import app; open('openapi.json','w').write(json.dumps(app.openapi()))"
cd ../apps/web && npm run gen:api            # schema.d.ts regenerated (idempotent)

cd /home/kim/Documents/Atlas/apps/web
npm run lint && npm run typecheck && npm run test && npm run build   # 101 vitest passed; build clean

cd /home/kim/Documents/Atlas && ./scripts/verify.sh   # verification: PASS (backend 662; frontend 101)
```

**Files added.** `services/api/atlas/calendar/status.py`,
`services/api/tests/unit/test_calendar_status.py`,
`services/api/tests/integration/test_calendar_sync_status_api.py`,
`apps/web/src/pages/Calendar.tsx`, `apps/web/src/pages/Calendar.test.tsx`,
`apps/web/src/components/SyncStatus.tsx`, `apps/web/src/components/SyncStatus.test.tsx`,
`apps/web/src/hooks/useSyncStatus.ts`, `apps/web/src/lib/syncStatus.ts`,
`apps/web/src/lib/syncStatus.test.ts`, `apps/web/src/test/calendar.ts`.
**Modified.** `services/api/atlas/calendar/__init__.py`, `services/api/atlas/api/calendar.py`,
`services/api/atlas/api/schemas.py`, `services/api/openapi.json`,
`apps/web/src/{App.tsx,api/client.ts,api/client.test.ts,styles.css}`, `apps/web/src/api/schema.d.ts`.

**Limitations recorded, not waived.** The status is derived from real M5-06 outcomes but exercised
only against the fake and a real database; no provider is contacted, so real error classification
(HTTP status → `ProviderError`) is still unverified until M5-00 unblocks and M5-03/M5-04 land. A
durable `in_progress` state is deliberately not reported (a synchronous sync persists no running
flag); it arrives with the scheduled/reconciled sync (M5-10). The `/calendar` route is a status
surface only — the day/week/month event views are M5-05/M5-07 and remain `BACKLOG`. Browser E2E is
`NOT RUN`.

---

### M5-10 — Periodic reconciliation fallback

**Verified** 2026-10-27 against the M5-02 `FakeCalendarAdapter`, the M5-06 sync service and a real
PostgreSQL (no provider contacted; M5-00 is `BLOCKED` — AR-001). `DEPENDS ON` M5-06 (`DONE`). The
implementing run stopped at its turn limit after the code and verification were complete; the
supervising pass re-ran the checks below and recorded this section.

| # | Acceptance criterion | Result | Evidence |
|---|---|---|---|
| 1 | A durable, scheduled scan re-syncs each due calendar from its stored cursor and recovers a change no notification delivered | `PASS` | `atlas/calendar/reconcile.py` (`CalendarReconciliationService.scan`); `tests/integration/test_calendar_reconcile.py::test_a_scan_recovers_a_change_no_notification_delivered` |
| 2 | A missed **deletion** is recovered too (tombstone) | `PASS` | `test_a_scan_recovers_a_deletion_no_notification_delivered` |
| 3 | The scan is idempotent (no duplicate projections) | `PASS` | `test_a_scan_is_idempotent_and_never_duplicates` |
| 4 | Restart-safe: a run is a durable job that survives a worker restart; an interrupted run is recovered, not lost or duplicated | `PASS` | `atlas/jobs/handlers.py` (`calendar_scan`) + `atlas/jobs/worker.py` (`ensure_recurring_jobs`); `test_the_worker_processes_the_calendar_scan_and_reschedules_it`, `test_a_stale_marker_makes_the_calendar_due_so_an_interrupted_run_recovers`, `test_ensure_reaps_a_stale_running_scan_and_schedules_a_fresh_one` |
| 5 | A durable `in_progress` marker exists and the M5-08 status reports it truthfully (derived, not invented) | `PASS` | `sync_cursors.sync_started_at` (migration `b7c2e1a9f4d0`); `begin_sync_run`/`end_sync_run`; `test_the_running_marker_is_set_then_cleared_and_the_status_reports_in_progress`; `test_classify_cursor_reports_in_progress_when_a_run_is_underway` |
| 6 | A **stale** marker is not reported as in_progress (a crashed run cannot lie) and makes the calendar due | `PASS` | `marker_is_active` + `test_a_stale_marker_is_not_active_so_a_crashed_run_cannot_lie`, `test_a_stale_marker_is_not_reported_as_in_progress`, `test_a_stale_marker_makes_the_calendar_due_so_the_run_is_recovered` |
| 7 | The M5-06 cursor rule is preserved (cursor advances only after commit; a failing scan leaves it unchanged) | `PASS` | `test_a_failing_scan_leaves_the_cursor_unchanged_and_clears_the_marker` (plus the M5-06 suite) |
| 8 | Notifications are never trusted as a full log; the scan is safe to run at any time | `PASS` | the scan only triggers a pass from the stored cursor (`reconcile.py` docstring; ADR-0031) |
| 9 | Isolation: one calendar's failure / an unavailable provider never aborts the scan; strict user scoping | `PASS` | `test_a_scan_without_an_adapter_is_a_harmless_no_op`, `test_a_scan_with_nothing_connected_does_nothing`, `test_a_scan_is_strictly_user_scoped` |
| 10 | Migration renders the schema, is reversible and matches the models | `PASS` | `b7c2e1a9f4d0` (adds `sync_cursors.sync_started_at`); downgrade drops it; `test_migrations_match_models` green |
| 11 | Unit + integration tests added; no existing test weakened or removed | `PASS` | 32 new tests (`test_calendar_reconcile.py` unit + integration); full suite 662 → **695** |
| 12 | `ruff` / `ruff format --check` / `mypy` / full suite / `verify.sh`; OpenAPI + `schema.d.ts` in sync | `PASS` | commands below; `npm run gen:api` re-run is byte-identical |
| 13 | Real Google/Microsoft adapters (M5-03/M5-04), notifications (M5-09), views (M5-05/M5-07) | `NOT RUN` — out of scope | M5-00 is `BLOCKED` (AR-001) |
| 14 | Browser E2E (Playwright) | `NOT RUN` | not set up in this repository |

**Commands run.**

```
cd services/api
.venv/bin/ruff check . && .venv/bin/ruff format --check . && .venv/bin/mypy   # clean
.venv/bin/python -m pytest tests/unit -q                                     # 408 passed
TEST_DATABASE_URL=postgresql+psycopg://atlas:atlas@127.0.0.1:5432/atlas_test \
  .venv/bin/python -m pytest tests/unit/test_calendar_reconcile.py \
    tests/integration/test_calendar_reconcile.py -q                           # 32 passed
TEST_DATABASE_URL=…/atlas_test .venv/bin/python -m pytest -q                  # 695 passed

# contract: regenerate OpenAPI + TS types; gen:api re-run is byte-identical (in sync)
cd apps/web && npm run gen:api

cd /home/kim/Documents/Atlas && ./scripts/verify.sh   # verification: PASS (backend 695; frontend 101)
```

**Files added.** `services/api/atlas/calendar/reconcile.py`,
`services/api/alembic/versions/b7c2e1a9f4d0_calendar_sync_running_marker.py`,
`tests/unit/test_calendar_reconcile.py`, `tests/integration/test_calendar_reconcile.py`.
**Modified.** `atlas/jobs/{handlers,worker}.py`, `atlas/config.py` (`calendar_reconcile_seconds`,
`calendar_sync_stale_seconds`), `atlas/calendar/{__init__,status}.py`, `apps/web/src/api/schema.d.ts`.

**Limitations recorded, not waived.** Exercised against the fake + a real database only; real
provider reconciliation (M5-03/M5-04) and notification-driven scans (M5-09) remain unverified until
M5-00 (AR-001) unblocks. The scan is best-effort per calendar; a persistent provider outage is retried
on each interval rather than backed off per-account. Browser E2E is `NOT RUN`.

---

## M7 — Cross-Device Synchronisation and Offline Support

### M7-01 — Per-user change feed endpoint

**Verified** 2026-10-27 against PostgreSQL 18 (`atlas_test`). `DEPENDS ON` M3-09 (`DONE`). The
implementing run stopped at its turn limit after the code and its tests were complete; the supervising
pass re-ran the checks below, regenerated the API contract, and recorded this section.

| # | Acceptance criterion | Result | Evidence |
|---|---|---|---|
| 1 | A single per-user change feed returns changes after a cursor across entity types (tasks, projects, notes metadata, note↔project links) | `PASS` | `GET /api/changes` (`atlas/api/changes.py`, `atlas/changes/service.py`); `ChangeEntityType`; `tests/integration/test_changes_api.py` |
| 2 | Ordered by a documented **monotonic** per-user cursor | `PASS` | `change_log.seq` allocated from `users.change_seq` in the mutation's transaction (ADR-0032); `tests/unit/test_change_feed.py` |
| 3 | Deletions appear as tombstones (`delete` operation) | `PASS` | `ChangeRecorder` records `delete`; `test_changes_api.py` |
| 4 | Paging is gap- and duplicate-free; a twice-changed entity appears once at its latest cursor | `PASS` | `plan_change_page`, `merge_latest`; `test_change_feed.py`, `test_changes_api.py` |
| 5 | Strict user scoping; invalid `since`/`limit` → `422` with no side effects; read-only | `PASS` | `parse_since` (0…2^63−1), `parse_limit` (1…500); `test_changes_api.py` |
| 6 | Cursor model documented; migration reversible and matching the models | `PASS` | ADR-0032; `d4e8b2c6f913`; `tests/unit/test_change_log_schema.py`, `test_change_schema.py` |
| 7 | Integration + unit tests added; no existing test weakened or removed | `PASS` | 34 change unit tests + 21 integration; full suite 695 → **750** |
| 8 | `ruff`/`ruff format --check`/`mypy`/full suite/`verify.sh`; OpenAPI + `schema.d.ts` in sync | `PASS` | commands below; `npm run gen:api` re-run byte-identical |
| 9 | Client offline queue/UI (M7-03/04/05), retention window (M7-02) | `NOT RUN` — out of scope | follow-on tasks |

**Commands run.**

```
cd services/api
.venv/bin/ruff check . && .venv/bin/ruff format --check . && .venv/bin/mypy   # clean
.venv/bin/python -m pytest tests/unit -q                                     # 447 passed
TEST_DATABASE_URL=postgresql+psycopg://atlas:atlas@127.0.0.1:5432/atlas_test \
  .venv/bin/python -m pytest -q                                              # 750 passed
TEST_DATABASE_URL=…/atlas_test .venv/bin/python -m pytest \
  tests/unit/test_change_feed.py tests/unit/test_change_schema.py -q         # 34 passed
TEST_DATABASE_URL=…/atlas_test .venv/bin/python -m pytest \
  tests/integration/test_changes_api.py tests/integration/test_change_log_schema.py -q   # 21 passed

# contract: regenerate OpenAPI + TS types; gen:api re-run is byte-identical (in sync)
cd apps/web && npm run gen:api

cd /home/kim/Documents/Atlas && ./scripts/verify.sh   # verification: PASS (backend 750; frontend 101)
```

**Files added.** `atlas/changes/{__init__,feed,record,service}.py`, `atlas/models/change.py`,
`atlas/api/changes.py`, `alembic/versions/d4e8b2c6f913_change_log.py`,
`tests/unit/test_change_feed.py`, `tests/unit/test_change_schema.py`,
`tests/integration/test_changes_api.py`, `tests/integration/test_change_log_schema.py`.
**Modified.** `atlas/models/{user,task,__init__}.py`, `atlas/{tasks,projects,notes}/service.py`
(record changes), `atlas/api/{__init__,tasks,notes,schemas}.py`, `atlas/main.py`, `atlas/config.py`,
`tests/conftest.py`, `apps/web/src/api/schema.d.ts`.

**Limitations recorded, not waived.** The feed carries entity **metadata**, not note content (notes
are files; content sync is the client's job via the notes API). `task_note_link` is a reserved entity
type with no mutation endpoint yet. Tombstones are currently retained indefinitely (the M7-02 retention
window is the follow-up). No client consumes the feed until M7-03/M7-04.

---

### M7-02 — Tombstones + retention window

**Verified** 2026-10-27 against PostgreSQL 18 (`atlas_test`). `DEPENDS ON` M7-01 (`DONE`).

| # | Acceptance criterion | Result | Evidence |
|---|---|---|---|
| 1 | A configurable retention window bounds the change-feed history | `PASS` | `change_retention_days` (default 30 days) + purge settings in `atlas/config.py`; `retention_cutoff` in `atlas/changes/retention.py`; `tests/unit/test_change_retention.py` |
| 2 | A durable, restart-safe, re-scheduled purge job on the existing queue | `PASS` | `changes.purge` handler + `ensure_change_purge_job`/`schedule_next_change_purge` (`atlas/jobs/handlers.py`); `test_change_purge.py::test_the_purge_job_runs_on_the_queue_and_reschedules`, `::test_a_stale_running_purge_is_reaped_and_restarted` |
| 3 | The purge is idempotent and removes **only** old change-log rows — never user entity rows | `PASS` | `ChangePurgeService` deletes only `change_log`; `test_change_purge.py::test_the_purge_removes_only_old_change_rows_never_entity_rows` (tasks intact; second pass removes nothing) |
| 4 | A delete is visible while within retention; a deleted entity is never reported as live | `PASS` | `test_change_purge.py::test_a_delete_is_visible_within_retention_and_the_purge_keeps_it`, `::test_a_purged_deletion_is_never_reported_as_live` (entity stays a tombstone; absent from `GET /api/tasks`) |
| 5 | A cursor that predates the purge floor gets a clear resync signal, not a partial feed | `PASS` | `resync_required` in `ChangeSet`/`ChangesOut`; `since < floor` branch in `ChangesService`; `test_change_purge.py::test_a_cursor_that_predates_the_floor_gets_resync_required` |
| 6 | Strict user scoping; boundary validation with no side effects | `PASS` | `test_change_purge.py::test_the_purge_floor_is_strictly_user_scoped`; M7-01 boundary tests unchanged |
| 7 | Unit + integration tests added; no existing test weakened or removed | `PASS` | 9 new unit + 7 new integration; full suite 750 → **766** |
| 8 | Migration reversible and matching the models | `PASS` | `c1a2b3d4e5f6` (`users.change_purge_floor` + `ix_change_log_changed_at`); `test_change_log_schema.py::test_migrations_match_models`; explicit upgrade/downgrade/upgrade on `atlas_test` |
| 9 | Response stays backward compatible | `PASS` | `resync_required` defaults to `false`; existing `test_changes_api.py` assertions unchanged |
| 10 | `ruff`/`ruff format --check`/`mypy`/full suite/`verify.sh`; OpenAPI + `schema.d.ts` in sync | `PASS` | commands below; `npm run gen:api` re-run |
| 11 | Client offline queue/UI (M7-03/04/05), failure-mode suite (M7-06) | `NOT RUN` — out of scope | follow-on tasks |

**Commands run.**

```
cd services/api
.venv/bin/ruff check . && .venv/bin/ruff format --check . && .venv/bin/mypy   # clean
.venv/bin/python -m pytest tests/unit -q                                     # 456 passed
TEST_DATABASE_URL=postgresql+psycopg://atlas:atlas@127.0.0.1:5432/atlas_test \
  .venv/bin/python -m pytest -q                                              # 766 passed
TEST_DATABASE_URL=…/atlas_test .venv/bin/python -m pytest \
  tests/unit/test_change_retention.py -q                                     # 9 passed
TEST_DATABASE_URL=…/atlas_test .venv/bin/python -m pytest \
  tests/integration/test_change_purge.py -q                                  # 7 passed

# migration on a real DB (atlas_test), reversible
DATABASE_URL=postgresql+psycopg://atlas:atlas@127.0.0.1:5432/atlas_test \
  .venv/bin/alembic current        # c1a2b3d4e5f6 (head)
DATABASE_URL=…/atlas_test .venv/bin/alembic upgrade head
DATABASE_URL=…/atlas_test .venv/bin/alembic downgrade -1    # c1a2b3d4e5f6 -> d4e8b2c6f913
DATABASE_URL=…/atlas_test .venv/bin/alembic upgrade head    # d4e8b2c6f913 -> c1a2b3d4e5f6

# contract: regenerate OpenAPI + TS types
cd apps/web && npm run gen:api

cd /home/kim/Documents/Atlas && ./scripts/verify.sh   # verification: PASS (backend 766; frontend 101)
```

**Files added.** `atlas/changes/{retention,purge}.py`,
`alembic/versions/c1a2b3d4e5f6_change_retention.py`, `tests/unit/test_change_retention.py`,
`tests/integration/test_change_purge.py`.
**Modified.** `atlas/changes/{__init__,feed,service}.py` (`ChangeSet.resync_required`, resync branch),
`atlas/api/{changes,schemas}.py`, `atlas/models/{user,change}.py`, `atlas/config.py`,
`atlas/jobs/{handlers,__init__}.py`, `apps/web/src/api/schema.d.ts`.

**Limitations recorded, not waived.** The purge deletes the aged `change_log` rows in one statement per
run (no batching); for very large installations a chunked delete would bound the transaction — deferred,
not needed at current scale. The M3-09 task pull (`GET /api/tasks/changes`) is derived from task rows
and is **not** bounded by this retention (its tombstones live in the task rows, which are never purged).
No client yet consumes `resync_required` — the M7-03/M7-04 client work is the follow-on.

---

### M7-03 — Client offline queue (durable)

**Verified** 2026-10-27 (frontend; no backend change). `DEPENDS ON` M7-01 (`DONE`). All checks below
were run on the working tree; browser E2E is not set up in this repository, so that criterion is
`NOT RUN`.

| # | Acceptance criterion | Result | Evidence |
|---|---|---|---|
| 1 | A durable client queue persists pending mutations (entity type/id, mutation, idempotency key, `base_revision`) in browser storage | `PASS` | `apps/web/src/lib/offlineQueue.ts` (`OfflineQueue`, `QueuedOperation`, versioned blob); `lib/offlineQueue.test.ts::OfflineQueue.enqueue` |
| 2 | Storage is IndexedDB-preferred with a documented fallback and a versioned format | `PASS` | `apps/web/src/lib/queueStorage.ts` (`IndexedDbStore` → `LocalStorageStore` → `MemoryStore`); ADR-0034; `lib/queueStorage.test.ts`; `offlineQueue.test.ts` (unknown version discarded) |
| 3 | The queue survives a reload (re-instantiated from the same backing storage, not just in-memory) | `PASS` | `offlineQueue.test.ts::survives re-instantiation from the same backing storage`, `::survives a reload (a fresh queue over the same localStorage)`; `queueStorage.test.ts::persists across re-instantiation over the same database` |
| 4 | Queued ops replay in FIFO order through the existing API | `PASS` | `lib/syncEngine.ts::flushQueue`; `syncEngine.test.ts::replays queued operations in FIFO order` |
| 5 | Each replay sends `Idempotency-Key` **and** `base_revision`; retrying never duplicates | `PASS` | `syncEngine.ts::sendOperation`; `api/client.ts` idempotency header; `syncEngine.test.ts::sends an update as PATCH with the idempotency key and base_revision`, `::does not duplicate an operation on retry (the idempotency key is stable)`; `api/client.test.ts::apiFetch idempotency` |
| 6 | A stale `409` is surfaced and the operation **kept** — never silently clobbered | `PASS` | `syncEngine.ts::flushQueue` (409 branch → `markConflict`, stop); `syncEngine.test.ts::surfaces a stale 409 and keeps the operation (never clobbers)`; `offlineQueue.test.ts::keeps a conflicted operation and records the server revision` |
| 7 | The engine pulls via `GET /api/changes` from a stored cursor, advancing it only after a page is applied | `PASS` | `syncEngine.ts::pullChanges`; `api/client.ts::changesApi`; `syncEngine.test.ts::pages from the stored cursor and advances it only after each page is applied`, `::does not advance the cursor when applying a page fails` |
| 8 | `resync_required` triggers a full resync (cursor predates the retention floor) | `PASS` | `syncEngine.ts::pullChanges` (resync branch → `fullResync`, cursor ← `next_since`); `syncEngine.test.ts::triggers a full resync when the cursor predates the retention floor` |
| 9 | A minimal queue-status surface (pending/conflict/failed counts + state) exists; business logic in `lib`/`hooks`, not components; light/dark + keyboard | `PASS` | `components/OfflineQueueStatus.tsx`, `hooks/useOfflineQueue.ts`, `lib/queueStatus.ts`, `pages/Sync.tsx`, route `/sync`; `OfflineQueueStatus.test.tsx` (9), `Sync.test.tsx` (2), `useOfflineQueue.test.tsx` (2); theme variables in `styles.css` |
| 10 | Unit + component tests added; no existing test weakened, skipped or removed | `PASS` | 54 new frontend tests; baseline 101 → **155**; the pre-existing 101 unchanged and green |
| 11 | `lint`/`typecheck`/`test`/`build`; backend gates; `./scripts/verify.sh` | `PASS` | commands below |
| 12 | Browser E2E (Playwright) | `NOT RUN` — Playwright is not set up in this repository | — |
| 13 | Backend / OpenAPI changes | `NONE` — no backend file touched, `schema.d.ts` unchanged (the change feed already existed) | `git status`; `npm run gen:api` not required |

**Commands run.**

```
# frontend gates
cd apps/web
npm run lint          # clean
npm run typecheck     # tsc --noEmit, clean
npm run test          # vitest run — 27 files, 155 passed (101 → 155)
npm run build         # tsc --noEmit && vite build, clean

# backend gates (unchanged, re-run for the record)
cd services/api
.venv/bin/ruff check . && .venv/bin/ruff format --check . && .venv/bin/mypy   # clean (163 files formatted; mypy 78 files)
.venv/bin/python -m pytest tests/unit -q                                     # 456 passed
TEST_DATABASE_URL=postgresql+psycopg://atlas:atlas@127.0.0.1:5432/atlas_test \
  .venv/bin/python -m pytest -q                                              # 766 passed

cd /home/kim/Documents/Atlas && ./scripts/verify.sh   # verification: PASS (backend 766; frontend 155)
```

**Files added.** `apps/web/src/lib/{queueStorage,offlineQueue,syncEngine,queueStatus}.ts`,
`apps/web/src/hooks/useOfflineQueue.ts`, `apps/web/src/components/OfflineQueueStatus.tsx`,
`apps/web/src/pages/Sync.tsx`, `apps/web/src/test/offline.ts`, and the tests
`apps/web/src/lib/{queueStorage,offlineQueue,syncEngine,queueStatus}.test.ts`,
`apps/web/src/hooks/useOfflineQueue.test.tsx`, `apps/web/src/components/OfflineQueueStatus.test.tsx`,
`apps/web/src/pages/Sync.test.tsx`.
**Modified.** `apps/web/src/api/client.ts` (`changesApi`, `Idempotency-Key`, exported `apiFetch`),
`apps/web/src/api/client.test.ts`, `apps/web/src/App.tsx` (route), `apps/web/src/components/Layout.tsx`
(nav), `apps/web/src/styles.css`, `apps/web/package.json` (+`package-lock.json`, test-only
`fake-indexeddb`).

**Limitations recorded, not waived.** M7-03 delivers the durable queue, the replay/pull engine and a
minimal status surface only: the **full reconnect reconciliation matrix** (M7-04) — applying pulled
changes to a local cache, resolving a surfaced conflict, draining on an `online`/focus event — and the
**full sync-status UI** (M7-05) are follow-on tasks. `flushQueue` stops at the first conflict to
preserve FIFO order; a conflict is currently surfaced but has no resolution action yet. The queue is a
client cache, never authoritative (`ARCHITECTURE.md` §5). Browser E2E is `NOT RUN`.

---

### M7-04 — Reconnect reconciliation

**Verified** 2026-10-27 (frontend; no backend change). `DEPENDS ON` M7-03 (`DONE`). All checks below were
run on the working tree; browser E2E is not set up in this repository, so that criterion is `NOT RUN`.

| # | Acceptance criterion | Result | Evidence |
|---|---|---|---|
| 1 | A reconciliation pass is triggered on `online`/focus and by a manual action; business logic lives in `lib`/`hooks`, not components | `PASS` | `apps/web/src/lib/reconciliation.ts` (`reconcile`, `Reconciler`); `hooks/useReconciliation.ts` (listeners + manual `reconcile`); `hooks/useReconciliation.test.tsx` (mount, `online`, `focus`, manual) |
| 2 | A pass **flushes** the durable queue (M7-03 replay) **then** **pulls** missed changes (`GET /api/changes`) from the stored cursor | `PASS` | `reconciliation.ts::reconcile` (steps 2/4); `lib/reconciliation.test.ts::replays the durable queue (flush) before pulling the change feed` |
| 3 | Pulled changes are applied to a **local cache**; the client is eventually consistent | `PASS` | `lib/localCache.ts` (`LocalCache.applyChanges`, tombstones, cursor never regresses); `reconciliation.test.ts`; `localCache.test.ts` |
| 4 | A stale `base_revision` (`409`) is a **conflict**: the local change is kept, the server never clobbered, the edit never silently dropped | `PASS` | `reconciliation.ts` (flush outcome → `markLocalState`, conflict kept); `reconciliation.test.ts::surfaces a stale 409, keeps the local change and never clobbers the server`; `applies a server change to the cache while keeping a queued local edit` |
| 5 | The conflicting entity is **surfaced** to the UI | `PASS` | `components/ConflictNotice.tsx` + `lib/reconciliation.ts` label helpers; `components/ConflictNotice.test.tsx` (5), `pages/Sync.test.tsx::surfaces a reconciliation conflict` |
| 6 | The conflict policy is defined and documented (keep-local + surface; manual resolution is M7-05) | `PASS` | ADR-0035; `PRODUCT_SPEC.md` §5.5; this section |
| 7 | `resync_required` triggers a full resync and resumes from the returned head | `PASS` | `reconciliation.ts::reconcile` (`fullResync` clears + re-applies local state, cursor ← `next_since`); `reconciliation.test.ts::drops the cache and resumes from the head, keeping the queued local edit` |
| 8 | Reconciling is **idempotent** — re-running does not duplicate effects | `PASS` | `reconciliation.test.ts::is idempotent: a second pass sends and applies nothing new`; `retries a network failure on the next pass without duplicating the change` (same `Idempotency-Key`); `localCache.test.ts::is idempotent: re-applying a page (or an older one) changes nothing` |
| 9 | Durability across reload holds | `PASS` | `localCache.test.ts::survives re-instantiation from the same backing storage`; `reconciliation.test.ts::keeps the queue, cursor and cache across a reload and still converges` |
| 10 | Light/dark + keyboard where UI is added | `PASS` | `components/ConflictNotice.tsx` (focusable `Retry sync`, `aria-busy`, explicit states); theme variables in `styles.css` (`.conflict-notice`); `ConflictNotice.test.tsx` |
| 11 | No heavy sync framework; no new dependency added | `PASS` | built on the M7-03 `lib`/`hooks`; no `package.json` change; ADR-0035 §"No new dependency" |
| 12 | Unit + component tests added; no existing test weakened, skipped or removed | `PASS` | 28 new frontend tests; baseline 155 → **183**; the pre-existing 155 unchanged and green (the two `Sync.test.tsx` cases kept) |
| 13 | `lint`/`typecheck`/`test`/`build`; backend gates; `./scripts/verify.sh` | `PASS` | commands below |
| 14 | Browser E2E (Playwright) | `NOT RUN` — Playwright is not set up in this repository | — |
| 15 | Backend / OpenAPI changes | `NONE` — no backend file touched, `schema.d.ts` unchanged (the change feed already existed) | `git status` |

**Commands run.**

```
# frontend gates
cd apps/web
npm run lint          # clean
npm run typecheck     # tsc --noEmit, clean
npm run test          # vitest run — 31 files, 183 passed (155 → 183)
npm run build         # tsc --noEmit && vite build, clean

# backend gates (unchanged, re-run for the record)
cd services/api
.venv/bin/ruff check . && .venv/bin/ruff format --check . && .venv/bin/mypy   # clean (163 files formatted; mypy 78 files)
.venv/bin/python -m pytest tests/unit -q                                     # 456 passed
TEST_DATABASE_URL=postgresql+psycopg://atlas:atlas@127.0.0.1:5432/atlas_test \
  .venv/bin/python -m pytest -q                                              # 766 passed

cd /home/kim/Documents/Atlas && ./scripts/verify.sh   # verification: PASS (backend 766; frontend 183)
```

**Files added.** `apps/web/src/lib/localCache.ts`, `apps/web/src/lib/reconciliation.ts`,
`apps/web/src/hooks/useReconciliation.ts`, `apps/web/src/components/ConflictNotice.tsx`, and the tests
`apps/web/src/lib/{localCache,reconciliation}.test.ts`,
`apps/web/src/hooks/useReconciliation.test.tsx`, `apps/web/src/components/ConflictNotice.test.tsx`.
**Modified.** `apps/web/src/pages/Sync.tsx` (renders the conflict surface and runs a full pass on the
manual action), `apps/web/src/pages/Sync.test.tsx` (+1 case, mocks the new hook), `apps/web/src/test/offline.ts`
(`makeCacheEntry`), `apps/web/src/styles.css` (conflict-surface styles).

**Limitations recorded, not waived.** This is the reconciliation pass and a **minimal** conflict
surface only: the **full sync-status UI** (M7-05) — the pending/failed/conflicts panel and manual
conflict **resolution** — and the **failure-mode E2E suite** (M7-06) are follow-on tasks. A conflict has
no resolution action yet; it is kept and surfaced. The local cache stores *change metadata* (which
entity changed, its cursor, tombstone status and the client's own pending/conflict flags), **not entity
payloads** — the M7-01 feed carries none, so a consumer that wants a body fetches it from the ordinary
endpoint. A full resync drops the metadata cache and resumes from the server's head; it does not re-fetch
every entity body. Reconciliation is client-driven (no push); it runs on `online`/`focus`/manual. The
cache is a client cache, never authoritative (`ARCHITECTURE.md` §5). Browser E2E is `NOT RUN`.

---

### M7-05 — Sync status UI (+ manual conflict resolution)

**Verified** 2026-10-27 (frontend; no backend change). `DEPENDS ON` M7-01 (`DONE`) and builds on M7-03/M7-04
(`DONE`). All checks below were run on the working tree; browser E2E is not set up in this repository,
so that criterion is `NOT RUN`.

| # | Acceptance criterion | Result | Evidence |
|---|---|---|---|
| 1 | A **sync-status panel** shows **pending / failed / conflict** counts and a clear **overall state** (up to date / syncing / offline / error / conflicts) | `PASS` | `components/SyncStatusPanel.tsx`; overall rule `lib/queueStatus.ts::overallSyncState`; `components/SyncStatusPanel.test.tsx` (8: empty/pending/failed/conflicts/offline/load-error/resolve-error/busy); `lib/queueStatus.test.ts::overallSyncState` (6) |
| 2 | Conflicts are surfaced with a **per-entity resolution action**; **"keep mine"** re-queues the local op with the **server's current revision** as the new `base_revision` so the next flush succeeds | `PASS` | `lib/conflictResolution.ts::resolveConflict`; `OfflineQueue.rebase` (`lib/offlineQueue.ts`); `lib/conflictResolution.test.ts::re-queues the local edit against the server's revision and clears the conflict` / `unblocks the next flush: the rebased operation is accepted`; `lib/offlineQueue.test.ts` (rebase cases) |
| 3 | **"keep mine"** never loses the edit: the queued payload is untouched, and an unknown server revision re-queues unchanged (no unchecked write) | `PASS` | `conflictResolution.test.ts::keeps the original base revision when the server revision is unknown`; `offlineQueue.test.ts` (payload preserved) |
| 4 | **"take server"** discards the local op and adopts the server's state (local-pending/conflict flags cleared) | `PASS` | `conflictResolution.test.ts::discards the local edit and adopts the server state`; `hooks/useConflictResolution.test.tsx` |
| 5 | Resolving is **idempotent** | `PASS` | `conflictResolution.test.ts::is idempotent: resolving an already-resolved conflict twice is a no-op` and `…for take-server as well`; `localCache.test.ts` (`markLocalState` is stable to re-run); `offlineQueue.test.ts` (rebase is a no-op on `pending`) |
| 6 | Resolution **re-uses the existing queue/cache/reconciliation primitives** (no duplicated logic) | `PASS` | `resolveConflict` calls `OfflineQueue.{list,remove,rebase}` and `LocalCache.markLocalState`; the panel composes `OfflineQueueStatus`/`ConflictNotice` and reads `useOfflineQueue`/`useReconciliation` |
| 7 | Business logic stays out of components (in `lib`/hooks) | `PASS` | `lib/conflictResolution.ts`, `lib/queueStatus.ts::overallSyncState`, `hooks/useConflictResolution.ts`; `components/SyncStatusPanel.tsx` renders props only |
| 8 | Component tests: the panel renders each state and both actions behave | `PASS` | `components/SyncStatusPanel.test.tsx`; `components/ConflictNotice.test.tsx` (+4 resolution cases); `pages/Sync.test.tsx` (+1 wiring case); `hooks/useConflictResolution.test.tsx` (3) |
| 9 | Unit tests for the resolution helpers | `PASS` | `lib/conflictResolution.test.ts` (9: keep-mine/take-server/idempotence/scoping/labels) |
| 10 | Light/dark + keyboard-accessible; useful empty state; clear errors | `PASS` | focusable buttons with `title`+`aria-busy`+disabled-while-busy; overall badge is `aria-live`; queue surface keeps `role="status"`; `styles.css` theme variables (`.sync-panel*`, `.conflict-actions`); error states covered in `SyncStatusPanel.test.tsx` |
| 11 | No existing test weakened, skipped or removed | `PASS` | the pre-existing 183 frontend tests unchanged and green (two `Sync.test.tsx` cases kept; only a mock for the new hook added); 183 → **216** (+33) |
| 12 | `lint`/`typecheck`/`test`/`build`; backend gates; `./scripts/verify.sh` | `PASS` | commands below |
| 13 | No new dependency added | `PASS` | built on the M7-03/M7-04 stack; `package.json` unchanged; ADR-0036 §"No new dependency" |
| 14 | Browser E2E (Playwright) | `NOT RUN` — Playwright is not set up in this repository | — |
| 15 | Backend / OpenAPI changes | `NONE` — no backend file touched, `schema.d.ts` unchanged | `git status` |

**Commands run.**

```
# frontend gates
cd apps/web
npm run lint          # clean
npm run typecheck     # tsc --noEmit, clean
npm run test          # vitest run — 34 files, 216 passed (183 → 216)
npm run build         # tsc --noEmit && vite build, clean

# backend gates (unchanged, re-run for the record)
cd services/api
.venv/bin/ruff check . && .venv/bin/ruff format --check . && .venv/bin/mypy   # clean (163 files formatted; mypy 78 files)
.venv/bin/python -m pytest tests/unit -q                                     # 456 passed
TEST_DATABASE_URL=postgresql+psycopg://atlas:atlas@127.0.0.1:5432/atlas_test \
  .venv/bin/python -m pytest -q                                              # 766 passed

cd /home/kim/Documents/Atlas && ./scripts/verify.sh   # verification: PASS (backend 766; frontend 216)
```

**Files added.** `apps/web/src/lib/conflictResolution.ts`,
`apps/web/src/hooks/useConflictResolution.ts`, `apps/web/src/components/SyncStatusPanel.tsx`, and the
tests `apps/web/src/lib/conflictResolution.test.ts`,
`apps/web/src/hooks/useConflictResolution.test.tsx`,
`apps/web/src/components/SyncStatusPanel.test.tsx`.
**Modified.** `apps/web/src/lib/offlineQueue.ts` (+`rebase`), `apps/web/src/lib/queueStatus.ts`
(+`overallSyncState`/labels), `apps/web/src/components/ConflictNotice.tsx` (optional resolution
actions), `apps/web/src/pages/Sync.tsx` (renders the panel and wires the resolution hook),
`apps/web/src/styles.css` (panel + conflict-action styles), and the tests
`apps/web/src/components/ConflictNotice.test.tsx` (+4), `apps/web/src/pages/Sync.test.tsx` (+1, mock),
`apps/web/src/lib/queueStatus.test.ts` (+6), `apps/web/src/lib/offlineQueue.test.ts` (+2).

**Limitations recorded, not waived.** This is the status panel and the two manual resolutions; the
**failure-mode E2E suite** (network loss, restart, stale client) is M7-06. Resolution is **per-entity**
and **client-driven** (no push); "take server" adopts the server's *metadata* state (the feed carries
no payloads, ADR-0035) and does not re-fetch an entity body — the `/sync` route does not render bodies.
"Keep mine" re-bases onto the revision recorded at the `409`; if the server changed again in the
meantime the next flush simply re-surfaces a fresh conflict rather than losing the edit. Browser E2E is
`NOT RUN`.

---

### M7-06 — Failure-mode tests (real browser E2E)

**Verified** 2026-10-27 (frontend + Playwright; no backend change). `DEPENDS ON` M7-03 (`DONE`), M7-04
(`DONE`). All checks below were actually run on this machine; the E2E suite **executed and passed** in
real Chromium.

| # | Criterion | Result | Evidence |
|---|---|---|---|
| 1 | Playwright is set up in `apps/web` (`@playwright/test`, `playwright.config.ts`, `e2e/`, `npm run e2e`) | `PASS` | `apps/web/package.json` (`"e2e": "playwright test"`), `apps/web/playwright.config.ts`; Chromium installed via `npx playwright install chromium` |
| 2 | The dependency + browser licence/purpose are recorded | `PASS` | `docs/DEPENDENCIES.md` (`@playwright/test`, Apache-2.0; the Chromium/"Chrome for Testing" build it downloads, BSD-3-Clause) |
| 3 | Serves the real app deterministically (no live backend) | `PASS` | `playwright.config.ts` `webServer` runs `npm run build && vite preview` (`http://localhost:4173`); the API is mocked via `page.route` |
| 4 | **Network loss:** a queued edit is kept while offline and the queue **flushes** on reconnect | `PASS` | `e2e/sync-failure-modes.spec.ts` "network loss…"; asserts `Pending sync` + `Offline` while down, then a successful `PATCH` and `All synced` after `online` |
| 5 | **Restart:** an offline edit survives a full page reload and still syncs | `PASS` | `e2e/sync-failure-modes.spec.ts` "restart…"; after `page.reload()` the queue is still `Pending sync` and then drains |
| 6 | **Stale client / conflict:** a stale-revision `409` is surfaced, and both actions behave as documented | `PASS` | `e2e/sync-failure-modes.spec.ts` "…'Keep mine'…" and "…'Take server'…"; `Sync conflicts` + `revision 5` shown, `Keep mine` lands a `PATCH` at `base_revision: 5`, `Take server` writes nothing |
| 7 | Deterministic and repeatable | `PASS` | 4 tests passed on **two** consecutive `npm run e2e` runs, 4 parallel workers, no retries |
| 8 | Existing suites and `verify.sh` still pass; no existing test weakened | `PASS` | frontend `216 passed`; full backend `766 passed`; `./scripts/verify.sh` → `verification: PASS` |
| 9 | `scripts/verify.sh` untouched; E2E is a separate, documented command | `PASS` | `git diff --exit-code scripts/verify.sh` clean; documented in `docs/TESTING.md` §1a |

**Exact commands and real results.**

```
cd apps/web && npm run lint                 # eslint .  → clean
cd apps/web && npm run typecheck            # tsc --noEmit → clean
cd apps/web && npm run test                 # 34 files, 216 passed
cd apps/web && npm run build                # tsc --noEmit && vite build → clean (dist/)
cd apps/web && npm run e2e                  # Playwright: 4 passed (Chromium), run green twice

cd services/api
.venv/bin/ruff check .                      # All checks passed!
.venv/bin/ruff format --check .             # 163 files already formatted
.venv/bin/mypy                              # Success: no issues found in 78 source files
.venv/bin/python -m pytest tests/unit -q    # 456 passed
TEST_DATABASE_URL=postgresql+psycopg://atlas:atlas@127.0.0.1:5432/atlas_test \
  .venv/bin/python -m pytest -q             # 766 passed

cd /home/kim/Documents/Atlas && ./scripts/verify.sh   # verification: PASS (backend 766; frontend 216)
```

**Files added.** `apps/web/playwright.config.ts`, `apps/web/e2e/sync-failure-modes.spec.ts`,
`apps/web/e2e/helpers.ts`.
**Modified.** `apps/web/package.json` (`@playwright/test` dev dependency + `e2e` script),
`apps/web/package-lock.json` (lockfile), `apps/web/vite.config.ts` (Vitest `exclude` of `e2e/**`),
`.gitignore` (Playwright `test-results/`/`playwright-report/`).

**Limitations recorded, not waived.**
- The queue's durable store is the source of truth here: because M7-03..M7-05 build the offline queue
  and its status/reconciliation **surfaces** but no *editing* UI enqueues an offline mutation yet, each
  test **seeds** a queued operation into the app's **own** durable IndexedDB store (`atlas-offline` →
  `kv` → `queue`, exactly the shape `offlineQueue.ts` reads) to represent the offline-edit state, then
  drives the **real** `/sync` UI (Refresh / Sync now / Keep mine / Take server, the hooks and the
  flush/reconcile code) to observe and act on it. The UI, reconciliation and HTTP paths exercised are
  production code; only the enqueue step is seeded.
- The API is **mocked** via Playwright network interception (AGENTS.md §11/§13 — no live backend, no
  real account); the suite therefore verifies the failure-mode **contract and UI behaviour**, not
  provider/back-end integration.
- "Offline" is simulated with a failing/aborted mutation route plus the real `window` `offline`/`online`
  events the app listens for, rather than `context.setOffline`, so the served app can load; the
  flush-on-reconnect path is still the real one.
- Chromium only (one browser in the matrix). `npm run e2e` is **not** wired into `scripts/verify.sh`
  (protected); it is a separate command documented in `TESTING.md`.
- The Chromium build had to be downloaded (`npx playwright install chromium`); the environment warned
  "your OS is not officially supported by Playwright", but the fallback `ubuntu24.04-x64` build
  installed and the suite ran.

---

## M7 — Gate (exit criteria)

Verified 2026-10-27 on Linux with Node 26, Playwright/Chromium and PostgreSQL 18 in Docker. All M7
tasks (M7-01…M7-06) are `DONE`; this is the explicit milestone-gate journey.

| Criterion | Result | Evidence |
|---|---|---|
| Multiple devices converge | `PASS` | Clients converge by paging `GET /api/changes` to the head; the per-user cursor is a total order (ADR-0032); `tests/integration/test_changes_api.py`. *(No literal two-physical-device run — recorded, not waived.)* |
| Offline edits retained | `PASS` | Durable client queue (M7-03) + E2E reload test |
| Stale writes detected | `PASS` | `base_revision` → `409`; E2E conflict tests (M7-05/M7-06) |
| Conflicting note edits recoverable | `PASS` | Notes conflict copies (M2-08) + M7 conflict surface/resolution (ADR-0036) |
| Deleted entities do not reappear | `PASS` | Tombstones + bounded retention + no-resurrection guarantee (M7-02, ADR-0033) |
| Restart preserves queued work | `PASS` | E2E: an offline edit survives a full page reload and still syncs (M7-06) |

**Commands run.**

```
./scripts/verify.sh
    # verification: PASS — backend 766 passed; frontend 216 passed

cd services/api && TEST_DATABASE_URL=postgresql+psycopg://atlas:atlas@127.0.0.1:5432/atlas_test \
  .venv/bin/python -m pytest tests/integration/test_changes_api.py \
    tests/integration/test_change_log_schema.py tests/integration/test_change_purge.py -q
    # 28 passed (change feed, paging, tombstones, retention purge, no resurrection)

cd apps/web && npm run e2e
    # 4 passed (Chromium): network loss, restart (offline edit survives reload), stale-client conflict
    #   with both resolutions — the first executed real-browser E2E in this repository
```

**Not run:** a literal two-physical-device convergence run; the E2E uses a mocked API (no live
provider — AR-001). Recorded honestly, not waived.

**Gate:** synchronisation recoverable under realistic failure conditions — **APPROVED 2026-10-27**.

---

## M8 — Notifications and Mobile Applications

### M8-01 — Reminder scheduler (durable)

**Verified** 2026-10-27. `DEPENDS ON` M1-08 (`DONE`), M3-05 (`DONE`). All checks below were actually
run on this machine (PostgreSQL 18 in Docker, `atlas_test` database). Backend-only; no API/OpenAPI
change, so `schema.d.ts` was **not** regenerated (verified: `openapi()` contains no reminder schema).

| # | Criterion | Result | Evidence |
|---|---|---|---|
| 1 | Durable reminder state: a policy entity + a scheduled reminder + a delivery record, in a versioned migration | `PASS` | `atlas/models/reminder.py`, migration `e5a91c3f7b64`; `tests/unit/test_reminder_schema.py`, `tests/integration/test_reminders.py::test_migrations_match_models` |
| 2 | A reminder fires **exactly once** at the time-zone-correct instant | `PASS` | `test_a_reminder_fires_once_and_records_the_delivery`; tz/fire-instant rules in `tests/unit/test_reminder_schedule.py` (CEST/CET + DST gap) |
| 3 | A retry/restart does **not** deliver twice | `PASS` | `test_a_retry_or_restart_does_not_deliver_twice`, `test_delivering_a_sent_reminder_again_is_skipped` (single `reminder_deliveries` row; unique `reminder_id`) |
| 4 | A cancelled/completed/archived/soft-deleted entity is **skipped** | `PASS` | `test_a_completed_or_archived_task_is_skipped` (parametrized), `test_a_soft_deleted_task_is_skipped`, `test_cancelling_a_reminder_skips_delivery`, `test_sync_cancels_a_reminder_when_the_task_becomes_terminal` |
| 5 | Editing a due date **reschedules**; cancelling skips | `PASS` | `test_editing_a_due_date_reschedules_the_reminder`, `test_the_api_reschedules_the_reminder_on_a_due_date_edit` |
| 6 | The scheduler is durable (job-queue backed) and **idempotent** | `PASS` | `test_scheduling_materialises_the_reminder_and_its_durable_job` (job `run_at == remind_at`), `test_the_scan_sweep_is_durable_and_idempotent`; `ensure_reminder_scan_job` wired into `ensure_recurring_jobs` |
| 7 | Time-zone correct via `atlas/tasks/timezones.py`; store UTC | `PASS` | `atlas/reminders/schedule.py::remind_at_for` uses `to_local`/`get_zone`/`to_utc`; unit tests assert the local-calendar-day and DST behaviour |
| 8 | Notifier abstraction with a fake/logging notifier | `PASS` | `atlas/reminders/notifier.py` (`LoggingNotifier`, `RecordingNotifier`); `tests/unit/test_reminder_schedule.py` |
| 9 | Strict user scoping at the boundary | `PASS` | `test_syncing_another_users_task_is_a_no_op`; `ReminderService.sync_for_task` loads through the owning user |
| 10 | Migration applies, reverses and matches the models | `PASS` | `test_migration_upgrade_and_downgrade_round_trip`; `compare_metadata == []`; ADR-0037 |
| 11 | No existing test weakened or removed; lint/type/format/full suite/`verify.sh` pass | `PASS` | counts below; full suite grew `766 → 809` |

**Exact commands and real results.**

```
cd services/api
.venv/bin/ruff check .                      # All checks passed!
.venv/bin/ruff format --check .             # 174 files already formatted
.venv/bin/mypy                              # Success: no issues found in 85 source files
.venv/bin/python -m pytest tests/unit -q    # 480 passed
TEST_DATABASE_URL=postgresql+psycopg://atlas:atlas@127.0.0.1:5432/atlas_test \
  .venv/bin/python -m pytest -q             # 809 passed
TEST_DATABASE_URL=postgresql+psycopg://atlas:atlas@127.0.0.1:5432/atlas_test \
  .venv/bin/python -m pytest tests/integration/test_reminders.py -q   # 19 passed

# Migration round-trip on the real test database (DATABASE_URL = atlas_test):
DATABASE_URL=postgresql+psycopg://atlas:atlas@127.0.0.1:5432/atlas_test .venv/bin/alembic downgrade c1a2b3d4e5f6
    # → no reminder_* tables present
DATABASE_URL=postgresql+psycopg://atlas:atlas@127.0.0.1:5432/atlas_test .venv/bin/alembic upgrade head
    # → reminder_deliveries, reminder_policies, reminders present

cd /home/kim/Documents/Atlas && ./scripts/verify.sh   # verification: PASS (backend 809; frontend 216)
```

**New tests.** `services/api/tests/unit/test_reminder_schedule.py` (15),
`services/api/tests/unit/test_reminder_schema.py` (9), `services/api/tests/integration/test_reminders.py`
(19).

**Not run / out of scope (recorded, not waived).** Real push transport (Web Push/VAPID) is M8-02 and
device push is M8-04; delivery here is verified against the fake/logging notifier only. A reminder
policy can only be assigned directly in the database in this milestone — the preferences UI is M8-05.

---

### M8-03 — Device token registry + invalidation

**Verified** 2026-10-27 against PostgreSQL 18 (`atlas_test`). `DEPENDS ON` M8-01 (`DONE`). The
implementing run stopped at its turn limit before writing the docs; the supervising pass re-ran the
checks below and recorded this section.

| # | Acceptance criterion | Result | Evidence |
|---|---|---|---|
| 1 | A durable registry of push destinations per user, keyed `(user_id, channel, endpoint)`, in a versioned migration | `PASS` | `atlas/models/notification.py`, migration `a3f7c2d8b105`; `tests/unit/test_notification_registry.py`, `tests/integration/test_notification_registry.py::test_migrations_match_models` |
| 2 | Register/unregister are idempotent; a re-register upserts (no duplicate) | `PASS` | `NotificationRegistryService.register` (upsert on the unique key); `test_registering_the_same_destination_is_idempotent`, `test_unregister_is_idempotent` |
| 3 | A web and a native destination round-trip | `PASS` | `test_register_returns_metadata_and_never_the_endpoint_or_keys`, `test_a_native_registration_round_trips` |
| 4 | Secrets (endpoint/`p256dh`/`auth`) are never returned or logged | `PASS` | `DeviceOut` omits them; `test_register_returns_metadata_and_never_the_endpoint_or_keys` |
| 5 | Strict user scoping; media auth (401) and CSRF (403) enforced at the boundary | `PASS` | `test_devices_are_strictly_user_scoped`, `test_devices_require_authentication`, `test_writes_require_csrf` |
| 6 | An invalid/expired destination reported by a delivery is pruned/disabled and not retried | `PASS` | `NotificationRegistryService.disable_many`; `tests/integration/test_notification_registry.py::test_an_invalid_destination_reported_by_a_delivery_is_pruned`, `test_a_dead_destination_is_disabled_even_when_its_send_fails` |
| 7 | A re-register revives an invalidated destination | `PASS` | `test_re_registering_revives_an_invalidated_destination` |
| 8 | Delivery targets active destinations and degrades safely with none | `PASS` | `atlas/reminders/delivery.py`; `test_a_user_without_devices_falls_back_to_an_untargeted_send` |
| 9 | Migration applies, reverses and matches the models | `PASS` | `test_migration_upgrade_and_downgrade_round_trip`; `compare_metadata == []`; ADR-0038 |
| 10 | No existing test weakened or removed; lint/type/format/full suite/`verify.sh` pass | `PASS` | full suite `809 → 856`; commands below |

**Commands run.**

```
cd services/api
.venv/bin/ruff check . && .venv/bin/ruff format --check . && .venv/bin/mypy   # clean
.venv/bin/python -m pytest tests/unit -q                                     # 480 passed
TEST_DATABASE_URL=postgresql+psycopg://atlas:atlas@127.0.0.1:5432/atlas_test \
  .venv/bin/python -m pytest -q                                              # 856 passed
TEST_DATABASE_URL=…/atlas_test .venv/bin/python -m pytest \
  tests/integration/test_notification_registry.py -q                         # 19 passed (incl. migration round-trip)

cd /home/kim/Documents/Atlas && ./scripts/verify.sh   # verification: PASS (backend 856; frontend 216)
```

**Files added.** `atlas/models/notification.py`, `atlas/notifications/{registry,service}.py`,
`atlas/api/notifications.py`, `alembic/versions/a3f7c2d8b105_notification_devices.py`,
`tests/unit/test_notification_registry.py`, `tests/integration/test_notification_registry.py`.
**Modified.** `atlas/reminders/{notifier,delivery}.py` (invalid-destination reporting + targeting the
active registry), `atlas/api/{__init__,schemas}.py`, `atlas/main.py`, `apps/web/src/api/schema.d.ts`.

**Limitations recorded, not waived.** Exercised with the fake/recording notifier and a real database;
real Web Push delivery is M8-02 and real mobile push is M8-04 (both need devices/services). The
registry stores a destination; it does not itself send.

---

### M8-02 — Web Push (VAPID) desktop

**Verified** 2026-10-27 with Chromium (Playwright), Python 3.14 and PostgreSQL 18 (`atlas_test`).
`DEPENDS ON` M8-01 (`DONE`), M8-03 (`DONE`). The implementing run stopped at its turn limit before the
docs and the push E2E; the supervising pass added the missing E2E spec
(`apps/web/e2e/web-push-consent.spec.ts`), ran it, and recorded this section.

| # | Acceptance criterion | Result | Evidence |
|---|---|---|---|
| 1 | VAPID keys are configuration (external, never committed); a missing key disables the feature cleanly | `PASS` | `atlas/notifications/vapid.py`; `tests/unit/test_vapid_config.py` |
| 2 | Delivery uses a maintained library (no custom crypto) behind the M8-01 `Notifier` | `PASS` | `atlas/reminders/push.py::PushSender` (`pywebpush`, MPL-2.0); `tests/unit/test_push_sender.py` |
| 3 | The sender targets the user's active web subscriptions | `PASS` | `tests/integration/test_web_push_delivery.py` |
| 4 | A push service's `404`/`410` is reported so the registry disables the destination | `PASS` | `INVALID_DESTINATION_STATUSES` → `invalid_destinations`; `tests/unit/test_push_sender.py`, `tests/integration/test_web_push_delivery.py` |
| 5 | `GET /api/notifications/config` serves only the **public** key | `PASS` | `atlas/api/notifications.py`; the private key is never serialised |
| 6 | The consent UI handles permission, subscribes with the VAPID key (from the server config) and registers the destination | `PASS` | `apps/web/e2e/web-push-consent.spec.ts` (granted → "Notifications are on" + `POST /api/notifications/devices` with the `{channel,endpoint,p256dh,auth}` payload) |
| 7 | Unsupported / server-disabled / denied states are clear | `PASS` | E2E: denied → "Notifications are blocked" (no enable action); no-VAPID → "Notifications aren't available on this server"; component tests for all states |
| 8 | A service worker renders a pushed message | `PASS` | `apps/web/public/sw.js` (renders `{title,body,data}`, dedupe `tag`); component/unit coverage of the client rules |
| 9 | No existing test weakened; lint/type/format/full suite/`verify.sh` pass | `PASS` | full suite `856 → 875`; frontend `216 → 244`; commands below |

**Commands run.**

```
cd services/api
.venv/bin/ruff check . && .venv/bin/ruff format --check . && .venv/bin/mypy   # clean
.venv/bin/python -m pytest tests/unit -q                                     # 490 passed
TEST_DATABASE_URL=postgresql+psycopg://atlas:atlas@127.0.0.1:5432/atlas_test \
  .venv/bin/python -m pytest -q                                              # 875 passed

cd apps/web && npm run lint && npm run typecheck && npm run test && npm run build   # clean; 244 vitest
cd apps/web && npm run e2e
    # 7 passed (Chromium): 4 M7 failure modes + 3 M8-02 push consent
    #   (granted → registered; denied → blocked; server without VAPID → unavailable)

cd /home/kim/Documents/Atlas && ./scripts/verify.sh   # verification: PASS (backend 875; frontend 244)
```

**Files added.** `services/api/atlas/notifications/vapid.py`, `services/api/atlas/reminders/push.py`,
`services/api/tests/unit/{test_vapid_config,test_push_sender}.py`,
`services/api/tests/integration/test_web_push_delivery.py`; `apps/web/public/sw.js`,
`apps/web/src/lib/webpush.ts` (+`.test.ts`), `apps/web/src/hooks/useWebPush.ts` (+`.test.tsx`),
`apps/web/src/components/NotificationConsent.tsx` (+`.test.tsx`), `apps/web/src/pages/Notifications.tsx`,
`apps/web/e2e/web-push-consent.spec.ts`.
**Modified.** `atlas/api/notifications.py`, `atlas/api/schemas.py`, `atlas/config.py`,
`services/api/pyproject.toml` (`pywebpush`), `apps/web/src/{App.tsx,components/Layout.tsx,api/client.ts,styles.css}`.

**Limitations recorded, not waived.** A real push **delivery** to a browser is `NOT RUN` — it needs a
live push service (and real VAPID keys) and cannot be exercised in this environment; the E2E mocks the
Push API and asserts the contract/UI. Real mobile push is M8-04.

---

### M8-05 — Notification preferences UI

**Verified** 2026-10-27 against PostgreSQL 18 (`atlas_test`) and the frontend test suite.
`DEPENDS ON` M8-01 (`DONE`). The implementing run stopped at its turn limit before the docs; the
supervising pass re-ran the checks and recorded this section.

| # | Acceptance criterion | Result | Evidence |
|---|---|---|---|
| 1 | A user can view and change the reminder timing (a per-user default) | `PASS` | `GET`/`PUT /api/notifications/reminders`; `tests/integration/test_reminder_preferences.py::test_the_default_is_null_until_set_then_reads_back` |
| 2 | A per-entity override exists and beats the default | `PASS` | `PUT /api/tasks/{id}/reminder`; `test_a_per_entity_override_beats_the_default_and_reschedules`, `test_repeated_overrides_reuse_one_policy_row` |
| 3 | A timing change reschedules the durable reminder | `PASS` | `test_setting_the_default_reschedules_inherited_tasks`; `test_the_scan_materialises_reminders_for_default_only_tasks` |
| 4 | Clearing clears/cancels | `PASS` | `test_clearing_the_default_cancels_inherited_reminders` |
| 5 | Idempotent, strictly user-scoped | `PASS` | `test_setting_the_default_is_idempotent`, `test_preferences_are_strictly_user_scoped` |
| 6 | Invalid values rejected at the boundary with no side effects | `PASS` | `tests/unit/test_reminder_preferences.py` (`days_before`/strict `HH:MM`), `test_an_invalid_timing_is_rejected_with_no_side_effects`, `test_an_invalid_override_is_rejected_with_no_side_effects`, `test_the_override_endpoint_rejects_an_unknown_task` |
| 7 | One default per user; existing policies unaffected | `PASS` | partial unique index `uq_reminder_policies_default`; migration `f1b2c3d4e5a6` (server default `false`) |
| 8 | UI renders loading/error/saved states; logic out of components; light/dark; keyboard | `PASS` | `components/ReminderPreferences.tsx` (+`.test.tsx`), `hooks/useReminderPreferences.ts`, `lib/reminders.ts` (+`.test.ts`); wired on `/notifications` |
| 9 | Auth (401) / CSRF (403) on writes; migration reversible + model-matching | `PASS` | `test_reminder_preferences_require_authentication`, `test_writes_require_csrf`; migration round-trip + `compare_metadata == []` |
| 10 | No existing test weakened; lint/type/format/full suite/`verify.sh` pass; OpenAPI + TS in sync | `PASS` | full suite `875 → 914`; frontend `244 → 268`; `gen:api` idempotent |

**Commands run.**

```
cd services/api
.venv/bin/ruff check . && .venv/bin/ruff format --check . && .venv/bin/mypy   # clean
.venv/bin/python -m pytest tests/unit -q                                     # 515 passed
TEST_DATABASE_URL=postgresql+psycopg://atlas:atlas@127.0.0.1:5432/atlas_test \
  .venv/bin/python -m pytest -q                                              # 914 passed
TEST_DATABASE_URL=…/atlas_test .venv/bin/python -m pytest \
  tests/integration/test_reminder_preferences.py -q                          # passed

cd apps/web && npm run lint && npm run typecheck && npm run test && npm run build   # clean; 268 vitest
cd /home/kim/Documents/Atlas && ./scripts/verify.sh   # verification: PASS (backend 914; frontend 268)
```

**Files added.** `services/api/alembic/versions/f1b2c3d4e5a6_reminder_default_policy.py`,
`services/api/tests/unit/test_reminder_preferences.py`,
`services/api/tests/integration/test_reminder_preferences.py`; `apps/web/src/lib/reminders.ts` (+`.test.ts`),
`apps/web/src/hooks/useReminderPreferences.ts`, `apps/web/src/components/ReminderPreferences.tsx` (+`.test.tsx`).
**Modified.** `atlas/models/reminder.py`, `atlas/reminders/*`, `atlas/api/{notifications,tasks,schemas}.py`,
`services/api/openapi.json`; `apps/web/src/pages/Notifications.tsx`, `apps/web/src/api/{client.ts,schema.d.ts}`.

**Limitations recorded, not waived.** A Playwright E2E for the preferences flow was not added (the
component/unit tests cover the UI states and the backend integration tests cover the reschedule effect);
recorded `NOT RUN` for the browser-E2E end, not waived. Real mobile-push timing is M8-04.

---

## M9-01 — Automated DB + Markdown backups

`DEPENDS ON` M1-02 (`DONE`). Backend only (`services/api` + `scripts`); the restore drill (M9-02) and
the full open-format export (M9-03) are **out of scope** for this task.

| # | Acceptance criterion | Result | Evidence |
|---|---|---|---|
| 1 | One backup set captures **both** stores (PostgreSQL dump + Markdown notes archive) | `PASS` | `atlas/backups/service.py` (`BackupService.run`); `tests/integration/test_backups.py::test_a_backup_captures_both_stores_with_a_verifiable_manifest` (the dump contains a committed task row; `notes.tar.gz` contains the on-disk note) |
| 2 | The set carries a manifest with a file list, sizes and checksums, plus provenance + timestamp | `PASS` | `atlas/backups/manifest.py`; `test_the_manifest_records_provenance_and_a_timestamp` (parts record `store` = `postgresql`/`markdown`, `created_at`, `sha256`) |
| 3 | An integrity check passes on a good set | `PASS` | `atlas/backups/verify.py` (`verify_backup_set`); `tests/unit/test_backups.py::test_a_good_set_verifies`; integration set verifies after each run |
| 4 | The integrity check fails clearly on a tampered set | `PASS` | `test_a_tampered_set_fails_the_integrity_check`, `test_a_missing_part_fails_the_integrity_check`, unit `test_a_tampered_part_fails_verification`, `test_a_missing_manifest_marks_a_set_incomplete`, `test_an_unsafe_part_filename_in_a_manifest_fails` |
| 5 | A partial/failed run is detectable and never reported as a good backup | `PASS` | staging → verify → atomic publish; `test_a_failed_run_is_detectable_and_never_published` (no published set; the leftover staging dir verifies `not ok`) |
| 6 | Runs are idempotent / safe to repeat; a surviving set is never mutated | `PASS` | `test_runs_are_repeatable_and_retention_keeps_the_newest` (a later run leaves an existing set's digests unchanged) |
| 7 | Configurable destination + retention with sane defaults; nothing written outside the destination | `PASS` | `BACKUP_DIR`/`BACKUP_RETAIN` (default 7); `BackupService._ensure_within`; `test_runs_are_repeatable_and_retention_keeps_the_newest` (only `notes/` + `backups/` exist) |
| 8 | No secret is written to the manifest or logs | `PASS` | manifest carries no URL/credential; password travels via `PGPASSWORD` (unit `test_binary_backend_keeps_the_password_out_of_argv`); `test_no_database_secret_reaches_the_manifest` |
| 9 | A durable job runs the backup and is restart-safe | `PASS` | `atlas/jobs/handlers.py` (`BACKUP_TASK`, `ensure_backup_job`, `schedule_next_backup`); `test_the_backup_job_runs_on_the_durable_queue_and_reschedules`, `test_a_stale_running_backup_is_reaped_and_restarted` |
| 10 | An operator CLI exists and works | `PASS` | `atlas/backups/cli.py` (`atlas-backup run|verify|list`); `test_the_cli_runs_lists_and_verifies`; manual run below |
| 11 | No existing test weakened or removed; lint/type/format/full suite/`verify.sh` pass | `PASS` | full suite `914 → 936`; frontend `268`; `verify.sh` → `verification: PASS` |

**Commands run.**

```
cd services/api
.venv/bin/ruff check . && .venv/bin/ruff format --check . && .venv/bin/mypy   # clean
.venv/bin/python -m pytest tests/unit -q                                     # 561 passed
TEST_DATABASE_URL=postgresql+psycopg://atlas:atlas@127.0.0.1:5432/atlas_test \
  .venv/bin/python -m pytest -q                                              # 936 passed
TEST_DATABASE_URL=…/atlas_test .venv/bin/python -m pytest \
  tests/integration/test_backups.py tests/unit/test_backups.py -q            # 22 passed

cd /home/kim/Documents/Atlas && ./scripts/verify.sh   # backend 936; frontend 268; verification: PASS
```

**Operator CLI (manual, `atlas_test` + a temp notes dir — never the application DB):**

```
$ DATABASE_URL=postgresql+psycopg://atlas:atlas@127.0.0.1:5432/atlas_test \
  NOTES_ROOT=$TMP/notes BACKUP_DIR=$TMP/backups BACKUP_PG_DUMP_CONTAINER=atlas-db-1 \
  .venv/bin/atlas-backup run
backup ok: 20261027T110759Z-e8104d55
  directory: …/backups/atlas-backup-20261027T110759Z-e8104d55
  database: 35868 bytes sha256=7e859e02…
  notes: 144 bytes (2 files) sha256=1a5dd185…
$ .venv/bin/atlas-backup verify           # ok …/atlas-backup-20261027T110759Z-e8104d55 (database: ok; notes: ok)
$ printf 'x' >> …/database.sql && .venv/bin/atlas-backup verify   # FAILED …: database: checksum/size mismatch  (exit 1)
```

**Files added.** `services/api/atlas/backups/{__init__,manifest,pgdump,verify,service,cli,__main__}.py`,
`services/api/tests/unit/test_backups.py`, `services/api/tests/integration/test_backups.py`.
**Modified.** `services/api/atlas/jobs/{handlers,__init__}.py`, `services/api/atlas/config.py`,
`services/api/pyproject.toml` (`atlas-backup` entry point), `services/api/Dockerfile`
(`postgresql-client`), `deploy/docker-compose.yml` (worker backups volume + env), `.env.example`.

**Limitations recorded, not waived.** The dump uses `pg_dump` **plain** format (portable, restorable
with `psql`); a `pg_dump` custom format + `pg_restore` was considered and deferred to keep the first
backup path dependency-free and easy to inspect (ADR-0041). Backup integrity proves the set is
*internally consistent*, not that it restores — end-to-end restore is the M9-02 drill and is recorded
`NOT RUN` here. Backups are taken by the worker with the container's local `pg_dump`; on this dev host
the client is absent and the test/CLI use `docker exec` into `atlas-db-1` (`BACKUP_PG_DUMP_CONTAINER`).

---

## M9-02 — Documented + executed restore drill

`DEPENDS ON` M9-01 (`DONE`). Proves an M9-01 backup set actually **restores**: a real drill against
scratch targets (a scratch database and a scratch notes directory) with a source-identical
verification, plus the failure path. The full open-format export (M9-03) and the vulnerability scan
(M9-04) are **out of scope**.

| # | Acceptance criterion | Result | Evidence |
|---|---|---|---|
| 1 | A backup set is restored into scratch targets (scratch DB + scratch notes dir) | `PASS` | `atlas-backup run` → `psql … < database.sql` into `atlas_restore_dst` (exit 0, no `ERROR`/`FATAL`) + `tar -xzf notes.tar.gz` into a scratch dir (exit 0) |
| 2 | The restored notes are byte-identical to the source | `PASS` | `diff -r notes_src notes_dst` exit 0; per-file SHA-256 equal (`32949e66…`, `7b96b088…`) |
| 3 | The known rows are present in the restored database | `PASS` | `SELECT` on `atlas_restore_dst` returns the seeded user (`drill@example.com`), task (`RESTORE-DRILL-TASK-42`) and project (`Restore Drill Project`) with identical values |
| 4 | The schema is applied cleanly (migration state matches the source) | `PASS` | restored `alembic_version` = source head `f1b2c3d4e5a6`; **23 tables / 203 columns** on both; normalized `pg_dump --data-only` diff identical (`a39f3088…`) and per-table `row_to_json` MD5 identical (users/tasks/projects) |
| 5 | A tampered set fails the integrity check | `PASS` | bytes appended to `database.sql` → `atlas-backup verify` `FAILED … database: checksum/size mismatch` (exit 1) |
| 6 | A partial set fails the integrity check | `PASS` | removed `notes.tar.gz` → `FAILED … notes: file missing` (exit 1); an interrupted-run staging dir reported `INCOMPLETE` (exit 1) |
| 7 | No application DB or real notes are touched; scratch targets are cleaned up | `PASS` | only `atlas_restore_src`/`atlas_restore_dst` were created and both were dropped; the scratch dirs removed; `atlas`/`atlas_test` untouched |
| 8 | The procedure is documented as an operator runbook matching what was run | `PASS` | `docs/OPERATIONS.md` §2 |
| 9 | No existing test weakened/removed; lint/format/type/full suite/`verify.sh` pass | `PASS` | unit `561 passed`; full `936 passed`; ruff/format/mypy clean; `./scripts/verify.sh` → `verification: PASS` |

**Executed drill (2026-10-27).** `$SCR` is a session scratch dir; `atlas_restore_src` (source) and
`atlas_restore_dst` (restore target) are scratch databases on the same PostgreSQL server as
`atlas_test`; the application `atlas` database and real notes were never used.

```
# --- seed a scratch source DB + notes root (known data) ---
docker exec atlas-db-1 psql -U atlas -d postgres -c "CREATE DATABASE atlas_restore_src OWNER atlas;"
docker exec atlas-db-1 psql -U atlas -d postgres -c "CREATE DATABASE atlas_restore_dst OWNER atlas;"
DATABASE_URL=postgresql+psycopg://atlas:atlas@127.0.0.1:5432/atlas_restore_src .venv/bin/alembic upgrade head
#   … -> f1b2c3d4e5a6 (head)
#   seeded rows: user 11111111-… ("drill@example.com"), task 22222222-… "RESTORE-DRILL-TASK-42",
#                project 33333333-… "Restore Drill Project"; notes $SCR/notes_src/{index.md,sub/todo.md}

# --- 1) produce + verify the set ---
$ DATABASE_URL=…atlas_restore_src NOTES_ROOT=$SCR/notes_src BACKUP_DIR=$SCR/backups \
    BACKUP_PG_DUMP_CONTAINER=atlas-db-1 .venv/bin/atlas-backup run
backup ok: 20261027T111643Z-ecdf00ad
  directory: …/backups/atlas-backup-20261027T111643Z-ecdf00ad
  database: 36452 bytes sha256=8e17eb16f85be8dc10e3f65d52c21ee187035883aadd3ef59a2191f1c6e2fd69
  notes: 281 bytes (2 files) sha256=aaa4c37e409fe123f12d0d734b39bc047cb29e72853d8615e95602c0f370ef7c
$ .venv/bin/atlas-backup verify $SET
ok …/atlas-backup-20261027T111643Z-ecdf00ad
    database: ok
    notes: ok                       # exit 0

# --- 2) restore into scratch targets ---
$ docker exec -i atlas-db-1 psql -U atlas -d atlas_restore_dst -v ON_ERROR_STOP=1 < $SET/database.sql
SET …  (exit 0; grep -iE 'error|fatal' -> none)
$ tar -xzf $SET/notes.tar.gz -C $SCR/notes_dst      # exit 0 -> index.md, sub/todo.md

# --- 3) assert restored == source ---
$ diff -r $SCR/notes_src $SCR/notes_dst             # IDENTICAL (exit 0)
source   index.md 32949e66b77f…  sub/todo.md 7b96b088e69d…
restored index.md 32949e66b77f…  sub/todo.md 7b96b088e69d…
$ docker exec atlas-db-1 psql -U atlas -d atlas_restore_dst -c "SELECT id,email,display_name FROM users;"
  11111111-1111-1111-1111-111111111111 | drill@example.com | Restore Drill
$ … -c "SELECT id,title,status,priority FROM tasks;"
  22222222-2222-2222-2222-222222222222 | RESTORE-DRILL-TASK-42 | next | high
$ … -c "SELECT id,name FROM projects;"
  33333333-3333-3333-3333-333333333333 | Restore Drill Project
$ … atlas_restore_dst -tAc "SELECT version_num FROM alembic_version;"   # f1b2c3d4e5a6
#   tables/columns: src 23/203 == dst 23/203
#   normalized data-only dump: src == dst (sha256 a39f3088…); per-table row_to_json md5 identical
#     users=df44be87… tasks=582932f3… projects=7c3c24cb… (both DBs)

# --- 4) the failure path (reuses the M9-01 integrity check) ---
$ cp -r $SET $SCR/tampered && printf '\n-- TAMPERED\n' >> $SCR/tampered/database.sql
$ .venv/bin/atlas-backup verify $SCR/tampered
FAILED …/tampered
    database: checksum/size mismatch
    notes: ok                       # exit 1
$ cp -r $SET $SCR/partial && rm $SCR/partial/notes.tar.gz
$ .venv/bin/atlas-backup verify $SCR/partial
FAILED …/partial
    database: ok
    notes: file missing             # exit 1
$ mkdir -p $SCR/backups/.staging/interrupted-run && … && .venv/bin/atlas-backup verify $SCR/backups
ok …/atlas-backup-20261027T111643Z-ecdf00ad
INCOMPLETE …/.staging/interrupted-run (interrupted run; no manifest)   # exit 1

# --- 5) clean up ---
$ docker exec atlas-db-1 psql -U atlas -d postgres \
    -c "DROP DATABASE IF EXISTS atlas_restore_src;" -c "DROP DATABASE IF EXISTS atlas_restore_dst;"
DROP DATABASE … both dropped; remaining: atlas, atlas_test
$ rm -rf $SCR

# --- verification gate ---
cd services/api
.venv/bin/ruff check . && .venv/bin/ruff format --check . && .venv/bin/mypy   # clean
.venv/bin/python -m pytest tests/unit -q                                     # 561 passed
TEST_DATABASE_URL=postgresql+psycopg://atlas:atlas@127.0.0.1:5432/atlas_test \
  .venv/bin/python -m pytest -q                                              # 936 passed
cd /home/kim/Documents/Atlas && ./scripts/verify.sh                          # verification: PASS
```

**Files changed.** `docs/OPERATIONS.md` (§2 restore runbook, replacing the placeholder), `docs/ROADMAP.md`
(M9-02 row → `DONE` + verification paragraph), `docs/ACCEPTANCE.md` (this section), `docs/CHANGELOG.md`,
`project/CURRENT_TASK.md`. No code was changed and no test was added, altered or removed — the drill
exercises the existing M9-01 `atlas-backup` CLI and `verify_backup_set`.

**Limitations recorded, not waived.** The drill restored into scratch targets and queried them
directly; it did **not** stop/start the compose stack nor serve the app against the restored data
(that is an operational act on a real host, `OPERATIONS.md` §2.4). Calendar-sync resumption after a
restore is **`NOT RUN`** — it needs the M5-00 real accounts (AR-001); the per-provider cursor restores
with the database and resumption is idempotent by design (`ADR-0029`/`ADR-0031`).

---

## M9-03 — Full data export

`DEPENDS ON` M2, M3, M4 (`DONE`). Implements REQ-015 data portability: a **complete export** of a
user's notes (content), tasks and projects (and their associations) in **open formats**, with a
manifest, reachable over HTTP and via the operator CLI. Reuses the M4-07 document (ADR-0026) rather
than forking it; the full-export set format is **ADR-0042**. **No migration** — the export is
read-only. **API change:** one new path/operation (`GET /api/export`), so OpenAPI and
`apps/web/src/api/schema.d.ts` were regenerated.

| # | Acceptance criterion | Result | Evidence |
|---|---|---|---|
| 1 | One export captures **notes + tasks + projects** | `PASS` | `tests/integration/test_export.py::test_a_full_export_captures_notes_tasks_and_projects` (the zip holds `data.json`, `notes.json` and the `.md` files) |
| 2 | Notes are exported as **real Markdown** (portable as-is) | `PASS` | `…::test_the_exported_notes_are_the_real_markdown_bytes` (exported bytes == the file on disk, byte-identical, unicode intact); manual CLI `diff`/`sha256sum` below |
| 3 | The notes index carries the metadata to rebuild **links/tags** (no proprietary wrapper for content) | `PASS` | `notes.json` (`atlas.notes-index` v1): per-note `tags`, wiki `links`, `projects`; `…::test_a_full_export_captures_notes_tasks_and_projects` asserts tags/links/project associations and that no `content` key exists; unit `test_a_note_index_entry_carries_metadata_but_no_content` |
| 4 | Tasks + projects **reuse the versioned M4-07 document** (not a forked format) | `PASS` | `data.json` is `atlas.project-export` v1 built by `atlas.projects.export.build_document`; `…::test_the_export_matches_the_m4_07_project_document` (fidelity vs `GET /api/projects/{id}/export`); unit `test_the_full_document_adds_unfiled_tasks_additively` |
| 5 | The export is **complete** — nothing silently omitted (incl. unfiled tasks; no `truncated`) | `PASS` | `data.json` carries the additive `unfiled_tasks`; `…::test_a_full_export_captures_notes_tasks_and_projects` asserts a filed task under its project **and** an unfiled task; unit `test_the_project_export_document_is_unchanged_without_unfiled_tasks` (M4-07 shape untouched) |
| 6 | A **manifest** (format + version, file list, sizes/checksums, timestamp) makes the set verifiable | `PASS` | `manifest.json` (`atlas.full-export` v1): `export_id`, `created_at`, `snapshot`, per-store `contents` and every file's `path`/`bytes`/`sha256`; unit `test_the_manifest_is_versioned_and_self_describing`; `…::test_the_manifest_verifies_the_downloaded_set` (re-assembles the download and `verify_export_set` → ok) |
| 7 | Verification fails on a tampered / missing file and flags an incomplete set | `PASS` | unit `test_a_tampered_file_fails_verification`, `test_a_missing_listed_file_fails_verification`, `test_a_missing_manifest_is_an_incomplete_set`, `test_an_unsafe_path_in_a_manifest_fails`; CLI `…::test_the_cli_verifies_lists_and_flags_incomplete_sets`; manual CLI below |
| 8 | **Self-consistent snapshot** (no torn read) | `PASS` | every DB read runs in one `REPEATABLE READ` transaction (reuses `ProjectsService.begin_consistent_read`, ADR-0026); `…::test_the_export_reads_one_repeatable_read_snapshot` asserts PostgreSQL reports `repeatable read`. Note files are written atomically and hashed while streaming, so the index/manifest describe the exact bytes |
| 9 | **Strictly user-scoped** | `PASS` | every query filters on the caller; `…::test_the_export_is_strictly_user_scoped` (a foreign user's project/task/note **and** a foreign note file in the same root never appear), `…::test_the_export_requires_authentication` (`401`) |
| 10 | The **empty** case is handled | `PASS` | `…::test_an_empty_export_is_well_formed` (`projects: []`, `unfiled_tasks: []`, `notes: []`, no `notes/` entries, zeroed `contents`, well-formed manifest) |
| 11 | Reachable like the other operational tooling: an **API endpoint** and/or a **CLI** | `PASS` | `GET /api/export` (`atlas/api/export.py`) returns the set as `application/zip`; `atlas-export` CLI (`run`/`verify`/`list`, `atlas/export/cli.py`); integration `…::test_the_cli_exports_and_verifies_a_set`; manual CLI below |
| 12 | The format + version are documented as a **stable contract** | `PASS` | `DECISIONS.md` **ADR-0042**; module docs of `atlas/export/document.py`; `PRODUCT_SPEC.md` §5.8 (REQ-015); `OPERATIONS.md` §1.3 |
| 13 | **No migration** (read-only) | `PASS` | no file added under `services/api/alembic/versions/`; the schema-drift test is unchanged |
| 14 | Unit + integration tests added; **no existing test weakened or removed** | `PASS` | 21 new unit (`tests/unit/test_export_document.py`) + 11 new integration (`tests/integration/test_export.py`); existing suites untouched (561 → 582 unit; 936 → 968 total) |
| 15 | OpenAPI / `schema.d.ts` regenerated and in sync | `PASS` | `npm run gen:api` (delta = the new `/api/export` operation; all pre-existing paths preserved, `gen:api` idempotent) |
| 16 | `ruff` / `ruff format --check` / `mypy` / full suite / frontend / `verify.sh` | `PASS` | commands below |
| 17 | Browser E2E (download an export in a real browser) | `NOT RUN` | Playwright is set up but only covers the M7/M8 surfaces; M9-03 is API/CLI-only (no export UI was in scope) — recorded, not waived |

**Commands run (2026-10-27) — real output.**

```
cd services/api
.venv/bin/ruff check .                      # All checks passed!
.venv/bin/ruff format --check .             # 210 files already formatted
.venv/bin/mypy                              # Success: no issues found in 107 source files
.venv/bin/python -m pytest tests/unit -q    # 582 passed
TEST_DATABASE_URL=postgresql+psycopg://atlas:atlas@127.0.0.1:5432/atlas_test \
  .venv/bin/python -m pytest -q             # 968 passed
TEST_DATABASE_URL=…/atlas_test .venv/bin/python -m pytest \
  tests/integration/test_export.py tests/unit/test_export_document.py -q   # 32 passed

cd /home/kim/Documents/Atlas && ./scripts/verify.sh   # backend 968; frontend 268; verification: PASS
```

**Operator CLI (manual, `atlas_test` + a temp notes root — never the application DB):**

```
$ DATABASE_URL=…/atlas_test NOTES_ROOT=$TMP/notes EXPORT_DIR=$TMP/exports \
  .venv/bin/python -m atlas.export run --user owner@example.com
export ok: 20261027T115649Z-e11a4ce5
  directory: $TMP/exports/atlas-export-20261027T115649Z-e11a4ce5
  projects: 1  tasks: 2  notes: 2  note-project links: 1
  files: 4
$ .venv/bin/python -m atlas.export list      # ok atlas-export-20261027T115649Z-e11a4ce5
$ .venv/bin/python -m atlas.export verify    # ok $TMP/exports/atlas-export-20261027T115649Z-e11a4ce5  (exit 0)
$ printf 'tampered' >> …/notes/Other.md && .venv/bin/python -m atlas.export verify
FAILED …/atlas-export-…: notes/Other.md: checksum/size mismatch   (exit 1)
```

The set it produced (real bytes):

```
atlas-export-20261027T115649Z-e11a4ce5/
  manifest.json   # format atlas.full-export, format_version 1, snapshot repeatable-read,
                  # contents {projects:1, tasks:2, notes:2, note_project_links:1};
                  # files: data.json (2247 B), notes.json (795 B), notes/Other.md (8 B),
                  #        notes/Plans/Launch.md (60 B) — each with its sha256
  data.json       # atlas.project-export v1: projects [Launch], filed tasks [Filed], unfiled_tasks [Unfiled]
  notes.json      # atlas.notes-index v1: notes/Plans/Launch.md projects=[<project id>]; Other.md
  notes/Plans/Launch.md   # engine bytes, byte-identical to the source (diff -q → identical; equal sha256)
  notes/Other.md
```

(`data.json`/`notes.json` shape is exercised with tags + a wiki link by the integration test, which
creates notes through the notes API so the parser populates them; the manual CLI seed inserted the
index rows directly and so shows empty tag/link lists.)

**Files added.** `services/api/atlas/export/{__init__,document,service,verify,cli,__main__}.py`,
`services/api/atlas/api/export.py`, `services/api/tests/unit/test_export_document.py`,
`services/api/tests/integration/test_export.py`. **Modified.**
`services/api/atlas/projects/export.py` (additive `unfiled_tasks` on `build_document`),
`services/api/atlas/api/{__init__,}.py` + `services/api/atlas/main.py` (router),
`services/api/atlas/config.py` (`export_dir`), `services/api/pyproject.toml`
(`atlas-export` entry point), `.env.example` (`EXPORT_DIR`), `apps/web/src/api/schema.d.ts`.

**Limitations recorded, not waived.** The `task_links` (task↔note) and `task_tags` tables exist but
have **no writer** in the codebase, so they are always empty and are not exported — recorded, not
silently dropped. Only **live** rows are exported (tombstones are sync plumbing; ADR-0026). The
export is **unbounded** (a full export must not truncate) and the HTTP response is assembled in
memory before it is sent, which is appropriate for the stated single-household scale
(`PRODUCT_SPEC.md` §7 A1); note content, however, is streamed to disk one file at a time. The
snapshot guarantee is structural (one REPEATABLE READ transaction + atomic note files), verified by
inspecting the transaction isolation rather than a non-deterministic concurrent-write race test.
Browser E2E for a download is `NOT RUN`.

---

## M9-04 — Dependency + vulnerability scan

`DEPENDS ON` M1-10 (`DONE`). Runs the **real** advisory scans over the backend and frontend dependency
trees, records every finding (here: **none**) honestly, and confirms the CI gate fails on an unresolved
critical/high. The security review (M9-05) and the full data export (M9-03) are **out of scope**.

| # | Acceptance criterion | Result | Evidence |
|---|---|---|---|
| 1 | Backend dependency scan actually run | `PASS` | `services/api/.venv/bin/pip-audit --progress-spinner off` → `No known vulnerabilities found` (exit 0); **91** distributions audited |
| 2 | Frontend dependency scan actually run | `PASS` | `apps/web$ npm audit --include=dev` / `--omit=dev` / `--audit-level=moderate` → `found 0 vulnerabilities` (exit 0); **370** locked packages |
| 3 | Every finding recorded with severity + decision; nothing suppressed | `PASS` | **No findings** at any severity (npm `info/low/moderate/high/critical = 0`; pip-audit 0 advisories). No `--ignore-vuln`, laxer threshold, or `.npmrc`/`--omit` suppression exists; the only skip is the local `atlas-api` workspace package (not a published dep) |
| 4 | A critical/high finding is remediated or recorded as an accepted risk | `PASS` (n/a) | No critical/high (or any) finding exists, so nothing to remediate or accept; recorded explicitly rather than hidden |
| 5 | CI runs the scans and fails on an unresolved critical/high | `PASS` | `.github/workflows/ci.yml`: `backend` → `pip-audit --progress-spinner off`; `frontend` → `npm audit --audit-level=moderate` — both exit non-zero on a finding. Failure semantics proven with positive controls (below) |
| 6 | The dependency inventory reflects reality | `PASS` | `docs/DEPENDENCIES.md` §"Vulnerability scan (M9-04)" (+ inventoried versions/licences) |
| 7 | No existing test weakened/removed; lint/format/type/full suite/`verify.sh` pass | `PASS` | unit `561 passed`; full `936 passed`; frontend `268 passed`; `./scripts/verify.sh` → `verification: PASS` |

**Commands run (2026-10-27) — real output.**

```
# backend (services/api)
$ .venv/bin/pip-audit --progress-spinner off
Name      Skip Reason
--------- ------------------------------------------------------------------------
atlas-api Dependency not found on PyPI and could not be audited: atlas-api (0.1.0)
No known vulnerabilities found                                   # exit 0

$ .venv/bin/pip-audit --progress-spinner off --format json   # parsed
dependencies audited: 91 ; packages WITH vulns: 0 ; skipped: atlas-api (local package)

# frontend (apps/web)
$ npm audit --include=dev ; echo $?           # found 0 vulnerabilities   -> 0
$ npm audit --omit=dev    ; echo $?           # found 0 vulnerabilities   -> 0
$ npm audit --audit-level=moderate ; echo $?  # found 0 vulnerabilities   -> 0

$ npm audit --include=dev --json   # parsed
vulnerabilities: {info:0, low:0, moderate:0, high:0, critical:0, total:0}
dependencies:    {prod:32, dev:338, optional:54, peer:8, total:370}
```

**CI gate — positive control (proves the exact commands fail a build on a finding; scratch only, the
repository was not modified).**

```
# pip-audit fails on a known-vulnerable pin:
$ printf 'urllib3==1.26.4\n' > $SCRATCH/req-vuln.txt
$ .venv/bin/pip-audit -r $SCRATCH/req-vuln.txt --progress-spinner off
urllib3 1.26.4  PYSEC-2021-108  1.26.5
… (20 advisory rows)
Found 20 known vulnerabilities in 1 package                  # exit 1

# npm audit fails on a known-high advisory:
$ mkdir $SCRATCH/npmdemo && cd $SCRATCH/npmdemo && npm init -y
$ npm install lodash@4.17.20 --package-lock-only --no-audit
$ npm audit --audit-level=high
lodash  <=4.17.23   Severity: high   (GHSA-35jh-r3h4-6jhm, +4 more)
1 high severity vulnerability                               # exit 1
```

**CI exercisability — `BLOCKED` (recorded, not claimed).** The workflow itself could **not** be run in
this environment: the `nektos/act` binary is not installed (the only `act` on `PATH` is an unrelated
local tool) and there is no remote to push a `pull_request`/`push` run to. The CI gate is therefore
confirmed by **inspection** of `.github/workflows/ci.yml` plus the positive controls above, which prove
the exact gated commands exit non-zero on a finding.

**Files changed.** `docs/DEPENDENCIES.md` (inventory + scan section), `docs/ACCEPTANCE.md` (this
section), `docs/ROADMAP.md` (M9-04 row → `DONE` + verification paragraph), `docs/RISKS.md` (R-17 review
entry), `docs/CHANGELOG.md`, `project/CURRENT_TASK.md`. **No code, dependency version, lockfile or test
was changed** — every scan was clean, so there was nothing to upgrade or pin, and **no CI change was
required** (the gate already existed and is stricter than the acceptance).

---

## M9-05 — Security review (threat model vs implementation)

`DEPENDS ON` M9-04 (`DONE`). Walks the `SECURITY.md` §2 threat model against the **delivered**
implementation and its tests, records each finding honestly, fixes real defects and records residual
risks. This is a **review** task: it changes no behaviour except the one defect it fixes (F1). The
upgrade/rollback docs (M9-06), user/operator docs (M9-07) and release checklist (M9-08) are **out of
scope**; M5/M6 (real calendar accounts) and M8's remaining device tasks are not delivered and are
reviewed as such, not as live.

### Per-control result

| # | Threat-model control | Result | Evidence (code + test) |
|---|---|---|---|
| T1 | Compromised browser session | `PASS` | HttpOnly/SameSite session + CSRF double-submit + revocation + auth rate limiting. `atlas/api/auth.py`, `atlas/middleware.py`, `atlas/auth/csrf.py`, `atlas/auth/ratelimit.py`; `test_security.py::test_session_cookie_is_httponly_and_samesite`, `test_auth_flow.py::test_logout_revokes_session`/`test_csrf_required_for_authenticated_writes`, `test_csrf.py`, `test_ratelimit.py`, `test_config.py::test_secure_cookies_only_in_production` |
| T2 | Stolen OAuth token | `PASS` (store) | AES-256-GCM at rest, key off-DB, tokens never logged/returned. `atlas/calendar/crypto.py`, `atlas/calendar/tokens.py`, `atlas/api/calendar.py`, `atlas/main.py`; `test_token_crypto.py`, `test_provider_credentials_api.py` (row is ciphertext; tamper → `500`; no token in responses/`422`; rotation). Real exchange `NOT RUN` (M5-00/AR-001) |
| T3 | Malicious Markdown / links | `PASS` | `marked` → `DOMPurify.sanitize`; the only `dangerouslySetInnerHTML` in the app. `apps/web/src/components/MarkdownPreview.tsx`; `MarkdownPreview.test.tsx` |
| T4 | Path traversal | `PASS` | `atlas/notes/storage.py` (reject `..`/absolute, reserved dir, `resolve()` parents check, trash on delete); `test_note_paths.py`, `test_note_storage.py`, `test_notes_api.py::test_path_traversal_is_rejected` |
| T5 | SQL injection | `PASS` | Parameterised ORM/bound SQL only; static raw statements. `test_tasks_filters.py::test_search_escapes_like_metacharacters`, `test_task_filters.py::test_the_like_pattern_escapes_wildcards_and_the_escape_character` |
| T6 | Cross-site scripting (incl. CSP) | `FAIL` → **fixed (F1)** | API headers tested (`test_health.py::test_security_headers_present`) but the **SPA document had none** — F1, fixed in `apps/web/nginx.conf`. Live nginx effect `NOT RUN` |
| T7 | Unauthorised API access | `PASS` | `CurrentUser` on every data router; anonymous set is exactly `/health`, `/health/ready`, `/api/setup/status`, `/api/auth/setup`, `/api/auth/login`. `test_*_require_authentication` (tasks, projects, project export, notes, note-links, changes, task-changes, calendar, notifications, reminders, export) |
| T8 | Compromised dependency | `PASS` | M9-04: `pip-audit` 0/91; `npm audit` 0/370; CI fails on a finding |
| T9 | Accidental public exposure | `PASS` (config) | `deploy/docker-compose.yml` (`db` loopback-only, `worker` no ports); HSTS + docs-disabled in prod + host allow-list. TLS termination `NOT RUN` (operator proxy) |
| T10 | Corrupted / incomplete backups | `PASS` | M9-01/ADR-0041 + M9-02 executed restore drill |
| T11 | Malicious / compromised client | `PASS` | Pydantic boundaries, `base_revision` `409`, idempotency keys, user-scoped services; `test_idempotency.py` + revision/cross-user tests |
| T12 | Work data on an unauthorised server | `NOT RUN` | Enforcing selection UI is M5-05 (not delivered); documented in `PRODUCT_SPEC.md`/`CALENDAR_SYNC.md` |

**New evidence added by this review:** `test_security.py::test_production_sets_hsts_and_disables_interactive_docs`
(proves the production-only HSTS + docs-disabled branches of the T9 posture, previously inspected only).

### Findings

| ID | Severity | Finding | Remediation | Status |
|---|---|---|---|---|
| F1 | Low | The SPA document/assets (served by nginx) carried **no** security headers or CSP; the API's headers cover `/api` responses only, so the T6 "strict CSP on the app" was only partly implemented. Practical XSS limited (React escaping + DOMPurify) — defence-in-depth gap | Added `X-Content-Type-Options`/`X-Frame-Options`/`Referrer-Policy`/`Permissions-Policy` + a CSP sized for the built app to `apps/web/nginx.conf` (scoped to the SPA location). Effect verified by inspection; live browser check `NOT RUN` | **Fixed** |
| R-21 | Low | Push destination `endpoint` not constrained to an `https` push-service host (delivery targets it directly) | Accepted for the single-user model; recorded in `RISKS.md` R-21; revisit if multi-user is approved | Accepted (residual) |

**Nothing was suppressed**; no scanner/gate finding was ignored. No other defect was found.

### Commands run (2026-10-27) — real output

```
# services/api
$ .venv/bin/ruff check .                     -> All checks passed!
$ .venv/bin/ruff format --check .            -> 210 files already formatted
$ .venv/bin/mypy                             -> Success: no issues found in 107 source files
$ .venv/bin/python -m pytest tests/unit -q   -> 582 passed
$ TEST_DATABASE_URL=…atlas_test .venv/bin/python -m pytest -q -> 969 passed
$ pytest tests/integration/test_security.py -q -> 5 passed   # incl. the new production-posture test

# apps/web
$ npm run lint && npm run typecheck && npm run test -> 268 passed (40 files)

# repo root
$ ./scripts/verify.sh                        -> verification: PASS
```

**Baseline:** full suite began at **968 passed** (unit **582**); this review adds **1** integration
test → **969**. Frontend unchanged at **268**. No existing test was weakened or removed.

### Controls not verifiable here (`NOT RUN`/`NOT DELIVERED`)

| Item | Status | Reason |
|---|---|---|
| TLS/HTTPS termination + reverse-proxy config (T9) | `NOT RUN` | Operator's proxy, outside this environment (`DEPLOYMENT.md` §8) |
| Real OAuth token exchange / provider sync (T2) | `NOT RUN` | M5-00 `BLOCKED` (AR-001) |
| Live browser effect of the SPA CSP/headers (F1) | `NOT RUN` | nginx is not run by `scripts/verify.sh` or the Playwright suite (`vite preview`) |
| Work-account data-flow acknowledgement UI (T12) | `NOT DELIVERED` | M5-05 |

**Files changed.** `apps/web/nginx.conf` (F1 fix), `services/api/tests/integration/test_security.py` (new
production-posture test), `docs/SECURITY.md` (review record), `docs/RISKS.md` (R-21 + review log),
`docs/ROADMAP.md` (M9-05 row → `DONE` + verification paragraph), `docs/ACCEPTANCE.md` (this section),
`docs/CHANGELOG.md`, `project/CURRENT_TASK.md`. No other source or test was modified.

---

## M9-06 — Upgrade + rollback documentation, tested

`DEPENDS ON` M1-04 (`DONE`). Documents the upgrade and rollback procedures **and executes them for
real** against scratch databases, so the runbook matches what was actually run. No migration, code or
test changed — the drills exercise the existing Alembic migrations and the M9-01 `atlas-backup` CLI.
The M9-05 F1 security-header fix is confirmed **live** here. M9-07 (user/operator docs) and M9-08
(release checklist) are **out of scope**.

| # | Acceptance criterion | Result | Evidence |
|---|---|---|---|
| 1 | An upgrade drill is executed from a previous revision/state via the documented command(s) | `PASS` | scratch `atlas_upgrade_drill` at `51b31762f974` (+ seeded user/task) → `alembic upgrade head` applied all 11 later revisions → `f1b2c3d4e5a6 (head)` |
| 2 | The upgraded schema matches the models (`compare_metadata == []`) | `PASS` | `schema_check.py` → `diffs: []` / `RESULT: MATCH`, exit 0 |
| 3 | Representative prior data survives the upgrade | `PASS` | `SELECT` returns the seeded `drill@example.com` and `UPGRADE-DRILL-TASK-7` with identical values |
| 4 | The app is healthy against the upgraded database | `PASS` | `GET /health` → `200 {"status":"ok","version":"0.1.0"}`; `GET /health/ready` → `200 {"status":"ready","database":"ok"}` |
| 5 | A rollback drill is executed (downgrade) and recovery verified | `PASS` | `alembic downgrade -1` removed `reminder_policies.is_default` + its unique index (version → `a3f7c2d8b105`); `alembic upgrade head` restored both and `compare_metadata` was `[]` again |
| 6 | A rollback by restoring an M9-01 backup is executed and verified | `PASS` | `atlas-backup run` → set `20261027T122100Z-be1ab1e7` verified `ok`; restored into `atlas_rollback_dst` (`psql -v ON_ERROR_STOP=1`, exit 0) → version `f1b2c3d4e5a6`, the known task present, `compare_metadata == []` |
| 7 | The F1 SPA security-header/CSP fix is confirmed **live** against a running web container | `PASS` | web image rebuilt and container recreated; `curl -I http://localhost:8081/` returns `X-Content-Type-Options`/`X-Frame-Options`/`Referrer-Policy`/`Permissions-Policy`/`Content-Security-Policy` on the SPA document; proxied `/health` keeps the API's headers |
| 8 | The runbook is ordered, copy-pasteable and matches what was run | `PASS` | `docs/DEPLOYMENT.md` §6–§7 (preconditions → **back up first** → apply → verify → rollback); cross-linked from `OPERATIONS.md` §2.6/§5 |
| 9 | No application DB/real data harmed; scratch targets cleaned up | `PASS` | only `atlas_upgrade_drill`/`atlas_rollback_dst` created and both dropped; remaining DBs = `atlas`, `atlas_test`, `postgres`; `atlas` never touched |
| 10 | No test weakened/removed; lint/format/type/full suite/`verify.sh` pass | `PASS` | unit `582 passed`; full `969 passed`; frontend `268 passed`; ruff/format/mypy clean; `./scripts/verify.sh` → `verification: PASS` |

**Executed drills (2026-10-27).** `$SCR` is the session scratch dir. `atlas_upgrade_drill` and
`atlas_rollback_dst` are scratch databases on the same PostgreSQL server as `atlas_test`; the
application `atlas` database and real notes were never used.

```
# --- UPGRADE DRILL ---
$ docker exec atlas-db-1 psql -U atlas -d postgres \
    -c "DROP DATABASE IF EXISTS atlas_upgrade_drill;" -c "CREATE DATABASE atlas_upgrade_drill OWNER atlas;"
DROP DATABASE / CREATE DATABASE
$ DATABASE_URL=…/atlas_upgrade_drill .venv/bin/alembic upgrade 51b31762f974
INFO  Running upgrade  -> eefce463b569, initial schema
INFO  Running upgrade eefce463b569 -> 50c01dbff23c, notes index
INFO  Running upgrade 50c01dbff23c -> 51b31762f974, tasks schema
$ docker exec -i atlas-db-1 psql -U atlas -d atlas_upgrade_drill -v ON_ERROR_STOP=1 < $SCR/seed.sql
INSERT 0 1 / INSERT 0 1 / users=1 tasks=1
$ DATABASE_URL=…/atlas_upgrade_drill .venv/bin/alembic upgrade head
INFO  Running upgrade 51b31762f974 -> f403c1b05be3, idempotency keys
INFO  Running upgrade f403c1b05be3 -> 8f1c2a7d5e04, projects schema
INFO  Running upgrade 8f1c2a7d5e04 -> f2a9c7d14b60, note↔project association
INFO  Running upgrade f2a9c7d14b60 -> c7d18e93a4f2, provider credentials
INFO  Running upgrade c7d18e93a4f2 -> 9d2f4b6a1c37, calendar event projections and sync cursors
INFO  Running upgrade 9d2f4b6a1c37 -> b7c2e1a9f4d0, calendar sync running marker (sync_cursors.sync_started_at)
INFO  Running upgrade b7c2e1a9f4d0 -> d4e8b2c6f913, per-user change feed store (change_log + users.change_seq)
INFO  Running upgrade d4e8b2c6f913 -> c1a2b3d4e5f6, change-feed retention: purge floor + changed_at index (M7-02)
INFO  Running upgrade c1a2b3d4e5f6 -> e5a91c3f7b64, durable reminders: policies, scheduled reminders, delivery records (M8-01)
INFO  Running upgrade e5a91c3f7b64 -> a3f7c2d8b105, notification destination registry (M8-03)
INFO  Running upgrade a3f7c2d8b105 -> f1b2c3d4e5a6, reminder policies: per-user default timing (M8-05)
$ DATABASE_URL=…/atlas_upgrade_drill .venv/bin/alembic current     # f1b2c3d4e5a6 (head)
$ docker exec atlas-db-1 psql -U atlas -d atlas_upgrade_drill -c "SELECT id,email FROM users;"
  11111111-1111-1111-1111-111111111111 | drill@example.com
$ … -c "SELECT id,title,status,priority FROM tasks;"
  22222222-2222-2222-2222-222222222222 | UPGRADE-DRILL-TASK-7 | next | high
#   post-upgrade extras: projects|change_log|reminders present; users.change_seq present
#   tables/columns after upgrade: 23 / 203
$ DATABASE_URL=…/atlas_upgrade_drill .venv/bin/python $SCR/schema_check.py
diffs: []
RESULT: MATCH                       # exit 0
$ DATABASE_URL=…/atlas_upgrade_drill .venv/bin/python $SCR/app_health.py
GET /health       -> 200 {'status': 'ok', 'version': '0.1.0'}
GET /health/ready -> 200 {'status': 'ready', 'database': 'ok'}
APP HEALTH: OK                      # exit 0

# --- ROLLBACK DRILL A: downgrade one revision, then recover ---
$ … psql -tAc "SELECT column_name FROM information_schema.columns \
    WHERE table_name='reminder_policies' AND column_name='is_default';"   # is_default
$ … psql -tAc "SELECT indexname FROM pg_indexes WHERE indexname='uq_reminder_policies_default';"
  uq_reminder_policies_default
$ DATABASE_URL=…/atlas_upgrade_drill .venv/bin/alembic downgrade -1
INFO  Running downgrade f1b2c3d4e5a6 -> a3f7c2d8b105, reminder policies: per-user default timing (M8-05)
$ … psql -tAc "SELECT count(*) … is_default;"   # 0   (column gone)
$ … psql -tAc "SELECT count(*) … uq_reminder_policies_default;"  # 0 (index gone)
$ … psql -tAc "SELECT version_num FROM alembic_version;"         # a3f7c2d8b105
$ … psql -tAc "SELECT title FROM tasks;"                          # UPGRADE-DRILL-TASK-7 (data intact)
$ DATABASE_URL=…/atlas_upgrade_drill .venv/bin/alembic upgrade head
INFO  Running upgrade a3f7c2d8b105 -> f1b2c3d4e5a6, reminder policies: per-user default timing (M8-05)
$ … psql -tAc "SELECT column_name … is_default;"   # is_default (restored)
$ … psql -tAc "SELECT count(*) … uq_reminder_policies_default;"   # 1 (restored)
$ DATABASE_URL=…/atlas_upgrade_drill .venv/bin/python $SCR/schema_check.py
diffs: [] / RESULT: MATCH            # exit 0

# --- ROLLBACK DRILL B: restore the pre-upgrade backup ---
$ DATABASE_URL=…/atlas_upgrade_drill NOTES_ROOT=$SCR/notes BACKUP_DIR=$SCR/backups \
    BACKUP_PG_DUMP_CONTAINER=atlas-db-1 .venv/bin/atlas-backup run
backup ok: 20261027T122100Z-be1ab1e7
  database: 36214 bytes sha256=ed5996d03ff509c7272375700c47bd06b0830c2eeee86c4430d59a46fa4300a6
  notes: 138 bytes (1 files) sha256=6501a3135db2b8e4711317ff0fe1702098b9122d1672b8a0121d9bacbd14d764
$ .venv/bin/atlas-backup verify $SET
ok $SET / database: ok / notes: ok    # exit 0
$ docker exec -i atlas-db-1 psql -U atlas -d atlas_rollback_dst -v ON_ERROR_STOP=1 < $SET/database.sql
  (exit 0; no ERROR/FATAL)
$ … psql -tAc "SELECT version_num FROM alembic_version;"   # f1b2c3d4e5a6
$ … psql -c "SELECT id,title,status FROM tasks;"
  22222222-2222-2222-2222-222222222222 | UPGRADE-DRILL-TASK-7 | next
$ DATABASE_URL=…/atlas_rollback_dst .venv/bin/python $SCR/schema_check.py
diffs: [] / RESULT: MATCH            # exit 0

# --- F1 LIVE CHECK (M9-05 fix) ---
$ docker compose -p atlas -f deploy/docker-compose.yml build web     # -> Successfully tagged atlas-web:latest
$ WEB_PORT=8081 docker compose -p atlas -f deploy/docker-compose.yml up -d --no-deps web
 Container atlas-web-1 Recreated / Started
$ curl -sSI http://localhost:8081/
HTTP/1.1 200 OK
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
Referrer-Policy: no-referrer
Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=()
Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; worker-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'self'; form-action 'self'
$ curl -sSI http://localhost:8081/health | head
  … content-security-policy: default-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'self'   # the API's own CSP

# --- CLEAN UP ---
$ docker exec atlas-db-1 psql -U atlas -d postgres \
    -c "DROP DATABASE IF EXISTS atlas_upgrade_drill;" -c "DROP DATABASE IF EXISTS atlas_rollback_dst;"
DROP DATABASE / DROP DATABASE
$ docker exec atlas-db-1 psql -U atlas -d postgres -tAc "SELECT datname FROM pg_database WHERE datistemplate=false;"
atlas / atlas_test / postgres

# --- VERIFICATION GATE ---
cd services/api
.venv/bin/ruff check .                       -> All checks passed!
.venv/bin/ruff format --check .              -> 210 files already formatted
.venv/bin/mypy                               -> Success: no issues found in 107 source files
.venv/bin/python -m pytest tests/unit -q     -> 582 passed
TEST_DATABASE_URL=…atlas_test .venv/bin/python -m pytest -q -> 969 passed
cd /home/kim/Documents/Atlas && ./scripts/verify.sh -> verification: PASS   (frontend 268 passed)
```

**Files changed.** `docs/DEPLOYMENT.md` (§6 upgrade + §7 rollback runbook, replacing the outline),
`docs/OPERATIONS.md` (rollback cross-link in §2.6 and the §5 failed-migration row),
`docs/SECURITY.md` (F1 live-verification note), `docs/ROADMAP.md` (M9-06 row → `DONE` + verification
paragraph), `docs/ACCEPTANCE.md` (this section), `docs/CHANGELOG.md`, `project/CURRENT_TASK.md`. No
source, migration or test was modified — the drills exercise the existing migrations and the M9-01
`atlas-backup` CLI.

**Limitations recorded, not waived.** The upgrade/rollback drills ran against **scratch databases**
with the host venv (`alembic`) rather than a full in-place upgrade of the running compose stack on an
operator host, and the backup-restore rollback was verified by querying the restored database rather
than by serving the app against it (that is the operational act in `OPERATIONS.md` §2.4). No
migration in the chain is irreversible, so the "restore the backup for an irreversible migration"
path was exercised with a general-looking set rather than a genuinely irreversible one. A real-provider
calendar-sync resumption after a restore remains `NOT RUN` (needs M5-00/AR-001).

---

## M9-07 — User + operator documentation

`DEPENDS ON` — (the README and existing docs). Delivers a person-readable **user guide**
(`docs/USER_GUIDE.md`) and **operator guide** (`docs/OPERATOR_GUIDE.md`) covering the features that
are actually shipped, honest about what is not, and linking the canonical documents instead of
forking them. No code, migration or test changed; M9-08 (release checklist + known limitations) is
**out of scope**.

| # | Acceptance criterion | Result | Evidence |
|---|---|---|---|
| 1 | A user can use the delivered features from the docs (notes; tasks Inbox/Today/Upcoming; Day/Week planning; Board; projects/progress; note search; sync/offline + `/sync`; notifications/reminder timing; calendar status; themes) | `PASS` | `docs/USER_GUIDE.md` §2–§10 — concrete steps (capture, complete, drag/status menu, conflict resolution *Keep mine*/*Take server*, reminder timing presets incl. Custom 0–30 days) matching `apps/web/src/pages/*` and `components/*` |
| 2 | An operator can install, configure, secure, back up, restore, upgrade/rollback, monitor and troubleshoot from the docs | `PASS` | `docs/OPERATOR_GUIDE.md` §3–§11 links `DEPLOYMENT.md` §4/§6/§7, `OPERATIONS.md` §1/§2/§3–§5, `SECURITY.md`; adds a troubleshooting table, a config reference and §11 "run the tests" |
| 3 | The docs are honest — undelivered/blocked features are clearly marked | `PASS` | `USER_GUIDE.md` §1 (What's in this release / what isn't) + §12; `OPERATOR_GUIDE.md` §10 + §12 "What is not delivered yet"; both name calendar accounts (M5/M6, AR-001), mobile/real push (M8), and the placeholder Tasks/Projects/Search/Settings pages |
| 4 | The docs do not duplicate canonical sources of truth — they link to them | `PASS` | Both guides are navigators: they reference `DEPLOYMENT.md`, `OPERATIONS.md`, `SECURITY.md`, `MARKDOWN_STORAGE.md`, `CALENDAR_SYNC.md`, `TESTING.md`, `PRODUCT_SPEC.md` and `.env.example`; the config reference points to `.env.example` as the canonical list |
| 5 | `README.md` links the new/updated guides; the doc set is navigable with no competing source of truth | `PASS` | `README.md` documentation table now lists `USER_GUIDE.md` and `OPERATOR_GUIDE.md`; the stale "Milestone 1 / features not implemented" banner is replaced with an accurate status pointing to `ROADMAP.md` |
| 6 | Quoted commands, paths and settings are accurate against the repository (spot-verified) | `PASS` | env names vs `.env.example` + `services/api/atlas/config.py`; entry points vs `services/api/pyproject.toml`; npm scripts vs `apps/web/package.json`; verify command vs `scripts/verify.sh`; services/volumes/ports vs `deploy/docker-compose.yml`; VAPID snippet executed successfully (`py_vapid` in the API venv) |
| 7 | A dangling cross-reference is resolved (`.env.example` → `DEPLOYMENT.md` "Web Push (VAPID keys)") | `PASS` | `docs/DEPLOYMENT.md` §3.1 "Web Push (VAPID keys)" added (generation command + the three settings + the compose-forwarding caveat) |
| 8 | No code/test changes; the suite still passes | `PASS` | only docs/README files changed; `./scripts/verify.sh` → `verification: PASS`; no `atlas` database or real data touched |

**Spot-verification performed (2026-10-27).**

- Env variable names (`ATLAS_ENV`, `PUBLIC_BASE_URL`, `ALLOWED_HOSTS`, `SECRET_KEY`, `SESSION_SECRET`,
  `TOKEN_ENCRYPTION_KEY`, `TOKEN_ENCRYPTION_KEY_ID`, `TOKEN_ENCRYPTION_PREVIOUS_KEYS`, `DATABASE_URL`,
  `NOTES_ROOT`, `NOTES_RECONCILE_SECONDS`, `BACKUP_DIR`/`BACKUP_RETAIN`/`BACKUP_INTERVAL_SECONDS`/
  `BACKUP_PG_DUMP_*`, `EXPORT_DIR`, `CHANGE_RETENTION_DAYS`, `CHANGE_PURGE_INTERVAL_SECONDS`,
  `VAPID_*`, `GOOGLE_*`, `MICROSOFT_*`) checked against `.env.example` and
  `services/api/atlas/config.py`.
- Entry points `atlas-worker` / `atlas-migrate` / `atlas-backup` / `atlas-export` and their module
  targets checked in `services/api/pyproject.toml`; `atlas-backup run|verify|list` and
  `python -m atlas.export run|verify|list` confirmed on the CLI.
- npm scripts `dev`/`build`/`typecheck`/`lint`/`test`/`e2e`/`gen:api` confirmed in
  `apps/web/package.json`; `verify.sh` contents read to quote the verification command accurately.
- Compose services (`db`/`api`/`worker`/`web`), volumes (`atlas-db`/`atlas-notes`/`atlas-backups`) and
  published ports confirmed in `deploy/docker-compose.yml`; the "compose forwards a subset of
  variables" caveat was verified by inspecting the `environment:` blocks.
- The VAPID generation snippet was **executed** (generated a pair; `Vapid.from_string` accepts the
  printed private key), so the documented command is known-good.

**Files changed.** Added `docs/USER_GUIDE.md`, `docs/OPERATOR_GUIDE.md`; changed `README.md`,
`docs/DEPLOYMENT.md` (§3.1), `deploy/README.md`, `apps/web/README.md`, `docs/ROADMAP.md` (M9-07 row →
`DONE` + verification paragraph), `docs/ACCEPTANCE.md` (this section), `docs/CHANGELOG.md`,
`project/CURRENT_TASK.md`. No source, migration or test file was modified.

**Limitations recorded, not waived.** The guides were reconciled against the code and the executed
milestone evidence, but the end-user flows were **not** clicked through in a browser here (the
Playwright suite covers sync/push consent only; M9-07 is docs). The compose-forwarding gap
(`VAPID_*`/`GOOGLE_*`/`MICROSOFT_*`/`ALLOWED_HOSTS`/`EXPORT_DIR`/`CHANGE_RETENTION_DAYS` not forwarded
to the containers) is **documented** as an operator caveat, not fixed — changing `deploy/docker-compose.yml`
was out of scope. The release label and the consolidated known-limitations list remain M9-08.

---

## M9-08 — Release checklist + known limitations

`DEPENDS ON` M9-01…M9-07 (`DONE`). Produces the **release document** and fills the **Release
Readiness** table above with honest verdicts. This is a **documentation/assessment** task: it changes
**no code, migration or test**, and it does **not** start or claim the work blocked on external
resources (M5-00/03/04/05/07/09, M6, M8-04/06/07/08).

| # | Acceptance criterion | Result | Evidence |
|---|---|---|---|
| 1 | A release checklist + known-limitations document exists | `PASS` | [`docs/RELEASE.md`](RELEASE.md) — §3 pre-release checklist (build/tests/security/backup/restore/upgrade/docs), §5 consolidated known limitations, §1 label |
| 2 | The document is **labelled by actual completeness** and explicitly **not production-ready** while M5/M6/M8 gates are open | `PASS` | `RELEASE.md` §1: label **`0.1.0-pre` — development snapshot · NOT production-ready**, with the three open gates (M5/M6/M8) and the reason each is open |
| 3 | The `ACCEPTANCE.md` "Release Readiness (M9)" table is filled per REQ-001…015 with honest `PASS`/`PARTIAL`/`NOT RUN` + evidence, citing the delivering milestone; no requirement overstated | `PASS` | at M9-08 time (since re-scored, see roll-up below): 9 `PASS`, 3 `PARTIAL` (REQ-010/011/012), 3 `NOT RUN` (REQ-007/008/009); blocked/incomplete delivery is **not** marked `PASS` |
| 4 | The open/blocked milestones and tasks are listed with their impact | `PASS` | `RELEASE.md` §2 and §6; the REQ-007/008/009 `NOT RUN` rows above cite M5-00/03/04/05/07/09 and AR-001, and the M8 device tasks |
| 5 | The operator caveat about the Compose env-forwarding gap is included | `PASS` | `RELEASE.md` §5.3 item 7 — `VAPID_*`, `GOOGLE_*`, `MICROSOFT_*`, `ALLOWED_HOSTS`, `EXPORT_DIR`, `CHANGE_RETENTION_DAYS`, … not forwarded by `deploy/docker-compose.yml` (documented in `OPERATOR_GUIDE.md` §4.6, **not** fixed here) |
| 6 | Residual risks (R-SEC-*, R-17, R-20, R-21) are recorded | `PASS` | `RELEASE.md` §5.5/§5.4 — R-SEC-1/2/4, R-21, R-17, R-20, session TTL, T12, licence caveat |
| 7 | `README.md` points at the release document; `CHANGELOG.md` carries a release entry labelled by completeness | `PASS` | `README.md` status block → `docs/RELEASE.md`; `CHANGELOG.md` `## [0.1.0-pre]` heading with the label |
| 8 | The docs are consistent with `ROADMAP.md`/`ACCEPTANCE.md` (no competing truth) | `PASS` | the M9-08 row is `DONE` (below); the release label matches the open M5/M6/M8 gates in `ROADMAP.md`; the REQ verdicts cite the milestone records |
| 9 | No code/test changes; `./scripts/verify.sh` still passes | `PASS` | docs + README only (see "Files changed"); `./scripts/verify.sh` → `verification: PASS` (backend **969 passed**, frontend **268 passed**) |

**Verdict labels used.** `PASS`/`PARTIAL`/`NOT RUN` follow the `ACCEPTANCE.md` vocabulary; `PARTIAL`
was chosen only where a requirement is delivered but has a real completeness/evidence gap (no literal
two-device run for REQ-010; real/mobile delivery unverified for REQ-011; mobile clients + desktop
matrix unverified for REQ-012). Every verdict and its justification is in the table above and in
[`RELEASE.md`](RELEASE.md).

**Commands run (2026-10-27).**

```
cd /home/kim/Documents/Atlas && ./scripts/verify.sh
  # backend ruff/format/mypy clean; pytest -> 969 passed; frontend lint/typecheck/vitest -> 268 passed
  # verification: PASS
```

**Files changed.** Added `docs/RELEASE.md`. Changed `docs/ACCEPTANCE.md` (this section + the Release
Readiness table), `docs/ROADMAP.md` (M9-08 row → `DONE` + verification paragraph; "Immediate Next
Tasks" refreshed), `docs/CHANGELOG.md` (`0.1.0-pre` release heading + label), `README.md` (status →
`docs/RELEASE.md`), `docs/OPERATOR_GUIDE.md` (§12 now links this release document), `project/CURRENT_TASK.md`.
**No** source, migration, dependency or test file was modified.

**Limitations recorded, not waived.** This task **assesses** completeness; it does not change it. The
release remains **not production-ready** because the M5/M6/M8 gates are open on external resources
(AR-001 real calendar accounts; real devices + a push service). `REQ-007/008/009` are `NOT RUN` and
`REQ-010/011/012` are `PARTIAL`; those are recorded, not waived. The Compose env-forwarding gap is
documented as an operator caveat but **not fixed** (changing `deploy/docker-compose.yml` was out of
scope). The end-user flows were not clicked through in a browser for this task (it is docs-only), and
the `scripts/verify.sh` gate does **not** run the browser E2E suite (a separate command).

---

## Milestones M5–M9

Acceptance criteria are listed in `ROADMAP.md`. Results are recorded here as each milestone is
executed. Entries remain `NOT RUN` until there is real evidence.

---

## MU — Usable Core (ADR-0043)

### MU-00 — Real-stack journey harness

**Result: `DONE` (local); CI job added but `NOT RUN` on GitHub Actions.** Playwright now runs against the
real FastAPI app (from `services/api/.venv`) and a fresh PostgreSQL database per run; see
[`TESTING.md`](TESTING.md) §1b.

| Criterion | Result | Evidence |
|---|---|---|
| Trivial journey passes against the real stack: setup → login → capture "Buy milk" → Inbox → reload | `PASS` | `cd apps/web && npm run test:e2e:real` → `1 passed` (`e2e-real/capture-journey.spec.ts`), run 4 times consecutively on 2026-11-01 |
| Fresh database per run; app's own database never used; no state leaks | `PASS` | `atlas_e2e_<random>` created, migrated with `atlas-migrate`, dropped in teardown; `db_admin.py` refuses non-`atlas_e2e_*` names. After the runs `select datname from pg_database` showed only `postgres, atlas, template0/1, atlas_test`; no leftover temp dirs or processes |
| One documented local command | `PASS` | `npm run test:e2e:real` (`TESTING.md` §1b) |
| Existing mocked specs keep passing | `PASS` | `cd apps/web && npm run e2e` → `7 passed` |
| Repository checks unaffected | `PASS` | `./scripts/verify.sh` → `973 passed` backend, frontend lint/typecheck/tests, `verification: PASS`; `vite.config.ts` default proxy (`localhost:8000`) unchanged unless `ATLAS_API_PROXY_TARGET` is set |
| Runs in CI | `NOT RUN` | Job `e2e-real` added to `.github/workflows/ci.yml` (PostgreSQL service, API from source in a venv, Chromium, `npm run test:e2e:real`); it could not be executed outside GitHub Actions |

Limitations: the harness is serial (one DB, one owner); the dev server (not the production build) is
served; Chromium only. Defect noticed then fixed: `.test` email addresses were rejected at setup with a bare
"Unprocessable Content"; the API now accepts them (`test_auth_schema.py`) and the client renders
FastAPI validation messages (`client.test.ts`). `.local` is still rejected.

### MU-01 — Task detail and editing; capture lands where expected

**Result: `DONE` (local); CI job `e2e-real` `NOT RUN` on GitHub Actions.** One task detail surface (side
sheet ≥ 721 px, full-screen page below) opens from Today, Inbox, Upcoming, Day, Week and the Board.
Backend additions (ADR-0044): `tags` on the task API and `POST /api/tasks/{id}/restore`; no migration.

| Criterion | Result | Evidence |
|---|---|---|
| J1 capture and plan: "Buy milk" on Today appears immediately, priority High + due tomorrow moves it to Upcoming, survives reload, stale second-tab edit shows a conflict | `PASS` | `cd apps/web && npm run test:e2e:real` → `7 passed` incl. `j1-capture-and-plan.spec.ts` (8 consecutive green runs on 2026-11-02 after fixing a focus race that had caused one J2 flake) |
| J2 triage inbox: five items scheduled (today / tomorrow / picked date), filed to a project, deleted with undo, keyboard driven | `PASS` | `j2-triage-inbox.spec.ts` (same runs); project filing verified by reading `project_id`/`status` back from the API |
| Edit title, description, status, priority, due date/time/time zone, start, tags; persisted after reload | `PASS` | `J1: every field can be edited…` (real API); component tests `TaskDetail.test.tsx`, `taskForm.test.ts` |
| Delete with undo (detail and Inbox row); restore keeps id/history/tags | `PASS` | `J1: a task can be deleted…`, J2; API `test_restore_*` (`test_tasks_api.py`) |
| Today capture sets due = today | `PASS` | J1; `Today.test.tsx` (`due_at` = today `T23:59:00`, viewer zone) |
| Enter opens, Esc closes (asks before discarding edits) | `PASS` | J1 (focus + Enter, Esc); `TaskDetail.test.tsx` |
| Server validation errors shown verbatim | `PASS` | J1 (`title: String should have at least 1 character`, `time_zone` message, no "Unprocessable"); `TaskDetail.test.tsx` |
| Stale edit never silently overwrites | `PASS` | J1 second-tab conflict → "Load latest version"; PATCH carries `base_revision` |
| Narrow screens: detail is a full page | `PASS` | `J1: on a narrow screen…` (375×800: dialog fills the viewport) |
| Backend: tags validated and user-scoped; restore idempotent; change feed announces restore | `PASS` | `test_tasks_api.py` (+6 tests); `./scripts/verify.sh` → `986 passed` backend |
| Repository checks | `PASS` | `./scripts/verify.sh` → ruff, format, mypy, pytest `986 passed`; eslint, `tsc`, vitest `302 passed`; `verification: PASS` |
| Mocked e2e still passes | `PASS` | `cd apps/web && npm run e2e` → `7 passed` |
| No stray `atlas_e2e_*` databases | `PASS` | `select datname from pg_database like 'atlas%'` → `atlas, atlas_test` after the runs |
| Runs in CI | `NOT RUN` | Job exists from MU-00; not executed outside GitHub Actions |

Limitations: UI mutations are online-only (idempotency key + `base_revision`; not queued offline, see
`RISKS.md` R-22); a real 23:59 due time is shown as "end of day" (ADR-0044); project assignment from the
detail panel is MU-02 (Inbox "File to…" works with existing projects); recurrence, subtasks and per-task
reminder in the panel are MU-04; the shortcut help overlay is MU-08; Chromium only; the date/datetime
inputs use the browser's native pickers.

### MU-02 — Projects UI

**Result: `DONE` (local); CI job `e2e-real` `NOT RUN` on GitHub Actions.** The Projects placeholder is
replaced by a project list (create, archive, restore) and a project page (description, dates, derived
progress, task list / board, linked notes). The task detail has a Project picker; the sidebar lists
active projects. No backend change: the existing projects API was sufficient.

| Criterion | Result | Evidence |
|---|---|---|
| J3 run a project: create in the UI, add tasks, file an inbox task from the task detail, complete one, move one on the board, link a note, edit, archive (leaves sidebar), restore | `PASS` | `cd apps/web && npm run test:e2e:real` → `8 passed` incl. `j3-run-a-project.spec.ts` |
| Progress is the server's derived value (ADR-0023) and refreshes after complete/move/assign | `PASS` | J3 (`0/3 · 0%` → `1/3 · 33%`, unchanged after restore); `Projects.test.tsx`, `ProjectPage.test.tsx` |
| Board moves persist; linked notes persist after reload | `PASS` | J3 (reload checks) |
| Assign / move / detach a task from the detail panel (archived projects not offered) | `PASS` | J3; `TaskDetail.test.tsx` |
| Server validation errors shown verbatim | `PASS` | `ProjectForm.test.tsx` (message unchanged, input kept); not exercised in J3 |
| Repository checks | `PASS` | `./scripts/verify.sh` → ruff, mypy, pytest `986 passed`; eslint, `tsc`, vitest `311 passed`; `verification: PASS` |
| Mocked e2e still passes | `PASS` | `cd apps/web && npm run e2e` → `7 passed` |
| No stray `atlas_e2e_*` databases | `PASS` | query of `pg_database` for `atlas_e2e_%` → empty after the runs |
| Runs in CI | `NOT RUN` | Job exists from MU-00; not executed outside GitHub Actions |

Limitations: project delete is not offered in the UI (archive only); a linked note opens the Notes page
but not that note directly (deep links arrive with MU-06); status `completed` for a project has no
control yet (the API supports it); project mutations are online-only (R-22); Chromium only.

### MU-03 — Tasks page

**Result: `DONE` (local); CI job `e2e-real` `NOT RUN` on GitHub Actions.** The Tasks placeholder is replaced
by an all-tasks page: server filters (text, status, priority, project, due range), sort, URL-held filter
state, client-side saved filters, row selection with bulk complete / move to project / delete (undo via the
restore endpoint). No backend change (ADR-0045): the existing list endpoint already supported every filter.

| Criterion | Result | Evidence |
|---|---|---|
| Filter by text, priority, project and due range; sort; state in the URL and survives reload | `PASS` | `cd apps/web && npm run test:e2e:real` → `10 passed` incl. `tasks-page.spec.ts` test 1 |
| Server validation error shown verbatim (inverted due range) | `PASS` | same journey (`due range is inverted`); `Tasks.test.tsx` |
| Saved filters persist across reload and apply via link; storage failure tolerated | `PASS` | journey test 1; `taskFilters.test.ts` (corrupt/unavailable storage) |
| Keyboard selection (Space on checkbox), bulk move, bulk complete, bulk delete + undo, row opens detail (Esc closes) | `PASS` | journey test 2; `Tasks.test.tsx` (partial failure lists the failing task and keeps it selected) |
| Repository checks | `PASS` | `./scripts/verify.sh` → pytest `986 passed`; eslint, `tsc`, vitest `329 passed`; `verification: PASS` |
| Mocked e2e still passes | `PASS` | `cd apps/web && npm run e2e` → `7 passed` |
| No stray `atlas_e2e_*` databases | `PASS` | query of `pg_database` for `atlas_e2e_%` → empty after the runs |
| Runs in CI | `NOT RUN` | Job exists from MU-00; not executed outside GitHub Actions |

Limitations: sort and the 500-row cap are client-side/page-bound (a notice shows when hit); one priority at
a time (server takes one); bulk actions are sequential and non-atomic; saved filters are per browser;
no "no project" filter; keyboard selection is checkbox-based (no shift-range or arrow-key selection);
Chromium only.

### MU-04 — Recurrence, subtasks and reminders in the task detail

**Result: `DONE` (local); CI job `e2e-real` `NOT RUN` on GitHub Actions.** The task detail gains a repeat
picker (daily / weekly / monthly / custom RRULE) with the server's preview, a subtask list with progress, and
a per-task reminder override. One backend addition: read-only `POST /api/tasks/recurrence/preview` (ADR-0046).

| Criterion | Result | Evidence |
|---|---|---|
| Repeat picker previews next occurrences from the server; bad rule shows the server message; rule saves and survives reload | `PASS` | `cd apps/web && npm run test:e2e:real` → `12 passed` incl. `mu04-…spec.ts` test 1; `TaskDetail.test.tsx`; `taskForm.test.ts` |
| Completing a repeating task completes only that occurrence, shows/open the next, and shows the series end (`COUNT=2`) | `PASS` | same journey (API read-back: statuses `completed`+`inbox`, then `completed`+`completed`) |
| Subtasks: add, complete, open (and back to parent), remove; progress follows the server rollup; list row shows it | `PASS` | journey test 2; `TaskSubtasks.test.tsx` |
| Per-task reminder: preset, server-rejected custom value (verbatim), reload, clear to default; delivery unchanged | `PASS` | journey test 2; `TaskReminder.test.tsx`; no change under `atlas/reminders` |
| Preview endpoint: server occurrences incl. DST, verbatim 422s, auth required | `PASS` | `tests/integration/test_tasks_api.py` (6 new cases) |
| Repository checks | `PASS` | `./scripts/verify.sh` → ruff, format, mypy; pytest `992 passed`; eslint, `tsc`, vitest `352 passed`; `verification: PASS` |
| Mocked e2e still passes | `PASS` | `cd apps/web && npm run e2e` → `7 passed` |
| No stray `atlas_e2e_*` databases | `PASS` | `docker exec atlas-db-1 psql … pg_database like 'atlas_e2e_%'` → empty |
| Runs in CI | `NOT RUN` | Job exists from MU-00; not executed outside GitHub Actions |

Limitations: an occurrence's rule is read-only (no edit/stop of a series from the UI); the next-occurrence
notice is found via the task list (≤ 500 open matches by title); a preview shows five occurrences; the
panel's subtask and reminder actions are immediate and online-only (R-22); no weekday/month-day builder
(use a custom RRULE); Chromium only.

### MU-05 — Command palette, quick switcher and unified search

**Result: `DONE` (local); CI job `e2e-real` `NOT RUN` on GitHub Actions.** Ctrl/Cmd+K opens a palette that finds
notes, tasks and projects and runs commands; the Search page is replaced by full results from the same
endpoint `GET /api/search` (ADR-0047). One migration: `a8c4d9e2b7f1` (two additive GIN indexes).

| Criterion | Result | Evidence |
|---|---|---|
| J5: shortcut opens palette; grouped results for notes (incl. body text), tasks, projects; Enter opens each; go-to and theme commands; create task/note/project from the same box; Enter alone creates nothing; server error verbatim; Search page | `PASS` | `cd apps/web && npm run test:e2e:real` → `13 passed` incl. `j5-find-anything.spec.ts` |
| Endpoint is user-scoped, bounded (`limit` per group), parameterised; hostile/empty text harmless; invalid parameters `422`; auth required; open before closed; deleted items hidden | `PASS` | `tests/integration/test_search_api.py` (cases incl. another user's note/task/project never returned) |
| Indexed (R-20, search path): planner uses `ix_tasks_search_fts` / `ix_projects_search_fts` | `PASS` | `test_task_and_project_queries_use_their_indexes` (EXPLAIN of the endpoint's statements, 3 000 rows, seq scan disabled) |
| Migration: clean upgrade from base, matches models, downgrade one step then upgrade restores exactly the two indexes; non-destructive | `PASS` | pytest session fixture (base → head), `test_migrations_match_models`, `test_migration_adds_and_removes_the_search_indexes` |
| Palette a11y/keyboard: combobox/listbox/option roles, `aria-activedescendant`, arrows wrap, Enter, Esc, Tab trap, Ctrl/Cmd+K toggle | `PASS` | `CommandPalette.test.tsx`, `Layout.test.tsx`, `palette.test.ts`, `Search.test.tsx` |
| Repository checks | `PASS` | `./scripts/verify.sh` → ruff, format, mypy; pytest `1011 passed`; eslint, `tsc`, vitest `378 passed`; `verification: PASS` |
| Mocked e2e still passes | `PASS` | `cd apps/web && npm run e2e` → `7 passed` |
| No stray `atlas_e2e_*` databases | `PASS` | `docker exec atlas-db-1 psql … pg_database like 'atlas_e2e_%'` → empty |
| Screen-reader behaviour / mobile layout of the palette | `NOT RUN` | no assistive-technology or device run; roles verified by tests only (MU-08 axe pass) |
| Runs in CI | `NOT RUN` | Job exists from MU-00; not executed outside GitHub Actions |

Limitations: word-prefix matching only (no mid-word substring, no typo tolerance); palette shows 6 hits per
group; creating from the palette is online-only (R-22); a note found by body text shows no snippet; after a
task is saved from the palette the page behind is remounted (its transient state resets); `Search · Ctrl K`
button is the only touch entry point; Chromium only.

### MU-06 — Note ↔ task ↔ project linking

**Result: `DONE` (local); CI job `e2e-real` `NOT RUN` on GitHub Actions.** A task can be created from the
text/line under the cursor in a note (explicit action, ADR-0048); the note lists its tasks and projects, the
task detail lists its notes; `[[` completes note paths. One migration: `b7d3e1a95c24` (additive index).

| Criterion | Result | Evidence |
|---|---|---|
| J4: `[[` picks a note; a checkbox line is not a task until "Task from selection"; title cleaned; too-long title refused with the server's text; task filed in the note's only project; note lists task + project; unsaved editor text untouched; save keeps the link text and the target note gets the backlink; task opens from the note; task detail lists the note; rename keeps the link; open-note and unlink from the task | `PASS` | `cd apps/web && npm run test:e2e:real` → `14 passed` incl. `j4-write-and-link.spec.ts` |
| Backend: link both ways, project in note detail, rename survival, unlink idempotent, one change-feed row; retry with same `Idempotency-Key` = 1 task + 1 link (different body with the same key = 409); delete/undo of task and note hide/restore the link; invalid input writes nothing; another user's/unknown ids are 404 and nothing of the caller's changes; auth required | `PASS` | `tests/integration/test_task_note_links.py` (7 tests) |
| Migration: clean upgrade from base, matches models, upgrade from previous head, downgrade one step, upgrade again, `alembic check` clean; non-destructive | `PASS` | pytest session fixture (base → head), `test_tasks_schema.py` drift check, manual run on a scratch database (dropped afterwards): `a8c4d9e2b7f1 → b7d3e1a95c24 → a8c4d9e2b7f1 → b7d3e1a95c24`, `No new upgrade operations detected` |
| Components: title from selection, `[[` completion rules, linked notes in the task detail, note page backlinks/tasks/projects, create form (project hint, verbatim server error, cancel) | `PASS` | `noteLinks.test.ts`, `TaskNotes.test.tsx`, `Notes.test.tsx` |
| Repository checks | `PASS` | `./scripts/verify.sh` → ruff, format, mypy; pytest `1018 passed`; eslint, `tsc`, vitest `406 passed`; `verification: PASS` |
| Mocked e2e still passes | `PASS` | `cd apps/web && npm run e2e` → `7 passed` |
| No stray `atlas_e2e_*` databases | `PASS` | `docker exec atlas-db-1 psql … pg_database` → only `atlas`, `atlas_test`, `postgres` |
| CodeMirror completion popup rendering/keyboard in a unit test | `NOT RUN` | covered only by J4 in Chromium (the pure matching is unit tested) |
| Runs in CI | `NOT RUN` | Job exists from MU-00; not executed outside GitHub Actions |

Limitations: a task can be linked to a note only at creation ("Task from selection"); there is no "link an
existing task" action; links are not parsed from or written into the note file; `[[` offers the notes loaded
in the page and does not alias or insert headings; wiki links are path-based, so renaming a note does not
rewrite `[[old/path]]` text in other notes (the task/project links, keyed on note id, do survive); an
externally renamed file that reconciliation sees as a new file gets a new id and loses its task links (same
as note↔project links); UI mutations are online-only (R-22); Chromium only.

---

## Release Readiness (M9)

Filled by **M9-08** (2026-10-27). Each `REQ-001…015` (defined in [`PRODUCT_SPEC.md`](PRODUCT_SPEC.md) §3)
is scored against the **delivered and verified** state, citing the milestone that delivered it. The
roll-up, the release label and the consolidated known-limitations list are in
[`RELEASE.md`](RELEASE.md).

Verdicts: **`PASS`** = the requirement is delivered and demonstrably works under realistic conditions;
**`PARTIAL`** = delivered but with a material completeness/evidence gap; **`NOT RUN`** = not delivered
(blocked). A requirement is **not** marked `PASS` where its delivery is blocked or incomplete.

| Requirement | Result | Delivering milestone | Evidence / notes |
|---|---|---|---|
| REQ-001 Self-hosted | `PASS` | M1 (+ M9 ops) | Core app, database and worker run on user-controlled infrastructure via one Docker Compose stack (`web/api/worker/db`); M1 gate (`PASS`): clean install, data survives restart, auth enforced, migrations reproducible. Operator tooling (`atlas-backup`, `atlas-export`) is local. No mandatory external service for the delivered surface. |
| REQ-002 Free to use (qualified by §3.1) | `PASS` | M0/M1 (design) + M9-04 | No paid *application* feature; every runtime dependency is open-source (`DEPENDENCIES.md`). The §3.1 platform costs (iOS Apple Developer Program fee; free FCM/optional relay) are **platform** costs, disclosed, not application licence costs. |
| REQ-003 Commercial-use rights | `PASS` | M1-10 + M9-04 | Complete dependency/licence inventory (`DEPENDENCIES.md`); all licences permit intended personal + workplace use (MIT/BSD/Apache/LGPL/MPL/CC0; `psycopg` LGPL used unmodified as a library). Standing pre-release action: re-verify identifiers upstream (`DEPENDENCIES.md`). |
| REQ-004 Markdown notes | `PASS` | **M2** (gate `PASS`) | Notes are real `.md` files, byte-identical on disk, path-traversal-safe, revision-aware with conflict copies; M9-03 exports the genuine note bytes. Tests: `test_notes_api.py`, `test_note_paths.py` (M2 gate). |
| REQ-005 Task management | `PARTIAL` | **M3** (gate `PASS`) + M4-02 | All required capabilities delivered and integration-tested over HTTP: Inbox/Today/Upcoming (+ Day/Week planning, Board), due dates & priorities (DST-correct), recurrence (RRULE), subtasks, project assignment. **Re-scored `PARTIAL` 2026-11-01 (ADR-0043):** the function audit showed the owner cannot edit a task, set a due date or priority, delete, or assign a project in the UI (capture is title-only; Complete is the only row action), so the requirement is not satisfied as a user-facing capability. Returns to `PASS` when MU-01…MU-04 journeys J1/J2 pass in a browser against the real API. **Progress 2026-11-02:** J1 and J2 pass (MU-01: edit, date, priority, tags, delete+undo, Inbox triage); the Tasks page (MU-03) passes; recurrence, subtasks and per-task reminders in the UI (MU-04) pass (`mu04-…spec.ts`). Returns to `PASS` with the next full release re-score. **2026-11-03 (UX-11, ADR-0064):** the standalone Board page is removed by owner decision; Kanban stays delivered inside projects (project Board tab, `ux07`/`ux11`/J3); tasks with no project are on no board. |
| REQ-006 Project management | `PARTIAL` | **M4** (gate `PASS`) | Projects, task lists, Kanban board, derived progress (documented formula, ADR-0023) and note↔project links are all implemented and tested. **Re-scored `PARTIAL` 2026-11-01 (ADR-0043):** there is no way to create or edit a project in the UI (the Projects page is a placeholder), so the Board is empty for a new user. Returns to `PASS` when MU-02 journey J3 passes. **Progress 2026-11-02:** J3 passes (MU-02: create/edit/archive/restore, project page with progress, list, board and linked notes, assignment from the task detail); the Tasks-page project filter/bulk move (MU-03) also passes (journey `tasks-page.spec.ts`). Returns to `PASS` with the next full release re-score. |
| REQ-007 Google Calendar | `PARTIAL` (implemented + fixture-tested; **live compatibility UNVERIFIED**) | M5-03/M5-05 `IN_REVIEW`; **M5-00 blocked on live verification** | Read-only Stage A: OAuth (PKCE, session-bound state), adapter, selection UI, unified view. Evidence: "Calendar Stage A" below. Not verified against Google (R-76, R-13): the owner runs `CALENDAR_SYNC.md` 12.7. Writes (Stage B / M6) not built. |
| REQ-008 Microsoft Outlook | `PARTIAL` (implemented + fixture-tested; **live compatibility UNVERIFIED**) | M5-04/M5-05 `IN_REVIEW`; **M5-00 blocked on live verification** | As REQ-007 with Microsoft Graph delta (rolling window, R-79). Tenant policy (R-01) is untested against a real tenant. |
| REQ-009 Calendar consolidation | `PARTIAL` (implemented + fixture-tested; **live data UNVERIFIED**) | M5-05/M5-07/M5-11 `IN_REVIEW` | Unified Day/Week/Month/Agenda view over Google, Microsoft and ICS feeds (ProtonMail via "Share via link"), colour per calendar, time-zone-correct, all-day and recurring, read-only. Real Proton feed delay and real provider data unverified. |
| REQ-010 Cross-device sync | `PARTIAL` | **M7** (gate `PASS`) | Per-user change feed, durable offline queue, reconnect reconciliation and conflict resolution are implemented and verified by integration tests + a Chromium E2E suite. **Gap:** no **literal two-physical-device** convergence run was performed and the E2E's API is mocked (`RELEASE.md` §5.1). |
| REQ-011 Notifications | `PARTIAL` | **M8-01/02/03/05** (`DONE`) | Durable reminder scheduler (at-most-once, tz-correct), Web Push pipeline + service worker, device registry + invalidation, and reminder preferences are delivered and tested. **Gap:** real (non-mocked) browser push delivery, mobile/native push and the desktop matrix are `NOT RUN` — **M8-04/06/07/08** `BACKLOG` (need real devices/services). |
| REQ-012 OS agnostic | `PARTIAL` | M1 (web client) | The browser/PWA client is OS-agnostic by construction and is verified on **Linux** (M1/M9 gates, CI, containerised web). **Gap:** the Windows/macOS desktop matrix (**M8-08**) and the **Android/iOS** clients (**M8-06/07**) are `NOT RUN`. |
| REQ-013 Security | `PASS` | M1 + M5-01 + M9-04/05 | Strong auth (Argon2id, server sessions, CSRF, rate limiting), protected credentials (AES-256-GCM at rest, key off-DB — M5-01), server-side access control on every protected endpoint, clean advisory scans (M9-04) and a threat-model review with the one gap fixed (F1, M9-05/06). Tested backup + restore (M9-01/02). Residual accepted risks R-SEC-1/2/4, R-21; TLS termination is operator-provided (`RELEASE.md` §5.5). |
| REQ-014 Low maintenance | `PASS` | M1 + M9-06/07 | One documented Compose install; `api` runs migrations on start; upgrade/rollback runbook **executed** (M9-06); operator guide (M9-07). Operator caveat resolved 2026-11-01 (audit A-04): Compose now forwards every setting the app reads; runtime re-check pending. |
| REQ-015 Data portability | `PASS` | M4-07 + M9-03 | Full, complete export of notes (real `.md`), tasks (incl. unfiled), projects and metadata in open formats, with a versioned manifest, via `GET /api/export` and the `atlas-export` CLI; project export is versioned (ADR-0026/ADR-0042). |

**Roll-up (re-scored 2026-11-01).** 7 requirements `PASS` (REQ-001/002/003/004/013/014/015), 5 `PARTIAL`
(REQ-005/006/010/011/012), 3 `NOT RUN` (REQ-007/008/009). **Update 2026-11-10:** REQ-007/008/009 are now `PARTIAL`
(read-only Stage A implemented and fixture-tested; live compatibility UNVERIFIED; see "Calendar Stage A" at the end of this file). Because mandatory requirements REQ-007/008/009 are
not verified live and REQ-010/011/012 are `PARTIAL`, the release is **explicitly not production-ready** —
label and rationale in [`RELEASE.md`](RELEASE.md) §1. No requirement is overstated: the blocked
calendar work (AR-001) and the device-bound notification/mobile work are recorded, not waived.

### MU-07 — Daily note, templates and Today as home

**Result: `DONE` (local); CI job `e2e-real` `NOT RUN` on GitHub Actions.** Today (`/`) shows overdue, due today,
work scheduled to start today, a daily-note card and an empty events slot; "Today's note" creates or opens
`daily/YYYY-MM-DD.md`; notes can be started from a note in `templates/` (ADR-0049). No migration.

| Criterion | Result | Evidence |
|---|---|---|
| J6 (browser zone UTC+14): Today lists overdue / due today / scheduled and an empty events slot; "Create today's note" opens `daily/<viewer's day>.md` whose file on disk is exactly `# <date>\n`; saved text is previewed as plain text on Today (HTML not rendered); opening it again from the card and from the palette leaves revision and file unchanged and the folder holds one note; palette "New note from template" focuses the picker; the note made from a template is the plain file with `{{date}}`/`{{title}}` replaced and `{{time}}`/HTML left verbatim; creating over an existing path shows the server's message and leaves the file unchanged | `PASS` | `cd apps/web && npm run test:e2e:real` → `15 passed` incl. `j6-daily-note-and-today.spec.ts` |
| Backend: daily note `201` then `200`, never rewritten after an edit; 6 concurrent calls = one `201`, one index row, one file; a file added outside Atlas is adopted unchanged; invalid days (impossible date, short form, traversal, full-width digits, text) = `400` verbatim and nothing created; another user's row does not count; `templates/daily.md` is used; substitution cases (spaces, unknown placeholders, no re-expansion); template failures (outside `templates/`, unknown id, existing path, traversal, bad date) change nothing; `write_new` never replaces and leaves no temp file; auth required | `PASS` | `services/api/tests/integration/test_daily_notes.py` (22 tests) |
| Components: Today (groups, scheduled once and only today, daily preview as text + open, create + verbatim error, events slot), Notes (today's note, template picker, verbatim error, no templates), palette commands, helpers | `PASS` | `Today.test.tsx`, `Notes.test.tsx`, `CommandPalette.test.tsx`, `dailyNote.test.ts` |
| Repository checks | `PASS` | `./scripts/verify.sh` → ruff, format, mypy; pytest `1040 passed`; eslint, `tsc`, vitest `422 passed`; `verification: PASS` |
| Mocked e2e still passes | `PASS` | `cd apps/web && npm run e2e` → `7 passed` |
| No stray `atlas_e2e_*` databases | `PASS` | `docker exec atlas-db-1 psql … \l` → only `atlas`, `atlas_test`, `postgres` |
| Calendar events on Today | `NOT RUN` | out of scope: the slot is a placeholder until M5 |
| Date near midnight / DST for the daily note | `NOT RUN` | the day string comes from the browser; only a fixed far-ahead zone (UTC+14) is exercised |
| Runs in CI | `NOT RUN` | Job exists from MU-00; not executed outside GitHub Actions |

Limitations: the browser's zone decides "today" (no user zone setting until MU-08); a renamed daily note is not
found again, so "Today's note" creates a new one; only `{{date}}` and `{{title}}` exist, no weekly/monthly
notes; creating needs a filesystem with hard links; a stale index row for a file deleted outside Atlas gives
`409` until reconciliation runs; scheduled work is "start date is today" (no work-block entity exists);
UI mutations are online-only (R-22); Chromium only.

### MU-08 — Settings and shell polish

**Result: `DONE` (local); CI job `e2e-real` `NOT RUN` on GitHub Actions.** The Settings placeholder is replaced
(account, theme, reminders/notifications, export, backup status, instance info); a shortcut help overlay,
a mobile navigation, loading/error consistency and an axe accessibility gate were added (ADR-0050). No migration.

| Criterion | Result | Evidence |
|---|---|---|
| J7: rename (blank name shows the server's message verbatim; saved name appears in the top bar and survives reload); password change (wrong current and unchanged password show the server's messages verbatim; success keeps this browser signed in and signs a second browser context out; the new password then works as "current" and the owner's password is restored); theme radio persists across reload; reminder timing saved and read back from the API; notification status shown; export downloads `atlas-export-*.zip` starting with `PK`; backup card says the folder is not visible, then shows last backup and sizes after a manifest is written to the run's backup folder; instance card matches `GET /api/instance`; `?` opens the help (not while typing in a field), Esc closes, "Keyboard shortcuts" in Ctrl+K opens it | `PASS` | `cd apps/web && npm run test:e2e:real` -> `17 passed` incl. `j7-stay-in-control.spec.ts` |
| axe-core (WCAG 2 A/AA, 2.1 A/AA, best-practice) reports no violation on Today, Inbox, Upcoming, Day, Week, Tasks, Board, Projects, a project, Calendar, Sync, Notifications, Notes, Search, Settings in light and dark, and on the task panel, command palette and shortcut help | `PASS` after fixes | `mu08-a11y-and-layout.spec.ts`. Real findings fixed, none suppressed: light accent contrast (`color-contrast`), task panel `aside role=dialog` (`aria-allowed-role`) and its `header` (`landmark-no-duplicate-banner`, `landmark-unique`). The first runs failed on them |
| No page scrolls sideways at 375 px or 800 px (all pages above) | `PASS` | same spec; also reviewed by screenshots at both widths. Found and fixed on the way: the wrapped nav filled half of a phone screen and spare height stretched it on short pages |
| Backend: name edit (trim, blank `422` verbatim, persisted, CSRF `403`); password change rejections leave the password unchanged (too short `422`, wrong current `400`, same password `400`) and echo neither value; success revokes the other device's session, keeps this one, leaves another account's session valid, old password `401` / new `200`; rate limit `400` x limit then `429`; `GET /api/instance` (version, revision, backup state from a manifest and a staging leftover, absent folder reported as unavailable, no path/URL/secret in the body); the three endpoints return `401` without a session; `.local` accepted, `.localhost`/`.invalid` still rejected | `PASS` | `services/api/tests/integration/test_account_settings.py` (10 tests), `tests/unit/test_auth_schema.py` |
| Components: Settings (instance and backup facts, folder-not-visible message, load retry, verbatim name/password/export errors, mismatch check, fields cleared after success), shortcut help (`?`, not while typing, from the palette), palette command, Notes first-load error with retry | `PASS` | `Settings.test.tsx`, `Layout.test.tsx`, `CommandPalette.test.tsx`, `Notes.test.tsx` |
| Repository checks | `PASS` | `./scripts/verify.sh` -> ruff, format, mypy; pytest `1053 passed`; eslint, `tsc`, vitest `430 passed`; `verification: PASS` |
| Mocked e2e still passes | `PASS` | `cd apps/web && npm run e2e` -> `7 passed` |
| No stray `atlas_e2e_*` databases from this task | `PASS` | `docker exec atlas-db-1 psql -U atlas -d postgres` lists one `atlas_e2e_uxaudit_caa2ecd8`; it is not created by the harness (harness names are `atlas_e2e_<12 hex>`), predates this task and was left alone |
| `.local` addresses accepted at setup/login | `PASS` | unit test above (library list adjusted, ADR-0050 §8); not exercised in a browser |
| Backup status against a real worker-made backup set | `NOT RUN` | the journey writes a manifest by hand; the reader was not run against a set produced by `atlas-backup run` or the Compose volume layout |
| Password change over HTTPS with `ATLAS_ENV=production` cookies, or from a real second device | `NOT RUN` | the journey uses a second browser context over HTTP (test environment) |
| User time-zone setting | `NOT RUN` | not requested; "today" is still the browser's zone (ADR-0049) |
| Screen-reader and contrast review beyond axe's automated rules; other browsers | `NOT RUN` | axe finds only a share of issues; Chromium only |
| Runs in CI | `NOT RUN` | job exists from MU-00; not executed on GitHub Actions |
| Dev dependency audit | `FAIL` (pre-existing) | `npm audit --include=dev` reports a moderate `minimatch` advisory in the eslint toolchain, identical with and without the new package; recorded in `RISKS.md`, not suppressed, not fixed here (breaking tooling upgrade) |

Limitations: password change ends every other session (no per-device list); the password rate limiter is
in-process; backup status depends on the API seeing `BACKUP_DIR` and does not re-verify checksums; the theme is
per browser; email and time zone cannot be changed; UI mutations are online-only (R-22); Chromium only.

## UX — Design system and app shell (ADR-0051)

### UX-01 — Design tokens and base controls

**Result: `DONE` (local); CI job `e2e-real` `NOT RUN` on GitHub Actions.** `styles.css` now starts from the
audit §3 tokens with the neutral accent chosen in ADR-0051 (ink `#1f1f23` in light, near-white `#e7e7ea` in
dark); light and dark come from CSS (`prefers-color-scheme` plus `data-theme`), with System/Light/Dark in
Settings and a pre-paint script. Base controls, one `.pill`, one section-header rule, a tokenised CodeMirror
theme and the notes toolbar change. No backend change, no migration, no new dependency.

| Criterion | Result | Evidence |
|---|---|---|
| Only scale values in `font-size` / `gap` / `padding` | `PASS` | `apps/web/scripts/check-css-scale.mjs`, run by `npm run lint` (so by `./scripts/verify.sh`) -> `check-css-scale: OK`. The same script run on the previous `styles.css` (`git show 4ca2c41:apps/web/src/styles.css`) reports 195 violations, so it does detect them. `verify.sh` itself is protected and was not edited |
| Contrast table met in both themes (unit test reads the tokens) | `PASS` | `src/styles.test.ts` (28 tests; also checks that System-dark and explicit-Dark blocks are identical and that dark redefines every light colour token). Table below |
| Control borders reach 3:1 (WCAG 1.4.11) | `PASS` | `--border-control` 3.20–3.42 (light), 3.11–3.68 (dark) on every field surface; inputs, selects, textareas, checkboxes and radios all use it. Region dividers stay at 1.23/1.24 |
| Theme store System/Light/Dark | `PASS` | `src/lib/theme.test.ts` (9 tests: System follows and tracks the OS without `data-theme`, explicit choices stored and applied, System clears both, unknown values ignored, toggle, subscription to OS changes, no storage; the pre-paint script applies a stored value and ignores anything else; `index.html` has no inline script). Settings shows three radios; J7 still checks Dark/Light persist |
| Login and setup follow the OS theme; no light flash | `PASS` | `e2e-real/ux01-theme.spec.ts`: with a dark OS and nothing stored the login page has no `data-theme` and a `rgb(24, 24, 27)` body, switching the OS to light turns it white; with `dark` stored and a light OS, the app entry module is held back and `<html>` already has `data-theme="dark"` and `color-scheme: dark` before React mounts. Production build: `dist/index.html` loads `/theme-init.js` and the CSS `<link>` in `<head>` before any content |
| Pre-paint script compatible with the production CSP | `PASS` | throwaway check: the built `dist/` served with the exact `Content-Security-Policy` from `apps/web/nginx.conf`, in Chromium: stored dark/light and System-under-dark OS each render the right background and log no CSP violation. nginx itself is not part of the harness (same as before) |
| axe sweep clean, including the old `/notes` findings | `PASS` | `mu08-a11y-and-layout.spec.ts` now also sweeps `/notes?open=<note>` with a task-list checkbox, in both themes: `.cm-content` has `aria-label="Note content"` (`aria-input-field-name`) and preview checkboxes are named after their item (`label`). No suppressions |
| No horizontal overflow at 375 / 800 px | `PASS` | same spec (16 routes at both widths); the screenshot run also measured 0 px overflow at 1440/1024/390 on every captured page |
| J1–J7 and all other real-stack specs | `PASS` | `cd apps/web && npm run test:e2e:real` -> `19 passed` (17 existing + 2 new). Selectors changed only where the visible text changed: priority `high` -> `High` (J1); notes toolbar `path · revision N` -> path with `title="Revision N"` and `Saved` / `Unsaved changes` (J4, J5, J6) |
| Mocked e2e | `PASS` | `npm run e2e` -> `7 passed` |
| Repository checks | `PASS` | `./scripts/verify.sh` -> ruff, format, mypy; pytest `1053 passed`; eslint + scale check, `tsc`, vitest `471 passed`; `verification: PASS` |
| No stray `atlas_e2e_*` databases | `PASS` | after all runs `pg_database` lists only `atlas` and `atlas_test`; harness temp note folders removed; the owner's dev API/worker/Vite were not restarted |
| Visual review at 1440 / 1024 / 390 × light / dark | `PASS` (manual) | see below |
| Other browsers, forced colours, 200 % zoom, screen reader | `NOT RUN` | Chromium only |

**Contrast (WCAG 2.x ratio, min–max over the listed backgrounds; asserted by `styles.test.ts`).**

| Foreground on backgrounds | Required | Light | Dark |
|---|---|---|---|
| `--text` on bg, bg-sidebar, bg-raised, bg-hover, bg-selected | ≥ 7 | `#1f1f23` 13.44–16.43 | `#e7e7ea` 10.93–15.03 |
| `--text-2` on the same | ≥ 4.5 | `#52525b` 6.33–7.73 | `#b4b4bc` 6.55–9.00 |
| `--text-3` (meta, placeholder, disabled) on the same | ≥ 4.5 | `#68686f` 4.52–5.53 | `#9898a0` 4.71–6.48 |
| `--border-control` on bg, bg-sidebar, bg-raised | ≥ 3 | `#8a8a93` 3.20–3.42 | `#6e6e78` 3.11–3.68 |
| `--accent-text` (links, focus ring) on all surfaces | ≥ 4.5 | `#1f1f23` 13.44–16.43 | `#e7e7ea` 10.93–15.03 |
| `--accent` (primary button, checked box) on page surfaces | ≥ 3 | 15.34–16.43 | 12.69–15.03 |
| `--accent-contrast` on accent / accent-hover | ≥ 4.5 | `#ffffff` 10.44–16.43 | `#18181b` 14.36–17.72 |
| `--danger` on all surfaces and `--danger-soft` | ≥ 4.5 | `#b42318` 5.38–6.57 | `#ff8a80` 5.91–8.12 |
| `--warning` on all surfaces and `--warning-soft` | ≥ 4.5 | `#9a5200` 4.80–5.86 | `#f0b45b` 7.31–10.05 |
| `--success` on all surfaces and `--success-soft` | ≥ 4.5 | `#17723a` 4.90–5.99 | `#5fd38a` 7.18–9.86 |

Differences from the audit table, on purpose: the accent is neutral (ADR-0051); `--text-3` is darker in light
(`#71717a` -> `#68686f`) and lighter in dark (`#8b8b94` -> `#9898a0`), and `--text-2` dark is `#b4b4bc`, because the
audit's values fall to 3.95–4.46:1 on hover and selected rows; danger/warning/success are slightly darker in light
for the same reason.

**Screenshots** (throwaway real stack: own `atlas_e2e_*` database, API and Vite via the harness global setup;
fictional seed of 3 projects, 21 tasks incl. subtasks, a repeating task, tags and all priorities, 6 notes in
folders, a template and a daily note; 9 views × 1440/1024/390 × light/dark = 54 PNGs plus a task-detail set, in the
session scratchpad, not in the repository). What they show compared with the audit's problems:
- Today / Inbox / Tasks / project page: no solid-colour buttons left except the one primary per form (Sign in,
  Create account, Save, Create task, New project's submit); Add is quiet until text is entered; Complete,
  Today/Tomorrow, Rename and the week/day navigation are ghost buttons; Delete is red text. Priority reads
  `Urgent` (red tint), `High` (amber tint), `Medium` (neutral), `Low` (outlined); tags read `#admin` in muted text.
  Selected nav and tree rows are a grey fill, not accent.
- Section labels are 12 px muted sentence case (Overdue, Due today, Saved filters, Links, Backlinks).
- Notes (open): editor and preview no longer stop at 60 vh; both columns share one height; the gutter is dark in
  dark mode; the toolbar reads `Projects/Website/Brief.md · Saved`; preview prose 16/26 with the 72 ch cap.
- Settings: Theme is System / Light / Dark radios with the custom 16 px controls; inputs have visible outlines in
  both themes; the progress bar uses the accent instead of browser blue.
- Login and setup: dark under a dark OS (previously always light), with a raised card on the sidebar tone.
Still visible and left to later tasks: Inbox rows keep six controls (UX-03), the flat 14-item nav and the topbar
(UX-02), the notes double sidebar and 50/50 split at 1024 px (UX-05), the flattened daily-note excerpt (UX-05),
ISO dates on the project page (UX-07).

Limitations: the inline `<style>` in `index.html` relies on `style-src 'unsafe-inline'`, which the CSP already
allows for CodeMirror; in the Vite dev server CSS is injected by script, so dev mode (not production) can still
paint unstyled for a moment — the browser canvas already follows the theme there; Chromium only.

### UX-02 — App shell: rail, sectioned sidebar, status bar, mobile bottom nav

**Result: `DONE` (local, 2026-11-02); CI job `e2e-real` `NOT RUN` on GitHub Actions; not committed.** `Layout.tsx`
is a new shell: a 48 px icon rail (Today, Inbox, Tasks, Projects, Notes; Settings at the bottom), a 240 px
sidebar generated from one `NAV_SECTIONS` config (`lib/navigation.ts`; the palette reads the same list) with
sections *Planning* (Today, Inbox, Upcoming, Week), *Workspace* (Tasks, Board, Projects + active projects, Notes)
and *More* (Search, Calendar, Sync, Notifications, Settings; collapsed by default), Ctrl/⌘ B to hide it
(remembered per browser), a 24 px status bar, and on phones a header (menu, search), a bottom nav and the
sidebar as a modal drawer. The topbar is gone: name, theme and Sign out are in the sidebar footer, Search is the
sidebar's first row (rail icon when the sidebar is hidden, header icon on phones), and the palette gained
*Toggle sidebar* and *Sign out*. `/day` redirects to Today; every other route is unchanged. Icons: 24 Lucide
shapes vendored in `components/Icon.tsx` (ISC notice in `DEPENDENCIES.md`). Page contents unchanged. No backend
change, no migration, no new dependency.

| Criterion | Result | Evidence |
|---|---|---|
| At most 6 top-level destinations | `PASS` | `lib/navigation.test.ts` (rail = Today, Inbox, Tasks, Projects, Notes, Settings; one per group); `Layout.test.tsx` reads the rail's links; the phone bottom nav has 5 (`Layout.test.tsx`, `ux02-shell.spec.ts`) |
| Exactly one active item at any time (project pages and nested routes included) | `PASS` | `Layout.test.tsx`: for 16 URLs (incl. `/day`, `/projects/<active>`, `/projects/<archived>`, `/sync` inside the collapsed More section) exactly one `aria-current="page"` in *Main navigation*, it is visible, and exactly one rail item is current (`page` on its own page, `true` for a page in its group, e.g. Upcoming → Today, Sync → Settings). Real stack: `ux02-shell.spec.ts` checks the count on every old URL. A section holding the current page opens by itself |
| Status bar states, component test with mocked hooks | `PASS` | `StatusBar.test.tsx` (13 tests, `useOfflineQueue` and `useSyncStatus` mocked): Synced; Offline · 3 queued; online/offline events; 2 queued; conflicts first in the danger tone; failed changes; unreadable queue; calendar not connected / never synced / failed / unavailable / last sync time / hidden while loading; links to `/sync` and `/calendar`; Shortcuts button. It is a labelled `<footer>` with an `aria-live="polite"` sync text, not `role="status"` (pages own that role) |
| All old URLs resolve; `/day` → Today | `PASS` | `App.routes.test.tsx` (16 URLs incl. `/day?date=…`, stubbed pages) and `ux02-shell.spec.ts` (13 URLs against the real API, then `/day` lands on `/` with the Today heading) |
| Ctrl+B collapse, remembered per browser, storage wrapped | `PASS` | `Layout.test.tsx` (toggle with Ctrl and ⌘, persists across remount, focus moves to *Show sidebar*, works when `localStorage` throws), `navigation.test.ts` (storage helpers incl. malformed JSON and throwing storage), `ux02-shell.spec.ts` (survives a reload). Listed in the shortcut help (`lib/shortcuts.ts`) |
| Mobile: bottom nav, no horizontal nav strip, no page overflow at 375 / 800 px | `PASS` | `mu08-a11y-and-layout.spec.ts` overflow loop (16 routes × 375/800 px) and `ux02-shell.spec.ts` (375 px: 5-link bottom nav, sidebar and rail hidden, 0 px overflow). The old scrolling nav row and its CSS are deleted. Screenshot run: 0 px overflow on all 88 shots |
| Keyboard-only navigation, drawer focus management | `PASS` | `ux02-shell.spec.ts`: Tab reaches the skip link, Enter focuses `<main>`; Tab to the rail, Enter on Tasks opens `/tasks`; Enter on the *More* header expands it, Tab/Enter opens Sync; Ctrl+B; at 375 px Enter on *Open menu* opens the drawer with focus on *Close menu*, Esc closes it and focus returns to *Open menu*. `Layout.test.tsx` covers the drawer too (rest of the page `inert` while open, closes on navigation) |
| Landmarks, skip link, aria-current, axe clean | `PASS` | rail `nav "Destinations"`, sidebar `aside "Sidebar"` with `nav "Main navigation"`, `main#main-content`, `footer "Status bar"`, phone `nav "Bottom navigation"`. `mu08-a11y-and-layout.spec.ts` (16 routes × 2 themes + task panel, palette, shortcut help) and two new axe checks in `ux02-shell.spec.ts` (sidebar collapsed; phone drawer open): 0 violations. One finding during the work, fixed in the app: `label-content-name-mismatch` on the sidebar Search row (its `aria-label` hid the visible `Ctrl K`; the hint is now `aria-hidden` and the row is named by its text) |
| J1–J7 and every other real-stack spec, only navigation selectors changed | `PASS` | `cd apps/web && npm run test:e2e:real` → `20 passed` (19 existing + `ux02-shell.spec.ts`). Selector changes: `ensureOwner` waits for the Inbox link in the rail or the bottom nav (was any Inbox link); capture journey and J7 click Inbox/Settings in the rail; J7 and the axe spec open the palette with the *Search* button (was `Search · Ctrl K`); J7 reads the renamed owner in the sidebar instead of `.topbar`. No assertion was weakened |
| Mocked e2e | `PASS` | `npm run e2e` → `7 passed` |
| Repository checks | `PASS` | `./scripts/verify.sh` → ruff, format, mypy; pytest `1053 passed`; eslint + scale check, `tsc`, vitest `542 passed` (63 files); `verification: PASS` |
| No stray `atlas_e2e_*` databases; owner's stack untouched | `PASS` | after all runs `pg_database` has no `atlas_e2e_*`; no harness API/Vite left running; the owner's API (826156), worker (826157) and Vite (826171) kept running and were not restarted |
| Screenshots reviewed | `PASS` (manual) | see below |
| Other browsers, forced colours, 200 % zoom, screen reader, real phones | `NOT RUN` | Chromium emulation only |

**Screenshots** (throwaway real stack through the harness global setup, same fictional seed as UX-01; Today,
Inbox, Tasks, Projects, a project page, Notes (open), Settings, Sync, the palette, sidebar collapsed, drawer,
offline status bar and the task panel at 1440/1024/390 × light/dark, plus Today, Tasks, collapsed, drawer and
offline at 800 px: 88 PNGs in the session scratchpad, not in the repository). Reviewed and iterated:
- 1440/1024: rail, sidebar and status bar share the sidebar tone and hairline borders; one grey fill marks the
  current page in the sidebar and the rail icon of its group; on a project page only the project's row is
  filled (the audit's double highlight is gone); the Projects row folds its list with a chevron; More is folded.
  Status bar: `Synced · Calendar not connected … Shortcuts`.
- Collapsed: the rail alone, with *Show sidebar* and *Search* above the destinations; the page uses the width.
- 800 px: rail plus page; the sidebar opens over a scrim from the rail.
- 390 px: header `☰ Atlas ⌕`, bottom nav with labelled icons and the current one in bold; the status bar is
  hidden while synced and shows `Offline` in the warning colour above the bottom nav when offline; the drawer
  fills the height (a first capture showed it content-high: an absolutely positioned grid child with
  `align-self: start` ignores its bottom inset; fixed with `align-self: stretch`), with the Ctrl K hint and
  Shortcuts hidden on phones.
- Iterations from review: mobile header showed the page title twice (header and H1), now shows *Atlas*; the
  Shortcuts item leaked onto phones (selector specificity); active project dot now inked; sidebar width
  248 → 240 px.
Still visible and left to later tasks: page contents are unchanged (Inbox row controls UX-03, Notes' inner
panel UX-05; at 1024 px the open note is narrower than before because the shell takes 288 px instead of 220 px,
which UX-05's "sidebar starts collapsed on notes below 1280 px" addresses; Ctrl+B is the workaround now). The
sidebar has both the Search row (palette) and More → Search (the results page).

Limitations: `Day.tsx` and its unit test remain in the tree but are unrouted until the Today date picker
(ADR-0051 §2) decides whether to reuse it; the status bar re-reads the offline queue on page change, focus and
connectivity change only (the queue has no change events); "last sync" is the calendar's last successful sync
(the offline queue keeps no sync time); Settings has no item in the phone bottom nav (it is in the drawer).

### UX-03 — Task row, menus and quick actions

**Result: `DONE` (local, 2026-11-02); CI job `e2e-real` `NOT RUN` on GitHub Actions; not committed.** One
`TaskRow` (`components/TaskRow.tsx`) renders every task list: Today, Inbox, Upcoming, Week, Tasks, a project's list,
the unrouted Day view and (read-only) search results. It has a round completion checkbox, the title (opens the
detail as before), a muted meta line (parent of a subtask, project, due in the shared format and amber when
overdue, priority flag, `n/m` subtasks, `#tags`), hover/focus quick actions (Schedule for today, Pick a date, Move
to a project) and a "…" menu built on the new shared `components/Menu.tsx`: Today, Tomorrow, Next week, Pick a
date…, No date, Priority, Move to project, Status, Delete (undo toast unchanged). Board cards are compact (same
meta) and their "…" menu starts with "Move to…", replacing the per-card `<select>`. List keys `j`/`k`/Enter/`x`/
`t`/`m`/`p` (help overlay updated). Decisions in ADR-0052. No backend, schema or npm change; nine vendored
Lucide shapes added (`DEPENDENCIES.md`).

| Criterion | Result | Evidence |
|---|---|---|
| Inbox rows have ≤ 2 persistent controls | `PASS` | `ux03-rows-and-menus.spec.ts` (1440 px, pointer and focus away): every one of the 9 Inbox rows has exactly 2 controls with non-zero opacity besides the title (checkbox, "…"); `TaskRow.test.tsx` checks the two persistent controls and that the three quick actions are a separate hover group |
| J2 still passes with ≤ 2 interactions per item | `PASS` | `j2-triage-inbox.spec.ts` (keyboard: focus + Enter): today 1 (quick action), tomorrow 2 (menu, Tomorrow), a picked date 2 (picker, type + Enter), file 2 (project picker, project), delete 2 (menu, Delete) + undo; end state read back from the API unchanged |
| Each row ≤ 40 px on desktop | `PASS` | `ux03-rows-and-menus.spec.ts`: tallest `.task-row` ≤ 40 px on `/`, `/inbox`, `/upcoming`, `/tasks` and a project page at 1440×900 with seeded data incl. a long title, a subtask, overdue + priority + tag (rows are 36 px; titles truncate on one line). Week's narrow day columns wrap by design and are excluded |
| All actions work keyboard-only (Playwright) | `PASS` | `ux03-rows-and-menus.spec.ts` "every row action works from the keyboard alone": `j` from outside the list, `j`/`k`; `t` (row leaves, focus moves to the next row); `m` + type-ahead + Enter; `p`, Esc (menu closes, focus back), `p` + arrows + Enter; Tab to "…" + Enter + ↓ + Enter (Tomorrow); Tab to the *Pick a date* quick action, type + Enter; Enter opens the detail, Esc returns focus; `x` completes; on Upcoming Tab → "…" → End → Enter (Delete) and Undo; on Tasks `x` selects / deselects. API read-back confirms each change |
| Mobile Inbox with 9 items < 1,000 px | `PASS` | same spec, 390×844 with touch: `scrollHeight` < 1000 (the full-page screenshot of the seeded 10-item Inbox fits in the 844 px viewport); before UX-03 it was 2,746 px for 9 items (audit) |
| Defect 1 — subtasks shown as top-level rows with no parent | `PASS` (fixed in the UI; server semantics kept, ADR-0052 §8) | Verified first by reading the code: `TaskList` had no parent field, while the API lists subtasks in every view (ADR-0016). Regression tests: `TaskList.test.tsx` (parent named from the list, or from one `GET /api/tasks/{id}`; fails on the old `TaskList`), `TaskRow.test.tsx` (subtask: "Subtask of …", no project choice), `ux03-rows-and-menus.spec.ts` (real stack: "Subtask of UX3 launch the site" on the Inbox row) |
| Defect 2 — project page showed "Complete" on completed tasks | `PASS` | Verified first in `ProjectPage.tsx` (every task got `onComplete`). Regression: `ProjectPage.test.tsx` (parametrized: an open task's checkbox completes, a completed task's is checked and unchecking calls `setStatus(task, "in_progress")`; no `Complete …` button), `ux03-rows-and-menus.spec.ts` (real stack: checked, unchecked → API `in_progress`) |
| Board: compact cards, card menu "Move to…" instead of the select | `PASS` | `Board.test.tsx` (menu lists only the current status and the allowed targets, calls `onMove`), `pages/Board.test.tsx` (persisted move, 409 and rejected transition via the menu), `j3-run-a-project.spec.ts` (move by "…" → Move to… → In progress, survives a reload) |
| axe clean on the swept routes | `PASS` | `mu08-a11y-and-layout.spec.ts` (16 routes × 2 themes + task panel, palette, shortcut help and, new, the open row menu and its date dialog) and `ux03-rows-and-menus.spec.ts` (Inbox with full meta, a row hovered, light and dark): 0 violations. Finding during the work, fixed in the app: `region` on the menu (portalled to `<body>`, outside landmarks), now rendered inside the opener's landmark |
| Existing specs pass, selectors changed only where labels legitimately changed | `PASS` | `npm run test:e2e:real` → `22 passed` (20 existing + 2 in `ux03-rows-and-menus.spec.ts`). Changes: J2 (tomorrow and delete via the menu, the date via the picker dialog, file via the project picker; today unchanged); J3 (`getByRole("button", "Complete …")` → `getByRole("checkbox", "Complete …")`, same name; board move via the card menu, asserted by the "In progress" column); mu08 (adds the two menu axe checks); `helpers.ts` `apiCall` accepts `PATCH`. tasks-page, ux02, J1, J4–J7, MU-04 unchanged. The row trigger is named "Actions for …" so ux02's `getByRole("button", { name: "More" })` stays unambiguous |
| Lean tests | `PASS` | Component: `Menu.test.tsx` (17, parametrized keys/close reasons/submenu openers), `TaskRow.test.tsx` (25, parametrized meta/status/keys/menu entries), `TaskList.test.tsx` (4); `taskForm.test.ts` +8 (schedule helpers). One real-stack spec (`ux03-rows-and-menus.spec.ts`, 2 tests). Page tests updated in place, no near-duplicates |
| Mocked e2e | `PASS` | `npm run e2e` → `7 passed` |
| Repository checks | `PASS` | `./scripts/verify.sh` → ruff, format, mypy; pytest `1053 passed`; eslint + scale check, `tsc`, vitest `595 passed` (65 files); `verification: PASS` |
| No stray `atlas_e2e_*` databases; owner's stack untouched | `PASS` | after all runs `pg_database` has no `atlas_e2e_*`; no harness API/Vite left; the owner's API (826156), worker (826157) and Vite (826171) kept running and were not restarted; the owner's `atlas` database was not touched |
| Screenshots reviewed | `PASS` (manual) | see below |
| Other browsers, touch on real phones, screen reader, 200 % zoom, forced colours | `NOT RUN` | Chromium (desktop and mobile emulation) only; the Popover API path is exercised in Chromium only (jsdom runs the fallback) |

**Screenshots** (throwaway real stack through the harness global setup, the UX-02 fictional seed plus an Inbox
subtask and a long urgent title): Today, Inbox, Upcoming, Week, Tasks, Tasks with two rows selected, Board, a
project list and board, Search, a hovered row, a keyboard-focused row, the open "…" menu, the project menu (`m`),
the priority menu (`p`), the date dialog and the board card menu, at 1440/1024/390 × light/dark (102 PNGs in the
session scratchpad, not in the repository). Reviewed and iterated:
- 1440/1024: rows are 36 px with no borders, a grey hover fill, a round 16 px checkbox, the title on the left and
  muted meta on the right (project dot + name, date, amber when overdue, flag + "High"/"Urgent" in amber/red,
  `↳ parent`, `#tag`); the "…" is a quiet grey icon; hovering or focusing a row reveals three icons that fade
  the end of the meta. The menu is a raised panel with icons, right-aligned weekday hints and chevrons;
  submenus open in place with *Back*, the current choice ticked. Completed tasks: ticked checkbox, struck-through
  grey title. Board cards: title, meta, "…" on hover; the Inbox column of 10 cards is about 1,000 px tall (was
  2,000 px with a select per card).
- 390 px: rows are 44 px+ touch targets with the meta under the title; no hover icons; the nine-item Inbox fits
  above the bottom nav; menus open under their button and stay on screen.
- Iterations from review: tag `#` was spaced from its text (flex gap on the pseudo-element); meta items
  overlapped when they did not fit (now they keep their size and the line clips; only a long parent title
  ellipsises; on phones the line wraps); the hover icons cut the meta mid-word (now a fade); the project
  appeared on every row of its own project page (now omitted there); Week's day columns had large gaps and
  clipped dates (now wrap compactly); the board widened a phone's layout viewport by 107 px because the cards'
  screen-reader text escaped the scrolling columns (fixed with a positioned card; regression check in the UX-03
  spec, which fails without the fix). Full-page captures draw top-layer menus at a shifted position on the
  board; viewport captures (and the live page) place them correctly.
Still visible and left to later tasks: the Tasks filter form and saved filters (UX-07), the project header with
ISO dates and no Completed group (UX-07), Week's seven narrow columns at 1024 px (UX-07), list width is the full
main area (no max width yet).

Limitations: reopening lands in *In progress* (the server keeps no earlier status); a renamed parent keeps its
old title in rows until it is listed again or the page reloads; search rows are read-only (the search API
returns no revision); quick actions are not shown under `(hover: none)` (the menu has them); a keyboard `x`
does not show the optimistic tick (the row updates on the server's answer).

### UX-04 — Task detail as a property panel with per-field autosave

**Result: `DONE` (local, 2026-11-03); CI job `e2e-real` `NOT RUN` on GitHub Actions; not committed.** The task
detail is a calm property panel: an inline borderless title, property rows (Status, Priority, Due date + time,
Start, Time zone, Project, Tags) whose values open the shared menu, a searchable time-zone list or an inline
editor, an auto-growing description, then Repeat, Subtasks, Reminder and Linked notes. **There is no Save
button**: each property saves itself through a per-task save session (`lib/taskAutosave.ts`, ADR-0053). Docked
beside the list at ≥ 1280 px, an overlay with a scrim and a focus trap below that, a full-screen sheet on phones.
Header: save indicator, "…" (*Copy link*, *Delete task* with undo), Close. No backend, schema or npm change; six
vendored Lucide shapes (`DEPENDENCIES.md`).

| Criterion | Result | Evidence |
|---|---|---|
| No Save button in the task detail | `PASS` | `TaskDetail.test.tsx` ("…has no Save button"), `ux04-task-panel.spec.ts` (`getByRole("button", { name: /^Save/ })` count 0 on the real stack); `TaskReminder` has no *Set reminder* button (`TaskReminder.test.tsx`) |
| Every property persists without an extra click, verified after reload | `PASS` | `ux04-task-panel.spec.ts` test 1: title, priority (menu), due date, tags (Enter), description (typed) → Esc → reload → all read back in the panel and via `GET /api/tasks/{id}`; `j1-capture-and-plan.spec.ts` "every field…": title, description, status, priority, due date + time, time zone (searchable list), start, tags → reload on Board → all read back; MU-04 spec: repeat preset/custom rule and reminder |
| Save requests never overlap for a task | `PASS` | `taskAutosave.test.ts` "never sends two requests at once…" (held fake server; `maxInFlight` = 1, `maxConcurrent` = 1, each request built on the revision the previous one returned, queued keystrokes coalesced into one PATCH); real stack: `ux04-task-panel.spec.ts` counts overlapping `PATCH /api/tasks/{id}` (request → finished) in tests 1 and 3: max 1 |
| Stale edit → conflict UI, no overwrite | `PASS` | `ux04-task-panel.spec.ts` test 2 (two tabs: the stale tab's description edit shows *Conflict* + "changed somewhere else", keeps the local text, the server still has the first tab's title and no description; *Load latest version* shows the first tab's title, *Reapply my changes* then saves the description against the new revision); J1 test 1 (priority via the menu in the stale tab → conflict, value kept, Load latest → server values); unit: `taskAutosave.test.ts` (409 → no further sends, `flush()` false, stash only the changed values), `TaskDetail.test.tsx` |
| Rapid typing then immediate close persists | `PASS` | `ux04-task-panel.spec.ts` test 3: `keyboard.type(…, { delay: 0 })` into the description and Esc at once → panel closes after the flush → API has the full text; switching to another row while the title is pending saves it first; delete while a title edit is pending saves it first, so Undo restores it |
| Validation message verbatim, text kept | `PASS` | `ux04-task-panel.spec.ts` test 4 (empty title → blur → alert exactly "title: String should have at least 1 character", field stays empty, indicator *Not saved*, server title unchanged; Esc asks "Some changes are not saved yet: Title", *Keep editing*, fix, Esc → saved and closed); J1 validation test (title, and an unknown zone "Mars/Olympus" typed in the zone list → `time_zone` message, not "Unprocessable"); MU-04 (custom RRULE on blur, reminder days on blur) |
| Escape closes and focus returns to the row | `PASS` | `ux04-task-panel.spec.ts` test 1 (`toBeFocused` on the opening row after Esc), `ux03-rows-and-menus.spec.ts` (unchanged, still passes), `TaskDetail.test.tsx` (Esc flushes then closes) |
| Save/status indicator visible without scrolling at 900 px height | `PASS` | `ux04-task-panel.spec.ts` test 1 at 1440×900: `[data-save-state]` `toBeInViewport()`; it sits in the non-scrolling header (screenshots: same at 1024×768 and 390×844) |
| List stays visible when docked at ≥ 1280 px | `PASS` | `ux04-task-panel.spec.ts` test 1: another row's right edge ≤ the panel's left edge, panel not `aria-modal`; screenshots at 1440 |
| axe clean incl. panel states | `PASS` | `mu08-a11y-and-layout.spec.ts` now also checks the docked panel, its priority menu, the open time-zone list and the overlay at 1024 px (`aria-modal`): 0 violations (found and fixed during the work: `heading-order` after the panel lost its visible `h2` — a screen-reader-only "Task details" heading keeps the order). The sweep's timeout is raised to 90 s (it now runs ~30 s) |
| J1–J7, tasks-page, ux02, ux03 and all real-stack specs pass | `PASS` | `npm run test:e2e:real` → `26 passed` (22 existing + 4 in `ux04-task-panel.spec.ts`). Selector changes only where the UI legitimately changed: J1 (no Save; priority/status via the property menu, zone via the searchable list, tags via "Add a tag", `exact` for "Due date"/"Start" because the new clear buttons contain those words, delete via "…" → *Delete task*); J3 (project via the property menu + wait for *Saved*); MU-04 (no Save/Set reminder; custom rule saved on blur/Enter, reminder on choice/blur); mu08 (panel states). J2, J4–J7, tasks-page, ux01–ux03 unchanged. New helpers in `e2e-real/helpers.ts` (`taskPanel`, `taskProperty`, `chooseTaskProperty`, `chooseTimeZone`, `expectTaskSaved`) |
| Lean tests for the risky part | `PASS` | `lib/taskAutosave.test.ts` (18, fake timers + a fake revisioned server: debounce, serialisation + coalescing, one group per request, typed-back no-op, a kick right after an empty flush is not lost, flush on close/switch/pagehide with keepalive, 409 + load latest + reapply, 422 hidden while typing then verbatim on flush and not blocking other fields, offline then online, network failure re-sent with the same key, 5xx + Retry, focus keeps text, per-field adoption of the server-pinned zone, external adopt only when clean, hold mode, discard, registry keeps unsaved sessions and forgets deleted ones); `TaskDetail.test.tsx` (28, parametrized menu properties, repeat presets, zone queries, flush shortcuts; overlay focus trap and scrim) |
| Mocked e2e | `PASS` | `npm run e2e` → `7 passed` |
| Repository checks | `PASS` | `./scripts/verify.sh` → pytest `1053 passed`; eslint + scale check, `tsc`, vitest `623 passed` (66 files); `verification: PASS` (final run, after the last code change; real-stack `26 passed` and mocked `7 passed` re-run then too) |
| No stray `atlas_e2e_*` databases; owner's stack untouched | `PASS` | `pg_database` lists no `atlas_e2e_*` after all runs (screenshots used the same harness with teardown); only the owner's API (826156), worker (826157) and Vite (826171) are running, never restarted; the owner's `atlas` database was not touched |
| Screenshots reviewed | `PASS` (manual) | see below |
| Other browsers, real phones, screen reader, 200 % zoom, forced colours; offline across a reload | `NOT RUN` | Chromium (desktop + mobile emulation) only. Offline is exercised with Playwright `setOffline` in the screenshot run and in unit tests, not in a committed real-stack spec |

**Found and fixed during verification** (each with a regression unit test): (1) a send request arriving
while the loop was finishing (blur-flush immediately followed by a menu choice) was stranded — the loop now
re-runs; (2) after the first due-date save the server pinned the viewer's zone, but a time typed while that
request was in flight later sent `time_zone: null` (J1 read back 10:30 instead of 09:30) — the server's answer
is now adopted per field, keeping only fields the user changed since their request was built.

**Screenshots** (throwaway real stack, the UX-03 fictional seed plus a long task with ten tags, a long
description, a monthly repeat, Tokyo zone and two subtasks): panel docked at 1440×900, overlay at 1024×768,
sheet at 390×844, light and dark; the priority menu open; the time-zone list searching "eu"; the indicator in
*Saving…* (PATCH held by a route), *Saved*, *Conflict* (edited via the API underneath), *Offline — not saved*
(`setOffline`) and *Not saved* (empty title); the long task scrolled (38 PNGs in the session scratchpad
`ux04/shots`, not in the repository). Reviewed and iterated:
- 1440: the list keeps its full width minus the 400 px panel; the panel has no shadow when docked, a hairline
  left border, a 44 px header with a small grey "✓ Saved" on the left and two quiet icons on the right; a 24 px
  bold title with no box; seven 32 px property rows with grey icon + label and plain values ("Empty" in grey
  for unset ones, priority flag in amber/red for High/Urgent); tags are quiet grey `#tag` chips with a small ×;
  the description reads as text; sections below have small grey headings.
- 1024: the same panel over a dimmed scrim with a shadow; 390: a full-screen sheet, rows keep their two columns,
  ten tags wrap in three lines.
- States: *Saving…* with a spinning icon; *Conflict* in red with a red-tinted notice under the header ("…Your
  edits were not saved (Description)" + Load latest version) while the edited text stays in the field;
  *Offline — not saved* in amber with an amber notice (and the status bar's Offline); *Not saved* with the
  server's message in red under the empty title.
- Iterations from review: the title showed a heavy focus box on open (now a hairline border); tags rendered as
  `##tag` (the row's `.task-tag::before` applied; chips got their own class); date/time/tag/subtask inputs
  kept the base control border (selector specificity) and due date + time wrapped onto two lines (narrower
  fields, the clock icon of the time field hidden); multi-line values (tags, the open zone list) centred their
  label vertically (now top-aligned); "Reminder timing for this task" was truncated as a row label (now "When",
  the select keeps that accessible name).

Limitations: unsaved task edits survive closing and navigating within the tab but not a reload while offline
(no local draft store for tasks); a save failing after its panel unmounted is shown when the task is reopened;
mutations stay online-only (R-22); the native date/datetime fields show their placeholder format when empty.

### UX-05 — Notes autosave and the Notes workspace

**Result: `DONE` (local, 2026-11-03); CI job `e2e-real` `NOT RUN` on GitHub Actions; not committed.** The Notes
**Save** button, the Ctrl+S requirement and the "Discard unsaved changes?" prompts are gone. A note saves by
itself through a framework-free engine (`lib/noteAutosave.ts`, ADR-0054; `NoteStore` and `DraftStore` injected,
so a native desktop client can reuse it) with a synchronous local draft. The page is a workspace: file tree
(header icons, row menus, inline names, no path box or `window.prompt`), note header (breadcrumb, save state,
Preview, details toggle, "…" menu), full-height editor with a 72ch column, details panel (Ctrl/⌘ Alt B),
`[[links]]` in the preview, shell sidebar docked on Notes only from 1280 px. No backend, schema or npm change;
six vendored Lucide shapes (`DEPENDENCIES.md`). Order of work: the engine and its unit tests were complete and
passing (27 + 3 draft-store tests) before the Save button was removed; the real-stack specs needed the wired
page, so they were written with it and run against the final code.

| Criterion | Result | Evidence |
|---|---|---|
| No Save button or Ctrl+S requirement | `PASS` | `Notes.test.tsx` ("has no Save button…"), `ux05-notes.spec.ts` test 1 (`getByRole("button", { name: "Save" })` count 0 on the real stack); Ctrl/⌘ S only flushes (`Notes.test.tsx`, `ux05-notes.spec.ts` test 2) |
| Every edit reaches the `.md` file without a click, byte for byte | `PASS` | `ux05-notes.spec.ts` test 1: 120 ms/char typing of `ünï ✓ 日本語 — 𝄞 emoji 😀` + a second line → `[data-save-state]="saved"` → `Buffer.compare` of the file on disk with `# Typing\n` + the typed text is 0 (UTF-8, no added front matter or newline changes), `GET /api/notes/{id}` equals it, and again after `page.reload()`; J4 (typed `[[` link reaches the file via the API) and J6 (daily note typed text on disk) |
| Requests never overlap; typing coalesces | `PASS` | `noteAutosave.test.ts` "sends nothing until the typing pauses, then one request with the latest text", "never has two requests in flight and chains the revision…" (held server, `maxInFlight` = 1, `["one",1]` then `["one two three",2]`); real stack: overlapping `PUT /api/notes/{id}` counted in `ux05-notes.spec.ts` test 1 (max 1) |
| Reload / closed tab loses nothing | `PASS` | `ux05-notes.spec.ts` test "reloading right after typing loses nothing" (reload inside the 1 s pause: the `pagehide` flush with `keepalive`, else the draft, saves it; file bytes polled) and test 3 below; unit: draft written synchronously, cleared only after confirm, restored on open |
| Offline typing, reload/reopen, reconnect persists | `PASS` | `ux05-notes.spec.ts` test 3 (`context.setOffline`): indicator `offline` + "Offline — saved on this device", `localStorage` draft holds the text, file unchanged; going online sends it without a click; then offline typing, the tab goes to `about:blank`, connection returns, the note is reopened → "Restored text you typed here…" → saved, file bytes exact, draft removed. Unit: "restores offline typing after a reload and sends it once online". Not tested in a browser: a reload *while the API is unreachable* (the page cannot start without the API) |
| External file edit during typing → conflict; the file on disk is never overwritten | `PASS` | `ux05-notes.spec.ts` test "a file edited on disk while typing is a conflict…": `writeFile` on disk, then typing → `conflict` + "Nothing was overwritten", editor keeps the text, file still the other program's text after typing more and 2.5 s; *Keep my version as a copy* → a `(conflict …)` file holds our text, the original is still theirs, editor shows theirs; then typing saves normally. Needed (found by this spec): the server only notices an edit on disk after indexing, so the conflict path calls `POST /api/notes/reconcile` before re-reading |
| Stale draft is never applied silently | `PASS` | `ux05-notes.spec.ts` "reload server version drops my text; a stale draft…" (draft on revision 1 while the server is on 2 → `conflict`, draft text shown, file unchanged; *Reload server version* → server text, draft removed); unit: "never applies a draft typed on an older revision…" |
| Unknown outcome: retry, then re-read on 409 | `PASS` (unit only) | `noteAutosave.test.ts`: network failure re-sent with the same body and applied once; lost answer + retry 409 + identical server text = saved at the server's revision, no conflict; retry 409 + different text = conflict; re-read failing keeps the request and looks again; 5xx like a network failure; 422 kept with the server's message and not re-sent until edited. **NOT RUN against a real server**: producing a lost answer needs a proxy that drops a response; the backend `PUT` is exercised for 409 only |
| Conflict never overwrites; existing choices kept | `PASS` | as above; `Notes.test.tsx` ("a 409 keeps the text, shows the conflict choices…") |
| Flush before switching note / rename / pagehide | `PASS` | `ux05-notes.spec.ts` test 2 (type then click another note at once → the first file has the text; Ctrl+Z in the new note does not reach back), `Notes.test.tsx` ("flushes the note before opening another one", "renames … after saving, without a prompt"), `noteAutosave.test.ts` ("flushes every unsaved session on pagehide with keepalive") |
| Workspace: create, rename in place, move, delete; `[[links]]` in the preview | `PASS` | `ux05-notes.spec.ts` "workspace…" (inline name boxes, a `dialog` handler asserts only a delete `confirm` appears, file contents, move to a folder through the menu, delete → file in the trash and listing, preview link opens the target, unresolved link is plain text); `NoteTree.test.tsx`, `MarkdownPreview.test.tsx` |
| Layout at 1440, 1024, 720 and 390 px without horizontal scroll; editor fills the height | `PASS` | `ux05-notes.spec.ts` "layout…" (`scrollWidth ≤ clientWidth`; editor taller than half the viewport at each width; at 1024 the shell sidebar is hidden and the tree remains; Ctrl+Alt+B toggles the panel and the choice survives a reload); screenshots below |
| axe clean incl. the new states | `PASS` | `mu08-a11y-and-layout.spec.ts` now also loads the note with Preview and the details panel on (both themes, a `[[link]]` and an unresolved one), the tree row menu, the header menu, an inline name box and the panel overlay at 1024 px: 0 violations; no horizontal overflow at 375 and 800 px (found and fixed: the overlay panel first covered the header's buttons; `aside` inside `main` is not allowed, so the panel is a labelled region) |
| J1–J7, ux02–ux04 and all real-stack specs pass | `PASS` | `npm run test:e2e:real` → `34 passed` (26 + 8 new in `ux05-notes.spec.ts`). Changed selectors only where the UI legitimately changed: J4 (no Save: wait for the *Saved* indicator; *Task from selection* and *Rename* from the "…" menu; rename box instead of `window.prompt`; revision read as a pattern because autosave may use more than one save; panel opened with `openNoteDetails`), J6 (no Save; template menu + inline name box instead of the combobox and path field; the new note lands in the open folder `daily/`), mu08 (above). J1–J3, J5, J7, MU-04, tasks-page, ux01–ux04 unchanged |
| Path traversal and note ownership still enforced | `PASS` (not new) | backend tests (`pytest` 1053 passed) and J5 (`../escape` from the palette → "path traversal is not allowed"); the UI changes add no new path input except the name boxes, which the server validates and whose message is shown verbatim (J6 "already exists") |
| Mocked e2e | `PASS` | `npm run e2e` → `7 passed` |
| Repository checks | `PASS` | `./scripts/verify.sh` → ruff, ruff format, mypy (`no issues found in 114 source files`), pytest `1053 passed`; eslint + scale check, `tsc`, vitest `670 passed` (68 files); `verification: PASS` |
| No stray `atlas_e2e_*` databases; owner's stack untouched | `PASS` | `pg_database` lists only `atlas`, `atlas_test`, `postgres`, templates after all runs; the owner's `atlas` database and running stack were not used |
| Screenshots reviewed | `PASS` (manual) | see below |
| Other browsers, real phones, screen reader, 200 % zoom, forced colours; two tabs on one note; a note over 64 KB closed mid-save; drafts near the storage quota | `NOT RUN` | Chromium (desktop + mobile emulation) only |

**Screenshots** (throwaway real stack with a fictional orchard seed, scratchpad `ux05/`, not in the repository):
`desktop-light-1440.png`, `desktop-dark-1440.png`, `tablet-light-1024.png`, `phone-light-390.png`,
`phone-dark-390.png`, `desktop-preview-menu-1440.png` (Preview on, row menu open) and `phone-tree-390.png`.
Reviewed and iterated: tree rows were centred (flex `justify-content`), the details panel overlay covered the
header buttons at 1280 px (now starts below the header), the panel stayed open on a phone because the desktop
choice was remembered (now closed and unremembered on phones), the breadcrumb truncated the file name instead of
the folders (folders now give way first).

**Found and fixed during verification:** (1) a draft restored on open could finish saving before the page
listened, leaving the header on an older revision — restored text is sent only after the host calls `resume()`,
and the page also takes any newer confirmed version; (2) a conflict after an edit made by another program kept
conflicting after *Reload* because the file was not yet indexed — `reconcile` before the re-read; (3) Ctrl+Z
right after opening a note could empty it (the initial text was an undoable transaction) — initial text is the
editor's starting document and later replacements are not undoable.

Limitations: see ADR-0054 and R-23 (drafts in `localStorage`, delete uses a native `confirm`, conflicts are
copy-or-reload with no merge, tree shows note titles, structural operations online-only R-22).

### UX-06 — Live preview

**Result: `DONE` (local, 2026-11-03); CI job `e2e-real` `NOT RUN` on GitHub Actions; not committed.** A third
editor view, **Live**, made only of CodeMirror decorations (`lib/livePreview.ts`, ADR-0056); **Source** stays,
**Preview** (rendered split) is unchanged. Live is the default for a browser with no stored choice
(`DEFAULT_EDITOR_MODE`, ADR-0051 §5); it was switched on only after the corpus round-trip tests and the
real-stack Live specs passed, and then the whole real-stack suite was run with Live as the default. No backend,
schema or new npm package (`@codemirror/language` declared directly, already installed); no Lucide shape added.

| Criterion | Result | Evidence |
|---|---|---|
| Markdown on disk stays byte-identical; decorations never write the document | `PASS` | `livePreview.test.ts` corpus (19 texts × 3): load, type, replace selection, select-all, undo/redo, undo-everything give the same text as Source after every step, and selection/focus changes never change the text; `ux06-live-preview.spec.ts` "typing in Live mode…" (`Buffer.compare` of the file with original + typed UTF-8: `ünï ✓ 日本語 𝄞 😀`, markup, trailing spaces) |
| Lines without the cursor/selection hide syntax; headings, bold/italic/code/strike, links, quotes, lists, rules, fenced code, `#tags` rendered | `PASS` | `livePreview.test.ts` "rendering" and "source lines show their Markdown when the editor has focus" (no focus → all rendered; cursor line and every selected line raw); `ux06` "the line with the cursor shows its Markdown" (mouse, ArrowUp, End, typing on a revealed line); screenshots |
| Task checkbox toggles through the normal change path | `PASS` | `livePreview.test.ts` (tick → text `[x]`, undo/redo), `NoteEditor.test.tsx` (click → `onChange("- [x] one…")`), `ux06` "ticking a checkbox…" (click → saved → file text `- [x] first`, second box untick, reload keeps state, Ctrl/⌘ Enter toggles, Source shows `[ ]`/`[x]`) |
| `[[wiki links]]` clickable (alias shown as label; unknown ones inert) | `PASS` | `livePreview.test.ts`, `NoteEditor.test.tsx`, `ux06` "a [[wiki link]] opens its note…" (click opens `ux06/Target note.md`, unresolved click does nothing, the source file unchanged) |
| No HTML execution, no unsafe URL handling | `PASS` | corpus DOM scan (no `script/iframe/a/img[src]/style/svg`, no `on*` attribute, no `javascript:`/`vbscript:`/`data:text/html` attribute value) for all 19 texts, before and after edits; `safeExternalUrl` 16 cases; `ux06` "note text cannot run anything…" (`<img onerror>`, `<script>`, `<a href=javascript:>`, tracker image: no `window.__pwned`, no request to the tracker host, Ctrl+click opens only `https://example.com/`, file unchanged) |
| Mode switching keeps cursor, content and undo; preference remembered | `PASS` | `NoteEditor.test.tsx` (compartment: same `EditorView`, same selection, undo still reaches earlier typing), `notesPrefs.test.ts`, `ux06` (type `AAA`, Source, `BBB`, Live, `CCC` → contiguous in the file; reload keeps the mode; default Live with nothing stored) |
| Conflict flow works in Live | `PASS` | `ux06` "a file edited on disk while typing in Live mode is a conflict…" (`conflict` + "Nothing was overwritten", file stays the other program's, *Reload server version* works) |
| Keyboard: editor stays a textbox; hidden syntax never makes content unreachable | `PASS` | `NoteEditor.test.tsx` (`role=textbox`, name *Note content* in both modes), checkbox widgets `tabindex=-1` and named after the item, Ctrl/⌘ Enter ticks/opens; `ux06` (ArrowUp/End/typing through revealed lines). Not tested with a screen reader |
| axe clean in Source and Live, light and dark | `PASS` | `mu08-a11y-and-layout.spec.ts` (note with a link, a resolved and an unresolved `[[link]]` and a task in both modes × both themes, plus the existing note states) |
| Names stable; old specs adjusted only where rendering legitimately changed | `PASS` | `Preview`, `Links and details`, `Note content` unchanged; new group `Editor mode` with `Source`/`Live`. J4: after focus leaves the line the link is shown rendered (`See: j4/seed-list`). mu08: the Preview's checkbox is selected inside `markdown-preview`, since Live has its own |
| CRLF note kept byte for byte end to end | `BLOCKED` | The editor keeps CRLF (`livePreview.test.ts`, `NoteEditor.test.tsx`), but the server reads files with universal newlines (R-24), so a CRLF file arrives as LF and the first save reports Conflict in Source and Live alike. Needs a backend fix (out of scope) |
| Repository checks | `PASS` | `./scripts/verify.sh` → ruff, ruff format, mypy (114 files), pytest `1053 passed`; eslint + CSS scale check, `tsc`, vitest `776 passed` (71 files; UX-05 recorded 670: UX-06 added 105 in three new files, 1 further test not attributed); `verification: PASS` |
| Real-stack suite with Live as the default | `PASS` | `npm run test:e2e:real` → `42 passed` (34 + 8 new in `ux06-live-preview.spec.ts`). A first full run with the default switched found two spec problems (J4's raw `[[…]]` assertion after the cursor left the line; a UX-06 text locator that matched a tree row), both fixed in the specs, then re-run |
| Mocked e2e | `PASS` | `npm run e2e` → `7 passed` |
| No stray `atlas_e2e_*` databases; owner's stack untouched | `PASS` | `pg_database`: `atlas`, `atlas_test`, `postgres`, templates only; the owner's `atlas` database and the running dev stack were not used |
| Other browsers, real phone, screen reader, IME composition in a rendered line, 200 % zoom, very large notes (performance), fuzzing | `NOT RUN` | Chromium (desktop + 390 px emulation) only |

**Screenshots** (throwaway stack, fictional orchard note, scratchpad `ux06/`, not in the repository):
`desktop-light-source.png`, `desktop-light-live.png`, `desktop-dark-source.png`, `desktop-dark-live.png`,
`phone-390-source.png`, `phone-390-live.png`, `desktop-light-live-cursor-line.png`. Reviewed and fixed: the Live
body used the monospace face (the base theme's selector won; now `&.cm-live .cm-scroller`), a done task showed a
stray line-through dash before its checkbox (strike now covers the text only).

**Found and fixed during verification:** (1) CodeMirror's default separators turned CRLF, a lone `\r` and U+2028
into `\n` on the first keystroke, silently changing the file (now `lineSeparator` is the note's own; the sync
effect also used the wrong length for CRLF); (2) a zero-width "skip" range made every `[[link]]` that
the Markdown parser read as a shortcut reference invisible to the wiki-link scan; (3) a note-derived `title`
attribute on unresolved links put raw link text (possibly `javascript:`) into the DOM — now a fixed string
(caught by the corpus DOM scan).

Limitations: ADR-0056 and R-24, R-25 (per-line revealing, no hanging indent in wrapped list items, tables/images
as text, a press-and-drag that starts on a rendered `[[link]]` opens the note).

### UX-07 — Tasks, Projects and Board polish

**Result: `DONE` (local, 2026-11-03); CI job `e2e-real` `NOT RUN` on GitHub Actions; not committed.** Filter bar,
floating bulk bar and List | Board on the Tasks page; project rows with a tokenised progress bar and a "…" menu;
a project header with tabs (Tasks | Board | Notes) and folded Completed / Archived groups; compact board cards with
`[` / `]` and Archived behind a toggle; one date format (ADR-0057). No backend, schema, dependency or icon change.

| Criterion | Result | Evidence |
|---|---|---|
| Tasks filter UI is one row at 1440 px | `PASS` | `ux07` "filter bar…": bar height <= 48 px and every control on one row (measured) |
| Every filter works by keyboard and survives a reload via the URL (ADR-0045 unchanged; `view=board` additive) | `PASS` | `ux07` (focus chip, Enter, ↓, Enter -> `status=all`, focus back on the chip; Esc from the Due popover returns focus); `tasks-page.spec` (sort, priority, project, due range, inverted-range server message, reload keeps `Priority: High`); `Tasks.test.tsx`; `taskFilters.test.ts` |
| Saved views: save, apply, remove; persist across reload | `PASS` | `tasks-page.spec` (Filter options -> Save this view… -> reload -> Saved views -> apply); `Tasks.test.tsx` (localStorage contents, removal) |
| Bulk selection with a floating bar (complete, move, delete + undo, clear) | `PASS` | `ux07` (bar `toBeInViewport` at top, bottom and mid scroll of a 25-row list; Clear selection); `tasks-page.spec` (select all, move to project via the menu, complete, delete, Undo); `Tasks.test.tsx` (per-task failure report kept) |
| List \| Board toggle on Tasks | `PASS` | `ux07` "tasks page board" (URL `view=board`, survives reload); `Tasks.test.tsx` (no extra list request) |
| Board: compact cards, Archived behind a toggle, `[` / `]` move the focused card and keep focus, card menu "Move to…" kept | `PASS` | `ux07` (`]` -> In progress with focus and stored status, `[` back, Inbox edge announces, `]` returns); `Board.test.tsx` (7 new); `taskStatus.test.ts` `adjacentStatus` |
| Project page: header (name, status pill, progress, dates, "…"), tabs Tasks / Board / Notes, Completed (n) group | `PASS` | `ux07` "projects…" (tabs from the keyboard, `?tab=` in the URL, folded groups open on click); J3 (tab, Notes tab, Project options -> Edit / Archive, row menu -> Restore); `ProjectPage.test.tsx` |
| Projects: rows with progress, open count, target date; Archive in the menu; archived behind a toggle | `PASS` | `ux07` (no visible Archive button; archive and restore through the row menu); `Projects.test.tsx` |
| No ISO date visible; one date format | `PASS` | `ux07` (`main` text of Projects and the project page has no `YYYY-MM-DD`); `tasks.test.ts` `formatDay`; unit checks on project dates |
| Project board at 1440 px with seeded data <= 1,200 px tall | `PASS` | `ux07` (document `scrollHeight` of `/projects/<id>?tab=board` with five tasks) |
| No horizontal page scroll at 1440 / 1024 / 720 / 390 px, light and dark | `PASS` | `ux07` "layout" (5 views x 4 widths x 2 themes; the phone board scrolls inside its columns); `mu08` at 375 and 800 px for the new routes |
| axe clean incl. the new states, light and dark | `PASS` | `mu08`: `/tasks?view=board`, project Board and Notes tabs in both themes, plus chip menu, Due popover, save-view popover, bulk bar, project row menu, project header menu. axe found one real issue on the first run (`label-content-name-mismatch`: the bulk bar's project button had an `aria-label` that did not contain its visible text); fixed by naming the button by its text |
| J1-J7, ux02-ux06, tasks-page keep passing with selectors changed only where labels legitimately changed | `PASS` | Changed: tasks-page (chips, "…" menu, bulk menu), J3 (tab, Notes tab, Project options, row menu), ux03 (a project's completed row is inside the folded group). Names kept: `Select <title>`, `Select all`, `Complete selected`, `Delete selected`, `Reset filters`, `Saved filter name`, `Search`, `Due from`, `Due to`, `Actions for <title>`, `Move to…`, `In progress` region |
| Tokens only; icons via `Icon.tsx`; no new package | `PASS` | `npm run lint` (CSS scale check `OK`); no Lucide shape added (`DEPENDENCIES.md` unchanged) |
| Repository checks | `PASS` | `./scripts/verify.sh` -> ruff, ruff format, mypy (115 files), pytest `1061 passed`; eslint + CSS scale check, `tsc`, vitest `798 passed` (71 files; UX-06 recorded 776) ; `verification: PASS` |
| Real-stack suite | `PASS` | `npm run test:e2e:real` -> `46 passed` (42 + 4 in `ux07-tasks-projects-board.spec.ts`). First full run: 44 passed, 2 failed (mu08 axe finding above; ux03 looked for a row in a project whose only task is now folded) - both fixed, then re-run in full |
| Mocked e2e | `PASS` | `npm run e2e` -> `7 passed` |
| No stray `atlas_e2e_*` databases; owner's stack untouched | `PASS` | `pg_database`: `postgres`, `atlas`, `atlas_test`, templates only; `atlas` and the dev stack were not used |
| Other browsers, real phone, screen reader (tabs, live announcements, popovers), 200 % zoom, drag and drop on touch | `NOT RUN` | Chromium (desktop + 390 px emulation) only |

**Screenshots** (throwaway stack, fictional orchard data, scratchpad `shots/`, not in the repository), at 1440 and
390 px, light and dark: `tasks-*`, `tasks-board-*`, `projects-*`, `project-*`, `project-board-*` (20 files). Reviewed
and fixed: the search icon overlapped the first letter (the base input padding out-ranked the bar's rule).

Limitations: ADR-0057 and R-26 (saved views per browser; the Tasks board shows only filtered tasks; fold and
archive toggles reset on reload; client copy of the transition table for `[` / `]`).


### UX-11 — Remaining phone pages and removal of the standalone Board

**Result: `DONE` (local, 2026-11-03); CI job `e2e-real` `NOT RUN` on GitHub Actions; not committed.** Tasks Select mode and Filters sheet,
project Board column tabs, Notes toolbar, Projects cards, full-screen palette, 44 px status-bar link, Medium/Low words, single capture
control on phone Inbox and project Tasks (ADR-0064). Owner scope change folded in: the **standalone Board page and the Tasks List | Board
view are removed**; `/board` redirects to Projects; Kanban remains in each project's Board tab. UI-only: no backend, schema, package, icon or
colour-token change (`DEPENDENCIES.md` unchanged).

| Criterion | Result | Evidence |
|---|---|---|
| No document scroll at 360/390/768/1440; no inner scroll at 360/390 on Tasks, Projects, Notes (list and open), the project Board tab, Settings sections | `PASS` | `ux11` test 1 (13 pages x 4 sizes x 2 themes; inner-scroll scan of every `overflow-x: auto/scroll` box). The Board tab strip is a grid, so no exception was needed; a tablet-width (768) board keeps its scrolling columns and is not judged |
| Every interactive control >= 44 px at 360/390 over the touched pages (excluding inline text links) | `PASS` | `ux11` test 1 + Filters sheet and palette overlays + Login/Setup (test 2) + Select mode (test 3) + Notes with the details panel open (test 5). A checkbox/radio inside a label counts as its label; excluded by design: list-row title buttons (the row body is the target, ADR-0062), checkboxes/links inside a note's own text (R-51) |
| Tasks: select boxes only in Select mode entered from "Filter options"; one leading control; Select all >= 44 px | `PASS` | `ux11` test 3 (no `Select <title>` or "Select all" at first; boxes 44x44; no `Complete <title>` while selecting; Done restores); `Tasks.test.tsx` |
| Bulk actions still work: complete, move, delete + undo | `PASS` | `ux11` test 3 (real API read-back for move and complete; "Deleted 1 task." + Undo); `tasks-page`, `ux07` (desktop) and J-specs pass |
| Filters sheet (replaces the chip line): filter, count, reset | `PASS` | `ux11` test 3 (Priority > High, "Filters, 1 active", Reset), axe on the open sheet at 360/390/768/1440; `Tasks.test.tsx`. Chip line replaced by a sheet to satisfy "no inner scroll" (ADR-0064 §2) |
| Project Board: one full-width column, all five reachable by tab (arrows, Home, End), `[`/`]` move and follow, announcement kept, "?" help, Archived toggle | `PASS` | `ux11` test 4; `Board.test.tsx` (phone: tabs with counts, End to Archived, `]` follows the card, help); `ux07` board test (desktop: `[`/`]`, edges, announcement, card menu) |
| Notes toolbar: name + folder (no "/…"), one Source/Live/Preview control, the rest in "…", tree drill-in kept | `PASS` | `ux11` test 5; `mu08` (phone note axe with Preview and details), `ux05`, `ux06`, J4 unchanged except `openNoteDetails` (phone uses the "…" item) |
| Projects cards: dot colour, one-line summary, target date at the right, 44 px "…", whole card opens the project | `PASS` | `ux11` test 6 (summary and target on one line, date right of the summary, 44 px menu, click on the card opens the project) |
| Palette: full-screen sheet, 44 px rows, no key hints, Close | `PASS` | `ux11` test 1 (palette box equals the viewport at 360/390; no "to move" text; targets; axe at four sizes in both themes) |
| Leftovers: Medium/Low word on phone; status bar link >= 44 px; one capture control on phone Inbox | `PASS` | `ux11` tests 3, 6, 7 (offline bar link >= 44 px and above the bottom nav) |
| Standalone Board removed; `/board` redirects; `view=board` ignored; no nav or palette entry | `PASS` | `ux11` test 8; `App.routes.test.tsx`, `navigation.test.ts`, `Layout.test.tsx`, `taskFilters.test.ts`; `ux02` old URL `/board` -> Projects |
| axe WCAG 2.0/2.1 A/AA + best practice clean in both themes at 360/390/768/1440 on Tasks, project Board, Projects, Notes, palette, Settings, Login, Setup | `PASS` | `ux11` tests 1-2 (+ `mu08` sweep, `ux09`, `ux10` unchanged). VoiceOver/TalkBack: `NOT RUN` (R-51) |
| J1-J7, ux01-ux10, tasks-page, mu04, mu08 and all other real-stack specs | `PASS` | `npm run test:e2e:real`: `69 passed` (61 + 8 in `ux11-phone-pages.spec.ts`). Edited (selector/route changes only): ux02, ux03, ux07, ux08, mu08, J1 and `helpers.ts` (`openNoteDetails`) |
| Lint (scale), typecheck, unit tests, backend | `PASS` | `./scripts/verify.sh`: ruff, format, mypy, pytest `4172 passed, 14 skipped`; eslint + `check-css-scale: OK`, `tsc`, vitest `896 passed` (78 files; UX-10 recorded 898 in 79 files: new phone tests added, the standalone Board page test file and the Tasks board test deleted); `verification: PASS` |
| Mocked e2e | `PASS` | `npm run e2e`: `7 passed` |
| Contrast of any new token | `PASS` (none) | No colour token added; `styles.test.ts` unchanged |
| Real phone (keyboard, notch, taps), iOS zoom, TalkBack/VoiceOver, Safari/Firefox, 200 % zoom, reduced-motion visual check | `NOT RUN` | Chromium emulation only (R-51); no animation was added |
| No stray `atlas_e2e_*` databases; owner's stack and `atlas` DB untouched | `PASS` | `pg_database` after teardown: `postgres`, `atlas`, `atlas_test`, templates only. A first full run was stopped when the scope change arrived; its leftover `atlas_e2e_*` database and processes were removed with `db_admin.py drop` |

**REQ-006 (Project management).** Kanban remains delivered **inside projects**: the project page's Board tab (drag, card menu "Move to…",
`]`/`[`, announcement, Archived toggle; phone column tabs) passes `ux07`, `ux11`, `Board.test.tsx`, `ProjectPage.test.tsx`, J3. The standalone Board
(`/board`) and the Tasks board view are removed by owner decision; consequence: a task with no project appears on no board.

Selector/route changes: `/board` (route now redirects), the "Board" nav/rail/palette entries, Tasks group "View" (`List | Board`) and the `view` URL
parameter are gone; phone-only: Tasks has "Filters" instead of the chips and no `Select <title>` / "Select all" until "Select tasks" in "Filter options";
phone Board columns are tabs named "<Column>, <n> tasks" (`tabpanel`, not `region`); phone Notes has no "Links and details" button (it is the first
"Note options" item); phone Inbox / project Tasks have no inline "Task title" field (the sheet has it; J1 narrow screen updated).

Deviations: filter chips are a sheet, not a scrollable line (plan note); phone Notes shows name + folder rather than the full breadcrumb path.

**Screenshots** (throwaway stack, scratchpad `ux11/`, not in the repository). Before (UX-10 tree, 390 px light and dark):
`/tmp/claude-1000/-home-kim-Documents-Atlas/31ff7fb3-5923-481a-b611-5657fde6b6ea/scratchpad/ux11/shots_before/{tasks,board,notes-open,projects,palette}_p390_{light,dark}.png` (`board` is the removed standalone page). After:
`/tmp/claude-1000/-home-kim-Documents-Atlas/31ff7fb3-5923-481a-b611-5657fde6b6ea/scratchpad/ux11/shots_after/{tasks,project-board,notes-open,projects,palette}_p390_{light,dark}.png` (the project board has no "before" capture; its
desktop layout is unchanged).

### UX-10 — Week agenda, phone capture sheet, menu sheets, 16 px fields and safe areas

**Result: `DONE` (local, 2026-11-03); CI job `e2e-real` `NOT RUN` on GitHub Actions; not committed.** Week is an auto-fit agenda of day
cards; a phone capture button opens a keyboard-aware bottom sheet around the existing `QuickCapture`; `Menu` and `Popover` are bottom
sheets on phones and no-hover devices; text fields are 16 px on touch/phone; the bottom nav, header, FAB and sheets use the safe-area
insets (ADR-0063). CSS and markup only: no backend, schema or dependency change; one Lucide icon (`plus`) added to `DEPENDENCIES.md`.

| Criterion | Result | Evidence |
|---|---|---|
| No horizontal document scroll and no inner scroll on Week at 360/390/768/1440 (sidebar open at 1440), both themes | `PASS` | `ux10` test 1 (5 pages x 4 sizes x 2 themes: document overflow 0; Week: no scroll container with overflow, every card inside `.week-agenda`) |
| All seven days reachable; no word split across lines; no clipped titles; today highlighted; empty day one line | `PASS` | `ux10` test 1 (7 `.week-day`, 7 day headings, one `.is-today`, per-word `Range` rects on one row, title `scrollWidth <= clientWidth`, empty cards <= 64 px; columns 1 at 360/390, >= 2 at 768/1440); `Week.test.tsx`. Phone meta lines with `text-overflow: ellipsis` (ADR-0062 line 3) are exempt at <= 390 px |
| Capture reachable in one tap from every task page; sheet not covered by the keyboard | `PASS` (emulated) | `ux10` test 2 (FAB >= 56 px, above the bottom nav, on Today, Inbox, Upcoming, Week, Tasks and a project page, both themes); test 3 (stand-in `visualViewport` of -300 px lifts the sheet and the field stays above the keyboard; returns to 844 px). **Real keyboard: `NOT RUN`** (R-50) |
| Capture adds exactly one task; failure keeps the title; retry adds one | `PASS` | `ux10` test 2 (`/api/tasks?q=` returns one per page; a 503 on the first POST then retry returns one); `CaptureSheet.test.tsx` (retry, double submit ignored); the page's own `onCapture` is reused |
| Sheet focus, Esc, scrim, Close, focus return, Tab trap, inert page | `PASS` | `CaptureSheet.test.tsx`, `MenuSheet.test.tsx`, `ux10` tests 2 and 4 |
| Every control in the sheets >= 44 px; fields compute to 16 px on touch | `PASS` | `ux10` tests 1, 2, 4 (`boundingBox` of buttons, inputs and `menuitem`s; computed `font-size` of every visible input/select/textarea on the five pages at 360/390/768, both themes) |
| Menu: bottom sheet at 360/390/768, popover at 1440, same roles and keys | `PASS` | `ux10` test 4 (full width, docked at the bottom, scrim, `menuitemradio` x 5 in Priority, End/Tab/Esc, scrim press returns focus, choosing an item works; 1440: no sheet, no scrim, no Cancel, width <= 320); `Menu.test.tsx` unchanged and passing |
| axe WCAG 2.0/2.1 A/AA + best practice clean (both themes) at 360/390/768/1440 on Today, Inbox, Upcoming, Week, Tasks, the open capture sheet and the open row sheet | `PASS` | `ux10` tests 1, 2 (sheet at 390 on Today and Inbox) and 4 (row sheet and Priority sheet at 360/390/768) |
| Safe-area padding (bottom nav, header, FAB, sheet) | `PASS` (emulated) | `ux10` test 5 (overriding `--safe-bottom: 34px`, `--safe-top: 47px`: nav 90 px with 56 px of targets, header 95 px, FAB above the nav, sheet keeps 34 px under its controls); `styles.test.ts`. **Real notch / home indicator: `NOT RUN`** |
| 44 px for changed controls (week segments, rail, FAB, chips, filter menu, nav) | `PASS` | `ux10` test 1 (touch sizes); measured sweep before the final run listed only task-open titles (the keyboard path; the body is the target), "Synced" (20 px, status bar), per-row Select boxes (22 px) and "Select all" box (16 px): UX-11 / not in scope |
| J1-J7, ux02-ux09, tasks-page, mu04, mu08 pass unchanged | `PASS` | `npm run test:e2e:real`: `61 passed` (56 + 5 new in `ux10-phone.spec.ts`); no existing spec was edited |
| Lint (scale), typecheck, unit tests; mocked e2e | `PASS` | `./scripts/verify.sh`: ruff, format, mypy, pytest `4172 passed, 14 skipped`; eslint + `check-css-scale: OK`, `tsc`, vitest `898 passed` (79 files; UX-09 recorded 877); `verification: PASS`. `npm run e2e`: `7 passed` |
| Contrast of any new token | `PASS` (none) | No colour token added (`--accent`, `--scrim`, `--due-today`, existing text tokens); `styles.test.ts` unchanged for colours |
| iOS zoom-on-focus, real keyboard overlap, notch, TalkBack/VoiceOver, other browsers, 200 % zoom | `NOT RUN` | Chromium emulation only (R-50) |
| No stray `atlas_e2e_*` databases; owner's stack and `atlas` DB untouched | `PASS` | `pg_database` listed after teardown: `postgres`, `atlas`, `atlas_test`, templates only; the throwaway screenshot stack `atlas_e2e_ux10_*` was dropped with `down.sh` |

Selector changes: Week only. `.week-day` is now `section.view-section.week-day` (with `.is-today` / `.is-empty`) whose first child is `h2.section-head`;
`.week-days` is an auto-fit grid wrapped in `.week-agenda`; `.week-day-count` is gone; phone Today has no inline "Task title" field (the sheet has it).
Kept: `Task title`, "Previous week", "This week", "Next week" and every ADR-0062 row selector.

Not built: the Inbox per-row "Today" button (plan item 5, owner may decline). Deviations: the projects summary toggles instead of scrolling (no inner scroll was a
stricter requirement); no `c` shortcut. Notes: the `ux10` layout test excludes `.sr-only` 1 px boxes from the inner-scroll scan and phone ellipsised meta; the
first full-suite run failed on that scan (`.sr-only`), the spec was fixed and the whole suite re-run (61 passed).

**Screenshots** (throwaway stack, scratchpad `ux10/`, not in the repository). Before (`git archive HEAD`, UX-09 tree):
`/tmp/claude-1000/-home-kim-Documents-Atlas/31ff7fb3-5923-481a-b611-5657fde6b6ea/scratchpad/ux10/shots_before/{week_p390_dark,week_t768_light,week_d1440_light,row-menu_p390_light,today_p390_light}.png`;
after: `.../ux10/shots_after/` with the same names plus `capture-sheet_p390_light.png`, `capture-sheet_p390_dark.png`, `row-menu_p390_dark.png`,
`row-submenu_p390_light.png`, `due-popover_p390.png`, `week-nextweek_{p390,d1440}.png` (empty days).

### UX-09 — Readability tokens, task row anatomy and section structure

**Result: `DONE` (local, 2026-11-03); CI job `e2e-real` `NOT RUN` on GitHub Actions; not committed.** New colour tokens, one row
anatomy for phone and desktop, section cards with sticky headers on Inbox, Today, Upcoming, Week, Tasks and the project Tasks
tab (ADR-0062). CSS and markup only: no backend, schema, dependency or icon change (`DEPENDENCIES.md` unchanged).

| Criterion | Result | Evidence |
|---|---|---|
| (a) Token contrast in both themes; both dark copies identical | `PASS` | `src/styles.test.ts` (62 tests incl. the new tokens: text on page/card/band, due, priority, 8 dots at 3:1, card outline, hairline) |
| (b) Phone rows <= 3 lines and <= 96 px, 16 px title, no overflow at 360/390; overdue / today / urgent distinguishable without colour | `PASS` | `ux09` test 1 (every `.task-row` on 7 pages at 360 and 390, light and dark, incl. a 124-character overdue urgent title with 3 tags); `TaskRow.test.tsx` (icon + word per state); greyscale screenshot saved by the spec to `test-results/` (not inspected by eye beyond the spec run) |
| (c) 44x44 completion hit area and "..." on touch; whole row body opens the task | `PASS` | `ux09` test 1 (`boundingBox` of checkbox and "..." at 360/390/768, both themes); test 2 (a click on the meta line opens "Task details"); `TaskRow.test.tsx` (opens once) |
| (d) Sticky headers with counts; Overdue distinguishable by icon and text | `PASS` | `ux09` test 2 (position sticky, top 48 px, measured 47-49 px after scrolling); `ViewSection.test.tsx`; `Today.test.tsx` |
| (e) No horizontal document scroll at 360/390/768/1440, light and dark | `PASS` | `ux09` test 1 (7 pages x 4 sizes x 2 themes) |
| (f) axe WCAG 2 A/AA (+2.1, best practice) clean | `PASS` | `ux09` test 1 on Inbox, Today, Upcoming, Week, Tasks, Projects and a project page at 360/390/768/1440 in both themes; `mu08` still clean. VoiceOver/TalkBack pass: `NOT RUN` (R-49) |
| (g) lint (scale check), typecheck, tests, mocked and real e2e | `PASS` | `./scripts/verify.sh`: ruff, format, mypy (130 files), pytest `4172 passed, 14 skipped`; eslint + `check-css-scale: OK`, `tsc`, vitest `877 passed` (76 files; UX-08 recorded 816); `verification: PASS`. `npm run e2e` `7 passed`. `npm run test:e2e:real` `56 passed` (53 + 3 in `ux09-readability.spec.ts`; J1-J7, mu04, mu08, tasks-page, ux01-ux08 all pass unchanged) |
| (h) Desktop rows <= 40 px (ADR-0052) | `PASS` | `ux09` test 1 at 1440 (every row on Inbox, Today, Upcoming, Tasks, Projects); `ux03` still `PASS` |
| Upcoming drops the date under a day header and keeps it elsewhere; "Tomorrow" header | `PASS` | `ux09` test 3; `Upcoming.test.tsx`; `dueChip.test.ts` |
| Project dot colour = `hash(id) % 8`, name always shown | `PASS` | `projectColor.test.ts`; `TaskRow.test.tsx`; `ux09` test 2 |
| Selectors kept (`.task-row`, `.task-priority`, `.task-due`, `.project-tag`, accessible names, regions) | `PASS` | No existing spec was edited; only `TaskRow.test.tsx` changed its "Overdue, due" expectation to the visible "Overdue · date" |
| Week 7-column layout, FAB, bottom-sheet menu, 16 px inputs | `NOT RUN` | UX-10 by plan (Week rows and headers got the new anatomy; Sunday is still cut off on desktop); delivered later, see UX-10 above |
| Other browsers, real phone, screen reader, 200 % zoom, forced colours | `NOT RUN` | Chromium only; R-49 |
| No stray `atlas_e2e_*` databases; owner's stack untouched | `PASS` | `pg_database`: `postgres`, `atlas`, `atlas_test`, templates only (listed at the end); the audit throwaway stack was torn down with `down.sh` |

Notes: one run of `vitest` during development failed once and passed on three reruns and in `verify.sh` (not reproduced, cause not
found). Three `ux09` tests share one database, so the spec uses `.first()` where seeding repeats.

**Screenshots** (throwaway stack from `git archive HEAD` backend, scratchpad `ux2/`, not in the repository). Before:
`/tmp/claude-1000/-home-kim-Documents-Atlas/31ff7fb3-5923-481a-b611-5657fde6b6ea/scratchpad/ux2/shots_before/{upcoming,today,inbox}_{p390_light,p390_dark,d1440_light}.png`;
after: `.../ux2/shots_after/` with the same names (plus week, tasks, projects at 360/390/768/1440 light and dark from the first capture).

Limitations: ADR-0062 and R-49 (Chromium only; line 2 clips at its end at 360 px with a long due + Urgent + subtasks; hues not simulated for colour-vision deficiency; Week
still cut off on desktop until UX-10; medium/low priority is a bare flag on a phone as designed).

### UX-08 — Settings consolidation, skeletons and empty states

**Result: `DONE` (local, 2026-11-03); CI job `e2e-real` `NOT RUN` on GitHub Actions; not committed.** Settings is a
section list plus one section at a time (`/settings/<section>`); Sync, Calendar and Notifications became sections;
skeletons replace "Loading…" on the list pages; one `EmptyState`; sign-in and first-run got a `main` landmark
(ADR-0058). No backend, schema, dependency or icon change (`DEPENDENCIES.md` unchanged).

| Criterion | Result | Evidence |
|---|---|---|
| Settings: seven sections, one at a time, section in the URL, survives a reload | `PASS` | `ux08` "Settings: one section…" (each section opened from the list, URL, `aria-current`, reload on About); `Settings.test.tsx`; `settingsSections.test.ts` |
| Old `/sync`, `/notifications`, `/calendar` still resolve; unknown section goes to `/settings`; palette "Go to Sync / Calendar / Notifications" works; sidebar/rail have one active item | `PASS` | `ux08` (redirects, palette Enter), `ux02` (old URLs, `/settings/sync` keeps one active item), `App.routes.test.tsx`, `navigation.test.ts`, `Layout.test.tsx` |
| Rows are "label + description left, control right"; at most one primary button per section | `PASS` | `ux08` (`button.primary` count <= 1 on each section); `Settings.test.tsx`; screenshots below |
| Existing content and behaviour preserved (account, theme, reminders, notification consent, export, backups, instance, Sync panel, Calendar status) | `PASS` | J7 (now opening each section from the list), `Settings.test.tsx`, `SyncSettings.test.tsx`, `CalendarSettings.test.tsx`, mocked `sync-failure-modes` (4) and `web-push-consent` (3) specs run through the redirects |
| Phone: the list first, then a drill-in section with "All settings" | `PASS` | `ux08` at 390 px (Account form hidden on the list, list hidden in a section, back link) |
| Skeletons instead of "Loading…" on Inbox, Today, Upcoming, Week, Tasks, Projects, Notes tree (and Board, project page, Sync/Calendar/backup/instance); `role="status"` kept; page does not jump; shimmer off under reduced motion | `PASS` | `ux08` "loading shows a skeleton…" (list request held: status with "Loading …" text visible, h1 `y` identical before and after release, skeleton gone); `Skeleton.test.tsx`; CSS has the explicit `prefers-reduced-motion` rule (reduced motion itself not run in a browser: `NOT RUN`) |
| One `EmptyState` (icon, one line, at most one action) on Inbox, Tasks (no results vs none yet), Projects, Today, Upcoming, Week, Notes | `PASS` | `ux08` "every empty list…" (8 views incl. Tasks both ways, icon present, action buttons, Reset filters flow); `Tasks.test.tsx`, `Inbox.test.tsx`, `Skeleton.test.tsx` |
| axe clean and no horizontal scroll at 1440 / 1024 / 720 / 390 px, light and dark: every Settings section and the list, skeleton states, empty states, sign-in and first-run | `PASS` | `ux08` (4 sweeps x 4 widths x 2 themes); `mu08` adds the six `/settings/<section>` routes (axe both themes, overflow at 375 and 800). axe found a real defect on the first sign-in run (`landmark-one-main`, `region`): fixed with `<main>` |
| Login and Setup consistent with the design system | `PASS` | one centred token-styled card at all four widths (position asserted within 1 px), axe clean; only fix was the `main` landmark and `role="alert"` on errors |
| J1-J7, ux02-ux07, mu08, tasks-page keep passing with selectors changed only where labels legitimately changed | `PASS` | Changed: J7 (section navigation), ux02 (More holds Settings; old URLs show the Settings h1), mu08 (section routes). Pages that were `h1` Sync/Calendar/Notifications are now `h2` sections under the `h1` Settings |
| Tokens only; icons via `Icon.tsx`; no new package | `PASS` | `npm run lint` (CSS scale check `OK`); no Lucide shape added |
| Repository checks | `PASS` | `./scripts/verify.sh` -> ruff, ruff format, mypy (115 files), pytest `1061 passed`; eslint + CSS scale check, `tsc`, vitest `816 passed` (73 files; UX-07 recorded 798); `verification: PASS` |
| Real-stack suite | `PASS` | `npm run test:e2e:real` -> `52 passed` (46 + 6 in `ux08-settings-states.spec.ts`); first `ux08` runs failed on spec mistakes (a count of h2s that includes the notification cards, an over-strict `Loading` text check, a hidden notes empty state on phones) and on the axe finding above; all fixed, then the full suite was run once |
| Mocked e2e | `PASS` | `npm run e2e` -> `7 passed` |
| No stray `atlas_e2e_*` databases; owner's stack untouched | `PASS` | `pg_database`: `postgres`, `atlas`, `atlas_test`, templates only; `atlas` and the dev stack were not used |
| Compact-density toggle (listed in `UX_AUDIT.md`) | `NOT RUN` | Out of scope by decision: no density token exists (ADR-0058 §7) |
| Other browsers, real phone, screen reader, 200 % zoom, reduced motion in a browser | `NOT RUN` | Chromium (desktop + emulated widths) only |

**Screenshots** (throwaway stack, scratchpad `ux08/`, not in the repository), 1440 and 390 px, light and dark:
`/tmp/claude-1000/-home-kim-Documents-Atlas/31ff7fb3-5923-481a-b611-5657fde6b6ea/scratchpad/ux08/settings-{index,account,appearance,sync,data}-*.png`, `skeleton-inbox-{light,dark}-1440.png`,
`skeleton-inbox-light-390.png`, `empty-{inbox,today,upcoming,week,projects,tasks,tasks-filtered,notes}-*.png`,
`auth-{login,setup}-*.png`.

Limitations: ADR-0058 and R-27 (old addresses are redirects; only the open Settings section is mounted; Today shows
one empty state when all three groups are empty; no density toggle).

### SYNC-01 — Feed correctness fixes (no protocol change)

**Result: `DONE` (local, 2026-11-03); not committed; CI `NOT RUN`.** Server: `NotesReconciler` records the change feed;
`/api/changes` answers a cursor ahead of the head with `resync_required` + `resync_reason`; the cursor ordering is proven
under real concurrency; the nginx body limit is verified. No migration (no schema change), no new dependency.

| Criterion | Result | Evidence |
|---|---|---|
| External edit, add, removal and revival found by reconcile each appear once in `/api/changes` | `PASS` | `test_notes_reconcile.py` (4 feed tests via `ChangesService`), `test_changes_api.py::test_a_reconciled_external_edit_reaches_a_client_through_the_feed` (HTTP, `POST /api/notes/reconcile` then `GET /api/changes`). Run against the old `reconcile.py`: 6 of these fail (regression value shown) |
| A scan that finds nothing records nothing; repeated scans are idempotent | `PASS` | `test_a_scan_that_finds_nothing_records_nothing` (3 scans: `users.change_seq` and `change_log` unchanged, 1 row) |
| Feed rows and index change are one transaction | `PASS` | `test_reconcile_feed_rows_roll_back_with_the_index` (failure after `run()`: no index row, no feed row, `change_seq` 0) |
| `since > head` returns a resync signal, not an empty page | `PASS` | `test_changes_api.py` (`head+1`, `head+10`, `MAX_CURSOR` -> `resync_required=true`, `resync_reason="cursor_ahead"`, `next_since=head`, no write to `change_seq`); `at head`/below head stay ordinary; `below_floor` reason in `test_change_purge.py`; unit `test_change_retention.py` (pure `resync_reason`) |
| API contract regenerated; web engine treats the new reason as a resync | `PASS` | `openapi.json` regenerated, `npm run gen:api` (`ResyncReason`, optional `resync_reason`); `syncEngine.test.ts` "treats a cursor ahead of the server as a resync" |
| N parallel same-user transactions: strictly increasing, gap-free, unique cursors; a reader never sees `k+1` committed before `k` | `PASS` | `test_change_concurrency.py` (8 tests; 12 consecutive runs after the last test fix, no failure): second writer observed blocked in `pg_stat_activity`; rollback leaves no gap; 5 writers released one at a time; other users not blocked; 3 seeded stress runs (8 writers x 3 changes, 25 % rolled back, paging reader with limits 1/2/5): nothing skipped, nothing duplicated, cursors `1..n` |
| The concurrency test can fail | `PASS` | negative control in the same file: a cursor handed out in its own short transaction lets the reader skip a committed change (asserted). A mutation of the real recorder in the stress test was not observable (pool exhaustion in the mutant, see note) |
| Ordering mechanism documented | `PASS` | `atlas/changes/record.py` docstring (unchanged, now test-backed), `SYNC_PROTOCOL.md` §2.1, RISKS R-32 |
| (d) nginx body limit vs the 5 MiB note limit | `PASS` (check done) / **defect found** | the shipped `apps/web/nginx.conf` in a throwaway `nginx:1.27-alpine` (own docker network, stub upstream, removed afterwards): POST 0.5 MiB `200`, 0.99 MiB `200`, 1.01 MiB `413`, 2 MiB `413`, 6 MiB `413`. Notes above ~1 MiB cannot be saved through the web container. **Not fixed** (deploy config, owner decision): RISKS R-34 + `DEPLOYMENT.md` §8 record it with the proposed `client_max_body_size 6m;` |
| Repository checks | `PASS` | `./scripts/verify.sh`: ruff, ruff format (227 files), mypy (115 files), pytest `1084 passed` (was 1061), eslint, tsc, vitest `817 passed` (was 816); `verification: PASS` |
| Real-stack suite | `PASS` | `npm run test:e2e:real` -> `53 passed` (4.6 min; web change was types only) |
| Reconcile of a removed note also drops its project links and announces them | **not done** | Pre-existing difference from `NotesService.delete`; recorded in ROADMAP SYNC-01 follow-up and the RISKS change log. Not a SYNC-01 acceptance criterion |
| Migration | n/a | none |
| Client handling of `cursor_ahead` beyond "resync" (confirm-before-reupload, notice) | `NOT RUN` | SYNC-08 / ADR-0059 D12 |

Note on the mutation attempt: replacing the allocator by an out-of-band one inside the real `ChangeRecorder` hung the stress
test instead of failing it (each writer needs a second pooled connection, 8 + 8 > 15), so that mutation was abandoned; the
deterministic negative control is the evidence that the check detects a skip.

### SYNC-02 — Simulation harness

**Result: `DONE` (local, 2026-11-03); not committed; CI `NOT RUN`.** Python harness in `services/api/tests/sim/` (reason in
`TESTING.md` §10.0). No dependency, no production code change, `scripts/verify.sh` untouched.

| Criterion | Result | Evidence |
|---|---|---|
| Deterministic, seeded; failure prints the seed and reproduces | `PASS` | `test_a_run_is_reproducible_from_its_seed` (identical trace and state twice); every `SimFailure` carries `seed=` and the last 30 events; planted-bug tests re-run the failing seed and get the same invariant |
| Fault transport: drop request, drop response after apply, duplicate, delay/reorder, 5xx, offline, restart, clock skew | `PASS` | `engine.py`, `client.py`; traces show each fault kind. 429/`Retry-After` and truncated pages are handled by the client but **not injected** (`NOT RUN`) |
| Invariants: convergence, no acknowledged loss, no duplicates, no resurrection, cursor safety, clock independence, idempotence, bounded work, revision-identifies-state | `PASS` | all implemented in `runner.py`; each is made to fail by a planted bug |
| Planted bugs fail the named invariant (and pass without the bug) | `PASS` | 11 flags (server: ignore idempotency, ack-but-drop, order by client time, skip feed row, resurrect, cursor overshoot; client: cursor before apply, key regenerated on retry, tombstones ignored, stale revisions applied, queue ordered by client clock) + convergence-alone, clock-dependence, scripted stale replay. The first version of the retry-key bug was too weak (1 of 60 seeds) and was corrected by this check |
| Model on many seeds | `PASS` | default 100 + 40 + 40 + 1; soak `ATLAS_SIM_SEEDS=1000` -> `1081 passed` in 10 s; no failure in 1000 seeds of the default shape or 300 with purge/4 clients |
| Real API under the same simulation | `PASS` | default 3 seeds; soak `ATLAS_SIM_REAL_SEEDS=30 ATLAS_SIM_STEPS=150` -> `30 passed` in 82 s (acceptance asked for >= 20); `test_the_real_api_run_can_fail` (client bugs caught against the real server) |
| Conformance model vs real | `PASS` | 8 traces (lifecycle, projects, validation, idempotency, replay after change, failed request stores nothing, base revision, feed paging/tombstones/cursor ahead) identical; the comparison itself can fail |
| Concurrency on the real API | **FAIL (finding)** | `test_two_concurrent_patches_...cannot_both_win`: both PATCHes returned 200 with the same revision in 8 of 8 attempts: lost update, **R-37**. Kept as `xfail(strict)` so verify stays green and the fix will flip it |
| Does not slow verify noticeably | `PASS` | `pytest tests/sim` 213 tests (212 + 1 xfail) in about 13 s |
| Model server mirrors the TS client / shipped web code | `NOT RUN` | model clients are Python; SYNC-08 owns the TS adapter. Not simulated: notes, links, subtasks, edit-wins, field merge, server restore as a random action, exhaustive crash points |
| Repository checks | `PASS` | `./scripts/verify.sh` after both tasks: ruff, ruff format (237 files), mypy (115), pytest `1296 passed, 1 xfailed` (SYNC-01 baseline 1084; +212 sim tests), eslint, tsc, vitest `817 passed`; `verification: PASS`. Web e2e not re-run after SYNC-02 (no web change) |


### SYNC-03 pre-work — R-37 lost update, R-34 nginx limit, reconcile removal parity

**Result: `DONE` locally (2026-11-03); not committed; CI `NOT RUN`.** No migration, no new dependency, no API contract
change (`openapi.json` untouched; `409` bodies are the existing shape). Scope was the three defects found by SYNC-01/02.

| Criterion | Result | Evidence |
|---|---|---|
| Concurrent PATCH/PUT with one `base_revision`: exactly one wins, loser `409` with `current_revision`, stored state is the winner's | `PASS` | `tests/integration/test_revision_races.py`: tasks, projects, notes (file on disk equals the winner's content), 8 rounds each. Before the fix 6 of 7 tests in the file failed (the lost update reproduced on tasks, projects and notes); after, 7 of 7 pass, 12 consecutive runs |
| The former `xfail(strict)` test passes strictly; project variant added | `PASS` | `tests/sim/test_sim_conformance.py::test_two_concurrent_patches_with_the_same_base_revision_cannot_both_win` (marker removed) and `..._project_patches_...` |
| Idempotency-key replay still returns the original result | `PASS` | `test_a_replayed_idempotency_key_still_returns_the_original_result` (same key and body: 200, identical body, revision bumped once) |
| A losing request leaves no feed entry and does not advance the cursor | `PASS` | `test_a_losing_patch_leaves_no_feed_entry` (4 parallel PATCHes: `[200,409,409,409]`, `change_seq` +1) |
| No deadlock: lock order entity rows, then change cursor; bulk task locks in id order | `PASS` | `test_concurrent_deletes_of_a_parent_and_project_unfiling_do_not_deadlock` **caught a real deadlock in the first version of the fix** (parent locked before its children vs project delete locking by id): `delete` now locks the task and its subtasks in one id-ordered statement; reconciler records feed entries after its row changes (`test_reconcile_and_concurrent_note_edits_do_not_deadlock`) |
| nginx allows a 5 MiB note plus JSON overhead on `/api/`, small elsewhere | `PASS` | `tests/unit/test_nginx_config.py`: static parse of `apps/web/nginx.conf` and a live throwaway `nginx:1.27-alpine` container (5 MiB + 1 KiB and + 64 KiB not `413`, 7 MiB `413`, 2 MiB + 1 to `/` `413`); against the old file 3 of 4 fail. Container removed; the owner's running containers untouched |
| Owner's running `web` container now accepts 5 MiB notes | `NOT RUN` | image not rebuilt (instruction); `DEPLOYMENT.md` section 8 says to rebuild |
| A 5 MiB note of nothing but newlines (about 10 MiB of JSON) passes nginx and the API | `PASS` | limit raised from 6m to 11m: `test_nginx_config.py` (static: `>= 2 x MAX_NOTE_BYTES + 64 KiB`; live: 10 MiB + 64 KiB not `413`, 12 MiB `413`) and `test_notes_api.py::test_a_maximum_size_note_of_escaped_characters_round_trips` (API stores and returns it, refuses one byte more). Only control characters (6 bytes each) could still exceed it |
| Reconcile removal = `NotesService.delete` (project links dropped and announced, wiki targets cleared, task links kept), idempotent, one transaction | `PASS` | `test_notes_reconcile.py` (4 new tests incl. state parity between the API and the scan path, 3 further scans change nothing, rollback restores links and cursor); 2 of the 4 fail on the old code |
| Repository checks | `PASS` | `./scripts/verify.sh`: ruff, ruff format (239 files), mypy (115 files), pytest `1620 passed` (SYNC-02 baseline 1296 + 1 xfail; +300 long-run sim seeds, +24 others), eslint, tsc, vitest `817 passed`; `verification: PASS`. (1314 before the second round of fixes) |
| Simulation soak | `PASS` | real API `ATLAS_SIM_REAL_SEEDS=20 ATLAS_SIM_STEPS=150` -> `22 passed` in 65 s; model `ATLAS_SIM_SEEDS=2000 ATLAS_SIM_STEPS=300` -> `2000 passed` in 47 s (seed 482 included); model `ATLAS_SIM_SEEDS=1000` default steps -> `1382 passed` (the module, incl. the 300 long-run seeds) |
| Real-stack suite | `PASS` | `cd apps/web && npm run test:e2e:real` -> `53 passed` (4.6 min; throwaway `atlas_e2e_*` database, dropped afterwards) |
| A task is never left live in a deleted project (move, create, restore vs project delete) | `PASS` | `test_revision_races.py` (3 tests, 16 rounds each); all three fail when the project share locks are removed (mutation run). Fix: project share lock before task lock (R-37) |
| No deadlock between task writers and project deletes, including a four-way swap | `PASS` | `test_swapping_tasks_between_projects_while_both_are_deleted_does_not_deadlock`; the alternative order (task, then project) was rejected on this case |
| Row locks do not block foreign-key checks | `PASS` | `test_a_note_edit_and_a_task_created_from_that_note_do_not_deadlock`: failed with plain `FOR UPDATE` (a real deadlock in my first version), passes with `FOR NO KEY UPDATE` |
| Model-sim seed 482 (300 steps) | `PASS` (fixed) | root cause: the model client installed a **replayed create acknowledgement** (original body, revision 1) over a tombstone it had already pulled (c1's create response was lost, c2 deleted the project, c1 pulled past the delete, then c1's retry was answered with the first result). Classification: missing client rule, not a server flaw (idempotent replay returning the first result is by design). Fix in `tests/sim/client.py`: an ack only fills a gap, never overwrites newer/tombstoned state, and the entity is re-read at the next pull; rule added to `SYNC_PROTOCOL.md` section 8.1. Regression: `test_regression_seed_482_...` (fails with `ClientBugs(trust_ack_state=True)`, passes otherwise) and seeds 0-299 at 300 steps in the normal suite |
| Not covered | `NOT RUN` | the NOWAIT fallback when a parent's project changes between peek and lock; two-process (separate worker) reconcile racing the API; behaviour under `REPEATABLE READ` callers (only the project export uses it, read-only) |

### SYNC-03 — Protocol v1 server (sub-steps 03a-03g)

**Result: `DONE` locally (2026-11-03); not committed; CI `NOT RUN`.** Three reversible migrations (`a1f0c3d2b4e6` field revisions
with backfill, `c3b7d9e1f2a8` instance epoch, `d5e8a2f1c4b9` live-path unique index), no new dependency (`DEPENDENCIES.md`
unchanged), `openapi.json`/`schema.d.ts` regenerated. Nothing was run against the owner's `atlas` database or dev stack; every test
used `atlas_test` (and the e2e run its own `atlas_e2e_*` database). Contract changes that touched pre-existing tests, each
deliberate: feed `since=0` is a snapshot without tombstones and the default retention is 90 days (tests in `test_change_purge.py`,
`test_changes_api.py`, `test_change_retention.py` re-pointed to cursor-based pulls and tombstone-only purge; schema column-set tests
gained `field_revisions`); web fixtures gained `head`/`floor` and the `sync` instance block (types only).

| Criterion | Result | Evidence |
|---|---|---|
| 03a `field_revisions` exists, is backfilled idempotently and is kept on every write path | `PASS` | `test_field_revisions.py` (11: create, patch only changed fields, no-op patch, `completed_at`, tags as one field, parent delete promotion, project delete unfiling, restore into a deleted project, project patch, recurrence successor); `test_field_revisions_migration.py` (3: values equal current revision at 7/3/5, nothing else moved, no feed rows; re-run never overwrites real stamps and fills empty rows; down/up round trip keeps columns) |
| 03b `Atlas-Sync` outside `1..1` is `426` with `{min,max}` on every route and before auth; no header = unchanged | `PASS` | `test_sync_protocol.py` (13 bad values parametrised, write refused with no effect, 401 vs 426 order) |
| 03b `GET /api/instance` advertises protocol, entity schemas, limits, retention, epoch | `PASS` | `test_the_instance_advertises_the_sync_block`, `test_the_epoch_is_stable_between_reads` |
| 03b/D12 wrong `Atlas-Epoch` is `409 epoch_mismatch` on tasks, projects, notes, changes, applies nothing; unauthenticated callers cannot learn it; `record-restore` rotates it and stops old clients | `PASS` | `test_a_wrong_epoch_is_409_on_every_sync_capable_router`, `test_an_unauthenticated_caller_cannot_learn_the_epoch`, `test_recording_a_restore_rotates_the_epoch_and_stops_old_clients` |
| 03c client ids: used, idempotent by id and by key, `id_exists` for different body / edited / deleted / another user's (same answer), accepted outside sync mode, subtask can reference an offline-created parent | `PASS` | `test_sync_writes.py` (8 tests) |
| 03c notes: client id, summary replay, collision rename with `path_collision`, tombstone path reuse by a new id, revive without id kept, reconcile and folder rename ignore tombstones on a live path | `PASS` | `test_sync_notes.py` (12); `test_notes_path_index_migration.py` (2: only live notes unique; downgrade keeps live note, renames colliding tombstone rows, round trip) |
| 03d sync-mode requires key, `base_revision`, known fields; non-sync mode demands nothing | `PASS` | `test_sync_writes.py`: `..requires_a_key_a_base_and_known_fields`, `..without_sync_mode_nothing_is_required_or_refused` |
| 03d rule 1: different fields merge; rule 2: later simple value wins and is reported with the loser; rule 3: same text field is `409 conflict` with both values, nothing applied, other fields still applied (`200` with `sync.conflicts`); equal value is a no-op with no bump; invalid transition never produced by later-wins; recurring completion on two devices is one successor; tags merge as one field | `PASS` | `test_sync_writes.py` (`test_different_fields_merge`, `..same_simple_field..`, `..same_text_field..`, `..does_not_block..`, `..equal_value..`, `..state_machine`, `..completing_twice..`, `..tags_merge..`, `..retried_patch..`) |
| 03d rule 4: edit of a deleted task/project revives it (also into a deleted project: unfiled); stale delete is `409 edit_wins` with the live entity; delete of a deleted entity is `204`; without sync mode an edit of a deleted task is still `404` | `PASS` | `test_sync_writes.py` (6 tests incl. projects) |
| D11 the server never reads `X-Client-Time` | `PASS` | `test_the_device_clock_never_decides` (older clock arriving later wins); simulation clock-independence (40 seeds model, v1) |
| 03e snapshot at `since=0`, later pages carry deletions, `types=` advances the cursor over filtered rows, unknown type `422`, `include=data` (task with tags and field revisions, project without progress, note metadata without content, link without data, tombstone with `deleted_at`), page caps 200/500, `head`/`floor` | `PASS` | `test_changes_feed_v1.py` (11) |
| 03e retention: tombstones only, upserts kept, floor = highest purged tombstone, `since=0` always served, idempotency keys expire with the tombstones, user-scoped | `PASS` | `test_change_purge.py` (7, rewritten), `test_change_retention.py`, `test_the_purge_job_runs_on_the_queue_and_reschedules` (old key deleted, recent kept) |
| 03e a multi-page bootstrap survives a floor above its first page | `PASS` (found by the sim) | `test_a_multi_page_bootstrap_survives_a_floor_above_its_position`; unit `test_a_snapshot_walk_is_never_below_the_floor` |
| Model/real conformance for all of the above | `PASS` | `test_sim_conformance.py`: 14 traces + the failure check + 3 concurrency tests |
| Simulation v1 on the model (default) | `PASS` | `test_sim_v1.py` 100 + 60 + 60 + 40 + 40 seeds, merge-outcome coverage test (conflicts, edit-wins, revives and later-wins all occur), 7 planted defects each caught by its named invariant, reproducible by seed, and the seed passes without the defect |
| Simulation soaks | `PASS` | model `ATLAS_SIM_SEEDS=1000 ATLAS_SIM_STEPS=300` (v1 + legacy, no real/planted): `2583 passed` in 71 s; real API `ATLAS_SIM_REAL_SEEDS=30 ATLAS_SIM_STEPS=150`: `62 passed` in 169 s (30 v1 seeds with late joiner and unsupported client, 30 legacy seeds, 2 planted) |
| Repository checks | `PASS` | `./scripts/verify.sh` on the final tree (including the `deprecated` marker on `GET /api/tasks/changes`, regenerated `openapi.json`/`schema.d.ts`): ruff, ruff format (259 files), mypy (123 files), pytest `2027 passed` in 123 s (SYNC-03 pre-work baseline 1620), eslint, tsc, vitest `817 passed` (73 files), `verification: PASS`. Earlier runs on intermediate trees: one `FAIL` (a 101-column line in the new migration, ruff E501; fixed) and a concurrent-edit artefact during 03a (a `test_migrations_match_models` failure caused by editing models while the run was in flight; not a code defect) |
| Real-stack browser suite (web unchanged: non-sync mode) | `PASS` | `cd apps/web && npm run test:e2e:real` -> `53 passed` (4.6 min) |
| Mocked browser suite | `PASS` after one flake | `npm run e2e`: first run `6 passed, 1 failed` (`sync-failure-modes` "network loss" timed out waiting for a write); that spec alone 3/3 `4 passed`, full suite re-run `7 passed`. Not reproduced, so not explained: recorded as a flake, not claimed fixed |
| Migrations tested on a representative existing schema | `PASS` | the two migration test files above start at the previous revision with populated rows. **Not run:** any migration against the owner's `atlas` database (instruction) - the owner's upgrade path (`atlas-migrate`) is the same code, tested only on `atlas_test` |
| Old non-sync behaviour unchanged | `PASS` | existing suites (tasks, projects, notes, reconcile, revision races, sim legacy) green; legacy sim seeds 0-299 at 300 steps in the normal run |
| Not covered | `NOT RUN` | CI; two-process concurrency of sync writes beyond `test_revision_races.py`; `epoch` mismatch and tombstone purge as random simulation actions; load/scale (TESTING 10.4); `reminder_policy`/`preferences` feed entities (not built); restoring a real backup and running `record-restore` (the command is tested, the drill is not repeated) |

### SYNC-04 — Note history, three-way merge, move/delete/revive rules, portable paths (sub-steps 04a-04g)

Local verification, 2026-11-03, uncommitted tree, CI not run. Decisions: ADR-0060. Statuses: `PASS`, `FAIL`, `BLOCKED`, `NOT RUN`.

| Criterion | Result | Evidence |
|---|---|---|
| 04a every revision of every note is recorded with its exact bytes (create, write, merge, move, folder rename, delete, revive, external edit) in every mode; files are content addressed and shared by revisions with the same text | `PASS` | `test_note_sync_merge.py`: `..every_revision_is_recorded_with_its_exact_bytes` (CRLF text, rows `create/write/move`, one file per distinct text), `..non_sync_writes_are_recorded_too`, `..a_folder_rename_keeps_every_note_mergeable`, `..an_edit_on_the_servers_disk_is_merged_not_overwritten` (reasons `merge, external, create`) |
| 04a a note that predates history is recorded by its next write, older revisions are unavailable (a stale client conflicts) | `PASS` | `..a_note_from_before_history_is_recorded_by_its_next_write`; `..a_base_that_is_no_longer_retained_is_a_conflict_not_a_guess` |
| 04a history is invisible to listings and reconcile, user-scoped (another user's note: `404` for history, read, `PUT`), a damaged or swapped file is never used, path-like hashes are refused, and it is inside every backup archive | `PASS` | `..history_files_are_invisible_to_listings_and_reconcile`, `..history_never_crosses_users`; `test_note_history.py`: `..a_damaged_or_swapped_history_file_is_never_used`, `..a_damaged_base_turns_a_stale_write_into_a_conflict`, `..history_is_part_of_every_backup` |
| 04a retention: newest N always, recent kept within 200 revisions / 64 MiB, old aged out by the job, the history of a long-deleted note removed, a shared text survives until both revisions are gone, repeat is a no-op | `PASS` | `test_note_history.py` (10 tests incl. the job function `prune_expired_history`, wired into `purge_change_log`) |
| 04a migration `e7a3c5b1d9f2`: adds the table, leaves existing notes untouched, FK cascade, down/up round trip, `alembic check` clean | `PASS` | `test_note_revisions_migration.py` (2) at the previous revision with a populated `notes` row; `test_migrations_match_models` |
| 04b merge: non-overlapping edits merge; touching, same-spot and delete-vs-edit conflict; CRLF/mixed/lone CR kept per line; final newline merged separately; BOM/emoji/UTF-8 untouched; front matter byte-identical to a side; huge or pathological input refused | `PASS` | `tests/unit/test_note_merge.py`: 20 examples + seeded properties over 300 seeds each (identities `merge(b,a,a)=a`, `merge(b,b,x)=x`, `merge(b,x,b)=x`; union of disjoint edits equals the expected text, symmetric, idempotent; "right or refused" with duplicate lines; different edits of the same lines never merge; no line lost or resurrected) |
| 04b library choice recorded (licence, maintenance); no dependency added | `PASS` | `DEPENDENCIES.md` "Considered and not adopted" (`merge3` GPL-2.0-or-later, `diff-match-patch` fuzzy patching, `three-merge` unmaintained since 2020, `git merge-file` not in the image), checked from the package metadata |
| 04c sync `PUT`: non-overlapping stale save merges silently and returns the merged content with `sync.merged`, `note_merged` and the next revision; the pre-merge text stays in history; exact bytes on disk | `PASS` | `..a_stale_save_that_does_not_overlap_merges_silently`, `..a_merge_keeps_crlf_and_the_missing_final_newline_exactly`, `..unicode_and_front_matter_survive_a_merge_byte_for_byte` |
| 04c overlapping/uncertain edits never overwrite: `409 conflict` with `reason`, `current_revision/hash`, `conflict_copy`; the copy holds the incoming text byte for byte, is announced on the feed, and a retry replays the same `409` and the same copy (no second one); `base_unavailable`, hash mismatch and two-sided front matter are conflicts | `PASS` | `..overlapping_edits_never_overwrite_and_are_kept_as_a_conflict_copy`, `..a_retried_conflict_replays_without_a_second_copy`, `..a_base_hash_that_does_not_match..`, `..front_matter_assembled_from_two_sides..` |
| 04c no-op saves do not bump the revision; a base from the future is `409 stale`; `base_hash` required (`422`), malformed/unknown fields refused; NUL and lone surrogate text is `422` | `PASS` | `..edits_that_change_nothing_do_not_bump_the_revision`, `test_sync_notes.py` (updated for the contract), `..the_text_must_be_utf8_and_free_of_nul` |
| 04c replay returns the first result with its `content` (merged text), also for create and move; with the revision pruned it returns the summary only | `PASS` | `..a_replayed_merge_returns_the_merged_content`, `..replays_of_create_and_move_carry_the_content`, `..a_replay_whose_revision_was_pruned..` |
| 04c four concurrent saves from one base all merge in a strict order; three overlapping ones give one winner and two conflict copies, every text kept | `PASS` | `..concurrent_saves_from_one_base_merge_or_conflict_but_never_lose_text` (real PostgreSQL row locks) |
| 04d stale `DELETE` is `409 edit_wins` with the live note, delete of a deleted note is `204`, a base from the future is `409 stale`, an unindexed external edit counts as an edit | `PASS` | `..a_stale_delete_is_refused_and_the_edit_wins`, `..deleting_after_an_unindexed_external_edit_is_refused` |
| 04d `PUT` of a deleted note revives it (old path, merged into the last text; overlap: revived with the last text plus a conflict copy; path reused: `name (2).md` + `path_collision`; no history: client text) | `PASS` | `..an_edit_of_a_deleted_note_brings_it_back`, `..the_revived_edit_is_merged..`, `..an_overlapping_edit_of_a_deleted_note..`, `..a_revive_whose_path_was_reused..`, `..a_note_deleted_before_history..` |
| 04d move: stale base allowed, later move logged `path_later_wins`, taken/case-variant target `409 path_exists`, same path no-op, a rename does not revive (`409 note_deleted`), a base from the future is stale | `PASS` | `..a_move_ignores_edits_made_since_its_base`, `..two_devices_moving_one_note..`, `..a_move_onto_a_live_note_is_refused_even_by_case`, `..a_rename_does_not_bring_a_deleted_note_back`, `..a_move_from_the_future_is_stale` |
| 04e portable paths in sync mode: 17 invalid paths (reserved names with/without extension in any segment, forbidden characters, control character, trailing dot/space, 241 chars, deep path, 255-byte name) are `422 invalid_path` on create and on move with nothing created; the limit itself is accepted; case and NFC/NFD variants are collisions; conflict-copy names stay within the limit; the web app (no sync mode) keeps every path | `PASS` | `..sync_mode_refuses_a_path_that_breaks..` (17 parametrised), `..the_web_app_outside_sync_mode_keeps_every_path_it_had`, `..a_path_differing_only_by_case_or_normalisation..`, `..a_valid_name_at_the_limit..`, `..a_conflict_copy_name_stays_portable` |
| 04f note simulation on the model: convergence and all note invariants, 3 clients x tasks+projects+notes and 4 clients notes-only, late joiner and purge, clock independence, outcome coverage (merge, conflict, revive, edit-wins, path_exists, collision, copy) | `PASS` | `test_sim_notes.py` default run (see counts below) |
| 04f each note invariant can fail: 10 planted defects (stale save overwrites; merge drops the client's edit; acknowledged save not applied; case-variant paths coexist; conflict copy truncated; retried conflict saves a second copy; stale delete wins; revive refused; idempotency ignored; client retries without its key) each trip a named invariant, reproduce from the seed and pass without the defect | `PASS` | `test_each_planted_note_defect_is_caught` (10) |
| 04f model and real API give identical answers on 6 note traces; 6 planted model defects make the comparison fail | `PASS` | `test_sim_notes_conformance.py` (13 tests) |
| 04f the same clients on the real API (per-test notes folder, late joiner, unsupported client) | `PASS` | `test_note_clients_converge_on_the_real_api` |
| Simulation found | note | seed 109 at 700 steps: a replayed delete acknowledgement tombstoned an entity another device had revived (R-40; model client now re-reads after a delete ack). Also adjusted the SYNC-03 regression planted bug so it still disables the re-read |
| Simulation soaks | `PASS` | model `ATLAS_SIM_SEEDS=1000 ATLAS_SIM_STEPS=300` over every sim module except real/planted/conformance (legacy, v1, notes): `4664 passed` in 136 s; real API `ATLAS_SIM_REAL_SEEDS=20 ATLAS_SIM_STEPS=150` (legacy, v1 and note runs plus the planted real-API cases): `82 passed` in 176 s; notes alone, real API, 20 seeds x 70 steps: `20 passed` in 33 s; notes model default (3 configurations) at 300 seeds x 300 steps: `681 passed` in 20 s |
| Repository checks | `PASS` backend, `FAIL` web unit (unrelated edit, below) | `./scripts/verify.sh` on the final tree: ruff, ruff format (270 files), mypy (126 files), pytest `3907 passed, 14 skipped` in 170 s (the 14 skips are the empty-base cases of the seeded merge properties; baseline before SYNC-04: 2027 on the SYNC-03 tree - the rest is the 1520 merge cases and the note tests below), eslint, tsc, vitest `817 passed` (73 files), `verification: PASS`. Earlier runs on intermediate trees: one `FAIL` (a ruff E501 in `tests/sim/real.py`, fixed) and one pytest `FAIL` (`test_regression_seed_482...` no longer failed because the new delete re-read also repaired the planted bug; the planted bug now disables that re-read too, as it does for creates) |
| New tests | info | `test_note_merge.py` 1520 cases, `test_note_sync_merge.py` 55, `test_note_history.py` 10, `test_note_revisions_migration.py` 2, `test_sim_notes.py` 294, `test_sim_notes_conformance.py` 13 |
| Real-stack browser suite (web unchanged: non-sync mode; one assertion added to the autosave journey: every autosave is a retained revision and the newest is the text on disk) | `PASS` | `cd apps/web && npm run test:e2e:real` -> `53 passed` (4.6 min) |
| Mocked browser suite | `PASS` | `npm run e2e` -> `7 passed` |
| OpenAPI and generated types | `PASS` | `openapi.json` regenerated, `npm run gen:api` leaves `apps/web/src/api/schema.d.ts` identical to the committed-in-tree version (new history endpoints, `NoteSyncResult`, `base_hash`, `NoteCopyOut`) |
| Migration tested on a representative existing schema | `PASS` | `test_note_revisions_migration.py` starts at `d5e8a2f1c4b9` with a populated `notes` row. **Not run:** any migration against the owner's `atlas` database (instruction); the owner's `atlas-migrate` applies `e7a3c5b1d9f2` (and the SYNC-03 migrations if still pending) |
| Old non-sync behaviour unchanged | `PASS` | all existing suites green; only `test_sync_notes.py` was adjusted (replay now carries content, `base_hash` is required, a same-text stale save is a no-op instead of `409 stale`: three documented contract changes); web autosave and conflict-copy flow covered by the real-stack `ux05` journeys and the mocked `sync-failure-modes` |
| Dev stack and owner data | `PASS` | nothing was restarted, no migration or test touched the `atlas` database (tests use `atlas_test`, the real-stack suite a throwaway database, the real-API simulations a per-test notes folder) |
| Known limitations (not defects) | note | R-44 history keeps overwritten/deleted text up to 90 days; R-45 conservative merge makes conflict copies for touching edits and two-sided front-matter edits; `ETag`/`If-None-Match` for note reads not built; `resolution` entries are response-only until SYNC-05; the export set carries current notes only (history is operational data, covered by backups) |
| Not covered | `NOT RUN` | CI; history pruning as a random simulation action (the model keeps 200 revisions; pruned bases covered by integration tests); unindexed external edits, folder renames and server restore as random simulation actions; two-process concurrency beyond the single-event-loop gather test (it does use separate database sessions and real row locks); any real client (SYNC-08/09) or device; load and scale of history on very large vaults (TESTING 10.4); a restore drill with history in the backup |

### SYNC-05 — Resolution log, feed entity and undo (sub-steps 05a-05g)

Local verification, 2026-11-03, uncommitted tree, CI not run. Decisions: ADR-0061. Statuses: `PASS`, `FAIL`, `BLOCKED`, `NOT RUN`.

| Criterion | Result | Evidence |
|---|---|---|
| 05a migration `f4a8b2c6d1e3`: adds an empty table, leaves tasks/projects/notes/feed rows and the cursor untouched, user cascade, rule and entity-type check constraints, one entry per `(op_key, ordinal)`, one undo entry per resolution, purging the original keeps the undo entry, downgrade drops the table **and** the `resolution` feed rows and keeps the entities, down/up round trip, `alembic check` clean | `PASS` | `test_sync_resolutions_migration.py` (3 tests; starts at `e7a3c5b1d9f2` with a populated user, project, task, note and three feed rows), `test_migrations_match_models` |
| 05b pure rules: only `simple_later_wins` and `path_later_wins` are undoable; every other kind names a reason and a follow-up; stored value bounded (4 096 bytes, a `null` value is still a value); cursor round trip and garbage rejected; strict merge turns every concurrent change into `changed_since` | `PASS` | `tests/unit/test_resolution_rules.py` (7 tests) |
| 05c feed: one `resolution` row per entry, `include=data` payload with state 1 (2 once undone), `types=resolution`, hidden from a legacy request without `types=` but with the same `next_since`/`head`, shown in sync mode, unknown type names still `422`, an undo re-announces the original and its own entry | `PASS` | `test_sync_resolutions.py`: `..announced_on_the_feed_with_data`, `..default_feed_shows_resolutions_only_in_sync_mode`, `..undo_re_announces_the_resolution_as_undone`; `test_sync_protocol.py` (entity list, one assertion changed for the new type); `tests/unit/test_change_feed.py` (vocabulary) |
| 05c retention: the purge job deletes entries older than the window with their feed rows, never entities, the floor is unchanged, a repeat is a no-op | `PASS` | `..retention_purge_removes_old_entries_and_their_feed_rows`, `..purge_job_runs_the_resolution_purge` |
| 05d what is logged: `simple_later_wins` (task, project; only fields really changed; a stored `null` loser), `edit_wins_over_delete` (revive; also a revive that ends in a conflict copy, replayed with the same ids), `note_merged`, `path_collision`, `path_later_wins`; nothing for a text conflict, a refused delete, non-sync mode | `PASS` | `test_sync_resolutions.py` (11 tests: `a_simple_field_later_wins_is_logged..`, `a_loser_of_null..`, `a_project_field..`, `text_conflicts_are_not_resolutions..`, `a_revive_is_logged..`, `a_refused_delete_writes_nothing..`, `no_resolution_outside_sync_mode`, `a_merged_note..`, `a_path_collision..`, `a_revive_that_ends_in_a_conflict..`, `a_note_move_that_overrides..`) |
| 05d same transaction: a request that fails after the write leaves no row, no feed row and no entity change; a replay logs nothing more and returns the same ids; the database refuses a second row for one `(key, position)` | `PASS` | `..failing_request_leaves_no_log_entry_and_no_feed_row`, `..replayed_write_logs_nothing_more`, `..same_key_and_position_cannot_be_logged_twice` |
| 05d no content: no text, description or note content in any row; application logs of a full flow contain no title, text, value or path | `PASS` | `..text_conflicts_are_not_resolutions_and_no_text_is_ever_stored`, `..merged_note_is_logged_without_content..`, `..application_logs_carry_no_values`; simulation `log_has_no_text` |
| 05e undo: restores the overwritten value through the revision-checked, strict write (priority, due date and its reminder, status incl. `completed_at`, tags, project status, note path); idempotent by key (replay, concurrent retries apply once); second undo `409 already_undone`; own `undo` entry; original marked undone | `PASS` | `..undo_restores_the_overwritten_value..`, `..idempotent_by_key..`, `..undo_requires_a_key`, `..undo_reschedules_the_reminder..`, `..undo_of_a_status_follows_the_state_machine`, `..undo_of_tags..`, `..undo_of_a_project_field`, `..concurrent_retries_of_one_undo_key_apply_it_once`, `..two_concurrent_undos_of_one_resolution_yield_exactly_one_undo` |
| 05e undo never overwrites newer data silently: a field changed since is `409 conflict`/`changed_since` with the current value and the entry stays undoable; a note moved again is the same; a deleted entity is `409 entity_deleted` and stays deleted; a no-longer-valid value (deleted project, illegal status step) is a conflict; a taken path is `409 path_exists`; a racing newer write is never lost | `PASS` | `..undo_never_overwrites_a_newer_value`, `..undoing_a_move_is_refused_when_the_note_moved_again`, `..undo_never_brings_a_deleted_entity_back`, `..undo_reports_a_value_that_is_not_valid_any_more`, `..undoing_a_move_onto_a_taken_path..`, `..undo_racing_a_newer_write_never_overwrites_it` (real row locks, 6 rounds) |
| 05e non-undoable kinds are explicit: `note_merged` -> history revision link, `edit_wins_over_delete` -> delete again (an ordinary delete works), `path_collision` -> rename; `undo` entries are final | `PASS` | `..a_revive_is_logged_as_edit_wins_and_cannot_be_undone`, `..merged_note_is_logged..`, `..path_collision_is_logged_and_not_undoable`, unit tests |
| 05e scope and gate: another user's entry and an unknown id are the same `404` for get, undo, list and feed (and the row is untouched); `Atlas-Epoch` mismatch is `409 epoch_mismatch` on list and undo; list is paged newest first with a cursor, filters, `422` on a bad limit or cursor | `PASS` | `..another_users_entries_are_invisible..`, `..resolution_endpoints_check_the_epoch`, `..list_pages_newest_first_and_filters` |
| The log is in the backup and comes back with a restore | `PASS` | `..a_backup_carries_the_log_with_the_database` (dump holds the table, row and entity id); **manual drill:** a backup set of a database with one resolution and its undo, loaded into a scratch database with `psql` (container `atlas-db-1`, database `atlas_drill_restore`, dropped afterwards): `alembic_version f4a8b2c6d1e3`, both `sync_resolutions` rows with `loser`, the undo link and `undone_at`, both `resolution` feed rows, the task at revision 4; model scenario: a restore to an older snapshot brings the older log and its feed back, an entry of the restored log can still be undone |
| 05f model/real conformance: 6 traces (later-wins + feed + list + undo + replay + refusals; newer value; non-undoable kinds; project; notes merge/collision/move/path undo/`path_exists`/non-undoable; revive ending in a conflict, replayed) give identical normalised answers; 4 planted model defects make the comparison fail | `PASS` | `test_sim_resolutions.py` (10 tests). The traces found two model/real disagreements before they passed (`kept_revision` of revive and collision, `detail` of `path_later_wins`) and a real inconsistency (`GET` of an unknown id answered the framework `404`, now `{error: not_found}` like undo) |
| 05f simulation on the model: clients that pull `resolution` and undo converge; 4 clients x tasks+projects+notes, late joiner, purge, clock independence; every outcome occurs (all 6 rules, applied and no-op undos, refusals `conflict`, `already_undone`, `not_undoable`, `path_exists`) | `PASS` | `test_sim_resolutions_model.py` default (100 + 40 + 40 seeds x 250 steps, coverage test over 60 seeds: 860 `simple_later_wins`, 425 revives, 800 collisions, 60 merges, 45 later-wins moves, 680 undo entries of which 570 applied) |
| 05f each invariant can fail: 10 planted server defects (reported but unlogged resolution; replay logs again; refused delete logs; entry not announced; merged note keeps content; undo ignores a newer value; undo twice; undo not logged; undo retried with its key evaluated again; undo revives a deleted entity) trip a named invariant, reproduce from the seed and pass without the defect; a restore that keeps the newer log fails the log/state check | `PASS` | `test_each_planted_defect_is_caught` (10), `test_the_log_is_restored_with_the_database` (2) |
| 05f the same clients on the real API (3 clients, notes, late joiner, undo wave) | `PASS` | `test_sim_resolutions_real.py` (3 seeds default); 8 seeds x 150 steps measured: 24 applied undos, refusals `conflict` 7, `already_undone` 55, `not_undoable` 165, `path_exists` 3 |
| Simulation soaks | `PASS` | model `ATLAS_SIM_SEEDS=1000 ATLAS_SIM_STEPS=300` over every sim module except real/planted/conformance: `5746 passed` in 212 s (legacy, v1, notes and resolutions; baseline before SYNC-05: `4664 passed`); real API `ATLAS_SIM_REAL_SEEDS=20 ATLAS_SIM_STEPS=150 -k real` (legacy, v1, notes, resolutions, planted real cases): `108 passed` in 266 s (final tree) |
| Repository checks | `PASS` backend, `FAIL` web unit (unrelated edit, below) | `./scripts/verify.sh` on the final tree: ruff, ruff format (283 files), mypy (130 files), pytest `4172 passed, 14 skipped` in 229 s: `PASS`. eslint and tsc `PASS`. **vitest: `FAIL` on the final tree, `1 failed | 859 passed` (`TaskRow.test.tsx`, an overdue-date text) - caused by a concurrent session's uncommitted UX-09 edits to `apps/web/src/components/TaskRow.tsx` and others, not by SYNC-05 (which changes no web source except the generated `schema.d.ts`).** The whole `./scripts/verify.sh` was `PASS` earlier on the SYNC-05 tree before those edits appeared (pytest `4169 passed, 14 skipped`, vitest `817 passed` in 73 files, `verification: PASS`). One intermediate run `FAIL`ed on a pre-existing time-dependent assertion in `test_sim_notes_conformance.py` (two conflict copies created in different clock seconds are listed in a different order than the model's); the assertion now compares the list as a set (baseline before SYNC-05: `3907 passed, 14 skipped`) |
| Real-stack browser suite (web unchanged; non-sync mode) | `PASS` | `cd apps/web && npm run test:e2e:real` -> `53 passed` (4.6 min) |
| Mocked browser suite | `PASS` | `cd apps/web && npm run e2e` -> `7 passed` (6 s) |
| OpenAPI and generated types | `PASS` | `openapi.json` regenerated (gitignored), `npm run gen:api` regenerated `apps/web/src/api/schema.d.ts` (`ResolutionOut`, `ResolutionListOut`, `ResolutionUndoOut`, `SyncResolutionOut.id`, the three endpoints, `resolution` in `ChangeOut.data`); `npm run typecheck` clean |
| Migration tested on a representative existing schema | `PASS` | see 05a. **Not run:** any migration against the owner's `atlas` database (instruction); the owner's next `atlas-migrate`/stack start applies `f4a8b2c6d1e3` (after the earlier ones if pending) |
| Old non-sync behaviour unchanged | `PASS` | all existing suites green; the only existing tests changed: `test_sync_protocol.py` and `test_change_feed.py` (the advertised entity set gained `resolution`) and the conformance model, which now logs; web code unchanged except the generated `schema.d.ts` |
| Dev stack and owner data | `PASS` | nothing restarted, no migration or test touched the `atlas` database (tests use `atlas_test`, the real-stack suite a throwaway database, the restore drill a scratch database that was dropped) |
| Found by the work | note | (1) a retried refused note `DELETE` (same key) replayed status `0`: the `409 edit_wins` committed the key with no stored answer (SYNC-04 code; fixed, `test_a_retried_refused_delete_replays_the_refusal`); (2) the model had to be corrected twice by the conformance traces (above); (3) `resolution_logged_once` first flagged a legitimate case: two no-op undos on one field share a revision, so "one write per (entity, rule, field, revision)" must not include `undo` (the simulation harness was wrong, not the server) |
| Known limitations (not defects) | note | R-47 overwritten simple values and note paths stay up to 90 days; R-48 strict undo is refused often on busy fields; a refused stale delete is not logged (ADR-0061); `device_id` is always `NULL` until SYNC-06; the model cannot simulate two users, so cross-user isolation rests on integration tests; the purge is exercised by integration tests, not as a random simulation action; retention drops a notice without a tombstone (clients expire by age); a conflicting text edit has no persisted resolve action (the response and the note conflict copy are the artefacts) |
| Not covered | `NOT RUN` | CI; any real client (SYNC-08/09) or the UI (SYNC-11); load/scale of the log; a restore drill through the full Compose stack (the drill above restored the dump into a scratch database and read it back; the app was not started on it) |

### SYNC-06 — Device credentials (sub-steps 06a-06h)

Local verification, 2026-11-03/04, uncommitted tree, CI not run. Decisions: ADR-0065. Statuses: `PASS`, `FAIL`, `BLOCKED`, `NOT RUN`.

| Criterion | Result | Evidence |
|---|---|---|
| 06a migration `b7c4d9e2a1f5`: adds an empty `devices` table, leaves tasks/sessions/resolutions untouched, unique token hash, platform and name checks, user cascade, `sync_resolutions.device_id` foreign key (`SET NULL`, unknown device refused), downgrade drops the table and clears `device_id`, down/up/up round trip; also clean schema (session fixture `downgrade base` / `upgrade head`) | `PASS` | `tests/integration/test_devices_migration.py` (3 tests, previous revision with a populated schema); `test_sync_resolutions_migration.py` still passes through the new head |
| 06b/06d sign-in: 256-bit token shown once, only its SHA-256 stored (a row dump contains neither token nor prefix), no cookie, no CSRF header, unknown account = wrong password = inactive account (same `401`), shared login rate limit, validation errors never echo the password (6 bodies), 25-device bound | `PASS` | `test_devices.py` sign-in tests |
| Bearer sync: tasks, projects, notes, `/api/changes`, `/api/tasks/changes`, resolutions, search, `GET /api/instance`, `GET /api/auth/me` work with a device token; `Atlas-Epoch` is honoured; the browser sees the device's data | `PASS` | `test_a_device_syncs_the_data_endpoints_without_cookies_or_csrf` |
| Scope (default deny): the exact set of device-open endpoints is asserted by walking every router; password change, profile edit, export, calendar credentials, notification registry, revoke-all, rename and revoke of other devices are `403 forbidden_scope` with a real device token; a bad token is still `401` | `PASS` | `test_the_set_of_endpoints_open_to_devices_is_exactly_this`, `test_a_device_cannot_use_account_level_endpoints` (8 cases), `test_scope_is_checked_after_the_token...` |
| Revocation: list (newest first, `current` marker, revoked hidden unless asked), rename (trim, 1-80, other user = `404`, CSRF on the browser path), revoke one (immediate `401 token_revoked` for the next request, idempotent, other user/unknown = `404`), revoke all, device signs itself out, revoked row ends the grace window | `PASS` | `test_devices.py` list/rename/revoke tests |
| Rotation: new token, old token valid in the window, ends when the new one is used, ends after 24 h, rotation with the old token after a lost response recovers, revoked device cannot rotate | `PASS` | `test_devices.py` rotation tests, `test_a_rotated_away_token...` |
| Expiry and `last_seen_at`: 91 days idle = `401 token_expired`, 89 allowed, never-used device expires from creation; `last_seen_at` is the server's `now()` (forged `Date` ignored), not rewritten inside 5 minutes, rewritten after, recorded when the request itself fails, never for a revoked device, **one bookkeeping connection for a burst of 20 parallel requests** | `PASS` | `test_devices.py` expiry / `last_seen_at` / burst tests |
| Rate limits per device (600 requests, 120 writes a minute): `429 rate_limited` with `Retry-After`, another device on the same address and the browser unaffected | `PASS` | `test_devices_are_rate_limited_per_device_not_per_address`, unit `test_retry_after_...` |
| Password: change keeps devices by default and revokes them with `revoke_devices`; a wrong current password revokes nothing; `atlas-admin reset-password` revokes every device and returns `(sessions, devices)`; `list-devices` / `revoke-device` (one, all, unknown, other account) | `PASS` | `test_a_password_change_keeps_devices_unless_asked`, `test_a_wrong_current_password_revokes_nothing`, `test_the_operator_reset_revokes_every_device_token`, `test_admin_cli.py` |
| `device_id` in the resolution log: list, feed `include=data` and undo name the device that wrote (undo entry = the undoing device, the original keeps its writer); a browser write is `NULL`; purging a device keeps the resolutions | `PASS` | `test_the_resolution_log_names_the_device_that_wrote`, `test_a_browser_session_write_has_no_device`, `test_purging_a_device_keeps_its_resolutions` |
| Security scenarios: stolen token works until revoked then never (also not rotation, not the list); a thief cannot reach password/revoke-all/export/calendar; a rotated-away token dies; users isolated for data and devices (rename, revoke, revoke-all); cookie requests still need CSRF with or without a Basic `Authorization` header; a bad bearer is not rescued by a cookie and writes nothing; a cookie + valid bearer cannot change the password (`403`); a session token is not a device token and the reverse; a device request sets no cookie | `PASS` | `tests/integration/test_device_security.py` (23 tests) |
| Token hygiene: no token (current, rotated, unknown) and no password in any log record, error body or response header of a full flow; database holds hashes only (a stored hash presented as a token is `401`); malformed `Authorization` headers (7 shapes) are plain `401`; scheme is case-insensitive, the token exact; deactivated account loses its devices; account deletion cascades | `PASS` | same file |
| Purge: devices revoked before the retention window are deleted by the hourly job (idle never-revoked and recent ones stay), repeatable | `PASS` | `test_the_purge_job_deletes_old_revoked_devices_only` |
| Backups: the dump holds `devices` with hashes only and no `atd_` string | `PASS` | `test_a_backup_carries_the_devices_as_hashes_only`. **Manual restore drill** (scratch databases `atlas_drill_dev_a`/`_b` in `atlas-db-1`, both dropped): two devices signed in on A, one revoked through the API, `pg_dump` of A loaded into B with `psql`; the dump contained no token; against B the kept device's token answered `200` and the revoked device's `401 token_revoked`. Consequence recorded in `OPERATIONS.md` 2.2a: revocations made after a backup are lost by a restore |
| 06g simulation: every client a device on the real API through the hostile schedule; each resolution (and undo) names the writer's device, none anonymous; a device revoked mid-run is never served 2xx again and its client stops at the first `token_revoked` (planted defect `ignore_revoked` is caught) | `PASS` | `tests/sim/test_sim_devices.py`: default 7 passed; `ATLAS_SIM_REAL_SEEDS=20 ATLAS_SIM_STEPS=150`: `41 passed` in 126 s. **The soak found a harness gap (seed 19, 150 steps):** `no_acknowledged_note_loss` blamed a line that an *unacknowledged* save of the revoked device had removed on the server; fixed in the invariant (a revoked client's pending saves may have removed lines), no product defect. Also earlier: `no_duplicates` allows creates a revoked device applied but never saw acknowledged |
| Simulation soaks (all other suites) | `PASS` | model `ATLAS_SIM_SEEDS=1000 ATLAS_SIM_STEPS=300 pytest tests/sim -k "not real and not planted and not conformance"`: `5753 passed` in 239 s (baseline before SYNC-06: `5746`); real API `ATLAS_SIM_REAL_SEEDS=20 ATLAS_SIM_STEPS=150 pytest tests/sim -k real`: `108 passed` in 247 s (unchanged count; the device runs are the 41 above) |
| 06h web: Settings → Devices lists devices with platform and last seen (or "Not seen yet"), marks the current device, renames inline (Escape/Cancel, server message kept), asks once before signing out and before signing out all, shows failures, empty state with a sentence, skeleton while loading and a retry on a load error; never shows a token; "Also sign out my devices" box on the password form (off by default, reset after a change) | `PASS` | vitest `DevicesSection.test.tsx` (11 tests), `Settings.test.tsx` (+1), `settingsSections.test.ts`. **Accessible names:** list `Signed-in devices`; per row `Rename <name>`, `Sign out <name>`; rename field `Name for <name>` with `Save name` / `Cancel`; confirm group `Sign out <name>?` with `Confirm: sign out <name>` / `Keep signed in`; `Sign out all devices`, group `Sign out all devices?`, `Confirm: sign out all devices` / `Keep them signed in`; checkbox `Also sign out my devices` described by its hint; status text in `aria-live="polite"` |
| 06h real-stack browser: bearer journey (sign in with the password, token syncs and appears in the Tasks page, account endpoints refused, a bad bearer with a live session cookie writes nothing, Settings lists, renames, signs out with confirmation, next request `token_revoked`, sign out all); Devices section axe clean at 1440/390/360 px in both themes in four states (list, rename, confirm, sign-out-all), no sideways scroll, every control >= 44 px on phone widths, no clipped rows; ux08/ux11 sweeps include the section | `PASS` | `cd apps/web && npm run test:e2e:real` -> `71 passed` (10.1 min; 69 before, +2 in `sync06-devices.spec.ts`; the ux08 and ux11 specs now also cover `/settings/devices`) |
| Mocked browser suite | `PASS` | `npm run e2e` -> `7 passed` (6 s) |
| Repository checks | `PASS` | `./scripts/verify.sh` on the final tree: ruff, ruff format (291 files), mypy (133 files), pytest `4251 passed, 14 skipped` (baseline before SYNC-06: `4172`), eslint, tsc, vitest `908 passed` in 79 files (baseline `896`/`898`), `verification: PASS` |
| OpenAPI and generated types | `PASS` | `openapi.json` regenerated (gitignored) and `npm run gen:api` regenerated `apps/web/src/api/schema.d.ts` (`DeviceSignIn`, `DeviceSignedIn`, `DeviceInfo`, `DeviceInfoList`, `DeviceRename`, `DeviceRevokeAllOut`, `PasswordChange.revoke_devices`, the eight endpoints); `npm run typecheck` clean |
| Migration against an existing installation | `PASS` (tests), `NOT RUN` (owner's DB) | tested on `atlas_test`, a populated previous schema and scratch databases only. The owner's next `atlas-migrate`/stack start applies `b7c4d9e2a1f5` after the earlier pending ones |
| Old behaviour unchanged | `PASS` | every existing suite green; the only existing tests changed: `test_admin_cli.py` (`reset_password` returns a pair), `Settings.test.tsx` / `settingsSections.test.ts` (eighth section, the password call's third argument, the success text) and the sim harness (additions only); browser sessions, CSRF and the data endpoints behave as before |
| Dev stack and owner data | `PASS` | nothing restarted, no migration or test touched the `atlas` database (tests use `atlas_test`, the real-stack suite a throwaway database, the drill scratch databases which were dropped). No new dependency, setting, icon or environment variable (`DEPENDENCIES.md` unchanged) |
| Found by the work | note | (1) the sim `no_duplicates` and `no_acknowledged_note_loss` invariants assumed every applied write is eventually acknowledged, false for a revoked device (harness fixed, see above); (2) a restore resurrects a device that was revoked after the backup (documented, operator step); (3) twenty parallel requests of one device would each have opened a second connection for the `last_seen_at` write - claimed once now (test); (4) FastAPI 0.154 wraps included routers (`app.routes` no longer lists endpoints), so the scope test walks the routers in `atlas.api.__all__`; (5) a mid-work `git checkout` of one generated file discarded unrelated edits to it (re-done; the tree was otherwise clean) |
| Known limitations (not defects) | note | R-52 rotation does not detect theft of the current token; R-53 no feed-page / snapshot-start limits, in-process limiters; a password change keeps devices unless the box is ticked (ADR-0065 point 5); idle never-revoked devices stay listed and count toward the 25; a device's `last_seen_at` is only accurate to 5 minutes; **no native client exists yet** (the keystore, HTTPS-only enforcement and scheduled rotation are SYNC-09/10): the bearer path is exercised by tests and the simulation only |
| Not covered | `NOT RUN` | CI; a second API process (limiters and the touch memo are per process); a real desktop/Android client; behaviour behind a real reverse proxy that strips `Authorization` (the shipped nginx forwards it; not tested); Safari/Firefox rendering of the new section |

### P0-1 / P0-2 / P0-3 - Personal alpha: Compose smoke, HTTPS, backups and restore drill

Local verification, 2026-11-03, uncommitted tree, CI not run. Isolated Compose projects `atlas-smoke`, `atlas-smoke-up`,
`atlas-smoke-restore` (own volumes, throwaway secrets, ports 18000-18443 on loopback, all removed afterwards); the owner's
`atlas-db-1`, `atlas` database, `data/dev` and dev stack were not touched. Statuses: `PASS`, `FAIL`, `BLOCKED`, `NOT RUN`.

| Criterion | Result | Evidence |
|---|---|---|
| P0-1 images build from the current tree | `PASS` | `docker compose -p atlas-smoke ... build` (api, worker, web) |
| P0-1 empty database migrates on start to `e7a3c5b1d9f2`; all four services healthy; worker no errors | `PASS` | api log shows every revision `eefce463b569` -> head; `ps`: db/api healthy |
| P0-1 first-run setup, second setup `409`, bad login `401`, login `200`, CSRF wrong/absent `403` | `PASS` | scripted HTTP through the `web` container |
| P0-1 notes 1.5 MiB, 5 MiB and 5 MiB of newlines (10 MiB JSON body) through nginx | `PASS` | `201` each; 12 MiB body: nginx `413`; 5 MiB + 1: `422` |
| P0-1 oversized note answers with a small error | `FAIL` then fixed | the 422 echoed the whole 5 MiB body; `main.py` now drops large `input`; `test_an_oversized_note_is_a_422_that_does_not_echo_the_body` |
| P0-1 task, project, project task list, search, history, export, `/api/instance`, health, `/health/ready` | `PASS` | same script |
| P0-1 worker runs jobs: backup at start and on schedule, reminder at its minute (`log` channel), scans, purge | `PASS` | `jobs` rows `succeeded`; `reminders.status=sent`, `reminder_deliveries` row at 16:01:00 |
| P0-1 `atlas-backup run/list/verify` and `atlas-export run/verify` inside the containers | `PASS` | export sets were written to an unmounted path (lost on recreate): `FAIL` then fixed with the `atlas-exports` volume |
| P0-1 Compose forwards every setting | `FAIL` then fixed | not forwarded: `TOKEN_ENCRYPTION_PREVIOUS_KEYS`, `SESSION_TTL_SECONDS`, `AUTH_RATE_LIMIT_PER_MINUTE`, `CORS_ORIGINS`, `REMINDER_SCAN_SECONDS`, `CALENDAR_RECONCILE_SECONDS`, `BACKUP_RETAIN` (api); `NOTE_HISTORY_*`, retention and sync settings were already forwarded. `tests/unit/test_compose_env.py` |
| P0-1 install from `.env.example` works | `FAIL` then fixed | `.env.example` set a `DATABASE_URL` password but no `POSTGRES_PASSWORD`, so api could not log in to db; the URL is now built from `POSTGRES_*` |
| P0-1 production `ALLOWED_HOSTS=<public name>` keeps the stack healthy | `FAIL` then fixed | the healthcheck (`Host: localhost`) and `/health` through nginx got `400`, api unhealthy, worker never started; `/health*` is exempt (`test_trusted_host_rejects_unknown_host`); re-verified with `ALLOWED_HOSTS=atlas.example.com` and `=localhost` |
| P0-1 web published only on loopback by default | `PASS` after change | was `0.0.0.0:8080` (plain HTTP on every interface); `WEB_BIND` |
| P0-1 Chromium (Playwright) against the real stack: load, sign in, reload, console | `PASS` | Today view rendered; only console error is the expected pre-login `401` |
| P0-1 upgrade from `b7d3e1a95c24` with data to head via the new images | `PASS` | old tree (`ea85a32`) built and seeded through its API (4 notes incl. a 3 MiB and a soft-deleted one, 3 tasks incl. recurring and deleted, project link); pre-upgrade backup; `up -d --build` ran `a1f0c3d2b4e6`, `c3b7d9e1f2a8`, `d5e8a2f1c4b9`, `e7a3c5b1d9f2`; DB fingerprint and every note file hash identical before/after; `compare_metadata` `[]`; field revisions backfilled to 1; reading, editing (history starts at the first edit; earlier revisions have no history), re-creating the deleted path (revives the note), feed, export, search work |
| P0-1 downgrade to `b7d3e1a95c24` and upgrade again with data | `PASS` | data intact; `note_revisions` rows are lost by the downgrade (the history files stay on disk) |
| P0-2 Caddy in front, TLS verified against its CA, cookies `Secure`, `HttpOnly` (session), `SameSite=Lax`, CSRF, 5 MiB note, Chromium secure context | `PASS` | `DEPLOYMENT.md` §8.2 table |
| P0-2 ACME certificate issuance (real name) | `NOT RUN` | no public name; Caddy used `local_certs` |
| P0-2 `tailscale serve` | `NOT RUN` | forbidden to change Tailscale on the owner's machine; documented from the CLI |
| P0-2 API redirect `Location` behind an HTTPS proxy | `FAIL` (accepted) | `http://localhost/api/tasks` for `/api/tasks/`; the web app never uses such URLs; R-46 |
| P0-3 scheduled backups run, retained, verified | `PASS` | `BACKUP_INTERVAL_SECONDS=60`, `BACKUP_RETAIN=3`: one set per minute, oldest pruned, `atlas-backup verify` ok |
| P0-3 off-machine copy | `PASS` | `docker compose cp worker:<set> ./offsite/` (3 files) |
| P0-3 restore drill into a second empty project from the smoke project's set, following `OPERATIONS.md` section 2 | `PASS` | `OPERATIONS.md` 2.7: fingerprint, notes tree incl. `.atlas/history` and login identical |
| P0-3 `atlas-admin record-restore` | `PASS` | prints `restore recorded`, twice without error |
| P0-3 `atlas-admin list-users` / `reset-password` | `PASS` | old password `401`, new `200`, 9 sessions signed out |
| P0-3 restore drill on the owner's real data | `NOT RUN` | forbidden here; the owner still has to do one (Roadmap P0-3) |
| `./scripts/verify.sh` | `PASS` | 3912 passed, 14 skipped; frontend 817 passed; ruff, format, mypy clean |

Not covered: a browser on a second device, a real tailnet or ACME name, behaviour across a Docker host reboot
(`restart: unless-stopped` only), long-running disk growth, Windows/macOS Docker hosts.

## SYNC-08 — `packages/sync-core` (2026-11-04, local, not committed, CI not run)

| Criterion | Result | Evidence |
|---|---|---|
| Framework-free core (no React/DOM/window/fetch/localStorage/clock/timer/random globals) | PASS | `framework-free.test.ts` (8), ESLint `no-restricted-globals`, vitest `node` environment |
| Queue, frozen bases, byte-identical retries, backoff/429/5xx, 426/401/epoch halts, atomic page+cursor, snapshot/below_floor, cursor_ahead restore state, gap-fill acks, tombstones, notes rebase, notices/undo, status | PASS | 108 vitest tests in project `sync-core` (unit + simulation), `npm run test` in `apps/web` |
| Simulation on the TS model server | PASS | default 12 seeds x 120 steps per scenario; soak `ATLAS_SYNC_SEEDS=150 ATLAS_SYNC_STEPS=250` 9 tests PASS (219 s) |
| Simulation on the real API | PASS | `ATLAS_SYNC_REAL=1 ATLAS_SYNC_REAL_SEEDS=8 ATLAS_SYNC_STEPS=150`: 3 tests PASS (38 s; conformance scenario model == real, 8 seeds, revocation); throwaway `atlas_e2e_*` DBs, none left |
| Planted defects fail the named invariant, reproducible from the seed | PASS for 32; **3 NOT caught** (R-55) | `planted.sim.test.ts` |
| `./scripts/verify.sh` | PASS | pytest 4251 passed / 14 skipped, vitest 1016 passed / 3 skipped (1 file skipped = opt-in real run), lint, typecheck; script unchanged |
| `npm run test:e2e:real` / `npm run e2e` (web config touched) | PASS | 71 passed / 7 passed |
| Web app migrated to the core | **NOT DONE (deliberate)** | ADR-0066 point 8, R-54 |
| Server bugs found | none | the real-API runs and the conformance scenario found no divergence |

Client bugs the simulation found while building it (all fixed): a user edit allowed in the view of a tombstoned note was refused by the
mirror check (view and check now share `materialise`); a halt was believed before it was stored (a lost transaction left the engine
halted without a durable halt); `cursor_safety` had to excuse a local create whose id the feed deleted (placeholder without server state).
NOT RUN: SQLite/Android stores, concurrent entities in flight, real devices.

### AUTH-01 — Account recovery by a one-time recovery code (sub-steps 01a-01j)

Local verification, 2026-11-04, uncommitted tree, CI not run. Decisions: ADR-0067 (owner approved the design 2026-11-04). Statuses: `PASS`, `FAIL`, `BLOCKED`, `NOT RUN`.

| Criterion | Result | Evidence |
|---|---|---|
| 01b migration `c9e4a7b2d6f1`: adds an empty `recovery_codes` table; existing accounts (with sessions, devices, tasks) keep every row and have **no** code; one code per user (primary key), unknown user refused, `failed_attempts >= 0`, user delete cascades; downgrade drops the table and keeps users, tasks, sessions, devices; down/up/up round trip; also clean schema (session fixture `downgrade base` / `upgrade head`) | `PASS` | `tests/integration/test_recovery_migration.py` (3 tests, previous revision with a populated schema) |
| 01c code: 30 Crockford characters = 150 bits (>= 128), six groups of five, every symbol used and no repeats over 400 draws; entry tolerant of case, dashes, underscores, spaces and `O/I/L`; wrong length, `U`, non-ASCII digits and over-long input refused; salted HMAC (different salts and codes differ, the hash does not contain the code); account key holds no address | `PASS` | `tests/unit/test_recovery_code.py` (16 tests) |
| 01d reset: new password works and the old one does not; **every** browser session and **every** device is revoked (`401 token_revoked`) in the same transaction; the code is replaced (new code differs, `last_used_at` set, `failed_attempts` 0); response has only `recovery_code`, `created_at` and sets no cookie; sloppy entry accepted | `PASS` | `test_recovery.py::test_a_reset_changes_the_password_signs_everything_out_and_rotates_the_code` |
| Replay of a used code is the generic `400`; the replacement works; two simultaneous resets with one code give exactly one `200`; if the device revocation raises, password, sessions and code are unchanged and the code still works | `PASS` | `test_a_used_code_cannot_be_replayed...`, `test_two_simultaneous_resets...`, `test_the_reset_is_one_transaction` |
| **Mutation checks** (hand, once): remove device revocation; remove the row lock; skip the failure update for unknown accounts; skip rotation; skip session revocation | `PASS` (each caught by the named test: reset, race, equal-work, reset, reset) | run during 01d, `recovery.py` restored from a copy and diffed |
| Enumeration: unknown e-mail, account without a code, inactive account, wrong code, someone else's code and a malformed code all return `400` with a byte-identical body, identical headers and **identical SQL statements in identical order**; the real account is untouched afterwards | `PASS` | `test_every_refusal_is_the_same_response_and_the_same_work`. **Wall-clock timing equality: `NOT RUN`** (flaky as a test; the equal-statements test is the deterministic proxy; refusals do no Argon2) |
| Rate limits: 5 wrong tries per account then `429` + `Retry-After` **before the code is read** (the right code also waits); an unknown address is throttled identically; after 901 s (clock advanced) the owner is back; per-address limit across accounts with `Retry-After`; refused attempts are not counted so the window cannot be extended; idle buckets are pruned | `PASS` | `test_attempts_per_account_are_limited_and_the_limit_is_a_bounded_delay`, `test_attempts_per_address_are_limited_across_accounts`, unit `test_a_throttle_is_a_bounded_delay...`, `test_the_limiter_does_not_grow_without_bound` |
| `failed_attempts` counts wrong tries, is shown in the status, reset by a success, and never changes an answer | `PASS` | `test_the_failure_counter_is_diagnostic_and_not_an_answer` |
| Setup returns the code once and stores salt and hash only; status never carries the code or hash; a second setup (`409`) neither reveals nor replaces it; `/api/auth/me` has no code | `PASS` | `test_setup_returns_the_code_once_and_stores_only_a_hash`, `test_a_second_setup...` |
| Regenerate: needs a session (`401`), CSRF (`403`), the current password (`400`, nothing leaked), is rate limited with `Retry-After`; kills the old code; sessions untouched; an account created before AUTH-01 (no code) can create one; a device token gets `403 forbidden_scope` on status and regenerate | `PASS` | `test_regenerating_needs_the_password...`, `test_an_existing_account_without_a_code...`, `test_regeneration_guesses...`, `test_a_device_cannot_read_or_regenerate_the_code` |
| Other password changes unaffected: a Settings password change leaves the code valid; `atlas-admin reset-password` leaves it valid; `atlas-admin recovery-code` (`issue_code_for`) replaces it and refuses an unknown account; the CLI reset still returns `(sessions, devices)` | `PASS` | `test_an_ordinary_password_change_leaves_the_code_alone`, `test_the_operator_reset...`, `test_admin_cli.py` unchanged and green |
| Cross-user isolation: one account's code never opens another (both ways), regenerating for one leaves the other's code valid, a reset signs out only its own account | `PASS` | `test_one_users_code_never_opens_another_account` |
| `RECOVERY_ENABLED=false`: setup issues no code, status says `enabled: false`, reset and regenerate are `404`, the CLI reset still works; `RECOVERY_ENABLED` forwarded in Compose and `.env.example` | `PASS` | `test_recovery_can_be_turned_off`, `tests/unit/test_compose_env.py` (green, unchanged) |
| Cookies and CSRF: the reset is exempt like login, sets no cookie, and a session cookie that posts to it is revoked like the rest; validation errors never echo the code or any password (`422` without `input`) | `PASS` | `test_the_reset_is_unauthenticated_like_login_and_ignores_cookies`, `test_validation_errors_never_echo...` |
| Hygiene: no code (either spelling), password or submitted e-mail in any log record of a full flow (refusals and a `422` included); the audit events are exactly `recovery_reset_succeeded`, two `recovery_reset_refused`, `recovery_code_regenerated`, with counts and no secret; no plaintext code in any table of the database or in `GET /api/export` | `PASS` | `test_no_code_or_password_reaches_the_logs`, `test_the_database_and_the_export_hold_no_plaintext_code` |
| Backups: the real `pg_dump` holds the salt and hash and not the code (either spelling); the manifest neither | `PASS` | `tests/integration/test_recovery_backup.py` (uses the container `pg_dump` fallback like the backup tests). **Restore drill of this table: `NOT RUN`** (a dump of a table with two text columns; covered by the existing restore drill mechanism) |
| 01g OpenAPI and generated types | `PASS` | `openapi.json` regenerated (gitignored) and `npm run gen:api` regenerated `apps/web/src/api/schema.d.ts` (`SetupResult`, `RecoveryStatus`, `RecoveryCodeIssued`, `RecoveryReset`, `RecoveryRegenerate`, `SetupStatus.recovery_enabled`, the three endpoints); `npm run typecheck` clean |
| 01h web: setup holds the app back until "I have saved my recovery code" is ticked (copy, download, nothing in storage or the URL); Forgot password form with generic errors (400, 429, 422, off) and a confirmation check; the new code is shown once and "Back to sign in" waits for the acknowledgement; Settings → Account → Recovery code shows set/not set, created date, last use and wrong tries, Regenerate asks for the password and shows the code once, no button when recovery is off | `PASS` | vitest `RecoveryCodeReveal` (4), `ForgotPassword` (6), `RecoverySection` (6), `AuthProvider.recovery` (4). **Accessible names:** `Your recovery code` (the code), `Copy code`, `Download as file`, checkbox `I have saved my recovery code`, `Continue to Atlas` / `Back to sign in` / `Done`, link-button `Forgot password?`, fields `Email`, `Recovery code`, `New password`, `Confirm new password`, Settings field `Your password`, `Make a new code`, `Regenerate` / `Create recovery code` |
| 01i real-stack browser: setup shows the code once and is held until acknowledged, the file download is `atlas-recovery-code.txt` holding the code, nothing in storage or the URL; Settings regenerate with a wrong then the right password; the Forgot journey (wrong code and unknown email give the same text; sloppy entry works; old password refused, new works; a second browser's session and a device token are signed out; the used code is dead; the replacement code resets once more and the owner is restored); Sign in, Forgot password, the setup screen and the Settings row are axe clean at 1440/768/390/360 in light and dark, no sideways scroll, controls and checkbox labels >= 44 px and fields >= 16 px on phone widths | `PASS` | `auth01-recovery.spec.ts` (5 tests). **Found by it:** a transition caught mid-way produced a false contrast finding (the specs use `reducedMotion: "reduce"`); a cascade-specificity miss left 32 px inputs on the phone auth pages (fixed in `styles.css`); two `Current password` labels on one page (the Settings row is now `Your password`); `capture-journey.spec.ts` assumed it creates the owner (now `ensureOwner`) |
| Repository checks | `PASS` | `./scripts/verify.sh` on the final tree: ruff, ruff format (298 files), mypy (135 files), pytest `4294 passed, 14 skipped` (baseline before AUTH-01: `4251`; +43: 16 unit, 23 + 3 + 1 integration), eslint (incl. sync-core), `check-css-scale`, tsc, vitest `1036 passed, 3 skipped` in 94 files (baseline `1016`; +20), `verification: PASS` |
| Real-stack browser suite and mocked suite | `PASS` | `cd apps/web && npm run test:e2e:real` -> `76 passed` (10.7 min; 71 before, +5 in `auth01-recovery.spec.ts`; the first full run was `75 passed, 1 failed`: `capture-journey.spec.ts` assumed it creates the owner, fixed with `ensureOwner`, then the full suite re-run green); `npm run e2e` -> `7 passed` (7 s). `verify.sh` ran on the tree before two later one-line edits (`capture-journey.spec.ts`, which `lint`/`tsc` and the full e2e re-run covered, and one assertion in `test_recovery.py`, re-run alone: pass); it was not re-run in full |
| Migration against an existing installation | `PASS` (tests), `NOT RUN` (owner's DB) | tested on `atlas_test` and a populated previous schema only; the owner's next `atlas-migrate` / stack start applies `c9e4a7b2d6f1` (after `b7c4d9e2a1f5` if that is still pending). Until the owner creates a code in Settings the account has none |
| Dev stack and owner data | `PASS` | nothing restarted; no migration or test touched the `atlas` database (tests `atlas_test`, browser suites throwaway `atlas_e2e_*` databases, checked at the end) |
| Known limitations (not defects) | note | R-56 the code is a bearer secret with no leak detection, and a code can be lost if the tab is closed before the acknowledgement (regenerate in Settings or `atlas-admin recovery-code`); R-57 limiters are in-process and a stranger can keep *recovery* throttled; after a reset the browser is **not** signed in (by design); a restore from an older backup returns the older code and password (`OPERATIONS.md` 2.2b); the recovery download is a plain text file on the owner's disk; no e-mail or push notice of a reset (no channel exists) |
| Observed, not changed (outside AUTH-01) | note | on Settings → Account the pre-existing "Also sign out my devices" checkbox is drawn 240 px wide (`.settings-row-control input:not([type="radio"])` also matches checkboxes); cosmetic, the row stays operable and axe clean |
| Not covered | `NOT RUN` | CI; wall-clock timing equality; a second API process; Safari/Firefox rendering; a password manager's autofill of the code; a real phone; the whole flow behind the real nginx/TLS proxy |

## SYNC-07 — Tauri 2 spike, Linux part (2026-11-04, local, not committed, CI not run)

Status of the task: Linux part `IN_REVIEW`; Windows and Android `BLOCKED` on hardware. Numbers, environment and the verdict are in `docs/SYNC_PROTOCOL.md` section 13 (single
source, not repeated); raw outputs in `spikes/tauri/results/`; code and commands in `spikes/tauri/README.md`. Nothing in `apps/web`, `services/api`, `packages/*` or `scripts/` was
changed; `./scripts/verify.sh` was **not run** (another agent was using it; the spike is outside its scope).

| Criterion (`ROADMAP.md` SYNC-07 plan) | Result | Where |
|---|---|---|
| S1 existing UI renders in WebKitGTK; CSS features; scenario vs Chromium | `PASS` (features, 20/20 desktop, 19/20 phone same as Chromium) with defects D1 select, D2 date inputs (`FAIL`, fixable) | 13.1 S1.1-S1.3 |
| S1 J1-J7 in the shell, axe, IME, real key events, latency p95 < 50 ms | `BLOCKED` (no `WebKitWebDriver`) / `NOT RUN`; synchronous edit cost `PASS`, post-edit frame inconclusive | S1.4-S1.6 |
| S2 SQLite, transaction page+cursor, kill-9 x100, migrations | `PASS` (`rusqlite`); `tauri-plugin-sql` `FAIL` as transaction vehicle (source reading, link conflict) | S2, S2b |
| S3 notes folder, scan, watcher, scope | `PASS` with limits (shell-simulated editors; same-size edit missed by size+mtime scan; Access-event loop found) | S3 |
| S4 keystore | `PASS` Secret Service/KWallet; GNOME Keyring and locked wallet `NOT RUN` | S4 |
| S5 notifications | `PASS` immediate; scheduled-with-app-closed `FAIL` on desktop | S5 |
| S6 auto-update, signature rejection | `PASS` Linux AppImage (valid, tampered, wrong key); Windows `NOT RUN`; `.deb` install `NOT RUN` | S6 |
| S7 Windows install without admin; S8 Android background sync | `NOT RUN` (hardware), checklists written | 13.3, 13.4 |
| S9 size, start, memory | `PASS` start (184-233 ms) and sizes; memory 397 MB PSS idle (above the 300 MB review line, 30 s idle, one note) | S9 |
| S10 capabilities, audit, maintenance, licences | `PASS` with warnings (0 vulnerabilities; 5 unmaintained/unsound transitive crates) | S10, `DEPENDENCIES.md` |
| X1 single instance; X2 HTTPS/CORS/CSP/capabilities and real `sync-core` round trip | `PASS` | X1, X2 |
| Verdict | stay with Tauri 2, no Electron criterion triggered on Linux, **conditional** on Windows S6/S7 and real-input checks | 13.2 |
| Isolation and cleanup | `PASS` | spike not in any workspace (configs read: `apps/web/eslint.config.js`, `tsconfig.json` `include`, `vite.config.ts` test projects, `ci.yml` working directories); throwaway DB dropped (only `atlas` and `atlas_test` remain), stack processes stopped, test Secret Service entry cleared, nothing published, no owner key used (throwaway minisign pair in the scratchpad) |
| Not covered | `NOT RUN` | Windows, Android, macOS (not in scope); real editors (VS Code, Obsidian, vim, `git checkout`) against the watcher; dialog plugin and plugin-fs `watch`; HTTPS update and HTTPS API with a publicly trusted or private-CA certificate; AppImage on another distribution; 10-minute idle memory with 5 000 notes; CI |

### SYNC-07 addendum: GitHub-hosted Windows runner (2026-11-04, committed and pushed; workflow `.github/workflows/windows-spike.yml`, manual only)

Status of the task: Linux part `IN_REVIEW`; the **mechanical** Windows part is `PASS` on a hosted runner; the **owner-environment** Windows part (S7 standard user / UAC / SmartScreen / AV / OneDrive / IME, S1 in WebView2) and Android remain `NOT RUN`. Numbers and what the runner can and cannot prove: `docs/SYNC_PROTOCOL.md` 13.3a (single source).
Runs: [41803343231](https://github.com/Mauz92/atlas/actions/runs/41803343231) `FAIL` (my `Get-Item`/registry script bug, build and headless checks passed), [41805706305](https://github.com/Mauz92/atlas/actions/runs/41805706305) `FAIL` (updater script used a hashtable member that did not exist; smoke ran and showed the single-instance harness needed `SPIKE_SUITE=hold`),
[41808348307](https://github.com/Mauz92/atlas/actions/runs/41808348307) `PASS` (found W1, the Windows directory-`fsync` defect, in the previous run's artifacts and fixed it; watcher path-separator gap remained), [41810645362](https://github.com/Mauz92/atlas/actions/runs/41810645362) `PASS` (final; 10 min 17 s for the Windows job, 37 s for the supply-chain job).

| Criterion | Result | Evidence |
|---|---|---|
| Workflow is manual only, time-boxed, secret-free, actions pinned to SHAs | `PASS` | `on: workflow_dispatch` only; `timeout-minutes` 75 / 15 / 15 / 25; no `secrets.*`; four actions pinned by SHA (`DEPENDENCIES.md`) |
| Spike compiles for `x86_64-pc-windows-msvc`, builds per-user NSIS installers 0.1.0 and 0.2.0 with a throwaway key generated on the runner | `PASS` | artifacts `TEST-ONLY-atlas-spike-windows-installers` (installers 3.0 MB, `.sig`, public key, `latest.json` sets, scripts; **no private key**) |
| Install per user, no HKLM, under `%LOCALAPPDATA%`, `asInvoker` | `PASS` (runner is admin: standard-user UAC-free install **not proven**) | `install.json` |
| Signed update: valid applied, tampered refused, wrong key refused | `PASS` | `updater-test.json` |
| Headless: SQLite bench + 100 kills, keyring (Credential Manager), scan, watcher, atomic write | `PASS` after fixing W1 and the watcher matcher | `headless*.txt/json`, `harness-fsscope.json` |
| Smoke: app starts under WebView2 156, single instance, harness suites, idle memory | `PASS` (memory `review`: 316 MB working set, 30 s idle) | `smoke.json` |
| `cargo audit` / `cargo license` for the Windows target | `PASS` (0 vulnerabilities, no warning inside the Windows graph, no GPL/AGPL/LGPL) | artifact `atlas-spike-windows-supply-chain` |
| Standard-user UAC-free install/update, SmartScreen, AppLocker/WDAC/AV, WebView2 bootstrapper under policy, OneDrive/Dropbox, IME, real Atlas UI in WebView2 (S1), toast display (S5) | `NOT RUN` | owner, checklist 13.3 / 13.3a |
| Defect found by the runner | W1 `notes::atomic_write` failed on Windows after a successful rename (`File::open(dir)` refused) | fixed in the spike (commit f584fc6); a SYNC-09 requirement |
| Minutes | 66 Windows job minutes over four runs (about 132 billed at the 2x private-repo multiplier) + about 11 `ubuntu-latest` minutes | `SYNC_PROTOCOL.md` 13.3a |

## P0-4 - First GitHub Actions runs (2026-11-04; private repo `Mauz92/atlas`, owner-authorised push and runners)

Status: **`IN_REVIEW`.** Every job of `.github/workflows/ci.yml` has now run on GitHub. Four of five jobs pass completely and the fifth (`frontend`) passes everything except its last step; the workflow as a whole is **red because of one owner decision** (R-61). Final run on the head after the Vite fix: [41823411112](https://github.com/Mauz92/atlas/actions/runs/41823411112), identical outcome (only the `minimatch` audit finding remains). Evidence run: [41819386512](https://github.com/Mauz92/atlas/actions/runs/41819386512)
(head `f5c94ee`, `ubuntu-latest` = Ubuntu 26.04 image 20261025.179.1, Python 3.13.x, Node 22, `postgres:17-alpine` service). The REQ scores in `RELEASE.md` are **not** re-scored here (owner review).

| Job (run 41819386512) | Result | Duration | What ran / not run |
|---|---|---|---|
| `hygiene` | `PASS` | 6 s | required docs present, no tracked `.env`, `docker compose config` |
| `backend` | `PASS` | 10 min 33 s | ruff, `ruff format --check` (298 files), mypy (135 files), **pytest 4293 passed / 15 skipped** (local: 4294 / 14: one more test skips on the runner, not investigated), `pip-audit` "No known vulnerabilities found", OpenAPI export |
| `frontend` | `FAIL` at the last step only | 2 min 44 s | API types current, ESLint, `tsc`, **vitest 1036 passed / 3 skipped (94 files)**, build `PASS`; `npm audit --audit-level=moderate` `FAIL` (R-61: `minimatch` GHSA-g3hv-75wg-m249 in dev tooling, "no fix available"; the same audit's Vite advisory GHSA-8g5g-mxqh-grgj was fixed by `vite` 6.4.5) |
| `e2e-real` | `PASS` | 28 min | **76 of 76** Playwright journeys against the real API + PostgreSQL 17 + Chromium (the `postgresql-client-17` step is in the `backend` job, where `pg_dump` is needed; `e2e-real` did not need it) |
| `containers` | `PASS` | 1 min 36 s | `docker compose build` of the api/web images; images were **not started** on CI |

**Not run on CI:** the mocked `test:e2e` Playwright suite (not in the workflow), `./scripts/verify.sh`, the sync-core model soak and real-API project (`ATLAS_SYNC_REAL=1`), the Compose smoke (P0-1), HTTPS/ACME (P0-2), backups/restore drill (P0-3), Firefox/Safari, mobile, the Windows workflow (separate, manual). The `spikes/` directory was not picked up by any job (verified: no job references it; the Windows workflow is `workflow_dispatch` only).

Failures on the way (all root-caused; **no test skipped, weakened or suppressed**; runs 41800845203, 41803323312, 41805705739, 41807194565, 41812073078, 41815467429 are the red ones):

| # | Symptom on CI | Root cause | Fix |
|---|---|---|---|
| 1 | `backend`: `INTERNALERROR ... PytestDeprecationWarning asyncio_default_fixture_loop_scope` | the runner resolved a `pytest-asyncio` that warns when the option is unset, and `filterwarnings = ["error"]` makes it fatal | explicit `asyncio_default_fixture_loop_scope = "function"` in `pyproject.toml` |
| 2 | `backend`: `test_no_database_secret_reaches_the_manifest` `pg_dump ... password authentication failed` | the test dumped a real database over TCP with a made-up password; locally pg_dump runs through the container's trust socket | the test's subject is the manifest: a stand-in `pg_dump` script (commit "CI-environment fixes") |
| 3 | `backend`: ruff E501 | my comment line in that fix | wrapped |
| 4 | `e2e-real` J4: Enter inserted a newline instead of the `[[` completion | CodeMirror ignores accept keys for `interactionDelay` (75 ms) after the list opens; the runner pressed at once | 200 ms wait with the reason in a comment; product default kept |
| 5 | `e2e-real` mu08 axe sweep: timeout 90 s | 80-100 s on 2 vCPU vs ~30 s locally | time budget 240 s (no check removed) |
| 6 | `frontend`: 3 vitest failures | CI is UTC / `en-US`: `dueChip`/`TaskRow` expected "15:00" (CI prints "03:00 PM"); `taskAutosave` read a naive wall-clock string in the machine's zone | locale-tolerant regexes; `TZ=Europe/Stockholm` pinned in that test file; reproduced locally with `TZ=UTC LC_ALL=en_US.UTF-8`, passes under UTC, Stockholm and Los Angeles |
| 7 | `e2e-real` ux10 `/week` at 1440 px: `.task-meta` 198 px of text in a 189 px card (first failure of 4 CI runs, passes locally) | product CSS defect: a long chip ("Overdue · Tue 3 Nov, 09:00") was clipped by the Week card; CI's fonts are wider than the developer's | `.week-day .task-due` wraps, plus a regression seed (an overdue task) in the journey; the failure message now names the row. Fixed in `c7a692f`; run 41819386512 passed it |
| 8 | `frontend`: `npm audit` | R-61 minimatch (open, owner) and Vite 6.4.4 GHSA-8g5g-mxqh-grgj (fixed) | audit moved to the last step so it cannot hide other results; gate unchanged |
| 9 | push events for two commits did not start CI | GitHub returned `Internal Server Error` / `fatal error in commit_refs_rules` on some pushes; the retry applied the ref without an event | retried; `workflow_dispatch` added to `ci.yml` for manual re-runs |

Actions minutes through run 41819386512 (job minutes, each job rounded up): `ci.yml` 8 runs = **295 Linux minutes** (about 20-43 per run; `e2e-real` 19-28 min and `backend` 10-12 min dominate), `windows-spike.yml` 4 runs = **66 Windows minutes (about 132 billed at the 2x private-repo multiplier)** + 11 Linux minutes; total about 440 billed-equivalent minutes. Every later run adds about 40 Linux minutes for `ci.yml` (about 25 Windows-billed for a warm manual Windows run).

## REQ-011 evidence plan for the native clients (M8-04; PLAN ONLY, written 2026-11-04; no item below has been run; ADR-0068 PROPOSED)

REQ-011 stays `PARTIAL`. Today's evidence (M8-01/02/03/05) covers the server scheduler and the browser Web Push; it says nothing about the desktop app or Android. **What would turn REQ-011 into `PASS`** (all must be recorded with device, OS, WebView version and vendor; a criterion that cannot be run stays `NOT RUN`, none is waived; the owner re-scores, the agent only proposes):

| # | Criterion | Evidence needed | Task | Status |
|---|---|---|---|---|
| E1 | Server exposes reminder state to devices; at-most-once server delivery unchanged | M8-04a integration tests incl. feed triggers, idempotent scan, actions endpoint, cross-user | M8-04a | `NOT RUN` |
| E2 | Scheduler arms, fires once, cancels, re-arms correctly under restart/reboot/update, DST, zone and clock changes, dedup, snooze round trip | M8-04b fake-clock suite, property test, simulation with planted defects | M8-04b | `NOT RUN` |
| E3 | Hint endpoint and emitter are content-free, coalesced, SSRF-safe, inert when off | M8-04e tests incl. byte-identical payload and fake-gateway failures | M8-04e | `NOT RUN` |
| E4 | Desktop (Windows and Linux) fires reminders while resident with the window hidden, after sleep/resume, after autostart, within 60 s | M8-04g manual log; timer throttling numbers | M8-04c/g | `NOT RUN` (blocked on SYNC-09) |
| E5 | Android fires with the app swiped away, offline, in Doze, after reboot and after an update; exact and inexact delays recorded; permission denials handled | M8-04g ADB log on two Android versions, one aggressive vendor | M8-04d/g | `NOT RUN` (blocked on SYNC-10 and a device) |
| E6 | Snooze/dismiss/complete from the notification (Android) or tray/panel (desktop) sync back and clear the other device | M8-04g two-device run | M8-04g | `NOT RUN` |
| E7 | Optional UnifiedPush hint wakes the Android app with the screen off; gateway-down behaviour observed | M8-04g with a self-hosted ntfy (owner-approved container) | M8-04e/d/g | `NOT RUN` |
| E8 | Real (non-mocked) browser Web Push delivery (carried over from M8-02) | a browser with real VAPID keys | M8-02 follow-up | `NOT RUN` |
| E9 | Known limits written for the owner: desktop must run, vendor kills, exact-alarm permission, offline-created tasks, stale-once after boot | `USER_GUIDE.md`, Settings copy | M8-04f | `NOT RUN` |

Proposed re-score rule: `PASS` only if E1-E6 and E8 are `PASS` and E9 exists; E7 is optional (the hint is opt-in) and only affects the claim "instant cross-device wake-up". If the owner amends the gate (iOS and macOS out of scope), REQ-012 changes with it (ADR-0068 Q9).


## M8-04a / M8-04b (core) / M8-04e - evidence (2026-11-09, local; CI not run; nothing committed)

Result vocabulary as `TESTING.md` section 9. Counts are in the verification block at the end of this section.

**M8-04a (`reminder` feed entity, actions, home time zone, `sent` fix): PASS (server and web).**
- One `reminder` upsert per task with a due date and a policy/default, with the same `remind_at` the delivery job uses: PASS (`test_reminder_feed.py`). Edit of due date/zone/policy/status changes it in the same transaction; an unrelated edit and a no-op `scan_reminders` record nothing and the cursor does not move: PASS. `sent` is never exposed (`server_delivered_at` informational): PASS. Complete, archive, delete, due date removed, default cleared: `cancelled`; restore: `armed`: PASS. `types=task` clients and legacy callers unaffected: PASS.
- Actions: snooze/dismiss idempotent by `action_id` (replay returns the stored answer, one revision), later action wins, snooze after dismiss re-arms, cancelled -> `applied:false`, other user `404`, device bearer allowed, `base_revision` ahead `409`/behind `stale`, key mismatch `422`, concurrency of three actions serialised: PASS. The exact-set-of-device-endpoints test was changed on purpose.
- Home time zone (Q6): API, Settings field, first-sign-in default, recompute of zone-less tasks only, closed to devices: PASS (pytest, vitest). Axe/44 px for the new Settings field: covered by the existing Settings sweeps in the real-stack and mocked e2e runs (see verification block).
- Migration `d3a5c8e1b7f2`: clean database, populated database (6 reminders, 2 users, derived states, feed backfill with cursors above the counter), downgrade, second round trip, constraints: PASS (`test_reminder_feed_migration.py`).
- Random-walk convergence against an independent oracle (6 seeds x 30 steps by default); two planted defects (cancellation not announced; a moved schedule keeping its snooze) were caught by hand-run mutations: PASS.
- Not done: extending the SYNC-02 model server/conformance with the entity (moved to M8-04b-ii).

**M8-04b (`packages/reminder-core`): PASS for the core.** 41 scheduler scenarios (arming, idempotent reconcile, restart/reboot/force-stop/update re-arm, catch-up once, horizon and caps, exact-alarm flag, cancel on complete/dismiss elsewhere/offline re-date, desktop engine tick, crash-before-show loses and never duplicates, a rejected show retries, clock jump back/forward, device zone change and DST instants move nothing, snooze round trip incl. lost response and the already-rang suppression, tomorrow-morning, enable toggle, permission denied/granted, content privacy and mode switch, quiet hours, missed list, serialisation, test notification, id collisions, fired-set retention) and the framework-free guard: PASS. Simulation (3 devices incl. one desktop engine, DST week, crashes, lost responses, clock jumps, reboots, permission and toggle changes) with invariants `at_most_once`, `no_stale_show`, `no_orphan_alarm`, `bounded_alarms`, `nothing_lost`; seven planted defects each caught by a named invariant; a failure prints its seed and reproduces: PASS. What the simulation found (in the harness, not the scheduler): oracle ordering bugs (judging a show against a later view; a crash after the intent was queued) were fixed in the oracle; one real design finding, R-68 (a late snooze rings other devices late). Not done: sync-core consumption, any native adapter (M8-04b-ii, M8-04c/d).

**M8-04e (long poll, hint emitter, ntfy adapter, operator guide): PASS for the server scope.**
- Wait endpoint: immediate when behind, timeout `changed:false`, wake on commit, auth/426/epoch, parameter bounds, cursor ahead, device allowed, revoked device refused and a wait in flight ends `401 token_revoked`, per-user cap releases the oldest, per-device rate limit: PASS (`test_sync_hints.py`). nginx: `proxy_read_timeout 75s`, static test PASS; a live long-poll probe through the nginx container: `NOT RUN`.
- Registration (`PUT/GET/DELETE /api/devices/current/hint`, `POST .../test` 1/min): disabled `409`, endpoint never returned, encrypted at rest, 7 refused endpoints `422` without echo and without any request to the gateway, revoke/revoke-all/cascade delete the row: PASS. SSRF table (28 refused endpoints, 12 gateway-origin cases, redirects never followed, token not sent to another origin): PASS (`test_hints.py`).
- Emitter and sender: a burst of 12 edits makes one job; payload byte-identical for task, note and reminder triggers; the writing device is excluded; `410` disables the destination and re-registering revives it; unreachable/`500`: three attempts then dropped, no effect on the request; breaker after five failures; reminder delivery also hints; no endpoint/token in logs; inert when switched off: PASS.
- Real ntfy 2.37.2 (throwaway container on loopback, torn down): adapter `delivered`; body delivered unencrypted to a subscriber; hardening matrix of OPERATOR_GUIDE 4.7 observed as written: PASS. The Android distributor / UnifiedPush test app (04e-v remainder): `NOT RUN`.

**REQ-011:** stays `PARTIAL`. Of the E-rows above: E1 (server exposure) `PASS`, E2 (Scheduler on a fake clock/simulation) `PASS` for the core (the sync-core half is open), E3 (hint endpoint/emitter) `PASS`; E4 to E9 `NOT RUN` (hardware, native clients, UI copy). No re-score is proposed.

**Verification block (2026-11-09, local, nothing committed, CI not run).** `./scripts/verify.sh`: `PASS` (ruff, format, mypy 144 files; pytest 4475 passed / 14 skipped; eslint incl. `packages/reminder-core`, tsc; vitest 1107 passed / 3 skipped). reminder-core soak 1000 seeds x 300 steps: `PASS`. Mocked `npm run e2e`: `PASS` 7/7. `npm run test:e2e:real`: `PASS` 76/76 (10.9 min). Real-API sync-core sim (20 seeds x 150): `PASS` (3 tests). sync-core model soak 1000 x 300: first run `FAIL` (1 of 108, `cursor_safety` at seed 983, see the SYNC-08 follow-up below), **fixed the same day, re-run `PASS`** (10/10 tests, 1000 seeds x 300 steps, `--testTimeout` raised). The default-size model sim runs in `verify.sh` passed. No stray `atlas_e2e_*`/spike databases (`atlas`, `atlas_test`, system DBs only). Not run: CI, a live long-poll probe through nginx, a real Android/desktop device.

**SYNC-08 follow-up: `cursor_safety` failure at seed 983 (2026-11-09, local, nothing committed, CI not run).** Found by the 1000 x 300 model soak
(scenario "a late joiner bootstraps from a snapshot while retention purges the feed"). **Root cause (client bug, `packages/sync-core/src/engine.ts`
`commitShadow`):** while walking a snapshot after `below_floor`, an entity absent from the snapshot was tombstoned locally only if it had no pending
non-create operation (`withOps`; SYNC_PROTOCOL 7.3 "rule 4: keep it"). c2 had an unsent *delete* of a note that another client had already deleted
(feed row #4); the snapshot left the note live in the store and moved the cursor to `head` (4), i.e. past a deletion it never recorded. The feed path
(`applyTombstone` in `commitPage`) never had that exception, and the exception was unnecessary: `view.ts` `materialise` already lays a pending edit over
a tombstone (edit wins). The oracle was right; the server was right (the model and the Python server return a correct snapshot and `head`). **Fix:** record
the tombstone for every entity absent from the snapshot (no `withOps`), SYNC_PROTOCOL 7.3 reworded. **Evidence:** unit regression `src/engine.test.ts`
"a snapshot tombstones an absent entity in the store even when an edit or a delete of it is pending" and seed regression `sim/model.sim.test.ts`
"regression: a snapshot taken while an edit or delete of an absent entity is pending records its tombstone (seed 983)": both `FAIL` without the fix, `PASS` with it.
`ATLAS_SYNC_SEEDS=1000 ATLAS_SYNC_STEPS=300 npx vitest run --project sync-core model.sim --testTimeout 1800000`: `PASS` 10/10 (29 min). `npx vitest run --project sync-core`:
`PASS` 110/110 (incl. 34 planted defects, each still trips). `ATLAS_SYNC_REAL=1 ATLAS_SYNC_REAL_SEEDS=20 ATLAS_SYNC_STEPS=150 ... --project sync-core-real`: `PASS` 3/3.
No server code changed (no deployment note); the web app and the desktop shell do not import `sync-core` (R-54), so shipped behaviour was not affected.

## M8-04b-ii - sync-core consumes `reminder`, queued actions, `acted_at` (R-68) - evidence (2026-11-10, local; CI not run; nothing committed)

Result vocabulary as `TESTING.md` section 9. Design `SYNC_PROTOCOL.md` 14.5 and 14.9a, ADR-0068 D11, tests `TESTING.md` 12.2a.

**Acceptance (scope of the task):**
- `types=` negotiation and the `types_synced` backfill without a full resync and without skipping a change: `PASS` (unit incl. crash before the last page, downgrade/upgrade; simulation scenario with a mid-run upgrade of running clients; planted "type recorded without the walk" and "walk omits a reminder" trip `cursor_safety`).
- Store schema/versioning (key-value state v2 reads v1, refuses newer), apply rules (upsert, tombstone, snapshot, `below_floor` shadow walk, never re-created by a restore): `PASS` (unit + simulation with late joiner and purge).
- Local overlay: a task edited, completed or deleted offline withdraws its alarm at once and stays `dirty` until a pull that started after the acknowledgement completes: `PASS` (unit; invariant `no_stale_show`; planted `ignoreDirtyTask` and `clearDirtyAtAck` both trip it).
- `ReminderSource`/`ActionSink` adapters (assignable to the scheduler's ports at compile time), `pendingActionIds`: `PASS`. The `delivered()` obligation stays with the native adapters (M8-04c/d); the fake OS honours it: not verifiable here.
- Queued, idempotent action (`action_id` as key, byte-identical retries, replay, 404/409/422/401 handled): `PASS` (unit; real API via the conformance scenario).
- R-68: server clamp and rule `PASS` (unit + integration); client sends `acted_at` only after a minute, frozen: `PASS`; model-versus-real conformance (acted_at 4 h ago / 3 days ahead / 9 days ago) 17/17 outcomes equal: `PASS`.
- Invariants of the task (fires at most once per device per instant across restarts and sync; never after dismissal/completion; dismissal syncs; late snooze at the right instant; no cursor skip on backfill): `PASS` in the simulation, each with a planted defect that trips the named invariant (18 checks).

**What the simulation found (all fixed or recorded):** a server rule bug: a dismissal that clears a snooze ending before `remind_at` let the dismissed reminder ring again (soak seeds 176 and 367) - `acknowledged_at` is now `max(base, effective_at, remind_at)`, regression test in `test_reminder_feed.py`; harness defects only otherwise (judging a show against a later owner action, an oracle that counted a create in flight as the re-dating (seed 252), invalid task transitions, a non-UUID action id, microsecond formatting). No sync-core or scheduler defect surfaced.

**Verification (final run after the last code change, 2026-11-10):** `./scripts/verify.sh` `PASS` (ruff, format, mypy 144 files; pytest 4489 passed / 14 skipped; eslint, tsc; vitest 1155 passed / 5 skipped). sync-core project at 1000 seeds x 300 steps with `--testTimeout=100000000`: `PASS` 156/156 in 91 min (14 files, incl. the 18 planted reminder defects, the earlier 34, and the reminder scenarios at 1000 / 200 seeds). reminder-core soak 1000 x 300: `PASS` 59/59. Real-API sync-core project (`ATLAS_SYNC_REAL=1`, 20 seeds x 150): `PASS` 5/5 (reminder conformance, reminder world, the earlier three). `npm run test:e2e:real`: `PASS` 76/76 (11.1 min). `npm run e2e`: `PASS` 7/7. Stray databases: none (`atlas`, `atlas_test`, system DBs). An earlier soak (before the dismissal fix) had 3 failures (seeds 176, 252, 367), all explained above.

**Not done / `NOT RUN`:** Python model 1000x300 and real 20x150 simulations (no Python sim file changed and they were not extended with `reminder`); CI; any real device (Android, desktop); owner DB migration (none needed).

## SYNC-09 — Desktop client, phase 1 = Linux (2026-11-10, local, not committed, CI not run; ADR-0069)

Scope as run: Linux only (CachyOS, kernel 7.2.9, KDE Plasma Wayland, NVIDIA RTX 3080, WebKitGTK 2.54.1, Tauri 2.12.5, Rust 1.99.1, Node 26.11.1, SQLite 3.5x bundled with `rusqlite` 0.41.1). Plan and acceptance per step: `ROADMAP.md` "SYNC-09 — Desktop client, phase 1". Vocabulary: `PASS`, `FAIL`, `BLOCKED`, `NOT RUN`. Windows (R-36) is **not part of this evidence**: nothing here moves the Tauri-or-Electron decision.

| Step | Acceptance | Result | Evidence |
|---|---|---|---|
| **09a** platform ports + per-row SQLite `LocalStore` | per-row access only | `PASS` | `SqliteLocalStore` writes one row per `put`/`del`; the test "a transaction is one atomic commit of exactly the rows it changed" shows a one-row change commits one row; no whole-state value exists anywhere |
| | page + cursor commit atomic; failed or crashed transaction leaves no trace | `PASS` | vitest `sqliteStore.test.ts` (rollback on exception; crash before commit loses page and cursor together; overlay reads; `clear`; queue order; parity with `MemoryStore`); the simulation on the desktop store (below); Rust `a_batch_with_a_bad_table_writes_nothing`, `a_failing_statement_rolls_the_whole_batch_back` |
| | kill -9 durability | `PASS` | `cargo test -p atlas-desktop-native --test store_kill` with `ATLAS_KILL_RUNS=100`: the product `Store::commit` in a child process killed (SIGKILL) at random moments 15-135 ms after start, 100/100 reopened with `integrity_check` ok, every page up to the cursor complete, no row beyond the cursor, cursor never backwards, writer advanced in >= 90 % of runs (229 s with `synchronous=FULL`); the default run is 60 |
| | `synchronous` decision recorded | `PASS` | ADR-0069 D4: FULL (0.71 ms vs 0.16 ms per page in the spike). Power-loss durability: `NOT RUN` (only process death is tested) |
| | schema/migrations, newer database refused | `PASS` | `reopening_keeps_data_and_a_newer_database_is_refused`, `migration_from_an_older_version_keeps_rows`; version 1 holds `entities, queue, meta` (cursor, epoch, `types_synced`, `dirty_tasks`), `resolutions, problems, drafts, notes_index, settings, scheduler`; reminders are `entities` of type `reminder` |
| | multi-client simulation on the desktop store | `PASS` | `packages/desktop-core/sim/desktop.sim.test.ts`: default run (10 seeds x 120 steps, 4 tests) and soak 120 seeds x 200 steps `PASS` (86 s): tasks/projects/notes with resolutions, 4 clients and store crashes (`pStoreCrash` 0.05); late joiner with retention purge; reminder devices with the upgrade backfill; **planted defect** (a database that commits row by row) is caught by the invariants in at least one of 16 seeds |
| **09b** notes-folder engine | create/edit/rename/delete reach server and a second device | `PASS` | vitest `notes/sync.test.ts` (real engine, model server, fake folder, two desktops) and the real e2e run: external create seen by a second device in 1.1 s; rename becomes a move, delete a server delete and the other desktop's trash |
| | concurrent edit merged or kept as a conflict-copy FILE; nothing lost | `PASS` | unit: different lines merge (`ONE ... FIVE`); same line keeps both texts and one conflict-copy file; real e2e: offline on both sides, same line edited differently, reconnect: `ext/hello (conflict ...).md` appears, both texts present |
| | external edit sent with its base; a server write never overwrites a file edited meanwhile | `PASS` | `SyncEngine.editNote(id, text, base)` (new optional argument); unit "compare-and-swap" race (the file changes between the host's check and the write): both texts survive; Rust `write_is_compare_and_swap` |
| | same-size edit found; missing root never "all deleted"; unsyncable files reported | `PASS` | Rust `a_same_size_same_mtime_edit_is_only_seen_by_a_full_scan` and unit; `a_missing_root_is_an_error_never_an_empty_list` and unit (`root_missing`, no delete); unit "too large / not UTF-8 / not portable (`CON.md`)" listed and untouched |
| | watcher drops `Access` and Atlas temp files, coalesces | `PASS` | Rust `reading_a_file_and_atlas_temp_files_are_not_hints`, `a_new_and_a_changed_note_are_hints_and_events_coalesce` (20 writes -> <= 4 hints), `our_own_atomic_write_is_one_hint...` (inotify only: real editors were not run) |
| | atomic writes incl. the Windows-safe rule | `PASS` on Linux | temp + fsync + rename + directory fsync under `#[cfg(unix)]`, no temp name left behind (`write_is_compare_and_swap`); the Windows branch compiles (SYNC-07 W1) but was **not run** |
| | deny-by-default scope, proven by a negative test | `PASS` | Rust `resolve_refuses_everything_outside_the_root` (absolute, `..`, `.`, dot segments `.git`/`.atlas-trash`, backslash, symlinked file and directory, sibling prefix); e2e: from the live page `fs`/`shell` plugin calls, `folder_read` of `/etc/hostname` and `../../etc/hostname`, `folder_write` of `../escape.md` and `.git/config`, `db_get` of `sqlite_master`, `api_request` of `//evil.example/api/x` are all refused, and no file escaped |
| **09c** shell + sign-in | device sign-in with e-mail + password; token only in the keystore, attached in Rust | `PASS` | e2e: sign-in through the real form; `secret-tool` shows the throwaway entry; the token string is in no file of the data, notes and output directories; `token_get` does not exist; storage holds no token; Rust `sign_in_stores_the_token_and_returns_only_the_device`, `the_host_attaches_the_token_and_drops_the_webviews_credentials`, `a_redirect_is_not_followed...` |
| | HTTPS only except loopback | `PASS` | TypeScript `urlRules` table, Rust `base_url_*`, `refuses_other_hosts_paths_and_methods_before_connecting`, runtime test (`http://192.0.2.7` refused before any request) |
| | existing web UI loads; no service worker; no CORS needed | `PASS` | e2e: `/api/auth/me`, tasks, notes, projects, instance `200` through the bridge with the API's `CORS_ORIGINS` empty; zero service-worker registrations; a direct `fetch` to another origin is blocked by the CSP; Settings > Desktop app rendered. **Not done:** a click-through of every page for stray `403` (R-73) |
| | 401 -> signed out; 426 -> update required; revoked device | `PASS` | vitest runtime tests (nothing more is sent after a 401; token forgotten; sign-in page; 426 keeps the token); e2e: revoke on the server -> sign-in page with the message, keystore entry gone |
| | `WEBKIT_DISABLE_DMABUF_RENDERER=1` | `PASS` | set in Rust when `/proc/driver/nvidia/version` exists and the user did not decide otherwise; the app rendered under Wayland on this NVIDIA machine without any variable set by the test |
| **09d** runtime | a reminder synced from another device fires one desktop notification | `PASS` | vitest (fake clock: nothing before the time, one at the time, none again; generic mode shows no task text); e2e: a task created on the second device -> exactly one D-Bus `org.freedesktop.Notifications.Notify` for its title (`dbus-monitor`), none again after 70 s |
| | tray close/reopen keeps syncing | `PASS` | e2e: `close` -> window hidden (host state), app alive, a remote edit still reached the file while hidden, tray "open" -> visible. The OS tray icon itself and a real click were not exercised (no input tool; the menu handler is the same code the e2e hook calls) |
| | autostart opt-in, default off | `PASS` | vitest; e2e (throwaway `HOME`): no entry by default, opt-in writes one `Atlas.desktop` with `--background`, opt-out removes it; the owner's `~/.config/autostart` was verified unchanged (the first version of this step wrote the owner's entry by mistake because the plugin ignores `XDG_CONFIG_HOME`; removed at once, the step now isolates `HOME` and asserts it) |
| | live connection | `PASS` | vitest (`changed` -> pull, <= 1 pull per 5 s, failing polls back off instead of spinning); e2e: remote edit reached the file in 6.8 s (long poll + pull + hash + write) |
| | per-device settings; the screen exists only in the shell | `PASS` | vitest runtime (persist across restart, tray flag applied), web tests (`DesktopSection.test.tsx`: section absent in a browser, present with the bridge, browser-only sections hidden) |
| | single instance | `PASS` | e2e: a second launch of the same binary exited with code 0 after 46 ms and the first kept its 3 processes |
| **09e** packaging | AppImage + .deb from a documented script; pinned tools | `PASS` | `scripts/build-linux.sh`: AppImage 115 247 608 bytes (109.9 MiB), `.deb` about 4.2 MiB (package `atlas`, binary `/usr/bin/atlas-desktop`, depends on the system WebKitGTK 4.1, GTK 3 and ayatana appindicator); bundler tools verified against `packaging/bundler-tools.tsv` (the patched `linuxdeploy` reproduces the cached hash); the previous AppImage was moved to `out/previous/` by the second build. **Reproducibility on this machine:** three builds from unchanged sources produced a byte-identical release binary and a byte-identical AppImage (`5aed0cd8...`, 115 247 608 bytes); the `.deb` differed between builds (archive timestamps, `SOURCE_DATE_EPOCH` is not honoured by its packer) while its contents are the same. Reproducibility on another machine or distribution: `NOT RUN` (the AppImage embeds this machine's WebKitGTK/GTK libraries, R-70) |
| | auto-update behind an off-by-default config, throwaway key | `PASS` | `updater` is a Cargo feature plus `tauri.updater.conf.json` overlay; no default build contains it (`update_check` answers `not_configured`). `e2e/updater-test.mjs` (throwaway minisign key pairs, local http server, nothing published): **valid** 0.2.0 downloaded, verified and installed in place (the AppImage file was replaced); **tampered** (one byte flipped after signing) -> `The signature verification failed`, file byte-identical, still 0.1.0; **signed by another key** -> `The signature was created with a different key than the one provided`, unchanged. A first run showed the refusals only as unchanged files because a stale instance held the single-instance lock; fixed in the script and the three cases re-run. HTTPS update from a real host and a Windows update: `NOT RUN` |
| | size / startup / RSS | measured | AppImage 109.9 MiB; bare release binary 9 MB; cold start to "sign-in page rendered and reported": about 0.5 s (polled every 250 ms, so +-0.25 s; release e2e binary and debug build alike); idle after the scripted run (3 processes: app, WebKitWebProcess, WebKitNetworkProcess) **277 MB PSS** (about 400 MB in the spike with a 5 000-line note open); AppImage start-up itself (extraction/FUSE) not timed |

**End-to-end run (final, release test binary, 2026-11-10 00:20): 19 steps, 19 `PASS`, 0 `FAIL`** (`apps/desktop/e2e/results/e2e-last.json`; earlier runs: 14/17 on the first debug run, 17/18 on the second, each failure was a defect of the run script, fixed: waiting for a report the navigating page cannot write, a case-sensitive text match, a report read from the wrong page, and the autostart isolation above). After every run: no `atlas_desktop_*` database (only `postgres`, `atlas`, `template0/1`, `atlas_test` remain), no process, temp directory, keystore entry or autostart entry left.

**Verification (final, 2026-11-10, nothing else running):** `./scripts/verify.sh` `PASS` in 8 min 9 s: ruff, format, mypy (144 files), pytest 4489 passed / 14 skipped, eslint (web, `sync-core`, `reminder-core`, `desktop-core`, `apps/desktop/src`), tsc, vitest **1223 passed / 5 skipped** (112 files; 1155/5 before this work: +68 tests: 61 in the `desktop-core` project (store, notes engine, runtime, URL rule, framework-neutral guard, Tauri adapter, simulation) and 7 in the web project; the engine/world changes pass the existing sync-core suites unchanged; sync-core model soak 100 seeds x 200 steps plus the planted-defect checks `PASS` 62/62 after the engine change). **Test counts (this session).** Rust: `cargo test -p atlas-desktop-native` 24 unit tests + the kill test, `PASS`; `cargo clippy --workspace --all-targets -- -D warnings` `PASS` for the default build, `--features e2e` and `--features updater`; `cargo audit`: 0 vulnerabilities, 8 warnings (see `DEPENDENCIES.md`; one real advisory, RUSTSEC-2026-0459 in bundled SQLite, was found and fixed by upgrading `rusqlite` to 0.41).

**Defects found while building (all fixed, kept as tests):** (1) an external edit made while a newer server revision arrived was an edit of the NEWER revision and would have overwritten it: the index now stores the base and `editNote` accepts it (race test); (2) creating notes before the first pull collided with the server's notes (collision renames): the folder engine now only scans until the first pull completed; (3) two devices with the same test id seed produced equal note ids (test fake); (4) the autostart plugin ignores `XDG_CONFIG_HOME` (e2e wrote the owner's entry once, removed; now isolated by `HOME`); (5) a stale `atlas-desktop` instance left by the updater test made later cases meaningless through the single-instance lock (the test now refuses to start with one running and kills the process group); (6) `.deb` metadata listed the dependencies twice (override removed).

**Not verified / `NOT RUN` (also `TESTING.md` 13.3):** catch-up of a reminder that came due while the app was not running (the scheduler core tests it; not repeated in the real app); Windows; other distributions; GNOME and its tray; GNOME Keyring and a locked wallet at start; real key input and IME/CJK in the editor; the OS tray icon and its menu by a real click; real suspend/resume; 30-minute hidden-window reminder lateness; `--background` start from a real login; `.deb` installation; the private-CA certificate; cloud-synced and network folders; very large folders; power-loss durability; moving the web UI onto the local store; the restore-confirmation and conflict-resolution screens (SYNC-11); a click-through of every UI page for `403`.

## SYNC-11 — Conflict, notice and restore UI; the shell on one engine (2026-11-10, local, not committed, CI not run; ADR-0070)

Scope as run: Linux (CachyOS, KDE Plasma Wayland), Chromium via Playwright, real FastAPI + PostgreSQL throwaway databases (`atlas_e2e_*`, `atlas_desktop_*`; none left behind, the owner's dev stack, tailnet server and the `atlas` database were not touched), the real Tauri app for the desktop run. Plan and acceptance per step: `ROADMAP.md` "SYNC-11". Vocabulary: `PASS`, `FAIL`, `BLOCKED`, `NOT RUN`. No server code, API or schema changed (`openapi.json` and `schema.d.ts` unchanged). One sync-core behaviour was added (`discardLocalAndRedownload()`), with a model-simulation scenario.

| Step | Acceptance | Result | Evidence |
|---|---|---|---|
| **11a-0** foundations | every `rule` and every undo refusal of `SYNC_PROTOCOL.md` 9 has wording; no text of a task, project or note can appear in a notice; values formatted per field | `PASS` | `lib/syncUi/*.test.ts` (resolutionText, undoOutcome, diff, conflictCopies, haltText, instantStatus, problemText, engineSource): table-driven over `simple_later_wins`, `path_later_wins`, `edit_wins_over_delete`, `note_merged`, `path_collision`, `undo`, and `changed_since`, `invalid_value`, `invalid_transition`, `entity_deleted`, `path_exists`, `already_undone`, `not_undoable`, 404, offline, 429, 5xx; a test asserts the wording never mentions title/description |
| **11a-1** notices, undo, Changes page | Undo restores the value when nothing changed since; "changed again since" is a plain outcome and keeps the entry; a not-undoable kind says why and links on; a retry never undoes twice; paged; axe clean | `PASS` | component tests (`Changes.test.tsx`: one key per tap, a retry after a lost answer reuses it, refusal shown with Undo still enabled, follow-up link, paging, empty and error states; `ChangedElsewhere.test.tsx`); real stack `sync11-conflicts.spec.ts` test 1: two device clients conflict on a task field, banner "1 change was made on another device", Changes page names the device (Pixel phone) and the replaced value, Undo -> the API returns the earlier value; second conflict plus a later edit -> "Not undone: the priority was changed again since" and the value is unchanged and the button still enabled; a merged note -> no Undo, reason and link `/notes?open=<id>`; axe and overflow sweeps at 360/390/768/1440 px, both themes |
| **11a-2** task text-conflict resolver | both versions kept; choose mine / theirs / edit merged; saved as a normal revision-checked write | `PASS` | `TextConflictResolver.test.tsx`, `taskAutosave.test.ts` (`resolveStashField`: mine is a save against the latest revision, theirs sends nothing), `TaskDetail.test.tsx`; real stack test 2: the page edits a title while a device changes it -> "changed somewhere else" -> Load latest -> both versions -> Edit merged -> the other device reads the merged title through the API; the title was still the other device's until the choice (nothing was sent early) |
| **11a-3** note conflict resolver | original never overwritten unseen; copy deleted only after the original was written | `PASS` | `NoteConflicts.test.tsx` (call order update then remove; a `409` rereads and deletes nothing; a failed delete keeps the copy and says so); real stack test 3: two overlapping edits give two conflict copies; one resolved by Merge in the editor, one by Keep mine; both originals read back with the chosen text and no `(conflict ...)` note remains |
| **11a-4** halt screens | restore: Re-upload vs Discard, never automatic, discard asks twice, calls `confirmRestore()`; 426 and 401 screens | `PASS` | `SyncHaltScreen.test.tsx`, `ShellHalt.test.tsx`; mocked-API Playwright `sync11-shell.spec.ts` (nothing happens by itself; second confirmation; axe/overflow/screenshots); sync-core model simulation "the person discards local changes" (3 clients, restore with a rotated epoch; every waiting client discards: pending 0, no failed or conflicting item, convergence to the restored server, nothing re-created, the scenario really throws something away); the real desktop app: operator `record-restore` -> restore screen -> Re-upload resumes; second restore -> Discard asks twice, `pending` 0 afterwards, the local file in the notes folder survives |
| **11a-5** devices polish | current device marker and last seen | `PASS` (no change) | present since SYNC-06 (`DevicesSection.test.tsx`, `sync06-devices.spec.ts`: "This device", "Last seen") |
| **11b** instant-updates / diagnostics (web half of M8-04f) | every state has copy and a test; axe | `PASS` for the web half | notifications: unsupported, server without keys, blocked, not asked, allowed-not-registered, on; live connection (browser: not used; desktop: connected / not); last hint; gateway (unreachable, not configured, on-not-registered, needs a new address, failing, working; only the last four characters of an endpoint are ever shown); `instantStatus.test.ts`, `InstantUpdates.test.tsx`; real stack test 4 (Settings > Notifications with a stand-in for the Notification API: the test button enabled and the page asked for exactly one notification) and `sync11-shell` (Desktop app group); the native half (per-device notification section on Android, permissions, battery status, UnifiedPush) stays with M8-04c/d/g |
| **11c** the shell on one engine | one queue and one cursor in the shell; restore/401/426 screens from engine state; a notes-folder conflict shows in the resolver | `PASS` for what was scoped, **partial against the instruction** | `Settings.shell.test.tsx` fails if the browser's offline queue or reconciler is started in the shell; status bar and Settings > Sync read the engine; bridge verbs (`runtime.test.ts` 6 new tests: resolutions, undo applied / refused / queued offline, `uiResolveText`, restore halt, re-upload, discard, refusal while signed out; `tauriPlatform.test.ts`); real app, `apps/desktop/e2e/run.mjs`: a conflict between two other devices -> banner -> Changes page -> Undo through the engine -> read back by another device. **Not done:** the UI's task, project and note reads and writes are still online REST through the host (ADR-0070 D7, R-73); a conflict copy of a note is resolved in the Notes page (REST), not from the engine's `Problem` |
| **11d** browser local store | planned only | `NOT RUN` (by design) | ADR-0070 D9 |

**Verification (2026-11-10):** `./scripts/verify.sh` `PASS` in 8 min 11 s (ruff, format, mypy, pytest 4489 passed / 14 skipped, eslint for web, `sync-core`, `reminder-core`, `desktop-core`, `apps/desktop/src`, the CSS scale check, tsc, vitest 1319 passed / 5 skipped in 129 files). `cd apps/web && npm run test:e2e:real` `PASS` 80/80 (76 before, 4 new; one earlier run had 2 failures from the banner's `role="status"`, fixed, see defects). `npm run e2e` (mocked API) `PASS` 12/12 (7 existing, 5 new). Desktop real-app run `node e2e/run.mjs target/debug/atlas-desktop` `PASS` 23/23 (19 before, 4 new: notices, settings, two restore steps; throwaway database `atlas_desktop_<hex>`, dropped). sync-core model soak 300 seeds x 250 steps `PASS` (12 tests, 439 s); planted-defect checks `PASS` (52 tests, 2 files); real-API simulation 8 seeds x 150 steps `PASS` (5 tests); desktop simulation soak 120 x 200 `PASS` (4 tests, 87 s). The reminder-core soak was not repeated (reminder code unchanged; the engine change is a new method and a flag on the snapshot walk). No stray databases (`atlas`, `atlas_test`, `postgres`, templates only).

**Defects found while building (all fixed):** (1) the first full real-stack run failed two existing specs (`tasks-page`, `ux03`): the banner used `role="status"` and those specs read the page's `status` unscoped (the app's rule is "pages own that role"); the banner is a named region now. (2) axe in dark mode flagged `color-contrast` only for the first width after a theme switch: buttons animate their colours; the sweeps wait for the transition. (3) `label-content-name-mismatch` on "Edit a merged title" (visible text "Edit merged"): the accessible name now starts with the visible text. (4) `heading-order` in the resolvers (h3/h4 under an h1): now a level-2 heading and non-heading labels. (5) A second text conflict right after "Keep mine" was possible because a conflicting write does not itself bring in the newer revision: `uiResolveText` now asks for a pull and waits (bounded) for that revision first. (6) The test helper `otherDevice` gave every simulated device the same ids and idempotency keys (`idempotency_mismatch`); seeds differ now. (7) The mocked-API suite's existing "network loss" test fails when the CPU-heavy axe sweeps of the new shell spec run in parallel with it (passes alone and without them); the new spec is serial so it runs in one worker. The test itself is timing-sensitive (5 s poll) and was not changed. (8) One of five full vitest runs (the one right after the heavy real-stack run) reported one failed test among 1324; the log of that run was not kept, so the test is unidentified; four full runs and the `verify.sh` run passed. Treat as an open flake to watch (it may be one of the new tests that wait a fixed 30 ms before asserting something is absent).

**Not verified / `NOT RUN`:** a browser local store (SYNC-11d); offline editing of tasks in the shell UI; the notices and resolvers on a real phone (checked in a browser at 360 and 390 px only); a screen reader (axe only); a real push delivery; Windows; the native half of M8-04f; names of other devices in the shell (R-74); the old CI jobs (`e2e-real` on GitHub Actions) were not run for these specs.

**Screenshots** (scratchpad, phone = 390 px, desktop = 1440 px, light and dark each): `/tmp/claude-1000/-home-kim-Documents-Atlas/31ff7fb3-5923-481a-b611-5657fde6b6ea/scratchpad/shots/` — `sync11-banner-*`, `sync11-changes-*`, `sync11-task-resolver-*`, `sync11-note-resolver-*`, `sync11-instant-*`, `sync11-restore-*`, `sync11-restore-confirm-*`, `sync11-update-required-*`, `sync11-signed-out-*`, `sync11-shell-sync-*`, `sync11-shell-changes-*`, `sync11-shell-instant-*`.


---

## Calendar Stage A (read-only linking and viewing) - evidence, 2026-11-10

Not committed, CI not run. Every result below is against **local fixtures and the fake provider only**; AGENTS.md section 10
says that is not provider-compatibility evidence, so M5-00, M5-03, M5-04, M5-05, M5-07 and M5-11 are **`IN_REVIEW` / blocked on live verification, never `DONE`**.

| Criterion | Result | Evidence |
|---|---|---|
| OAuth: PKCE, single-use session-bound state, TTL, redirect URI from `PUBLIC_BASE_URL` incl. `:9443`, minimal read-only scopes, scope/refresh-token checks, cancel, replay | `PASS` (fixtures) | `tests/integration/test_calendar_oauth_api.py` (20 tests) |
| Tokens never logged / never returned; encrypted at rest | `PASS` | log-grep test; ciphertext does not contain tokens; API dumps checked |
| Refresh server-side, Microsoft rotation persisted, revoked grant -> "needs re-authorisation", scans skip it | `PASS` (fixtures) | same file + `test_calendar_provider_sync.py` |
| Google adapter: paging, syncToken, 410 resync, deletions, recurring + exceptions + cancelled, all-day, zones, 429/Retry-After, 401 refresh | `PASS` (fixtures built from the cited API pages) | `tests/unit/test_calendar_provider_adapters.py` |
| Microsoft adapter: calendars, calendarView delta, nextLink/deltaLink, @removed, 410, window renewal, Prefer UTC, origin pinning | `PASS` (fixtures) | same |
| ICS: SSRF matrix, pinned address, redirects, size cap, conditional GET, parser (TZID/Windows names/floating/all-day/RRULE/EXDATE/overrides/cancelled/malformed), diffing deletions, secret never exposed | `PASS` | `test_calendar_netguard`, `test_calendar_feed_fetch`, `test_calendar_ics`, `test_calendar_feeds_events` |
| Recurrence/DST/all-day properties | `PASS` | `test_calendar_recurrence` (81 incl. 65 property cases) |
| Cursor safety: crash between applying and saving the cursor, failing later page, crashing snapshot tombstoning | `PASS` | `test_calendar_provider_sync.py` |
| Events API: bounded window, pagination, user scope, detail, hidden calendars, tasks never events | `PASS` | `test_calendar_feeds_events.py` |
| Migration clean, on a representative schema, reversible | `PASS` | `test_calendar_sources_migration.py` + `migrations_match_models` |
| UI: provider cards in every state, feed form, disconnect confirmation, Calendar page views, detail, Today/Week | `PASS` | vitest (`CalendarSettings.test.tsx`, `Calendar.test.tsx`, `calendar.test.ts`) |
| Real stack + fake provider: feed, Google and Microsoft OAuth redirect, re-authorisation, Today, four views, disconnect; axe clean in both themes at 360/390/768/1440; no sideways scroll | `PASS` | `e2e-real/cal01-calendar.spec.ts` (3 tests) |
| **Live Google / Microsoft / Proton behaviour; refresh-token lifetime after > 7 days; real consent screens; real feed delay** | **`NOT RUN` / UNVERIFIED** | runbook and evidence template: `CALENDAR_SYNC.md` 12.7 (the owner fills it in) |
| Webhook change notifications (M5-09) | `NOT BUILT` | needs a public endpoint; Atlas is private (SEC-01) |
| Bidirectional sync (M6) | `NOT BUILT` | Stage B |

## UX-12 - Accent colours (2026-11-10, local; CI not run; nothing committed; ADR-0073)

Owner request: "I would just like to have some more accent colors."; addition the same day: colour headings with the accent.

| Criterion | Result | Evidence |
|---|---|---|
| Ten accents (Neutral default + nine), each as five tokens for Light and both dark blocks | `PASS` | `styles.css` data-accent blocks; `styles.test.ts` key-set and System-dark = explicit-Dark checks |
| Contrast: text 4.5:1, solid accent / ring 3:1, on-accent 4.5:1, heading text 4.5:1, every accent x theme x surface | `PASS` | `styles.test.ts` matrix; no ratio lowered |
| `accent` preference, default Neutral, invalid value falls back, storage failure, no reload, set before first paint | `PASS` | `lib/accent.test.ts`; `ux12-accent.spec.ts` (script runs before the app module is released; invalid value ignored) |
| Picker: radio group, named swatches, 44 px, selected not by colour alone, keyboard, default labelled, 360/390/768/1440 | `PASS` (768 only through the sweep widths 390/1440 and the 360 target check; 768 NOT RUN separately) | `AccentPicker.test.tsx`; `ux12` test 1 (arrow keys, focus ring, check mark, 44 px at 360, no overflow) |
| Every use of the accent follows tokens; no hard-coded hex outside token blocks; semantic colours untouched | `PASS` | CSS audit (selected nav, segmented, presets, notes selection, live links/tags moved to tokens); `styles.test.ts` literal check; `ux12` test 3 (semantic tokens identical across all ten accents) |
| Coloured headings switch (default on, no-op for Neutral, per device, pre-paint) and what it does and does not colour | `PASS` | `accent.test.ts`, `ux12` test 4 (computed colours in Light and Dark) |
| axe clean, no horizontal scroll at 390 and 1440, Today/Tasks/Notes/Calendar/Settings, every accent, Light and Dark, headings on and off | `PASS` | `ux12` sweep (380 axe runs) |
| Desktop shell needs nothing extra | `PASS` by inspection, NOT RUN in the shell | the shell loads this web UI; its welcome page keeps its own colours |

**Verification (2026-11-10).** `./scripts/verify.sh` PASS (pytest 4739 passed / 14 skipped; vitest 1542 passed / 5 skipped; lint incl. CSS scale check, typecheck). `npm run e2e` PASS 12/12. `npm run test:e2e:real` PASS 88/88 (26.5 min; the UX-12 sweep is 13 min of it). No stray `atlas_e2e_*` databases; the `atlas` database and the owner's stack were not touched.
Screenshots (not committed): `/tmp/claude-1000/-home-kim-Documents-Atlas/31ff7fb3-5923-481a-b611-5657fde6b6ea/scratchpad/report/` (Blue, Pink, Green on Today, Tasks, Notes, Calendar at phone 390 and desktop 1440, Light and Dark; Settings with the picker for Neutral and Violet with headings on and off); all ten accents: `/tmp/claude-1000/-home-kim-Documents-Atlas/31ff7fb3-5923-481a-b611-5657fde6b6ea/scratchpad/shots/`.
**Not verified:** Safari/Firefox, a real phone, the desktop shell window, the 768 px width of the sweep, a screen reader reading the picker. Known limits: per-device only (not synced); Amber/Orange/Red accents resemble the warning/overdue colours (R-81).

## REL-01 — Releases and in-app server updates (2026-11-10, ADR-0074)

| Criterion | Result | Evidence |
|---|---|---|
| Updater rules and sequence: no downgrade, low disk, unsafe bundle paths, stop before backup, rollback with/without restore, pull failure changes nothing, request must name the newest version, prune keeps newer images | `PASS` | `tests/unit/test_updater_agent.py` (13 tests, fake Docker) |
| API contract: not configured, status sanitised, request only for the version the host reported, one at a time, version format, device token refused, signed-in only | `PASS` | `tests/integration/test_system_update.py` (8 tests); `test_devices.py` allow-list unchanged (default deny) |
| Settings UI: not set up, confirm before update, notes as plain text, rolled-back alert, check again | `PASS` | `UpdateSection.test.tsx` (5 tests) |
| **Real Docker, isolated project** (not the dev stack): update 0.1.0 -> 0.2.0 with data present | `PASS` | stack stopped, backup verified, compose files switched, 0.2.0 healthy and reporting 0.2.0, user row kept (rehearsal script, 2026-11-10) |
| **Real Docker**: a 0.3.0 whose migration succeeded but which never reports itself healthy | `PASS` | rolled back automatically: the database was restored from the pre-update backup (the new table gone, revision back at `a6c3e9d27b14`), user kept, 0.2.0 running, `version.env` back at 0.2.0, status `rolled_back` with the reason |
| `deploy/docker-compose.release.yml` merges with the base file (images, `UPDATE_DIR`, `../update` mount) | `PASS` | `docker compose config` |
| Release workflow dry run (gate, images built and smoke-tested through the release compose file, Linux AppImage and .deb, deploy bundle, SHA256SUMS; nothing published) | `PASS` | Actions run 43066574355, 2026-11-11, version 0.0.1. It took seven attempts: CI flakes fixed (sync-simulation timeout, hint-burst window, calendar OAuth-return race, 29-minute accent matrix sampled on CI), Playwright installed without apt because Ubuntu package servers were unreachable from runners, apt steps bounded. **Publishing (push to GHCR, draft then public release) is not yet exercised.** |
| systemd path/timer units, `install.sh`, GHCR pull with the owner's token, GitHub release lookup and asset download | `NOT RUN` | need the real server and token |
| Windows client | `NOT RUN` | opt-in job, unverified |
| Update of the live server | `NOT RUN` | after the dry run and `install.sh` |

Notes: the rehearsal first ran under the wrong compose project (a script error: it read its configuration before creating it) and recreated the dev database
container; the dev data was unchanged (volume reused: 2 users, revision `e5b8f2a4c1d9`) and the container was restored. The script now refuses any project but its own.
