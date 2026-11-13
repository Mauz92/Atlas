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
| M5 | Unified read-only calendar | `IN_PROGRESS` | **Re-scoped (ADR-0076, 2026-11-13): ICS-fed events shown read-only and correctly; Google/Microsoft live sync deferred to Later.** Original gate: real calendar data synced safely (no writes) |
| M6 | Bidirectional calendar sync | `BACKLOG` | **DEFERRED to Later (ADR-0076).** External event editing reliable for daily use |
| M7 | Cross-device sync and offline | `DONE` | Sync recoverable under realistic failure ✔ (verified 2026-10-27) |
| M8 | Notifications and mobile apps | `IN_PROGRESS` | Platform behaviour tested on real devices |
| M9 | Security, recovery, release | `IN_PROGRESS` | Production-readiness review |
| **MU** | **Usable core — personal-OS UX** (ADR-0043) | `DONE` (2026-11-13) | Owner journeys J1–J7 pass in a browser against the real API **and in CI** (run 43420687967); every sidebar item is a working screen; the release re-score is recorded in `ACCEPTANCE.md` (confirmed by the owner 2026-11-13) |
| **UX** | **Design system and app shell** (ADR-0051, `UX_AUDIT.md`) | `DONE` (local PASS; CI `e2e-real` NOT RUN) | UX-01…UX-03 `DONE` 2026-11-02, UX-04…UX-08 `DONE` 2026-11-03; J1–J7 and the axe sweep pass on the finished UI. The separate `AUTH-01` row (account recovery) was `BACKLOG` at this exit and is `DONE` since 2026-11-04 |
| **SYNC** | **Local-first sync** (ADR-0055, ADR-0059 ACCEPTED, `SYNC_PROTOCOL.md`) | `IN_PROGRESS` (SYNC-01…SYNC-06 `DONE` locally 2026-11-03: server protocol v1 for tasks, projects and notes incl. history/merge, the resolution log with undo and per-device bearer credentials; next SYNC-07 Tauri spike / SYNC-08 `sync-core`) | Worked **first** (owner priority order). Server protocol + deterministic multi-client simulation pass before any native-shell task; Tauri spike verdict before SYNC-09/10 |

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
| M5-00 | Validate MS tenant + Google publishing mode with real accounts | M1-05 | Refresh tokens persist; scopes granted; limitations noted | Manual + recorded evidence | DEFERRED to Later (ADR-0076, owner 2026-11-13): `BLOCKED on live verification` — runbook + evidence template written (`CALENDAR_SYNC.md` §12.7); the owner runs it with their real accounts (2026-11-10 decision: real Google account manually, never in tests) |
| M5-01 | OAuth credential store (encrypted) | M1-05 | Tokens encrypted at rest; key external | Unit + integration | `DONE` |
| M5-02 | Provider adapter interface | M5-01 | Common interface; no provider leakage | Unit | `DONE` |
| M5-03 | Google Calendar adapter (read, syncToken) | M5-02 | Pagination, incremental, deletions handled | Adapter tests | DEFERRED to Later (ADR-0076, owner 2026-11-13): `IN_REVIEW` (built + fixture-tested 2026-11-10; **live compatibility UNVERIFIED**, not `DONE` until M5-00 evidence) |
| M5-04 | Microsoft Graph adapter (read, delta) | M5-02 | Pagination, delta, deletions handled | Adapter tests | DEFERRED to Later (ADR-0076, owner 2026-11-13): `IN_REVIEW` (built + fixture-tested; **live compatibility UNVERIFIED**) |
| M5-05 | Calendar/account selection UI | M5-03,M5-04 | Select calendars; colour; connect/disconnect | Frontend + E2E | Provider-account half DEFERRED (ADR-0076); ICS source selection stays: `IN_REVIEW` (UI, OAuth flow and E2E against the fake provider pass; real OAuth consent screens UNVERIFIED) |
| M5-06 | Event projection store + sync cursors | M5-02,M1-08 | Cursor advances only after commit | Integration | `DONE` |
| M5-07 | Unified calendar view (day/week/month) | M5-05 | Time-zone-correct display; all-day + recurring | Frontend + E2E | Over ICS-fed events (provider data deferred, ADR-0076): `IN_REVIEW` (Day/Week/Month/Agenda, Today and Week integration; real-provider data UNVERIFIED) |
| M5-08 | Sync status + error surface | M5-06 | Last sync, failures visible in UI | Integration + E2E | `DONE` |
| M5-09 | Change notifications (hints → reconcile) | M5-03,M5-04 | Notification triggers reconcile; never trusted as full log | Integration | DEFERRED to Later (ADR-0076, owner 2026-11-13): `BACKLOG` |
| M5-10 | Periodic reconciliation fallback | M5-06 | Missed notifications recovered by scan | Integration | `DONE` (wired to the real adapters and ICS feeds by Stage A, 2026-11-10) |
| M5-11 | ICS feed adapter (Proton and others) | M5-02,M5-06,M5-10 | Secret feed URL (sealed, masked), SSRF-guarded fetch, conditional GET, RRULE/EXDATE/RECURRENCE-ID, deletions by diffing, malformed feeds never crash | Unit + integration + E2E (fixture host) | `IN_REVIEW` (fixture-tested; a real Proton link UNVERIFIED) |
| M5-12 | Manual `.ics` file import | M5-11 | Upload an `.ics`, check it, import as a read-only calendar, replace, remove; 5 MiB limit; nothing fetched | Integration (9) + frontend (3) + real-stack E2E | `DONE` (2026-11-13; ADR-0076 D4; `ACCEPTANCE.md` M5-12) |

**Stage A plan and status (2026-11-10, ADR-0071/0072).** Owner decisions: the real Google account is connected
*manually* (never in automated tests), Microsoft Outlook is supported, the ProtonMail calendar syncs through its
"Share via link" ICS feed, and the redirect URIs derive from `PUBLIC_BASE_URL` (owner setup:
`https://galaxia-atlas.duckdns.org:9443`, tailnet-only until SEC-01). Built in verified sub-steps, **all read-only**:

| Step | Content | Acceptance (all `PASS` against fixtures; see `ACCEPTANCE.md` "Calendar Stage A") |
|---|---|---|
| A1 | Migration `a6c3e9d27b14` (sources, OAuth state, event detail columns), config, snapshot semantics in the sync core | migration clean + representative + downgrade tests; cursor-safety fault injection |
| A2 | OAuth (code + PKCE, session-bound single-use state), token refresh/rotation, revoke, disconnect, "not configured" | OAuth API tests incl. replay, other session, expiry, scopes, no-token-in-logs |
| A3 | Google and Microsoft adapters (M5-03/04) on documented shapes; fake provider server | adapter tests: paging, incremental, 410, deletions, recurrence, all-day, zones, 429/Retry-After, 401 refresh |
| A4 | ICS adapter (M5-11): SSRF guard, parser, recurrence expansion, feeds API | SSRF matrix, parser fixtures, property tests (DST/all-day), feed API tests |
| A5 | Events API, reconcile/jobs, status, `atlas-admin calendar-status` | window/pagination/user-scope tests, scan tests |
| A6 | Frontend (Settings cards, Calendar page, Today/Week) + real-stack E2E with the fake provider | vitest, `e2e-real` incl. axe (both themes, 360/390/768/1440), no sideways scroll |
| A7 | Docs and the live-check runbook | `CALENDAR_SYNC.md` §11-12 |

**Not `DONE` on purpose:** M5-00/03/04/05/07/11 stay `IN_REVIEW`/blocked on live verification until the owner runs
`CALENDAR_SYNC.md` §12.7 (AGENTS.md §10: mocks are not provider-compatibility evidence). M5-09 (webhooks) stays
`BACKLOG`: it needs a public endpoint and Atlas is private (SEC-01). M6 (writes) is untouched.

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
| M6-01 | Create events via provider (Atlas-owned) | M5-06 | Created in provider; projection updated with returned id | Integration (real account) | DEFERRED to Later (ADR-0076, owner 2026-11-13): `BACKLOG` |
| M6-02 | Update events via provider | M6-01 | Update reflected in provider; version stored | Integration | DEFERRED to Later (ADR-0076, owner 2026-11-13): `BACKLOG` |
| M6-03 | External deletion propagation | M5-06 | Provider deletion removes/marks projection | Integration | DEFERRED to Later (ADR-0076, owner 2026-11-13): `BACKLOG` |
| M6-04 | Conflict detection + resolution UI | M6-02 | Conflicts preserved and surfaced | Integration + E2E | DEFERRED to Later (ADR-0076, owner 2026-11-13): `BACKLOG` |
| M6-05 | Retry/backoff + idempotency for writes | M1-08,M6-01 | No duplicate events on retry | Integration | DEFERRED to Later (ADR-0076, owner 2026-11-13): `BACKLOG` |
| M6-06 | Expired/revoked token recovery | M5-01 | Re-auth flow; no data loss | Integration | DEFERRED to Later (ADR-0076, owner 2026-11-13): `BACKLOG` |
| M6-07 | Feedback-loop prevention | M6-02 | Local echo does not re-trigger writes | Integration | DEFERRED to Later (ADR-0076, owner 2026-11-13): `BACKLOG` |
| M6-08 | Bidirectional E2E per provider | M6-01…07 | Both directions, deletions, recurring, conflicts | E2E (real accounts) | DEFERRED to Later (ADR-0076, owner 2026-11-13): `BACKLOG` |

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
- Core tasks work on Android. ⛔ `NOT RUN` — M8-06 (= SYNC-10 + M8-04d) needs a real device. **Amended by the owner 2026-11-04 (ADR-0068 Q9): iOS is out of scope (M8-07 cancelled); the gate no longer names iOS.**
- Desktop verified on Linux/Windows. ⛔ `NOT RUN` — M8-08 (Tauri client, through M8-04g) needs the two platforms. **Amended 2026-11-04 (Q9): macOS is out of scope.**

**Tasks**

| ID | Title | Depends on | Acceptance | Tests | Status |
|---|---|---|---|---|---|
| M8-01 | Reminder scheduler (durable) | M1-08,M3-05 | Reminders fire once; cancelled entities skipped | Integration | `DONE` |
| M8-02 | Web Push (VAPID) desktop | M8-01,M8-03 | Notification delivered; permission handled | E2E | `DONE` |
| M8-03 | Device token registry + invalidation | M8-01 | Invalid tokens pruned | Integration | `DONE` |
| M8-04 | ~~Push delivery (FCM/APNs or Expo relay)~~ **Replaced 2026-11-04** by M8-04a to M8-04g below (owner decision: local scheduling + opt-in self-hosted UnifiedPush hint; FCM rejected by default; ADR-0068 PROPOSED) | M8-03 | see the M8-04 plan | see below | `BACKLOG` (split) |
| M8-05 | Notification preferences UI | M8-01 | Per-entity timing configurable | Frontend | `DONE` |
| M8-06 | ~~Android client (Expo)~~ **Re-scoped (ADR-0068 D10, ADR-0075):** = SYNC-10 (Tauri 2 Android, ADR-0055) + M8-04d + M8-04g; Expo is not used | SYNC-10 | Core task workflows work | Device E2E | `DONE` with recorded limitations (owner sign-off 2026-11-13; see `ACCEPTANCE.md` SYNC-10) (the Android app exists and passes the phone e2e; the M8-04g matrix and the REQ-011 re-score are still open) |
| M8-07 | iOS client (Expo) | — | **Out of scope** (ADR-0055); the M8 exit criterion that names iOS needs the owner's amendment (ADR-0068 Q9) | — | `BACKLOG` (out of scope) |
| M8-08 | Desktop verify Linux/Windows/macOS | M8-02 | PWA works on all three. **Proposed re-scope (ADR-0068 D10):** the Tauri desktop client on Linux and Windows (macOS not planned), verified through M8-04g | Manual | `BACKLOG` |

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

### M8-04 plan — device-local reminders plus an optional sync hint (design 2026-11-04; ADR-0068 ACCEPTED 2026-11-04; M8-04a, M8-04b (core) and M8-04e implemented 2026-11-09, the rest below is not)

**Goal.** REQ-011 on the native clients: Android and desktop show the owner's reminders without the web app and without FCM/Google, and a self-hosted gateway can wake the Android app to sync. Design, gap analysis
(G1-G14), protocol and security: `SYNC_PROTOCOL.md` section 14 (the single source; not repeated here). Decisions and open questions Q1-Q9: ADR-0068. Tests: `TESTING.md` section 12. Evidence plan: `ACCEPTANCE.md` REQ-011 (M8-04). Risks R-59, R-63 to R-67.
**Order and rules.** Server and core work first (needs no native shell, no hardware): **M8-04a -> M8-04b -> M8-04e**; then the native tasks, which are blocked: **M8-04c** (SYNC-09), **M8-04d** (SYNC-10 and an Android device), **M8-04g** (hardware). M8-04f has a web half (after 04a/04e) and a native half (with 04c/04d).
WIP: one task at a time; every task needs its tests before `DONE`; any unmeasured platform behaviour stays `NOT RUN`. No task starts before the owner has answered Q1 (04a), Q6 (04a sub-step), Q7 (04a/04b), Q8 (04e).

