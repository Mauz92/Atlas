# Atlas — Architectural Decision Records

**Status:** Draft for approval (Milestone 0)
**Last updated:** 2026-10-26

Each record states context, decision, consequences and status. Proposed decisions are not
binding until the planning gate is approved. Validation findings from Milestone 0 research are
included with sources.

Legend: **Status** ∈ {Proposed, Accepted, Superseded, Rejected}.

---

## ADR-0001 — Modular monolith with a separate worker

**Context.** The product spans notes, tasks, projects, calendars, sync and notifications.
Microservices would multiply operational overhead for a self-hosted, single-owner deployment.

**Decision.** One FastAPI codebase with explicit internal modules, deployed as two processes
(`api`, `worker`) sharing the same code and PostgreSQL. No message broker, no Kubernetes.

**Consequences.** Simple deployment and reasoning; scales to household size. A module boundary
regression is the main maintainability risk, mitigated by keeping provider code inside adapters
and business logic out of clients.

**Status.** Proposed.

---

## ADR-0002 — Two durable stores: PostgreSQL + Markdown filesystem

**Context.** Notes must remain portable files (REQ-004) while structured data needs
transactions, filtering and recurrence (REQ-005/REQ-006).

**Decision.** Note content lives only in `.md` files; PostgreSQL stores note metadata plus all
structured entities. No third datastore, no search cluster (PostgreSQL FTS initially).

**Consequences.** Clear ownership; portable notes. Requires a reconciliation process between
filesystem and metadata index (`MARKDOWN_STORAGE.md`). PostgreSQL FTS is sufficient at this
scale; a dedicated search engine is explicitly out of scope.

**Status.** Proposed.

---

## ADR-0003 — Markdown editor: CodeMirror 6 (source mode) + renderer

**Context.** The editor must support Markdown source mode, preview, keyboard-first editing and
offline-friendly operation without locking content into a proprietary model.

**Decision.** Use **CodeMirror 6** as the source-mode editor (small, actively maintained,
precise Markdown control) with a Markdown renderer for preview. WYSIWYG options (Milkdown,
TipTap/ProseMirror) are *not* adopted for the core editor in the first release because they add
a document-model layer that risks divergence from the on-disk Markdown.

**Consequences.** Guarantees what the user types is what is stored. Fewer formatting niceties
out of the box; acceptable for a portability-first product.

**Validation (M0).** CodeMirror 6 is a current, maintained, programmable text field with
Markdown support; Milkdown/TipTap remain viable alternatives if WYSIWYG is later required.

**Status.** Proposed.

---

## ADR-0004 — Deployment via Docker Compose

**Context.** REQ-014 requires one documented deployment with minimal operations.

**Decision.** Docker Compose with four services (`web`, `api`, `worker`, `db`) and two
persistent volumes (database, Markdown root). Reverse proxy supplied by existing infrastructure.

**Consequences.** Reproducible and portable. Requires users to run Docker; acceptable for the
target audience.

**Status.** Proposed.

---

## ADR-0005 — Durable background jobs on PostgreSQL

**Context.** Calendar sync, retries and reminders must survive worker restarts without a broker
(ADR-0001).

**Decision.** Use a PostgreSQL-backed durable queue. Primary candidate: **Procrastinate**
(Postgres-native, async-friendly, ASGI/FastAPI integration). Documented fallback: **APScheduler
with a persistent SQLAlchemy job store**, or a small `SELECT … FOR UPDATE SKIP LOCKED` queue if
library maintenance becomes a blocker.

**Consequences / risk.** Procrastinate is **actively flagging a need for additional
maintainers** (maintenance risk, see RISKS.md R-05). Mitigation: keep the queue behind the
`jobs` module interface so the implementation is replaceable; the schema in `DATA_MODEL.md`
(§2.5) is intentionally generic.

**Validation (M0).** Procrastinate confirmed as the leading Postgres-native Python task queue;
maintenance status noted. APScheduler + PostgreSQL persists jobs across restarts as a fallback.

**Status.** Proposed.

---

## ADR-0006 — Microsoft integration via delegated OAuth 2.0 (Graph)

**Context.** REQ-008 requires Outlook/M365 calendar access for personal and work accounts.

**Decision.** Use Microsoft Graph with **delegated permissions** via the **authorization code
flow with PKCE**, requesting least-privilege scopes (e.g. `Calendars.ReadWrite`,
`offline_access`). Store refresh tokens encrypted.

**Validation (M0).** Microsoft documents that **all delegated permissions are valid for work or
school accounts, but not all are valid for personal Microsoft accounts**, and that the
**client-credentials (application permission) flow is not supported for personal accounts**
because admin consent cannot be granted for consumer resources. This confirms the delegated
authorization-code approach and rules out app-only sync for personal accounts.

**Consequences.** Per-tenant app registration and consent needed; some organisations restrict
delegated scopes. Treat tenant policy as a Must-Validate early risk (RISKS.md R-01). A
self-hosted app may need to be registered in the user's own tenant or as a multi-tenant app
with a documented registration procedure.

**Status.** Proposed.

---

## ADR-0007 — Mobile delivery and push strategy

**Context.** REQ-011/REQ-012 require reminders on Android and iOS. Desktop can use Web Push.

**Decision.**

- **Desktop:** PWA with Web Push (VAPID) — free and self-hostable.
- **Mobile:** React Native + **Expo** (kept under review), sending pushes either through Expo's
  relay or **directly to FCM (free) and APNs** from the FastAPI/worker backend.

**Validation (M0).** Expo push is a wrapper over FCM/APNs plus a relay; direct FCM/APNs is
supported and avoids the relay dependency. **APNs requires Apple Developer Program membership**
(annual Apple fee) to sign/deliver builds to devices — an unavoidable platform cost with no
free self-hosted substitute.

**Consequences.** Android push can be free (FCM); iOS push carries a platform cost. The
notification design must handle invalid tokens, delivery receipts and retries. This is why
PRODUCT_SPEC §3.1 qualifies "free to use".

**Status.** Proposed.

---

## ADR-0008 — Google integration, OAuth publishing mode, and its refresh-token caveat

**Context.** REQ-007 requires Google Calendar sync for a self-hosted, single-owner app.

**Decision.** Google Calendar API v3 with OAuth 2.0 authorization code flow, incremental sync
via `syncToken`, and least-privilege scopes (prefer `calendar.events`/`calendar.readonly` over
full `calendar` where possible).

**Validation / critical caveat (M0).** Google's OAuth consent screen **publishing status**
affects refresh-token lifetime: apps left in **Testing** mode issue refresh tokens that **expire
after ~7 days**, forcing frequent re-authentication. Publishing to **Production** avoids the
7-day expiry but, for **sensitive scopes**, presents an "unverified app" warning and is subject
to a **100-user cap** until verification. For a personal single-owner deployment, publishing to
Production (unverified) is the pragmatic path; completing Google verification is required only
if the app is shared broadly. This MUST be tested with a real account in M5.

**Consequences.** A weekly-reauthentication trap if configured naively. Documented as a
milestone-critical operational detail (RISKS.md R-13). Google sensitive-scope handling also
requires the OAuth app and its scopes to be declared before use.

**Status.** Proposed.

---

## ADR-0009 — Provider API cost and terms

**Context.** REQ-002 asks for a free product; the integrations must not impose mandatory cost.

**Validation (M0).** Both APIs are free to call within quota: Google Calendar API is free with
per-project/per-user rate limits and a daily threshold; Microsoft Graph is free within
throttling limits. Neither requires a paid subscription for the intended usage.

**Consequences.** Throttling and quota handling are required (backoff + jitter, pagination).
No paid tier is required for the agreed feature set. Platform costs for iOS remain (ADR-0007).

**Status.** Proposed.

---

## ADR-0010 — External Markdown change detection

**Context.** Users may edit note files outside Atlas. The reconciliation mechanism must not
assume filesystem notifications are reliable.

**Decision.** Treat the filesystem as authoritative, but reconcile via a **periodic scan keyed
by content hash** as the reliable baseline, with filesystem notifications (fsnotify) used only
as an *optimisation* to trigger earlier rescans. Reuse the existing revision/conflict machinery
for any note whose file changed underneath an open editor.

**Consequences.** Bounded scan cost proportional to note count; correctness independent of
platform notification behavior. Detailed in `MARKDOWN_STORAGE.md`.

**Status.** Proposed.

---

## ADR-0011 — Authentication approach

**Context.** REQ-013 requires strong authentication without custom cryptography.

**Decision.** Use a maintained authentication approach: FastAPI security with Argon2id password
hashing, server-side session cookies (HttpOnly, Secure, SameSite) with CSRF protection, plus
optional OIDC support via **Authlib**. No custom crypto or auth protocol.

**Consequences.** Single-user simplicity preserved; OIDC available for users who want it.
Rate-limit auth endpoints. Details in `SECURITY.md`.

**Status.** Proposed.

---

## ADR-0012 — API contract via OpenAPI with generated TypeScript types

**Context.** Frontend and backend must not drift.

**Decision.** FastAPI's OpenAPI schema is the contract; the frontend consumes generated
TypeScript types and a thin client. The client never re-implements business rules.

**Status.** Proposed.

---

## ADR-0013 — Task status is an explicit, server-enforced state machine

**Context.** A task's `status` (`inbox`, `next`, `in_progress`, `completed`, `archived`) drives
views, board columns (M4) and completion. Uncontrolled status writes make those inconsistent.

**Decision.** Transitions are validated server-side against one table
(`services/api/atlas/tasks/state.py`, the canonical source):

- the three active statuses (`inbox`, `next`, `in_progress`) may move among themselves and into
  `completed` or `archived`;
- a `completed` task may be reopened (`in_progress`) or archived;
- an `archived` task may be restored to `inbox` or `next`.

A move to the current status is not a transition and is rejected. An invalid transition returns
`409` with the current status, the requested status and the allowed targets; nothing is changed.
`completed_at` is maintained so that it is set exactly when a task is in `completed`.

**Consequences.** Clients must omit unchanged fields (our `PATCH` uses `exclude_unset`). Board
columns and quick actions must reuse this table rather than inventing their own rules.

**Status.** Accepted (M3-03).

---

## ADR-0014 — Task due-date time-zone semantics

**Context.** A task's due/start instants are stored as UTC (`timestamptz`), but users think in
wall-clock terms ("09:30"). Daylight-saving transitions create a spring-forward gap (times that do
not exist) and a fall-back overlap (times that occur twice), and the calendar day of an instant
depends on the zone.

**Decision.** `services/api/atlas/tasks/timezones.py` is the canonical implementation:

- an aware `due_at`/`start_at` is converted to its UTC instant; a naive one is interpreted as
  wall-clock time in the task's IANA `time_zone` (UTC when unset);
- a wall-clock time inside the DST gap is **rejected** (`400`), rather than silently shifted;
- an ambiguous (overlap) wall-clock time resolves to the first occurrence unless `fold=1` is given;
- the `time_zone` is validated as a real IANA zone at the API boundary (`422` if unknown);
- "today"/"overdue" compare the UTC instant for overdue and the **calendar date in the task's
  zone** for today, so they are correct across DST changes and zone boundaries.

**Consequences.** Clients may send either an offset-aware instant or a naive wall-clock time; the
stored value is always a UTC instant plus the task's zone. Recurrence (M3-05) and date-range views
(M3-07) build on these helpers.

**Status.** Accepted (M3-04).

---

## ADR-0015 — Recurrence engine and recurring-completion semantics

**Context.** Recurring tasks must follow RFC 5545 `RRULE` semantics and, when one occurrence is
completed, must complete only that occurrence and generate the next one — never completing or
deleting the series or its other occurrences (`DATA_MODEL.md` §2.3/§4; AGENTS.md §9). Writing a
custom recurrence engine is explicitly discouraged (AGENTS.md §7.5).

**Decision.**

- **Library.** Use **`python-dateutil`** (`dateutil.rrule.rrulestr`) as the RFC 5545 engine; no
  custom recurrence arithmetic. It is a long-maintained, widely used library, dual-licensed
  **BSD-3-Clause OR Apache-2.0** (free for the intended use), recorded in
  `docs/DEPENDENCIES.md`. It is imported as `from dateutil.rrule import rrulestr` because 3.0.0
  no longer exports the top-level `FREQ`/`MO` names.
- **Model.** The task that first carries a `recurrence_rule` is the **series head** and is also
  its first occurrence; a `recurrence_series` row (`rule`, `dtstart`, `time_zone`, `end_date`,
  `count`) mirrors the series bounds for querying. Every later occurrence is a task whose
  `recurrence_parent_id` points at the head. The RRULE text is authoritative for the pattern and
  its own `COUNT`/`UNTIL`; an explicit `count`/`end_date` is an additional outer cap.
- **Time zones.** Occurrences are computed on the **wall clock of the task's IANA zone** (a task
  repeating at 09:30 stays at 09:30 local across a daylight-saving change) and stored as UTC
  instants, reusing `atlas/tasks/timezones.py` (ADR-0014). A naive `dtstart` is interpreted in the
  series zone; a time inside the DST gap is rejected.
- **Completion.** Arriving at `completed` (a valid transition, ADR-0013) triggers exactly one
  step: the next instant is computed and, when one exists and is not already present, a new
  `inbox` occurrence is created (inheriting the completed occurrence's title/description/
  priority/project/zone, `recurrence_parent_id` = head). There is no successor once `COUNT`/
  `UNTIL`/`end_date` is reached, so the series simply stops; the series row and the head are
  always preserved.
- **Validation and idempotency.** The RRULE is validated at the API boundary (`422` on an invalid
  rule; `400` when a recurrence has no `start_at`/`due_at` anchor). A retried completion carrying
  the same `Idempotency-Key` replays the stored response and cannot duplicate the new occurrence;
  an existing occurrence at the computed instant is never created twice.

**Consequences.** No bespoke recurrence engine to maintain; DST and `COUNT`/`UNTIL` behaviour is
the library's. New occurrences start as `inbox`. Manual edits to an occurrence's due date are not
re-synchronised with the series sequence (documented limitation, `CURRENT_TASK.md`).

**Status.** Accepted (M3-05).

---

## ADR-0016 — Subtask (parent/child) rules and the completion rollup

**Context.** `DATA_MODEL.md` §2.3 models a `Task 1─* Task (subtasks)` relation through
`parent_task_id`, and REQ-005/§5.2 list subtasks. Without server-side rules a client could create a
cycle, link across users, or leave a child orphaned under a deleted parent, and "what does
completing a subtask do to the parent?" would be ambiguous. The FK is `parent_task_id → tasks.id`
`ON DELETE SET NULL` (M3-01, migration `51b31762f974`).

**Decision.** `services/api/atlas/tasks/subtasks.py` is the canonical, pure rule set;
`atlas/tasks/service.py` performs the lookups and enforces it server-side. A violation is a
`TaskValidationError` → `400`, and nothing is changed.

- **Definition and ownership.** A subtask is a Task whose `parent_task_id` points at another Task.
  A parent must belong to the same user. A proposed parent that does not exist, belongs to another
  user, or is soft-deleted is rejected with one message (`parent task does not exist`), so task ids
  cannot be probed across users.
- **No self-parenting.** Setting `parent_task_id` to the task's own id is rejected.
- **No cycles at any depth.** When (re)parenting a task `T` under `P`, `T` must not already be `P`
  or an ancestor of `P`. `P`'s ancestor chain is walked server-side and `T` appearing anywhere in
  it is rejected. A brand-new task can never be its own ancestor.
- **Project inheritance.** A subtask always shares its parent's `project_id`. On create an omitted
  project is inherited from the parent; an explicit project differing from the parent's is
  rejected. On update, re-parenting re-points the subtask's project at the new parent's, and an
  explicitly supplied project must match the parent's. (*Choice:* a subtask inherits the parent's
  project and cannot be assigned a different one while the link exists.)
- **Parent deletion / orphaning.** Deletion is a soft delete (`deleted_at`), so the FK's
  `ON DELETE SET NULL` never fires for API deletes. To keep the FK's intent — children are
  detached, never deleted — soft-deleting a parent promotes its direct, live subtasks to top level
  (`parent_task_id` cleared, `revision` bumped) in the same transaction; grandchildren stay under
  the promoted child. A hard delete performed directly in SQL still clears `parent_task_id` through
  the FK.
- **Completion rollup (exact formula).** Completing subtasks **never auto-completes the parent**:
  the status state machine (ADR-0013) remains the only way to complete a task. Instead a derived
  count is exposed on the task's representation:
  `subtasks_total` = the number of the task's direct, non-deleted subtasks;
  `subtasks_done` = how many of those are `completed`.
  `subtasks_done == subtasks_total` with `subtasks_total > 0` is the client's "all subtasks done"
  signal and has no side effect on the parent. Archived subtasks count towards `total` but not
  `done`. The counts are computed on read; they are never stored.
- **Recurrence interaction (M3-05).** A generated recurring occurrence is a fresh top-level task:
  it copies the completed occurrence's title/description/priority/project/zone but **not** its
  `parent_task_id` and **not** its subtasks. Completing a recurring parent therefore does not clone
  its checklist into the next occurrence. This is the explicit default; changing it is a separate
  decision.

