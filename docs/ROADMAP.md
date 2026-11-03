# Atlas — Roadmap and Backlog

**Status:** Draft for approval (Milestone 0)
**Last updated:** 2026-11-03

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
| **UX** | **Design system and app shell** (ADR-0051, `UX_AUDIT.md`) | `DONE` (local PASS; CI `e2e-real` NOT RUN) | UX-01…UX-03 `DONE` 2026-11-02, UX-04…UX-08 `DONE` 2026-11-03; J1–J7 and the axe sweep pass on the finished UI. The separate `AUTH-01` row (account recovery) stays `BACKLOG` and is not part of this exit |
| **SYNC** | **Local-first sync** (ADR-0055, ADR-0059 PROPOSED, `SYNC_PROTOCOL.md`) | `IN_PROGRESS` (design done 2026-11-03; SYNC-01 `READY`; nothing implemented) | Worked **first** (owner priority order). Server protocol + deterministic multi-client simulation pass before any native-shell task; Tauri spike verdict before SYNC-09/10 |

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

## UX — Design system and app shell

Source of evidence and detail: [`UX_AUDIT.md`](UX_AUDIT.md) (do not duplicate it here). Decisions: ADR-0051.
Rules for every UX task: no backend or data-model change unless stated; no new npm dependency; `npm run
test:e2e:real` (J1–J7) and the axe sweep keep passing (selectors may change only where the visible label
legitimately changes); screenshot set at 1440/1024/390 × light/dark attached to the evidence.

