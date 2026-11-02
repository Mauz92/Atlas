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
| **MU** | **Usable core — personal-OS UX** (ADR-0043) | `IN_PROGRESS` | **Worked next.** Owner journeys J1–J7 pass in a browser against the real API |

**Order change (ADR-0043, 2026-11-01).** MU is worked **before** the remaining M5/M6/M8 tasks, which stay
blocked on external accounts and devices. M5–M9 statuses above describe the *buildable backend scope*, not
owner-usable behaviour.

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

**M3-01 verification (2026-10-22).** `tasks` plus the §2.3 task-side tables (`recurrence_series`, `task_tags`, `task_links`) modelled in `atlas/models/task.py` and applied by migration `51b31762f974`. Full evidence: `ACCEPTANCE.md`.

**M3-02 verification (2026-10-22).** Task CRUD at `/api/tasks` (`POST`/`GET`/`GET {id}`/`PATCH`/ `DELETE`) in `atlas/api/tasks.py` + `atlas/tasks/service.py`; soft delete (tombstone) and revision-aware updates. Full evidence: `ACCEPTANCE.md`.

**M3-03 verification (2026-10-22).** Server-enforced status state machine in `atlas/tasks/state.py` (`TRANSITIONS`, `validate_transition`, `transition_fields`), applied by `TasksService` on create and update; invalid transitions → `409` with current/requested/allowed (ADR-0013). Full evidence: `ACCEPTANCE.md`.

**M3-04 verification (2026-10-22).** DST-aware due-date handling in `atlas/tasks/timezones.py` (`to_utc`/`to_local`/`local_date`/`due_state`, DST gap rejected, ambiguous times resolved by `fold`) and priority ordering in `atlas/tasks/priority.py`; `time_zone` validated as an IANA zone at the API boundary and naive `start_at`/`due_at` stored as UTC via the task's zone (ADR-0014). Full evidence: `ACCEPTANCE.md`.

**M3-02/03/04 DB-backed verification (2026-10-26).** PostgreSQL 18 was reachable (`docker compose -f deploy/docker-compose.yml up -d db`), so the previously-`BLOCKED` integration checks were executed: `pytest tests/integration/test_tasks_api.py tests/integration/test_tasks_schema.py` → **26 passed**; full suite → **194 passed**. Full evidence: `ACCEPTANCE.md`.

**M3-05 verification (2026-10-26).** RRULE-based recurrence in `atlas/tasks/recurrence.py` (`build_spec`/`occurrences`/`next_occurrence`; RFC 5545 engine from `python-dateutil`, ADR-0015) wired into `atlas/tasks/service.py`. Full evidence: `ACCEPTANCE.md`.

**M3-06 verification (2026-10-26).** Parent/child rules live in `atlas/tasks/subtasks.py` (`validate_parent`, `ensure_parent_is_usable`, `subtask_project_id`, `rollup_from_statuses`) and are enforced server-side by `TasksService` (ADR-0016): self-parenting, cycles at any depth, cross-user parenting and a missing/soft-deleted parent are rejected with `400` and change nothing, and a subtask inherits the parent's project. Full evidence: `ACCEPTANCE.md`.

**M3-07 verification (2026-10-26).** The primary task views are implemented end to end. Full evidence: `ACCEPTANCE.md`.

**M3-08 verification (2026-10-26).** `GET /api/tasks` now accepts validated filters that compose with each other and with the existing `view`/`tz`/`parent_task_id` parameters: `status` (repeated or comma-separated), `priority`, an inclusive `due_from`/`due_to` range on `due_at`, an inclusive `start_from`/`start_to` range on `start_at`, `project_id`, the bounded text search `q` over title/description, and `limit`. Full evidence: `ACCEPTANCE.md`.

**M3-09 verification (2026-10-26).** `GET /api/tasks/changes?since=N&limit=…` is the incremental pull: it returns the calling user's tasks with `revision > N`, ordered by `revision` ascending, **including soft-deleted tombstones** (a non-null `deleted_at`), so clients observe deletions. Full evidence: `ACCEPTANCE.md`.

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