**Consequences.** Clients get a stable, server-computed subtask view
(`GET /api/tasks?parent_task_id=…`) and derived counts on `TaskOut`, and never reimplement the
rules (ADR-0012). Cycles are impossible through the API; the database cannot express acyclicity for
a self-referential FK, so direct SQL could still introduce one — the service is the only writer.
Clients must treat a subtask's project as the parent's.

**Status.** Accepted (M3-06).

---

## ADR-0017 — Primary task views and the "today" query contract

**Context.** M3-07 adds the Inbox / Today / Upcoming views (`PRODUCT_SPEC` §5.7, `ARCHITECTURE` §8).
They must be server-authoritative — clients render what the API returns and never re-implement
business rules (ADR-0012) — and time-zone correct: "today" is a *calendar day in a zone*, while the
API stores UTC instants and only optionally records a task's IANA zone (`DATA_MODEL` §4, ADR-0014).
Two questions follow: where does the *caller's* day come from, and how is a task's due instant
classified? The views also need to know which statuses are "active".

**Decision.** `GET /api/tasks` gains two optional, validated query parameters:

- `view` ∈ {`inbox`, `today`, `upcoming`} — a validated enum, so an unknown value is a `422`;
- `tz` — the caller's IANA zone (the browser's), validated with the canonical `is_valid_time_zone`
  and length-bounded (`422` when unknown); it defaults to UTC.

Classification **reuses** `atlas/tasks/timezones.py` (`due_state`) — no new date arithmetic.
`atlas/tasks/views.py` is the canonical, pure rule set:

- a task's **effective zone** is its own `time_zone` when set, otherwise the caller's `tz`,
  otherwise UTC (`effective_time_zone`). This resolves the two requirements together: the task's own
  zone wins where a task declares one (ADR-0014), and for a zone-less task "today" is the caller's
  calendar day;
- `due_state` (`none`/`overdue`/`today`/`upcoming`) is derived on read (never stored) and attached to
  every `TaskOut`, so clients group without re-deriving dates;
- view membership (`matches_view`): `inbox` → status is `inbox`; `today` → `due_state` ∈
  {`overdue`, `today`}; `upcoming` → `due_state` = `upcoming`. Today and Upcoming exclude
  `completed`/`archived`; Inbox is exactly the `inbox` status.

`view` and the M3-06 `parent_task_id` filter are mutually exclusive (`400`). Filtering by due state
runs in Python through `matches_view` rather than in SQL, so the calendar logic is not duplicated;
this is acceptable at the intended single-user/personal scale.

**Consequences.** The server is the single source of truth for what is overdue/today/upcoming, and
clients render it (ADR-0012). Because a zone-less task is judged in the caller's zone, the *same*
task can appear in different views for two clients in different zones — the intended behaviour. As a
derived field, a replayed idempotent response (M3-02) may carry a slightly stale `due_state`, like
any other computed value. If a dedicated date-range filter is later added (M3-08), it should reuse
`views.py` rather than introduce new arithmetic.

**Status.** Accepted (M3-07).

---

## ADR-0018 — Task list filters and text search contract

**Context.** M3-08 adds search and filters to the task list (`ROADMAP.md` M3-08, `PRODUCT_SPEC`
§5.2). PostgreSQL is authoritative for tasks (`DATA_MODEL` §2.3, ADR-0002) and clients render what
the API returns rather than re-deriving rules (ADR-0012). The listing endpoint already carries
`view`/`tz` (ADR-0017) and `parent_task_id` (M3-06), so the new parameters must *compose* with
those, must not change the unfiltered listing, must be safe against injection, and must be bounded
so a single request cannot ask the server to do unbounded work.

**Decision.** `GET /api/tasks` gains optional, validated query parameters:

- `status` — repeatable and/or comma-separated; each value must be a known `TaskStatus`
  (`inbox`/`next`/`in_progress`/`completed`/`archived`). Values are trimmed, blanks ignored and
  duplicates collapsed; at most 20 values may be supplied.
- `priority` — a single known `TaskPriority` value.
- `due_from`/`due_to` (on `due_at`) and `start_from`/`start_to` (on `start_at`) — *inclusive* UTC
  instant bounds. A value with a time component is used exactly (offsets converted to UTC, no
  offset means UTC). A **date-only** value spans the whole UTC day: `…_from` starts at
  `00:00:00`, `…_to` ends at `23:59:59.999999`. An inverted range is rejected. A task with no
  `due_at`/`start_at` never matches a bound on that field.
- `project_id` — a UUID.
- `q` — a case-insensitive substring match over `title` and `description`, at most 200 characters.
- `limit` — 1…500, default 200.