| ID | Title | Depends on | Status |
|---|---|---|---|
| UX-01 | Design tokens (neutral), base controls, pre-paint theme, quick wins 1, 3, 5, 6, 7, 8, 10 | MU-08 | `DONE` (local PASS 2026-11-02; evidence `ACCEPTANCE.md` UX-01; CI `e2e-real` NOT RUN) |
| UX-02 | App shell: rail, sectioned sidebar, status bar, mobile bottom nav, vendored icons; Day removed from nav | UX-01 | `DONE` (local PASS 2026-11-02; evidence `ACCEPTANCE.md` UX-02; CI `e2e-real` NOT RUN; not committed) |
| UX-03 | Task row, menus, quick actions (fixes: subtasks shown without parent; Complete shown on completed tasks) | UX-02 | `DONE` (local PASS 2026-11-02; evidence `ACCEPTANCE.md` UX-03; ADR-0052; CI `e2e-real` NOT RUN; not committed) |
| UX-04 | Task detail as property panel with per-field autosave | UX-03 | `DONE` |
| UX-05 | Notes workspace + note autosave (own tests before Save is removed) | UX-02 | `DONE` (local PASS 2026-11-03; evidence `ACCEPTANCE.md` UX-05; ADR-0054; CI `e2e-real` NOT RUN; not committed) |
| UX-06 | Live preview mode; Live becomes default once round-trip tests pass | UX-05 | `DONE` (local PASS 2026-11-03; evidence `ACCEPTANCE.md` UX-06; ADR-0056; CI `e2e-real` NOT RUN; not committed) |
| UX-07 | Tasks, Projects and Board polish | UX-03 | `DONE` (local PASS 2026-11-03; evidence `ACCEPTANCE.md` UX-07; ADR-0057; CI `e2e-real` NOT RUN; not committed) |
| UX-08 | Settings consolidation, skeletons, empty states | UX-02 | `DONE` (local PASS 2026-11-03; evidence `ACCEPTANCE.md` UX-08; ADR-0058; CI `e2e-real` NOT RUN; not committed) |
| AUTH-01 | Account recovery in the UI: recovery code issued at setup/in Settings, "Forgot password?" on the sign-in page, reset without email (CLI `atlas-admin reset-password` exists since 2026-11-03) | UX-02 | `BACKLOG` (needs an ADR and the owner's approval of the recovery design: there is no email service in a self-hosted install, so a one-time recovery code shown once at setup and regenerable in Settings is proposed; reset must revoke all sessions, be rate limited, never log the code, and store only its hash) |

### UX-01 plan — Design tokens and base controls
- **Scope.** Replace `:root` in `apps/web/src/styles.css` with the audit §3 tokens, using a neutral accent
  (ADR-0051 §1). Light and dark via `prefers-color-scheme` plus `data-theme` (System/Light/Dark in Settings); a
  pre-paint theme script in `index.html` (no light flash on login/setup). Base rules for button variants
  (secondary default, `.primary`, `.ghost`, `.danger`), input/textarea/select/checkbox/radio, `.pill`, `kbd`,
  section header; type/space/radius scales. Delete duplicate badge/heading rules. Tokenise the CodeMirror theme
  (dark gutter, `aria-label` on `.cm-content`). Quick wins 1, 3, 5, 6, 7, 8 and 10 from audit §6 (rest of 2/4/9
  belong to UX-05/UX-03). Control borders reach 3:1 (WCAG 1.4.11).
- **Out of scope.** Layout/navigation changes (UX-02), new components, any behaviour change.
- **Acceptance.** Only scale values in `font-size`/`gap`/`padding` (grep check script run by `verify.sh`); a unit
  test reads the tokens and asserts the audit's contrast ratios; login/setup follow the OS theme with no flash;
  axe clean on all swept routes; J1–J7 pass; before/after screenshots.
- **Tests.** Token contrast unit test; theme store test (System/Light/Dark); existing suites. **Size** M. **Risk**
  low (visual only, touches every page).
- **Status: `DONE` (2026-11-02).** As built: tokens in `styles.css` (neutral accent `#1f1f23` / `#e7e7ea`; text-3
  darkened to `#68686f` / `#9898a0` so meta text keeps 4.5:1 on hover and selected rows too); `lib/theme.ts`
  System/Light/Dark (System stores nothing and leaves `data-theme` off); pre-paint `public/theme-init.js` loaded
  from `index.html` (same-origin, so the nginx CSP `script-src 'self'` is unchanged); scale check
  `scripts/check-css-scale.mjs` runs from `npm run lint` (verify.sh is protected, so it is reached through
  lint); `.pill` replaces the five badge classes (old class names stay as test hooks without styles); one
  section-header rule; CodeMirror theme from tokens plus `aria-label="Note content"`; preview task checkboxes
  are named after their item; the notes toolbar shows path plus Saved/Unsaved changes, revision only in the
  tooltip. Not done here (left to their tasks): round task checkbox (UX-03), daily-note preview through
  `MarkdownPreview` (UX-05), dates in one format (UX-07), task-detail priority options still lowercase (UX-04).

### UX-02 plan — App shell
- **Scope.** `Layout.tsx`: icon rail (Today, Inbox, Tasks, Projects, Notes + Settings), collapsible sectioned
  sidebar generated from one `NAV_SECTIONS` config (shared with the command palette), Ctrl+B collapse remembered
  per browser, status bar fed by `useSyncStatus`/offline queue (offline, queued, conflict, last sync), mobile
  bottom nav plus drawer, topbar removed (search lives in the palette and a sidebar button). `/day`, `/calendar`,
  `/sync`, `/notifications` stay routable (redirects or sections) so no bookmark breaks; Day redirects to Today.
  Vendored `Icon.tsx` (about 25 Lucide SVGs, ISC notice in `DEPENDENCIES.md`).
- **Out of scope.** Page contents (UX-03…08); a Today date picker is added only if needed to replace Day.
- **Acceptance.** At most 6 top-level destinations; exactly one active item at any time (project pages included);
  status bar states covered by a component test with a mocked queue; all old URLs resolve; mobile has the bottom
  nav and no horizontal nav strip; J1–J7 and axe sweep pass with updated nav selectors only; screenshots.
- **Tests.** Component tests (nav config, active state, collapse persistence, status bar), redirect test,
  existing real-stack suite. **Size** L. **Risk** medium (IA change; selectors).
- **Status: `DONE` (2026-11-02).** As built: `lib/navigation.ts` `NAV_SECTIONS` (Planning: Today, Inbox,
  Upcoming, Week; Workspace: Tasks, Board, Projects + active projects, Notes; More, collapsed by default: Search,
  Calendar, Sync, Notifications, Settings) is the one source for the sidebar, the rail (items marked `rail`), the
  phone bottom nav and the palette's "Go to …"; each item has a rail `group`, so the rail lights the group and the
  sidebar the page (`activeNavKey`/`activeRail`; a section holding the current page opens by itself). Calendar,
  Sync, Notifications and Search stay at their URLs in *More* (least change; folding them into Settings sections is
  UX-08). `/day` → `<Navigate to="/" replace>`; `Day.tsx` stays unrouted until the Today date picker. Ctrl/⌘ B:
  wide (≥ 1024 px) docks/hides the sidebar, remembered as `atlas-sidebar`; section folds as
  `atlas-sidebar-sections`; below 1024 px the sidebar is a modal drawer (rest `inert`, focus in, Esc and focus
  return). Status bar (`StatusBar.tsx`, wording in `lib/statusBar.ts`) reads `useOfflineQueue`, `useSyncStatus`
  and the online/offline events; it is a labelled `<footer>`, not `role="status"`. Topbar removed; name, theme
  and Sign out in the sidebar footer; palette adds *Toggle sidebar* and *Sign out*. 24 vendored Lucide icons
  (`components/Icon.tsx`). Breakpoints: 1024 px (dock vs drawer), 720 px (rail vs header + bottom nav). Known
  follow-ups: the open note at 1024 px is narrower than before (shell 288 px vs 220 px) until UX-05 collapses the
  sidebar on notes; Settings is not in the phone bottom nav (drawer).

### UX-03 plan — Task row, menus and quick actions
- **Scope.** One shared `TaskRow` (round checkbox, title, meta, hover/focus quick actions, "…" menu) on Today,
  Inbox, Upcoming, Week, Tasks, project lists and search results; one shared accessible `Menu` (schedule:
  Today/Tomorrow/Next week/pick a date; priority; project; status; delete with undo); list keys `j`/`k`/`x`/`t`/
  `m`/`p`/Enter; board cards with the same meta and a card menu "Move to…" instead of the `<select>`; fixes for
  subtasks shown without their parent and "Complete" on completed tasks (project page).
- **Out of scope.** Task detail (UX-04), filter chips / Completed group / board `[`/`]` keys / drag-and-drop
  changes (UX-07), page width, backend.
- **Acceptance.** Inbox rows ≤ 2 persistent controls; J2 ≤ 2 interactions per item; rows ≤ 40 px on desktop
  (Playwright on seeded data); every action keyboard-only (Playwright); phone Inbox with 9 items < 1,000 px; axe
  clean; J1–J7, tasks-page and ux02 specs pass with selectors changed only where labels legitimately changed;
  component tests for TaskRow and Menu, one real-stack spec for the keyboard/menu flows.
- **Status: `DONE` (2026-11-02).** As built (ADR-0052): `components/TaskRow.tsx` (+ `TaskMeta`),
  `components/Menu.tsx` (WAI-ARIA menu in a portal inside the opener's landmark, top layer via
  `popover="manual"`, submenus as views, a date `dialog`), `components/TaskMenu.tsx` (entries),
  `hooks/useTaskActions.ts` (existing PATCH/DELETE with `base_revision` + idempotency key, one change per task in
  flight; exposed as `useTaskEditor().actions`), `hooks/useParentTitles.ts`, `lib/listKeys.ts`; `InboxActions.tsx`
  removed. Persistent: checkbox + "…"; hover/focus: Schedule for today, Pick a date, Move to a project (hidden on
  touch). Reopen = `completed → in_progress`. Tasks page: square selection box before the round checkbox, `x`
  selects there. Subtasks keep the server's list semantics (not a bug) and name their parent. Inbox triage rule
  (date or project → `next`) now applies on every list. Evidence: `ACCEPTANCE.md` UX-03.

### UX-04 plan — Task detail as a property panel with per-field autosave
- **Scope.** Rebuild `TaskDetail` as a Notion-like property panel: inline title, property rows (status,
  priority, due, start, time zone, project, tags) whose values open the shared `Menu` or an inline editor, a
  searchable time-zone list, an auto-growing description, then Repeat, Subtasks, Reminder and Linked notes
  restyled. Docked at ≥ 1280 px, overlay with scrim below, full-screen sheet on phones; focus trap as an overlay,
  Esc + focus return; header with the save indicator, "…" (copy link, delete with undo) and close. **No Save
  button**: each property saves itself, serialised per task, coalesced, with `base_revision` and idempotency.
- **Out of scope.** Notes autosave and removing the Notes Save button (UX-05); backend changes; new npm packages.
- **Acceptance.** No Save button; every property persists without an extra click (after reload, Playwright);
  requests never overlap for a task; stale edit → conflict UI, no overwrite; rapid type + close persists; Esc
  closes and focus returns to the row; indicator visible without scrolling at 900 px; list visible when docked;
  axe clean incl. panel states; J1–J7, tasks-page, ux02, ux03 and all real-stack specs pass.
- **Status: `DONE` (2026-11-03).** As built (ADR-0053): `lib/taskAutosave.ts` (save session + registry),
  `hooks/useTaskAutosave.ts`, `components/TaskProperties.tsx` (property row, menu property, time-zone list,
  tags, auto-growing textarea), `TaskDetail.tsx` rewritten; `TaskRepeat`/`TaskReminder` save without a button
  (custom values on blur/Enter), `TaskSubtasks`/`TaskNotes` restyled; `useTaskEditor` flushes before switching
  tasks, hands row-action updates to the panel and opens `/tasks?task=<id>` links; six vendored Lucide shapes.
  Note autosave and removing the Notes **Save** button remain in **UX-05**. Evidence: `ACCEPTANCE.md` UX-04.

### UX-05 plan — Notes workspace and note autosave
- **Scope.** (A, first) `lib/noteAutosave.ts`: a framework-free save session per note (no React, no DOM, no
  `window`): the API and the draft store are injected (`NoteStore`, `DraftStore`) so the same engine runs in
  the web app now and in the planned native desktop client later (owner note 2026-11-03: desktop app, Obsidian
  style, syncing with the Atlas server). Behaviour: debounce 1 s + flush on blur/switch/close/pagehide; one
  `PUT` in flight per note, queued edits coalesced, `base_revision` chained from each response; local draft
  (`content`, `base_revision`, timestamp) written synchronously on every change and cleared only after the
  server confirms; draft offered back on open/reload when it differs from the server (never applied silently
  over a newer revision). `409` = no overwrite: keep the text, show the existing conflict choices (keep as
  copy / load server version). Unknown outcome (network/5xx): retry with the same body; if the retry returns
  `409`, re-read the note and treat it as saved when the server content equals ours (note `PUT` has no
  idempotency key; no backend change). Offline: "Offline — saved on this device". Then remove the **Save**
  button and the "Discard unsaved changes?" prompts. (B) Workspace: sidebar is the tree (header icons New
  note / New folder / Collapse, row "…" menu: Rename, Move, Delete, New from template; no path text box or
  `window.prompt`), editor header (breadcrumb, save state, "…" menu with Task from selection / Rename /
  Delete), editor fills the height with a 72 ch measure and token-based CodeMirror theme, Links / Backlinks /
  linked tasks and projects in a right panel (toggle Ctrl+Alt+B), revision hidden in a tooltip, `[[links]]`
  render as links in the preview, sidebar collapses on Notes at 1024 px (UX-02 follow-up). Source mode stays
  the default; Live preview is UX-06.
- **Out of scope.** Live preview (UX-06); backend or note-format changes; new npm packages; a native client;
  offline *queueing* of structural operations (create/rename/delete stay online-only, R-22).
- **Required tests (written before Save is removed).** Unit (fake store, fake timers): rapid typing = one
  request with latest text; requests never overlap and the revision chains; 409 mid-typing keeps text and sends
  nothing more; unknown outcome then 409 with identical server content = saved; unknown outcome with different
  content = conflict; offline then online resends; flush on switch/close/pagehide; draft written on every
  change and cleared only after confirm; reload with a draft equal to / older than / different from the server.
  Real-stack: type then reload persists; offline typing, reload, reconnect persists; an external file edit
  during typing gives the conflict UI and the file on disk is never overwritten; Markdown file bytes are exactly
  the typed text (UTF-8, no added content); path traversal and note-ownership journeys (J4) still pass.
- **Acceptance.** No Save button or Ctrl+S requirement; every edit reaches the `.md` file without a click;
  no data loss under the cases above; conflict never overwrites; sidebar/editor/right panel layout works at
  1440, 1024, 720 and 390 px without horizontal scroll; axe clean; J1–J7, ux02–ux04 and all real-stack specs
  pass; ADR-0054 records the engine boundary (portable to desktop), draft format and the 409 rule.
- **Status: `DONE` (2026-11-03).** As built (ADR-0054): `lib/noteAutosave.ts` (engine, no React/DOM/window; `NoteStore` +
  `DraftStore` injected, `NoteSessions` registry), `lib/noteDrafts.ts` (`localStorage` drafts), `hooks/useNoteAutosave.ts`
  (web wiring, pagehide/online listeners), `NoteTree.tsx` (inline names, row menus), `Notes.tsx` rewritten (tree |
  note | details panel), `NoteEditor.tsx` (full height, 72ch, no line numbers, undo-safe replacement),
  `MarkdownPreview.tsx` (`[[links]]`), `Layout.tsx` (shell sidebar docks on Notes from 1280 px), six Lucide shapes.
  Phase A (engine, 27 unit tests) was finished and passing before the Save button and the discard prompts were
  removed; the real-stack specs needed the wired page, so they were written with it and run against the final
  code. Also added during verification: `reconcile` before reading a version to resolve a conflict (an edit made
  by another program is invisible to the revision check until indexed). Left for UX-06: live preview. Limitations in
  ADR-0054 and `RISKS.md` R-23.

### UX-06 — Live preview (done)
- **Scope.** Obsidian-style live preview as a third editor view made only of CodeMirror decorations
  (`lib/livePreview.ts`, ADR-0056): headings at scale, bold/italic/strikethrough/inline code, links, quotes,
  lists, task checkboxes (a click or Ctrl/⌘ Enter edits the text through the normal change path), fenced
  code, rules, `[[wiki links]]` (click opens the note) and `#tags`, hidden on every line without the cursor or a
  selection. **Source | Live** switch in the note header (names `Source`, `Live`; **Preview** unchanged and
  combinable), remembered as `atlas-notes-mode`. Line endings of a note are kept (`EditorState.lineSeparator`).
- **Status: `DONE` (2026-11-03).** Order of work: the decorations, the corpus round-trip tests and the real-stack
  specs existed and passed with the default still `source`; only then `DEFAULT_EDITOR_MODE` became `"live"`,
  and the whole real-stack suite (including J4, J6, ux05 and the axe sweep) was run with Live as the default.
  No backend, schema or new npm package (`@codemirror/language` declared directly: it was already installed).
  Known limitation found: the server normalises CRLF to LF on read (R-24), so the real-stack CRLF byte test is
  `BLOCKED` (unit-level proof only). Other limits in ADR-0056 and R-25.

### UX-07 plan — Tasks, Projects and Board polish
- **Scope.** (1) Tasks page: the stacked form becomes one **filter bar** (search field, chips Status / Priority /
  Project / Due / Sort that open the shared `Menu` or, for the Due range, a small popover; a List | Board segmented
  toggle; "Reset filters" when anything is set; a "…" menu with *Save this view…*, *Saved views* and *Remove saved
  view*). URL state stays exactly ADR-0045 (`view=board` is the only new, additive parameter). Bulk selection keeps
  the square boxes and `x`, and the bulk bar now floats (sticky above the status bar). Board mode of the Tasks page
  renders the filtered tasks. (2) Projects: rows with name, status pill, tokenised progress bar, open count, target
  date and a "…" menu (Open, Archive/Restore); archived projects behind a *Show archived (n)* toggle. (3) Project page:
  header (name, status pill, progress, dates, "…" menu with Edit/Archive/Restore) and tabs **Tasks | Board | Notes**
  (URL `?tab=`); completed (and archived) tasks fold into *Completed (n)* / *Archived (n)* groups. (4) Board: compact
  cards (title, project dot, due, priority flag), "Move to…" in the card menu **plus keys `[` / `]`** (previous / next
  allowed column, focus follows the card, polite announcement), the Archived column behind a toggle. (5) One date
  format (`formatDay`, no ISO dates shown). Business rules (`adjacentStatus`, due presets, chip labels) are pure
  functions in `lib/`, covered by unit tests; every write is the existing revision-checked, idempotent call.
- **Out of scope.** Backend/schema changes, new npm packages, drag-and-drop redesign, project delete, server-side
  sort, a sidebar section for saved views (they live in the filter bar's "…" menu; the sidebar stays
  `NAV_SECTIONS`-only), Settings/skeleton work (UX-08).
- **Acceptance.** Tasks filter UI is one row at 1440 px; every filter works by keyboard and survives a reload via the
  URL; saved views save/apply/remove; the bulk bar floats and works (complete, move, delete + undo); Board/List
  toggle on Tasks; project page tabs, header and *Completed (n)* group; board `[`/`]` move the focused card to the
  adjacent allowed column and keep focus; Archived column hidden by default; no ISO date visible; board at 1440 px
  with seeded data <= 1,200 px tall; no horizontal page scroll at 1440/1024/720/390 in light and dark; axe clean (mu08
  incl. new states); J1-J7, ux02-ux06 and tasks-page pass with selectors changed only where labels legitimately
  changed; `./scripts/verify.sh`, `npm run test:e2e:real`, `npm run e2e` pass.
- **Status: `DONE` (2026-11-03).** As built (ADR-0057): `FilterBar`, `BulkBar`, `MenuButton`, `Popover`, `Tabs`,
  `FoldGroup`, `useSavedFilters`; `Board` gained `archivedToggle`, `[` / `]` and compact cards; `Projects`,
  `ProjectPage`, `Tasks` rewritten on them; pure rules in `lib/taskFilters.ts`, `lib/taskStatus.ts`
  (`adjacentStatus`), `lib/tasks.ts` (`formatDay`). Saved views stayed in the filter bar's "…" menu (the sidebar
  is `NAV_SECTIONS` only). Evidence: `ACCEPTANCE.md` UX-07. Limitations in ADR-0057 and R-26.