| ID | Title | Depends on | Status |
|---|---|---|---|
| M8-04a | `reminder` feed entity, the reminder actions endpoint, home time zone (Q6) and the `sent` fix (server + Settings field) | SYNC-03, M8-01, M8-05; ADR-0068 accepted | `DONE` 2026-11-09 locally (evidence `ACCEPTANCE.md` M8-04a; CI not run) |
| M8-04b | `packages/reminder-core`: device Scheduler with simulated clock and multi-device simulation | M8-04a | `DONE` 2026-11-09 locally (core only; evidence `ACCEPTANCE.md` M8-04b) |
| M8-04b-ii | (split from 04b) sync-core support: consume `reminder` (`types=`, `types_synced` backfill G7), local overlay for task edits (`dirty`), queued action operation keyed by `action_id`, the `delivered()`/`dirty` obligations of the Scheduler ports; extend the SYNC-02 model server and conformance; **plus R-68: optional clamped `acted_at`** | M8-04b, SYNC-08 | `DONE` 2026-11-10 locally for the TypeScript scope (evidence `ACCEPTANCE.md` M8-04b-ii; CI not run). Not done: extension of the Python simulations (`services/api/tests/sim`), recorded in RISKS |
| M8-04e | Server sync hints: `GET /api/sync/wait`, `device_hints`, emitter job, `HintGateway` + ntfy adapter, config, operator guide | SYNC-06 (04a only for the optional reminder-time hint) | `DONE` 2026-11-09 locally for the server scope; 04e-v partly answered (ntfy 2.37.2 delivers the body unencrypted and the ACL hardening was verified on loopback; the Android distributor/UnifiedPush test app remains `NOT RUN`, M8-04g). Evidence `ACCEPTANCE.md` M8-04e |
| M8-04c | Desktop (Windows, Linux): tray, close-to-tray, autostart, live long-poll, Scheduler adapter, "Due now" panel | M8-04b, M8-04e (wait endpoint), **SYNC-09** | **Linux half `IN_REVIEW` (2026-11-10, local, via SYNC-09d):** tray + close-to-tray, opt-in autostart, live long-poll, desktop `NotificationPort`, scheduler tick/clock-jump, single instance, per-device settings, a reminder fired from a synced reminder in the real app. **Not done:** "Due now" panel and tray snooze/complete, the 30-minute hidden-window lateness run, sleep/resume, reboot persistence, **all of Windows** (R-36, R-71) |
| M8-04d | Android: local alarms, permissions, receivers, battery status, UnifiedPush connector | M8-04b, M8-04e, **SYNC-10**, an Android device | `DONE` with recorded limitations (owner sign-off 2026-11-13; see `ACCEPTANCE.md` SYNC-10) (2026-11-12, local, one phone: OnePlus 8T, Android 14): alarms (`setAlarmClock`, 0.6 s late, also in forced Doze, process killed), delivery log, boot/update re-arm receiver, notification permission, exact-alarm and battery status with shortcuts, tap-to-open, all in `plugins/atlas-android` and the e2e run (ADR-0075 D5). **Not built:** the UnifiedPush connector (D7); **not run:** a real reboot, a second Android version, a second vendor |
| M8-04f | Settings UI: web (hint status, test) and native (per-device notification section, test notification, permissions, diagnostics) | web half: M8-04a, M8-04e; native half: M8-04c/d | web half `DONE` locally 2026-11-10 as SYNC-11b (browser: permission, local test notification; desktop shell: live connection, last hint, gateway status; the Android-only hint registration is not shown in a browser); native half `BLOCKED` on M8-04c/d |
| M8-04g | Real-device verification matrix and the REQ-011 re-score | M8-04c, M8-04d, M8-04e | `DONE` for the 0.1.0 scope (2026-11-13): Linux desktop, OnePlus 8T (Android 14) and an Android 15 emulator, results in `ACCEPTANCE.md` SYNC-10/SYNC-12; REQ-011 re-scored (proposed). Windows and a second vendor are not part of 0.1.0 |

**M8-04a — `reminder` feed entity and actions endpoint.** *(DONE 2026-11-09. Refinements made in place: the entity also carries `effective_at` and `server_delivered_at`; the legacy and `types`-less feeds hide the type like `resolution`; `dismiss` stores `max(now, effective_at)`; snooze presets include `tomorrow_morning` (Q7, server-computed); `base_revision` ahead is `409 revision_ahead`, behind is flagged `stale`; the per-device **home time zone** (04a-ii) is `GET/PUT /api/notifications/time-zone` plus a Settings field and a first-sign-in default; the migration backfills the feed and `scan_reminders` re-announces missing rows idempotently.)*
*Problem.* Devices cannot know when a task reminds (G1, G4, G6, G7). *Scope.* Migration (reversible, additive): `reminders.revision int default 1`, `snoozed_until`, `acknowledged_at` (nullable); `ChangeRecorder` calls in `sync_task`, `cancel_for_task`, `scan_reminders`, the preference reschedule path and `deliver_reminder`
**only when a value changed** (`state`, `remind_at`, `snoozed_until`, `acknowledged_at`); `reminder` in `changes/data.py` (`include=data`) and in `instance.sync.entities` (schema 1); `state` derivation (`armed|cancelled`, never `sent`); `POST /api/reminders/{id}/actions` (14.5) open to devices
(exact-set test updated on purpose), `Idempotency-Key` + stored result, user-scoped, other user's id is `404`; `GET /api/reminders?state=armed` for the web diagnostics. Sub-step 04a-ii (needs Q6): `preferences.time_zone` used when `tasks.time_zone` is NULL. *Out of scope:* policies in the feed, hints, any client.
*Acceptance.* A task with a due date and a policy/default yields one `reminder` upsert in the feed with the same `remind_at` the delivery job uses; editing due date/zone/policy/status changes it in the same transaction and a scan with no change records nothing (cursor does not move); `sent` is never exposed; completion, archive and delete produce `cancelled`;
a snooze/dismiss replay (same `action_id`) returns the stored result and does not bump the revision twice; later action wins; a snooze after a dismiss re-arms; another user's reminder is `404`; a device token can call the actions endpoint and nothing else new; `types=task` clients are unaffected.
*Tests.* Unit (state derivation, action rules); integration against PostgreSQL (feed assertions for each trigger, idempotent scan, cross-user, concurrency of two actions with the cursor lock as in `test_change_concurrency.py`); extend the SYNC-02 model server (`tests/sim/model*.py`) and conformance with the entity; migration clean/populated/downgrade; OpenAPI/`schema.d.ts` regenerated. *Evidence:* `ACCEPTANCE.md` M8-04a.

**M8-04b — device Scheduler core.** *(DONE 2026-11-09 for `packages/reminder-core` and its simulation; the sync-core half moved to **M8-04b-ii**. Added during the build: `NotificationPort.delivered()`, the `dirty` task flag, a `key` field on notifications, `ActionSink`/`ReminderSource.pendingActionIds`; vitest project `reminder-core`, eslint, tsconfig wired without touching `scripts/verify.sh`.)*
*Problem.* No code decides what to arm, fire, cancel or deduplicate on a device (14.4). *Scope.* New `packages/reminder-core` (wired into vitest/eslint/tsc like sync-core; a `framework-free` test): ports, `reconcile`, `tick`, `onAction`, `onClockChange`, `onBoot`, `testNotification`, fired-set, horizon and cap, catch-up/missed list, burst grouping, quiet hours, `contentMode`, in-memory fakes for all ports and a **simulated OS** (`FakeOsScheduler` with alarm firing, reboot clearing, force-stop, inexact delay, a permission switch).
sync-core: consume `reminder` (`types=`, **`types_synced` backfill**, G7), local overlay for task edits that cancel alarms (14.2 rule 2), a queued **action operation** with the idempotency key = `action_id` and the optimistic snooze. *Out of scope:* any Tauri/Kotlin code, UI.
*Acceptance.* The scenarios of `TESTING.md` 12.2 pass on a fake clock: one notification per key across restarts/reboots/updates/duplicate reconciles; DST gap and overlap instants fire at the server-computed instant; zone change of the device changes nothing; clock jump forward/back; offline completion cancels; offline re-date cancels until sync; recurrence next occurrence appears after sync; two simulated devices: both fire, dismiss on one clears the other after its sync; snooze round trip incl. a lost response and a replay; horizon/cap; burst grouping; permission denied then granted catches up; no `Date.now()`/`setTimeout` outside the ports.
*Tests.* Vitest unit + property tests (random edit/clock/reboot sequences against an oracle: "fired exactly once per key, never for a cancelled reminder, never after being acknowledged"), plus the multi-client simulation extended with a reminder-aware client and a planted-defect check (e.g. writing the fired key after showing must fail a named test). *Evidence:* `ACCEPTANCE.md` M8-04b.

**M8-04e — server sync hints and the UnifiedPush adapter.** *(DONE 2026-11-09, server scope. Decisions: no private-range blocking because the origin is operator-pinned (LAN/tailnet gateways work); `http` needs `SYNC_HINT_ALLOW_INSECURE_HTTP` or loopback outside production; the endpoint is encrypted at rest; coalescing key includes the writer; breaker process-local; `httpx` moved to runtime dependencies. The nginx `/api/` location now states `proxy_read_timeout 75s`.)*
*Problem.* Cross-device changes arrive only on the next sync; the running desktop and a backgrounded phone cannot be told (G9, G10). *Scope.* 04e-i `GET /api/sync/wait` (14.7) and the nginx check (no proxy change needed, verified against the shipped `nginx.conf`; record the 60 s default); 04e-ii `device_hints`, `PUT/GET/DELETE /api/devices/current/hint`, `POST .../test`, purge/cascade, masking, no logging of endpoints; 04e-iii `atlas/hints` (`HintGateway`, `NtfyGateway`, origin pinning, SSRF rules), the coalesced `sync.hint` job, the optional reminder-time hint, retries, circuit breaker, status; 04e-iv settings (env, Compose, `.env.example`, `test_compose_env.py`), `DEPLOYMENT.md`/`OPERATOR_GUIDE.md` section for a self-hosted ntfy with the ACL hardening;
04e-v **first step before building the adapter**: a throwaway ntfy container and the UnifiedPush test app on the owner's approval to answer the plain-vs-encrypted question (14.8) and the licence/maintenance check (`DEPENDENCIES.md`). *Out of scope:* the Android receiver (04d), any FCM code, any change to the owner's dev stack.
*Acceptance.* The wait endpoint returns within the timeout, immediately when behind, enforces auth/revocation/limits/versioning; a hint job is enqueued once per 30 s bucket per user and never to the writing device; the payload is byte-identical for every event (a test compares payloads from a task edit, a note edit and a reminder); a destination whose origin/path is not the configured one is `422` (SSRF cases: other host, other port, userinfo, redirect, `http`, path traversal, IPv6/IP-literal, DNS name resolving elsewhere is irrelevant because only the configured origin is accepted); unreachable gateway: bounded retries, circuit open, no impact on the request that caused the change or on reminder delivery; `404/410` disables the destination; revoking a device deletes its hint row; no endpoint or token in logs/errors/exports (log-capture test like T24); the feature is inert when `SYNC_HINT_ENABLED=false`.
*Tests.* Unit (payload, origin validation table, backoff, breaker); integration with PostgreSQL and a local fake gateway (an in-process HTTP server that records and can fail, delay, redirect, 410); concurrency of the coalescing key; optional integration against a real ntfy container (`NOT RUN` unless approved). *Evidence:* `ACCEPTANCE.md` M8-04e.