Every filter is applied in SQL with bound parameters. `q` is translated into an escaped `LIKE`
pattern (`%`, `_` and `\` escaped) and passed through `ilike(pattern, escape="\\")`, so `%`/`_`
match literally and a term can never alter the statement's structure. All the parsing and
normalisation lives in the pure `atlas/tasks/filters.py` (`TaskFilters`, `build_filters`), keeping
the HTTP layer to validation plus error translation.

Invalid values — an unknown status or priority, a malformed or inverted date bound, a malformed
`project_id`, an empty or over-long `q`, an out-of-range `limit` — are rejected with `422` and
change nothing. `view` + `parent_task_id` remains a `400` (ADR-0017). The filters compose with each
other, with `parent_task_id` and with `view` (a view classification runs on the already-filtered
candidate set).

**Ordering.** A listing with no filter keeps its historical capture order `(created_at, id)`. A
listing with at least one filter is ordered most-urgent-first, then by earliest due date
(`NULLS LAST`), then by capture order: a SQL `CASE` rank built from the canonical
`PRIORITY_ORDER`, so the sort and `priority_rank` cannot drift apart. Both orders are total (the
`id` tie-break), so results are deterministic. The views keep their own ordering.

**No index or migration.** No schema change was needed: `user_id`, `status`, `priority` and
`due_at` are already indexed, and the filters run per user at the intended personal scale
(thousands of rows, not millions). A `project_id` index and project-existence validation arrive
with M4, when the `projects` table exists. Postgres full-text search (a generated `tsvector` column
plus a GIN index, as used for notes) was rejected for now: it would need a migration and changes
the matching contract from substring to word/stem matching, which is not what the specification
asks for.

**Consequences.** Clients can build a task search and a filtered task list from one endpoint, and
the rules stay server-authoritative. Because the result is capped by `limit` (default 200), a very
large task list is truncated rather than fully returned — deliberate, and visible in the contract.
Date bounds are UTC instants, so a client that wants "tasks due on 2026-11-02 in
Europe/Amsterdam" sends the UTC instants of that local day; this keeps the time-zone question on
the client, consistent with ADR-0014/ADR-0017, and avoids inventing a second calendar rule.
`project_id` cannot be validated for existence until M4: a malformed id is a `422`, a well-formed
id with no matching tasks is an empty list.

**Status.** Accepted (M3-08).

---

## ADR-0019 — Task change feed: incremental pull contract

**Context.** A client that has already synchronised must be able to fetch only what changed since,
including deletions, instead of re-listing everything (M3-09, and the foundation M7-01/M7-02 build
on). Tasks are PostgreSQL-owned (`DATA_MODEL` §2.3, ADR-0002) and every mutation bumps the task's
integer `revision`; deletion is a soft delete (`deleted_at` tombstone). There is no global
per-user sequence, and adding one would need a migration. The pull must page without gaps or
duplicates, must not leak another user's tasks, must be bounded/validated, and must be read-only.

**Decision.** Add `GET /api/tasks/changes?since=<revision>&limit=<n>`, scoped to the calling user:

- It returns the user's tasks — **including soft-deleted tombstones** — whose `revision` is strictly
  greater than `since`, ordered by `revision` ascending. A task bumped twice between two pulls
  appears once, at its latest revision (the feed is the current row state, not an append-only log).
- The response carries the caller's new high-water mark `next_since` and `has_more`. A client sends
  back `since=next_since` until `has_more` is false.
- `since` is validated to `0…2147483647` (the 32-bit `revision` range) and `limit` to `1…500`
  (default 200). An invalid value is rejected with `422` and changes nothing. The endpoint is
  read-only and strictly user-scoped.

**Cursor correctness under ties.** `revision` is *per task*, so many rows legitimately share one
value (every freshly captured task is revision `1`). Ordering by `revision` alone is therefore not a
total order, and a page boundary must never fall *inside* a run of equal revisions — advancing the
cursor to that revision would skip the rest of the run. The planner
(`atlas/tasks/changes.py::plan_change_page`) always hands out whole revision groups: a page stops at
a revision boundary, drops a partial trailing group (leaving it for the next pull), and, if the
smallest remaining group is larger than `limit`, returns that whole group so the cursor still makes
progress. The page is thus *at most* `limit` tasks, except that a single revision group is never
split. The database query (in `atlas/tasks/service.py::TasksService.changes`) fetches `limit + 1`
rows to detect whether more remains, and the tie-break is the task `id`.

**Tombstones and retention.** Deletion propagates to offline clients as a tombstone (a change item
with a non-null `deleted_at`), which the client applies by removing its local copy. Tombstones are
currently **retained indefinitely**, so a client may resync from `since=0` at any time; a bounded
retention window for devices that have been offline longer than the window is deferred to M7-02
(`DATA_MODEL` §7, D-4). The feed is derived from the task rows themselves; the `ChangeLog` table
(`DATA_MODEL` §2.5) is not used by it (a per-user event log remains an option for M7 if one is
needed).

**No index or migration.** No schema change was needed: the query filters on `user_id` (already
indexed) and `revision`, which runs per user at the intended personal scale (thousands of rows).
A dedicated `(user_id, revision)` index can be added later if a measured need appears.

**Consequences.** Clients can converge on a delta instead of re-listing; the rules stay
server-authoritative (ADR-0012) and the pure paging/parsing logic is unit-testable. Because a page
never splits a revision tie, a client must not assume `len(tasks) == limit`; it pages on
`next_since`/`has_more`. Cross-device sync/offline queue and a retention window remain M7.

**Status.** Accepted (M3-09).

---

## ADR-0020 — Projects table and the `tasks.project_id` ON DELETE behaviour

**Context.** `DATA_MODEL.md` §2.3 defines **Project** (`id`, `user_id`, `name`, `description`,
`status`, `start_date`, `target_date`, `revision`, `created_at`, `updated_at`, `deleted_at`) and a
nullable `tasks.project_id` ("tasks need not belong to a project"). Tasks were created in M3-01 with
`project_id` as a bare UUID precisely so the projects milestone could add the real foreign key.
Milestone 4 introduces projects, so the key can now be created — and its delete behaviour is a
consequential decision: it decides what happens to a user's tasks when a project goes away.

**Decision — schema.**

- `projects` carries exactly the §2.3 columns. `user_id` is `NOT NULL` with
  `ON DELETE CASCADE` (deleting an account removes its projects, matching `tasks`); `name` and
  `status` are `NOT NULL`, `revision` defaults to `1`. `start_date`/`target_date` are `date`
  (calendar days, not instants) and the tombstone is `deleted_at timestamptz`.
- `status` is a small server-validated enumeration — `active`, `completed`, `archived` — with
  `active` as the default. It is not a task-style transition state machine (ADR-0013 governs task
  status only): a project's status is a plain attribute a client may set in any order. The set is
  deliberately minimal and can be extended by migration when a concrete need appears; progress stays
  **derived** and is not stored.
- Indexes: `user_id` (every list/get is user-scoped) and `status`.
- The `projects` table and the `tasks.project_id → projects.id` foreign key are created by one
  versioned migration (`8f1c2a7d5e04`), which downgrades cleanly (drop the constraint, then the
  table). The migration matches the models exactly (`compare_metadata` diff empty).

**Decision — `ON DELETE` is `SET NULL`.** The foreign key is
`tasks.project_id → projects.id ON DELETE SET NULL`. Removing a project must **never** remove the
user's tasks: tasks are independent, user-owned work that merely *may* be filed under a project
("membership is never forced", `PRODUCT_SPEC.md` §5.3), and `CASCADE` would silently destroy user
data — the exact failure `AGENTS.md` §9/§17 and CONTRIBUTING forbid. `SET NULL` instead preserves
every task and clears its association, which is the least destructive, most recoverable outcome. It
also mirrors the existing self-referencing keys on `tasks` (`parent_task_id`, `recurrence_parent_id`
are both `SET NULL`).

**Soft delete vs. the key.** The API's `DELETE /api/projects/{id}` is a soft delete (a tombstone, as
for tasks), so the row is *retained* and the foreign key is not exercised by the normal path. The
`SET NULL` behaviour therefore guards the hard-delete paths that do exist: account deletion
(`users` → `projects`/`tasks` cascade) and any future retention purge. Project tombstone semantics
for its tasks (whether a client should show a task as unfiled when its project is tombstoned) are
settled with the task↔project association work in M4-02; M4-01 deliberately does not touch tasks on
project delete. **Settled in M4-02 — see ADR-0021: the tombstone un-files the project's live tasks.**

**Consequences.**

- A task can only reference a **live project of the same user**: task create/update validates the
  project (unknown or another user's project → `400`), so the new foreign key cannot surface as a
  database error, and a user cannot attach a task to someone else's project. The M3-08
  `project_id` *list filter* keeps its existing semantics — a well-formed unknown id simply matches
  nothing (ADR-0018) — because it is a read filter, not an association.
- Schema-drift tests (`test_migrations_match_models`) and the schema unit/integration tests now
  cover `projects` and the key.
- Kanban board columns (M4-03), derived progress (M4-04), note↔project links (M4-05) and planning
  (M4-06) build on this table; board columns are not part of M4-01.

**Status.** Accepted (M4-01).

---

## ADR-0021 — Task↔project association and what a project tombstone means for its tasks

**Context.** `DATA_MODEL.md` §2.3 makes `tasks.project_id` nullable ("tasks need not belong to a
project") and `PRODUCT_SPEC.md` §5.3 states that membership is never forced. M4-01 added the
`projects` table, the `tasks.project_id → projects.id ON DELETE SET NULL` foreign key, and the task
create/update validation that only a *live* project of the same user may be referenced (ADR-0020).
Two things were deliberately left to M4-02:

1. How a client assigns, moves and removes project membership, and how it reads a project's tasks.
2. What a **soft**-deleted project (tombstone) means for the tasks filed under it. The ordinary
   `DELETE /api/projects/{id}` path never exercises the foreign key, so the key alone cannot answer
   this.

**Decision — association.**

- Membership is set with `project_id` on `POST /api/tasks` and changed with
  `PATCH /api/tasks/{id}`. The update boundary forwards only the fields the client actually sent
  (`exclude_unset`), so an omitted `project_id` leaves membership untouched, an explicit `null`
  clears it ("unfile") and a different UUID moves the task. Each change bumps the task's `revision`,
  so it reaches offline clients through the change feed like any other edit (M3-09).
- Membership is optional and single-valued: a task has at most one project and may have none. The
  subtask rule is unchanged — a subtask always shares its parent's project, so moving a subtask to
  another project (or unfiling it while its parent is filed) is a `400` (ADR-0016).
- An unknown project, another user's project or a deleted project is rejected with `400`
  (`project does not exist`) on create **and** on update, before any mutation, so a rejected
  assignment has no side effects and a user can never file work under another account's project.
- A project's tasks are listed two equivalent ways: the M3-08 `project_id` filter on
  `GET /api/tasks` (a read filter — a well-formed unknown id matches nothing, ADR-0018) and
  `GET /api/projects/{id}/tasks`, which additionally requires the project to exist and to be the
  caller's, reporting an unknown, foreign or tombstoned project as `404`. Both return live tasks
  only, in the same most-urgent-first order, and both are strictly user-scoped.

**Decision — the project tombstone un-files its live tasks.**

`DELETE /api/projects/{id}` stays a soft delete. For its tasks:

- **Tasks are never deleted.** The tombstone only hides the project.
- Every **live** task of the project (`deleted_at IS NULL`) has its `project_id` cleared (set to
  NULL) and its `revision` incremented, in one statement in the same transaction as the tombstone,
  so the change feed delivers the now *unfiled* task to offline clients. This is the end state the
  foreign key's `ON DELETE SET NULL` produces on the hard-delete paths (account deletion, a future
  retention purge), so soft and hard deletion cannot disagree; it also mirrors the existing
  precedent for soft-deleting a parent task, where its live subtasks are promoted to top level
  (ADR-0016).
- Tasks that are **already tombstoned** are left exactly as they are: they are invisible to every
  listing, and bumping them would only re-deliver tombstones. Their `project_id` is therefore
  retained on the row until a hard delete clears it through the foreign key.
- Because membership is cleared, the old project id matches nothing afterwards: the `project_id`
  list filter returns no tasks for it and `GET /api/projects/{id}/tasks` is a `404`. A client that
  had a task filed under the removed project sees an ordinary "task updated" change with
  `project_id: null`, and renders the task as unfiled rather than as belonging to a project it can
  no longer fetch.

**Alternatives considered.** (a) *Keep `project_id` on the tasks.* Rejected: a tombstoned project
is invisible through every endpoint, so a client would hold a permanent dangling reference it cannot
resolve, and the soft and hard delete paths would end in different states. (b) *Delete the project's
tasks.* Rejected outright — silent data loss (`AGENTS.md` §9/§17). (c) *Un-file lazily on read.*
Rejected: a read endpoint must not mutate, and the client would still have to reconcile the
project's disappearance on its own.

**Consequences.**

- **No migration.** The schema already supports the decision (`project_id` is nullable, the foreign
  key is `SET NULL`); only service behaviour and documentation change.
- Un-filing a large project is a single bound `UPDATE` in the same transaction as the tombstone, so
  the project and its tasks cannot be observed half-updated.
- Re-assigning a task to a tombstoned project stays impossible (`400`), so the association cannot be
  resurrected by accident.
- Kanban columns (M4-03), derived progress (M4-04), note links (M4-05), planning views (M4-06) and
  export (M4-07) build on this contract.

**Status.** Accepted (M4-02).

---

## ADR-0022 — Kanban board: placement and the move mechanism

**Context.** `PRODUCT_SPEC.md` §5.3 requires a board view whose "columns derive from task status",
and `ROADMAP.md` M4-03 (the first user-visible M4 surface) requires that dragging a task between
columns persists and propagates. The task status set and its allowed transitions are a server-enforced
state machine (ADR-0013, `atlas/tasks/state.py::TRANSITIONS`); the API already lists tasks with
`status`/`project_id` filters and moves one with `PATCH /api/tasks/{id}` carrying `base_revision`
(ADR-0018, ADR-0021). Two decisions were open: **where** the board lives, and **how** a move is made
in the browser — including the dependency question (`DECISIONS.md` D-3, "board column model detail").

**Decision — columns are the statuses, and the client only *steers*.** A board has exactly the five
canonical columns `inbox`/`next`/`in_progress`/`completed`/`archived`, in that order. `boardColumns`
and the allowed-target table in `apps/web/src/lib/taskStatus.ts` are a **client-side mirror** of
`state.py`; they exist to disable a forbidden target and refuse a disallowed drop, **not** to authorise
moves. The server remains authoritative: it re-validates every transition and a client that guesses
wrong (or holds a stale `base_revision`) simply receives a `409`, which the board shows (ADR-0013,
ADR-0012). No column model is stored anywhere, so D-3 is settled without a schema change.

**Decision — a global board at `/board`.** M4-03 ships one **global** board — all of the caller's
tasks, grouped by status — reachable from a new "Board" navigation item and the `/board` route.
A per-project board was considered and deferred: `PRODUCT_SPEC.md` §5.7 fixes the primary navigation
to Today/Inbox/Upcoming/Tasks/Projects/Calendar/Notes/Search/Settings (adding a "Board" item is a
small, reversible extension of that list), and no project detail route exists yet, so a project board
would need a project picker that is really M4-05/M4-06 scope. The presentational `Board` already takes
a `projectId`-scoped listing from `useBoard(projectId)`, so a project-scoped board can reuse it
unchanged once the project view lands. The board reads the tasks with one `GET /api/tasks` and groups
by status on the client — the columns *are* the statuses, so a per-column request would be five
round-trips for the same data.

**Decision — native HTML5 drag-and-drop, no new dependency.** A card is `draggable` and a column is a
drop zone; a drop is only accepted when `canMove(from, to)` (the mirror of the server table). The
mandatory keyboard alternative is a per-card status `<select>` whose forbidden `<option>`s are
`disabled`, wired to the same `tasksApi.setStatus` call. This satisfies the interaction requirement
without a drag-and-drop library, so no dependency is added (`AGENTS.md` §14; `package.json` and
`DEPENDENCIES.md` are unchanged). A library such as `dnd-kit` would add maintenance and licensing
surface for an interaction native browser events already cover; it can be revisited if a richer
interaction (reordering *within* a column, touch support) is approved.

**Failure handling.** The board never moves a card optimistically: a success replaces the local task
with the server's response, and a failure (a `409` stale revision `→ "changed elsewhere"`, a `409`
invalid transition with the server's reason, or a network error) is surfaced in a visible
`role="alert"` and the card stays in its column. A rejected move is never silently ignored
(`AGENTS.md` §9/§16). Business logic lives in `hooks/useBoard.ts` / `lib/taskStatus.ts`; the
`Board` component renders props only (`AGENTS.md` §7.4).

**Consequences.** A project-scoped board and richer interactions are follow-ups, not part of M4-03.
The board inherits the task listing's `limit` (default 200), so a board larger than that is truncated
until pagination is added. Columns for `completed`/`archived` are shown even when empty, so the full
state machine is always visible.

**Status.** Accepted (M4-03).

---

## ADR-0023 — Derived project progress: the canonical formula

**Context.** `PRODUCT_SPEC.md` §5.3 (REQ-006) requires projects to have "a documented progress
calculation" and `AGENTS.md` §9 requires that "project progress has a documented calculation".
`DATA_MODEL.md` §2.3 states that progress is **derived, not stored** (`completed_tasks / total_tasks`,
"excluding archived"), and the `projects` table deliberately has no progress column (ADR-0020). What
counts as a project's "tasks", what "completed" and "excluding archived" mean, and what progress a
project with no tasks has all needed one documented answer, computed consistently and without a
per-project query when listing projects.

**Decision — the formula and its exclusions.** Progress is derived on every read by
`services/api/atlas/projects/progress.py` (the canonical implementation). For a project, over its
tasks:

- `total` = the number of its tasks that are **live** (`deleted_at IS NULL`) and **not** `archived`;
- `completed` = the number of those tasks whose `status` is `completed` (a subset of `total`);
- `percent` = `round(completed × 100 / total)` to the nearest whole percent, halves rounded **up**;
  when `total` is 0 the progress is `0 / 0` and `percent` is **0** — a project with no countable
  tasks is **not** complete.

Excluded tasks never affect progress: soft-deleted (tombstoned) tasks, `archived` tasks, and tasks
filed under a different project or under none. Archiving a `completed` task therefore drops both its
count and its completion, which is exactly `DATA_MODEL.md`'s "excluding archived". Membership stays
optional (ADR-0021), so an unfiled task belongs to no project's progress. "Completed" is the single
canonical status of the task state machine (ADR-0013), not a board column or a rollup of subtasks.

**Decision — surface and cost.** Every project response (`POST`/`GET`/`GET {id}`/`PATCH` on
`/api/projects`) carries a `progress` object `{total, completed, percent}`. The value is **never
stored or cached**: `ProjectsService.progress(project_ids)` computes every requested project in **one**
grouped `SELECT project_id, status, count(*) ... GROUP BY project_id, status` (user-scoped, live
tasks, restricted to the requested projects), so `GET /api/projects` with N projects stays a fixed
number of queries — there is no per-project count and no N+1. A project with no countable task rows is
absent from the mapping; callers fall back to the zero value.

**Alternatives considered.** (a) *Store a progress column and maintain it on every task write.*
Rejected: a derived value kept in sync is a second source of truth (`AGENTS.md` §7.2) that can drift
after a failed or out-of-order write; `DATA_MODEL.md` §2.3 says derived, not stored. (b) *Expose only
`total`/`completed` and let clients divide.* Rejected: the zero-task case would then be re-decided —
and could differ — in every client; a single server-computed `percent` keeps it consistent.
(c) *Define `percent` for `total = 0` as `100` or `null`.* Rejected: a project with no tasks has no
work done, so `0` (with `total: 0` making it unambiguous) is the honest value and keeps the field a
plain integer.

**Consequences.** The formula and each exclusion are unit-tested (`tests/unit/test_project_progress.py`,
pure helper and the single grouped query) and exercised over HTTP
(`tests/integration/test_project_progress.py`). `percent` is a convenience; `total`/`completed` remain
the canonical data, so a client may render its own fraction. M4-06 planning views consume the same
`progress` object. No migration is needed — nothing is stored.

**Status.** Accepted (M4-04).

---

## ADR-0024 — Note↔project links: the association table and its delete behaviour

**Context.** `DATA_MODEL.md` §2.2 has notes (`NoteIndex`: a stable UUID `id` plus a mutable `path`)
and §2.3 has projects; REQ-006/`PRODUCT_SPEC.md` §5.3 want a project's notes. M2-02 already keeps a
note's identity in `id` and its location in `path`, and `MARKDOWN_STORAGE.md` requires that a rename
"update metadata while keeping stable note ids so links survive". A precedent for a many-to-many
association already exists: `task_links` (`task_id`, `note_id`) is a payload-free join table with a
composite primary key and `ON DELETE CASCADE` on both foreign keys. M4-05 adds the analogous
**note↔project** link, and two things had to be decided: the table/constraint shape, and what a
delete of either side — or the FK's `ON DELETE` — does to an existing link.

**Decision — schema.** Add `note_projects` (`services/api/atlas/models/project.py`, `NoteProject`):

- columns `note_id`, `project_id`, `created_at` (no payload beyond the link's creation instant);
- a **composite primary key `(note_id, project_id)`**, which makes an association **unique per
  pair** (linking twice cannot create a duplicate) — exactly as `task_links` and `note_tags` do;
- `note_id → notes.id` and `project_id → projects.id`, **both `NOT NULL`** and **both
  `ON DELETE CASCADE`**;
- an index `ix_note_projects_project_id`, because the composite PK leads on `note_id` and the
  project→notes listing filters on `project_id`;
- created by **one versioned, reversible migration** (`f2a9c7d14b60`, `down_revision` =
  `8f1c2a7d5e04`) that matches the models exactly (`test_migrations_match_models`).

**Decision — the link references the note's stable `id`, never its `path`.** The association is
keyed on `notes.id`, which a rename never changes, so a link survives a rename untouched; the
schema cannot even express a path-keyed link (there is no `path` column). This is deliberately
different from the *derived* `NoteLink` index (a note's wiki-links), which stores a `target_path`
and must be rewritten on rename; a project membership is a real relationship, not a resolution
hint, and belongs on the stable id. (Verified by `test_the_link_survives_a_note_rename` and the
schema-level `test_a_link_survives_the_note_id_with_a_rename_path_change`.)

**Decision — `ON DELETE CASCADE` on both sides.** A link has no meaning without both ends: it is a
pure association, not an owned entity, so deleting either side's row must remove the link and never
leave a dangling reference. `CASCADE` matches the existing `task_links` precedent (just as
`tasks.project_id` is `SET NULL`, its association rows are independent and may simply disappear).
`SET NULL` is not usable here — both columns are `NOT NULL` parts of the primary key — and deleting
the *other* entity when a link is removed would be silent data loss (`AGENTS.md` §9/§17). The keys
cover the hard-delete paths (account deletion via `users`, a future retention purge).

**Decision — the soft-delete (API) path clears the links explicitly.** The API's `DELETE` is a soft
delete (tombstone) for both notes and projects, so the FK never fires on the ordinary path. Each
side therefore removes its link rows in the **same transaction** as the tombstone:

- `NotesService.delete` deletes the note's `note_projects` rows (the note row itself is retained as
  a tombstone; the storage-trash behaviour is unchanged);
- `ProjectsService.delete` deletes the project's `note_projects` rows, alongside the existing M4-02
  un-filing of its live tasks (ADR-0021). No note and no task is ever deleted.

This mirrors ADR-0021's reasoning: a tombstoned entity is invisible on every endpoint, so a link that
pointed at it would be a permanent dangling reference a client could never resolve. The listings
additionally join the live entity (`deleted_at IS NULL`) as defence in depth. A consequence to note:
recreating a note at the same path (notes can be revived by re-creating the path) does **not** restore
its project links — the link was removed by the delete, and a revived note starts unlinked.

**Decision — the API surface.** `PUT`/`DELETE /api/projects/{project_id}/notes/{note_id}` link and
unlink; `GET /api/projects/{project_id}/notes` lists a project's notes (as `NoteSummaryOut`, in path
order); `GET /api/notes/{note_id}/projects` lists a note's projects (as `ProjectOut` with the derived
`progress`, ADR-0023). Link and unlink are **naturally idempotent** — linking uses an `ON CONFLICT DO
NOTHING` on the composite key and unlinking a missing row is a no-op — so no `Idempotency-Key` header
is needed (both return `204`). Both ends are resolved against the caller before any write: an unknown,
another user's or tombstoned note/project is reported as **`404 Not found`** (matching
`GET /api/projects/{id}/tasks`), with **no side effects**. Every endpoint is strictly user-scoped.

**Alternatives considered.** (a) *One project per note.* Rejected: a note (a meeting note, a research
note) can legitimately relate to several projects. (b) *Key the link on `notes.path`.* Rejected: it
would break on the very rename the milestone must survive. (c) *`ON DELETE SET NULL`.* Not expressible
(both columns are `NOT NULL`), and it would leave orphaned rows that mean nothing without both ends.
(d) *Cascade-delete the note (or project) when the other is deleted.* Rejected outright: silent data
loss. (e) *Keep links to tombstoned entities and filter on read only.* Rejected for the same reason
ADR-0021 rejected it for tasks — the client would hold an unresolvable reference; the link is cleared
on delete, with the read filter kept as a belt-and-braces check.

**Consequences.** A note delete or project delete removes the association (tested, no orphans); a
rename leaves it intact; schema drift is covered by `test_migrations_match_models`; M4-06 planning
views and M4-07 export can consume `GET /api/projects/{id}/notes` / `GET /api/notes/{id}/projects`
rather than re-deriving the relationship. There is no user-visible count or progress effect (progress
stays task-based, ADR-0023).

**Status.** Accepted (M4-05).

---

## ADR-0025 — Day and week planning: routes, boundary and placement

**Context.** `ROADMAP.md` M4-06 adds daily/weekly planning (`PRODUCT_SPEC.md` §5.7/§5.3,
`ARCHITECTURE.md` §8). The server is the single source of truth for task views and due states
(ADR-0012/ADR-0014/ADR-0017): "today" and "overdue" are derived per request, in the task's own IANA
zone when it has one and otherwise in the caller's `tz`. Two questions were open for a *planner*: how
a day or a week is **selected** and **bounded**, and how a task is **placed** on a day, given that
the API's only date filters (`due_from`/`due_to`, ADR-0018) are UTC instants while the user thinks in
local calendar days. A third question was where the views live.

**Decision — routes `/day` and `/week`, navigation items "Day"/"Week".** Both views are plain
routes added next to Today/Upcoming, with navigation buttons (`Previous day`/`Today`/`Next day`,
`Previous week`/`This week`/`Next week`) rather than URL state, matching the existing Views, which
hold no date in the URL. Adding two items to the navigation list (which `PRODUCT_SPEC.md` §5.7 fixes
at Today/Inbox/Upcoming/Tasks/Projects/Calendar/Notes/Search/Settings) is the same small, reversible
extension ADR-0022 already made for the Board. No new API surface: both views read the existing
`GET /api/tasks` (a `view`, or an inclusive `due_from`/`due_to` window) and `GET /api/projects` for
project context.

**Decision — the current day *is* the server's `today` view; other days and weeks are due windows.**
The Day view asks for the server's `today` view when the selected day is today, and for an inclusive
`due_from`/`due_to` window otherwise; the Week view always asks for a window. This keeps the
server-authoritative classification where it matters most (the current day: overdue work carried
forward plus what is due today, each task judged in its own zone) while reusing the documented
date-range filter for any other day. A window is filtered to **open work** (`inbox`, `next`,
`in_progress`), the same "active status" rule the server's Today/Upcoming views apply, so a completed
or archived task never clutters a plan. Both views request the caller's `tz`, exactly as the existing
views do.

**Decision — days are the viewer's local days; weeks are ISO weeks (Monday first).** The window for a
local day is its midnight to the following midnight, converted to UTC instants with `Date` for the
existing `due_from`/`due_to` filters — the *only* date arithmetic the client performs, and it is a
boundary conversion for an existing parameter, not a new rule. Placement is **not** re-derived: a
task is rendered on the day its `due_at` falls on, formatted with `Intl.DateTimeFormat` in the
viewer's zone, reusing the Upcoming view's grouping helper. So a task due 23:30 UTC is planned on the
next local day for a viewer in Berlin, and DST is handled by the platform rather than by offsets.
Both bounds are inclusive on the server, so the closing midnight is also the next day's opening one;
placement is decided client-side in the same zone, so a task due exactly at midnight appears on
exactly one day. Zone correctness therefore rests on using the *same* zone for the window and for
placement — which the app always does, since both come from the browser's zone (`viewerTimeZone()`).
Weekends are ordinary days; the week is the ISO week beginning Monday, consistent with the
`en-CA`/`YYYY-MM-DD` day keys already used by the Upcoming view.

**Decision — project context is a lookup, not a new field.** `GET /api/projects` already returns every
project with its derived `progress` (M4-04/ADR-0023), so the planning views load it once alongside
the tasks and use it for two things: a project tag on a filed task's row and a short "Projects"
summary of the projects the plan touches, each with its derived progress. No task or project response
shape changes, no endpoint is added, and `schema.d.ts` is unchanged. Project context is **non-fatal**:
if that request fails, the plan still renders and the failure is shown as a status message instead of
hiding the day (never silently ignored, AGENTS.md §9/§16).

**Consequences.** The Today view is untouched and stays simple; the Day view is the focused,
navigable version of it (and, for the current day, shows the same overdue/due-today split). Overdue
carry-over is therefore available for *today* but not for an arbitrary future day. A plan is bounded
by the task listing's `limit` (default 200), so a very busy week is truncated until pagination
exists. Because placement is by the viewer's zone, a task that declares its own zone is displayed on
the viewer's day even though the server judged its `due_state` in the task's zone — the same
existing display rule as the Upcoming view. Business logic stays in `lib/planning.ts` and
`hooks/usePlanning.ts`; the Day/Week components render props only.

**Status.** Accepted (M4-06).

---

## ADR-0026 — Project export: the open document format and its version contract

**Context.** `PRODUCT_SPEC.md` §5.8 (REQ-015) requires "full export of notes, tasks, projects and
metadata in open formats", and `ROADMAP.md` M4-07 asks that projects and their tasks export "in an
open format". `OPERATIONS.md` §1 already treats a built-in export as additional portability beside
the PostgreSQL/Markdown backups. M9-03 is the *full* export (notes + tasks + projects); M4-07 is
the projects side. A portability export is only useful if its shape is a **stable, documented
contract** a third party can read without Atlas, so the format and its version must be pinned by a
decision, not left implicit in the code.

**Decision — endpoints and scope.** Two read-only endpoints on the projects router:

- `GET /api/projects/export` — the caller's projects (bounded, below);
- `GET /api/projects/{project_id}/export` — one project, reported as `404` for an unknown, another
  user's or tombstoned project (consistent with `GET /api/projects/{id}/tasks`, ADR-0021).

Both return the **same document shape** and are strictly user-scoped: every query filters on the
caller's `user_id`, so another account's projects, tasks or notes can never appear. Only **live**
rows are exported — soft-deleted (tombstoned) projects, tasks and notes are omitted.

**Decision — the format is JSON with a versioned document envelope.**

```jsonc
{
  "format": "atlas.project-export",  // fixed identifier
  "version": 1,                      // document schema version
  "generated_at": "2026-10-26T12:00:00Z",
  "truncated": false,                // true when the project bound omitted projects
  "projects": [
    {
      "id": "…", "name": "…", "description": null, "status": "active",
      "start_date": "2026-11-01", "target_date": null,
      "revision": 4, "created_at": "…Z", "updated_at": "…Z",
      "progress": { "total": 4, "completed": 1, "percent": 25 },   // derived (ADR-0023)
      "tasks": [ { <task fields, DATA_MODEL §2.3> } ],
      "notes": [ { "id", "path", "title", "revision", "content_hash", "size_bytes" } ]
    }
  ]
}
```

- Every identifier is a lower-case UUID **string** (stable across exports). Every instant is an
  **ISO-8601 UTC** string with a `Z` suffix; `start_date`/`target_date` are ISO-8601 calendar days
  (`YYYY-MM-DD`), matching `DATA_MODEL.md` §2.3 (a `date`, not an instant).
- `tasks` are the project's **documented** task fields with their stored values only (no
  request-relative derivation such as `due_state`), ordered by capture (`created_at`, `id`), so the
  same rows always export identically. `archived` tasks **are** included — they are real data — while
  `progress` follows the canonical formula and therefore excludes them (ADR-0023); the two are
  deliberately independent.
- `notes` are the project's note↔project links (M4-05) as the standard note summary (stable note
  id, current `path`), in path order.
- The document is `JSON` because the data is genuinely nested and typed (projects → tasks/notes,
  display order, `None`s). A **CSV** flat task list was considered and rejected as the primary
  format: it cannot express the nesting, the note links or the typed nulls without a side-channel,
  and it would be a second, weaker contract to maintain. CSV can be derived from the JSON by a
  consumer if desired.

**Decision — one consistent snapshot (no torn read).** The export reads several tables (projects,
tasks, notes, plus the grouped progress count). The service opens a single **REPEATABLE READ**
transaction (`ProjectsService.begin_consistent_read`) and reads everything inside it, so every
statement observes the same point in time. Under PostgreSQL's default READ COMMITTED each statement
takes its own snapshot, and a concurrent write between two of them could tear the document; the
request's read-only transaction is ended and a REPEATABLE READ one begun, which is the only point
an isolation level can be chosen. The reads are otherwise read-only and the connection is HTTP-safe
(no cross-request state).

**Decision — the bound.** The number of projects is bounded by a `limit` query parameter
(1…500, default 200 — the same `DEFAULT_LIMIT`/`MAX_LIMIT` as the project listing). The service
fetches `limit + 1` rows to learn whether the bound cut the result short and reports it as
`truncated`; the document is therefore always a *consistent, self-describing snapshot* — a consumer
knows when it is partial and can narrow the export (`truncated` is never silently dropped data).
Within the bound, each project is exported **complete**: its tasks and notes are fetched with one
query each for every selected project (`… WHERE project_id IN (…)`), so exporting N projects is a
fixed number of queries rather than a query per project, and no per-project task cap silently
truncates a project's work. A single-project export is never truncated. Streaming/NDJSON output is
deferred: a personal export is bounded by the project `limit` and held in memory; a fully streamed
full-account export (with notes content) is M9-03 scope, not M4-07.

**Decision — the version contract.** `format` is a constant that never changes. `version` starts at
`1` and is bumped **only for a breaking change** to the document; every change is recorded in
`CHANGELOG.md` and, if breaking, a new ADR. Additive fields (a new optional key) do **not** bump the
version — a consumer must tolerate unknown fields and must not treat a missing optional field as an
error. The shape is published in the OpenAPI schema (`ProjectsExportOut`) and its TypeScript mirror
(`apps/web/src/api/schema.d.ts`), and the pure builder
(`services/api/atlas/projects/export.py`) is the single source of truth, unit-tested against the
response model so the wire shape and the published schema cannot drift.

**Alternatives considered.** (a) *CSV (flat task list).* Rejected as the primary format (see above).
(b) *One request per project (client loops).* Rejected: N+1 round-trips and no single consistent
snapshot. (c) *No explicit transaction.* Rejected: a torn read is a correctness defect in a data
export. (d) *Unbounded export.* Rejected: an unbounded response is an avoidable memory/DoS surface;
the bound plus `truncated` is honest and safe. (e) *Include tombstones.* Rejected: an export is the
user's *current* data; tombstones are sync plumbing (they remain available through the M3-09 change
feed). (f) *Include note **content**.* Out of scope for M4-07 — note content lives on disk
(Markdown is already portable) and belongs to the M9-03 full export.

**Consequences.** No migration (read-only). OpenAPI and `apps/web/src/api/schema.d.ts` are
regenerated for the two new paths and the `ProjectExportOut`/`ProjectExportTaskOut`/`ProjectsExportOut`
schemas; a second `gen:api` is idempotent. No UI is added (the export is an API contract; a download
button is not required by REQ-015 and is M9-03 scope). M9-03 builds on this document by adding notes
and their content.

**Status.** Accepted (M4-07).

---

## ADR-0027 — Encrypted OAuth credential store: schema, AEAD and key handling

**Context.** M5-01 is the security foundation for the calendar adapters (M5-02…M5-04): Atlas must
store, per user and provider, the OAuth access/refresh tokens it will use to read Google Calendar and
Microsoft Graph. `SECURITY.md` T2 ("stolen OAuth token") and R-SEC-3 ("symmetric key management …
key custody and rotation must be defined before M5") make this the point to settle how tokens are
protected at rest, how the key is held, and how it can be rotated. `AGENTS.md` §7.5 forbids custom
cryptography: a maintained, authenticated-encryption library must be used. `DATA_MODEL.md` §2.1
sketches an `OAuthCredential`, but the concrete table shape, the ciphertext layout and the API
surface were open. The real-account OAuth flows (M5-00) are blocked (AR-001), so this decision is
about the **store**, built and tested with fakes; no provider is contacted.

**Decision — schema.** Add `provider_credentials` (`services/api/atlas/models/credential.py`), one
row per `(user_id, provider)`:

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK | server-generated |
| `user_id` | `uuid` | → `users.id` `ON DELETE CASCADE`; deleting an account removes its credentials |
| `provider` | `varchar(32)` | `google` \| `microsoft` (validated; an enum in the model) |
| `key_id` | `varchar(64)` | the encryption key **version** that sealed this row (rotation) |
| `ciphertext` | `bytea` | AES-256-GCM seal of the JSON token bundle |
| `scopes` | `text[]` | granted OAuth scopes (not secret) |
| `access_expires_at`, `refresh_expires_at` | `timestamptz` | token expiry (not secret) |
| `created_at`, `updated_at` | `timestamptz` | via the shared `TimestampMixin` |

A **unique constraint on `(user_id, provider)`** enforces one credential per pair; its index also
serves the user-scoped lookups, so no separate `user_id` index is created. The table is created by
one versioned, reversible migration (`c7d18e93a4f2`) that matches the models exactly
(`test_migrations_match_models`).

**Decision — a single AEAD ciphertext, not per-token columns.** `DATA_MODEL.md` §2.1 sketched
separate `encrypted_refresh_token`/`encrypted_access_token` columns. A **single** `ciphertext` is
used instead: the access token, refresh token and token type are serialised to one small JSON object
and sealed as a unit. This keeps the secret material in exactly one authenticated blob (nothing can
be forgotten or left in clear), lets the bundle evolve (e.g. an `id_token`) without a migration, and
re-seals atomically on a refresh. `scopes` and expiry are **not** secret and stay queryable columns,
matching §2.1. (`DATA_MODEL.md` §2.1 is updated to reflect this.)

**Decision — library and construction.** Use **`cryptography`** (Apache-2.0/BSD), a maintained,
widely used library, and its high-level **`AESGCM`** (AES-256-GCM), an authenticated cipher — no
hand-written crypto (`AGENTS.md` §7.5). Each ciphertext is `nonce (96 random bits) || ciphertext+tag`.
The service also passes **associated data** binding the blob to `provider-credentials:<user>:<provider>`,
so a ciphertext moved onto another user's or provider's row fails to authenticate rather than
substituting a credential. Decryption failures (tampering, wrong key, truncation, AAD mismatch) raise
`DecryptionError`, surfaced as a generic `500` — never as garbage and never echoing the plaintext.

**Decision — key handling and rotation.** The key is held **outside the database** in configuration
(`Settings.token_encryption_key`) and is never stored in the DB, returned by an API or logged
(`.env.example` documents a strong random value; production rejects the placeholder, reusing the
existing `validate_for_runtime` check). A 256-bit key is derived with **HKDF-SHA256** (a maintained
KDF), binding the derived key to its `key_id` (`Settings.token_encryption_key_id`, default `v1`).
The **`key_id` is recorded in each row**, so rotation is feasible: a new active key is configured,
the retired key is listed in `Settings.token_encryption_previous_keys`, and rows still sealed with
the old key stay readable until they are re-sealed (an `upsert`/`refresh` re-seals with the active
key; rows whose `key_id` is unknown fail closed). This resolves R-SEC-3.

**Decision — service and API surface.** `ProviderCredentialsService` (`atlas/calendar/credentials.py`)
provides typed **upsert / read / refresh / delete**, strictly user-scoped (every query filters the
caller's `user_id`, so another user's credential is a `NotFound` and cannot be probed). It validates
at the boundary (known provider, at least one token, bounded token/scope lengths). The read path
(`read`) returns decrypted tokens to in-process adapters only; `TokenBundle.__repr__`/`__str__`
redact the tokens, and no domain error message contains token or key material. The API is the
**minimum to persist credentials safely**: `PUT /api/calendar/credentials/{provider}` (upsert — one
row per pair, naturally idempotent), `GET` (metadata for one / list) returning only
`ProviderCredentialOut` (provider, key id, scopes, expiry, `has_refresh_token`, timestamps — **no
tokens, no ciphertext**), `POST …/{provider}/refresh` (record a refresh result the caller already
performed — the endpoint does **not** contact a provider), and `DELETE …/{provider}` (hard delete,
`404` when absent). The FastAPI request-validation handler additionally strips the `input` value from
`422` bodies on `/api/calendar/credentials*`, so a rejected over-long token is never echoed back
(`SECURITY.md` T2). No adapter, selection UI or projection store is added (those are M5-02…M5-06).

**Alternatives considered.** (a) *Fernet.* Still maintained and correct, but AES-GCM is the
requested primitive and `AESGCM` gives explicit nonce/AAD control; Fernet's base64 envelope and
built-in timestamp add nothing here. (b) *Two ciphertext columns (access/refresh).* Rejected: two
independent blobs that can drift, a second AAD binding and a migration on every bundle change, for
no benefit over one authenticated object. (c) *Store the key in the database (or in the row).*
Rejected outright: it defeats "encryption at rest" — a database leak would include the key.
(d) *`revoked_at` tombstone instead of delete.* Rejected: a credential has no offline-client meaning,
so retaining ciphertext after disconnect is pure liability; provider-side revocation belongs to the
account flow (M5-05). (e) *Return tokens from the API.* Rejected: the browser never needs them, so
exposing them only widens T2. (f) *Custom encryption.* Forbidden (`AGENTS.md` §7.5).

**Consequences.**

- New dependency `cryptography` (bounded `>=50,<51`; that floor clears the advisories `pip-audit`
  reports against earlier 4x wheels), recorded in `DEPENDENCIES.md`.
- `TOKEN_ENCRYPTION_KEY` becomes load-bearing: losing it makes stored credentials unreadable, so it
  must be backed up separately (documented in `DEPENDENCIES.md`/`SECURITY.md`/`.env.example`).
- The schema-drift and schema unit/integration tests now cover `provider_credentials`.
- M5-02 (adapter interface) and M5-03/M5-04 (adapters) read tokens through this service; M5-05
  (selection UI) drives connect/disconnect against the API. Real-account validation remains M5-00.

**Status.** Accepted (M5-01).

---

## ADR-0028 — Calendar adapter contract, neutral event model and error taxonomy

**Context.** M5-02 is the seam between Atlas and Google Calendar / Microsoft Graph. `AGENTS.md` §7.3
requires provider-specific logic to stay behind adapters and application services to depend on stable
internal interfaces; `CALENDAR_SYNC.md` defines the semantics those adapters must deliver
(pagination, incremental cursors advanced only after commit, deletions/tombstones, retry/backoff,
token-expiry handling); `DATA_MODEL.md` §2.4 sketches the projection/mapping tables. The concrete
interface, the neutral value types and the retry classification were open. M5-00 (real accounts) is
`BLOCKED` (AR-001), so this decision is about the **shape** of the seam, built and tested with a fake.

**Decision — one Protocol, three operations.** `atlas/calendar/adapter.py` defines `CalendarAdapter`,
a `@runtime_checkable` `Protocol` (structural typing, so M5-03/M5-04 need not inherit from a base
class): `list_calendars() -> Sequence[Calendar]`;
`list_events(calendar_id, *, cursor=None, page_token=None, page_size=None) -> EventPage`; plus
`provider: str` and `cursor_type: CursorType`. Nothing provider-specific is in the signature — no SDK
object, no provider enum, no `syncToken`/`deltaLink` name.

**Decision — pagination and cursors are distinct.** A **page token** walks one listing call
(transient); a **cursor** is the durable incremental token (`sync_token` | `delta_link` |
`history_id`, matching `SyncCursor` in DATA_MODEL §2.4). `EventPage.next_cursor` is populated **only
on the final page**, matching Google's and Graph's real behaviour, so the sync layer persists a
cursor only after every change in the call is committed (CALENDAR_SYNC §4: never advance in a way
that skips unprocessed changes).

**Decision — neutral value types.** `atlas/calendar/types.py` holds frozen dataclasses: `Calendar`;
`Event` (id, calendar id, provider, summary, aware `start`/`end` instants, IANA `time_zone`,
`is_all_day`, `status`, `etag` = provider version, `updated`, `recurrence_id`, `recurrence_rule`,
`ical_uid`); `EventDeletion` (tombstone); and `EventPage`. Instants must be timezone-aware and
`end >= start` (validated in `__post_init__`), so a timezone bug fails loudly at the boundary rather
than silently in the projection. Deletions are a separate type surfaced on the page, so "the page was
short" can never be misread as "everything else was deleted" (DATA_MODEL §5).

**Decision — an error taxonomy the sync layer can act on without provider knowledge.**
`atlas/calendar/errors.py` maps every provider failure to a `ProviderError` subclass carrying a
`RetryDisposition`:

| Error | Disposition | Sync behaviour |
|---|---|---|
| `TransientProviderError` | `retry_backoff` | bounded exponential backoff + jitter |
| `RateLimitedError` (`retry_after`) | `retry_after` | honour `Retry-After`, else fall back to backoff |
| `AuthExpiredError` | `reauth` | request re-authentication; do not blind-retry |
| `PermanentProviderError` | `permanent` | surface to sync status; terminal |

`retry_delay_for(error, attempt)` reuses the existing `atlas.jobs.queue.backoff_delay`, so the backoff
policy stays in one place. Contract/configuration errors (`UnknownProviderError`, `AdapterError`) are
a separate hierarchy from runtime provider failures.

**Decision — registry/factory by provider name.** `AdapterRegistry` selects an adapter by canonical
(lower-cased, trimmed) provider name; `build_adapter` uses a process-wide `default_registry()` that
M5-03/M5-04 register their factories into. An unregistered provider raises `UnknownProviderError`
naming the known providers; a duplicate registration is refused unless `replace=True` (used to
substitute a fake in tests). The credential store remains the only place OAuth tokens live: an
`AdapterFactory` receives the `StoredCredential` the caller read through `ProviderCredentialsService`
(ADR-0027).

**Decision — an in-memory fake as a first-class test double.** `atlas/calendar/fake.py::
FakeCalendarAdapter` implements the contract over an append-only change log: it pages, honours
incremental cursors and surfaces tombstones, and its cursor is the revision a pass *started* at, so a
change made while the caller pages is returned by the next pass and can never be skipped. It is
exported (`atlas.calendar.FakeCalendarAdapter`, `fake_adapter_factory`) for reuse by the M5-06
projection/sync tests.

**Alternatives considered.** (a) *An ABC base class.* Rejected: a Protocol keeps adapters
structurally decoupled while still giving `isinstance` checking and strict typing. (b) *Pydantic
models for the neutral types.* Rejected: these are internal value objects, not a serialised API
contract, so frozen dataclasses are lighter and Pydantic stays at the HTTP boundary. (c) *Plain
dicts.* Rejected: loses the type safety and the boundary validation that catch timezone/version
mistakes. (d) *A single `status="cancelled"` flag instead of a tombstone type.* Rejected: providers
differ (Google returns cancelled events, Graph returns `@removed` entries); an explicit `EventDeletion`
makes removal unambiguous. (e) *A vendor-neutral model from a third-party library.* Rejected: none is
maintained for this, and it would add a dependency for a small, well-understood shape (AGENTS.md
§7.5/§14). (f) *Bake Google/Microsoft types into the interface.* Rejected: exactly the leakage
AGENTS.md §7.3 forbids.

**Consequences.**

- No dependency is added (no provider SDK).
- M5-03/M5-04 implement `CalendarAdapter` and register factories; M5-06 consumes the contract and the
  fake. The `Event`/`Calendar` fields align with the `ExternalEvent`/`CalendarSource` projections in
  DATA_MODEL §2.4.
- Real-provider compatibility of the cursor/etag/status mapping remains unverified until M5-00
  unblocks.

**Status.** Accepted (M5-02).

---

## ADR-0029 — Event projection store, sync cursors and the "advance only after commit" mechanism

**Context.** M5-06 must persist provider events as a **projection** and advance each provider's sync
cursor **only after the corresponding changes have committed** (AGENTS.md §10; `CALENDAR_SYNC.md` §4:
"a cursor is never advanced in a way that can permanently skip unprocessed changes";
`ARCHITECTURE.md` §6.3; `DATA_MODEL.md` §2.4 sketches `ExternalEvent`/`SyncCursor`). M5-02 delivered
the adapter contract, the neutral `Event`/`EventDeletion`/`EventPage` types and the fake; M5-00 (real
accounts) is `BLOCKED` (AR-001), so the mechanism is built and verified against the fake and a real
PostgreSQL. The concrete schema and the transaction discipline were open.

**Decision — two tables, matching DATA_MODEL §2.4 with the M5-02 neutral fields.**
`external_events` (model `ExternalEvent`) stores the projection with the exact neutral-event fields:
`provider`, `external_event_id`, `calendar_id`, `summary`, `start_at`/`end_at` (aware instants),
`time_zone` (IANA), `is_all_day`, `status`, `etag` (provider version), `ical_uid`, `recurrence_id`,
`recurrence_rule`, `source_updated_at` (provider `updated`), `last_synced_at`, `deleted_at`
(tombstone) and the `TimestampMixin` timestamps. It is **unique per
`(user_id, provider, external_event_id)`** (`uq_external_events_user_provider_external_event_id`).
`sync_cursors` (model `SyncCursor`) is **unique per `(user_id, provider, calendar_id)`**
(`uq_sync_cursors_user_provider_calendar`) and holds `cursor_type`, `cursor_value`,
`last_success_at` and `last_error`/`last_error_at`. Both `user_id` foreign keys cascade on account
deletion. The columns are plain `String`/`Text`/`Boolean` (not the neutral enums) so the models carry
no dependency on `atlas.calendar.types`; the service supplies the enum values. `cursor_value` is
nullable because a cursor row may exist (recording an error) before the first successful baseline.
The migration `9d2f4b6a1c37` is versioned and reversible.

**Decision — the projection is Atlas-side and a deletion is a tombstone.** A provider deletion is
applied by setting `deleted_at`; the row is never hard-deleted on the sync path, so a short page can
never be misread as "everything else is gone" (`DATA_MODEL.md` §5) and the user's own data is never
removed. Re-seeing a previously deleted event clears `deleted_at` (revival). A deletion for an event
that was never projected is a no-op — there is no local data to remove.

**Decision — apply and cursor-advance share one transaction; the service owns the boundary.**
`CalendarSyncService.sync_calendar` (a) reads the stored cursor, (b) drains **every page** of one pass
from the adapter, keeping the events, the tombstones and the durable `next_cursor` the contract emits
**only on the final page**, (c) upserts the events and tombstones on the unique key **and** advances
the cursor (an `INSERT … ON CONFLICT DO UPDATE` on the cursor row), then (d) commits **once**. If
anything raises after applying and before committing, the transaction is rolled back, so the cursor
is unchanged and the next pass re-fetches exactly the same changes — nothing is skipped. `next_cursor`
is persisted verbatim; when the final page carries none, the stored value is left as it was (the
service never invents a cursor). The failure path records `last_error`/`last_error_at` on the cursor
row in its **own** transaction and never touches `cursor_value`/`last_success_at`, so recording an
error cannot advance (or rewind) the cursor; this is the durable state M5-08 will surface. A change
that lands *during* paging is deferred by the adapter's own cursor semantics (the returned cursor is
the revision the pass started at), so it is picked up next pass.

**Decision — idempotency is enforced at two levels.** The unique key plus `ON CONFLICT DO UPDATE`
makes re-applying a change incapable of creating a duplicate projection; and a pure rule
(`atlas/calendar/projection.py::event_is_unchanged`) treats a row that already records the same
provider version — the same `etag` when the provider supplies one, otherwise the same
`source_updated_at` — as a no-op, so a re-sync does not churn unchanged rows.

**Decision — strict user scoping.** Every query in the service filters on the caller's `user_id`, and
both unique keys are scoped by `user_id`, so one user's projections/cursors are invisible and
non-conflicting with another's.

**Alternatives considered.** (a) *Store the full provider payload (JSON) instead of typed columns.*
Rejected: the projection exists to render and reconcile; typed columns align with `DATA_MODEL` §2.4
and keep time-zone/all-day typing. (b) *Advance the cursor in a second transaction after the apply.*
Rejected: that is exactly the window AGENTS.md §10 forbids — a crash between them would skip changes.
(c) *Hard-delete on a provider deletion.* Rejected: loses the user's last-known data and makes a
missing page indistinguishable from a mass deletion. (d) *A single `event_projection` table with the
cursor on the calendar row.* Rejected: there is no `CalendarSource` table yet (M5-05); keying the
cursor on `(user, provider, calendar_id)` keeps M5-06 self-contained and matches the contract's
calendar-id key. (e) *A `ChangeLog`-style event table.* Rejected as out of scope — the projection is
the state, not a log (the M3-09 change feed handles client pulls separately).

**Consequences.**

- No dependency is added; no provider is contacted.
- Real `syncToken`/`deltaLink` expiry (a `410`/`400` → full resync) and the exact provider field
  mapping remain unverified until M5-03/M5-04 land after M5-00 unblocks.
- M5-08 consumes the cursor's `last_success_at`/`last_error`; M5-10 (reconciliation) and M6 (writes)
  build on the projection.

**Status.** Accepted (M5-06).

---

## ADR-0030 — Sync status read model and the manual sync trigger

**Context.** M5-08 must make calendar sync **observable** (AGENTS.md §10 "observable sync state";
`ARCHITECTURE.md` §6.3 step 4 "surface to sync status"; `CALENDAR_SYNC.md` §3 "show sync status and
failures"). M5-06 already writes the durable state this needs — the `sync_cursors` row
(`last_success_at`, `last_error`/`last_error_at`, `cursor_value`) — and M5-01 stores whether an
account is connected (`provider_credentials`). The open questions were the shape of the status, its
state vocabulary, and how (and whether) a manual sync trigger should be exposed. M5-00 (real
accounts) is `BLOCKED` (AR-001), so this is built and tested against the fake and a real PostgreSQL.

**Decision — derive the status on read; never store a second copy.** `atlas/calendar/status.py`
turns the existing rows into a typed status (`SyncStatusService`). There is **no new table and no
new column**: the status is a pure function of the M5-06 cursor rows plus credential presence, so it
can never disagree with what the sync actually did. It is strictly user-scoped (every query filters
on the caller's `user_id`). `GET /api/calendar/sync-status` reports, per provider/calendar:
`connected`; `last_success_at` (UTC); `state`; `cursor_health`; and the last error (a bounded,
content-free message).

**Decision — a state vocabulary limited to what the rows can prove.** `state` is `never_synced`
(no successful baseline), `idle` (the most recent outcome was a success) or `error` (the most recent
outcome failed). A recorded error is the most recent outcome *because* M5-06 clears `last_error` on
every success, so `last_error IS NOT NULL` is decisive. `cursor_health` is `ok` (a baseline cursor
exists, no error), `missing` (no cursor yet) or `error`. A durable **`in_progress`** marker is
deliberately **not** reported: a sync runs synchronously inside one request/worker and persists no
running flag, so any "in progress" value would be invented rather than derived (AGENTS.md §2/§16).
A durable running marker arrives with the scheduled/reconciled sync (M5-10).

**Decision — a manual trigger over the registry seam, naturally idempotent.** `POST
/api/calendar/providers/{provider}/sync` reads the caller's credential, builds the adapter through
the M5-02 `AdapterRegistry`, and drains every calendar the account exposes through the M5-06
`CalendarSyncService` (which owns the cursor-safety transaction). It is **naturally idempotent** —
a repeat re-applies the same changes on the projection's unique keys and never duplicates an event —
so no `Idempotency-Key` is required (the same reasoning as the M5-01 credential upsert). It never
contacts a provider; in tests the registry is overridden with the fake.

**Decision — error mapping and secret safety.** `CredentialNotFoundError` → `409` ("provider is not
connected"), `UnknownProviderError` (no adapter built — M5-03/M5-04 pending) → `503`, a
`ProviderError` → `502` with its content-free message (ADR-0028), an unknown provider path value →
`422`, a `CredentialDecryptionError` → `500`. The status and trigger responses carry **counts and a
content-free message only** — never a token, a ciphertext or a raw cursor value; the trigger response
reports `cursor_advanced` (a boolean) rather than the opaque cursor. The `last_error` value is the
same bounded (`≤ 500` char) diagnostic M5-06 records (ADR-0029).

**Alternatives considered.** (a) *A `sync_status` table written by the sync.* Rejected: a second
source of truth that can drift from the cursor row, which is exactly what AGENTS.md §2/§7.2 forbid.
(b) *An `in_progress` column on `sync_cursors`.* Rejected for now: with a synchronous trigger it is
never observable, and a marker that lingers after a crash would lie; it belongs with the scheduled
sync (M5-10). (c) *Expose the raw `cursor_value` in the status.* Rejected: an opaque sync token
grants continued incremental access; it is not needed by the client and is safest omitted.
(d) *A background-job trigger via the durable queue.* Rejected as out of scope for M5-08 — the
registry seam is the small, honest step, and the real adapters (M5-03/M5-04) do not exist yet.

**Consequences.**

- No dependency is added; no provider is contacted; no migration is needed.
- The status reflects real sync outcomes today (M5-06) and is the surface M5-09/M5-10 will feed
  through when notifications/reconciliation exist.
- M5-05/M5-07 (the event views) remain separate; `/calendar` shows status only for now.

**Status.** Accepted (M5-08).

---

## ADR-0031 — Periodic reconciliation: durable scan job + the durable running marker

**Context.** Provider change notifications (M5-09) are hints, not a guaranteed change log
(`AGENTS.md` §10; `CALENDAR_SYNC.md` §9): a notification can be lost, delayed or never delivered, so
a missed change must be recoverable without it. Separately, M5-08 deliberately did **not** report an
`in_progress` state, because a synchronous sync persisted no running flag and any such value would
have been invented. Both needs land in M5-10.

**Decision — a durable, scheduled scan.** A `calendar_scan` job runs on the durable queue
(M1-08, ADR-0005) and is re-scheduled by `ensure_recurring_jobs` in the worker, so it survives a
worker restart. `CalendarReconciliationService.scan` enumerates every `(user, provider)` holding a
stored credential, lists that account's calendars through the M5-02 registry seam, and re-syncs the
ones **due** by running the M5-06 `CalendarSyncService` from the **stored cursor**. The cursor stays
the source of truth: the scan only *triggers* a pass, and the pass advances the cursor only after its
changes commit (ADR-0029). A scan is therefore safe to run at any time and is never trusted in place
of the cursor.

**Decision — the durable running marker.** A pass sets (and commits, in its own transaction)
`sync_cursors.sync_started_at` before it runs, and clears it in a `finally`. The marker lives on the
same row the M5-08 status already derives from — no parallel source of truth (ADR-0030). It is
bounded by a freshness window (`calendar_sync_stale_seconds`, default 900 s): inside the window the
status may report `in_progress`; past it the marker is **stale** — ignored by the status (a crashed
run cannot lie) and a cause to re-scan the calendar.

**Decision — due-selection and isolation.** A calendar is due when it has never synced, when its last
success is older than `calendar_reconcile_seconds` (default 300 s), when its last outcome was an error
(retry), or when it carries a stale marker (recover a crashed run); it is **not** due while a live run
is underway, so a slow pass is never double-run. A provider with no registered adapter (M5-03/M5-04
pending) or an unreadable credential is skipped and counted `unavailable`, and one calendar's failure
is recorded and retried next scan — neither aborts the whole scan. Every query is user-scoped.

**Schema.** `sync_cursors.sync_started_at` (`timestamptz`, nullable), added by the reversible
migration `b7c2e1a9f4d0`.

**Status.** Accepted (M5-10).

---

## ADR-0032 — Per-user change feed: a monotonic per-user cursor (`change_log` + `users.change_seq`)

**Context.** M7-01 needs a single per-user feed so a client can pull everything that changed after a
cursor it holds (`PRODUCT_SPEC.md` §5.5). The M3-09 task pull used the per-entity `revision`, which is
**not** globally ordered — two rows' revisions are unrelated — so it cannot give one total order across
entity types (tasks, projects, notes metadata, links). A cross-entity feed needs a per-user monotonic
ordering.

**Decision — a per-user monotonic cursor.** Add `change_log` (one row per changed entity, keyed
`(user_id, entity_type, entity_id)`) plus `users.change_seq` (`bigint`, the per-user counter). Each
mutation that must be visible to clients calls `ChangeRecorder`, which advances `users.change_seq`
(`UPDATE … + 1 RETURNING`) and upserts the entity's `change_log` row **in the same transaction** as the
mutation, stamping the new `seq` as the entity's cursor. Because the cursor is allocated inside the
mutation's transaction and is unique per user (`uq_change_log_user_id_seq`), ordering by it is a total
order — two same-user recording transactions cannot interleave cursors — so a page boundary can never
split a tie and paging from `next_since` is gap- and duplicate-free.

**Decision — one row per entity, not an append-only stream.** The feed is the *current change state*:
a row is upserted on every mutation, so an entity bumped twice between two pulls appears once, at its
latest cursor. `operation` is `upsert` for a create/update and `delete` for a soft delete (tombstone),
so deletions propagate. A `delete` row is retained until the M7-02 retention window purges it, so a
client may resync from `cursor=0` while tombstones are kept (there is no purge yet, so tombstones are
retained indefinitely today).

**Decision — the vocabulary and the boundary.** `entity_type` is a validated enumeration (`task`,
`project`, `note`, `note_project_link`, plus a reserved `task_note_link` whose mutation endpoints do
not exist yet); `entity_id` is a string so a pair link can use `"{note_id}:{project_id}"`.
`GET /api/changes?since=&limit=` is read-only, strictly user-scoped, and bounds `since` (0…2^63−1) and
`limit` (1…500) at the boundary (`422` with no side effects).

**Schema.** Migration `d4e8b2c6f913`: `change_log` (FK `users` CASCADE, composite PK, unique
`(user_id, seq)`) and `users.change_seq` (`bigint NOT NULL DEFAULT 0`, backward compatible). Both
directions are reversible.

**Status.** Accepted (M7-01).

---

## ADR-0033 — Change-feed retention: a bounded window, a purge floor and the resync signal

**Context.** M7-02. The M7-01 per-user change feed (`change_log`) keeps one row per changed entity,
including a `delete` tombstone for a soft-deleted entity, so an offline client observes deletions
(AGENTS.md §9, "deletions must propagate safely to offline clients"). Tombstones must be retained
long enough for that, but the feed cannot grow without bound. Purging a tombstone is only safe if no
client still relies on it: a client that has not yet seen a purged delete can otherwise never learn
of it, and a partial feed could let it resurrect the entity.

**Decision — a configurable retention window.** `change_retention_days` (default **30 days**,
`config.py`) bounds how far back the feed's history reaches. A change-log row with
``changed_at < now − window`` is purgeable. Thirty days is the maximum offline window a client can be
away and still catch up incrementally; the value is configurable per deployment.

**Decision — a durable, restart-safe, idempotent purge.** A `changes.purge` job on the existing
durable queue (ADR-0005) removes the aged rows. `ensure_change_purge_job` starts the chain at worker
startup and reaps a stale `running` job (older than `change_purge_stale_seconds`) so a worker that
crashed mid-purge cannot wedge the chain, mirroring the calendar reconcile (ADR-0031); the job
re-schedules itself every `change_purge_interval_seconds` (default 3600). The purge runs in one
transaction — a crash purges the whole batch or none of it — and re-running over the same window
removes nothing, so it is idempotent. It deletes **only `change_log` rows**: the user's entity rows
(tasks, projects, notes) are never deleted. A soft-deleted entity stays a tombstone in its own table,
so the purge bounds the *feed history*, not the user's data (`DATA_MODEL.md` §5).

**Decision — a per-user purge floor and an explicit resync signal.** Each purge raises
`users.change_purge_floor` to the highest cursor it removed. Because `seq` and `changed_at` are
stamped together (ADR-0032), the purge removes a **prefix** of the cursor order, so every change with
`seq <= floor` is gone and every change above it is still retained. The feed therefore answers
`resync_required = true` (with an empty `changes` list and `next_since` at the current high-water
mark) when `since < floor`, and serves the normal incremental page when `since >= floor`. The client
full-resyncs, then resumes from `next_since`. This makes a delete always observable while its
tombstone is within the window, and makes a purged deletion impossible to resurrect from a partial
feed.

**Schema.** Migration `c1a2b3d4e5f6`: `users.change_purge_floor` (`bigint NOT NULL DEFAULT 0`,
backward compatible, monotonic) and index `ix_change_log_changed_at` (the purge scans by age; the
feed's per-user `(user_id, seq)` scan is already served by `uq_change_log_user_id_seq`). Both
directions are reversible and match the models.

**Compatibility.** `resync_required` defaults to `false`, so an existing client that ignores it is
unaffected until it actually falls behind the window; the new column defaults to `0` (nothing purged).

**Status.** Accepted (M7-02).

---

## ADR-0034 — Client offline queue: durable, versioned browser storage with a conflict-safe replay

**Context.** M7-03. `PRODUCT_SPEC.md` §5.5 and `ARCHITECTURE.md` §7 require that an edit made while
offline is queued durably and replayed on reconnect, revision-aware and idempotent, so nothing is lost
and nothing is duplicated. The M7-01 change feed (`GET /api/changes`) and its `resync_required` signal
(M7-02) are the pull side. The queue must survive a page reload, which rules out in-memory state.

**Decision — IndexedDB first, with a documented fallback.** The queue persists through a thin
`KeyValueStore` abstraction (`apps/web/src/lib/queueStorage.ts`) whose preferred implementation is a
small wrapper over the native **IndexedDB** API (one object store of string values) — no third-party
sync framework (AGENTS.md §7.5, §15). When IndexedDB is unavailable the store falls back to
`localStorage`, and finally to an in-memory store (a last resort that keeps the app usable but not
durable). A browser that exposes IndexedDB but rejects it at use time degrades to memory for the
session and warns once, rather than failing every edit. The fallback is acceptable because the queue
is a **client cache**: the server is authoritative for structured data (`ARCHITECTURE.md` §5), so a
lost queue is recoverable by a pull, never a source of truth.

**Decision — one versioned blob per store, not a record per operation.** The queue stores one JSON
document (`{version, nextSeq, operations[]}`) under a single key, and the sync cursor is a second
versioned document (`{version, since, updatedAt}`) in the same backing. At the intended personal scale
a handful of operations fit in one document, and a single write/read is simpler and atomic-er than
enumerating an object store (AGENTS.md §7.1). Each document carries a `version`; a document whose
version is unrecognised (or is corrupt) is discarded and the client starts clean — safe, because the
authoritative copy is on the server and a full pull restores it. A future format change must add a
migration instead of relying on the discard.

**Decision — FIFO replay carrying `Idempotency-Key` + `base_revision`.** Each queued operation records
the entity type/id, the mutation (`create`/`update`/`delete`), a client-generated idempotency key and
the `base_revision` it was based on. `flushQueue` (`apps/web/src/lib/syncEngine.ts`) replays them in
FIFO order through the ordinary entity API, sending the key as `Idempotency-Key` (M3-02/M4-01) and the
revision as `base_revision`; a retry reuses the **same** key, so the server treats a re-sent mutation
as the same request — **retrying never duplicates**. On a stale `409` the operation is *kept*, the
server revision is recorded and the conflict is surfaced; the client never clobbers newer data
(AGENTS.md §9). A retryable failure (network/5xx) stops the pass and leaves the queue intact for the
next reconnect; a permanent `4xx` marks the operation failed and the caller (M7-05) surfaces it.

**Decision — advance the cursor only after a page is applied.** `pullChanges` pages
`GET /api/changes` from the stored cursor and commits the cursor to a page's `next_since` only **after**
that page's changes have been handed to `onChanges`. An interrupted pull therefore re-delivers a page
rather than skipping it. When the feed answers `resync_required` the engine runs a full resync and
resumes from the returned head instead of trusting the empty page (ADR-0033).

**Scope.** M7-03 provides the durable queue, the replay/pull engine and a minimal status
surface (route `/sync`). The full reconnect reconciliation matrix (M7-04), the full sync-status UI
(M7-05) and the failure-mode suite (M7-06) are follow-on tasks.

**Status.** Accepted (M7-03).

---

## ADR-0035 — Reconnect reconciliation: flush-then-pull, a durable metadata cache, and a keep-local conflict policy

**Context.** M7-04. `PRODUCT_SPEC.md` §5.5 and `ARCHITECTURE.md` §7 require that when connectivity
returns the client replays its queued offline mutations **and** catches up on what changed elsewhere,
converging without loss or duplication. M7-03 delivered the durable queue and the replay/pull
primitives (`apps/web/src/lib/{offlineQueue,syncEngine}.ts`); M7-01/M7-02 delivered the change feed and
its `resync_required` signal. What was missing was the *pass* that composes them, a place to hold what
the feed reports, and a defined policy for a stale write (AGENTS.md §9: a stale client must not
overwrite newer data silently, and a deletion must not resurrect).

**Decision — one reconciliation pass, ordered flush-then-pull.** `reconcile()`
(`apps/web/src/lib/reconciliation.ts`) runs four steps: (1) reflect the durable queue in the cache, (2)
**flush** the queue via the M7-03 replay, (3) surface the flush outcome (a `pending` edit clears; a
stale `409` becomes a kept `conflict`), then (4) **pull** `GET /api/changes` from the stored cursor and
apply each page to the cache. The order is deliberate: draining the queue first removes an entity's own
just-landed edit *before* its server change is pulled, so the client never re-applies its own write as
a "remote" change or manufactures a self-conflict; and a conflict is surfaced *before* the pull updates
the cache, so the pull can never hide it. The pass is wired to the browser's `online` and the window's
`focus` events plus a manual action (`apps/web/src/hooks/useReconciliation.ts`); it holds no logic of
its own beyond scheduling and non-overlap (AGENTS.md §6).

**Decision — a durable *metadata* local cache, not a payload store.** `LocalCache`
(`apps/web/src/lib/localCache.ts`) persists, through the same `KeyValueStore` as the queue and cursor
(so it survives a reload), one entry per entity the feed has mentioned: its latest cursor, whether the
last change was a `delete` tombstone, when the server changed it, and the client's own `localPending` /
`conflict` / `serverRevision` flags. The M7-01 feed carries **no entity payload**, so the cache stores
change metadata; a consumer that needs a body fetches it from the ordinary endpoint. A change whose
cursor is not newer than the entry's is ignored, so re-applying a page is a no-op (idempotent) and a
tombstone cannot be silently overwritten by a re-delivered older page. The **queue-owned** flags are
never taken from the feed; they are re-derived from the queue by `markLocalState`, which makes the
surfaced conflict state consistent across a reload and stable to re-run.

**Decision — a stale write is a conflict: keep-local + surface (never clobber).** When the replay gets
a `409` the local edit is **kept** in the durable queue (it is not dropped and not retried blindly) and
the server is **never clobbered** — the client does not overwrite newer data (AGENTS.md §9). The
affected entity is flagged on the cache and rendered by a small **conflict surface**
(`apps/web/src/components/ConflictNotice.tsx`) that explains the edit was kept. This is the documented
policy; **manual resolution is M7-05** (the choice of "which wins" is left to the user rather than being
silently guessed — no universal last-write-wins, mirroring the calendar conflict policy in
`ARCHITECTURE.md` §7 and `AGENTS.md` §10). The full status UI is also M7-05.

**Decision — `resync_required` drops the cache and resumes from the head.** When the cursor predates the
M7-02 retention floor the feed returns `resync_required` with an empty page. The pass clears the
(possibly stale) metadata cache — re-applying the still-queued local edits so nothing in flight is
hidden — and resumes from the server's returned head instead of trusting the partial feed, so a purged
deletion cannot resurrect an entity (ADR-0033).

**Idempotence and durability.** Re-running a pass is safe: a landed operation is already removed from
the queue, a `conflict`/`failed` operation is not retried blindly, the pull resumes from the advanced
cursor (delivering nothing new) and the cache helpers are stable to re-run. The queue, cursor and cache
all sit on the durable backing (`queueStorage.ts`), so a reload resumes exactly where the previous
session stopped; tests re-instantiate all three over one store to prove it.

**No new dependency.** The pass is built entirely on the M7-03 modules and the standard browser APIs
(event listeners, `navigator.onLine`); no sync framework was added, and `package.json` is unchanged.

**Schema.** None — no database or API change; the cache is a new versioned document (`{version,
entries[]}`, `CACHE_STORE_VERSION = 1`) in the existing client `KeyValueStore`. Backend untouched;
OpenAPI / `schema.d.ts` not regenerated.

**Status.** Accepted (M7-04).

---

## ADR-0036 — Sync status panel and manual conflict resolution: rebase ("keep mine") vs. adopt ("take server")

**Context.** M7-05. `PRODUCT_SPEC.md` §5.5 requires **visible sync status** — last success, connection
state, pending changes, failures and conflicts — and `ARCHITECTURE.md` §8 keeps conflict resolution
server-side but leaves the *choice of which side wins* to the user. M7-03/M7-04 delivered the durable
queue, the flush-then-pull reconciliation pass and a durable metadata cache, and defined the conflict
policy as **keep-local + surface** (ADR-0035): a stale write is kept in the queue and shown, never
silently dropped and never allowed to clobber newer server data. What was missing was the full status
surface and a way for the user to actually **resolve** a surfaced conflict. The calendar conflict
policy (`AGENTS.md` §10) is the model: detect, and where correctness cannot be established, preserve
both sides and expose a resolution action — **no universal last-write-wins**.

**Decision — one overall state, derived by a pure rule.** The panel shows a single overall badge —
`up-to-date | syncing | offline | error | conflicts`. The rule (`overallSyncState`,
`apps/web/src/lib/queueStatus.ts`) takes the counts, `online`, `busy` and whether the queue could be
read, and applies a fixed precedence: a queue that cannot be read is `error`; an unresolved `conflict`
needs the user; a permanently `failed` operation is `error`; being `offline` explains why nothing is
moving; outstanding work or an in-flight pass is `syncing`; otherwise `up-to-date`. It is a pure
function so it is unit-testable and the component only renders the result (AGENTS.md §6). The panel
**composes** the existing `OfflineQueueStatus` and `ConflictNotice` surfaces and reads the existing
`useOfflineQueue`/`useReconciliation` hooks — it duplicates none of their logic. The overall badge is
an `aria-live` region, not a second `role="status"`, so it does not shadow or duplicate the queue
surface's own status role.

**Decision — two explicit resolutions, defined over the queue.** For a conflicted entity the user may
choose:

- **"Keep mine"** — the conflicting local operation is **re-queued against the server's current
  revision** as its new `base_revision`, returning it to `pending` so the next flush is *accepted*
  instead of rejected with a stale `409`. The queued payload is untouched, so the user's edit is never
  lost (AGENTS.md §9). When the server revision is **unknown** (`null`), the operation is returned to
  `pending` **unchanged**, so the next flush re-attempts it and re-learns the revision from the
  resulting `409` — the client still never sends an unchecked write (no blind overwrite). A later
  server change simply produces a fresh `409`, i.e. the conflict is re-surfaced rather than lost.
- **"Take server"** — the conflicting local operation is **discarded** and the client adopts the
  server's state: the entity's local-pending/conflict flags are cleared so no local override remains.
  (The `LocalCache` is *change metadata*, not payloads, per ADR-0035, so adopting "the server state"
  means dropping the local override for that entity; the entry already reflects the server's latest
  change cursor.)

The orchestrator is `resolveConflict` (`apps/web/src/lib/conflictResolution.ts`), over the existing
`OfflineQueue` (a new `rebase` method and the existing `remove`) and `LocalCache` (`markLocalState`).
Resolution acts only on the operations currently in the `conflict` state **for that entity**, so an
unrelated queued edit for the same entity is left alone.

**Decision — resolving is idempotent and never loses an edit silently.** `resolveConflict` reports how
many operations it touched and whether the call was a no-op (`unchanged`). Resolving an
already-resolved conflict changes nothing: "keep mine" leaves an already-`pending` operation untouched
(the queue `rebase` is a no-op on `pending`), "take server" finds no conflicting operation to remove,
and `markLocalState` re-derives the queue-owned flags from scratch — so a double-click, a re-render or
a retry cannot drop or duplicate work. Neither action ever deletes a payload without the user asking
("take server" is the user explicitly choosing to discard).

**Scope.** M7-05 provides the full status panel and the two manual resolutions. The failure-mode E2E
suite (network loss, restart, stale client) is M7-06. Resolution is per-entity and client-driven; it
does not re-fetch every entity body (the feed carries no payloads, ADR-0035).

**No new dependency.** The panel and the resolutions are built entirely on the M7-03/M7-04 modules and
the existing React/`lib` stack; `package.json` is unchanged.

**Schema.** None — no database or API change. `OfflineQueue.rebase` mutates the same versioned queue
document (`QUEUE_STORE_VERSION` unchanged); the cache document is unchanged. Backend untouched;
OpenAPI / `schema.d.ts` not regenerated.

**Status.** Accepted (M7-05).

---

## ADR-0037 — Durable reminders: policy + scheduled instance + delivery record, and exactly-once delivery

**Context.** M8-01 (`ROADMAP.md`, `PRODUCT_SPEC.md` §5.6) requires the backend to own **scheduling and
durable reminder state**: a reminder must fire at the right **time-zone-correct** instant, survive a
worker restart, never fire **twice** after a retry, and never fire for a **cancelled/completed/
deleted** entity. M1-08 (ADR-0005) already provides a PostgreSQL-backed durable job queue, and M3
(ADR-0013/ADR-0014) provides the task state machine and the time-zone rules
(`atlas/tasks/timezones.py`). `DATA_MODEL.md` §2.6 already named a `Reminder` entity and a bare
`tasks.reminder_policy_id`. Real push transport is out of scope here (Web Push is M8-02, device push
M8-04), so the delivery channel must be abstracted and testable without a provider.

**Decision — three tables, matching `DATA_MODEL.md` §2.6.**

- **`reminder_policies`** (per user): `days_before` (whole days before the due *calendar day*) and
  `at_time` (local wall-clock time of day). `tasks.reminder_policy_id → reminder_policies.id
  ON DELETE SET NULL`, so the previously-bare column becomes a real reference and a task survives a
  deleted preference. A task **without** a policy has **no** reminder, so no existing task silently
  gains one; per-task timing is configured by M8-05.
- **`reminders`**: the durable **scheduled instance** — one row per `(entity_type, entity_id)`
  (`uq_reminders_entity_type_entity_id`), holding `remind_at` (the UTC fire instant), `status`
  (`scheduled`/`sent`/`cancelled`/`failed`) and `attempts`/`last_attempt_at`. One row per entity means
  a reschedule **edits in place** instead of accumulating duplicates (AGENTS.md §9). `entity_type`
  allows `event` so calendar reminders (M5/M6) can reuse the store without a schema change.
- **`reminder_deliveries`**: the **delivery record**. `reminder_id` is **unique** — at most one row
  per reminder — written in the same transaction that flips the reminder to `sent`.

**Decision — time-zone-correct instant, no new date logic.** The fire instant is the day
`days_before` before the entity's due date, at `at_time` **local**, interpreted in the entity's IANA
zone and stored UTC. The only arithmetic is `local_date`/`to_utc`/`to_local` from
`atlas/tasks/timezones.py` (`atlas/reminders/schedule.py::remind_at_for`); there is no bespoke date
maths. A wall-clock time inside the spring-forward **gap** does not exist, so rather than drop the
reminder (which would violate "a reminder must never vanish") it **rolls forward** to the first
instant after the gap; the fall-back overlap resolves to the first occurrence (`fold=0`), matching
`to_utc`'s default. This is a deliberate, documented deviation from ADR-0014's "reject the gap" rule,
which targets *user input* rather than a scheduling computation.

**Decision — durable, idempotent, exactly-once delivery.**

- **Scheduling is materialised from the entity, and the job is pinned to the instant.** When a task
  is created/edited/deleted, `ReminderService.sync_for_task` recomputes the reminder and queues **one**
  durable `reminder.deliver` job (M1-08) with `run_at == remind_at`, keyed
  `reminder.deliver:{id}:{remind_at epoch}`. An unchanged reminder reuses the same job (idempotent);
  a reschedule creates a job for the new instant. A recurring `reminders.scan` sweep (same pattern as
  M5-10/ADR-0031) re-materialises every eligible task and re-queues any missed delivery, so the
  schedule **self-heals** after a restart or a missed fire time.
- **The job is idempotent.** `atlas/reminders/delivery.py::deliver_reminder` refuses to act unless
  the reminder is still `scheduled` and due, skips one whose `remind_at` no longer matches the job's
  payload (a superseded schedule), and skips an entity that is completed/archived/soft-deleted
  (marking the reminder `cancelled`). A retried job after a restart therefore does nothing.
- **Delivery happens at most once.** Because `reminder_deliveries.reminder_id` is unique and the row
  is written in the same transaction as marking the reminder `sent`, a second delivery — a duplicate
  job, a retried job, a restart — finds the record and is a no-op. A **transport failure** is recorded
  (`attempts`, `last_attempt_at`) and raised so the durable job retries with backoff; it does not
  write the delivery record, so the retry can still succeed. The only residual window is a crash
  **between** the transport accepting a message and the transaction committing; `ReminderMessage`
  carries a stable `dedupe_key` (`reminder:{id}`) so the transport or client can drop that duplicate.
  This residual window is a recorded limitation, not a claim of distributed exactly-once.
- **No reminder for a cancelled entity, and cancel/reschedule are synchronous.** Cancelling or
  soft-deleting a task cancels the reminder in the same request transaction (`sync_for_task` /
  `cancel_for_task`); completing/archiving does the same on the next edit **or** the next sweep; and
  the delivery handler re-checks the entity at fire time as the final guard. Editing a due date while
  the reminder is still `scheduled` reschedules it in place; a reminder that has already been `sent`
  is left alone (editing after delivery does not re-notify this milestone).

**Decision — delivery behind a `Notifier` interface.** `atlas/reminders/notifier.py` defines a small
`Notifier` protocol with `LoggingNotifier` (the default) and `RecordingNotifier` (a fake for tests);
the handler obtains it through `get_notifier()`. No provider SDK leaks into the reminder logic
(AGENTS.md §7.3) and the scheduler's idempotency is testable without a push service. Web Push/M8-02
and device push/M8-04 plug in behind the same interface.

**Schema.** New migration `e5a91c3f7b64` (down_revision `c1a2b3d4e5f6`): three tables plus one foreign
key on `tasks`. It adds no columns to existing tables and rewrites no data, so it is backward
compatible; both directions are reversible. No API/OpenAPI change (no endpoint or schema added), so
`schema.d.ts` is not regenerated.

**Consequences.** No new dependency. Task reminders are inert until a policy exists (M8-05 configures
them), so behaviour is unchanged for existing data. Retry exhaustion leaves a reminder `scheduled`
with attempts recorded; a future milestone can surface/deliver those. Managed by
`ensure_recurring_jobs` at worker startup, like the other durable chains.

**Status.** Accepted (M8-01).

---

## ADR-0038 — Notification destination registry and invalidation

**Context.** M8-01 fires durable reminders (ADR-0037) but had no way to reach a device: delivery needs
a per-user set of push destinations. M8-03 adds that registry — the storage M8-02 (Web Push) and
M8-04 (mobile push) build on — and defines what happens when a destination is reported
invalid/expired.

**Decision — one registry for every channel.** `notification_devices` holds one row per push
destination, keyed `(user_id, channel, endpoint)`: `channel ∈ {web, android, ios}`; `endpoint` is the
destination identifier (a Web Push endpoint URL, or a native push token); web rows additionally carry
the subscription's `p256dh`/`auth` client keys; `platform` is an optional hint; `last_seen_at` is
refreshed on every (re-)register and `disabled_at` marks an invalidated destination. The unique
constraint `uq_notification_devices_user_channel_endpoint` makes re-registering the same destination an
**upsert**, not a duplicate (`AGENTS.md` §9), and a re-register **revives** a previously invalidated
row. `p256dh`/`auth` are stored only so a send can use them and are **never** returned by an API or
logged.

**Decision — invalidation, not deletion.** A delivery that finds a destination dead (a Web Push
`404`/`410`, or a mobile token the provider rejects) reports it through the notifier's
`invalid_destinations`; the delivery path then **disables** exactly those rows
(`NotificationRegistryService.disable_many`), so they are never retried, and `active_devices`/`active_endpoints`
exclude them. Disabling is idempotent and reversible (a re-register clears `disabled_at`).

**Decision — the delivery path degrades safely.** `atlas/reminders/delivery.py` builds the caller's
active destinations from the registry; a user with no active device falls back to an untargeted send
(useful for logging/tests) rather than failing. The M8-01 notifier abstraction is extended with
`invalid_destinations` — no separate delivery logic (ADR-0037).

**Schema.** Migration `a3f7c2d8b105` — `notification_devices`, keyed `(user_id, channel, endpoint)`,
FK `users` CASCADE, `user_id` index. New table only; reversible; no existing table or data touched.

**Status.** Accepted (M8-03).

---

## ADR-0039 — Web Push desktop: VAPID config, a maintained transport, and a vanilla service worker

**Context.** M8-02 must deliver a desktop notification even when the Atlas tab is closed. Web Push
(RFC 8030) needs an application-server key pair (VAPID, RFC 8292), a service worker to render a
pushed message, and a transport that signs and sends the request to the browser's push service. The
M8-01 `Notifier` abstraction (ADR-0037) and the M8-03 registry (ADR-0038) already exist.

**Decision — VAPID keys are configuration, the feature degrades cleanly.** `vapid_public_key`,
`vapid_private_key` and `vapid_subject` come from the environment like the other secrets
(`AGENTS.md` §11) and are never committed. `atlas/notifications/vapid.py` holds the pure rule
(`build_vapid_config`/`is_configured`/`missing_vapid_fields`): when any field is missing the whole
feature is a single explicit **disabled** state, so the system degrades cleanly instead of attempting a
send it cannot sign. The **public** key is served to the browser
(`GET /api/notifications/config`); the **private** key is handed only to the push library to sign and
is never returned by an API, bundled or logged.

**Decision — a maintained transport, no custom crypto.** Delivery uses the maintained **`pywebpush`**
library (MPL-2.0) behind the M8-01 `Notifier` abstraction — `atlas/reminders/push.py::PushSender`.
No cryptography is hand-written. A push service reporting a destination **gone** (HTTP `404`/`410`)
is returned as an `invalid_destinations` entry — exactly the signal M8-03 uses to disable the row so it
is never retried (ADR-0038).

**Decision — a dependency-free service worker.** `apps/web/public/sw.js` is vanilla JS copied verbatim
into the build; it renders the pushed JSON `{title, body, data}` as a notification (using `data.dedupe_key`
as the notification `tag`, so a duplicate push collapses to one notification) and caches nothing. It
holds no cryptography: the browser's push service decrypts the payload with the subscription keys.

**Decision — the client flow.** `apps/web/src/lib/webpush.ts` holds the pure rules (`derivePushUiState`,
`urlBase64ToUint8Array`, `subscriptionToPayload`) and a `WebPushClient` bridge over
`Notification`/`ServiceWorker`/`PushManager` (an interface, so it is faked in tests). The consent surface
(`components/NotificationConsent.tsx`, `hooks/useWebPush.ts`, `pages/Notifications.tsx`) requests
permission, subscribes with the VAPID public key and registers the destination through the M8-03
registry (`POST /api/notifications/devices`); it distinguishes unsupported/disabled/denied/prompt/
granted/subscribed.

**Status.** Accepted (M8-02).

---

## ADR-0040 — Reminder preferences: a per-user default timing + a per-entity override

**Context.** M8-01 gave reminders a durable policy, but a user could not configure *when* a reminder is
sent — the timing could only be set directly in the database. M8-05 exposes it: a user wants a sensible
personal default and the ability to override a single task.

**Decision — a per-user default policy.** `reminder_policies.is_default` marks one of a user's policies
as the default, applied to that user's tasks that carry no per-task override. A **partial unique index**
(`uq_reminder_policies_default`, unique on `user_id` where `is_default`) guarantees at most one default
per user without constraining other named policies. The column is added with a server default of
`false`, so existing policies are unaffected (backward compatible).

**Decision — a per-entity override.** A task can carry its own policy (`tasks.reminder_policy_id`,
already modelled); `PUT /api/tasks/{id}/reminder` sets or clears it. The precedence is **override beats
default**; clearing an override drops the task back to the default, and repeated overrides of the same
value reuse one policy row.

**Decision — a timing change reschedules; clearing cancels.** Changing the default reschedules every
inherited task's durable reminder through the M8-01 machinery (**no new scheduling logic**), and clearing
the default cancels the inherited reminders. All endpoints are strictly user-scoped, idempotent, and
validated at the boundary (`days_before` + a strict `HH:MM` local wall-clock `at_time`); an invalid
value changes nothing.

**Decision — the UI.** The `/notifications` page hosts a `ReminderPreferences` surface (with
`useReminderPreferences`/`lib/reminders.ts` holding the logic) alongside the Web Push consent — one
place to configure notifications.

**Schema.** Migration `f1b2c3d4e5a6` adds `reminder_policies.is_default` + the partial unique index
(reversible; no data rewritten).

**Status.** Accepted (M8-05).

---

## ADR-0041 — Backups: one self-verifying set, plain-SQL dumps and a staging→publish layout

**Context.** M9-01 must produce automated backups of **both** durable stores (PostgreSQL +
Markdown files, ADR-0002) with an integrity check, so recovery is possible and *verifiable*
(REQ-015; `OPERATIONS.md` §1). Several consequential, hard-to-reverse choices were open: the dump
format, how the two stores are bundled and checksummed, and where `pg_dump` is executed.

**Decision — one backup *set* covering both stores.** Each run writes a directory
`atlas-backup-<UTC-timestamp>-<id>` containing `database.sql`, `notes.tar.gz` and a `manifest.json`.
A backup is only meaningful as the pair; a set missing either part fails the integrity check. This
makes "back up only the DB" or "only the files" structurally impossible to mistake for complete.

**Decision — plain-SQL dump (`pg_dump --format=plain --no-owner --no-privileges`).** Plain SQL is
human-readable, restorable with `psql` alone (no `pg_restore`), uniformly checksummable, and
portable across PostgreSQL versions. `--no-owner --no-privileges` lets a restore run without matching
roles. Custom/`-Fc` format (compressed, `pg_restore`) is smaller and faster for large databases but
adds a tool dependency; deferred until a size/performance need is demonstrated.

**Decision — manifest + SHA-256 as the completion marker.** `manifest.json` records each part's
store (`postgresql`/`markdown`), file, size and SHA-256, with `created_at` and the tool version. A
set is *complete* only when its manifest is present and every checksum matches; the manifest holds
no connection string, credential or absolute path (`AGENTS.md` §11).

**Decision — assemble in staging, verify, then publish atomically.** The set is built under
`<destination>/.staging/<id>`, verified against its own manifest, and only then `os.replace`d into
the destination. A failed run leaves a staging directory **without** a manifest (reported as
incomplete) and never a published set — so a partial backup is always detectable and can never be
mistaken for a good one. Retention (keep newest N) prunes only published sets inside the
destination.

**Decision — explicit pg_dump backend.** `BACKUP_PG_DUMP_CONTAINER` selects `docker exec` into the
PostgreSQL container; otherwise a local `pg_dump` (installed in the image via `postgresql-client`)
connects over TCP. The password is passed via `PGPASSWORD`, never on the command line. The dump is
single-transaction (PostgreSQL's default) so it is self-consistent.

**Consequences / limitations.** The integrity check proves the set is complete and internally
consistent, **not** that it restores — the end-to-end restore is the M9-02 drill. The notes archive
is a full snapshot each run (no incremental/deduplicated storage); acceptable at single-user scale
and revisited if a size need appears. The backup job runs on the worker, so `BACKUP_DIR` must be a
volume the worker mounts.

**Status.** Accepted (M9-01).

---

## ADR-0042 — Full data export: one open, verifiable set covering all three stores

**Context.** `PRODUCT_SPEC.md` §5.8 (REQ-015) requires a "complete export of notes, tasks, projects
and relevant metadata in open formats" so a whole workspace is portable out of Atlas. M4-07
(ADR-0026) already exports projects + their tasks + linked notes as the versioned
`atlas.project-export` JSON document. M9-03 must add the **notes** (whose content lives as Markdown
files on disk) and compose **one complete artifact**. Open questions were settled here: the artifact
shape, how the three stores are combined, how completeness and a consistent snapshot are achieved,
and how the export is reached.

**Decision — the artifact is a *set* (a directory), offered as a zip.** One export writes
`atlas-export-<UTC-timestamp>-<id>/` containing:

| File | Contents |
|---|---|
| `notes/` | The notes themselves — genuine `.md` files at their workspace-relative paths (open/portable as-is; readable by any editor or `git`) |
| `data.json` | The tasks + projects store: the M4-07 `atlas.project-export` document, **reused not forked** |
| `notes.json` | The notes metadata index (`atlas.notes-index` v1): per note id/path/title/revision/hash/size plus `tags`, wiki `links` and note↔project `projects` — enough to reconstruct the associations |
| `manifest.json` | The set's record: format + version, `export_id`, `created_at`, tool/`atlas_version`, `snapshot`, per-store `contents` counts and, for **every** file, its `path`, `bytes` and SHA-256 |

`GET /api/export` zips the set and streams it to the authenticated user; the `atlas-export` CLI
writes the set to a destination for an operator. The set layout deliberately mirrors the M9-01
backup set (ADR-0041) so operators learn one shape.

**Decision — reuse the M4-07 document, extended additively with `unfiled_tasks`.** The tasks +
projects portion is produced by the same document builder (`atlas.projects.export.build_document`)
that M4-07 uses, so the shape has a single source of truth. The M4-07 export nests tasks under their
project; a *full* export must also carry the tasks that belong to **no** project, so the document
gains one top-level key, `unfiled_tasks`, holding exactly those. This is an **additive** change, so
`version` stays `1` (ADR-0026); the key is present in the full export's `data.json` and absent from
the M4-07 endpoints, which are unchanged.

**Decision — notes are exported as their real bytes; the index holds metadata only.** The note
*files* are written under `notes/` byte-for-byte (content hashed while streaming, so nothing is
buffered whole). The index carries **no content** — there is no proprietary wrapper for the note
body — only the metadata needed to resolve links/tags/associations. The `content_hash`/`size_bytes`
in the index (and the manifest) describe the **exact exported bytes**, so the index and the archive
can never disagree even if a note is edited during the export.

**Decision — one consistent snapshot (no torn read).** All database reads happen inside a single
**REPEATABLE READ** transaction, reusing `ProjectsService.begin_consistent_read` (ADR-0026), so the
project/task/note graph is one point in time. Note files are read after the database read but each
file is written atomically by Atlas (temp file + `os.replace`), so a torn file is impossible; the
manifest records what was actually written.

**Decision — completeness over the M4-07 bound; scale by streaming.** Unlike the M4-07 project
export (bounded by `limit` with `truncated`), the full export is **unbounded** — a full export must
not silently omit data. The stated scale is a single household (`PRODUCT_SPEC.md` §7 A1), and note
content is streamed one file at a time so memory does not grow with the number of notes. The HTTP
response zips the finished set into memory (personal scale); a larger scale need would stream the
zip to disk.

**Decision — reachable, strictly user-scoped, with an operator CLI.** `GET /api/export`
(authenticated) exports exactly the caller's rows — every query filters on the authenticated user's
id — so another account's data can never appear. The `atlas-export` CLI (`run --user EMAIL |
--user-id UUID`, `verify`, `list`) is an **operator** tool that runs on the server and names the
account explicitly, like `atlas-backup`; it is not reachable over the network.

**Alternatives considered.** (a) *Ship the M9-01 backup `notes.tar.gz` + SQL dump as the "export".*
Rejected: a backup is for restore, is not per-file verifiable and mixes in schema/job state; the
export must be a clean, open, per-file artifact. (b) *One JSON with the note bodies embedded.*
Rejected: the notes must remain real Markdown files, not wrapped in a proprietary container.
(c) *A separate tasks document.* Rejected: it would fork the M4-07 format. (d) *Bound the export
with `truncated`.* Rejected: a full export that can silently truncate is not a complete export.
(e) *Include tombstones.* Rejected (as in ADR-0026): an export is the user's current data.

**Consequences / limitations.** The `task_links` (task↔note) and `task_tags` tables exist but have
no writer yet, so they are always empty and are not exported (recorded, not silently dropped). Only
live rows are exported (tombstones excluded). A full export is independent of the backups: it is a
*portability* artifact, never a substitute for the M9-01/M9-02 backup/restore. `verify` proves the
set is complete and internally consistent (every listed checksum matches), which is what a portable
artifact needs.

**Status.** Accepted (M9-03).

---

## ADR-0043 — Re-prioritise to a usable "personal OS" core; user-reachable means delivered

**Context.** A function audit on 2026-11-01 (walking the running app as a user) found that the
backend implements far more than the interface exposes: tasks can be captured by title, completed
and moved on the Board, but not edited, dated, prioritised, deleted or assigned to a project;
Tasks/Projects/Search/Settings are placeholders; no project can be created in the UI; Calendar has no
connect flow. Every task was marked `DONE` on API-level acceptance, so REQ-005/REQ-006 were scored
`PASS` while the owner could not use them. The owner also stated the product direction: an
Obsidian/Notion-class **personal operating system** with planning built in (`PRODUCT_SPEC.md` §1.1).

**Decision.**
1. **Definition of done changes.** A task that adds or changes owner-facing behaviour is `DONE` only
   when its acceptance journey passes **in a browser against the real API** (not a mocked one) and the
   evidence is recorded. API tests remain required but are no longer sufficient.
2. **New milestone MU — Usable Core** is inserted **before** the remaining calendar work (M5-03…M5-09,
   M6) and before M8 device work. Justification (AGENTS.md §5, "adjusted only when a documented
   dependency or validated technical risk justifies it"): M5/M6/M8 are blocked on external accounts and
   hardware (AR-001), the calendar views have nothing useful to sit in until tasks can be dated, and
   continuing fake-backed backend work has diminishing value. MU contains no new data stores.
3. **No new sources of truth.** Notes stay authoritative as Markdown files; tasks, projects and links
   stay in PostgreSQL. "Create a task from a note" is an explicit action that creates a database task
   holding a link back to the note; Markdown checkboxes are **not** parsed as the task database
   (AGENTS.md §8).
4. **Release scoring is corrected.** REQ-005 and REQ-006 are `PARTIAL` until MU-01…MU-03 pass.

**Scope decisions D-1…D-4 — owner approved the recommendations on 2026-11-01.** Nothing in this table is
built by MU; D-1/D-3 are deferred with a named trigger, D-2 is a standing constraint, D-4 is closed.

| ID | Question | Decision |
|---|---|---|
| D-1 | Notion-style user-defined databases / table and board views over notes | **Deferred** (revisit after MU-06). If wanted, model as **saved queries over note frontmatter** (read-only views, files stay authoritative) rather than a new store. |
| D-2 | Editor model: keep CodeMirror 6 source mode + preview, add Obsidian-style *live preview*, or move to block/WYSIWYG | **Approved:** keep CodeMirror 6 source mode + preview; Obsidian-style live preview may be added later as CodeMirror decorations; a block editor would break Markdown portability and `[[link]]` parsing. |
| D-3 | Graph view and canvas | **Deferred** until linking (MU-06) is in daily use; a graph is cheap once backlinks cover tasks and projects. |
| D-4 | Plugins / user scripting / automation | **Closed — excluded** (`PRODUCT_SPEC.md` §4.2). "Built in" is the product's answer to plugins. |

**Consequences.** The next work is UI-bound, which is slower to verify than API work and needs
browser journeys in CI (MU-07). The excluded list in the spec is unchanged except that daily notes,
templates, the command palette and unified search are now in scope. Revisit D-1 and D-3 after MU-06.

## ADR-0044 — Task detail conventions: date-only due dates, tags and restore (MU-01)

**Context.** MU-01 adds editing, quick scheduling and delete-with-undo. Three gaps surfaced: tasks have
no all-day concept; the `tags`/`task_tags` tables existed without an API; a soft-deleted task could not
be brought back.

**Decision.**
1. **A due *date* without a time is stored as 23:59 on that date in the task's zone** ("end of day").
   The client sends the naive wall-clock time plus the IANA zone and the server converts it (no date
   maths in the client beyond "today + N calendar days"). The form shows an empty time for such a task
   and lists omit the clock time. A real 23:59 due time is indistinguishable from "end of day"; the
   trade-off is accepted to avoid a schema change. Revisit if an `is_all_day` flag is wanted (MU-04/M5).
2. **Tags are exposed on the task API** as `tags: string[]` (create/update replace the whole set; omit
   to leave unchanged; max 20, each ≤ 64 characters, trimmed, leading `#` removed, de-duplicated
   case-insensitively; an existing tag keeps its spelling). Stored in the existing `tags`/`task_tags`
   tables, user-scoped. No migration.