### UX-08 plan — Settings consolidation, skeletons, empty states
- **Scope.** (1) **Settings** becomes a two-column page: a section list (Account, Appearance, Notifications and
  reminders, Calendar, Sync, Data and backups, About) and one section at a time, addressed as `/settings/<section>`
  (`/settings` shows Account on a wide screen and the list alone on a phone, where a section is a drill-in with an
  "All settings" back link). `/sync`, `/notifications` and `/calendar` redirect to their section; the sidebar's
  *More* section keeps only Search and Settings, while the palette still offers "Go to Sync / Calendar /
  Notifications / …" (from one `SETTINGS_SECTIONS` table). Rows are "label and description left, control right";
  at most one primary button per section; the Sync, Calendar, Notification, reminder, export, backup and instance
  content and behaviour are reused unchanged. (2) **Skeletons** (a shared `Skeleton` with `role="status"` and
  screen-reader text, token colours, shimmer off under reduced motion) replace the "Loading…" lines on Inbox,
  Today, Upcoming, Week, Tasks, Projects, Board, the project page and the Notes tree. (3) **One `EmptyState`**
  (icon, one line, at most one action) on Inbox, Tasks (no results vs none yet), Projects, Today, Upcoming, Week
  and Notes, replacing the dashed developer-style box. (4) Login and Setup are checked against the design system
  and small inconsistencies fixed.