**M8-04c — desktop resident client** (`BLOCKED` on SYNC-09). *Scope:* tray + close-to-tray, `tauri-plugin-autostart` (AppImage path check), single-instance interplay, Rust 30 s tick event, clock-jump/resume detection, long-poll loop with backoff, the `NotificationPort` over `tauri-plugin-notification` 2.8.0 (`show` only; permission handling incl. the ACL finding of X2), "Due now" panel and tray snooze/complete, quit semantics ("Quit" really quits; a notice that reminders stop). *Acceptance:* with the app resident (window hidden) a reminder fires within 60 s of `effective_at` for 30 minutes on Windows (WebView2) and Linux (WebKitGTK) (throttling measured), after sleep/resume catch-up works, autostart survives a reboot as a standard user without admin, a second launch focuses the first, with the server stopped the app still fires armed reminders. *Tests:* Rust unit tests for the tick/jump logic, Vitest for the adapter against the fake `invoke`, manual matrix in M8-04g.
**M8-04d — Android** (`BLOCKED`). *Scope:* manifest permissions, `POST_NOTIFICATIONS` flow, exact-alarm check and grant intent, channel `atlas-reminders-v1`, receivers (`MY_PACKAGE_REPLACED`, time, zone, exact-alarm-state), reconcile against `listPending`, battery-optimisation status/link, action buttons (verify the no-UI behaviour), UnifiedPush connector receiver + registration flow, headless-sync decision (G12) with SYNC-10. *Acceptance:* S5 of 13.4 plus: fires with the app swiped away, offline, in forced Doze, after reboot and after an app update; exact vs inexact delay recorded; denial paths handled; tap opens the task. *Tests:* Kotlin unit tests where logic exists, instrumented/ADB scripts, manual matrix in M8-04g.
**M8-04f — Settings UI.** Web half: "Instant updates" status/test, per-device hint state, masked endpoints, gateway-not-configured explanation; native half: 14.6. *Acceptance:* every state (unsupported, denied, granted, exact unavailable, gateway off/unreachable/ok) has copy and a test; axe sweeps at 1440/768/390/360, both themes, 44 px targets (MU-08 rules). *Tests:* vitest component tests, Playwright real-stack journey for the web half; native half in M8-04g.
**M8-04g — verification matrix** (`BLOCKED`). Real-device scenarios in `TESTING.md` 12.4, results recorded with the 5-state vocabulary and device/OS/WebView/vendor details in `ACCEPTANCE.md`; ends with the REQ-011 re-score proposal for the owner.

**Reminder: what the owner must decide first** (ADR-0068): Q1 (cost of server-computed instants), Q6 (home time zone), Q7 (snooze presets), Q8 (ntfy hardening), Q9 (gate wording). Q2-Q5 are needed before M8-04c/d.

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
| J1–J7 pass **in CI** | **`PASS`** (2026-11-13) | the `e2e-real` job ran on GitHub Actions on the self-hosted runner: CI run 43420687967 green (job "Real-stack journeys (Playwright, real API + PostgreSQL)"); it was `NOT RUN` on 2026-11-02 |
| Every sidebar item is a working screen, no "Not implemented yet" placeholders | `PASS` (with a caveat) | `Placeholder` removed; all 14 items route to real pages (`App.tsx`). Caveat: **Calendar** shows sync status only, no events (M5 is blocked) and Today's events slot is empty by design |
| `ACCEPTANCE.md` records the journey evidence | `PASS` | sections MU-00…MU-08 |
| Release table re-scored from user-reachable behaviour | `PASS` (2026-11-13) | re-score block in `ACCEPTANCE.md` "Release Readiness": REQ-005/006/010 `PASS`; confirmed by the owner |

**Update 2026-11-13:** CI has run the journeys and the release table has been re-scored (proposed); MU is `DONE`.

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
| UX-09 | Readability tokens and the task row / section structure on Inbox, Today, Upcoming, Tasks lists, project list (phone first; evidence `UX_AUDIT.md` "Readability and mobile audit (2026-11)") | UX-08 | `DONE` (local PASS 2026-11-03; evidence `ACCEPTANCE.md` UX-09; ADR-0062; CI `e2e-real` NOT RUN; not committed) |
| UX-10 | Week agenda layout and navigation, phone capture (FAB + sheet), phone menu as bottom sheet, 16 px inputs, viewport/safe-area | UX-09 | `DONE` (local, 2026-11-03; ADR-0063) |
| UX-11 | Remaining phone pages: Tasks select mode and Filters sheet, project Board column tabs, Notes toolbar, Projects cards, palette sheet; standalone Board removed | UX-10 | `DONE` (local, 2026-11-03; ADR-0064; the UX series UX-01…UX-11 is complete) |
| UX-12 | Selectable accent colours (ten, Neutral default), per-device preference, picker in Settings > Appearance | UX-11 | `DONE` (local, 2026-11-10; ADR-0073; evidence `ACCEPTANCE.md` UX-12) |
| AUTH-01 | Account recovery in the UI: one-time recovery code at setup / in Settings, "Forgot password?" on the sign-in page, reset without email | UX-02, SYNC-06 (`revoke_all_devices`) | `DONE` (2026-11-04, local, 10 sub-steps 01a-01j all verified; owner approved the design 2026-11-04; not committed; CI not run; evidence `ACCEPTANCE.md` AUTH-01; ADR-0067; risks R-56, R-57; threats `SECURITY.md` T25-T30). `atlas-admin reset-password` stays the fallback when both password and code are lost; new `atlas-admin recovery-code`; new setting `RECOVERY_ENABLED` (default true) |

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

### UX-09 plan — Readability tokens and the task row / section structure (owner feedback 2026-11-03)
- **Problem.** On a phone the task lists are hard to read: one undifferentiated text block per row (title 14 px, meta
  12 px wrapping to 2-3 lines, rows 52-80 px), no row separators, flat grey section labels, overdue and High share one
  colour, 22 px checkboxes and a 20 px title as the only open target. Evidence and screenshots:
  `UX_AUDIT.md` "Readability and mobile audit (2026-11)" §B, §C.1 findings 2, 3, 5, 6.
- **Scope.** (1) Tokens from the audit §D.2 in `styles.css` (light and dark, both dark copies): `--bg-page`,
  `--bg-card`, `--bg-section`, `--row-sep`, `--due-overdue(-soft)`, `--due-today(-soft)`, `--priority-urgent/high/medium/low`,
  `--project-1..8`; the same values added to `src/styles.test.ts` `REQUIREMENTS` (text 4.5:1 on every surface
  they appear on, dots 3:1). (2) `TaskMeta`/`TaskRow`: phone anatomy of §D.3 (title 16 px; line 2 due chip with icon + word,
  priority, subtask count; line 3 project dot + name and at most two tags; parent for subtasks; never more than three
  lines); overdue/today/priority conveyed by colour **and** icon **and** text; project dot colour = `hash(project.id) % 8`
  (no schema change); inside a day group (Upcoming, Today, Week) the date is dropped and only the time shown. (3) Touch
  targets: the checkbox gets a 44x44 hit area, the whole row body opens the task, row min-height 56 px, `(pointer: coarse)`.
  (4) Section structure on `Inbox`, `Today`, `Upcoming`, `Tasks`, project Tasks tab: section cards on `--bg-page` (phone), row
  hairlines, sticky `--bg-section` headers with counts, Overdue / Due today header treatment, relative day headers
  ("Tomorrow · Wed 4 Nov"). (5) Desktop: due and priority in fixed-width columns. (6) `Skeleton` row height follows the new row
  height. (7) Today: daily note preview as plain text with Markdown markers dropped (refined 2026-11-03: `MarkdownPreview` would render inline HTML, which j6 forbids; ADR-0062 §7), one-line Events. Icons: the vendored `triangle-alert` replaces the planned `alert-circle`; none added.
- **Out of scope.** Week layout and navigation, FAB/capture, bottom-sheet menu, 16 px inputs (UX-10); Tasks select mode, Board,
  Notes, Projects, palette (UX-11); user-chosen project colours (would add a project field and sync surface: separate
  decision); swipe gestures (not recommended, audit §C.4); any API, data-model or dependency change. Two icons
  (`alert-circle`, `sun` if missing) would be Lucide shapes recorded in `DEPENDENCIES.md`.
- **Dependencies.** UX-08 (done). No backend work; independent of SYNC.
- **Acceptance.** (a) Token contrast test passes in both themes and both dark copies are identical. (b) At 390 and 360 px
  every task row is at most three lines, text never overflows its row, no row is taller than 96 px, title is 16 px, and
  an overdue row, a due-today row and an urgent/high row are distinguishable **without colour** (icon + word, checked by
  a component test and by a greyscale screenshot). (c) Every row has a 44x44 completion hit area and the row body
  opens the task; "…" stays 44x44; unit/e2e check by `boundingBox`. (d) Section headers are sticky below the mobile
  header, show counts, and the Overdue header is distinguishable by icon and text. (e) No horizontal document scroll at
  360, 390, 768 and 1440 in light and dark (extend the mu08 layout spec to the four sizes). (f) axe WCAG 2 A/AA clean on
  Inbox, Today, Upcoming, Tasks, project page in both themes at 390 and 1440 (and one VoiceOver or TalkBack pass, or
  recorded as unverified). (g) `npm run lint` (scale check) and `npm run typecheck` pass, `npm test` passes, `npm run e2e`
  and `npm run test:e2e:real` pass. (h) Desktop rows stay at most 40 px (ADR-0052).
- **Required tests.** Component tests for `TaskMeta` (each state renders icon + text; dropped date inside a day group;
  at most two tags + "+n"); a unit test for the project colour hash (stable, 8 buckets); `styles.test.ts` additions; Playwright
  real-stack spec `ux09-readability.spec.ts` at the four sizes in both themes (row height <= 96, targets >= 44,
  no horizontal scroll, axe); update ux03 only where a label legitimately changes.
- **e2e selectors to keep** (listed in `UX_AUDIT.md` §E): `.task-row`, `.task-priority`, `.task-due`, `Open <title>`,
  `Complete <title>`, `Actions for <title>`, `Schedule <title> for today`, menu roles, regions "Daily note" and "Events".
- **Verification evidence.** screenshot set at 390, 360, 768, 1440 x light/dark compared with the audit set
  (`UX_AUDIT.md` §A), command output of the checks above in `ACCEPTANCE.md` UX-09. Rollback: CSS/markup only.
- **Status: `DONE`** (local, 2026-11-03; see `ACCEPTANCE.md` UX-09, ADR-0062, R-49). Deviations recorded there: phone line 2 is 14 px and line 3 12 px (no 13 px in the scale); the title keeps one line when both meta lines exist (three-line cap); the real-stack spec checks Today, Inbox, Upcoming, Week, Tasks, Projects and a project page at four sizes (not the roadmap's ux03/mu08 extension).

### UX-10 plan — Week agenda, phone capture, menu sheet, inputs
- **Problem.** Week's 7 columns of 150-160 px hide Saturday/Sunday (1,122 px grid in a 656 px container at 768; 1,192 in
  1,088 at 1440 with the sidebar open), break words and clip meta; there is no always-reachable capture on a phone; the row
  menu is a small popover over the text; inputs are 14 px (iOS zoom). Audit §C.1 findings 1, 4, 7 and §D.4.
- **Scope.** (1) Week: agenda cards in an `auto-fit, minmax(260px, 1fr)` grid by default, seven columns only where they fit
  (container query, >= 7 x 220 px); today's card highlighted; empty day = one muted line; segmented, bordered, 44 px
  week navigation with the same names; projects summary on one scrollable line. (2) Phone capture: a 56 px FAB and a bottom sheet
  reusing `QuickCapture` on Today, Inbox, Upcoming, Week, Tasks and project pages (not Notes/Settings); inline capture
  removed on phone Today, kept on desktop and phone Inbox. (3) `Menu`/`Popover`: bottom-sheet presentation at
  `(max-width: 720px)`, same roles, keys, focus return and Esc rules (ADR-0052 §4). (4) `@media (pointer: coarse)`
  `font-size: var(--fs-md)` for text inputs, selects and textareas; `viewport-fit=cover` and
  `interactive-widget=resizes-content` in `index.html`, `env(safe-area-inset-bottom)` on the bottom nav, FAB and sheets.
  (5) Inbox on touch: a second visible 44 px "Today" button per row (owner may decline).
- **Out of scope.** Tasks/Board/Notes/Projects/palette (UX-11); gestures; backend.
- **Dependencies.** UX-09 (tokens, row anatomy).
- **Acceptance.** No horizontal document scroll **and no inner horizontal scroll on the Week page** at 360, 390, 768 and 1440 (with the
  sidebar open) in both themes; all seven days reachable at every size; no word breaks inside a title; capture reachable in
  one tap from every task page on a phone and the sheet does not cover the input when the keyboard is open (emulated; real device
  recorded as unverified); every control inside the sheet is >= 44 px; all text inputs compute to >= 16 px under
  `(pointer: coarse)`; the menu is a bottom sheet at 390 and a popover at 1440 with identical roles and keys; axe clean; J1-J7,
  ux02-ux09, tasks-page, mu08 pass; `npm run e2e`, `npm run test:e2e:real`, lint, typecheck, tests pass.
