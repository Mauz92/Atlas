# Atlas — Roadmap and Backlog

**Status:** Draft for approval (Milestone 0)
**Last updated:** 2026-10-27

This is the canonical project state. Milestones are worked in dependency order. A task is
`DONE` only when its acceptance criteria pass and verification evidence is recorded in
`ACCEPTANCE.md`. Status vocabulary: `BACKLOG`, `READY`, `IN_PROGRESS`, `BLOCKED`, `IN_REVIEW`, `DONE`.

---

## Milestone Overview

| # | Milestone | Status | Gate |
|---|---|---|---|
| M0 | Discovery and architecture | `DONE` | Architecture approved before implementation ✔ (approved 2026-10-20) |
| M1 | Foundation and secure deployment | `DONE` | Deployment + security basics verified ✔ |
| M2 | Markdown notes | `DONE` | Markdown portability and integrity verified ✔ |
| M3 | Core task management | `DONE` | Tasks usable as a standalone daily tool ✔ (verified 2026-10-26) |
| M4 | Projects and planning | `DONE` | Notes + tasks + projects form one workflow ✔ (verified 2026-10-26) |
| M5 | Unified read-only calendar | `IN_PROGRESS` | Real calendar data synced safely (no writes) |
| M6 | Bidirectional calendar sync | `BACKLOG` | External event editing reliable for daily use |
| M7 | Cross-device sync and offline | `DONE` | Sync recoverable under realistic failure ✔ (verified 2026-10-27) |
| M8 | Notifications and mobile apps | `IN_PROGRESS` | Platform behaviour tested on real devices |
| M9 | Security, recovery, release | `IN_PROGRESS` | Production-readiness review |

**Rule:** do not start the next milestone until the current milestone's exit criteria pass.
If a criterion cannot be verified, record it as unverified — never silently waive it.

---

## M0 — Discovery and Architecture

**Goal.** Establish documentation, validate the proposed architecture, register risks and
produce a dependency-aware backlog. No production features.

**Deliverables.** Repository structure; `PRODUCT_SPEC.md`; `ARCHITECTURE.md`; `DATA_MODEL.md`;
technology decision record (`DECISIONS.md`); `RISKS.md`; this backlog; development-environment
and CI skeleton.

**Exit criteria.**
- Core architecture documented. ✔ (drafted)
- Every non-negotiable requirement (REQ-001…015) has an implementation strategy. ✔ (PRODUCT_SPEC §3/§5)
- Unresolved technical risks visible. ✔ (`RISKS.md`)
- Dependency licences checked. ◻ (initial pass in DECISIONS; full inventory in M1)
- No production features built. ✔

**Tasks**

| ID | Title | Depends on | Acceptance | Tests | Status |
|---|---|---|---|---|---|
| M0-01 | Write product specification | — | PRODUCT_SPEC covers vision, all REQs, boundaries, DoD | Doc review | `DONE` |
| M0-02 | Write architecture document | M0-01 | Components, deployment, ownership, flows, validations documented | Doc review | `DONE` |
| M0-03 | Write data model | M0-02 | Entities, ownership, sync/deletion semantics documented | Doc review | `DONE` |
| M0-04 | Record technology decisions | M0-02 | ADRs incl. the 10 validation items with evidence | Doc review | `DONE` |
| M0-05 | Establish risk register | M0-02 | Risks with severity, mitigation, owner milestone | Doc review | `DONE` |
| M0-06 | Produce dependency-aware backlog | M0-01…05 | M0–M9 tasks with deps, acceptance, tests | Doc review | `DONE` |
| M0-07 | Create repository skeleton + CI | M0-02 | Directory layout + minimal working CI | CI runs green | `DONE` |
| M0-08 | Initial dependency/licence inventory | M0-04 | Candidate deps + licences listed | Manual review | `DONE` (see `docs/DEPENDENCIES.md`) |

**Gate:** product owner approves the architecture and backlog before M1 begins.
**Result:** ✅ approved 2026-10-20.

---

## M1 — Foundation and Secure Deployment

**Goal.** A clean install starts, persists data, and protects all data behind authentication.

**Deliverables.** Docker Compose (`web`,`api`,`worker`,`db`); PostgreSQL integration; FastAPI app;
React app shell; authentication; Alembic migrations; structured logging; health checks; CI for
tests + linting.

**Exit criteria.**
- Clean install starts by following `DEPLOYMENT.md`. ✔ `PASS` — `docker compose up --build` brings all
  four containers to healthy/running (db healthy, api healthy, worker up, web up).
- Persistent data survives a restart. ✔ `PASS` — after `docker compose down` (volumes kept) and
  `up`, the pre-restart account still logs in (`setup_required:false`).
- Unauthenticated users cannot access protected data. ✔ `PASS` — `test_me_requires_authentication`
  (401) and `test_csrf_required_for_authenticated_writes` (403).
- Migrations run reproducibly on a clean DB. ✔ `PASS` — `alembic upgrade head` on a fresh
  PostgreSQL 18 cluster; `alembic check` reports no schema drift.
- No real secrets required in source control. ✔ `PASS` — `.env.example` holds placeholders;
  production rejects placeholder secrets at startup.

**Tasks**

| ID | Title | Depends on | Acceptance | Tests | Status |
|---|---|---|---|---|---|
| M1-01 | Repo scaffolding (apps/services/packages/tests/deploy) | M0-07 | Layout matches ARCHITECTURE §4; projects build | Build | `DONE` |
| M1-02 | Docker Compose with 4 services + volumes | M1-01 | `docker compose up` reaches healthy state | Smoke E2E | `DONE` |
| M1-03 | FastAPI skeleton + settings + structured logging | M1-01 | `/health` returns ok; logs are structured; no secrets logged | Unit | `DONE` |
| M1-04 | SQLAlchemy + Alembic baseline | M1-03 | Clean DB migrates up; downgrade works | Migration test | `DONE` |
| M1-05 | Local auth (Argon2id, sessions, CSRF, rate limit) | M1-04 | Login/logout; protected route rejects anonymous | Unit + integration | `DONE` |
| M1-06 | React app shell + navigation + theme | M1-03 | App loads, routes render, auth-gated | Frontend unit | `DONE` |
| M1-07 | OpenAPI → TS type generation | M1-03 | Generated types compile against API | Type check | `DONE` |
| M1-08 | Durable job queue module (ADR-0005) | M1-04 | Enqueue/claim/complete survives worker restart | Integration | `DONE` |
| M1-09 | CI pipeline (lint, typecheck, unit, integration) | M1-03 | CI fails on broken tests/lint | CI green | `DONE` |
| M1-10 | Dependency inventory + licence audit | M0-08 | Each dep has licence + purpose recorded | Manual review | `DONE` |
| M1-11 | Security baseline review | M1-05 | Threat model controls for M1 verified | Review + tests | `DONE` |

**Gate:** deployment + security basics verified. ✅ All four CI jobs (hygiene, backend, frontend,
containers) executed green via `act`, and the pipeline was shown to fail on a deliberately broken
test. Security review recorded in `docs/SECURITY.md` §11.

---

## M2 — Markdown Notes

**Goal.** Genuine `.md` files with safe, revision-aware editing and search.

**Deliverables.** Markdown root; note listing/editing; create/rename/delete; folder navigation;
full-text search; tags and wiki links; revision-aware API; path-traversal-safe file operations;
external-change reconciliation (ADR-0010).

**Exit criteria.**
- Notes are actual `.md` files, readable in an ordinary editor. ✔ `PASS` — files written to the
  notes root; content byte-identical (verified on disk and in the container volume).
- Unicode/special characters preserved. ✔ `PASS` — `test_unicode_and_special_characters_survive`,
  `test_unicode_content_round_trips_through_the_api`.
- Path traversal rejected. ✔ `PASS` — `test_note_paths.py` (traversal, absolute, reserved dir,
  symlink escape) and `test_path_traversal_is_rejected` → `400`.
- Concurrent edits never silently overwrite. ✔ `PASS` — stale revision → `409`
  (`test_update_requires_the_current_revision`); an external file edit is detected by hash and
  refused (`test_external_edit_is_never_overwritten`); both versions kept
  (`test_conflict_copy_preserves_both_versions`).
- Create/edit/retrieve via API verified. ✔ `PASS` — `test_notes_api.py`.

**Tasks**

| ID | Title | Depends on | Acceptance | Tests | Status |
|---|---|---|---|---|---|
| M2-01 | Safe storage layer (atomic writes, traversal guard, symlink policy) | M1-04 | Traversal/symlink outside root rejected; writes atomic | Unit | `DONE` |
| M2-02 | Note metadata index + content hash/revision | M2-01 | Revision changes on write; hash matches bytes | Unit + integration | `DONE` |
| M2-03 | Note CRUD API (revision-aware) | M2-02 | `409` on stale revision; no overwrite | Integration | `DONE` |
| M2-04 | Note editor UI (CodeMirror 6) + preview | M1-06,M2-03 | Source mode + preview; keyboard editing | Frontend unit + E2E | `DONE` |
| M2-05 | Folder navigation + file tree | M2-03 | Create/rename/delete folders; renames keep links | Integration | `DONE` |
| M2-06 | Full-text search (PostgreSQL FTS) | M2-02 | Search returns ranked matches | Integration | `DONE` |
| M2-07 | Tags + wiki links + backlinks + unresolved links | M2-06 | Links parsed; backlinks shown; unresolved flagged | Unit + E2E | `DONE` |
| M2-08 | Conflict handling + conflict copies | M2-03 | Concurrent edit preserves both versions | Integration | `DONE` |
| M2-09 | External file reconciliation (scan + fsnotify hint) | M2-02 | External edit refreshes metadata; no data loss | Integration | `DONE` |

**Note on M2-04 / M2-07 testing.** Frontend coverage is component-level (editor host, preview
sanitisation, tree navigation). Playwright end-to-end tests are not yet in the suite — recorded as
`NOT RUN` in `docs/ACCEPTANCE.md`, not waived.

**Gate:** Markdown portability and integrity verified. ✅

---

## M3 — Core Task Management

**Goal.** Tasks usable daily without any calendar integration.

**Deliverables.** Task model; Inbox; create/edit; priorities and due dates; recurring tasks;
subtasks; completion and archival; Today and Upcoming views; search and filters.

**Exit criteria.**
- Tasks persist across restarts. ✅ **PASS** — a task written to a migrated database survived a
  PostgreSQL container restart with identical id/title/status/revision (2026-10-26). *Devices*:
  cross-device convergence is M7 (M7-01/M7-02) — recorded, not waived.
- Recurring completion behaves correctly (future occurrences intact). ✅ **PASS** — M3-05.
- Due dates + time zones correct. ✅ **PASS** — M3-04 (DST unit tests + HTTP round-trips).
- Mutations transactional; retries do not duplicate. ✅ **PASS** — idempotency replay returns the
  original result (M3-02/M3-05 HTTP tests).
- Essential workflows work with calendar disconnected. ✅ **PASS** — no calendar integration
  exists in the codebase yet; the whole M3 workflow journey runs without one.

**Tasks**

| ID | Title | Depends on | Acceptance | Tests | Status |
|---|---|---|---|---|---|
| M3-01 | Task schema + migration | M1-04 | Fields per DATA_MODEL §2.3 | Migration test | `DONE` |
| M3-02 | Task CRUD API + idempotency keys | M3-01 | Duplicate key returns original result | Integration | `DONE` |
| M3-03 | Task state machine + transitions | M3-02 | Only valid transitions allowed | Unit | `DONE` |
| M3-04 | Priorities, due dates, time zones | M3-02 | DST-correct due handling | Unit | `DONE` |
| M3-05 | Recurring tasks (RRULE) | M3-03 | Completing an occurrence keeps the series; next generated | Unit + integration | `DONE` |
| M3-06 | Subtasks | M3-03 | Parent/child rules; completion rollup documented | Unit + integration | `DONE` |
| M3-07 | Inbox / Today / Upcoming views | M3-02,M1-06 | Views match spec §5.7; quick capture | Frontend + E2E | `DONE` |
| M3-08 | Task search and filters | M3-02 | Filter by status/priority/date/project; safe, bounded text search | Integration | `DONE` |
| M3-09 | Change log for tasks (client pull) | M3-02 | Incremental pull after revision N | Integration | `DONE` |

**M3-01 verification (2026-10-22).** `tasks` plus the §2.3 task-side tables (`recurrence_series`,
`task_tags`, `task_links`) modelled in `atlas/models/task.py` and applied by migration
`51b31762f974`. `ruff`, `ruff format --check` and `mypy` clean; the model→migration mapping is
checked by `tests/unit/test_task_schema.py` (8 assertions, incl. offline-rendered DDL and
reversibility). `project_id`/`reminder_policy_id` are carried as bare UUIDs — their foreign keys
are added when the `projects` (M4) and reminder-policy (M8) tables exist. The DB-backed
`tests/integration/test_tasks_schema.py` **passed** against PostgreSQL 17.11 on 2026-10-22 (migration executed: downgrade base → upgrade head); see
`ACCEPTANCE.md`. Evidence recorded in `ACCEPTANCE.md`.