- **Out of scope.** Backend or data-model changes, new npm packages, the compact-density toggle (UX_AUDIT UX-08
  lists it; no page uses a density token yet), the Day date picker on Today, new settings, AUTH-01 (account
  recovery), a native client.
- **Acceptance.** Every old URL (`/settings`, `/sync`, `/notifications`, `/calendar`) resolves, with a redirect to
  the right section for the last three; the section is in the URL and survives a reload; J7 passes with the new
  section navigation; the Sync and push-consent mocked specs pass against the redirected URLs; no list page shows
  "Loading…" text without a skeleton and no skeleton remains once data is loaded; every empty list has an icon and a
  sentence (action where one makes sense); axe clean in light and dark and no horizontal scroll at 1440/1024/720/390
  on Settings (every section), a skeleton state and the empty states; J1-J7, ux02-ux07, tasks-page and mu08 pass
  with selectors changed only where labels legitimately changed; `./scripts/verify.sh`, `npm run test:e2e:real` and
  `npm run e2e` pass.
- **Status: `DONE` (2026-11-03).** As built (ADR-0058): `lib/settingsSections.ts`, `pages/Settings.tsx` with
  `components/settings/*` (`SettingsRow`, Account, Appearance, Data, About), `SyncSettings` and `CalendarSettings`
  (the former page bodies), `Skeleton`, `EmptyState`; `NAV_SECTIONS` lost Calendar/Sync/Notifications and the
  palette reads `PALETTE_PAGES`. Left out: the compact-density toggle (UX_AUDIT lists it; no density token
  exists). Evidence: `ACCEPTANCE.md` UX-08. Limitations in ADR-0058 and R-27.