- **Required tests.** Week layout spec at 360/390/768/1440 (all seven day headings visible, no inner scroll); component tests
  for the sheet focus trap, Esc and focus return; capture sheet adds exactly one task on retry (idempotent, existing path);
  update the `Week` and `Inbox` unit tests for the removed phone inline capture (selector `Task title` stays: one visible
  instance at a time).
- **e2e selectors to keep.** Those of UX-09 plus "Previous week", "This week", "Next week", `Task title`. Selectors that may
  change: `.week-days` / `.week-day` class names (list them in the PR), the phone Today inline capture.
- **Refinements made while implementing (2026-11-03, ADR-0063).** (a) The projects summary is wrapping small chips plus a
  "Projects · n" toggle row on a phone, not "one scrollable line" (that contradicts the no-inner-scroll acceptance). (b) The container
  query lives on a wrapper `.week-agenda`, not the page (layout containment would trap the fixed capture button). (c) `Popover` (Due range,
  saved-view name) becomes a sheet with `Menu`. (d) The existing `.segmented` control is reused for week navigation. (e) Capture from
  Upcoming, Week and Tasks creates an Inbox task and says so; no `c` shortcut was added. (f) Plan item 5 (Inbox "Today" button) was **not
  built** (owner may decline; revisit). (g) Rail, filter chips, filter menu, "Select all" label and List | Board get 44 px targets on touch.
- **Status: `DONE`** (local, 2026-11-03, not committed, CI `e2e-real` not run; evidence `ACCEPTANCE.md` UX-10, ADR-0063, R-50). Not verified on a
  real phone (keyboard, notch, iOS zoom, TalkBack/VoiceOver).

### UX-11 plan — Remaining phone pages
- **Problem.** Tasks has two checkboxes per row and a wrapping dashed chip bar; Board is five side-scrolling columns of ~190 px
  (2,404 px tall); the Notes toolbar is crowded and the breadcrumb reads "/…"; Projects rows are three loose lines; palette rows
  are ~28 px. Audit §C.1 findings 8-10.
- **Scope.** Tasks: square select box only in a "Select" mode (entered from the filter "…" menu), filter chips (44 px, solid border,
  active tinted; built as one "Filters" sheet button, see below), "Select all" 44 px. Project Board: one column at a time with a tab
  strip, the key-hint paragraph behind a "?" button on touch. Notes: toolbar shows the note title, one segmented mode control, the
  rest in "…". Projects: cards with project dot colour, one-line summary, target date right, 44 px "…". Palette: full-height sheet on
  phone, 44 px rows, no key hints. Settings, Login, Setup: tokens only.
- **Out of scope.** Backend; drag-and-drop redesign; Notes editor behaviour; new settings.
- **Dependencies.** UX-10 (sheet, 16 px inputs, FAB).
- **Acceptance.** At 360 and 390 px: no inner or document horizontal scroll on Tasks, Projects, Notes (except the Board's deliberate
  column strip if tabs are not chosen), every interactive control >= 44 px (a Playwright sweep over the touched pages excluding
  inline text links), Board shows one full-width column with all five reachable by tab, bulk actions still work (complete, move, delete + undo,
  J-specs), axe clean in both themes, existing specs pass with listed selector changes (the Tasks "Select" control and the
  Board help button), tests, lint and typecheck pass, `npm run e2e` and `npm run test:e2e:real` pass.
- **Required tests.** Tasks selection-mode component test; Board column tabs (keyboard: arrows, `[`/`]` still move cards; the move
  announcement is kept); target-size sweep spec; update `tasks-page.spec`, `ux07`.
- **Refinements and scope change made while implementing (2026-11-03, ADR-0064).** (a) Owner scope change: the **standalone Board is
  removed** (route `/board` redirects to Projects, nav/palette entry and the Tasks `List | Board` switch deleted, `view=board` ignored,
  dead code and tests deleted); the project page's Board tab is the only board and gets the phone column tabs; a task with no project
  is on no board (known consequence, R-51). (b) Filter chips are one "Filters" button + sheet on touch/phone (no scroll strip, so no
  exception to "no inner scroll" is needed). (c) Medium/Low show their word on a phone; the status-bar link is 44 px; phone Inbox and
  project Tasks show the capture button only. (d) 44 px rules are keyed on `(max-width: 720px)` as well as `(pointer: coarse)`, which
  Chromium's emulation did not report. (e) Selectors: `/board`, the "Board" nav link, "Go to Board" and the Tasks group "View" are gone; the
  phone Tasks page has no `Select <title>` until "Select tasks"; specs ux02, ux03, ux07, ux08, mu08, J1 were updated (`TESTING.md`).
- **Status: `DONE`** (local, 2026-11-03, not committed, CI `e2e-real` not run; evidence `ACCEPTANCE.md` UX-11, ADR-0064, R-51). Not verified on a
  real phone (keyboard, notch, iOS zoom, TalkBack/VoiceOver). **The UX series (UX-01 ... UX-11) is complete.**

---

### UX-12 plan — Accent colours
- **Problem.** Owner request (2026-11-10): "I would just like to have some more accent colors." The accent is neutral only (ADR-0051).
- **Scope.** Nine accents beside Neutral, each as the five accent tokens for Light and both dark blocks; an `atlas-accent` preference (`data-accent`) and an `atlas-accent-headings` switch (`data-accent-text`, coloured headings, owner addition) applied by `theme-init.js` before paint and live by `lib/accent.ts`; a radio-group picker in Settings > Appearance; selected navigation moved to the accent tint; CodeMirror selection, live-preview links and tags on the tokens.
- **Out of scope.** Syncing the preference across devices (needs a server setting; later option), per-project colours, the desktop shell's own welcome page, any change to semantic colours, backend.
- **Dependencies.** UX-01 tokens, ADR-0062. **Acceptance and tests.** `ACCEPTANCE.md` UX-12, `TESTING.md` (UX-12 bullet).
- **Status: `DONE`** (local, 2026-11-10, not committed, CI not run; ADR-0073). Not verified on real Safari/Firefox, a real phone or the desktop shell.

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
| SYNC-03 | Protocol v1 server: client ids, sync mode, field merge, `include=data`/`types`/snapshot/retention, versioning | SYNC-01, SYNC-02, ADR-0059 D1–D4, D6, D9, D11–D12 | `DONE` (2026-11-03, local, 7 sub-steps 03a-03g all verified; not committed; CI not run; evidence `ACCEPTANCE.md` SYNC-03). Notes: identity/create/idempotency only, content semantics are SYNC-04 |
| SYNC-04 | Note history and three-way merge, move/delete/revive rules, portable paths | SYNC-03, ADR-0059 D3, D5, D10 | `DONE` (2026-11-03, local, 7 sub-steps 04a-04g all verified; not committed; CI not run; evidence `ACCEPTANCE.md` SYNC-04; ADR-0060) |
| SYNC-05 | Resolution log, feed entity and undo | SYNC-03, ADR-0059 D7 | `DONE` (2026-11-03, local, 7 sub-steps 05a-05g all verified; not committed; CI not run; evidence `ACCEPTANCE.md` SYNC-05; ADR-0061) |
| SYNC-06 | Device credentials: table, bearer auth, rotation, revoke, Settings → Devices | SYNC-03, ADR-0059 D8; AUTH-01 consumes the revoke function | `DONE` (2026-11-03, local, 8 sub-steps 06a-06h all verified; not committed; CI not run; evidence `ACCEPTANCE.md` SYNC-06; ADR-0065) |
| SYNC-07 | Tauri 2 spike (Linux, Windows, Android) and Electron-fallback decision | — (hardware: Windows machine, Android device) | Linux part `IN_REVIEW` (2026-11-04, local, not committed; results `SYNC_PROTOCOL.md` section 13, evidence `ACCEPTANCE.md` SYNC-07, code `spikes/tauri/`): stay with Tauri 2, no Electron criterion triggered on Linux, **conditional**; **Windows runner (2026-11-04, `.github/workflows/windows-spike.yml`, manual): mechanical part `PASS`** (MSVC build, 2.9 MiB per-user NSIS installer, signed update valid/tampered/wrong-key, SQLite 100/100 kills, Credential Manager, single instance, WebView2 156, Windows graph audit clean; one Windows-only defect found and fixed: directory `fsync`), results `SYNC_PROTOCOL.md` 13.3a. **Still `BLOCKED` on the owner:** S7 as a standard user on the work laptop (UAC, SmartScreen, AppLocker/AV, WebView2 under policy), OneDrive/Dropbox watching, IME/real input (S1), and Android; the owner now downloads the prebuilt installers (`gh run download`, 13.3a) instead of building; checklists in `SYNC_PROTOCOL.md` 13.3 and 13.4 |
| SYNC-08 | `packages/sync-core`: framework-free TS client core (queue, pull/apply, rebase, backoff, conflict states) over a `LocalStore` interface; web adapters keep M7 behaviour | SYNC-03, SYNC-02 | `DONE` for the core, simulation and adapters (2026-11-04, local, not committed, CI not run; evidence `ACCEPTANCE.md` SYNC-08; ADR-0066). **Not done:** migrating `apps/web/src/lib/syncEngine.ts` to the core (deliberately, R-54) |
| SYNC-09 | Desktop client: Tauri shell, SQLite store, notes-folder engine, keystore, device sign-in | SYNC-04, SYNC-05, SYNC-06, SYNC-07 pass, SYNC-08 | **Phase 1 (Linux) in progress 2026-11-10**: plan and acceptance in the section "SYNC-09 — Desktop client, phase 1"; ADR-0069; Windows and the UI-on-local-store step are NOT in phase 1 |
| SYNC-10 | Android client (or PWA fallback per A-09) with background sync | SYNC-09, SYNC-07 Android pass | `DONE` with recorded limitations (owner sign-off 2026-11-13; see `ACCEPTANCE.md` SYNC-10) (2026-11-12, local, not committed, CI not run; ADR-0075; evidence `ACCEPTANCE.md` SYNC-10): the desktop shell builds and runs on Android (debug APK on a OnePlus 8T / Android 14; release signing script), Keystore token, app-private notes folder, sync, OS reminders, Settings reliability section; the e2e run `apps/desktop/e2e/android.mjs` passes on the phone. **Also done 2026-11-13:** second Android version (API 35 emulator, e2e 13 PASS incl. a reboot), notes export through the share sheet, editor typing with real touch and key events on the phone, an Android dependency scan (Jackson forced to 2.22.4), a manual CI workflow (not run). **Added 2026-11-13 (tested on the OnePlus and the emulator):** shared notes folder, keep-connected background service. **Not done:** push wake-up (UnifiedPush/ntfy), the physical phone's reboot (the owner said to skip it), a second vendor, IME composition |
| SYNC-11 | Conflict and "changed on another device" UI (text-conflict resolver, undo, devices list) | SYNC-05, SYNC-08 | `DONE` (2026-11-13) for 11a, 11b, 11c as planned; **11d moved to Later** (ADR-0077-style scope cut, below). CI: runs 43420687967 and later green; evidence `ACCEPTANCE.md` SYNC-11; ADR-0070 |
| SYNC-12 | Release gate: real-device matrix, backup/restore with devices attached, docs (USER_GUIDE, OPERATIONS) | SYNC-09, SYNC-11 | `DONE` (2026-11-13) for the 0.1.0 scope (Linux desktop, Android, web): real-device matrix and restore with devices attached recorded in `ACCEPTANCE.md` SYNC-12; USER_GUIDE and OPERATIONS cover the restore screens and `record-restore`. Windows/macOS/iOS out (ADR-0077) |

### SYNC-08 — `packages/sync-core` (`DONE` locally 2026-11-04)
- **Plan (written first).** (1) Ports and types; (2) store with real transactions + in-memory store; (3) apply rules (R-40); (4) engine: FIFO
  push with frozen bases and chained bases, pull with atomic page+cursor, snapshot/restore, halts (426, 401, epoch); (5) notes: pinned
  working copy, rebase; (6) notices/undo/status; (7) unit tests; (8) TS model server (port of `tests/sim/model*.py`), fault network,
  invariants, planted defects; (9) real-API conformance; (10) adapters; (11) wiring into the existing vitest/eslint/tsc; (12) docs.
- **Scope kept out:** web UI change, desktop/Android stores, conflict UI (SYNC-11), concurrency across entities, `types_synced` backfill.
- **Web app:** left on the M7 engine; exact reasons in ADR-0066 point 8 and R-54. What remains: SYNC-11 decides the conflict UX, then
  `KeyValueLocalStore` + `createFetchTransport` + `legacyQueueSnapshot` are the incremental path.
