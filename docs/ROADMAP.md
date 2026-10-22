# Atlas — Roadmap and Backlog

**Status:** Draft for approval (Milestone 0)
**Last updated:** 2026-10-22

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
| M3 | Core task management | `IN_PROGRESS` | Tasks usable as a standalone daily tool |
| M4 | Projects and planning | `BACKLOG` | Notes + tasks + projects form one workflow |
| M5 | Unified read-only calendar | `BACKLOG` | Real calendar data synced safely (no writes) |
| M6 | Bidirectional calendar sync | `BACKLOG` | External event editing reliable for daily use |
| M7 | Cross-device sync and offline | `BACKLOG` | Sync recoverable under realistic failure |
| M8 | Notifications and mobile apps | `BACKLOG` | Platform behaviour tested on real devices |
| M9 | Security, recovery, release | `BACKLOG` | Production-readiness review |

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
- Tasks persist across restarts and devices. ◻
- Recurring completion behaves correctly (future occurrences intact). ◻
- Due dates + time zones correct. ◻
- Mutations transactional; retries do not duplicate. ◻
- Essential workflows work with calendar disconnected. ◻

**Tasks**

| ID | Title | Depends on | Acceptance | Tests | Status |
|---|---|---|---|---|---|
| M3-01 | Task schema + migration | M1-04 | Fields per DATA_MODEL §2.3 | Migration test | `IN_REVIEW` |
| M3-02 | Task CRUD API + idempotency keys | M3-01 | Duplicate key returns original result | Integration | `IN_REVIEW` |
| M3-03 | Task state machine + transitions | M3-02 | Only valid transitions allowed | Unit | `IN_REVIEW` |
| M3-04 | Priorities, due dates, time zones | M3-02 | DST-correct due handling | Unit | `IN_REVIEW` |
| M3-05 | Recurring tasks (RRULE) | M3-03 | Completing an occurrence keeps the series; next generated | Unit + integration | `BACKLOG` |
| M3-06 | Subtasks | M3-03 | Parent/child rules; completion rollup documented | Unit | `BACKLOG` |
| M3-07 | Inbox / Today / Upcoming views | M3-02,M1-06 | Views match spec §5.7; quick capture | Frontend + E2E | `BACKLOG` |
| M3-08 | Task search and filters | M3-02 | Filter by status/priority/date/project | Integration | `BACKLOG` |
| M3-09 | Change log for tasks (client pull) | M3-02 | Incremental pull after revision N | Integration | `BACKLOG` |

**M3-01 verification (2026-10-22).** `tasks` plus the §2.3 task-side tables (`recurrence_series`,
`task_tags`, `task_links`) modelled in `atlas/models/task.py` and applied by migration
`51b31762f974`. `ruff`, `ruff format --check` and `mypy` clean; the model→migration mapping is
checked by `tests/unit/test_task_schema.py` (8 assertions, incl. offline-rendered DDL and
reversibility). `project_id`/`reminder_policy_id` are carried as bare UUIDs — their foreign keys
are added when the `projects` (M4) and reminder-policy (M8) tables exist. The DB-backed
`tests/integration/test_tasks_schema.py` is **`BLOCKED`** here (no PostgreSQL reachable); see
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

**Gate:** tasks usable as a standalone daily tool.

---

## M4 — Projects and Planning

**Goal.** Projects, boards and planning that compose with notes and tasks.

**Deliverables.** Projects; project task lists; Kanban boards; task/project relationships;
derived progress; note-to-project links; daily/weekly planning.

**Exit criteria.**
- Tasks can be organised without forcing project membership. ◻
- Board changes persist and sync. ◻
- Progress is derived consistently (documented formula + tests). ◻
- Today stays simple and responsive. ◻
- Project data exports. ◻

**Tasks**

| ID | Title | Depends on | Acceptance | Tests | Status |
|---|---|---|---|---|---|
| M4-01 | Project schema + CRUD | M3-02 | Project fields per DATA_MODEL §2.3 | Integration | `BACKLOG` |
| M4-02 | Task↔project association | M4-01 | Optional membership; filtering by project | Integration | `BACKLOG` |
| M4-03 | Kanban board (columns from status) | M4-02 | Drag between columns persists; propagates | Frontend + E2E | `BACKLOG` |
| M4-04 | Derived progress calculation | M4-01 | Documented formula; unit-tested | Unit | `BACKLOG` |
| M4-05 | Note↔project links | M2-02,M4-01 | Association survives note rename | Integration | `BACKLOG` |
| M4-06 | Daily/weekly planning views | M3-07,M4-02 | Planning reflects tasks + projects | Frontend + E2E | `BACKLOG` |
| M4-07 | Project export | M4-01 | Projects + tasks exported in open format | Integration | `BACKLOG` |