---

## SYNC — Local-first sync

**Goal.** Make ADR-0055 buildable: a server protocol that keeps local-first clients convergent without silent loss,
proven by a deterministic multi-client simulation, then (after a spike) the shared sync core and the native
clients. Design, gap analysis and message shapes: [`SYNC_PROTOCOL.md`](SYNC_PROTOCOL.md) (do not duplicate here).
Choices awaiting the owner: ADR-0059 D1–D12. Test strategy: `TESTING.md` §10. Risks: R-28…R-36.

**Rules.** First vertical slice is server-side (SYNC-01…SYNC-03) plus the harness (SYNC-02), before any native shell
work. No client behaviour changes until a client sends `Atlas-Sync: 1`. Each task's evidence goes to `ACCEPTANCE.md`;
none is `DONE` until its tests ran. WIP limit: one task at a time except the spike (SYNC-07), which is hardware-bound.

| ID | Title | Depends on | Status |
|---|---|---|---|
| SYNC-01 | Feed correctness fixes (no protocol change) | — | `DONE` (2026-11-03) |
| SYNC-02 | Simulation harness: model server, fault transport, invariants, conformance vs real server | — (uses current API) | `DONE` (2026-11-03) |
| SYNC-03 | Protocol v1 server: client ids, sync mode, field merge, `include=data`/`types`/snapshot/retention, versioning | SYNC-01, SYNC-02, ADR-0059 D1–D4, D6, D9, D11–D12 | `BACKLOG` (ADR-0059 accepted 2026-11-03; starts after SYNC-01/02) |
| SYNC-04 | Note history and three-way merge, move/delete/revive rules, portable paths | SYNC-03, ADR-0059 D3, D5, D10 | `BACKLOG` (ADR-0059 accepted) |
| SYNC-05 | Resolution log, feed entity and undo | SYNC-03, ADR-0059 D7 | `BACKLOG` (ADR-0059 accepted) |
| SYNC-06 | Device credentials: table, bearer auth, rotation, revoke, Settings → Devices | SYNC-03, ADR-0059 D8; AUTH-01 consumes the revoke function | `BACKLOG` (ADR-0059 accepted) |
| SYNC-07 | Tauri 2 spike (Linux, Windows, Android) and Electron-fallback decision | — (hardware: Windows machine, Android device) | `READY` for Linux; Windows/Android `BLOCKED` on hardware |
| SYNC-08 | `packages/sync-core`: framework-free TS client core (queue, pull/apply, rebase, backoff, conflict states) over a `LocalStore` interface; web IndexedDB adapter keeps M7 behaviour | SYNC-03, SYNC-02 | `BACKLOG` |
| SYNC-09 | Desktop client: Tauri shell, SQLite store, notes-folder engine, keystore, device sign-in | SYNC-04, SYNC-05, SYNC-06, SYNC-07 pass, SYNC-08 | `BACKLOG` |
| SYNC-10 | Android client (or PWA fallback per A-09) with background sync | SYNC-09, SYNC-07 Android pass | `BACKLOG` |
| SYNC-11 | Conflict and "changed on another device" UI (text-conflict resolver, undo, devices list) | SYNC-05, SYNC-08 | `BACKLOG` |
| SYNC-12 | Release gate: real-device matrix, backup/restore with devices attached, docs (USER_GUIDE, OPERATIONS) | SYNC-09, SYNC-11 | `BACKLOG` |