- **Wiring:** `apps/web/vite.config.ts` projects `web`/`sync-core`/`sync-core-real`; `tsconfig.json` includes the package; the web
  `lint` script also lints the package. `scripts/verify.sh` is unchanged and picks the tests up through `npm run test`.

### SYNC-09 — Desktop client, phase 1 = Linux (plan refined 2026-11-10; ADR-0069)

**Risk control.** The owner has not yet run the Windows no-admin installer test (R-36). A Windows failure moves BOTH desktop platforms to
Electron (13.2), so phase 1 keeps everything that is not Rust glue in framework-neutral TypeScript behind a **platform port**
(`packages/desktop-core/src/ports.ts`: row database, HTTP, session/keystore, notes folder, notifier, tray, autostart, lifecycle, timers,
crypto), with a Tauri adapter (`apps/desktop/src/tauriPlatform.ts` + `apps/desktop/src-tauri`) and a fake adapter for tests. Rust commands stay
thin and separately tested (`apps/desktop/native`). The boundary is ADR-0069 and `ARCHITECTURE.md` section 8a; a test fails if the core names a host.
Scope of the phase: **Linux only**; Windows build/packaging and Android are NOT part of it. What the shell does with the existing web UI:
loads it from the bundle and routes its `/api` calls through the host (device token attached in Rust); the UI keeps the M7 engine (R-54); the
sync-core engine runs beside it for the notes folder and reminders. Moving the UI itself onto the local store is SYNC-11/SYNC-12.

| Step | Title | Scope | Acceptance (all must hold; evidence `ACCEPTANCE.md` SYNC-09) | Required tests | Status |
|---|---|---|---|---|---|
| SYNC-09a | Platform ports and per-row SQLite `LocalStore` | `ports.ts`; `SqliteLocalStore` (overlay + one atomic `commit` per transaction); Rust `Store` (rusqlite, WAL, `synchronous=FULL`, forward migrations in `user_version`, fixed table list); fake adapter | Per-row access only; page+cursor commit atomic; a failed or crashed transaction leaves no trace; a newer database is refused; `synchronous` decision recorded (ADR-0069 D4); kill -9 durability; sim passes on the desktop store | vitest store contract + parity with `MemoryStore`; `cargo test` store + kill -9 (100 runs); `desktop.sim.test.ts` (model server, faults, store crashes) incl. a planted non-atomic store | `DONE` locally (see ACCEPTANCE) |
| SYNC-09b | Notes-folder engine | `NotesFolderSync` (TS) + `Folder`/`FolderWatcher` (Rust): one granted root, relative-path API, atomic compare-and-swap writes (Windows-safe fsync rule), watcher dropping `Access` and Atlas temp files, content-hash comparison, scan on start/focus/periodic incl. same-size edits, external edits as `editNote` with the base revision/hash, conflict copies, portable paths, trash instead of delete, deny-by-default scope | create/edit/rename/delete in the folder reach the server and a second device; a concurrent edit is merged or kept as a conflict-copy FILE; a file edited while a server write arrives is never overwritten; a missing folder is never "all deleted"; non-portable/too large/invalid UTF-8 files are reported and untouched; paths outside the root are refused | vitest engine + model server (10 scenarios incl. crash window and race); `cargo test` resolve/CAS/scan/watch (negative tests for traversal, symlink, hidden, sibling prefix) | `DONE` locally |
| SYNC-09c | Shell and sign-in | Tauri 2 app loading the bundled web UI; `session_*`/`api_request` (token only in the OS keystore, attached in Rust, HTTPS except loopback, no redirects, header allow-list); sign-in page; no service worker; `WEBKIT_DISABLE_DMABUF_RENDERER`; 401 -> signed-out; 426 -> update required; CORS note for operators | device sign-in with e-mail+password; the page cannot read the token (no command, not in storage); the UI works through the host; a revoked device lands on the sign-in page and its token is removed; HTTPS rule enforced in Rust | `cargo test` http/rules; vitest runtime + adapter + web bridge tests; e2e | `DONE` locally |
| SYNC-09d | Runtime integration | `DesktopRuntime`: engine + reminder scheduler + folder sync + live `GET /api/sync/wait` loop; desktop notifications; tray + close-to-tray (Q2); autostart opt-in at first run; per-device settings (reminders on/off, content mode Q5); Settings > Desktop app (shell only) | a reminder synced from another device fires a notification once; tray close/reopen keeps syncing; autostart off by default; settings persist per device; the section does not exist in a browser | vitest runtime (fake clock); web tests; e2e | `IN_REVIEW` (2026-11-10, local): acceptance passes in the e2e run; the OS tray icon by a real click, `--background` start from a real login, suspend/resume and the 30-minute hidden-window run are `NOT RUN` (M8-04c row, R-71) |
| SYNC-09e | Packaging | `scripts/build-linux.sh` -> AppImage + .deb; bundler tools pinned by SHA-256; auto-update behind the off-by-default `updater` feature with a throwaway key in tests; size/startup/RSS measured; previous AppImage kept as rollback | documented, repeatable build; tools verified; update accepted/rejected as in S6 | build log; updater test; measurements | `IN_REVIEW` (2026-11-10, local): AppImage and .deb built, tools pinned, updater valid/tampered/wrong-key `PASS` with a throwaway key; not reproducible bit for bit, not built on another distribution (R-70), `.deb` not installed |

**Out of scope of phase 1 (recorded, not forgotten):** Windows packaging and the Windows repeat of the e2e run; moving the web UI onto the local database; the conflict
resolver UI (SYNC-11); Android; code signing; publishing any update; IME and real key input (no input tool on this machine).

### SYNC-11 - Conflict, notice and restore UI; the shell on one engine (plan written 2026-11-10 before any code; ADR-0070)

**Risk control.** The browser app works today and must not regress. Every step is additive (new components, new routes, new hooks), is
independently verified (unit/component tests, then a real-stack spec, then the full gates) and leaves the previous behaviour reachable.
The browser keeps its current engine (M7 autosave sessions over REST); nothing in 11a/11b changes how a browser reads or writes data. The
desktop shell changes only behind `isDesktopShell()` (11c). What the UI actually has to work with (read from the code on 2026-11-10):
the web app's legacy offline queue is not fed by any production code path (only tests enqueue), so "one engine" in the shell means the
sync-core engine owns the queue, cursor, notices, problems and halts, while the UI's reads and writes stay online REST through the host
(R-73). Writes the browser sends are not sync mode, so the browser never produces resolution entries or `Problem`s itself; it receives other
devices' entries through `GET /api/sync/resolutions` (cookie session allowed) and its own stale writes as `409 revision conflicts`.

**Design.** Presentational components take sync-core shaped data (`ResolutionRecord`, `Problem`, `SyncStatus.halt`); all wording and decisions
are pure functions in `apps/web/src/lib/syncUi/` (tested without React). Two **sources** feed them behind one small interface
(`ResolutionsSource`): a REST source (browser, and the shell until 11c) and an engine source (shell, 11c). Server API: no change is
planned; the one real gap found (a device token cannot list other devices, so the shell cannot name "which device") is recorded as R-74
and handled with generic wording, not by widening the device scope (T22).

| Step | Title | Scope | Acceptance | Required tests | Status |
|---|---|---|---|---|---|
| SYNC-11a-0 | Foundations | `lib/syncUi`: resolution wording (what/which device/when/values of simple fields only), undo-refusal mapping (changed again since, already undone, entity deleted, invalid value/transition, path taken, not undoable with follow-up link, expired), line diff, conflict-copy pairing (`<name> (conflict YYYY-MM-DD HHMMSS[ n]).md`); `resolutionsApi` (list/get/undo with `Idempotency-Key`); `ResolutionsSource` + REST source | every `rule` and every refusal in SYNC_PROTOCOL 9 has wording; no task/project/note text appears in a notice (title/description are not simple fields); values are formatted per field | vitest for each helper, table-driven over the rules and refusals | `DONE` locally 2026-11-10 |
| SYNC-11a-1 | Notices, undo, Resolutions page | `ChangedElsewhere` banner in the app shell (new, unseen, other-device entries; dismiss remembers per browser; never blocks), `/changes` page (paged "Load older"), `ResolutionCard` with Undo wired to `POST .../undo`, honest refusal text with the follow-up link (note history revision / delete again / rename); entry in Settings > Sync | Undo restores the value when nothing changed since; "changed again since" is shown as a normal outcome, not an error, and keeps the entry; a not-undoable kind shows what to do instead; a retry never undoes twice (key per tap); axe clean | component tests with a fake source; real-stack: two device clients conflict on a task field -> notice -> Undo (value restored), second conflict + a later edit -> refused text, note merge -> follow-up link | `DONE` locally 2026-11-10 |
| SYNC-11a-2 | Task text-conflict resolver | `TextConflictResolver` (both versions side by side, Keep mine / Keep theirs / Edit merged, save = ordinary revision-checked write); integrated in the task panel's existing conflict flow (the stash banner) and `TaskConflictPanel` for sync-core `Problem`s | choosing never loses the other text until the write is acknowledged; saving is a normal PATCH against the revision just read; a second conflict while saving shows the resolver again | component tests; real-stack: a device changes the title, the page edits it, resolver, merged text saved, device sees it | `DONE` locally 2026-11-10 (task panel; the engine's `Problem` in the shell) |
| SYNC-11a-3 | Note conflict resolver | list of conflict copies with their originals (Notes page), `NoteConflictResolver`: inline diff, Keep mine (copy becomes the note), Keep theirs, Merge in the editor; the copy is deleted after the resolution is saved; original saved with its revision (409 -> reread, nothing lost) | the original is never overwritten unseen; the copy is deleted only after the original's write was acknowledged; trash, not purge | component tests; real-stack: two clients edit one note, copy appears, each of the three choices | `DONE` locally 2026-11-10 |
| SYNC-11a-4 | Halt screens | `SyncHaltScreen`: restore confirmation (`cursor_ahead`/`epoch_mismatch`, D12: what the server lost, Re-upload my local data vs Discard local changes and re-download, never automatic, calls `confirmRestore()`), update required (426), signed out/revoked (401); wording per reason | each halt has a screen with one primary action; nothing is automatic; discard asks twice | component tests per halt | `DONE` locally 2026-11-10 (adds `SyncEngine.discardLocalAndRedownload()`; model simulation scenario) |
| SYNC-11a-5 | Devices polish | current-device marker and last seen exist (SYNC-06); verify only | no change needed if present | existing sync06 spec | `DONE` (verified, no change: current-device marker and last seen exist since SYNC-06) |
| SYNC-11b | Instant-updates / diagnostics status (web half of M8-04f) | Settings > Notifications: web push permission/subscription status, test notification, hint-channel state; shell: live connection, last pull, last hint | every state has copy and a test | component tests; real-stack where the server can answer; axe | `DONE` locally 2026-11-10 (browser: permission, local test notification, live connection not used; shell: live connection, last hint, gateway status; M8-04f native half stays with M8-04c/d) |
| SYNC-11c | Shell on one engine | bridge `sync` surface (status incl. halt, notices, resolutions, problems, undo, dismiss, confirmRestore, task text resolve); shell's Sync section, status bar, notices and halt screens read the engine; the legacy reconciler/queue/cursor is never started in the shell; browser path untouched | one queue and one cursor in the shell; restore/401/426 screens from engine state; a notes-folder conflict copy shows in the resolver | vitest runtime + bridge tests; desktop e2e steps | `DONE` (2026-11-13; as planned: the shell runs one engine; the UI data hooks stay on the server by design, AGENTS.md 7.4; limits R-73). Linux desktop e2e 23/23 and the Android e2e use it |
| SYNC-11d | Browser local store (ADR-0070, PLANNED ONLY) | `IndexedDbLocalStore` for sync-core, Settings opt-in "Offline mode (beta)", one-way migration rules, rollback to online-only | not built in this task | n/a | `BACKLOG` → **Later** (owner-agreed scope cut for 0.1.0: the browser keeps its existing offline queue engine, R-54; an IndexedDB offline mode is not needed for the first release) |

**Plan note on 11c.** Moving the UI's data hooks (task lists, filters, recurrence, search, planning) onto the local store would re-implement
server logic in the client (AGENTS.md 7.4) and is not attempted. 11c is the smaller change that removes the second sync engine from the shell;
what it cannot do is recorded as R-73 / SYNC-11d.

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

### SYNC-03 — Protocol v1 server (`DONE` locally 2026-11-03)

Scope, acceptance and tests follow `SYNC_PROTOCOL.md` section 4-10 (the "Implementation status" table there says what is behaviour).
Common acceptance for SYNC-03..06: the simulation scenarios of `TESTING.md` 10.3 for the feature pass on the model and on the real
API; non-sync-mode behaviour is unchanged (existing suites green, only the tests listed below were adjusted, each for a documented
contract change); migrations tested up/down on a clean DB and a populated one; `alembic check` clean (`test_migrations_match_models`).