**M3-02 verification (2026-10-22).** Task CRUD at `/api/tasks` (`POST`/`GET`/`GET {id}`/`PATCH`/
`DELETE`) in `atlas/api/tasks.py` + `atlas/tasks/service.py`; soft delete (tombstone) and
revision-aware updates. Idempotency via an optional `Idempotency-Key` header, reserved with
`INSERT … ON CONFLICT DO NOTHING` and replayed from a new `idempotency_keys` table (migration
`f403c1b05be3`). `ruff`/`format`/`mypy` clean; `pytest tests/unit` → 84 passed (no database);
OpenAPI + `apps/web/src/api/schema.d.ts` regenerated (CI drift check passes). The DB-backed
`tests/integration/test_tasks_api.py` is **`BLOCKED`** here. Also fixed a regression from the
opt-in DB fixtures: `test_jobs.py` and `test_tasks_schema.py` now request `_db` explicitly.

**M3-03 verification (2026-10-22).** Server-enforced status state machine in
`atlas/tasks/state.py` (`TRANSITIONS`, `validate_transition`, `transition_fields`), applied by
`TasksService` on create and update; invalid transitions → `409` with current/requested/allowed
(ADR-0013). `completed_at` is set exactly when a task is `completed`. `ruff`/`format`/`mypy` clean;
`pytest tests/unit` → 106 passed (22 new). DB-backed transition tests live in
`tests/integration/test_tasks_api.py` (`BLOCKED` here).

**M3-04 verification (2026-10-22).** DST-aware due-date handling in `atlas/tasks/timezones.py`
(`to_utc`/`to_local`/`local_date`/`due_state`, DST gap rejected, ambiguous times resolved by
`fold`) and priority ordering in `atlas/tasks/priority.py`; `time_zone` validated as an IANA zone
at the API boundary and naive `start_at`/`due_at` stored as UTC via the task's zone (ADR-0014).
`ruff`/`format`/`mypy` clean; `pytest tests/unit` → 125 passed (19 new). DB-backed due-date tests
in `tests/integration/test_tasks_api.py` are `BLOCKED` here.

**M3-02/03/04 DB-backed verification (2026-10-26).** PostgreSQL 18 was reachable
(`docker compose -f deploy/docker-compose.yml up -d db`), so the previously-`BLOCKED`
integration checks were executed: `pytest tests/integration/test_tasks_api.py
tests/integration/test_tasks_schema.py` → **26 passed**; full suite → **194 passed**. With
these the M3-02 (idempotency, CRUD, soft delete, stale-revision `409`, CSRF), M3-03
(transition enforcement over HTTP) and M3-04 (due-date/time-zone round-trips over HTTP)
criteria are `PASS`; the three tasks are `DONE`. Evidence in `ACCEPTANCE.md`.

**M3-05 verification (2026-10-26).** RRULE-based recurrence in `atlas/tasks/recurrence.py`
(`build_spec`/`occurrences`/`next_occurrence`; RFC 5545 engine from `python-dateutil`, ADR-0015)
wired into `atlas/tasks/service.py`. Creating a task with `recurrence_rule` (plus a `start_at` or
`due_at` anchor) creates the head task **and** its `recurrence_series` row; completing an
occurrence advances the series by exactly one step — it completes only that occurrence, creates
the next one (a new `inbox` task with `recurrence_parent_id` pointing at the head) and never
completes/deletes the series, the head or any other occurrence. `COUNT`/`UNTIL` and the
`end_date`/`count` columns end the series with no successor. Occurrences are computed on the wall
clock of the task's IANA zone (09:30 stays 09:30 across DST) and stored as UTC (ADR-0014). The API
validates the RRULE at the boundary (`422`); a recurrence without an anchor is `400`. `ruff`/
`format`/`mypy` clean; `pytest tests/unit -q` → **158 passed** (33 new); with PostgreSQL 18
(`atlas_test`) the full suite → **240 passed** (13 new recurrence integration tests) and
`./scripts/verify.sh` → `verification: PASS` (exit 0). No OpenAPI drift. Evidence in
`ACCEPTANCE.md`.