3. **`POST /api/tasks/{id}/restore` undoes `DELETE`.** The task keeps its id, history and tags; its
   revision advances and the change feed announces it, so offline clients converge. Subtasks promoted by
   the delete (ADR-0016) stay promoted; a project deleted in the meantime is detached. Idempotent via
   `Idempotency-Key`.
4. **Capture on Today sets `due = today` (date-only) and leaves the status `inbox`**; Inbox triage
   ("schedule", "file") sets `status = next` together with the date/project so the task leaves the Inbox.

**Consequences.** UI mutations send an `Idempotency-Key` and the task's `base_revision`; a stale edit
shows a conflict. They are online-only: wiring the optimistic updates through the offline queue
(M7-03) is not done by MU-01 (recorded in `RISKS.md`).

## ADR-0045 — Tasks page: URL filter state, client-side sort and saved filters (MU-03)

**Context.** The task list API already filters (`status`, `priority`, `due_from/to`, `project_id`, `q`,
`limit` ≤ 500) but has no sort parameter and accepts one priority. MU-03 needs sort, linkable views and
saved filters.

**Decision.**
1. **No backend change.** Sort is applied in the client over the (≤ 500) rows returned; the page says when
   the limit was hit. A server sort parameter is the follow-up if lists outgrow one page (R-20).