**Pre-work (earlier, `DONE`):** R-37 row locks before the `base_revision` check; R-34 `client_max_body_size 11m`; reconcile
removal shares `NotesService.tombstone_index`; task-into-deleted-project race; sim seed 482.

**Plan as executed: ordered, independently shippable sub-steps** (each with its own verification; `verify.sh` was run on the
cumulative state at the end because the steps were landed in one uncommitted working tree, with targeted suites after each step;
the full-suite numbers are in `ACCEPTANCE.md`):

| Step | Content | Migration (reversible, tested) | Status |
|---|---|---|---|
| 03a | `field_revisions` on tasks and projects: column, **idempotent backfill to the current revision**, upkeep on every write path (create, patch, restore, delete promotion, project-delete unfiling, recurrence); `field_revisions` in `TaskOut`/`ProjectOut` | `a1f0c3d2b4e6` (tested at the previous revision with representative rows: backfill values, no revision bump, no feed rows, re-run changes nothing, down/up round trip) | `DONE` |
| 03b | `Atlas-Sync` negotiation and `426` (global, before auth), `GET /api/instance` `sync` block, `epoch` + `Atlas-Epoch` (`409 epoch_mismatch`, after auth), `atlas-admin record-restore` (D9, D12); D11 test | `c3b7d9e1f2a8` (`instance_meta`, epoch generated in SQL) | `DONE` |
| 03c | Optional client `id` on create for tasks, projects, notes (idempotent by id, `id_exists`), partial unique index on live note paths and its call-site fixes (create, adopt, rename folder, reconcile), sync-mode note idempotency + path-collision rename (D3) | `d5e8a2f1c4b9` (downgrade renames colliding tombstone *index rows* so the old constraint can return; tested with a live note and two tombstones on one path) | `DONE` |
| 03d | Sync-mode writes: required key/base, unknown fields `422`, structured errors, `sync` block, field-level merge (rules 1-4), invalid-transition guard, text conflict `409`/partial `200`, `DELETE` edit-wins, revive on `PATCH` | none | `DONE` |
| 03e | Feed: `include=data`, `types=`, snapshot at `since=0`, `head`/`floor`, `snapshot=true` continuation (**found by the simulation**), retention to tombstones only (default 90 d, minimum 30), idempotency-key TTL in the same job; ADR-0033 status note | none | `DONE` |
| 03f | Simulation: model server and a v1 client, conformance traces vs the real API, planted defects, late joiner, old client, purge, soaks | none | `DONE` |
| 03g | Docs, `openapi.json`/`schema.d.ts`, web test fixtures, real-stack and mocked e2e | none | `DONE` |

**Interfaces left for later tasks (as the spec requires):** `sync.resolution` objects are the wire shape of SYNC-05's
`sync_resolutions` rows (rule/field/kept_revision/loser); `PATCH`/`PUT` bodies reject unknown fields so SYNC-04 can add
`base_hash` without a silent half-write; note `DELETE`/`move` already require `base_revision`; `Atlas-Epoch` and the per-user
cursor are the hooks for SYNC-06 device scoping; `ChangeOut.data` is a typed union ready for `resolution` and `device` types
(clients send `types=`).

**Not in SYNC-03 (by plan):** note content merge/history/`base_hash`/stale-delete `edit_wins`/revive-on-`PUT`/move rules/portable
paths (SYNC-04); `sync_resolutions` table, feed entity and undo (SYNC-05); device tokens, per-device rate limits, `401
token_revoked` (SYNC-06); `reminder_policy`/`preferences` feed entities (not scheduled: no owner decision on timing; tracked in
`SYNC_PROTOCOL.md` section 3 as [NEW]).
`GET /api/tasks/changes` is marked `deprecated` in OpenAPI and its docstring (frozen; the web engine still uses it, removal waits for SYNC-08).
- **SYNC-04** also: nginx/compose body limit for 5 MiB notes verified (SYNC-03 pre-work); merge library licence/maintenance check recorded in
  `DEPENDENCIES.md` (done); history is included in the backup set because the archive walks the notes root; the *export* set
  carries current notes only (history is operational data, `ACCEPTANCE.md` SYNC-04).
- **SYNC-06** also: Settings → Devices; rate limit keyed by device; token never in logs/OpenAPI examples; revocation tested (all done, see the SYNC-06 section).

### SYNC-04 — Note history, three-way merge, move/delete/revive rules, portable paths (`DONE` locally 2026-11-03)

Contract: `SYNC_PROTOCOL.md` 6.3 and 11; decisions: ADR-0060; storage: `MARKDOWN_STORAGE.md` 4a. **Problem.** After SYNC-03 a stale note
`PUT` was a plain `409`, a stale `DELETE` won, a `PUT` of a deleted note was `404`, a replay returned no content and paths were
unchecked for Windows/Android (R-42). **Plan as executed: ordered, independently verified sub-steps** (one uncommitted tree; targeted
suites after each step, full `verify.sh` at the end):

| Step | Content | Migration | Status |
|---|---|---|---|
| 04a | Note history: `note_revisions` table, content-addressed files `.atlas/history/<note_id>/<hash>.md`, recorded by **every** revision bump in every mode (create, write, move, folder rename, delete, revive, reconcile), lazy recording of legacy notes, retention (20 / 90 days / 200 revisions / 64 MiB), pruning on write and in the hourly purge job, `GET .../history[/{revision}]`, covered by backups | `e7a3c5b1d9f2` (reversible; tested up/down and with a populated notes table) | `DONE` |
| 04b | Merge: `atlas/notes/merge.py` (line-based diff3 on `difflib`, final newline merged separately, front-matter and size guards); library/licence evaluation recorded in `DEPENDENCIES.md` (no dependency added); property tests (identities, symmetry, idempotence, union of disjoint edits, "right or refused" under duplicate lines) | none | `DONE` |
| 04c | Sync `PUT`: `base_hash` required, merge against the retained and hash-verified base, conflict copies saved by the server and answered `409 conflict` (stored under the key so a retry replays), external-edit adoption under the row lock, replay returns the content from history, NUL/surrogate hardening | none | `DONE` |
| 04d | Delete/revive/move: stale `DELETE` ⇒ `409 edit_wins`, delete of a deleted note `204`, `PUT` of a deleted note revives (merged into its last text, `name (2).md` if the path was reused), move independent of content with `path_later_wins`, `path_exists` by case/normalisation, `note_deleted` | none | `DONE` |
| 04e | Portable paths in sync mode: `atlas/notes/portable.py` (reserved names, forbidden characters, trailing dot/space, 240 chars / 255 bytes, case + NFC collisions), conflict-copy names shortened | none | `DONE` |
| 04f | Simulation: `model_notes.py`, note-aware `SyncSimClient` (working copy pinned to its base, hydration, coalescing), invariants `no_silent_overwrite`, `no_acknowledged_note_loss`, `conflict_copy_has_losing_text`, `unique_paths`/`portable_paths`, edit-wins for notes; 10 planted defects; 6 conformance traces model vs real; real-API runs on a per-test notes folder | none | `DONE` |
| 04g | Docs, `openapi.json`/`schema.d.ts`, `.env.example`/compose/operator guide for `NOTE_HISTORY_*`, mocked and real-stack e2e | none | `DONE` |

**Acceptance (all verified, see `ACCEPTANCE.md`):** non-overlapping edits merge silently and keep CRLF/LF/final newline/UTF-8/front matter
byte for byte; overlapping or uncertain edits never overwrite and are saved whole as a conflict copy named in the `409`; a pruned,
damaged or mismatching base is a conflict, never a guess; no acknowledged note write is lost (simulation, model and real API);
stale delete refused / edit revives; path collisions renumber, invalid paths are refused, case/normalisation collisions are
collisions; replay of a merged save returns the same content; history is user-scoped, bounded, pruned and in backups; non-sync
behaviour and the web app's autosave/conflict-copy flow are unchanged (existing suites green, only the SYNC-03 note tests were
adjusted for the `base_hash` contract).

**Deviations from the sketch, all in ADR-0060:** content-addressed history files; the server (not the client) saves the conflict copy;
front matter must be byte-identical to one side (no YAML parser); a rename of a deleted note is refused; `ETag`/`If-None-Match` not built.
**Found by the work:** a lone surrogate in a JSON string was a `500` (fixed, all modes); a replayed *delete* acknowledgement can
tombstone an entity another device revived (R-40, client rule, model client fixed). **Not in SYNC-04:** resolution log and undo
(SYNC-05, done: every resolution is logged), device credentials (SYNC-06),
clients (SYNC-08/09), conflict UI (SYNC-11), word-level merge or YAML-aware front-matter merge (R-45).

### SYNC-05 — Resolution log, `resolution` feed entity and undo (`DONE` locally 2026-11-03)

Contract: `SYNC_PROTOCOL.md` 9; decisions: ADR-0061; data: `DATA_MODEL.md` 2.5 (`SyncResolution`). **Problem.** After SYNC-04 every
automatic decision of a sync-mode write (`simple_later_wins`, `edit_wins_over_delete`, `note_merged`, `path_collision`,
`path_later_wins`) existed only in the response of the writing device (R-41): other devices could not be told "changed on another
device", the overwritten value was lost when the idempotency key expired, and nothing could be undone (ADR-0055 section 4: every
automatic resolution is logged so it can be inspected and undone). **Plan (written before the work, refined while executing),
ordered, each step verified before the next** (one uncommitted tree; targeted suites after each step, full `verify.sh` at the end):