### SYNC-01 — Feed correctness fixes
- **Problem.** (a) `NotesReconciler` changes revisions/tombstones without recording feed changes; (b) a client whose cursor
  is ahead of the server (restore) is told nothing; (c) the one-row-per-entity ordering is claimed monotonic but untested
  under concurrency; (d) the shipped nginx may reject notes above 1 MiB (R-34, unverified).
- **Scope (plan, 2026-11-03).**
  (a) `NotesReconciler.run` records `note` `upsert` (added, updated, revived) and `delete` (removed) through the same
  `ChangeRecorder` the API uses, in the reconcile transaction, only for rows it actually changed (a scan that finds nothing
  records nothing, so repeated scans are idempotent and do not churn the cursor). No schema change, no migration.
  (b) `ChangesService`: `since > head` ⇒ `resync_required=true`, `resync_reason="cursor_ahead"`, `next_since=head`,
  empty `changes`. `below_floor` is reported with `resync_reason="below_floor"`. `ChangesOut.resync_reason` is additive
  (`null` when no resync). `openapi.json`/`schema.d.ts` regenerated; the web engine already stops on `resync_required`.
  The pure decision lives in `atlas.changes.retention` (unit tested).
  (c) Read the ordering mechanism (user-row lock taken by `UPDATE users SET change_seq…`, held to commit), document it in
  `ChangeRecorder`/`SYNC_PROTOCOL.md`, and prove it with `tests/integration/test_change_concurrency.py`: deterministic
  interleavings (writer A holds an allocated cursor, B blocks, reader sees neither; A commits; B proceeds; rollback gives
  no gap) plus an N-writer stress with a concurrent reader asserting no reader ever skips a later-committed change.
  Fix only if the test shows it unsafe.
  (d) Run the shipped `apps/web/nginx.conf` in a throwaway container and POST bodies of 0.5/2/6 MiB; record the result in
  RISKS R-34 and `DEPLOYMENT.md`; do **not** change deploy config in this task (owner decision; proposed one-line fix).
- **Acceptance.** An external edit, add, removal and revival on the server filesystem each appear once in `/api/changes` after
  reconcile; reconcile with no change records nothing (no cursor churn); `since > head` returns the resync signal with
  reason `cursor_ahead`; N parallel mutating transactions of one user (asyncio + real PostgreSQL) yield strictly
  increasing, gap-free, unique cursors and a reader never observes cursor `k+1` committed before `k`; (d) result recorded.
- **Tests.** `tests/integration/test_notes_reconcile.py` (feed assertions), `test_changes_api.py` (cursor ahead, reasons),
  new `test_change_concurrency.py`; unit `test_change_retention.py`; web unit for the engine (`syncEngine.test.ts`).
- **Evidence.** `ACCEPTANCE.md` SYNC-01. **Status** `DONE` (2026-11-03, local; not committed; CI not run).
- **Follow-up found in SYNC-01, fixed in SYNC-03 (below):** `NotesReconciler` tombstoned a removed note without dropping its
  `note_projects` rows or announcing the link removal (`NotesService.delete` does both).

### SYNC-02 — Simulation harness
- **Problem.** There is no multi-client test; M7-06 e2e uses a mocked API. Sync correctness cannot be claimed without one.
- **Language choice (changed from the first sketch, which said TypeScript/vitest).** Python, under
  `services/api/tests/sim/`, run by the existing `pytest` call in `scripts/verify.sh`. Reasons: the conformance half must
  drive the real FastAPI app and PostgreSQL through the existing `httpx` ASGI fixtures (a TS harness would need a second
  process and a bridge); the model server mirrors server semantics and belongs next to the code it models; no new
  dependency. Cost, stated honestly: the model *clients* are a Python model of the intended client protocol (durable queue,
  idempotency keys, cursor + apply), **not** the shipped TypeScript (`offlineQueue.ts` is unused by the app, see
  `SYNC_PROTOCOL.md` §2). SYNC-08 (`packages/sync-core`) must therefore add a TS adapter that runs the same scenarios and
  invariants against the real core; the scenario/trace format is JSON-serialisable for that.
- **Scope (plan, 2026-11-03).** Discrete-event simulation with a virtual clock and one seeded PRNG: N model clients (durable
  op queue with idempotency keys persisted before the first send, mirror of server state, cursor committed with the applied
  page, one request in flight, backoff with jitter, full resync on `resync_required`), a fault-injecting network (drop
  request, drop response after the server applied, duplicate, delay and so reorder, timeout, 5xx, offline periods, client
  restart losing volatile state at any step incl. mid-pull, per-client clock skew sent as `X-Client-Time`), and two server
  ports behind one interface: an in-memory **model server** of today's task/project/feed/idempotency semantics and the **real
  API** (ASGI test client + PostgreSQL). Invariants: convergence, no lost acknowledged write, no duplicate on retry, no
  resurrection, cursor safety, clock independence (same seed, different skew, identical final state), idempotence of an extra
  pull+push, bounded quiescence, revision-identifies-state. Planted-bug checks mutate model server/client (one flag each)
  and assert that the named invariant fails. Conformance: identical sequential traces (create/patch/delete/restore with
  keys, replays, key reuse, stale base revision, feed paging, cursor ahead) against model and real, responses compared;
  plus a real-server concurrency test.