**Gate:** notes, tasks and projects form one coherent workflow.

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
| M5-00 | Validate MS tenant + Google publishing mode with real accounts | M1-05 | Refresh tokens persist; scopes granted; limitations noted | Manual + recorded evidence | `BACKLOG` |
| M5-01 | OAuth credential store (encrypted) | M1-05 | Tokens encrypted at rest; key external | Unit + integration | `BACKLOG` |
| M5-02 | Provider adapter interface | M5-01 | Common interface; no provider leakage | Unit | `BACKLOG` |
| M5-03 | Google Calendar adapter (read, syncToken) | M5-02 | Pagination, incremental, deletions handled | Adapter tests | `BACKLOG` |
| M5-04 | Microsoft Graph adapter (read, delta) | M5-02 | Pagination, delta, deletions handled | Adapter tests | `BACKLOG` |
| M5-05 | Calendar/account selection UI | M5-03,M5-04 | Select calendars; colour; connect/disconnect | Frontend + E2E | `BACKLOG` |
| M5-06 | Event projection store + sync cursors | M5-02,M1-08 | Cursor advances only after commit | Integration | `BACKLOG` |
| M5-07 | Unified calendar view (day/week/month) | M5-05 | Time-zone-correct display; all-day + recurring | Frontend + E2E | `BACKLOG` |
| M5-08 | Sync status + error surface | M5-06 | Last sync, failures visible in UI | Integration + E2E | `BACKLOG` |
| M5-09 | Change notifications (hints → reconcile) | M5-03,M5-04 | Notification triggers reconcile; never trusted as full log | Integration | `BACKLOG` |
| M5-10 | Periodic reconciliation fallback | M5-06 | Missed notifications recovered by scan | Integration | `BACKLOG` |

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
- Multiple devices converge. ◻ Offline edits retained. ◻ Stale writes detected. ◻ Conflicting
  note edits recoverable. ◻ Deleted entities do not reappear. ◻ Restart preserves queued work. ◻

**Tasks**

| ID | Title | Depends on | Acceptance | Tests | Status |
|---|---|---|---|---|---|
| M7-01 | Per-user change feed endpoint | M3-09 | Pull changes after revision N | Integration | `BACKLOG` |
| M7-02 | Tombstones + retention window | M7-01 | Deletes propagate; no resurrection | Integration | `BACKLOG` |
| M7-03 | Client offline queue (durable) | M7-01 | Edits survive reload/offline | Frontend + E2E | `BACKLOG` |
| M7-04 | Reconnect reconciliation | M7-03 | Pending ops replayed; conflicts surfaced | Integration + E2E | `BACKLOG` |
| M7-05 | Sync status UI | M7-01 | Pending/failed/conflicts visible | Frontend | `BACKLOG` |
| M7-06 | Failure-mode tests | M7-03,M7-04 | Network loss, restart, stale client covered | E2E | `BACKLOG` |

**Gate:** synchronisation recoverable under realistic failure conditions.

---

## M8 — Notifications and Mobile Applications

**Deliverables.** Reminder scheduler; desktop notifications; Android client; iOS client;
push-token management; notification preferences.

**Exit criteria.**
- Reminders work without the web app open (within platform limits). ◻ Time-zone/reschedule
  correct. ◻ Duplicate delivery controlled. ◻ Token/permission failures handled. ◻ Core tasks
  work on Android + iOS. ◻ Desktop verified on Linux/Windows/macOS. ◻

**Tasks**

| ID | Title | Depends on | Acceptance | Tests | Status |
|---|---|---|---|---|---|
| M8-01 | Reminder scheduler (durable) | M1-08,M3-05 | Reminders fire once; cancelled entities skipped | Integration | `BACKLOG` |
| M8-02 | Web Push (VAPID) desktop | M8-01 | Notification delivered; permission handled | E2E | `BACKLOG` |
| M8-03 | Device token registry + invalidation | M8-01 | Invalid tokens pruned | Integration | `BACKLOG` |
| M8-04 | Push delivery (FCM/APNs or Expo relay) | M8-03 | Delivered on real devices; receipts handled | Manual on devices | `BACKLOG` |
| M8-05 | Notification preferences UI | M8-01 | Per-entity timing configurable | Frontend | `BACKLOG` |
| M8-06 | Android client (Expo) | M1-07,M7-03 | Core task workflows work | Device E2E | `BACKLOG` |
| M8-07 | iOS client (Expo) | M8-06 | Core workflows; push via APNs | Device E2E | `BACKLOG` |
| M8-08 | Desktop verify Linux/Windows/macOS | M8-02 | PWA works on all three | Manual | `BACKLOG` |

**Gate:** platform-specific behaviour tested on actual devices.

---

## M9 — Security, Recovery and Release

**Deliverables.** Backup automation; restoration tests; dependency/vulnerability checks; security
review; data export; upgrade docs; user docs; release checklist; known-limitations doc.

**Exit criteria.**
- Notes + DB restored together (demonstrated). ◻ Auth/authz tests pass. ◻ No unresolved critical
  vuln. ◻ All mandatory requirements verified or explicitly recorded incomplete. ◻ Clean install
  reproducible from docs. ◻

**Tasks**

| ID | Title | Depends on | Acceptance | Tests | Status |
|---|---|---|---|---|---|
| M9-01 | Automated DB + Markdown backups | M1-02 | Both stores captured; integrity check | Integration | `BACKLOG` |
| M9-02 | Documented + executed restore drill | M9-01 | Restore verified end-to-end | Manual evidence | `BACKLOG` |
| M9-03 | Full data export | M2,M3,M4 | Notes+tasks+projects exported open-format | Integration | `BACKLOG` |
| M9-04 | Dependency + vulnerability scan | M1-10 | No unresolved critical/high | CI | `BACKLOG` |
| M9-05 | Security review (threat model vs impl) | M9-04 | Controls implemented; findings recorded | Review | `BACKLOG` |
| M9-06 | Upgrade + rollback docs, tested | M1-04 | Upgrade from prior version works | Manual | `BACKLOG` |
| M9-07 | User + operator documentation | — | Install/use/operate documented | Review | `BACKLOG` |
| M9-08 | Release checklist + known limitations | M9-01…07 | Labelled by actual completeness | Review | `BACKLOG` |

**Gate:** production readiness review.

---

## Immediate Next Tasks

- **M3-05** — Recurring tasks (RRULE) and **M3-06** — Subtasks, both depend on M3-03 (`IN_REVIEW`)
  and can proceed in either order.
- **M3-07** — Inbox / Today / Upcoming views (depends on M3-02, M1-06) will use `due_state`.

These are the smallest safe next steps for the current milestone (M3).