**M3-06 verification (2026-10-26).** Parent/child rules live in `atlas/tasks/subtasks.py`
(`validate_parent`, `ensure_parent_is_usable`, `subtask_project_id`, `rollup_from_statuses`) and are
enforced server-side by `TasksService` (ADR-0016): self-parenting, cycles at any depth, cross-user
parenting and a missing/soft-deleted parent are rejected with `400` and change nothing, and a
subtask inherits the parent's project. `GET /api/tasks?parent_task_id=…` lists a parent's direct
subtasks (`404` for an unknown parent), and `TaskOut` exposes the derived
`subtasks_total`/`subtasks_done` — completing a subtask never completes the parent. Soft-deleting a
parent promotes its live subtasks to top level (the FK's `ON DELETE SET NULL` intent), and a
generated recurring occurrence does not clone the parent's subtasks. `ruff`/`format`/`mypy` clean;
`pytest tests/unit -q` → **178 passed** (20 new); with PostgreSQL 18 (`atlas_test`) the full suite →
**272 passed** (12 new subtask integration tests) and `./scripts/verify.sh` → `verification: PASS`
(exit 0). OpenAPI + `apps/web/src/api/schema.d.ts` regenerated (CI drift check passes). Evidence in
`ACCEPTANCE.md`.

**M3-07 verification (2026-10-26).** The primary task views are implemented end to end. Backend:
`GET /api/tasks` accepts validated `view` (`inbox`/`today`/`upcoming`) and `tz` (IANA) query
parameters; the pure rules live in `atlas/tasks/views.py` (`TaskView`, `matches_view`,
`effective_time_zone`, `due_state_for`) and reuse `atlas/tasks/timezones.py` with no new date logic
(ADR-0017). A task's effective zone is its own `time_zone`, else the caller's `tz`, else UTC;
`TaskOut` now carries a derived `due_state` (`none`/`overdue`/`today`/`upcoming`). Today is
overdue-or-due-today and Upcoming is a later calendar day, both excluding completed/archived work;
Inbox is exactly the `inbox` status; `view` and `parent_task_id` are mutually exclusive (`400`).
Frontend: **Today** is the landing route and **Inbox**/**Upcoming** are routed from the primary
navigation (`App.tsx`; `Layout.tsx` already linked them); each view renders the API response through
`useTaskView` (`hooks/useTaskView.ts`) and groups via `lib/tasks.ts` (`groupToday`,
`groupUpcomingByDay`), with title-only **quick capture** (`QuickCapture`), useful empty states and a
clear error-with-retry (`LoadError`). `ruff`/`format`/`mypy` clean; `pytest tests/unit -q` →
**194 passed** (16 new); with PostgreSQL 18 (`atlas_test`) the full suite → **299 passed** (11 new
view integration tests) and `./scripts/verify.sh` → `verification: PASS` (exit 0). Frontend `lint`/
`typecheck`/`test` (25 vitest tests, 17 new)/`build` all clean. OpenAPI + `schema.d.ts` regenerated
with no drift. Browser E2E (Playwright) is `NOT RUN` — it is not set up in this repository. Evidence
in `ACCEPTANCE.md`; decision in ADR-0017.

**M3-08 verification (2026-10-26).** `GET /api/tasks` now accepts validated filters that compose
with each other and with the existing `view`/`tz`/`parent_task_id` parameters: `status` (repeated
or comma-separated), `priority`, an inclusive `due_from`/`due_to` range on `due_at`, an inclusive
`start_from`/`start_to` range on `start_at`, `project_id`, the bounded text search `q` over
title/description, and `limit`. The pure parsing/normalisation rules live in
`atlas/tasks/filters.py` (`parse_statuses`, `parse_priority`, `parse_instant`, `normalise_search`,
`search_pattern`, `build_filters`, `TaskFilters`); the SQL lives in `atlas/tasks/service.py`
(`_filter_conditions`/`_apply_filters`), where every value is a bound parameter and the search term
is escaped before being used as a `LIKE` pattern, so `%`/`_` match literally and a term can never
alter the statement. A filtered listing is ordered most-urgent-first (a SQL `CASE` derived from the
canonical `PRIORITY_ORDER`), then by earliest due date, then capture order; an unfiltered listing
keeps its original `(created_at, id)` order, and the M3-07 views keep their ordering and
classification. Unknown status/priority, a malformed or inverted date bound, a malformed project
id, an empty or over-long `q` and an out-of-range `limit` are rejected (`422`) without touching
data; `view` + `parent_task_id` stays a `400`. No migration was added — the existing indexes
(`user_id`, `status`, `priority`, `due_at`) cover the filters at the intended personal scale
(ADR-0018). `ruff`/`format`/`mypy` clean; `pytest tests/unit -q` → **222 passed** (28 new); with
PostgreSQL 18 (`atlas_test`) the full suite → **355 passed** (28 new filter/search integration
tests) and `./scripts/verify.sh` → `verification: PASS` (exit 0); frontend `lint`/`typecheck`/
`test` (27 vitest tests) clean; OpenAPI + `schema.d.ts` regenerated with no drift. Evidence in
`ACCEPTANCE.md`; decision in ADR-0018.

**M3-09 verification (2026-10-26).** `GET /api/tasks/changes?since=N&limit=…` is the incremental
pull: it returns the calling user's tasks with `revision > N`, ordered by `revision` ascending,
**including soft-deleted tombstones** (a non-null `deleted_at`), so clients observe deletions.
The response carries the new high-water mark `next_since` and `has_more`; a client pages on
`next_since` until `has_more` is false. Because `revision` is per-task (many rows share one value),
a page never splits a run of equal revisions — the pure planner `atlas/tasks/changes.py`
(`plan_change_page`, `parse_since`, `parse_change_limit`) hands out whole revision groups and the SQL
lives in `atlas/tasks/service.py` (`TasksService.changes`, fetching `limit + 1` rows to detect more).
`since` is bounded to `0…2147483647` and `limit` to `1…500` (default 200); an invalid value is a `422`
with no side effects, and the endpoint is read-only and strictly user-scoped. Deletion propagation
uses tombstones; tombstones are currently retained indefinitely, so a client may resync from
`since=0` — a bounded retention window is M7-02 (ADR-0019). No migration was added: `user_id` is
already indexed and the query runs per user at personal scale. `ruff`/`format`/`mypy` clean;
`pytest tests/unit -q` → **244 passed** (22 new); with PostgreSQL 18 (`atlas_test`) the full suite →
**387 passed** (32 new: 22 unit + 10 change-feed integration tests) and `./scripts/verify.sh` →
`verification: PASS` (exit 0); frontend `lint`/`typecheck`/`test` (27 vitest tests, unchanged) clean;
OpenAPI + `schema.d.ts` regenerated with no drift. Evidence in `ACCEPTANCE.md`; decision in ADR-0019.

**M3 gate verification (2026-10-26).** All M3 tasks (M3-01…M3-09) are `DONE` and the milestone gate
journey was run explicitly:

- **Full gate:** `./scripts/verify.sh` → `verification: PASS` (backend **387 passed**; frontend
  **27 passed**).
- **Workflow journey, calendar disconnected:** `pytest tests/integration/test_tasks_api.py
  test_tasks_views.py test_tasks_filters.py test_tasks_recurrence.py test_tasks_subtasks.py
  test_tasks_changes.py -q` → **93 passed** — over HTTP against PostgreSQL, with *no* calendar
  integration in the codebase at all.
- **Retry / idempotency:** the same run includes the idempotent-create and idempotent-completion
  tests (a repeated `Idempotency-Key` replays the original result — no duplicate task/occurrence).
- **Restart persistence:** a task written to a migrated database survived a real
  `docker restart atlas-db-1` with identical id/title/status/revision (disposable `atlas_gate`
  database, dropped afterwards; the running stack recovered to healthy).
- **Due dates + time zones:** M3-04 DST unit tests + the HTTP round-trip tests in the journey.
- **Not run:** browser E2E (Playwright not set up) and cross-*device* convergence (M7-01/M7-02) —
  recorded honestly, not waived.

**Gate:** tasks usable as a standalone daily tool. ✅ **PASS** (2026-10-26).

---

## M4 — Projects and Planning

**Deliverables.** Projects; project task lists; Kanban boards; task/project relationships;
derived progress; note-to-project links; daily/weekly planning.

**Exit criteria.**
- Tasks can be organised without forcing project membership. ✔ (M4-02 — membership is optional and
  single-valued; ADR-0021)
- Board changes persist and sync. ✔ (M4-03 — a move persists through `PATCH /api/tasks/{id}` with
  `base_revision` and reaches offline clients via the M3-09 change feed; *cross-device* convergence
  is M7, recorded not waived, as for the M3 gate)
- Progress is derived consistently (documented formula + tests). ✔ (2026-10-26 — ADR-0023)
- Today stays simple and responsive. ✔ (M4-06 — the Today view is unchanged; the new planning views
  reuse its components and add no work to it)
- Project data exports. ✔ (2026-10-26 — M4-07, ADR-0026)

**Tasks**

| ID | Title | Depends on | Acceptance | Tests | Status |
|---|---|---|---|---|---|
| M4-01 | Project schema + CRUD | M3-02 | Project fields per DATA_MODEL §2.3 | Integration | `DONE` |
| M4-02 | Task↔project association | M4-01 | Optional membership; filtering by project | Integration | `DONE` |
| M4-03 | Kanban board (columns from status) | M4-02 | Drag between columns persists; propagates | Frontend + E2E | `DONE` |
| M4-04 | Derived progress calculation | M4-01 | Documented formula; unit-tested | Unit | `DONE` |
| M4-05 | Note↔project links | M2-02,M4-01 | Association survives note rename | Integration | `DONE` |
| M4-06 | Daily/weekly planning views | M3-07,M4-02 | Planning reflects tasks + projects | Frontend + E2E | `DONE` |
| M4-07 | Project export | M4-01 | Projects + tasks exported in open format | Integration | `DONE` |

**M4-01 verification (2026-10-26).** `projects` modelled with the exact `DATA_MODEL` §2.3 columns
(`atlas/models/project.py`) and applied by migration `8f1c2a7d5e04`, which also adds
`tasks.project_id` → `projects.id` with `ON DELETE SET NULL` (ADR-0020). Project CRUD at
`/api/projects` (`POST`/`GET`/`GET {id}`/`PATCH`/`DELETE`) in `atlas/api/projects.py` +
`atlas/projects/service.py`: soft delete (tombstone), revision-aware updates with `base_revision`
(`409` on stale), optional `Idempotency-Key` replay, boundary validation and strict user scoping.
Because `tasks.project_id` is now a foreign key, task create/update validates the project against
the table (unknown/foreign project → `400`); the M3-08 `project_id` list filter keeps its existing
"unknown id matches nothing" semantics. `ruff`, `ruff format --check` and `mypy` clean; `pytest
tests/unit` → 258 passed; the full suite (unit + integration, PostgreSQL 18) → 419 passed; the
new migration upgrades and downgrades cleanly on a real database (downgrade base → upgrade head →
downgrade -1 → upgrade head). OpenAPI + `apps/web/src/api/schema.d.ts` regenerated (idempotent).
See `ACCEPTANCE.md` for the exact commands.

**M4-02 verification (2026-10-26).** Project membership is now explicit end to end and the project
tombstone's meaning for its tasks is settled (ADR-0021). A task can be **created in a project**
and **moved between projects or unfiled** with `PATCH /api/tasks/{id}`: the update boundary forwards
only the fields the client set, so an omitted `project_id` is left alone, an explicit `null` clears
membership and a different UUID moves the task — each change bumping `revision` and therefore
reaching offline clients through the M3-09 change feed. Membership stays optional and single-valued,
and the M3-06 subtask rule is untouched (a subtask still shares its parent's project; moving one
away is a `400`). Unknown, another user's or deleted projects are rejected with `400 project does
not exist` on create **and** update before any mutation, so a rejected assignment has no side
effects. A project's tasks are readable two ways — the M3-08 `project_id` filter on `GET /api/tasks`
(semantics unchanged: a well-formed unknown id matches nothing) and the new, documented
`GET /api/projects/{id}/tasks`, which reuses the same listing (same most-urgent-first order, same
`TaskOut` shape, live tasks only) but reports an unknown/foreign/tombstoned project as `404` and
rejects an out-of-range `limit` with `422`. Both are strictly user-scoped. **Tombstone behaviour:**
`DELETE /api/projects/{id}` still soft-deletes the project and **never** deletes a task; it *un-files*
the project's **live** tasks in the same transaction (one bound `UPDATE` clearing `project_id` and
bumping `revision`, the application-level mirror of the FK's `ON DELETE SET NULL`), so clients see an
ordinary "task updated" change and render the task as unfiled, while already-tombstoned tasks are
left untouched. After the delete the old project id matches nothing and can no longer be assigned.
No migration was needed; nothing in M4-03…M4-07 was touched. `ruff`, `ruff format --check` and `mypy`
clean; `pytest tests/unit` → 263 passed; the full suite (unit + integration, PostgreSQL 18) → 439
passed; frontend `lint`/`typecheck`/`vitest` → 27 passed; `./scripts/verify.sh` → `verification:
PASS`. OpenAPI + `apps/web/src/api/schema.d.ts` regenerated for the new endpoint (delta = the one
new path/operation). See `ACCEPTANCE.md` for the exact commands.

**M4-03 verification (2026-10-26).** The first user-visible M4 surface is a **global Kanban board at
`/board`** (nav item "Board"), whose five columns are exactly the task statuses —
`inbox`/`next`/`in_progress`/`completed`/`archived` — taken from the canonical
`services/api/atlas/tasks/state.py::TRANSITIONS` and mirrored on the client in
`apps/web/src/lib/taskStatus.ts` (columns, labels and allowed targets). The choice of a global board
(rather than a per-project one) and of native HTML5 drag-and-drop (no new dependency) is recorded in
ADR-0022. Tasks are read once with `GET /api/tasks` and grouped by status; a card is moved either by
dragging it to another column or with a per-card status `<select>` (the keyboard-accessible
alternative), and the move persists through `PATCH /api/tasks/{id}` with the task's `base_revision`
(new `tasksApi.setStatus`). Both paths offer **only** transitions the state machine allows — the
select disables the forbidden targets and a disallowed drop is refused — while the server stays
authoritative: a rejected move (a stale `409` or an invalid transition) is surfaced as a visible
`role="alert"` and the card is **not** moved, never silently ignored. Success replaces the card with
the server's response. Empty columns render a placeholder and an empty board a hint; columns are the
statuses so all five always render. Business logic lives in `hooks/useBoard.ts` and
`lib/taskStatus.ts`, not in the components. 20 new frontend tests added (`lib/taskStatus.test.ts` 6,
`api/client.test.ts` 3, `components/Board.test.tsx` 5, `pages/Board.test.tsx` 6): columns render with
their tasks, a valid move calls the API with `base_revision` and updates the card, a stale/invalid
`409` surfaces an error and leaves the card put, the keyboard path works and the drop path respects
the transition table, and the empty state. **No API change**, so OpenAPI / `schema.d.ts` were not
regenerated and no backend test was added. `ruff`, `ruff format --check` and `mypy` clean; `pytest
tests/unit` → 263 passed; the full suite (unit + integration, PostgreSQL 18) → 439 passed; frontend
`lint`/`typecheck`/`vitest` → 47 passed and `build` clean; `./scripts/verify.sh` → `verification:
PASS`. Browser E2E is `NOT RUN` (Playwright is not set up in this repo). See `ACCEPTANCE.md` for the
exact commands.

**M4-04 verification (2026-10-26).** Project progress is now derived, documented and exposed. The
canonical rule lives in one pure helper, `services/api/atlas/projects/progress.py`
(`progress_from_status_counts`, `project_progress`, `ProjectProgress`, `ZERO_PROGRESS`): `total` =
the project's live (`deleted_at IS NULL`), non-`archived` tasks; `completed` = those whose status is
`completed`; the reported `percent` = `round(completed × 100 / total)` to the nearest whole percent
(halves rounded up), and **0** when `total` is 0 — a project with no countable tasks is **not**
complete. Soft-deleted (tombstoned) tasks, `archived` tasks and tasks filed elsewhere never count
(ADR-0023, `PRODUCT_SPEC.md` §5.3). Every project response (`POST`/`GET`/`GET {id}`/`PATCH` on
`/api/projects`) now carries `progress: {total, completed, percent}`. The value is computed from
**one** grouped count (`ProjectsService.progress`, `GROUP BY project_id, status` over the caller's
live tasks), so `GET /api/projects` with N projects stays a fixed number of queries — no N+1. No
migration was added (nothing is stored). `ruff`, `ruff format --check` and `mypy` clean; `pytest
tests/unit` → **275 passed** (12 new); the full suite (unit + integration, PostgreSQL 18) → **460
passed** (9 new progress integration tests) and `./scripts/verify.sh` → `verification: PASS`
(exit 0); frontend `lint`/`typecheck`/`vitest` → 47 passed (unchanged). OpenAPI +
`apps/web/src/api/schema.d.ts` regenerated (delta = the new `progress` field and the
`ProjectProgressOut` schema). See `ACCEPTANCE.md` for the exact commands; decision in ADR-0023.

**M4-05 verification (2026-10-26).** Notes and projects are now linkable, and the association is
proven to survive a rename because it references the note's **stable id**, not its path. The new
`note_projects` association (`services/api/atlas/models/project.py`, `NoteProject`) has a composite
primary key `(note_id, project_id)` — unique per pair — and both foreign keys (`note_id → notes.id`,
`project_id → projects.id`) are `ON DELETE CASCADE`, consistent with the existing `TaskLink`
(reasoning recorded in **ADR-0024**). A `project_id` index serves the project→notes direction. One
versioned, reversible migration (`f2a9c7d14b60`, `down_revision` `8f1c2a7d5e04`) creates it and
matches the models (`test_migrations_match_models` green on a real DB). The surface reuses the
established patterns: `PUT`/`DELETE /api/projects/{id}/notes/{note_id}` link/unlink (both **naturally
idempotent**, `204`; no `Idempotency-Key` needed), `GET /api/projects/{id}/notes` lists a project's
notes (`NoteSummaryOut`, path order) and `GET /api/notes/{id}/projects` lists a note's projects
(`ProjectOut` with derived `progress`). Both ends are resolved against the caller before any write —
an unknown, another user's or tombstoned note/project is a `404` with **no side effects** — and every
endpoint is strictly user-scoped. **Delete effect:** the API's `DELETE` is a soft delete, so the FK
never fires on the ordinary path; instead `NotesService.delete` and `ProjectsService.delete` remove
the link rows in the **same transaction** as the tombstone, so a note delete or project delete leaves
no dangling association and deletes nothing else (the note/project rows are retained as tombstones);
the read listings also join only the live entity. `ruff`, `ruff format --check` and `mypy` clean;
`pytest tests/unit` → **287 passed** (12 new); the full suite (unit + integration, PostgreSQL 18) →
**492 passed** (20 new integration tests); the migration upgrades and downgrades cleanly on a real
database (downgrade base → upgrade head → downgrade -1 → upgrade head, `current` = `f2a9c7d14b60`);
frontend `lint`/`typecheck`/`vitest` → 47 passed (unchanged); `./scripts/verify.sh` →
`verification: PASS`. OpenAPI + `apps/web/src/api/schema.d.ts` regenerated (delta = the three new
paths/operations and the new `ProjectNotesOut` schema; `gen:api` is idempotent). See `ACCEPTANCE.md`
for the exact commands; decision in ADR-0024.

**M4-06 verification (2026-10-26).** Planning is now a first-class, navigable surface: a **Day** view
at `/day` and a **Week** view at `/week` (navigation items "Day" and "Week" next to Today/Upcoming),
both reading tasks from the existing `GET /api/tasks` and project context from the existing
`GET /api/projects` — **no backend file was touched, no new endpoint was added and
`apps/web/src/api/schema.d.ts` was not regenerated** — the task adds no API surface: the shared
client gained optional `dueFrom`/`dueTo` and multi-status forwarding for parameters the API already
documented, plus a three-line `projectsApi.list` wrapper. The
current day *is* the server's `today` view, so overdue work carried forward and today's work keep
their server-side classification (per-task zone; ADR-0014/ADR-0017) and are split with the existing
`groupToday` helper; any other day and every week are an inclusive `due_from`/`due_to` window in the
viewer's zone, filtered to open work (`inbox`/`next`/`in_progress`, the same active-status rule the
server's Today/Upcoming views apply). A week is the ISO week (Monday first) and always renders its
seven days, including the empty ones. Placement is time-zone correct and *not* re-derived: a task is
shown on the day its `due_at` falls on in the viewer's zone via `Intl.DateTimeFormat` (the approach
the Upcoming view already used), so a task due 23:30 UTC is planned on the next local day for a
viewer in Berlin; the only client date arithmetic is converting a local day's midnight to the UTC
instant the existing filter takes. Project context is reflected where it helps: a filed task shows a
project tag, and a short "Projects" summary lists the projects the plan touches with their **derived
progress** (M4-04/ADR-0023). Project context is non-fatal — a failure to load it is reported as a
status message and never hides the day. Business logic stays in `lib/planning.ts` and
`hooks/usePlanning.ts`; the pages and `components/TaskList`/`ProjectSummary` render props only, the
Today view is untouched, and the new styles reuse the existing theme variables (light/dark) with a
responsive seven-column week that collapses to one column on narrow screens. 30 new frontend tests
added (`lib/planning.test.ts` 11, `pages/Day.test.tsx` 9, `pages/Week.test.tsx` 6,
`components/ProjectSummary.test.tsx` 2, `api/client.test.ts` 2): day and week grouping, cross-day
placement, time-zone-correct placement (a UTC instant that belongs to a different local day),
navigation, project name **and** derived progress, empty states, error + retry and a non-fatal
project-context failure. `ruff`, `ruff format --check` and `mypy` clean; `pytest tests/unit` → 287
passed; the full suite (unit + integration, PostgreSQL 18) → 492 passed (both unchanged — no backend
code was touched); frontend `lint`/`typecheck`/`vitest` → **77 passed** (47 → 77) and `build` clean;
`./scripts/verify.sh` → `verification: PASS`. Browser E2E is `NOT RUN` (Playwright is not set up in
this repository). See `ACCEPTANCE.md` for the exact commands; decision in ADR-0025.

**M4-07 verification (2026-10-26).** Projects and their tasks now export in a documented, open
format. Two read-only, strictly user-scoped endpoints — `GET /api/projects/export` (all of the
caller's projects) and `GET /api/projects/{id}/export` (one project) — return a single **versioned
JSON document** (`format: atlas.project-export`, `version: 1`) containing each project's documented
fields, its **derived `progress`** (M4-04), its live **tasks** (the `DATA_MODEL` §2.3 fields with
stable UUID ids and ISO-8601 UTC instants, in capture order) and the **notes linked to it** (M4-05,
in path order). Only live rows are exported (tombstones excluded); `archived` tasks are included as
data while `progress` excludes them per the canonical formula (ADR-0023). The pure builder lives in
`services/api/atlas/projects/export.py` (single source of the shape, `build_document`/`task_document`
/`note_document`) and the DB reads in `ProjectsService.export`, which runs the whole document in one
**REPEATABLE READ** transaction (`begin_consistent_read`) so a concurrent write cannot tear the
snapshot. Scale is bounded: `limit` (1…500, default 200) caps the projects, the service fetches
`limit + 1` to report `truncated` honestly, and tasks/notes are fetched with one query each for
every selected project (no N+1, no per-project task cap). `GET /api/projects/{id}/export` reports an
unknown, another user's or tombstoned project as `404`. The format/version contract is ADR-0026. No
migration was added (read-only). `ruff`, `ruff format --check` and `mypy` clean; `pytest tests/unit`
→ **299 passed** (12 new); the full suite (unit + integration, PostgreSQL 18) → **519 passed** (27
new: 12 unit + 15 integration) and `./scripts/verify.sh` → `verification: PASS` (exit 0); frontend
`lint`/`typecheck`/`vitest` → 77 passed (unchanged) and `build` clean. OpenAPI +
`apps/web/src/api/schema.d.ts` regenerated (delta = the two new paths and the
`ProjectExportOut`/`ProjectExportTaskOut`/`ProjectsExportOut` schemas; `gen:api` is idempotent).
Browser E2E is `NOT RUN` (Playwright is not set up in this repository). See `ACCEPTANCE.md` for the
exact commands; decision in ADR-0026.

**M4 gate verification (2026-10-26).** All M4 tasks (M4-01…M4-07) are `DONE` and the milestone gate
("notes, tasks and projects form one coherent workflow") was run explicitly:

- **Full gate:** `./scripts/verify.sh` → `verification: PASS` (backend **519 passed**; frontend
  **77 passed**).
- **One workflow over HTTP against PostgreSQL:** the projects, task↔project, Kanban-backend,
  progress, note-link and export integration suites pass together —
  `pytest tests/integration/test_projects_api.py test_project_tasks.py test_project_progress.py
  test_note_projects.py test_project_export.py -q` → **65 passed**.
- **Membership is never forced:** a task with no project behaves exactly as in M3 (M4-02 tests);
  a project delete un-files its live tasks and never deletes them (ADR-0021).
- **Board persistence/propagation:** a board move is a `PATCH /api/tasks/{id}` carrying
  `base_revision`; the un-filing/move appears in the M3-09 change feed.
- **Progress:** derived, documented (ADR-0023) and covered by unit + integration tests.
- **Export:** projects + tasks + linked notes export in the versioned open format (M4-07, ADR-0026).
- **Not run:** cross-*device* convergence (M7-01/M7-02) — recorded honestly, not waived.

**Gate:** notes, tasks and projects form one coherent workflow. ✅ **PASS** (2026-10-26).

---

## M5 — Unified Read-Only Calendar

**Goal.** Aggregate Google and Microsoft calendars safely (no external writes).

**Deliverables.** Google OAuth; Microsoft OAuth; provider adapters; calendar selection; unified
view; incremental sync; sync status + errors.

**Exit criteria.**
- Both providers' selected calendars view together. ◻
- Recurring events + time zones correct. ◻
- Sync state survives worker restarts. ◻
- Disconnections recoverable. ◻
- Retries do not duplicate events. ◻
- Event source is clearly identified. ◻

**Tasks**

| ID | Title | Depends on | Acceptance | Tests | Status |
|---|---|---|---|---|---|
| M5-00 | Validate MS tenant + Google publishing mode with real accounts | M1-05 | Refresh tokens persist; scopes granted; limitations noted | Manual + recorded evidence | `BLOCKED` (needs real accounts — AR-001) |
| M5-01 | OAuth credential store (encrypted) | M1-05 | Tokens encrypted at rest; key external | Unit + integration | `DONE` |
| M5-02 | Provider adapter interface | M5-01 | Common interface; no provider leakage | Unit | `DONE` |
| M5-03 | Google Calendar adapter (read, syncToken) | M5-02 | Pagination, incremental, deletions handled | Adapter tests | `BACKLOG` |
| M5-04 | Microsoft Graph adapter (read, delta) | M5-02 | Pagination, delta, deletions handled | Adapter tests | `BACKLOG` |
| M5-05 | Calendar/account selection UI | M5-03,M5-04 | Select calendars; colour; connect/disconnect | Frontend + E2E | `BACKLOG` |
| M5-06 | Event projection store + sync cursors | M5-02,M1-08 | Cursor advances only after commit | Integration | `DONE` |
| M5-07 | Unified calendar view (day/week/month) | M5-05 | Time-zone-correct display; all-day + recurring | Frontend + E2E | `BACKLOG` |
| M5-08 | Sync status + error surface | M5-06 | Last sync, failures visible in UI | Integration + E2E | `DONE` |
| M5-09 | Change notifications (hints → reconcile) | M5-03,M5-04 | Notification triggers reconcile; never trusted as full log | Integration | `BACKLOG` |
| M5-10 | Periodic reconciliation fallback | M5-06 | Missed notifications recovered by scan | Integration | `DONE` |

**Entry note (2026-10-26).** M5-00 requires *real* Google/Microsoft test accounts and cannot be
run autonomously; it is `BLOCKED` pending the accounts (approval request **AR-001** in
`project/APPROVAL_REQUESTS.md`). By explicit product-owner decision, the loop proceeds with the
buildable M5 tasks (M5-01 credential store, M5-02 adapter interface, M5-06 sync store, …) using
fakes and unit/integration tests, and M5-00 plus the real-account adapter tests (M5-03/M5-04) are
executed before the milestone gate is closed.

**M5-01 verification (2026-10-26).** The encrypted credential store is implemented. `provider_credentials`
(`services/api/atlas/models/credential.py`) stores one credential per `(user_id, provider)` — `provider`,
`key_id`, `ciphertext` (`bytea`), `scopes` (`text[]`), `access_expires_at`, `refresh_expires_at` and the
timestamps, with a **unique constraint on `(user_id, provider)`** and `user_id → users.id ON DELETE
CASCADE` — created by one versioned, reversible migration (`c7d18e93a4f2`, `down_revision`
`f2a9c7d14b60`) that matches the models (`test_migrations_match_models` green on PostgreSQL). Tokens are
sealed with **AES-256-GCM** via the maintained `cryptography` library (`atlas/calendar/crypto.py`;
AGENTS.md §7.5 — no custom crypto), as a single authenticated `ciphertext` (`nonce || ciphertext+tag`)
with associated data binding the blob to its `(user, provider)`, so a ciphertext cannot be replayed onto
another row and tampering/unknown keys fail closed. The key is derived (HKDF-SHA256) from
`Settings.token_encryption_key`, held **outside the database** (never in the DB, an API or a log;
production rejects the placeholder), and each row records its `key_id` so keys can be rotated
(`token_encryption_key_id` / `token_encryption_previous_keys`). `ProviderCredentialsService`
(`atlas/calendar/credentials.py`) is the typed, strictly user-scoped **upsert / read / refresh / delete**
surface; `TokenBundle`/errors redact token material. The API (`atlas/api/calendar.py`) is the minimum to
persist credentials safely — `PUT`/`GET`/`POST …/refresh`/`DELETE /api/calendar/credentials/{provider}` —
and never returns tokens or ciphertext (`ProviderCredentialOut` is metadata only); a `422` on a
credential path never echoes the submitted token. No provider is contacted (M5-00 is `BLOCKED`, AR-001).
`ruff`/`format`/`mypy` clean; `pytest tests/unit -q` → **330 passed** (31 new); the full suite (unit +
integration, PostgreSQL) → **570 passed** (51 new: 31 unit + 20 integration); from repo root
`./scripts/verify.sh` → `verification: PASS` (backend **570 passed**; frontend **77 passed**, unchanged);
the migration upgrades/downgrades cleanly on a real database (downgrade base → upgrade head → downgrade
-1 → upgrade head, `current` = `c7d18e93a4f2`); `.venv/bin/pip-audit` → **No known vulnerabilities
found**; OpenAPI + `apps/web/src/api/schema.d.ts` regenerated (`gen:api` idempotent). Decision in
ADR-0027; evidence in `ACCEPTANCE.md`.

**M5-02 verification (2026-10-27).** The provider-neutral adapter contract is implemented.
`atlas/calendar/adapter.py` defines the `CalendarAdapter` Protocol — `list_calendars()`,
`list_events(calendar_id, *, cursor, page_token, page_size)`, plus `provider` and `cursor_type` —
deliberately free of Google/Microsoft SDK types (a unit test AST-checks these modules for provider
imports, so provider leakage is caught, not just promised). Neutral value objects live in
`atlas/calendar/types.py`: `Calendar`; `Event` (id, calendar id, provider, summary, aware `start`/`end`
instants, IANA `time_zone`, `is_all_day`, `status`, `etag` (provider version), `updated`,
`recurrence_id`, `recurrence_rule`, `ical_uid`); `EventDeletion` (a tombstone); and `EventPage`
(events + deletions + `next_page_token`/`has_more` + a durable `next_cursor` returned **only** on the
final page), with `CursorType` (`sync_token`|`delta_link`|`history_id`). Pagination (a transient page
token) and incremental cursors (a durable sync token) are separate concepts, so a cursor can be
persisted only after the corresponding changes are committed (`CALENDAR_SYNC.md` §4).
`atlas/calendar/errors.py` adds the provider-error taxonomy — `AuthExpiredError` (`REAUTH`),
`RateLimitedError` (`RETRY_AFTER`, honours a `Retry-After`), `TransientProviderError`
(`RETRY_BACKOFF`) and `PermanentProviderError` — each carrying a `RetryDisposition` and a
`retry_delay_for` helper that reuses the shared bounded exponential backoff, so the sync layer
retries/backoffs **without provider knowledge**. `AdapterRegistry` (in `adapter.py`) selects an
adapter by canonical provider name; an unknown provider raises `UnknownProviderError` naming the
known ones, and registering a provider twice is refused unless `replace=True`. `FakeCalendarAdapter`
(`atlas/calendar/fake.py`) implements the contract in memory with paging, incremental cursors and
tombstones; a cursor is advanced only to the revision a pass *started* at, so a change made while the
caller pages is deferred to the next pass and can never be skipped (covered by a unit test). The fake
is exported for reuse by M5-06. No Google/Microsoft adapter (M5-03/M5-04), no sync/projection store
(M5-06) and no UI are added; **no new dependency** is introduced (no provider SDK). `ruff` /
`ruff format --check` / `mypy` clean; `pytest tests/unit -q` → **368 passed** (38 new); the full suite
→ **608 passed** (38 new); from repo root `./scripts/verify.sh` → `verification: PASS` (backend
**608 passed**; frontend **77 passed**, unchanged). No provider is contacted (M5-00 is `BLOCKED`,
AR-001). Decision in ADR-0028; evidence in `ACCEPTANCE.md`.

**M5-06 verification (2026-10-27).** The event projection store and sync cursors are implemented and
verified against the M5-02 `FakeCalendarAdapter` and a real PostgreSQL (no provider contacted; M5-00 is
`BLOCKED` — AR-001). Two new tables, created by one versioned, reversible migration (`9d2f4b6a1c37`,
`down_revision` `c7d18e93a4f2`, matching the models — `test_migrations_match_models` green on
PostgreSQL): `external_events` (`atlas/models/calendar.py::ExternalEvent`) stores the provider event
projection with the exact neutral-event fields (`provider`, `external_event_id`, `calendar_id`,
`summary`, `start_at`/`end_at`, `time_zone`, `is_all_day`, `status`, `etag`, `ical_uid`,
`recurrence_id`, `recurrence_rule`, `source_updated_at`, `last_synced_at`, `deleted_at`), **unique per
`(user_id, provider, external_event_id)`**; and `sync_cursors` (`SyncCursor`) holds the per
`(user_id, provider, calendar_id)` cursor (`cursor_type`, `cursor_value`, `last_success_at`,
`last_error`/`last_error_at`), **unique per that triple**. `CalendarSyncService`
(`atlas/calendar/sync.py`) reads the stored cursor, drains every page of one pass, applies the events
(an `INSERT … ON CONFLICT DO UPDATE` on the unique key — idempotent, no duplicates) and the
`EventDeletion` tombstones (`deleted_at`, never a hard delete) **and** advances the cursor **in one
transaction**, committing once. A failure between apply and commit is rolled back, so the cursor is
unchanged and the next pass re-fetches the same changes — nothing is skipped (proved by a
`before_commit` crash-injection test); the failure path records `last_error` on the cursor row in its
own transaction without touching the cursor value. The cursor is persisted verbatim from the adapter's
**final page only**, so a change that lands mid-pass is **deferred, not skipped**; the first sync
establishes a baseline; a re-sync is idempotent; and every query is strictly user-scoped. The pure
apply/merge logic lives in `atlas/calendar/projection.py` (`projected_values`, `merge_event_row`,
`event_is_unchanged`, `ProjectionState`) and is unit-tested. `ruff`/`ruff format --check`/`mypy` clean;
`pytest tests/unit -q` → **386 passed** (18 new); with PostgreSQL (`atlas_test`) the full suite →
**642 passed** (34 new: 18 unit + 16 integration) and `./scripts/verify.sh` → `verification: PASS`
(exit 0); the migration upgrades/downgrades cleanly on a real database (downgrade base → upgrade head
→ downgrade -1 → upgrade head, `current` = `9d2f4b6a1c37`). No new dependency; no API surface, UI,
notifications or reconciliation (M5-05/M5-07/M5-08/M5-09/M5-10 are untouched). Decision in ADR-0029;
evidence in `ACCEPTANCE.md`.

**M5-08 verification (2026-10-27).** Calendar sync state is now observable end to end, derived from
the M5-06 cursor rows with **no parallel source of truth** (ADR-0030). Backend: `GET
/api/calendar/sync-status` returns, per provider/calendar, whether the account is `connected` (from
the M5-01 credential store), `last_success_at` (UTC), the derived `state` (`never_synced` | `idle` |
`error`) and `cursor_health` (`ok` | `missing` | `error`), plus the last error — a bounded,
content-free message only, never a token, ciphertext or raw cursor value. The derivation is pure
(`atlas/calendar/status.py`: `classify_cursor`, `rollup_provider`) and unit-tested; a recorded error
is the most recent outcome because M5-06 clears `last_error` on success. `POST
/api/calendar/providers/{provider}/sync` is an optional, strictly user-scoped, **naturally
idempotent** manual trigger that builds the adapter through the M5-02 registry seam and drains the
M5-06 service — no provider is contacted (M5-00 is `BLOCKED`, AR-001); a provider with no adapter is
`503`, an unconnected provider `409` and an unknown provider `422`, and the response carries counts
only. Frontend: the `/calendar` route now renders a small **sync-status surface** (`pages/Calendar.tsx`,
`components/SyncStatus.tsx`, `hooks/useSyncStatus.ts`, `lib/syncStatus.ts`) with loading/empty/error
states, a retry, a keyboard-accessible per-provider **Sync now**, light/dark styling and business
logic out of the component; it is a status surface only, not the M5-05/M5-07 event views.
`ruff`/`ruff format --check`/`mypy` clean; `pytest tests/unit -q` → **395 passed** (9 new); with
PostgreSQL (`atlas_test`) the full suite → **662 passed** (20 new: 9 unit + 11 over HTTP) and
`./scripts/verify.sh` → `verification: PASS` (exit 0); frontend `lint`/`typecheck`/`test` (101 vitest
tests, 24 new)/`build` all clean; OpenAPI + `apps/web/src/api/schema.d.ts` regenerated
(`services/api/openapi.json` re-exported). Browser E2E (Playwright) is `NOT RUN` — it is not set up
in this repository. Decision in ADR-0030; evidence in `ACCEPTANCE.md`.

**M5-10 verification (2026-10-27).** The periodic reconciliation fallback is implemented and
restart-safe. `atlas/calendar/reconcile.py` (`CalendarReconciliationService.scan`) enumerates every
`(user, provider)` with a stored credential, lists its calendars through the M5-02 registry seam and
re-syncs the ones **due** by running the M5-06 `CalendarSyncService` from the **stored cursor** — so a
change whose notification never arrived is recovered on the next scan and re-running is idempotent.
The scan is a durable `calendar_scan` job (M1-08) re-scheduled by `ensure_recurring_jobs`, so it
survives a worker restart; a stale run is reaped and re-scheduled. A durable running marker
(`sync_cursors.sync_started_at`, migration `b7c2e1a9f4d0`) is set before a pass and cleared in a
`finally`, letting the M5-08 status report `in_progress` truthfully (stale markers are ignored, so a
crashed run cannot lie) — same row, no parallel source of truth (ADR-0031). Due-selection uses
`calendar_reconcile_seconds` (300 s) and `calendar_sync_stale_seconds` (900 s); an unavailable provider
or one calendar's failure is skipped/counted, never aborting the scan, and every query is
user-scoped. `ruff`/`format`/`mypy` clean; `pytest tests/unit -q` → **408 passed**; with PostgreSQL
(`atlas_test`) the full suite → **695 passed** (32 new reconcile tests) and `./scripts/verify.sh` →
`verification: PASS` (backend 695; frontend 101); OpenAPI + `schema.d.ts` regenerated and in sync.
Decision in ADR-0031; evidence in `ACCEPTANCE.md`. **M5-10 is the last buildable M5 backend task** —
M5-03/M5-04 (real adapters), M5-05/M5-07 (views) and M5-09 (notifications) remain `BACKLOG` until
M5-00 (AR-001) unblocks, so the M5 gate stays open pending real calendar data.

**Gate:** real calendar data synchronised safely before external writes are enabled.

---

## M6 — Bidirectional Calendar Synchronisation

**Goal.** Reliable external event editing for supported types.

**Deliverables.** Event create/edit; external deletion handling; conflict detection; retry
policies; expired-token recovery; reconciliation; integration tests vs real test accounts.

**Exit criteria.**
- Supported edits propagate both directions. ◻
- Event ownership explicit. ◻
- Concurrent changes do not silently overwrite. ◻
- Retries do not duplicate. ◻
- Unsupported provider features reported. ◻
- Both providers pass acceptance tests. ◻

**Tasks**

| ID | Title | Depends on | Acceptance | Tests | Status |
|---|---|---|---|---|---|
| M6-01 | Create events via provider (Atlas-owned) | M5-06 | Created in provider; projection updated with returned id | Integration (real account) | `BACKLOG` |
| M6-02 | Update events via provider | M6-01 | Update reflected in provider; version stored | Integration | `BACKLOG` |
| M6-03 | External deletion propagation | M5-06 | Provider deletion removes/marks projection | Integration | `BACKLOG` |
| M6-04 | Conflict detection + resolution UI | M6-02 | Conflicts preserved and surfaced | Integration + E2E | `BACKLOG` |
| M6-05 | Retry/backoff + idempotency for writes | M1-08,M6-01 | No duplicate events on retry | Integration | `BACKLOG` |
| M6-06 | Expired/revoked token recovery | M5-01 | Re-auth flow; no data loss | Integration | `BACKLOG` |
| M6-07 | Feedback-loop prevention | M6-02 | Local echo does not re-trigger writes | Integration | `BACKLOG` |
| M6-08 | Bidirectional E2E per provider | M6-01…07 | Both directions, deletions, recurring, conflicts | E2E (real accounts) | `BACKLOG` |

**Gate:** external event editing reliable enough for daily use.

---

## M7 — Cross-Device Synchronisation and Offline Support

**Deliverables.** Client caching; revision-aware mutations; pending offline changes; reconnect
reconciliation; conflict handling; sync status UI.

**Exit criteria.**
- Multiple devices converge. ✅ **PASS** — any number of clients converge by paging the per-user
  change feed (`GET /api/changes`) to the head; the cursor is a total order per user (ADR-0032).
  *(No literal two-physical-device run was performed; the mechanism + integration tests are the
  evidence — recorded, not waived.)*
- Offline edits retained. ✅ **PASS** — the durable client queue (M7-03) + the E2E reload test.
- Stale writes detected. ✅ **PASS** — `base_revision` → `409`; E2E conflict tests (M7-05/M7-06).
- Conflicting note edits recoverable. ✅ **PASS** — notes conflict copies (M2-08) plus the M7
  conflict surface and resolution (keep-mine / take-server, ADR-0036).
- Deleted entities do not reappear. ✅ **PASS** — tombstones with a bounded retention window and a
  no-resurrection guarantee (M7-02, ADR-0033).
- Restart preserves queued work. ✅ **PASS** — E2E: an offline edit survives a full page reload and
  still syncs (M7-06).

**Tasks**

| ID | Title | Depends on | Acceptance | Tests | Status |
|---|---|---|---|---|---|
| M7-01 | Per-user change feed endpoint | M3-09 | Pull changes after revision N | Integration | `DONE` |
| M7-02 | Tombstones + retention window | M7-01 | Deletes propagate; no resurrection | Integration | `DONE` |
| M7-03 | Client offline queue (durable) | M7-01 | Edits survive reload/offline | Frontend + E2E | `DONE` |
| M7-04 | Reconnect reconciliation | M7-03 | Pending ops replayed; conflicts surfaced | Integration + E2E | `DONE` |
| M7-05 | Sync status UI | M7-01 | Pending/failed/conflicts visible | Frontend | `DONE` |
| M7-06 | Failure-mode tests | M7-03,M7-04 | Network loss, restart, stale client covered | E2E | `DONE` |

**Order note (2026-10-27).** M5's buildable tasks are `DONE` (M5-01/02/06/08/10) but its gate cannot
close — M5-00 (real Google/Microsoft accounts) is `BLOCKED` (AR-001) and M5-03/04/05/07/09 depend on it;
M6 depends on M5-06 → M6-01 (real provider writes) and is likewise blocked. Per `AGENTS.md` §5 ("the
exact order may be adjusted … when a documented dependency … justifies it") and the product owner's
standing instruction to continue, work proceeds with **M7**, which depends only on M3-09 (`DONE`) and
is independent of the calendar. M5/M6 resume when AR-001 unblocks.

**M7-01 verification (2026-10-27).** A single per-user change feed, `GET /api/changes?since=<cursor>&limit=…`,
was added: it returns the caller's changes across tasks, projects, notes **metadata** and the
note↔project links (including soft-delete tombstones) ordered by a **monotonic per-user cursor**, so a
client converges incrementally instead of re-fetching everything. The cursor is `change_log.seq`,
allocated from `users.change_seq` and stamped in the **same transaction** as each mutation, which makes
ordering a total order (ADR-0032); the store keeps one row per changed entity, so an entity bumped
twice between pulls appears once, at its latest cursor. `atlas/changes/{feed,record,service}.py`
(+ `api/changes.py`): pure cursor/page logic in `feed.py`, the transactional recorder in `record.py`,
read-only and strictly user-scoped; `since` (0…2^63−1) and `limit` (1…500, default 200) are bounded at
the boundary (`422`, no side effects). Migration `d4e8b2c6f913` adds `change_log` + `users.change_seq`
(reversible; matches the models). `ruff`/`format`/`mypy` clean; `pytest tests/unit -q` → **447 passed**;
with PostgreSQL (`atlas_test`) the full suite → **750 passed** (+55: 34 change unit tests + 21
integration) and `./scripts/verify.sh` → `verification: PASS` (backend 750; frontend 101); OpenAPI +
`apps/web/src/api/schema.d.ts` regenerated and in sync. Decision in ADR-0032; evidence in
`ACCEPTANCE.md`.

**M7-02 verification (2026-10-27).** The change feed's tombstone history is now bounded without ever
touching user data. A configurable retention window (`change_retention_days`, default **30 days**)
bounds how far back `GET /api/changes` reaches; a durable `changes.purge` job on the existing queue
(restart-safe via `ensure_change_purge_job`, re-scheduled every `change_purge_interval_seconds`,
idempotent, runs in one transaction) removes only old `change_log` rows — **never** a user's task,
project or note row — and raises `users.change_purge_floor` to the highest cursor it removed. When a
client's `since` predates that floor the feed returns `resync_required=true` with an empty change set
and `next_since` at the current head, instead of a partial feed that could resurrect a purged delete;
`since >= floor` is still served incrementally. Because `seq` and `changed_at` are stamped together
(ADR-0032) the purge removes a cursor prefix, making the floor exact. `atlas/changes/{retention,purge}.py`
(+ `service.py` resync branch, `api/changes.py`, `jobs/handlers.py`, `config.py`): pure rules in
`retention.py`, the SQL purge in `purge.py`. Migration `c1a2b3d4e5f6` adds `users.change_purge_floor`
+ index `ix_change_log_changed_at` (reversible; matches the models; upgrade/downgrade exercised on
`atlas_test`). `ruff`/`format`/`mypy` clean; `pytest tests/unit -q` → **456 passed**; with PostgreSQL
(`atlas_test`) the full suite → **766 passed** (+16: 9 retention unit tests + 7 purge/resync
integration tests) and `./scripts/verify.sh` → `verification: PASS` (backend 766; frontend 101);
OpenAPI + `apps/web/src/api/schema.d.ts` regenerated and in sync. Decision in ADR-0033; evidence in
`ACCEPTANCE.md`.

**M7-03 verification (2026-10-27).** The client can now keep offline edits **durably** and replay them
safely. A versioned, FIFO offline queue (`apps/web/src/lib/offlineQueue.ts`) records each pending
mutation as an operation carrying the entity type/id, the mutation (`create`/`update`/`delete`), a
client-generated **idempotency key** and the **`base_revision`** it was based on; it persists through a
thin `KeyValueStore` (`apps/web/src/lib/queueStorage.ts`) whose preferred backing is **IndexedDB**,
falling back to `localStorage` and then memory (ADR-0034). Because the backing is durable, a queued
edit **survives a reload** — proved by tests that re-instantiate the store over the same
IndexedDB/localStorage (queue unit tests; `queueStorage.test.ts` exercises the real IndexedDB path
under `fake-indexeddb`, added as a **test-only, MIT** dependency). A replay/sync engine
(`apps/web/src/lib/syncEngine.ts`) flushes the queue **in FIFO order** through the existing entity API,
sending each operation's `Idempotency-Key` and `base_revision`: a retry reuses the same key, so
**retrying never duplicates**; a stale `409` is **surfaced and the operation kept** — the client never
clobbers newer data; a network/5xx failure leaves the queue for the next reconnect. The same engine
pulls changes via `GET /api/changes` from a **durable cursor**, advancing it only *after* a page's
changes are applied, and on **`resync_required`** (the cursor predates the M7-02 retention floor) runs
a full resync and resumes from the returned head. The API client gained `changesApi.list` and
`Idempotency-Key` support (`apps/web/src/api/client.ts`); **no backend file changed and OpenAPI /
`schema.d.ts` were not regenerated** (the change feed already existed). A minimal status surface
(route **`/sync`**, nav "Sync"; `pages/Sync.tsx`, `components/OfflineQueueStatus.tsx`,
`hooks/useOfflineQueue.ts`, `lib/queueStatus.ts`) shows the pending/conflict/failed counts and a state
badge, with business logic in `lib`/`hooks` and a keyboard-focusable manual replay — M7-05 builds its
full UI on it. `ruff`/`ruff format --check`/`mypy` clean (backend untouched); `pytest tests/unit -q` →
**456 passed**; the full suite (PostgreSQL 18, `atlas_test`) → **766 passed** (both unchanged);
frontend `lint`/`typecheck`/`vitest` → **155 passed** (101 → 155; 54 new) and `build` clean;
`./scripts/verify.sh` → `verification: PASS`. Browser E2E (Playwright) is `NOT RUN` — it is not set up
in this repository. Decision in ADR-0034; evidence in `ACCEPTANCE.md`.

**M7-04 verification (2026-10-27).** The client now **reconciles on reconnect**. A reconciliation pass
(`apps/web/src/lib/reconciliation.ts`) is triggered when the browser fires `online`, when the tab
regains `focus`, and on demand — wired in `hooks/useReconciliation.ts`, which takes the reconciler as
an argument (business logic stays in `lib`/`hooks`, AGENTS.md §6). One pass (a) **reflects** the durable
queue, (b) **flushes** it through the M7-03 replay, (c) **surfaces** the outcome and (d) **pulls**
`GET /api/changes` from the stored cursor, applying each page to a new **durable local cache**
(`apps/web/src/lib/localCache.ts`, over the same `KeyValueStore` as the queue and cursor, so it
survives a reload). **Ordering is flush-then-pull on purpose**: draining the queue first removes an
entity's own just-landed edit before its server change is pulled (no self-conflict, no re-application)
and surfaces a conflict before the pull updates the cache (the pull never hides it). **Conflicts:** a
stale `base_revision` (`409`) is a conflict — the local edit is **kept** in the queue (never dropped)
and the server is **never clobbered**; the affected entity is recorded on the cache and rendered by a
small **conflict surface** (`components/ConflictNotice.tsx`, opened on the `/sync` page) that explains
the edit was kept. Manual resolution is M7-05. **`resync_required`** (the cursor predates the M7-02
retention floor) drops the stale cache — re-applying the still-queued local edits — and resumes from
the server's head, never trusting the partial feed. The pass is **idempotent** (a landed op is gone, a
conflict/failed op is not retried blindly, the pull resumes from the advanced cursor, and the cache
apply/mark helpers are stable to re-run) and **survives a reload** (proved by re-instantiating the
queue, cursor and cache over the same store). No backend file changed and OpenAPI / `schema.d.ts` were
not regenerated; **no new dependency** (ADR-0035). `ruff`/`ruff format --check`/`mypy` clean;
`pytest tests/unit -q` → **456 passed**; the full suite (PostgreSQL 18, `atlas_test`) → **766 passed**
(both unchanged — backend untouched); frontend `lint`/`typecheck`/`vitest` → **183 passed** (155 → 183;
28 new) and `build` clean; `./scripts/verify.sh` → `verification: PASS`. Browser E2E (Playwright) is
`NOT RUN` — it is not set up in this repository. Decision in ADR-0035; evidence in `ACCEPTANCE.md`.

**M7-05 verification (2026-10-27).** The sync state is now **visible and actionable**. A full
**sync-status panel** (`apps/web/src/components/SyncStatusPanel.tsx`, opened on the `/sync` route)
shows a single **overall state** badge — *up to date / syncing / offline / error / conflicts* — plus
the **pending / failed / conflict** counts, the queued operations and the conflicts. The overall state
is a pure rule in `lib/queueStatus.ts` (`overallSyncState`), so the component only renders it
(business logic stays in `lib`/`hooks`, AGENTS.md §6/§7.4); the panel **composes** the existing
M7-03/M7-04 surfaces (`OfflineQueueStatus`, `ConflictNotice`) and reads `useOfflineQueue`/
`useReconciliation` — no logic is duplicated.

Conflicts can be **resolved manually** per entity. **"Keep mine"** re-queues the kept local operation
against the **server's current revision** as its new `base_revision` (a new `OfflineQueue.rebase`
method) so the next flush is *accepted* instead of failing stale — the queued payload is untouched, so
no edit is lost; when the server revision is unknown the operation is returned to `pending` unchanged
so the next flush re-attempts it and re-learns the revision from the resulting `409` (the client still
never sends an unchecked write). **"Take server"** discards the local operation and adopts the
server's state (the entity's local-pending/conflict flags are cleared). Both actions live in
`lib/conflictResolution.ts` (`resolveConflict`), are wired by `hooks/useConflictResolution.ts`, and are
**idempotent**: resolving an already-resolved conflict touches nothing (`unchanged: true`) and the
queue-owned cache flags are re-derived by the existing `markLocalState`. The panel and the conflict
actions are light/dark (theme variables in `styles.css`), keyboard-accessible (focusable buttons,
`aria-live` overall badge, `aria-busy`/disabled while a resolution is in flight) with explicit empty,
loading and error states. No backend file changed, OpenAPI / `schema.d.ts` were not regenerated, and
**no new dependency** was added (ADR-0036). `ruff`/`ruff format --check`/`mypy` clean (backend
untouched); `pytest tests/unit -q` → **456 passed**; the full suite (PostgreSQL 18, `atlas_test`) →
**766 passed** (both unchanged); frontend `lint`/`typecheck`/`vitest` → **216 passed** (183 → 216; 33
new) and `build` clean; `./scripts/verify.sh` → `verification: PASS`. Browser E2E (Playwright) is
`NOT RUN` — it is not set up in this repository. Decision in ADR-0036; evidence in `ACCEPTANCE.md`.

**M7-06 verification (2026-10-27).** The M7 failure modes are now backed by **executed browser
evidence**. Playwright is set up in `apps/web` (`@playwright/test`, `playwright.config.ts`, an `e2e/`
directory and an `npm run e2e` script; Chromium installed) and serves the **production build** via
`vite preview`. Four deterministic failure-mode E2E tests drive the **real** `/sync` UI in Chromium
with the HTTP API mocked through Playwright network interception (authentication + the change feed
stubbed; task mutations answered on demand), so the suite needs no live backend and no real account
(AGENTS.md §11/§13): **network loss** (a queued edit is kept while offline and drains when the
connection returns), **restart** (a queued edit survives a full page reload over the same IndexedDB
store and still syncs) and **stale client** (a stale-revision `409` is surfaced, keeping the local
edit, and both resolutions behave as documented — **Keep mine** re-sends against the server's revision
and lands, **Take server** discards the local edit without ever writing it). Because M7-03..M7-05 build
the queue and its status/reconciliation surfaces but no *editing* UI enqueues an offline mutation yet,
each test seeds a queued operation **into the app's own durable IndexedDB queue** (the same store the
`/sync` page reads) to represent the offline-edit state, then drives the real UI to observe and flush
it — recorded honestly as a limitation. `cd apps/web && npm run e2e` → **4 passed (Chromium)**, run
green twice. `verify.sh` is protected and **does not** run E2E (it is a separate command; noted in
`TESTING.md`). No backend file changed and OpenAPI / `schema.d.ts` were not regenerated. `ruff`/
`ruff format --check`/`mypy` clean; `pytest tests/unit -q` → **456 passed**; the full suite
(PostgreSQL 18, `atlas_test`) → **766 passed**; frontend `lint`/`typecheck`/`vitest` → **216 passed**
and `build` clean; `./scripts/verify.sh` → `verification: PASS`. Evidence in `ACCEPTANCE.md`.

**M7 gate verification (2026-10-27).** All M7 tasks (M7-01…M7-06) are `DONE` and the gate journey was
run explicitly:

- **Full gate:** `./scripts/verify.sh` → `verification: PASS` (backend **766 passed**; frontend
  **216 passed**).
- **Change-feed / retention journey:** `pytest tests/integration/test_changes_api.py
  test_change_log_schema.py test_change_purge.py -q` → **28 passed** (per-user feed, paging,
  tombstones, retention purge, no resurrection).
- **Real browser E2E (Playwright, Chromium):** `cd apps/web && npm run e2e` → **4 passed** —
  network loss (queued edit kept offline, flushes online), restart (offline edit survives a reload and
  still syncs), and stale client (a `409` is surfaced; keep-mine re-sends at the server revision;
  take-server discards without clobbering). This closed the repo-wide "Playwright not set up" gap.
- **Not run:** a literal two-physical-device convergence run (the mechanism is the per-user change
  feed + E2E); the E2E uses a mocked API (no live provider — AR-001). Recorded, not waived.

**Gate:** synchronisation recoverable under realistic failure conditions. ✅ **PASS** (2026-10-27).

---

## M8 — Notifications and Mobile Applications

**Deliverables.** Reminder scheduler; desktop notifications; Android client; iOS client;
push-token management; notification preferences.

**Exit criteria.**
- Reminders work without the web app open (within platform limits). ✅ **PASS** (mechanism) — M8-01
  durable scheduler + M8-02 Web Push pipeline and service worker. *Real delivery needs a push service
  and VAPID keys, so the browser-delivery end is `NOT RUN` here — recorded, not waived.*
- Time-zone/reschedule correct. ✅ **PASS** — M8-01 (tz-correct fire instant) + M8-05 (reschedule on a
  timing/default change).
- Duplicate delivery controlled. ✅ **PASS** — M8-01 at-most-once (single `reminder_deliveries` row).
- Token/permission failures handled. ✅ **PASS** — M8-03 invalidation (a dead destination is disabled,
  never retried) + M8-02 consent states (unsupported/denied/disabled).
- Core tasks work on Android + iOS. ⛔ `NOT RUN` — M8-06/M8-07 need real devices.
- Desktop verified on Linux/Windows/macOS. ⛔ `NOT RUN` — M8-08 needs the three platforms.

**Tasks**

| ID | Title | Depends on | Acceptance | Tests | Status |
|---|---|---|---|---|---|
| M8-01 | Reminder scheduler (durable) | M1-08,M3-05 | Reminders fire once; cancelled entities skipped | Integration | `DONE` |
| M8-02 | Web Push (VAPID) desktop | M8-01,M8-03 | Notification delivered; permission handled | E2E | `DONE` |
| M8-03 | Device token registry + invalidation | M8-01 | Invalid tokens pruned | Integration | `DONE` |
| M8-04 | Push delivery (FCM/APNs or Expo relay) | M8-03 | Delivered on real devices; receipts handled | Manual on devices | `BACKLOG` |
| M8-05 | Notification preferences UI | M8-01 | Per-entity timing configurable | Frontend | `DONE` |
| M8-06 | Android client (Expo) | M1-07,M7-03 | Core task workflows work | Device E2E | `BACKLOG` |
| M8-07 | iOS client (Expo) | M8-06 | Core workflows; push via APNs | Device E2E | `BACKLOG` |
| M8-08 | Desktop verify Linux/Windows/macOS | M8-02 | PWA works on all three | Manual | `BACKLOG` |

**Order note (2026-10-27).** M5/M6 remain blocked on real provider accounts (AR-001) and M7 is `DONE`,
so work continues with M8's backend-deliverable tasks (M8-01 reminder scheduler, M8-02 Web Push,
M8-03 token registry, M8-05 preferences), which depend only on `DONE` tasks. M8-04/M8-06/M8-07/M8-08
(real-device delivery + mobile clients) need physical devices and are worked or recorded when hardware
is available; the M8 gate therefore stays open until then.

**Dependency swap (2026-10-27).** **M8-03 (device token registry)** is done before **M8-02 (Web Push)**:
the web-push subscription *is* a device token, so the registry (M8-03) is the storage M8-02 needs.
M8-02's dependency was updated to `M8-01,M8-03`; both originally depended only on M8-01, so this is a
pure ordering clarification, not a scope change.

**M8-01 verification (2026-10-27).** Durable reminder state and scheduler implemented
(`atlas/models/reminder.py`, `atlas/reminders/*`, migration `e5a91c3f7b64`). A reminder fires exactly
once at the time-zone-correct instant (interpreted in the entity's IANA zone via
`atlas/tasks/timezones.py`, ADR-0014) through the durable M1-08 queue; a retry/restart does not
deliver twice (single `reminder_deliveries` row per reminder); a cancelled/completed/archived/
soft-deleted entity is skipped; editing a due date reschedules and cancelling skips. Delivery is
behind a `Notifier` interface (`LoggingNotifier` default, `RecordingNotifier` fake for tests); real
Web Push is M8-02. Evidence: `services/api/tests/unit/test_reminder_schedule.py`,
`test_reminder_schema.py`, `services/api/tests/integration/test_reminders.py`; migration
upgrade/downgrade round-trip and `compare_metadata == []` on PostgreSQL 18; full API suite
`809 passed`; `./scripts/verify.sh` → PASS. See `ACCEPTANCE.md` (M8-01) and ADR-0037.

**M8-03 verification (2026-10-27).** The push-destination registry is implemented —
`notification_devices` (one row per `(user_id, channel, endpoint)`; `channel ∈ {web, android, ios}`;
web rows carry the subscription's `p256dh`/`auth`; `last_seen_at`/`disabled_at`) via migration
`a3f7c2d8b105` (new table only, reversible, matches the models). `atlas/notifications/{registry,service}.py`
provide strictly user-scoped, idempotent register/unregister/list (`GET`/`POST`/`DELETE /api/devices`);
re-registering the same destination is an **upsert** and **revives** an invalidated row, and the client
keys are never returned by an API or logged. `atlas/reminders/delivery.py` now targets the caller's
**active** destinations and, when a transport reports a destination invalid/expired (Web Push
`404`/`410`), **disables** exactly those rows so they are never retried (the M8-01 `Notifier` gained
`invalid_destinations`; no separate delivery logic). `ruff`/`format`/`mypy` clean; `pytest tests/unit -q`
→ **480 passed**; with PostgreSQL (`atlas_test`) the full suite → **856 passed** (+47: 28 unit + 19
integration) and `./scripts/verify.sh` → `verification: PASS` (backend 856; frontend 216). Decision in
ADR-0038; evidence in `ACCEPTANCE.md`.

**M8-02 verification (2026-10-27).** Web Push desktop delivery is implemented. Backend:
`atlas/notifications/vapid.py` turns `vapid_public_key`/`vapid_private_key`/`vapid_subject`
(environment secrets, never committed) into a config or a single explicit **disabled** state;
`atlas/reminders/push.py::PushSender` delivers through the maintained **`pywebpush`** library
(MPL-2.0, no custom crypto) behind the M8-01 `Notifier`, targeting the M8-03 registry's active web
destinations and reporting a push service's `404`/`410` as an `invalid_destinations` entry (so the
registry disables it); `GET /api/notifications/config` serves only the public key. Frontend: a
dependency-free service worker (`apps/web/public/sw.js`) renders the pushed payload (dedupe via
`data.dedupe_key`), and the `/notifications` consent surface (`lib/webpush.ts`, `hooks/useWebPush.ts`,
`components/NotificationConsent.tsx`) requests permission, subscribes with the VAPID key and registers
the destination via `POST /api/notifications/devices`, distinguishing unsupported/disabled/denied/
prompt/granted/subscribed. `ruff`/`format`/`mypy` clean; `pytest tests/unit -q` → **490 passed**; with
PostgreSQL (`atlas_test`) the full suite → **875 passed**; frontend `lint`/`typecheck`/`test` (244
vitest) /`build` clean; **real browser E2E**: `cd apps/web && npm run e2e` → **7 passed** (4 M7 failure
modes + 3 M8-02 push-consent: granted→subscribed+registered, denied→blocked, no-VAPID→unavailable).
Decision in ADR-0039; evidence in `ACCEPTANCE.md`. **Not exercised:** a real push *delivery* to a
browser (needs a live push service) — recorded `NOT RUN`, not waived.

**M8-05 verification (2026-10-27).** Reminder timing is configurable end to end. Backend:
`GET`/`PUT /api/notifications/reminders` read/set the user's **default** reminder timing, and
`PUT /api/tasks/{id}/reminder` sets or clears a **per-entity override**; the precedence is override >
default (ADR-0040). `reminder_policies.is_default` (migration `f1b2c3d4e5a6`, with the partial unique
index `uq_reminder_policies_default`) guarantees one default per user without touching existing
policies; changing the default **reschedules** every inherited task's durable reminder and clearing it
cancels them, both by reusing the M8-01 machinery (no new scheduling logic). Endpoints are strictly
user-scoped, idempotent, and validated (`days_before` + strict `HH:MM`); an invalid value changes
nothing. Frontend: a `ReminderPreferences` surface on the `/notifications` page
(`hooks/useReminderPreferences.ts`, `lib/reminders.ts`) with loading/error/saved states, business logic
out of the component, light/dark, keyboard-accessible. `ruff`/`format`/`mypy` clean; `pytest tests/unit
-q` → **515 passed**; with PostgreSQL (`atlas_test`) the full suite → **914 passed**; frontend
`lint`/`typecheck`/`test` (268 vitest) /`build` clean; `./scripts/verify.sh` → `verification: PASS`.
OpenAPI + `schema.d.ts` regenerated and in sync. Decision in ADR-0040; evidence in `ACCEPTANCE.md`.

**M8 gate status (2026-10-27).** The buildable M8 tasks are `DONE` (**M8-01 reminder scheduler**,
**M8-03 device registry**, **M8-02 Web Push + 3 push-consent E2E**, **M8-05 reminder preferences**) and
the notification/reminder behaviour is verified (914 backend + 268 frontend tests, 7 browser E2E).
Two exit criteria remain `NOT RUN` because they need hardware not available here — **M8-04/M8-06/M8-07**
(real mobile push + Android/iOS clients) and **M8-08** (Linux/Windows/macOS desktop matrix) — plus the
real (non-mocked) browser push delivery. **The M8 gate is therefore NOT closed**: "platform-specific
behaviour tested on actual devices" is unmet. It closes when real devices/services are available.

**Gate:** platform-specific behaviour tested on actual devices. ⛔ **OPEN** — needs real devices
(M8-04/M8-06/M8-07/M8-08), recorded not waived.

---

## M9 — Security, Recovery and Release

**Deliverables.** Backup automation; restoration tests; dependency/vulnerability checks; security
review; data export; upgrade docs; user docs; release checklist; known-limitations doc.

**Exit criteria.**
- Notes + DB restored together (demonstrated). ✔ `PASS` — M9-02 restore drill (2026-10-27). Auth/authz
  tests pass. ✔ No unresolved critical/high advisory — M9-04 scan clean (2026-10-27). ◻ All mandatory
  requirements verified or explicitly recorded incomplete. ◻ Clean install reproducible from docs. ◻

**Tasks**

| ID | Title | Depends on | Acceptance | Tests | Status |
|---|---|---|---|---|---|
| M9-01 | Automated DB + Markdown backups | M1-02 | Both stores captured; integrity check | Integration | `DONE` |
| M9-02 | Documented + executed restore drill | M9-01 | Restore verified end-to-end | Manual evidence | `DONE` |
| M9-03 | Full data export | M2,M3,M4 | Notes+tasks+projects exported open-format | Integration | `DONE` |
| M9-04 | Dependency + vulnerability scan | M1-10 | No unresolved critical/high | CI | `DONE` |
| M9-05 | Security review (threat model vs impl) | M9-04 | Controls implemented; findings recorded | Review | `DONE` |
| M9-06 | Upgrade + rollback docs, tested | M1-04 | Upgrade from prior version works | Manual | `DONE` |
| M9-07 | User + operator documentation | — | Install/use/operate documented | Review | `DONE` |
| M9-08 | Release checklist + known limitations | M9-01…07 | Labelled by actual completeness | Review | `DONE` |

**Order note (2026-10-27).** M5/M6 (real calendar accounts), M8's remaining device tasks and M8-04/06/07/08
are blocked on external resources, but M9's deliverables depend only on `DONE` tasks, so M9 is worked now.
Items whose evidence needs an operator (a real restore drill, a clean-install reproduction) are executed
as far as this environment allows and recorded honestly.

**M9-01 verification (2026-10-27).** Automated backups now produce **one backup set capturing both
durable stores**: a consistent plain-SQL PostgreSQL dump (`pg_dump` in a single transaction) and a
deterministic archive of the Markdown notes root, plus a `manifest.json` recording each part's store,
size and **SHA-256** and a self-verifying integrity check (ADR-0041). A new `atlas/backups` package
exposes `BackupService` (assemble in staging, verify, then atomically publish), `verify_backup_set`
(checks both parts are present and every checksum matches) and `atlas-backup run|verify|list`. A durable
job (`backups.run`) runs on the M1-08 queue, self-re-schedules and reaps a stale lock, and is started by
`ensure_recurring_jobs`. Destination (`BACKUP_DIR`) and retention (`BACKUP_RETAIN`, default 7) are
configurable; nothing is written outside the destination and the manifest contains no connection string
or secret. A partial/failed run is never published and its leftover staging directory is reported as
incomplete. `pg_dump` runs from the image's client (`postgresql-client`) or, on a host without one, via
`docker exec` into the DB container (`BACKUP_PG_DUMP_CONTAINER`). `ruff`/`format`/`mypy` clean; unit
suite **561 passed**; full suite with PostgreSQL (`atlas_test`) **936 passed** (+12 unit, +10 integration
over the 914 baseline); frontend **268 passed**; `./scripts/verify.sh` → `verification: PASS`. Decision in
ADR-0041; evidence in `ACCEPTANCE.md`. **Not implemented here:** the restore drill (M9-02) and the full
open-format export (M9-03).

**M9-02 verification (2026-10-27).** The restore drill was **executed** end to end with the real CLI.
A scratch PostgreSQL database (`atlas_restore_src`) was migrated to head (`f1b2c3d4e5a6`) and seeded
with known rows (a known user, task `RESTORE-DRILL-TASK-42` and project), together with a temp notes
root with known content. `atlas-backup run` produced a set (`20261027T111643Z-ecdf00ad`) that
verified `ok`. The dump was restored into a second scratch database (`atlas_restore_dst`) with
`psql … -v ON_ERROR_STOP=1` (exit 0, no `ERROR`/`FATAL`) and `notes.tar.gz` into a scratch directory
with `tar -xzf`. The restored data **matched the source**: notes byte-identical (`diff -r` exit 0 and
equal SHA-256 per file); the known user/task/project rows present with identical values; the schema
applied cleanly (restored `alembic_version` = source head; 23 tables / 203 columns on both); and a
normalized `pg_dump --data-only` diff and per-table `row_to_json` MD5 checksums were identical between
source and restored. The failure path was shown too: a tampered set (bytes appended to `database.sql`)
and a partial set (missing `notes.tar.gz`) both `FAILED` `atlas-backup verify` with exit 1, and an
interrupted-run staging directory was reported `INCOMPLETE`. Both scratch databases were dropped and
the scratch directories removed afterwards; the application `atlas` database and real notes were never
touched. `ruff`/`ruff format --check`/`mypy` clean; `pytest tests/unit -q` → **561 passed**; full suite
(`atlas_test`) → **936 passed**; `./scripts/verify.sh` → `verification: PASS`. The restore procedure is
documented as an operator runbook in `OPERATIONS.md` §2. Evidence in `ACCEPTANCE.md`. **Not run:** a
real-provider calendar-sync resumption check (needs M5-00/AR-001) — the sync cursor restores with the
DB and resumption is idempotent by design, recorded not waived.

**M9-03 verification (2026-10-27).** A full, portable export of **all three stores** is implemented
as one self-describing, verifiable *set* (ADR-0042). Each export writes
`atlas-export-<UTC-timestamp>-<id>/` containing the notes as their genuine `.md` files under
`notes/`, the tasks + projects as the M4-07 `atlas.project-export` document (reused, extended
**additively** with the top-level `unfiled_tasks` so no work is omitted) in `data.json`, a notes
metadata index in `notes.json` (per-note tags, wiki links and note↔project associations — metadata
only, never a wrapper for the content) and a `manifest.json` naming the format/version, `export_id`,
timestamp, `snapshot` and, for every file, its path, size and **SHA-256**. Every database read
happens inside one **REPEATABLE READ** transaction (the M4-07 `begin_consistent_read` approach), so
the snapshot cannot tear; each note file is written atomically and hashed while streaming, so the
index and manifest describe exactly the exported bytes. The export is **complete** (all live
projects, all live tasks including unfiled ones, all live notes — no `truncated`), **strictly
user-scoped** and handles the **empty** case. It is reachable two ways: `GET /api/export` (an
authenticated user's own data, streamed as an `application/zip`) and the operator `atlas-export` CLI
(`run --user/--user-id` | `verify` | `list`), which publishes the set atomically and verifies it
against its own manifest. Format + version contract: **ADR-0042**. No migration (read-only). `ruff`,
`ruff format --check` and `mypy` clean; `pytest tests/unit -q` → **582 passed** (21 new); the full
suite (PostgreSQL `atlas_test`) → **968 passed** (32 new: 21 unit + 11 integration) and
`./scripts/verify.sh` → `verification: PASS` (backend 968; frontend 268); OpenAPI +
`apps/web/src/api/schema.d.ts` regenerated (delta = the new `/api/export` operation; `gen:api`
idempotent). Browser E2E is `NOT RUN` (Playwright covers the M7/M8 surfaces; M9-03 is API/CLI only).
See `ACCEPTANCE.md` for the exact commands; decision in ADR-0042.

**M9-04 verification (2026-10-27).** Both real advisory scans were run on the installed dependency trees
and are **clean**. Backend: `services/api/.venv/bin/pip-audit --progress-spinner off` → `No known
vulnerabilities found` (exit 0) across **91** distributions (every runtime pin and the dev/CI toolchain;
the only skipped entry is the local, unreleased `atlas-api` package, which is not a published
dependency). Frontend: `npm audit --include=dev` / `--omit=dev` / `--audit-level=moderate` → `found 0
vulnerabilities` (exit 0) across **370** locked packages (32 prod + 338 dev). **No finding of any
severity** exists, so nothing was upgraded, pinned or accepted — and nothing was suppressed (no
`--ignore-vuln`, no laxer threshold, no `.npmrc`/`--omit` exclusion; the only skip is the local
package). The CI gate **already existed** and is confirmed by inspection: `.github/workflows/ci.yml` runs
`pip-audit` in the `backend` job (non-zero on **any** advisory) and `npm audit --audit-level=moderate`
in the `frontend` job (non-zero on **moderate/high/critical**) — stricter than the "no unresolved
critical/high" acceptance, so **no CI change was needed**. A live GitHub Actions run could **not** be
exercised here (`nektos/act` is not installed and there is no remote to push to), so the gate's failure
semantics were shown with local positive controls instead: `pip-audit -r` on a file pinned to
`urllib3==1.26.4` → exit 1 ("Found 20 known vulnerabilities"); `npm audit --audit-level=high` on a
scratch project pinned to `lodash@4.17.20` → exit 1 ("1 high severity vulnerability"). `ruff`/`ruff
format --check`/`mypy` clean; `pytest tests/unit -q` → **561 passed**; full suite (`atlas_test`) →
**936 passed**; frontend `lint`/`typecheck`/`test` → **268 passed**; `./scripts/verify.sh` →
`verification: PASS`. Inventory and evidence in `DEPENDENCIES.md` and `ACCEPTANCE.md`; recurring risk
R-17. **Not done here:** the M9-05 security review.

**M9-05 verification (2026-10-27).** The `SECURITY.md` §2 threat model was walked control-by-control
against the **delivered** implementation and its tests. Eleven of the twelve threats (T1–T11) are
**implemented server-side and evidenced** by test or code reference; T12 (work-account data-flow
acknowledgement) is **not delivered** (it belongs to M5-05) and is recorded as such, not as live. **One
real defect was found and fixed:** the SPA document and assets (served by nginx) carried **no**
security headers or CSP — the API's `Content-Security-Policy`/`X-Content-Type-Options`/`X-Frame-Options`/
`Referrer-Policy` only covered `/api` responses — so the T6 "strict CSP on the app" was only partly
implemented. `apps/web/nginx.conf` now sets those headers (plus `Permissions-Policy` and a CSP sized for
the built app: `script-src 'self'`, `style-src 'self' 'unsafe-inline'` for CodeMirror) on the SPA
location, scoped so proxied `/api` responses keep the API's own headers; the live browser effect is
**`NOT RUN`** here (nginx is not run by `verify.sh` or the Playwright suite, which uses `vite preview`).
A **new regression test** (`test_security.py::test_production_sets_hsts_and_disables_interactive_docs`)
now proves the production-only HSTS + interactive-docs-disabled posture (T9), previously inspected only.
One residual risk was added (**R-21**: a push destination `endpoint` is length/shape-bounded but not
restricted to an `https` push-service host — accepted for the single-user model). No finding was
suppressed. Controls that need an operator/host (TLS termination; real OAuth exchange under M5-00/AR-001;
the live nginx CSP effect) are recorded `NOT RUN` with reasons rather than waived. Full record with
per-control evidence, findings and commands in `SECURITY.md` §"Milestone 9 security review" and
`ACCEPTANCE.md` (M9-05). `ruff`/`ruff format --check`/`mypy` clean; `pytest tests/unit -q` → **582
passed**; full suite (`atlas_test`) → **969 passed** (+1 integration over the 968 baseline); frontend
`lint`/`typecheck`/`test` → **268 passed**; `./scripts/verify.sh` → `verification: PASS`. **Not done
here:** M9-06 (upgrade/rollback docs), M9-07 (user/operator docs), M9-08 (release checklist).

**M9-06 verification (2026-10-27).** The upgrade and rollback procedures are documented **and were
executed for real**. **Upgrade drill:** a scratch database (`atlas_upgrade_drill`) was taken to the
previous revision `51b31762f974` (notes+tasks schema) with `alembic upgrade 51b31762f974`, seeded
with representative prior state (a user and task `UPGRADE-DRILL-TASK-7`), then upgraded with the
documented command `alembic upgrade head` — all **11** later revisions applied (projects, note↔project,
provider credentials, calendar projections, change feed, reminders, notification registry, reminder
policies) and the database reached head `f1b2c3d4e5a6`. Verified after upgrade: the schema matches
the models exactly (`compare_metadata == []`, exit 0), the seeded rows survived (`drill@example.com`,
`UPGRADE-DRILL-TASK-7`), the new tables/columns exist (`projects`/`change_log`/`reminders`,
`users.change_seq`), and the app is healthy against the upgraded database (`/health` → 200 ok,
`/health/ready` → `database: ok`). **Rollback drill:** `alembic downgrade -1` removed revision
`f1b2c3d4e5a6`'s `reminder_policies.is_default` column and its unique index and moved the version to
`a3f7c2d8b105` with data intact; `alembic upgrade head` restored both and `compare_metadata` was `[]`
again. The **restore-from-backup** rollback path was also exercised: `atlas-backup run` produced a
set `20261027T122100Z-be1ab1e7` that verified `ok`, and it was restored into a second scratch database
(`atlas_rollback_dst`) with `psql … -v ON_ERROR_STOP=1` (exit 0), yielding head `f1b2c3d4e5a6`, the
known task row and `compare_metadata == []`. The runbook was written into `DEPLOYMENT.md` §6–§7
(ordered, copy-pasteable: preconditions → **back up first** → apply → verify → rollback via downgrade
or backup restore) matching the executed commands, cross-linked from `OPERATIONS.md` §2.6/§5. The
**M9-05 F1 fix is now confirmed live**: the web image was rebuilt and the recreated container serves
the SPA document with `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`,
`Referrer-Policy: no-referrer`, `Permissions-Policy` and the CSP on `/`, while proxied `/api`/`/health`
responses keep the API's own headers (scoping intact). Both scratch databases were dropped afterwards;
the application `atlas` database and real notes were never touched. `ruff`/`ruff format --check`/`mypy`
clean; `pytest tests/unit -q` → **582 passed**; full suite (`atlas_test`) → **969 passed**; frontend
**268 passed**; `./scripts/verify.sh` → `verification: PASS`. No migration, code or test changed (the
drills exercise the existing migrations and the M9-01 `atlas-backup` CLI); evidence in `ACCEPTANCE.md`.
**Not run:** a live upgrade of the *application* compose stack against a real operator host (the drill
used scratch databases and the host venv) — recorded, not waived.

**M9-07 verification (2026-10-27).** The user and operator documentation is written and reconciled
with the delivered code. Two new navigator guides were added — `docs/USER_GUIDE.md` (how to use notes,
tasks, Inbox/Today/Upcoming, Day/Week planning, the Kanban board, projects/progress, note search,
sync/offline and the `/sync` page, notification consent and reminder timing, the calendar status
surface, themes) and `docs/OPERATOR_GUIDE.md` (install, configuration reference, secrets and VAPID
keys, security hardening, backups, restore, upgrade/rollback, monitoring, troubleshooting) — each
**linking the canonical documents** (`DEPLOYMENT.md`, `OPERATIONS.md`, `SECURITY.md`,
`MARKDOWN_STORAGE.md`, `CALENDAR_SYNC.md`, `TESTING.md`, `.env.example`) rather than duplicating them,
and both carrying an explicit **"what is not delivered"** section (calendar accounts M5/M6 blocked on
AR-001; mobile apps and real push delivery M8; placeholder Tasks/Projects/Search/Settings pages; UI
gaps for task editing, filters and export). A dangling cross-reference was fixed by documenting
**Web Push (VAPID keys)** in `DEPLOYMENT.md` §3.1 (the section `.env.example` already pointed to), and
`README.md` now links both guides and states the milestone status honestly (the stale "Milestone 1 …
notes, tasks and calendar features are not implemented" banner is gone). Commands, paths and settings
were **spot-verified against the repository** — env names against `.env.example` and
`services/api/atlas/config.py`, scripts against `services/api/pyproject.toml`, `apps/web/package.json`
and `scripts/verify.sh`, compose services/volumes/ports against `deploy/docker-compose.yml`, and the
VAPID generation snippet was executed. No code, migration or test changed; `pytest`/`ruff`/`mypy` and
the frontend suites are untouched, and `./scripts/verify.sh` → `verification: PASS`. Review PASS table
in `ACCEPTANCE.md` (M9-07). **Not done here:** M9-08 (release checklist + known limitations), which
owns the release label.

**M9-08 verification (2026-10-27).** The release checklist, the consolidated known-limitations list and
the release label are produced, and the release-readiness table is filled honestly — **no code,
migration or test changed.** A new **`docs/RELEASE.md`** carries: the **release label**
**`0.1.0-pre` — development snapshot · NOT production-ready** (with the three open gates — M5/M6/M8 — and
why each is open); a **pre-release checklist** (build, tests, security/advisories, backup, restore,
upgrade/rollback, docs, dependency/licence inventory) with every green item **cited to the evidence in
`ACCEPTANCE.md`**, plus the gates that are **not** green (calendar accounts/views, bidirectional sync,
real/mobile push + desktop matrix, a literal two-device run); a **consolidated known-limitations list**
(the blocked calendar/mobile work; the API-first UI gaps; the operator **Compose env-forwarding caveat**
for `VAPID_*`/`GOOGLE_*`/`MICROSOFT_*`/`ALLOWED_HOSTS`/`EXPORT_DIR`/`CHANGE_RETENTION_DAYS`/…; the
load-bearing `TOKEN_ENCRYPTION_KEY`; TLS as an operator concern; and the residual risks **R-SEC-1/2/4**,
**R-17**, **R-20**, **R-21**, T12); and the list of work that is **blocked on external resources**
(AR-001 real Google/Microsoft accounts; real devices + a push service). The **"Release Readiness (M9)"**
table in `ACCEPTANCE.md` is filled per REQ-001…015 with honest `PASS`/`PARTIAL`/`NOT RUN` + evidence and
the delivering milestone: **9 `PASS`** (REQ-001–006, 013–015), **3 `PARTIAL`** (REQ-010 cross-device —
mechanism + mocked E2E only; REQ-011 notifications — pipeline delivered, real/mobile delivery `NOT RUN`;
REQ-012 OS-agnostic — web client verified on Linux, mobile clients + desktop matrix `NOT RUN`) and
**3 `NOT RUN`** (REQ-007/008/009 calendar — blocked on AR-001). No blocked/incomplete requirement is
marked `PASS`. `README.md`'s status now points at `docs/RELEASE.md`; `docs/CHANGELOG.md` gains a
`## [0.1.0-pre]` release heading with the label; `docs/OPERATOR_GUIDE.md` §12 links the release document.
`./scripts/verify.sh` → `verification: PASS` (backend **969 passed**; frontend **268 passed**); no
application database or real data was touched. Evidence in `ACCEPTANCE.md` (M9-08 and the Release
Readiness table). **Not done here:** the blocked M5/M6/M8 work — it stays `BLOCKED`/`BACKLOG` until the
external resources are available.

**M9 gate status (2026-10-27).** All M9 tasks (M9-01…M9-08) are `DONE` — backups, an executed
restore drill, full export, a clean vulnerability scan, a threat-model security review (one gap fixed),
executed upgrade/rollback, the user/operator guides, and a release document labelled by actual
completeness. **The gate itself is OPEN:** the production-readiness review's honest verdict is that
Atlas is **`0.1.0-pre` — NOT production-ready** while M5 (calendar accounts, AR-001), M6 and M8's
device/mobile tasks are open. Release-readiness: **9 `PASS`, 3 `PARTIAL`, 3 `NOT RUN`** (see
`ACCEPTANCE.md`). M9 closes when the blocked milestones do and a final readiness review is run.

**Gate:** production readiness review. ⛔ **OPEN** — `0.1.0-pre` (not production-ready; M5/M6/M8 open),
recorded not waived. See `docs/RELEASE.md`.

---

## Immediate Next Tasks

**All buildable work is `DONE`; the remaining work is blocked on external resources and cannot be
started here** — see [`RELEASE.md`](RELEASE.md) §6 and the Release Readiness table in
`ACCEPTANCE.md`. The next actions each require a resource this environment does not have:

- **M5-00** — Validate the Microsoft tenant + Google publishing mode with **real accounts** (the M5
  entry gate; approval request **AR-001**). Until it unblocks, the M5 calendar adapters
  (**M5-03/M5-04** → **M5-05/M5-07/M5-09**) and all of **M6** stay `BACKLOG`.
- **M8-04 / M8-06 / M8-07 / M8-08** — mobile/native push, the Android and iOS clients and the
  Linux/Windows/macOS desktop matrix need **real devices** and a live push service; the M8 gate stays
  open until then.

**M0–M4 and M7 are `DONE`.** **M5** is `DONE` for its buildable scope (`M5-01/02/06/08/10`) with
`M5-00` `BLOCKED`; **M8** is `DONE` for its buildable scope (`M8-01/02/03/05`) with the device tasks
`BACKLOG`; **M9** (`M9-01…M9-08`) is `DONE`. The M5/M6/M8 gates remain open on AR-001 and hardware,
so the release is **not production-ready** ([`RELEASE.md`](RELEASE.md) §1).