**M4-01 verification (2026-10-26).** `projects` modelled with the exact `DATA_MODEL` §2.3 columns (`atlas/models/project.py`) and applied by migration `8f1c2a7d5e04`, which also adds `tasks.project_id` → `projects.id` with `ON DELETE SET NULL` (ADR-0020). Full evidence: `ACCEPTANCE.md`.

**M4-02 verification (2026-10-26).** Project membership is now explicit end to end and the project tombstone's meaning for its tasks is settled (ADR-0021). Full evidence: `ACCEPTANCE.md`.

**M4-03 verification (2026-10-26).** The first user-visible M4 surface is a **global Kanban board at `/board`** (nav item "Board"), whose five columns are exactly the task statuses — `inbox`/`next`/`in_progress`/`completed`/`archived` — taken from the canonical `services/api/atlas/tasks/state.py::TRANSITIONS` and mirrored on the client in `apps/web/src/lib/taskStatus.ts` (columns, labels and allowed targets). Full evidence: `ACCEPTANCE.md`.

**M4-04 verification (2026-10-26).** Project progress is now derived, documented and exposed. Full evidence: `ACCEPTANCE.md`.

**M4-05 verification (2026-10-26).** Notes and projects are now linkable, and the association is proven to survive a rename because it references the note's **stable id**, not its path. Full evidence: `ACCEPTANCE.md`.

**M4-06 verification (2026-10-26).** Planning is now a first-class, navigable surface: a **Day** view at `/day` and a **Week** view at `/week` (navigation items "Day" and "Week" next to Today/Upcoming), both reading tasks from the existing `GET /api/tasks` and project context from the existing `GET /api/projects` — **no backend file was touched, no new endpoint was added and `apps/web/src/api/schema.d.ts` was not regenerated** — the task adds no API surface: the shared client gained optional `dueFrom`/`dueTo` and multi-status forwarding for parameters the API already documented, plus a three-line `projectsApi.list` wrapper. Full evidence: `ACCEPTANCE.md`.

**M4-07 verification (2026-10-26).** Projects and their tasks now export in a documented, open format. Full evidence: `ACCEPTANCE.md`.

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

**M5-01 verification (2026-10-26).** The encrypted credential store is implemented. Full evidence: `ACCEPTANCE.md`.

**M5-02 verification (2026-10-27).** The provider-neutral adapter contract is implemented. Full evidence: `ACCEPTANCE.md`.

**M5-06 verification (2026-10-27).** The event projection store and sync cursors are implemented and verified against the M5-02 `FakeCalendarAdapter` and a real PostgreSQL (no provider contacted; M5-00 is `BLOCKED` — AR-001). Full evidence: `ACCEPTANCE.md`.

**M5-08 verification (2026-10-27).** Calendar sync state is now observable end to end, derived from the M5-06 cursor rows with **no parallel source of truth** (ADR-0030). Full evidence: `ACCEPTANCE.md`.

**M5-10 verification (2026-10-27).** The periodic reconciliation fallback is implemented and restart-safe. Full evidence: `ACCEPTANCE.md`.

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

**M7-01 verification (2026-10-27).** A single per-user change feed, `GET /api/changes?since=<cursor>&limit=…`, was added: it returns the caller's changes across tasks, projects, notes **metadata** and the note↔project links (including soft-delete tombstones) ordered by a **monotonic per-user cursor**, so a client converges incrementally instead of re-fetching everything. Full evidence: `ACCEPTANCE.md`.

**M7-02 verification (2026-10-27).** The change feed's tombstone history is now bounded without ever touching user data. Full evidence: `ACCEPTANCE.md`.

**M7-03 verification (2026-10-27).** The client can now keep offline edits **durably** and replay them safely. Full evidence: `ACCEPTANCE.md`.