- **Acceptance.** `pytest` runs the model simulation (default 100 seeds), the real-API simulation (default 3 seeds) and the
  conformance suite in the existing verify run without a noticeable increase (< 60 s added); env `ATLAS_SIM_SEEDS`,
  `ATLAS_SIM_REAL_SEEDS`, `ATLAS_SIM_STEPS` raise them (soak); every failure message carries `seed=` and reproduces by
  `ATLAS_SIM_SEED=<n>`; each planted bug (cursor advanced before apply, key regenerated on retry, idempotency ignored,
  tombstone ignored, resurrect on stale patch, acked-but-dropped write, feed row skipped, cursor skip, client clock used for
  ordering) is a test that fails the named invariant; ≥ 20 real-API seeds are run once as a soak and recorded.
- **Tests.** `tests/sim/test_sim_model.py`, `test_sim_planted_bugs.py`, `test_sim_real.py`, `test_sim_conformance.py`, harness
  self-tests. **Evidence.** `ACCEPTANCE.md` SYNC-02. **Status** `DONE` (2026-11-03, local, with the stated deviations: Python not TS; default 100 model / 3 real seeds, the 200/20 figures are soak runs).
- **Found:** R-37 (lost update on concurrent PATCH, `xfail(strict)` test). Fixed at the start of SYNC-03, see below.

### SYNC-03 … SYNC-06
Scope, acceptance and tests follow `SYNC_PROTOCOL.md` §3–§10; each task gets its own plan section here when it becomes
`READY` (after ADR-0059). Minimum acceptance common to all: the simulation scenarios named in `TESTING.md` §10.3 for that
feature pass on the model and on the real API; old non-sync-mode behaviour is unchanged (existing suites untouched and green);
migrations tested up/down on a clean DB and a populated one; `alembic check` clean.
- **SYNC-03 pre-work, `DONE` locally 2026-11-03 (not committed, CI not run; evidence `ACCEPTANCE.md` SYNC-03 pre-work):**
  (1) R-37: row lock (`SELECT ... FOR UPDATE`) before the `base_revision` check on task/project `PATCH` and note `PUT`
  (and on delete/restore/rename, which also bump revisions); lock order entity rows then change cursor, bulk task locks in `id`
  order; `xfail` removed; (2) R-34: `client_max_body_size 11m` for `/api/` in `apps/web/nginx.conf`, with a static and a live
  container test; (3) `NotesReconciler` removal shares `NotesService.tombstone_index/announce_removal` with `delete` (project
  links dropped and announced, wiki-link targets cleared, task links kept), announcements recorded after all row changes
  (lock order). **Moved out of scope of the remaining SYNC-03 list:** R-37, R-34 and the reconcile link-drop. Also fixed from this work: the
  task-into-deleted-project race (project share lock before task lock, R-37), nginx 11m for JSON-escaped notes (R-34),
  and model-sim seed 482 (client rule: an acknowledgement is a historical snapshot).
  **Remaining SYNC-03 scope:** `field_revisions` backfill; `Atlas-Sync` header; `426`; `include=data`, `types=`, snapshot, tombstone-only purge,
  idempotency-key TTL job; `GET /api/instance` sync block; the task feed `GET /api/tasks/changes` marked deprecated.
- **SYNC-04** also: nginx/compose body limit for 5 MiB notes verified; merge library licence/maintenance check recorded in
  `DEPENDENCIES.md`; history included in backup and export sets (ADR-0041/0042 amended).
- **SYNC-06** also: Settings → Devices; rate limit keyed by device; token never in logs/OpenAPI examples; revocation tested.

### SYNC-07 plan — Tauri 2 spike (throwaway code, in a scratch directory, not in the repo tree)
Versions looked up on 2026-11-03 (GitHub releases API): `tauri` 2.12.5 (2026-10-21), `tauri-cli` 2.12.4, plugin `sql` 2.6.0
(2026-10-14), `notification` 2.8.0, `updater` 2.14.1, `deep-link` 2.6.3 (2026-10-28); `sql`, `store`, `stronghold`, `single-instance`
also have `3.0.0-alpha.3` (2026-10-14): **pin 2.x, do not adopt alphas**. Licences (Apache-2.0/MIT) are **[UNVERIFIED]**:
read each `LICENSE` at the pinned tag and record in `DEPENDENCIES.md` (AGENTS.md §14). Docs consulted: fs plugin (watch needs
the `watch` Cargo feature; fs access is scope-limited; on Android only the app folder by default, external-storage
permissions otherwise; no mention of SAF/content URIs), updater (desktop only; signature mandatory; only AppImage named for
Linux), stronghold (IOTA engine; no OS-keystore plugin listed). Everything else below is **[UNVERIFIED]** until run.

Common setup: build the existing `apps/web` bundle unchanged inside a minimal Tauri 2 shell; no Atlas code changes. Record
OS, webview version (WebKitGTK / WebView2 / Android System WebView), and exact tool versions in the evidence.