2. **The filter lives in the URL query string** (`q`, `status`, `priority`, `project`, `due_from`,
   `due_to`, `sort`; defaults omitted). Values are passed to the server unchanged, so an invalid value is
   rejected by the server and its message is shown verbatim.
3. **Status default is `open`** (inbox, next, in progress); `all` and each single status are selectable.
4. **Due-date bounds are the viewer's local days** (start of the from-day to end of the to-day, sent as
   instants), not UTC days.
5. **Saved filters are a client-side convenience** in `localStorage` (`atlas.savedTaskFilters`: name and
   query string, max 20), validated on read and wrapped in try/catch. They are per browser, not synced and
   not authoritative for anything; losing them loses nothing else.
6. **Bulk actions are one request per task** (existing `PATCH`/`DELETE`, carrying `base_revision` and an
   idempotency key). A failure on one task does not stop the rest; each failure is listed verbatim and the
   failed tasks stay selected. Delete undo calls the restore endpoint for each deleted task (ADR-0044).
   There is no atomic multi-task operation; it is online-only (R-22).

## ADR-0046 — Recurrence preview endpoint, subtasks and reminder override in the task detail (MU-04)

**Context.** The task detail needs a repeat picker with a preview. AGENTS.md §7.4 forbids reimplementing
recurrence in the client, and no endpoint exposed the engine without creating a task.