**M7-04 verification (2026-10-27).** The client now **reconciles on reconnect**. Full evidence: `ACCEPTANCE.md`.

**M7-05 verification (2026-10-27).** The sync state is now **visible and actionable**. Full evidence: `ACCEPTANCE.md`.

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

**M7-06 verification (2026-10-27).** The M7 failure modes are now backed by **executed browser evidence**. Full evidence: `ACCEPTANCE.md`.

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

**M8-01 verification (2026-10-27).** Durable reminder state and scheduler implemented (`atlas/models/reminder.py`, `atlas/reminders/*`, migration `e5a91c3f7b64`). Full evidence: `ACCEPTANCE.md`.

**M8-03 verification (2026-10-27).** The push-destination registry is implemented — `notification_devices` (one row per `(user_id, channel, endpoint)`; `channel ∈ {web, android, ios}`; web rows carry the subscription's `p256dh`/`auth`; `last_seen_at`/`disabled_at`) via migration `a3f7c2d8b105` (new table only, reversible, matches the models). Full evidence: `ACCEPTANCE.md`.

**M8-02 verification (2026-10-27).** Web Push desktop delivery is implemented. Full evidence: `ACCEPTANCE.md`.

**M8-05 verification (2026-10-27).** Reminder timing is configurable end to end. Full evidence: `ACCEPTANCE.md`.

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

**M9-01 verification (2026-10-27).** Automated backups now produce **one backup set capturing both durable stores**: a consistent plain-SQL PostgreSQL dump (`pg_dump` in a single transaction) and a deterministic archive of the Markdown notes root, plus a `manifest.json` recording each part's store, size and **SHA-256** and a self-verifying integrity check (ADR-0041). Full evidence: `ACCEPTANCE.md`.

**M9-02 verification (2026-10-27).** The restore drill was **executed** end to end with the real CLI. Full evidence: `ACCEPTANCE.md`.

**M9-03 verification (2026-10-27).** A full, portable export of **all three stores** is implemented as one self-describing, verifiable *set* (ADR-0042). Full evidence: `ACCEPTANCE.md`.

**M9-04 verification (2026-10-27).** Both real advisory scans were run on the installed dependency trees and are **clean**. Full evidence: `ACCEPTANCE.md`.

**M9-05 verification (2026-10-27).** The `SECURITY.md` §2 threat model was walked control-by-control against the **delivered** implementation and its tests. Full evidence: `ACCEPTANCE.md`.

**M9-06 verification (2026-10-27).** The upgrade and rollback procedures are documented **and were executed for real**. Full evidence: `ACCEPTANCE.md`.

**M9-07 verification (2026-10-27).** The user and operator documentation is written and reconciled with the delivered code. Full evidence: `ACCEPTANCE.md`.

**M9-08 verification (2026-10-27).** The release checklist, the consolidated known-limitations list and the release label are produced, and the release-readiness table is filled honestly — **no code, migration or test changed.** A new **`docs/RELEASE.md`** carries: the **release label** **`0.1.0-pre` — development snapshot · NOT production-ready** (with the three open gates — M5/M6/M8 — and why each is open); a **pre-release checklist** (build, tests, security/advisories, backup, restore, upgrade/rollback, docs, dependency/licence inventory) with every green item **cited to the evidence in `ACCEPTANCE.md`**, plus the gates that are **not** green (calendar accounts/views, bidirectional sync, real/mobile push + desktop matrix, a literal two-device run); a **consolidated known-limitations list** (the blocked calendar/mobile work; the API-first UI gaps; the operator **Compose env-forwarding caveat** for `VAPID_*`/`GOOGLE_*`/`MICROSOFT_*`/`ALLOWED_HOSTS`/`EXPORT_DIR`/`CHANGE_RETENTION_DAYS`/…; the load-bearing `TOKEN_ENCRYPTION_KEY`; TLS as an operator concern; and the residual risks **R-SEC-1/2/4**, **R-17**, **R-20**, **R-21**, T12); and the list of work that is **blocked on external resources** (AR-001 real Google/Microsoft accounts; real devices + a push service). Full evidence: `ACCEPTANCE.md`.

**M9 gate status (2026-10-27).** All M9 tasks (M9-01…M9-08) are `DONE` — backups, an executed
restore drill, full export, a clean vulnerability scan, a threat-model security review (one gap fixed),
executed upgrade/rollback, the user/operator guides, and a release document labelled by actual
completeness. **The gate itself is OPEN:** the production-readiness review's honest verdict is that
Atlas is **`0.1.0-pre` — NOT production-ready** while M5 (calendar accounts, AR-001), M6 and M8's
device/mobile tasks are open. Release-readiness: **7 `PASS`, 5 `PARTIAL`, 3 `NOT RUN`** (re-scored 2026-11-01, ADR-0043) (see
`ACCEPTANCE.md`). M9 closes when the blocked milestones do and a final readiness review is run.

**Gate:** production readiness review. ⛔ **OPEN** — `0.1.0-pre` (not production-ready; M5/M6/M8 open),
recorded not waived. See `docs/RELEASE.md`.

---

## MU — Usable Core (personal-OS UX)

**Why this exists.** The 2026-11-01 function audit showed the backend runs ahead of the interface (see
ADR-0043, risk R-22). The owner's goal is a **personal operating system** — an Obsidian/Notion-class
workspace with tasks, projects, planning, calendar and reminders built in (`PRODUCT_SPEC.md` §1.1). MU
turns what already exists into something that can be used every day. It adds **no new data store**;
notes remain Markdown files, tasks/projects/links remain in PostgreSQL.

**Definition of done for every MU task.** Its journey passes **in a browser against the real API and a
real database** (MU-00), evidence is recorded in `ACCEPTANCE.md`, and the usual lint/type/unit/integration
checks pass. A task that is reachable only via the API is not `DONE`.

**Design rules for all MU work.**
- Keyboard-first: every action reachable without a mouse; shortcuts listed in one help overlay.
- One task detail surface, reused from Today, Inbox, Upcoming, Day, Week, Board, project pages and search.
- Optimistic updates through the existing offline queue; stale edits show the conflict UI, never overwrite.
- Show the server's real validation message; never a bare status text such as "Unprocessable Content".
- Server-side rules stay on the server (AGENTS.md §7.4): the UI does not reimplement recurrence,
  state transitions or access control.
- Prefer building on what exists (`useTaskView`, `useBoard`, offline queue, Notes page) over rewriting.

**Owner journeys (the exit criteria).**

| # | Journey | Passes when |
|---|---|---|
| J1 | **Capture and plan.** Add "Buy milk" on Today, open it, set priority High and due tomorrow | It shows in Today immediately after capture, moves to Upcoming after the date edit, survives reload, and a stale second-tab edit shows a conflict |
| J2 | **Triage the inbox.** Process five inbox items | Each can be scheduled (today/tomorrow/pick date), filed to a project, or deleted (with undo) in ≤2 interactions, keyboard only |
| J3 | **Run a project.** Create a project, add tasks, move them on its board | Create/edit/archive works; the project page shows progress, tasks, board and linked notes |
| J4 | **Write and link.** Write a note, turn a line into a task, link the note to a project | The task keeps a link back to the note, the note lists its tasks, backlinks include tasks and projects |
| J5 | **Find anything.** Press the palette shortcut, type part of a note, task or project name | Results from all three appear grouped; Enter opens; a "new note/task" action works from the same box |
| J6 | **Daily review.** Open Today | It shows today's tasks, overdue items, today's daily note (created on demand) and — once M5 lands — today's calendar events |
| J7 | **Stay in control.** Open Settings | Account, theme, reminder timing/notifications, export and backup status are all reachable and work |

**Tasks** (one at a time; dependencies in order).

| ID | Title | Depends on | Scope and acceptance | Tests | Status |
|---|---|---|---|---|---|
| MU-00 | **Real-stack journey harness** | M1-02 | Playwright runs against the real API + PostgreSQL (compose or CI service) with a fresh database per run and a helper that creates the owner account. The existing mocked-API specs stay as unit-level E2E. A trivial journey (setup → login → add task → see it in Inbox) passes in CI | Playwright (real API) | `DONE` (local PASS 2026-11-01; GitHub Actions job `e2e-real` added, **NOT RUN on Actions**; evidence: `ACCEPTANCE.md` MU-00) |
| MU-01 | **Task detail and editing; capture lands where expected** | MU-00, M3-02…M3-09 | One task detail panel (side sheet on desktop, full page on mobile) opened from any list: edit title, description, status, priority, due date/time/time zone, start, tags; delete with undo. Today capture sets due = today; Inbox rows get schedule/file/delete actions. Opens with Enter, closes with Esc. Server validation errors shown verbatim. **J1, J2 pass** | Component + Playwright J1, J2 | `DONE` (local PASS 2026-11-02: J1 + J2 pass against the real stack; evidence: `ACCEPTANCE.md` MU-01; CI job `e2e-real` **NOT RUN on Actions**) |
| MU-02 | **Projects UI** | MU-01, M4-01…M4-07 | Replace the Projects placeholder: list, create, edit, archive/restore; project page with description, derived progress (ADR-0023), task list, board and linked notes; assign/move tasks to a project from the task detail. Sidebar shows active projects. **J3 passes** | Component + Playwright J3 | `DONE` (local PASS 2026-11-02: J3 passes against the real stack; evidence: `ACCEPTANCE.md` MU-02; CI job `e2e-real` **NOT RUN on Actions**) |
| MU-03 | **Tasks page: all tasks, filters, sort** | MU-01, M3-08 | Replace the Tasks placeholder with the existing server filters (status, priority, due range, project, text) plus sort and a saved-filters shortcut list stored client-side; bulk complete/delete/move to project | Component + Playwright | `DONE` (local PASS 2026-11-02: `tasks-page.spec.ts` passes against the real stack; ADR-0045; evidence: `ACCEPTANCE.md` MU-03; CI job `e2e-real` **NOT RUN on Actions**) |
| MU-04 | **Recurrence, subtasks and reminders in the UI** | MU-01, M3-05, M3-06, M8-05 | Repeat picker (daily/weekly/monthly/custom RRULE preview) with server validation; completing a recurring task shows the next occurrence; subtask list with progress; per-task reminder override; delivery behaviour unchanged | Component + Playwright | `DONE` (local PASS 2026-11-02: `mu04-recurrence-subtasks-reminders.spec.ts` passes against the real stack; ADR-0046; evidence: `ACCEPTANCE.md` MU-04; CI job `e2e-real` **NOT RUN on Actions**) |
| MU-05 | **Command palette, quick switcher and unified search** | MU-01, MU-02, M2-06 | Global shortcut opens a palette: fuzzy find notes, tasks, projects; actions (new note/task/project, go to view, toggle theme). Backend adds one `GET /api/search` over notes (existing FTS), tasks and projects, user-scoped, bounded and indexed (resolves R-20). Replace the Search placeholder. **J5 passes** | Backend integration + Component + Playwright J5 | `DONE` (local PASS 2026-11-02: `j5-find-anything.spec.ts` passes against the real stack; ADR-0047; evidence: `ACCEPTANCE.md` MU-05; CI job `e2e-real` **NOT RUN on Actions**) |
| MU-06 | **Note ↔ task ↔ project linking** | MU-02, MU-05, M2-07, M4-05 | Create a task from the selected text/line in a note (explicit action; the task stores a link to the note; Markdown checkboxes are **not** parsed as tasks — AGENTS.md §8); note shows its tasks and project; task detail shows linked notes; `[[` autocomplete picks notes; backlinks list tasks and projects too. **J4 passes** | Backend + Component + Playwright J4 | `DONE` (local PASS 2026-11-02: `j4-write-and-link.spec.ts` passes against the real stack; ADR-0048; evidence: `ACCEPTANCE.md` MU-06; CI job `e2e-real` **NOT RUN on Actions**) |
| MU-07 | **Daily note, templates and Today as home** | MU-06 | "Today's note" creates/opens `daily/YYYY-MM-DD.md` on demand (a normal Markdown file); template notes from a `templates/` folder when creating a note; Today shows overdue, due today, scheduled work, the daily note and an events slot that stays empty until M5. **J6 passes** | Backend + Component + Playwright J6 | `DONE` (local PASS 2026-11-02: `j6-daily-note-and-today.spec.ts` passes against the real stack; ADR-0049; evidence: `ACCEPTANCE.md` MU-07; CI job `e2e-real` **NOT RUN on Actions**) |
| MU-08 | **Settings and shell polish** | MU-01 | Replace the Settings placeholder: account (name, password change), theme, reminder timing + notification status, export download, backup status/last run, instance info and version. Fix layout defects (note-name field squashed: fixed early), loading/empty/error states, mobile layout, shortcut help overlay, accessibility pass; (setup email validation: fixed early, `.local` still rejected). **J7 passes** | Component + Playwright J7 + axe check | `DONE` (local PASS 2026-11-02: `j7-stay-in-control.spec.ts` and the axe/layout sweep `mu08-a11y-and-layout.spec.ts` pass against the real stack; ADR-0050; `.local` emails now accepted; evidence: `ACCEPTANCE.md` MU-08; CI job `e2e-real` **NOT RUN on Actions**) |

**Exit criteria for MU.** J1–J7 pass in CI against the real API; every sidebar item is a working
screen (no "Not implemented yet" placeholders remain); `ACCEPTANCE.md` records the journey evidence;
the release table is re-scored from user-reachable behaviour.

**MU exit criteria — evaluation after MU-08 (2026-11-02). MU is NOT declared complete.**

| Criterion | Result | Evidence / gap |
|---|---|---|
| J1–J7 pass against the real API and a real database | `PASS` locally | `cd apps/web && npm run test:e2e:real` → `17 passed` (J1, J2, J3, J4, J5, J6, J7 plus MU-04/MU-03 and the axe sweep) |
| J1–J7 pass **in CI** | **`NOT RUN`** | the `e2e-real` job exists in `.github/workflows/ci.yml` but has never executed on GitHub Actions; this criterion is unverified |
| Every sidebar item is a working screen, no "Not implemented yet" placeholders | `PASS` (with a caveat) | `Placeholder` removed; all 14 items route to real pages (`App.tsx`). Caveat: **Calendar** shows sync status only, no events (M5 is blocked) and Today's events slot is empty by design |
| `ACCEPTANCE.md` records the journey evidence | `PASS` | sections MU-00…MU-08 |
| Release table re-scored from user-reachable behaviour | **`NOT DONE`** | REQ-005/REQ-006 are still `PARTIAL` as set on 2026-11-01; the re-score has not been run and needs the owner's review |

MU therefore stays open until CI has run the journeys and the release table has been re-scored.

**After MU.** Resume calendar: M5-00 (needs owner accounts, AR-001) → M5-03/04 → M5-05/07 so events
appear in Today/Day/Week. Mobile (M8-06/07) waits for decision A-09; the installable PWA is the
default mobile path until then. Scope decisions D-1…D-4 are settled in ADR-0043 (D-1 and D-3 deferred, revisited after MU-06; D-2 keeps CodeMirror 6; D-4 closed).

---

## Immediate Next Tasks

**Next: milestone MU (usable core): `MU-00` (real-stack journey harness), `MU-01` (task detail and
editing) and `MU-02` (Projects UI), `MU-03` (Tasks page) and `MU-04` (recurrence, subtasks and reminders in the UI) and `MU-05` (command palette, quick switcher and unified search) and `MU-06` (note ↔ task ↔ project linking) and `MU-07` (daily note, templates and Today as home) and `MU-08` (settings and shell polish) are `DONE`; MU itself is not closed (CI run and release re-score outstanding, see the MU exit-criteria evaluation).** See the MU section and ADR-0043 for why this precedes calendar and mobile
work. Everything else is blocked on a resource this environment does not have:

- **M5-00** — validate Microsoft tenant + Google publishing mode with **real accounts** (AR-001). Until
  it unblocks, **M5-03/M5-04** → **M5-05/M5-07/M5-09** and all of **M6** stay `BACKLOG`; they resume
  after MU so calendar events land in already-usable Today/Day/Week views.
- **M8-04 / M8-06 / M8-07 / M8-08** — native push, Android/iOS clients and the desktop matrix need
  **real devices** and a live push service (decision A-09).

The M0–M9 `DONE` statuses mean "buildable backend scope verified by API tests". They do **not** mean the
owner can use the feature; the release table (`ACCEPTANCE.md`) is the user-reachable view and currently
reads 7 `PASS`, 5 `PARTIAL`, 3 `NOT RUN`. The release is **not production-ready**
([`RELEASE.md`](RELEASE.md) §1).

---

## Audit Remediation (2026-11-01)

An engineering audit of the repository found the work sound but the process and baseline weak. These
tasks are cross-cutting and sit outside M0–M9. Pause new fake-backed features until the unblock
decisions below are made.

| ID | Title | Status | Evidence |
|---|---|---|---|
| A-01 | Commit the accumulated M3–M9 work | `DONE` | Commits `eb5a299`, `2fa7c7f`, `fe5d031` |
| A-02 | Fix the 8 failing backup tests (test probe chose an app container with a `pg_dump` client but no server) | `DONE` | `pytest tests/integration/test_backups.py` → 10 passed |
| A-03 | CI: install PostgreSQL 17 client so backup tests run against the postgres service | `IN_REVIEW` | Workflow edited; **not run on GitHub Actions** |
| A-04 | Compose: forward every setting the API reads (ALLOWED_HOSTS, VAPID_*, EXPORT_DIR, CHANGE_*, …) and bind the API port to 127.0.0.1 | `DONE` | `docker compose config -q` passes; runtime re-check pending |
| A-05 | Fix startup crash on documented `ALLOWED_HOSTS=host` / blank values (list settings now accept comma-separated or JSON) | `DONE` | `tests/unit/test_config.py` (regression, 4 cases) |
| A-06 | Docs: condense roadmap verification narrative to pointers (evidence lives in `ACCEPTANCE.md`); remove stale `project/BACKLOG.md` | `DONE` | `ROADMAP.md` 105 KB → 44 KB; original text in git history |
| A-07 | Decide the supported Python version (image/CI use 3.13; local venv 3.14; `mypy` targets 3.12) | `READY` | Needs a decision; see `DECISIONS.md` when taken |
| A-08 | M5-00 real-account validation (AR-001) | `BLOCKED` | Needs owner to supply throwaway Google/Microsoft test accounts |
| A-10 | Function audit; adopt the personal-OS direction; add milestone MU; re-score REQ-005/006 `PARTIAL` (ADR-0043, R-22) | `DONE` | `PRODUCT_SPEC.md` §1.1, `DECISIONS.md` ADR-0043, this section |
| A-09 | Decide mobile strategy: PWA-only v1 vs native Android/iOS (M8-06/07) | `BLOCKED` | Owner decision (iOS needs a paid Apple developer account) |

**Caveats recorded by the audit.**
- M7 and M9 are `DONE` for their buildable scope; M7 sync has not been exercised against real
  calendar data, which depends on M5-00.
- `ATLAS_ENV` defaults to `development`, which accepts the placeholder secrets. Production hardening
  applies only when `ATLAS_ENV=production`; operators must set it (see `DEPLOYMENT.md`).
