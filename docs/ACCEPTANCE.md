# Atlas — Acceptance Record

**Status:** Active (Milestone 0)
**Last updated:** 2026-10-22

Records verification evidence for milestone gates. A milestone is not complete until its criteria
are marked `PASS` here with evidence, or explicitly recorded as `BLOCKED`/`NOT RUN`.

Evidence vocabulary: `PASS`, `FAIL`, `BLOCKED`, `NOT RUN`.

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
| Duplicate key returns the original result (live) | `BLOCKED` | `tests/integration/test_tasks_api.py::test_create_is_idempotent_for_the_same_key` — no PostgreSQL |
| CRUD, soft delete, stale-revision `409`, CSRF | `BLOCKED` | `tests/integration/test_tasks_api.py` (9 tests) — no PostgreSQL |
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
| Enforcement over HTTP (`409`, nothing changes) | `BLOCKED` | `tests/integration/test_tasks_api.py` (5 transition tests) — no PostgreSQL |
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
| Naive due date stored in the task's zone over HTTP | `BLOCKED` | `tests/integration/test_tasks_api.py` (4 due-date tests) — no PostgreSQL |
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

## Milestones M4–M9

Acceptance criteria are listed in `ROADMAP.md`. Results are recorded here as each milestone is
executed. Entries remain `NOT RUN` until there is real evidence.

---

## Release Readiness (M9)

| Requirement | Result | Evidence |
|---|---|---|
| REQ-001 Self-hosted | `NOT RUN` | — |
| REQ-002 Free to use (qualified by §3.1) | `NOT RUN` | — |
| REQ-003 Commercial-use rights | `NOT RUN` | — |
| REQ-004 Markdown notes | `NOT RUN` | — |
| REQ-005 Task management | `NOT RUN` | — |
| REQ-006 Project management | `NOT RUN` | — |
| REQ-007 Google Calendar | `NOT RUN` | — |
| REQ-008 Microsoft Outlook | `NOT RUN` | — |
| REQ-009 Calendar consolidation | `NOT RUN` | — |
| REQ-010 Cross-device sync | `NOT RUN` | — |
| REQ-011 Notifications | `NOT RUN` | — |
| REQ-012 OS agnostic | `NOT RUN` | — |
| REQ-013 Security | `NOT RUN` | — |
| REQ-014 Low maintenance | `NOT RUN` | — |
| REQ-015 Data portability | `NOT RUN` | — |