**Decision.**
1. **`POST /api/tasks/recurrence/preview`** (`rule`, naive-or-aware `anchor`, optional `time_zone`, `limit` ≤ 20)
   returns the next occurrences as UTC instants using exactly `build_spec`/`occurrences` (the code path that
   creating and completing a recurring task uses). It is read-only, authenticated, stores nothing, and
   answers `422` with the server's message for an unusable rule, unknown zone or skipped wall-clock time.
2. **Presets are strings, not logic.** Daily/Weekly/Monthly send `FREQ=DAILY|WEEKLY|MONTHLY`; anything else is
   a custom RRULE the server validates. Giving a task without a zone a rule also pins the viewer's zone
   (the series needs one to keep wall-clock time across DST). The anchor is the due date, else the start,
   mirroring the server.
3. **Completing a repeating task** is the normal status change; the server already creates exactly the next
   occurrence. The panel then finds it (same title and series, open statuses) and offers to open it, or says
   the series ended. Occurrences of a series show the rule read-only: the server keeps the series on its head
   task, so editing or stopping a series from an occurrence is not offered (recorded in R-22).
4. **Subtasks** use the existing endpoints (`parent_task_id`, ordinary create/complete/delete); progress is
   the server's rollup (completed/total). **Reminder** uses the M8-05 `GET/PUT /api/tasks/{id}/reminder`;
   "Use my default" clears the override. Delivery and scheduling are unchanged.