| Step | Content | Migration | Status |
|---|---|---|---|
| 05a | Table `sync_resolutions` + model: user-scoped, rule/entity-type check constraints, `loser` as `{"value": ...}` (null-able values), `device_id` column without FK, `op_key`/`ordinal` tripwire, unique `undoes_id`; indexes for the list and the purge. Migration tested clean, at the previous revision with representative data (tasks, projects, notes, feed rows; nothing changes, table empty), constraints, cascade, down/up round trip | `f4a8b2c6d1e3` (reversible; downgrade also deletes the `resolution` feed rows) | `DONE` |
| 05b | `atlas/sync/resolution_rules.py` (pure: undoability and its reasons/follow-ups, bounds, list cursor) and `resolution_log.py` (insert + announce in the caller's transaction, page, mark undone, purge); unit tests | none | `DONE` |
| 05c | Feed entity: `ChangeEntityType.RESOLUTION`, `include=data` payload (state 1/2), `types=` vocabulary, default visibility (sync mode only), `instance.sync.entities`, purge job deletes expired rows with their feed rows; `ResolutionOut` in OpenAPI | none | `DONE` |
| 05d | Log at every write site in the write's transaction, ids in the response: task/project `PATCH` (only fields really changed), revive, note create (`path_collision`), `PUT` (`note_merged`, revive, collision), the conflict response of a revive, note move (`path_later_wins` with `path` and the overwritten path). Refused deletes deliberately not logged (ADR-0061). Fixed on the way: retried refused note `DELETE` replayed status 0 | none | `DONE` |
| 05e | `GET /api/sync/resolutions`, `GET .../{id}`, `POST .../{id}/undo`: strict write through the ordinary services (`plan_merge(strict=True)`, base = `kept_revision`), never revives, idempotent, own `undo` entry, original marked undone and re-announced, reminders rescheduled, explicit refusal bodies for non-undoable kinds | none | `DONE` |
| 05f | Simulation: model log/feed/list/undo, clients that pull `resolution` and undo (a second wave after quiescence), 8 invariants, 10 planted defects + restore scenario, model/real conformance (6 traces), real-API runs | none | `DONE` |
| 05g | Docs, `openapi.json`/`schema.d.ts`, `verify.sh`, soaks, real-stack browser suite, restore drill of a backup that contains the table | none | `DONE` |

**Acceptance (all verified, `ACCEPTANCE.md`):** a decision and its log row commit or roll back together (injected failure after the
write leaves nothing); a replay or retry logs nothing more (integration, DB tripwire, simulation); a client learns every decision
through the feed with the same cursor/`types=`/`include=data`/retention behaviour as other entities, the web app does not see the
new type; no text or note content is stored or logged; list and undo are user-scoped (another user's entry is `404`, untouched);
undo restores the overwritten value only if nothing changed the field since and otherwise says so (`changed_since`), never
revives a deleted entity, is idempotent by key, answers a second undo `already_undone`, logs itself, and non-undoable kinds
(`note_merged`, `edit_wins_over_delete`, `path_collision`, `undo`) say why and what to do instead; the log survives a database
backup and restore; non-sync mode and the web app are unchanged.

**Deviations, all in ADR-0061:** a refused stale `DELETE` is not logged (nothing was written); no `delete` tombstone for a purged
resolution (a client drops notices by age); retention reuses `CHANGE_RETENTION_DAYS` (no new setting, nothing for `OPERATOR_GUIDE`).
**Not in SYNC-05:** which device made a write (`device_id` is `NULL`, SYNC-06), the notice/undo UI and the client cache of notices
(SYNC-11, SYNC-08), a persisted resolve action for text conflicts, a redo of an undo (edit the field).

### SYNC-06 — Device credentials (`DONE` locally 2026-11-03)

Contract: `SYNC_PROTOCOL.md` 10.1; decisions: ADR-0065; data: `DATA_MODEL.md` `Device`; threats: `SECURITY.md` T13, T17, T22-T24.
**Problem.** After SYNC-05 the only credential was the browser cookie session with double-submit CSRF: a native client would have had
to fake a browser, could not be listed or revoked on its own, and the resolution log could not say which device wrote (`device_id`
was `NULL`). **Plan as executed: ordered sub-steps, each verified before the next** (one uncommitted tree; targeted suites after each
step, full `verify.sh` at the end):

| Step | Content | Migration | Status |
|---|---|---|---|
| 06a | Table `devices` + model (hash-only token columns, grace columns, platform/name checks, unique token hash) and the foreign key of `sync_resolutions.device_id` (`ON DELETE SET NULL`). Tested clean, at the previous revision with a populated schema (user, session, task, resolution), constraints, cascade, `SET NULL`, down/up/up round trip | `b7c4d9e2a1f5` (reversible; downgrade drops `devices` and clears `device_id`) | `DONE` |
| 06b | `atlas/auth/devices.py`: token generation (`atd_` + 256 bits), SHA-256, shape check, constant-time lookup, rotation, `revoke_device`, `revoke_all_devices`, idle expiry, `last_seen_at` in its own transaction at most every 5 min, per-device limiters; `RateLimiter.retry_after`; `SyncError.headers` | none | `DONE` |
| 06c | Auth dependencies: `CurrentUser` stays browser-only (device = `403 forbidden_scope`), new `SyncUser` (session or device) applied to the sync/data routers; bearer-alone rule; CSRF skipped only for bearer requests and `POST /api/devices`; `request.state.device_id` and `session.info["device_id"]` | none | `DONE` |
| 06d | Endpoints: `POST /api/devices` (sign-in, shared login limiter, `422` without echo), `GET`, `PATCH`, `DELETE`, `POST /revoke-all`, `GET /current`, `POST /current/rotate`, `DELETE /current`; schemas; `openapi.json` and `schema.d.ts` | none | `DONE` |
| 06e | `revoke_all_devices` wired into `reset_password` (CLI; returns `(sessions, devices)`) and into `POST /api/auth/password` (`revoke_devices`, default off, decision in ADR-0065 point 5); `atlas-admin list-devices` / `revoke-device`; the hourly purge deletes devices revoked before the retention window | none | `DONE` |
| 06f | `device_id` into the resolution log (list, feed `include=data`, undo) via the session; the integration tests of default deny (the exact set of open endpoints), scopes, rotation, expiry, `last_seen_at`, limits, theft, isolation, cookie/CSRF interaction, token hygiene, backup dump | none | `DONE` |
| 06g | Simulation: clients as devices on the real API, invariants `resolution_device`, `revoked_never_served`, `stop_on_revoked`, a planted defect; model soak unchanged | none | `DONE` |
| 06h | Web: Settings → Devices (list, rename, sign out, sign out all, last seen, empty state, current marker), the "Also sign out my devices" box, vitest, real-stack spec (bearer journey, layout, axe, 44 px), docs, soaks, `verify.sh` | none | `DONE` |

**Acceptance (all verified, `ACCEPTANCE.md`):** a device signs in with e-mail and password and receives a 256-bit token once; only its
hash is stored and the token appears in no log, URL, error or backup; the token syncs tasks, projects, notes, the feed and the
resolution log, and cannot change the password, export, connect calendars or touch another device (the exact open set is a test);
revoking is effective on the very next request and ends the grace window; rotation gives a new token and a 24 h window for the old
one that ends when the new one is used; an idle device (90 days) must sign in again; a password reset (CLI) signs out every device and
a password change does so when asked; a bearer request ignores cookies and needs no CSRF while every cookie request is checked as
before; users are isolated; `last_seen_at` is the server's time and written at most every five minutes; resolutions name the device
that wrote; a revoked device is never served again in the hostile simulation and its client stops; the web UI lists, renames and
signs devices out under the touch rules with no axe findings.

**Deviations from the sketch (ADR-0065):** no `app_version`/`protocol` columns; idle expiry is the retention window (no new setting);
a general per-device limit instead of the per-endpoint numbers of 8.3 (R-53); `GET /api/devices` is open to devices (read-only, so
a device can mark itself `current`); the Settings page has no "Add a device" dialog (devices sign in themselves).
**Found by the work:** the
simulation's `no_duplicates` invariant had to allow for creates a revoked device applied but never saw acknowledged; a restore brings
back devices as the backup had them, so a device revoked after the backup works again until revoked once more (documented in
`OPERATIONS.md` 2.2a and `OPERATOR_GUIDE.md`). **Not in SYNC-06:** the client side (keystore, HTTPS-only enforcement, sign-in screen,
scheduled rotation: SYNC-07/09/10), a pairing flow, reuse detection (R-52), feed/snapshot limits (R-53), "changed on another device"
UI (SYNC-11), AUTH-01 itself.

### SYNC-07 plan — Tauri 2 spike (throwaway code; as run it lives in `spikes/tauri/`, outside every workspace)

**Linux part run 2026-11-04 (`IN_REVIEW`).** Results table, verdict and the Electron-fallback criteria applied: `SYNC_PROTOCOL.md` section 13 (the single
source; not repeated here). Refinements made while running: the check list below was kept as S1-S10 and three checks were added (X1 single instance, X2 API access with
bearer/CORS/CSP/capabilities/real `sync-core` round trip, licence and advisory check inside S10); S1 and S2 were split into sub-results because they are
partly `PASS`, partly `NOT RUN`; the spike lives in `spikes/tauri/` instead of a scratch directory so that a fresh session can rerun it (it is isolated:
not in `apps/web`'s ESLint/tsc/vitest scope, not in `verify.sh`, not in CI). **Remaining before SYNC-09:** (1) Windows S6/S7 and the rest of the Windows
checklist (owner's machine), (2) Android checklist (owner's phone), (3) on Linux the real-input checks that need a tool: manual J1-J7, IME, post-edit frame on a
GPU-enabled WebKitGTK. **Owner `sudo` list for (3), optional:** `sudo pacman -S --needed xdotool xorg-server-xvfb gnome-keyring` (xdotool for key events into the
shell under Xwayland, Xvfb for a controlled non-compositor display, gnome-keyring to test the second Secret Service implementation); and, to find the missing
WebDriver for WebKitGTK (Playwright/`tauri-driver` need `WebKitWebDriver`, not shipped in the installed `webkit2gtk-4.1`): `sudo pacman -Fy && pacman -F WebKitWebDriver`.
Nothing else needed `sudo`: `webkit2gtk-4.1`, `libsoup3`, `openssl`, `librsvg`, `gtk3`, `libayatana-appindicator` were already installed.

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

## Path to personal use and to native clients (owner request 2026-11-03)

**Where we are (verified locally, CI never run).** The web app covers notes (Markdown files, autosave, live preview,
history), tasks, projects, board, search, reminders, settings, backups and export for ONE owner on ONE server.
Not built or not verified: calendars (REQ-007/008/009 `NOT RUN`, M5-00 blocked on real accounts), offline use in
the UI (R-22: mutations are online-only), real push delivery (REQ-011), the sync *clients* (only the server side,
SYNC-01…04, exists), account recovery in the UI (AUTH-01), HTTPS (operator-provided), and every check on a real
second device. `RELEASE.md` still labels the release "not production-ready"; that label is accurate for calendars
and devices, not for the notes/tasks core.

**Phase 0 — Personal alpha (web, own server).** Usable for your own notes and tasks once these hold. Results of
2026-11-03 (evidence `ACCEPTANCE.md` P0-1/P0-2/P0-3; install guide `DEPLOYMENT.md` section 11; risks R-46):
- **P0-1 `DONE` (locally).** Compose images built from the current tree; fresh install, notes up to 5 MiB through nginx, tasks,
  projects, worker jobs, export, browser check, and the upgrade from `b7d3e1a95c24` with data all `PASS`. Six defects found and
  fixed (DATABASE_URL vs POSTGRES_PASSWORD, unforwarded settings, `ALLOWED_HOSTS` vs the healthcheck, 5 MiB error echo,
  exports not in a volume, web on all interfaces). CI has not run it.
- **P0-2 `IN_REVIEW`.** HTTPS documented (`DEPLOYMENT.md` section 8). Cookies, CSRF, secure context and a 5 MiB note verified through
  Caddy with a local CA. `tailscale serve` and ACME issuance are `NOT RUN` (not allowed to touch Tailscale or the network
  config); the owner runs the three `tailscale serve` commands once and checks login.
- **P0-3 `IN_REVIEW`.** Scheduled backups (start-up plus every 24 h, keep 7), off-machine copy and a full restore drill into a second
  empty stack `PASS` on smoke data, including note history and `record-restore`. **Still to do by the owner: one drill on the real
  data, an off-machine copy job, and `.env` stored safely.**
P0-4 `IN_REVIEW` (2026-11-04): `master` pushed to the private repo `Mauz92/atlas` (owner's decision) and the workflow run. **Result of CI run [41823411112](https://github.com/Mauz92/atlas/actions/runs/41823411112) (final head, same outcome as) [41819386512](https://github.com/Mauz92/atlas/actions/runs/41819386512)
(head `f5c94ee`): `e2e-real` `PASS` (76 of 76, 28 min), `backend` `PASS` (10 min: ruff, format, mypy, pytest, pip-audit, OpenAPI export), `containers` `PASS`, `hygiene` `PASS`; `frontend` `FAIL` only at its last step, `npm audit --audit-level=moderate`**
(a `minimatch` advisory in ESLint/openapi-typescript tooling published 2026-10-30, "no fix available", dev-only, `RISKS.md` R-61, owner decision; its lint, types, 1036 vitest and build steps passed). A Vite advisory (GHSA-8g5g-mxqh-grgj) in the same audit was real and fixed
(`vite` 6.4.4 -> 6.4.5, lockfile only). The first four runs failed for CI-only reasons that were fixed in tests/config, none skipped or weakened (`ACCEPTANCE.md` P0-4, R-62). The whole workflow is therefore **not yet green**: one owner decision (R-61) blocks it. **Release table:
CI evidence now exists for REQ-005/006 and the rest of the core; the scores are NOT re-scored here (owner review).** (was: run `e2e-real` on GitHub Actions once ... and re-score REQ-005/006);
P0-5 AUTH-01 (recovery) or keep the `atlas-admin` CLI (verified in the smoke test); P0-6 a two-week dogfood log of defects.
Limits to accept: no calendars, online only, one user.

**Phase 1 — Finish the sync server.** SYNC-05 (resolution log + undo; done 2026-11-03, locally), SYNC-06 (device credentials; AUTH-01 shares
the revoke function), SYNC-07 (Tauri 2 spike on Linux first; Windows and Android need your hardware).
**Phase 2 — Shared client core.** SYNC-08 `packages/sync-core` (TS, framework-free: queue, pull/apply, rebase,
backoff, conflict states) tested by the SYNC-02 simulation against the real server; the web app keeps working.
**Phase 3 — Desktop (Linux + Windows).** SYNC-09: Tauri shell around the existing UI, SQLite store, a notes
folder of real `.md` files with scan-on-start/focus, OS keystore for the device token, device sign-in, per-user
Windows install (no admin), signed auto-update. Costs/limits: Windows code signing is a paid certificate (an
unsigned installer triggers SmartScreen warnings; optional for personal use); Linux AppImage/deb needs no signing.
**Phase 4 — Android.** SYNC-10: Tauri 2 Android, or the installable web app if the spike fails (A-09); local
reminders on-device (M8-04b/d), an optional self-hosted UnifiedPush/ntfy sync hint (M8-04e; FCM rejected by default, ADR-0068 PROPOSED, 2026-11-04), sideloaded APK for personal use (Play Store
has a one-time developer fee); notes live in app-private storage unless the spike proves a shared folder works.
**Phase 5 — Conflict UI and release gate.** SYNC-11 (text-conflict resolver, "changed on another device" undo,
devices list), SYNC-12 (real-device matrix, restore with devices attached).
**Parallel / after:** calendars (M5-00 → M5-03/04/05/07, then M6) need real Google and Microsoft accounts;
the Python version decision (A-07); iOS is out of scope.

**Order (owner priority Sync → Auth → Calendar → Core, 2026-11-03):** Phase 1 → AUTH-01 → Phase 2 → Phases 3–4 with
Calendar interleaved when accounts are available → Phase 0 items P0-4 and P0-1 early because every later step
depends on CI and the Compose stack being green.

### REL-01 — Releases and in-app server updates (owner request 2026-11-10, ADR-0074)
- **Problem.** The server is updated by running `scripts/deploy-update.sh` from the owner's PC, and the desktop clients are built by hand.
  The owner wants releases built by CI (including the desktop clients) and a one-click server update from Settings that loses nothing.
- **Scope.** `.github/workflows/release.yml` (gate, images, Linux desktop, optional Windows, release); `deploy/docker-compose.release.yml`;
  host updater `deploy/updater/` (check, apply, rollback; systemd units; `install.sh`); API `GET/POST /api/system/update*`; Settings > About >
  Server updates; documentation (`DEPLOYMENT.md` 13, `OPERATIONS.md`, ADR-0074).
- **Acceptance.** (1) A tag builds, smoke-tests and publishes images and the Linux clients and creates the release. (2) Settings shows the running and
  newest version and updates on one confirmed click. (3) The update takes a verified backup before any change and a failed start restores the previous
  version and, if it was migrated, the database. (4) A request cannot name another version, a downgrade, or come from a device token.
- **Verification so far.** Updater rules and sequence (fake Docker, `tests/unit/test_updater_agent.py`); API contract (`tests/integration/test_system_update.py`);
  UI (`UpdateSection.test.tsx`); the updater against real Docker in an isolated project (update, then a failing migrating version rolled back with data
  intact; see ACCEPTANCE). **Not verified:** the release workflow (it has never run: do a dry run first), the systemd path unit on the real server, GHCR
  pull with the owner's token, Windows, and an update of the live server.
- **Status: `IN_REVIEW`** until the dry run and the first real update on the server have passed.

### SEC-01 — Independent security audit before any public exposure (owner decision 2026-11-10)
- **Decision.** Atlas stays **private** (tailnet-only; no public listener, no port forwarding, no public DNS record pointing at it) until a real
  security audit has been done and its findings are fixed. The calendar redirect name `galaxia-atlas.duckdns.org` must therefore resolve to the
  server's tailnet address, never to the public IP, and no reverse-proxy `Host` rule may serve Atlas on a public listener.
- **Scope (to plan before it starts).** Threat-model refresh against the real implementation (auth, sessions, device tokens, recovery codes,
  OAuth + token store, ICS fetching/SSRF, sync protocol, notes path handling, desktop shell IPC and updater, Docker/proxy config); an
  independent review (a person or an external service the owner chooses; an AI-assisted review is input, not a substitute); dependency and
  container scanning in CI as blocking gates; authenticated and unauthenticated dynamic testing (OWASP ASVS L2 checklist) on a staging copy;
  rate-limiting and brute-force behaviour behind a proxy (R-46), HSTS and cookie flags; backup/secret handling; incident and key-rotation runbook.
- **Dependencies.** Calendar Stage A built; SYNC-12 release gate; owner chooses the reviewer and budget.
- **Acceptance.** Findings recorded with severity; every critical/high fixed and re-tested; the audit report and evidence referenced from
  `SECURITY.md` and `ACCEPTANCE.md`; only then may the owner decide about public exposure (a separate ADR).
- **Status: `BACKLOG`** (blocks any public deployment).

---

## Immediate Next Tasks

**Owner priority order (2026-11-03): 1. Sync (local-first, ADR-0055), 2. Auth (AUTH-01 plus device credentials for sync clients), 3. Calendar (M5-00 onward), 4. Core (close MU: CI run of `e2e-real` + release re-score). UX-01…UX-08 are all `DONE`. The Sync design and backlog are done (2026-11-03, see the SYNC section, `SYNC_PROTOCOL.md`, ADR-0059 PROPOSED). **Next: SYNC-01 (feed correctness fixes) then SYNC-02 (simulation harness); SYNC-07 (Tauri spike, Linux first) can run alongside; SYNC-03…06 wait for the owner's answers to ADR-0059. AUTH-01 met SYNC-06 at the shared device-revoke function (ADR-0059 D8) and is `DONE` since 2026-11-04.** Milestone MU (usable core): `MU-00` (real-stack journey harness), `MU-01` (task detail and
editing) and `MU-02` (Projects UI), `MU-03` (Tasks page) and `MU-04` (recurrence, subtasks and reminders in the UI) and `MU-05` (command palette, quick switcher and unified search) and `MU-06` (note ↔ task ↔ project linking) and `MU-07` (daily note, templates and Today as home) and `MU-08` (settings and shell polish) are `DONE`; MU itself is not closed (CI run and release re-score outstanding, see the MU exit-criteria evaluation).** See the MU section and ADR-0043 for why this precedes calendar and mobile
work. Everything else is blocked on a resource this environment does not have:

- **M5-00** — validate Microsoft tenant + Google publishing mode with **real accounts** (AR-001). Until
  it unblocks, **M5-03/M5-04** → **M5-05/M5-07/M5-09** and all of **M6** stay `BACKLOG`; they resume
  after MU so calendar events land in already-usable Today/Day/Week views.
- **M8-04 / M8-06 / M8-07 / M8-08** — M8-04 was split on 2026-11-04 (plan in the M8 section; **M8-04a, M8-04b, M8-04e need no hardware and are next once the owner accepts ADR-0068 D2/D7**); native push, Android/iOS clients and the desktop matrix need
  **real devices** (decision A-09, ADR-0068).

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
| A-04 | Compose: forward every setting the API reads (ALLOWED_HOSTS, VAPID_*, EXPORT_DIR, CHANGE_*, …) and bind the API port to 127.0.0.1 | `DONE` | Runtime check done 2026-11-03 (P0-1); more gaps found and fixed, guarded by `test_compose_env.py` |
| A-05 | Fix startup crash on documented `ALLOWED_HOSTS=host` / blank values (list settings now accept comma-separated or JSON) | `DONE` | `tests/unit/test_config.py` (regression, 4 cases) |
| A-06 | Docs: condense roadmap verification narrative to pointers (evidence lives in `ACCEPTANCE.md`); remove stale `project/BACKLOG.md` | `DONE` | `ROADMAP.md` 105 KB → 44 KB; original text in git history |
| A-07 | Decide the supported Python version (image/CI use 3.13; local venv 3.14; `mypy` targets 3.12) | `DONE` (2026-11-13) | ADR-0078: 3.13 runtime, 3.12 minimum, 3.14 not yet supported |
| A-08 | M5-00 real-account validation (AR-001) | `BLOCKED` | DEFERRED to Later (ADR-0076, owner 2026-11-13): Needs owner to supply throwaway Google/Microsoft test accounts |
| A-10 | Function audit; adopt the personal-OS direction; add milestone MU; re-score REQ-005/006 `PARTIAL` (ADR-0043, R-22) | `DONE` | `PRODUCT_SPEC.md` §1.1, `DECISIONS.md` ADR-0043, this section |
| A-09 | Decide mobile strategy: PWA-only v1 vs native Android/iOS (M8-06/07) | `BLOCKED` | Direction set in ADR-0055 (Android via Tauri 2, PWA fallback, iOS out of scope); final choice after the spike |

**Caveats recorded by the audit.**
- M7 and M9 are `DONE` for their buildable scope; M7 sync has not been exercised against real
  calendar data, which depends on M5-00.
- `ATLAS_ENV` defaults to `development`, which accepts the placeholder secrets. Production hardening
  applies only when `ATLAS_ENV=production`; operators must set it (see `DEPLOYMENT.md`).

### AUTH-01 plan — Account recovery by a one-time recovery code (sub-steps 01a-01j)

Owner decision (2026-11-04): a one-time code shown once at setup and regenerable in Settings, stored only as a hash; "Forgot password?"
asks for email + code + new password; a reset revokes every session and every device in the transaction of the password change
(`revoke_all_devices`, ADR-0065), replaces the code, is rate limited and never logs or echoes the code. Decisions: ADR-0067. Each step
was verified before the next (targeted tests, then the whole suite at the end).

| Step | Content | Migration | Status |
|---|---|---|---|
| 01a | Design decisions recorded (format and entropy, hash choice, table, enumeration, limits, rotation, regenerate, CLI fallback, `RECOVERY_ENABLED`, CSRF/cookies) | none | `DONE` (ADR-0067) |
| 01b | Model `RecoveryCode` and migration; tested clean, at the previous revision with a populated schema, constraints, cascade, downgrade, down/up/up | `c9e4a7b2d6f1` (reversible; downgrade drops the table) | `DONE` |
| 01c | `atlas/auth/recovery.py`: generation, normalisation, salted HMAC, `issue_recovery_code`, `apply_password_reset` (shared with the CLI), limiter pruning; unit tests | none | `DONE` |
| 01d | `POST /api/auth/recovery/reset`: one transaction under a row lock, equal work for every refusal, per-address and per-account throttle, CSRF exemption like login; integration tests incl. replay, race, atomicity, enumeration (SQL compared) and five hand mutations | none | `DONE` |
| 01e | Setup returns the code; `GET /api/auth/recovery`, `POST /api/auth/recovery/regenerate`; `RECOVERY_ENABLED` (config, compose, `.env.example`, the compose-env test stays green); `atlas-admin recovery-code` | none | `DONE` |
| 01f | Security and hygiene tests: no secret in logs/errors/exports/DB/dump, cross-user isolation, devices refused, other password changes unaffected | none | `DONE` |
| 01g | `openapi.json` and `apps/web/src/api/schema.d.ts` regenerated; `recoveryApi` client | none | `DONE` |
| 01h | Web: setup gate with `RecoveryCodeReveal` (copy, download, acknowledgement), Forgot password form, Settings → Account recovery row, CSS (tokens only); vitest | none | `DONE` |
| 01i | Real-stack specs (`auth01-recovery.spec.ts`), `createOwner` passes the gate; axe 1440/768/390/360 both themes, 44 px and 16 px | none | `DONE` |
| 01j | Docs (ADR, SECURITY, RISKS, DATA_MODEL, OPERATIONS, OPERATOR_GUIDE, USER_GUIDE, TESTING, ACCEPTANCE, CHANGELOG, `.env.example`), `./scripts/verify.sh`, `test:e2e:real`, `e2e` | none | `DONE` |

**Not built (decided):** server-side tracking of "the owner saw the code" (R-56), e-mail or push confirmation of a reset (no channel), a
shared limiter store (R-57), several codes per account.

---

## Later (after 0.1.0; owner decision 2026-11-13, ADR-0076)

Not scheduled. Each needs the resource named; none blocks the first release.

| ID | Title | Needs | Notes |
|---|---|---|---|
| M5-12 | Manual `.ics` file import (one-shot upload through the existing ICS parser) | nothing external | **`DONE` 2026-11-13** (moved from Later): migration `b7d4e1a8c5f3`, `ImportedIcsAdapter`, `POST/PUT /api/calendar/imports`, Settings > Calendar form with check/replace/remove; evidence in `ACCEPTANCE.md` M5-12. Not tried: real Apple/Proton/Google/Outlook exports |
| M5-00 | Validate Microsoft tenant and Google publishing mode with real accounts | throwaway Google and Microsoft accounts | AR-001 is withdrawn until then |
| M5-03/04/05/09 | Live Google and Microsoft read sync, account connection, change notifications | M5-00; a public callback endpoint (SEC-01) | Adapters exist and are fixture-tested |
| M6-01…08 | Writing events to the providers, conflicts, token recovery, loop prevention, per-provider E2E | M5-00 done | The whole of M6; design rules stay in `CALENDAR_SYNC.md` and AGENTS.md section 10 |
| SEC-01 | Independent security audit | reviewer and budget | Needed before public exposure, also before a public OAuth callback |
| M8-04 push | UnifiedPush/ntfy wake-up for Android | a distributor app | ADR-0075 D7 |
| SYNC-11d | Browser local store (IndexedDB offline mode, ADR-0070 D9) | nothing external | Not needed for 0.1.0; design recorded |
| SYNC-09 Windows | Windows desktop client (installer, Credential Manager, tray) and M8-08 macOS/Windows verification | a Windows machine | ADR-0077: out of 0.1.0; R-36 |