| # | Check | PASS criterion | FAIL → |
|---|---|---|---|
| S1 | Render existing UI (Linux WebKitGTK, Windows WebView2, Android WebView) | `npm run test:e2e:real` journeys J1–J7 adapted to run against the shell (Playwright where possible, otherwise manual script) pass; CodeMirror 6 Live mode: caret, selection, IME composition, undo, 5 000-line note typing latency p95 < 50 ms; the axe sweep has no new violations; no CSS feature missing in the oldest supported webview (record which) | Electron fallback for that platform if a core-editing defect cannot be fixed in CSS/JS within 2 days |
| S2 | SQLite | `tauri-plugin-sql` 2.6.0 (or `rusqlite` behind our own commands if the plugin cannot do explicit transactions) opens a WAL database; 50 000 rows insert + indexed query < 1 s; **a transaction spanning "apply page + store cursor" commits atomically and rolls back on a forced kill (kill -9 at 100 random points, 0 inconsistent states)**; migrations run forward | No transactional guarantee ⇒ own Rust commands; if impossible ⇒ fail |
| S3 | Notes folder | user picks a folder (dialog plugin), scope granted at runtime; 2 000 `.md` files scanned < 2 s (size+mtime) ; watcher reports external create/modify/delete/rename from VS Code, Obsidian, vim and `git checkout` within 2 s on Linux and Windows, **and a scan finds every change the watcher missed** (watch is a hint); atomic write (temp+rename) does not trigger a loop; works with the folder under OneDrive/Dropbox on Windows (record behaviour) | Watcher unreliable but scan correct ⇒ PASS with scan-only cadence documented; scan wrong ⇒ FAIL |
| S4 | Keystore | token stored/read/deleted via Windows Credential Manager, Linux Secret Service (GNOME Keyring and KWallet) and Android Keystore; not readable from the webview; behaviour with no Secret Service running is defined (refuse, never fall back to a file silently). Candidate: Rust `keyring` crate (licence **UNVERIFIED**); Android needs a custom plugin | No safe store on a platform ⇒ that platform cannot sign in; blocks SYNC-06 client |
| S5 | Notifications | a local notification fires at a scheduled time with the app closed on Windows and Linux; Android: scheduled local notification fires with the app swiped away and in Doze (record delay); tapping opens the task | Android cannot ⇒ reminders need the existing Web Push/PWA path (A-09) |
| S6 | Auto-update | Windows per-user (NSIS `currentUser`, no admin) installs and updates over HTTPS from the self-hosted server with a signed update; Linux AppImage updates; `.deb` behaviour recorded; update signature failure refuses; rollback story written | Needs admin on the work laptop ⇒ portable/zip + manual update, or Electron |
| S7 | Windows install without admin | installer runs as a standard user; WebView2 present or bootstrappable without admin on the target laptop (policy-dependent, **ask the owner to test on the work laptop**) | Not installable ⇒ desktop work client dropped from scope, record |
| S8 | Android background sync | a periodic job (WorkManager via a small Kotlin plugin) runs a pull within the documented ≥ 15 min cadence while the app is closed, survives reboot, honours battery optimisation; foreground sync on open < 3 s for 1 000 changes | Cannot run ⇒ sync only while open + push notification wake (needs FCM; ADR-0007 cost/dependency review) or PWA fallback |
| S9 | Size/footprint | installer size, idle RAM after 10 min with 5 000 notes indexed (Windows, Linux), cold start < 2 s | informational; > 300 MB idle RAM or > 5 s start ⇒ review |
| S10 | Security posture | capability file grants only the commands used; CSP kept strict; webview cannot call arbitrary fs/shell; `cargo audit`/`npm audit` clean at the pin; maintenance check: last release < 60 days (met: 2026-10-21) and open security advisories read | Any unmitigated advisory ⇒ FAIL until pinned past it |

**Electron fallback criteria (desktop only; Electron has no Android).** Choose Electron for a desktop platform if any of:
S1 fails on that platform for core editing; S2 cannot be made transactional; S6/S7 make Tauri unusable for the owner's
work laptop; S10 shows an unfixable advisory or the project stops releasing for > 90 days. Android then falls back to
the PWA (A-09) or to a separately evaluated shell (not assessed here). A mixed result (Tauri on Linux, Electron on
Windows) is rejected: two shells double the platform bugs.

**Needs real hardware, not available in this environment:** Windows machine (ideally the work laptop), an Android device
(two OS versions if possible), and for S8 a device with an aggressive vendor battery manager.

---

## Immediate Next Tasks

**Owner priority order (2026-11-03): 1. Sync (local-first, ADR-0055), 2. Auth (AUTH-01 plus device credentials for sync clients), 3. Calendar (M5-00 onward), 4. Core (close MU: CI run of `e2e-real` + release re-score). UX-01…UX-08 are all `DONE`. The Sync design and backlog are done (2026-11-03, see the SYNC section, `SYNC_PROTOCOL.md`, ADR-0059 PROPOSED). **Next: SYNC-01 (feed correctness fixes) then SYNC-02 (simulation harness); SYNC-07 (Tauri spike, Linux first) can run alongside; SYNC-03…06 wait for the owner's answers to ADR-0059. AUTH-01 stays `BACKLOG` and meets SYNC-06 at the shared device-revoke function (ADR-0059 D8).** Milestone MU (usable core): `MU-00` (real-stack journey harness), `MU-01` (task detail and
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
| A-09 | Decide mobile strategy: PWA-only v1 vs native Android/iOS (M8-06/07) | `BLOCKED` | Direction set in ADR-0055 (Android via Tauri 2, PWA fallback, iOS out of scope); final choice after the spike |

**Caveats recorded by the audit.**
- M7 and M9 are `DONE` for their buildable scope; M7 sync has not been exercised against real
  calendar data, which depends on M5-00.
- `ATLAS_ENV` defaults to `development`, which accepts the placeholder secrets. Production hardening
  applies only when `ATLAS_ENV=production`; operators must set it (see `DEPLOYMENT.md`).