**Consequences.** One small backend endpoint with tests; no schema change, no new dependency.

---

## Open decisions deferred to later milestones

| # | Question | Milestone |
|---|---|---|
| D-1 | PWA vs packaged desktop app for Linux/Windows/macOS | M8 (default: PWA) |
| D-2 | Expo relay vs direct FCM/APNs | M8 |
| D-3 | Board column model detail | M4 — **settled**: columns are exactly the task statuses (ADR-0022) |
| D-4 | Tombstone retention window | M7 — **settled**: 30-day default retention with a purge floor + resync signal (ADR-0033) |
| D-5 | Whether/when to add external task providers (Google Tasks / MS To Do) | post-release |
| D-6 | Minimum offline feature set | M7 |

## Sources (Milestone 0 research)

- [Procrastinate — PostgreSQL-based Task Queue for Python](https://github.com/procrastinate-org/procrastinate)
- [Microsoft Graph permissions reference](https://learn.microsoft.com/en-us/graph/permissions-reference)
- [Use delta query to track changes in Microsoft Graph data](https://learn.microsoft.com/en-us/graph/delta-query-overview)
- [Google Calendar API usage limits](https://developers.google.com/workspace/calendar/api/guides/quota)
- [Google sensitive scope verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/sensitive-scope-verification)
- [Expo push notification services](https://docs.expo.dev/guides/using-push-notifications-services/)
- [CodeMirror / headless Markdown editors comparison](https://md2rich.com/blog/headless-markdown-editors-2026-block-workflows-en)
- [Authlib FastAPI integration](https://docs.authlib.org/en/stable/oauth2/client/web/fastapi.html)

## ADR-0047 — Unified search endpoint and command palette (MU-05)

**Context.** MU-05 needs one place to find notes, tasks and projects and to run a few commands. Notes
already have full-text search (`notes.search_vector`, GIN); `GET /api/tasks?q=` is an unindexed substring
scan (R-20); projects have no search. The palette must feel instant while typing, so matching is by word
*prefix*.

**Decision.**
1. **One read-only endpoint, `GET /api/search?q=&limit=`** (auth required, user-scoped). `q` is 1…200
   characters, `limit` 1…50 (default 10) and bounds **each** group. The answer is
   `{query, notes[], tasks[], projects[]}`; a note hit carries `id`, `path`, `title` only (never content),
   a task `id, title, status, priority, due_at, project_id`, a project `id, name, status`. Text with no word
   characters answers `200` with empty groups; a missing/empty/over-long `q` or an out-of-range `limit` is
   `422` with the framework's message (shown verbatim by the client).
2. **Matching is word-prefix, every word (AND).** The text is reduced to `\w` words (at most 8, each ≤ 64
   characters), turned into `w1:* & w2:*` and bound as the argument of `to_tsquery`; no user character can
   reach tsquery syntax, and every value is a bound parameter. Notes use their existing `english` vector
   (title + content); tasks and projects use the `simple` configuration (no stemming or stop words, so short
   names such as "the" or "to" still match) over title/name + description.
3. **Two GIN expression indexes** (`ix_tasks_search_fts`, `ix_projects_search_fts`, migration
   `a8c4d9e2b7f1`) back the task/project statements. The expression is one literal constant shared by the
   model, the query and the migration, written in PostgreSQL's canonical printed form so Alembic autogenerate
   sees no drift. Additive and reversible; no data is touched. A test runs the endpoint's own statements
   with sequential scans disabled over 3 000 rows and asserts the plan uses the index.
4. **Ordering.** Open work before completed/archived (tasks) and active before closed (projects), then
   `ts_rank`, then most recently updated.
5. **Palette (client).** Ctrl/Cmd+K toggles a modal combobox mounted in the shell; arrows/Enter/Esc, focus
   trap, focus returns to the opener; results debounced 150 ms with the older request aborted. Commands
   (go to a view, toggle theme) are filtered client-side with a small subsequence matcher. "New task / note /
   project" appear for any typed text but are **never the default active entry**, so Enter alone cannot
   create something. Created items open (task detail, note, project page). The theme is now a tiny shared
   store (`lib/theme.ts`) so the palette and the toggle button agree.
6. **Opening results.** A task opens the shared task detail (the shell owns a `useTaskEditor`; after a
   save from there the page behind is remounted to show the change). A project opens its page. A note opens
   via the new deep link `/notes?open=<note id>`, which the Notes page honours on load and on change.
7. **Search page** replaces the placeholder: same endpoint, `limit` 25, the text kept in `?q=`.

**Consequences.** No new dependency. Substring matches inside a word ("ilk" for "milk") are not found
(use the Tasks page filter for that); the task-list `q` filter and `tasks.project_id` stay unindexed
(R-20 remains open for those). Palette creates are online-only (R-22). A search ranks by relevance, not by
fuzzy edit distance.

## ADR-0048 — Task↔note links: create-from-note, stable ids, backlinks (MU-06)

**Context.** The `task_links` table (task ↔ note, `ON DELETE CASCADE`, ADR-0024) existed with no writer and
no API; `TASK_NOTE_LINK` was a reserved change-feed entity. MU-06 makes the association reachable without
adding a source of truth (ADR-0043 §3, AGENTS.md §8).

**Decision.**
1. **Links are created only by an explicit action:** `POST /api/notes/{id}/tasks` takes the body of
   `POST /api/tasks`, validates the note first (unknown, another user's or deleted → `404`), then creates the
   task and its link in one transaction. An `Idempotency-Key` makes a retry return the first response; the
   link insert is `ON CONFLICT DO NOTHING`. The note file is never read or written, and Markdown checkboxes
   are never parsed into tasks. There is deliberately no "link an existing task" endpoint yet (nothing in the
   UI would use it).
2. **Identity is the note's id**, never its path, so an API rename keeps links (tested). Wiki-link *text*
   remains path-based (M2-07) and is not rewritten on rename.
3. **Reading:** `GET /api/tasks/{id}/notes` (live notes, path order) and `DELETE /api/tasks/{id}/notes/{note_id}`
   (idempotent unlink; neither side is deleted). `NoteDetailOut` gains `tasks` (id, title, status, priority,
   due_at, project_id; open work first) and `projects` (from `note_projects`) — the non-note part of a note's
   backlinks, in the same response as the note.
4. **Tombstones:** rows for soft-deleted tasks/notes are kept and hidden by the listings, so undoing a task
   delete (or a reappearing note file) restores the link. Hard deletes cascade.
5. **Change feed:** a created or removed link is recorded as `task_note_link` (`<task>:<note>`) in the same
   transaction; a repeated no-op unlink records nothing.
6. **Migration `b7d3e1a95c24`:** adds `ix_task_links_note_id` (the primary key leads with `task_id`), additive
   and reversible.
7. **Client:** "Task from selection" uses the selection, or the cursor's line, reduced to its first non-empty
   line with list/checkbox/heading markers removed; the person confirms or edits the title. If the note has
   exactly one project the task is filed in it (shown before creating). Creating a task refreshes only the
   note's tasks/projects/backlinks, never the editor text or its base revision, so unsaved text and conflict
   handling are untouched. The task detail lists linked notes (open, unlink). A note found by the task detail
   opens through `/notes?open=`.
8. **`[[` completion** uses `@codemirror/autocomplete` (already installed as a dependency of
   `@codemirror/lang-markdown`; now declared directly, same version, MIT). Candidates are the notes already
   loaded by the page, matched on path and title; unsafe paths (`[ ] | # ^ \`) are never offered.

**Consequences.** Linking an existing task to a note, rewriting wiki links on rename and a graph view are
not done (D-3 trigger is now met: backlinks cover notes, tasks and projects). A file renamed outside Atlas
may get a new id and lose task links, as for project links. Online-only mutations (R-22).

