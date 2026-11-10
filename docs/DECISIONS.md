# Atlas — Architectural Decision Records

**Status:** Draft for approval (Milestone 0)
**Last updated:** 2026-11-03

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

**Status note (2026-11-03, SYNC-03e): PARTLY SUPERSEDED by ADR-0059 D2 (accepted).** What changed: (1) the purge removes only
**`delete` rows**, never `upsert` rows, so the log stays one row per existing entity and a device with no state can bootstrap
from cursor 0; (2) the default window is **90 days** (minimum 30, `CHANGE_RETENTION_DAYS`) instead of 30; (3) `since = 0` is a
snapshot and is never `below_floor` (nor is a `snapshot=true` continuation page); (4) idempotency keys expire with the tombstones.
What stays: the durable purge job, the per-user `change_purge_floor`, entity tombstones never purged, and `resync_required`
for `0 < since < floor`. The floor is now "the highest purged tombstone", not "the highest purged row". The text below is the
original decision and is kept as history.

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

## ADR-0049 — Daily note, templates and Today as home (MU-07)

**Context.** MU-07 adds a note for each day, notes started from templates and a Today home page. Notes stay
plain Markdown files with no new source of truth (ADR-0043 §3, AGENTS.md §8). Two things needed deciding:
what "today" means and how a create can never overwrite.

**Decision.**
1. **Which day.** There is no per-user time-zone setting (tasks carry their own zone, Settings arrives in
   MU-08). The browser's zone is the viewer's zone everywhere else (Today view, `tz` parameter), so the
   **client sends the calendar day** (`YYYY-MM-DD` in the browser's zone) and the server only validates it
   (`^\d{4}-\d{2}-\d{2}$`, ASCII, a real date). The server never guesses a day from its own clock for the
   daily note. For `{{date}}` in a template note made without a `date` the server falls back to the UTC day;
   the web client always sends its own day. Revisit when MU-08 adds a user zone setting.
2. **Daily note.** `POST /api/notes/daily {date}` opens `daily/<date>.md`: `201` when this call created it,
   `200` with the untouched note otherwise. Content is `# <date>\n`, or the rendered `templates/daily.md` if
   that note exists. Concurrent calls are serialised with a per-user-and-path transaction advisory lock, so
   exactly one creates the file; a file that already exists on disk but is not indexed yet (added in an
   editor) is **adopted** (indexed as it is), never rewritten. The folder is `daily/` (lower case, as in the
   roadmap); `MARKDOWN_STORAGE.md` §1 is updated from the older `Daily/` sketch.
3. **No overwrite, ever.** New `NotesStorage.write_new` writes a temporary file, fsyncs it and publishes it
   with a hard link, which fails if the target exists. `NotesService.create` now uses it, which also closes a
   check-then-write race in the existing `POST /api/notes`. It requires a filesystem with hard links (any
   Linux local filesystem or Docker volume); elsewhere the create fails with the OS error and nothing is
   overwritten.
4. **Templates** are ordinary notes whose path starts with `templates/` (nothing is registered anywhere).
   `POST /api/notes/from-template {path, template_id, date?}` reads the template by id (user-scoped; not in
   `templates/` → `400`), substitutes and creates the note with the normal create rules (an existing path →
   `409`, bad path → `400`). Placeholders are exactly `{{date}}` (`YYYY-MM-DD`) and `{{title}}` (the new
   note's file name without `.md`; for the daily note, the date), optionally with spaces inside the braces.
   Substitution is a single regular-expression pass: other `{{...}}` text, HTML and anything else is copied
   verbatim, inserted values are not expanded again, nothing is evaluated or included. Template content is
   treated as untrusted text like every note (the preview does not render raw HTML).
5. **Today** (route `/`, already the default) shows Overdue, Due today, **Scheduled today** (open tasks whose
   `start_at` falls on the viewer's day, via the existing `start_from`/`start_to` filter, minus tasks already
   listed above), a **Daily note** card and an **Events** slot that says it is empty until a calendar is
   connected (M5). The card previews the note's first lines as plain text and never creates a file just by
   being displayed: creating happens only on the button. Listing templates and finding the daily note use the
   existing `GET /api/notes`, so no list endpoint was added.
6. **Palette and Notes page:** commands "Open today's note" and "New note from template" (the latter goes to
   `/notes?new=template`, which focuses the template picker next to the new-note path field); the Notes page
   also has a "Today's note" button.

**Consequences.** No migration, no new dependency. `daily/` and `templates/` are normal folders the user can
rename or edit externally; the daily note for a day is found by its path, so renaming it makes the next
"Today's note" create a new one. The daily note is not linked to tasks automatically. A stale index row whose
file was deleted outside Atlas still conflicts until reconciliation runs (`409`, message shown). Weekly or
monthly notes, template variables beyond the two above and a user time-zone setting are not done.

## ADR-0050 — Settings: account endpoints, session policy, instance and backup status, accessibility gate (MU-08)

**Context.** MU-08 replaces the Settings placeholder (J7). Several parts needed a decision: how the account
can be edited safely, what a password change does to sessions, where "backup status" can come from without
inventing data, and how accessibility is checked.

**Decision.**
1. **Account endpoints** (new; `services/api/atlas/api/auth.py`). `PATCH /api/auth/me {display_name}` edits
   the name only (the email is the login identity and is not editable). `POST /api/auth/password
   {current_password, new_password}` returns `204`. Server rules: the **current password is required** and
   checked with Argon2 (`400 "Current password is incorrect"`; not `401`, so the client never reads it as a
   lost session); the new password has the setup rule, **at least 12 and at most 1024 characters**
   (`422`, the framework message); a new password equal to the current one is `400`; CSRF applies as for every
   authenticated write; attempts are rate limited with the login limit and window (`AUTH_RATE_LIMIT_PER_MINUTE`,
   in-process like login), keyed **per account** rather than per address; an unauthenticated call is `401`.
2. **Sessions on password change.** All of the account's sessions are **revoked** and a **fresh session is
   issued to the caller** in the same response (new cookies). The browser that changed the password stays
   signed in; every other device (and any stolen session) must sign in again. This also rotates the session
   token. Offline edits queued on another device are kept in that device's queue and replay after it signs in
   again (the queue is client-side). Trade-off: the user may be surprised to lose other devices; the page says
   so before and after.
3. **No secret in logs or errors.** Request bodies are never logged (the access log records method, path and
   status). The framework's 422 body echoes the submitted value as `input`; the existing redaction handler
   (SECURITY T2, previously `/api/calendar/credentials` only) now also covers every path under `/api/auth/`,
   which includes passwords on setup, login and the new endpoint.
4. **Instance information** — `GET /api/instance` (authenticated; read-only): Atlas version, `ATLAS_ENV`,
   database status, the migration revision (`alembic_version`), whether Web Push keys are configured (a
   boolean, never the keys), and the backup summary. It returns no path, connection string or secret and no
   job error text. Database "ok" means the query ran; it does not replace `/health/ready`.
5. **Backup status** has a safe read-only source, with limits that the page states. The API reads the
   **published backup sets' manifests** in `BACKUP_DIR` (the Compose `api` service already mounts the backup
   volume; the worker writes to it): number of sets, the newest set's time, version and part sizes, the number
   of leftover staging directories (an interrupted run, never counted as a backup), plus the status and time of
   the newest `backups.run` job from the durable queue and the configured interval/retention. It does **not**
   recompute checksums (a dump can be large; `atlas-backup verify` does that) and says so. If the folder is not
   visible to the API (not mounted, or different host) the page says it cannot report, instead of claiming "no
   backups". New module `atlas/backups/status.py`.
6. **Export** uses the existing `GET /api/export`, fetched by the page with the session cookie and saved as a
   file, so a failure shows the server's message instead of navigating to a JSON error.
7. **Theme** stays a per-browser setting (`localStorage`), now also a Light/Dark choice on Settings. Reminder
   timing and notification status are the existing M8 components, shared with the Notifications route
   (`NotificationSettings`). There is **no user time-zone setting** (ADR-0049 §1): not requested for MU-08, the
   browser's zone still decides "today".
8. **`.local` addresses.** `email_validator` rejects `.local` as a special-use name even with
   `test_environment=True`. Its documented module list `SPECIAL_USE_DOMAIN_NAMES` has `local` removed at import
   (`atlas/api/schemas.py`); `invalid`, `localhost`, `arpa` and the others stay rejected, and no DNS check is made.
9. **Accessibility gate.** `@axe-core/playwright` (MPL-2.0, dev only, `docs/DEPENDENCIES.md`) runs in the
   real-stack suite (`mu08-a11y-and-layout.spec.ts`) with the WCAG 2 A/AA, 2.1 A/AA and best-practice rule
   sets, over all main pages in light and dark, the task panel, the palette and the shortcut help; the same
   spec asserts no page scrolls sideways at 375 px and 800 px. Findings are fixed, not suppressed. Fixed:
   light-theme accent colour contrast (`#3b6ef5` to `#2c5ce0`), the task panel's `aside role=dialog` and
   `header` (now `div`s) that produced a second banner landmark.
10. **Shell.** `?` (when focus is not in a text field, CodeMirror included) and the palette command "Keyboard
    shortcuts" open one help overlay listing only shortcuts that exist (`lib/shortcuts.ts`). On screens up to
    720 px the nav is one scrolling row (the current view is scrolled into view), the sidebar project list is
    hidden (Projects is one tap away) and the top bar is compact. Loading messages are `role="status"`; the
    Notes page got a loading state and a retry for its first read.

**Consequences.** One migration-free change set; the only dependency is dev-only. Sessions are no longer
manageable one by one (no "sessions" list or "sign out other devices" button). The password rate limiter is
in-process (single-process deployment; see SECURITY §3 note). Backup status reflects the folder as the API
sees it; a worker writing elsewhere would show nothing. Not done: email change, user time zone, account
deletion, OIDC/2FA.


---

## ADR-0051 — UX direction: neutral Notion-like design system, new app shell, always-autosave (owner decisions)

**Status:** Accepted (owner, 2026-11-02). **Source:** [`UX_AUDIT.md`](UX_AUDIT.md) (evidence and proposal).

**Decisions (answers to the audit's open questions).**
1. **Accent:** neutral, Notion-like. Surfaces and text carry the interface; one accent token exists but is
   neutral (ink in light, near-white in dark) and is swappable later in one place. Colour is used only for
   meaning (priority, overdue, danger, success). Replaces the audit's indigo default.
2. **Day view:** removed from navigation; `/day` redirects to Today (a date picker on Today replaces it).
3. **Icons:** vendored inline SVGs (about 25, Lucide, ISC licence, notice kept in `docs/DEPENDENCIES.md`); no
   npm icon package.
4. **Saving is always automatic, everywhere, with no Save button and no Ctrl+S requirement** (Obsidian-like):
   task properties save per field; note text saves on a debounce, on blur, on navigation and on close. A visible
   state indicator ("Saving… / Saved / Offline / Conflict") replaces "revision N". Safety is unchanged and
   mandatory (AGENTS.md §8, §9): every save carries `base_revision`; a `409` never overwrites; the local buffer
   is kept and the existing conflict UI is shown; unsaved text survives reload via a local draft; saves are
   serialised per document (no overlapping requests) and idempotent. Ctrl+S, if pressed, just flushes now.
5. **Editor default mode:** Source until live preview passes its round-trip tests, then Live becomes the default,
   remembered per browser.

**Consequences.** Autosave for notes is a data-integrity feature, not polish: it ships with its own tests
(rapid typing, offline, 409 mid-typing, tab close, reload) before the explicit Save button is removed
(UX-05). Task detail loses its Save button in UX-04. Until then the current Save buttons stay. Nothing here
adds a data store or changes the Markdown format. Scope: UX tasks UX-01…UX-08 in `ROADMAP.md`.

## ADR-0052 — One task row, a shared menu and list keys; Tasks-page selection; subtask context (UX-03)

**Status:** Accepted (2026-11-02, within the owner's UX direction ADR-0051; every choice here is UI-only and
reversible). **Source:** `UX_AUDIT.md` §1 verdict #2, §3.4, §4.3, §6 (UX-03, quick win 4).

**Context.** Every list rendered its own row (`TaskList` plus page-specific controls): a bordered "Complete"
button, six Inbox controls (`InboxActions`), a per-card `<select>` on the board, and no keyboard model beyond
Tab. The audit also found two defects: subtasks listed as top-level rows with no parent shown, and the project
page offering "Complete" on tasks that were already completed.

**Decisions.**
1. **One row.** `components/TaskRow.tsx` is the only task row: Today, Inbox, Upcoming, Week, Tasks, the project
   list (and the unrouted Day view) render it through `TaskList`; search results render it read-only (they are a
   snapshot of `/api/search`, which returns no revision, so actions happen in the detail panel). Board cards
   reuse its `TaskMeta` and the same menu (`TaskMenu`). Row = round checkbox, title (opens the detail as
   before), muted meta (parent, project dot + name, due in the shared `formatDue` format and the warning colour
   when overdue, priority flag, subtask `n/m`, `#tags`), hover/focus quick actions and a "…" menu.
2. **Completion is a native checkbox**, styled round, named `Complete <title>` whether open or done; checked
   means completed. Unchecking reopens through `completed → in_progress`, the only reopening transition the
   server allows (ADR-0013); archived tasks show a disabled checkbox. The tick is shown at once and replaced by
   the server's answer. Every action is the existing `PATCH`/`DELETE` with `base_revision` and a fresh
   idempotency key (`hooks/useTaskActions.ts`); one change per task is in flight at a time, a failure is shown in
   the server's words and the list is re-read.
3. **Persistent controls: two.** The checkbox and the "…" trigger are always visible. *Schedule for today*
   (omitted when due today or done), *Pick a date* and *Move to a project* (omitted for subtasks or with no
   project) appear on hover or when focus is in the row, overlaying the end of the row; under
   `(hover: none)` they are not rendered visible and the menu carries everything. J2 stays within two
   interactions: today 1, tomorrow 2 (menu, Tomorrow), a date 2 (picker, type + Enter), a project 2 (picker,
   choose), delete 2 (menu, Delete; undo toast unchanged). Keys: `t` 1, `m` + choice 2.
4. **The menu** (`components/Menu.tsx`) is a WAI-ARIA `menu` (`menuitem` / `menuitemradio`), rendered in a portal
   and promoted to the top layer with the native Popover API (`popover="manual"`) where available, so a list's
   `overflow` cannot clip it. Open/close logic is ours, not `popover="auto"` or `<dialog>`: light dismiss and focus
   return differ between engines and are absent in jsdom, and a menu must not trap focus. Opening focuses the
   checked choice or the first item; ↑ ↓ Home End and type-ahead move; → opens a submenu, ← or *Back* returns;
   Enter/Space choose; Esc and Tab close and return focus to the opener; a press outside closes without moving
   focus; handled keys never reach the row, the page or the task panel's Esc. Submenus replace the view (works at
   phone width). The date choice is a small `role="dialog"` with a labelled date field and *Set date* (submit on
   Enter): committing on `change` would fire on a partially typed year. Right-hand hints (weekday, current
   value) are `aria-hidden`, so item names stay stable. Entries: Today, Tomorrow, Next week (the coming
   Monday), Pick a date…, No date (when due); Priority; Move to project (not for subtasks); Status (current plus
   the allowed transitions); Delete. On the board, "Move to…" (status) comes first and replaces the `<select>`.
5. **Triage rule.** Giving an Inbox task a date or a project moves it to `next`, on every list (it was the
   Inbox's rule; J2). Moving to another day keeps a task's clock time in its own zone; a date-only task stays
   date-only (ADR-0044).
6. **Tasks-page selection (MU-03) is a separate square checkbox** before the round one (`Select <title>`), shown
   on hover/focus, whenever anything is selected, and always on touch. *Select all*, the bulk bar and its
   actions are unchanged. On the Tasks page `x` selects; everywhere else `x` completes or reopens.
7. **List keys** (only when not typing; a checkbox, radio or button input no longer counts as typing, so `?`
   works there too): `j`/`k` next/previous row across all lists on the page (from outside a list: first/last),
   Enter opens, `x` as above, `t` today, `m` project menu, `p` priority menu. Listed in `lib/shortcuts.ts` (the
   help overlay). When the focused row leaves a list, focus moves to the row that took its place.
8. **Subtasks keep the server's list semantics.** A subtask is a task (ADR-0016) and the views list it like any
   other; that is intended, not a bug, so the server is unchanged. The row names the parent as muted context
   ("Subtask of …"): from the same list when it is there, otherwise one `GET /api/tasks/{id}` per unseen parent,
   kept for the session. A subtask has no project choice because it always shares its parent's project.

**Consequences.** No backend, schema or dependency change; nine Lucide shapes added to the vendored icons
(`DEPENDENCIES.md`). `InboxActions.tsx` is removed. Limitations: reopening lands in *In progress*, not the
status before completion (the server keeps no history to restore); a renamed parent shows its old title in
rows until it is listed again or the page reloads; quick actions cover the end of the meta while shown; Week's
narrow day columns hide the quick actions (menu only); the board's `[`/`]` keys and drag-and-drop changes are
UX-07.

## ADR-0053 — Task detail autosave: one save session per task, serialised per-group PATCHes (UX-04)

**Status:** Accepted (2026-11-03, implements the owner's decision ADR-0051 §4 for the task detail; UI-only,
no backend, schema or dependency change). **Source:** `UX_AUDIT.md` §3.4, §4.3, §6 (UX-04).

**Context.** The task detail had one form and a Save button: all edits went out in one `PATCH` with the task's
`base_revision`, a `409` showed "Load latest version". ADR-0051 §4 removes the Save button: every property must
save itself, and the safety rules of AGENTS.md §8/§9 must hold (no overwrite of a newer revision, no silent
loss, idempotent, never two overlapping requests for one document). Per-field saving raises request volume and
makes the order of requests and the revision bookkeeping the core of the feature, so it lives in a small pure
module with its own tests rather than in the component.

**Decisions.**
1. **One save session per task** (`apps/web/src/lib/taskAutosave.ts`, `TaskAutosave`). It holds the last
   version the server confirmed (`task`, whose revision is the next `base_revision`), what the fields show
   (`draft`), the unsaved property groups and the indicator state. The panel binds to it with
   `hooks/useTaskAutosave.ts` (`useSyncExternalStore`); the panel is keyed by task id, so each task has its own.
2. **Property groups, one group per request.** Groups: title, description, status, priority, *schedule* (due
   date, due time, time zone and start travel together because they jointly define the instants, as
   `changesFromDraft` already required), tags, project, repeat. A `PATCH` carries exactly one group, so a `422`
   names the field that caused it and an invalid field never blocks the others.
3. **Serialised, coalesced, revision-chained.** One send loop per session; never two requests in flight for a
   task (asserted by unit tests and by counting overlapping `PATCH`es in the real-stack spec). The body is
   computed from the draft **at send time** against the latest confirmed version, so keystrokes queued behind a
   request become one `PATCH` with the newest text, and each request uses the revision the previous answer
   returned (no self-conflicts). An edit typed back to the server's value sends nothing. A new idempotency key
   per request.
4. **When things are sent.** Menu choices (status, priority, project, time zone, a repeat preset, adding or
   removing a tag) at once. Text (title, description, due date/time, start) after a 600 ms pause and
   immediately on blur, Enter in the title, closing the panel, opening another task (from the list while
   docked, a subtask, the parent, the next occurrence, a linked note), delete, `pagehide` and
   `visibilitychange → hidden` (with `fetch keepalive`), and Ctrl/⌘ Enter or Ctrl/⌘ S. A custom RRULE is sent
   only on blur/Enter (a half-typed rule is never sent). The reminder override (its own endpoint, M8-05) saves
   when chosen; a custom timing when a field is left.
5. **Adopting the server's answer per field.** After a save every field takes the server's value (for example
   the zone the server pins when a due date is first set), except fields the user changed since their group's
   request was built and the field that has focus (a save never rewrites text under the cursor). A newer copy
   of the task from outside the panel (a row action on the same task) is adopted only when nothing is pending;
   otherwise the next save meets the revision check.
6. **Failures never drop an edit.**
   - `409` with `current_revision` → **conflict**: nothing more is sent, the local values stay in the fields,
     the header says *Conflict* and the MU-01 notice offers **Load latest version**. Loading shows the server's
     version and sets the user's changed values aside (only those that differ), offered as **Reapply my
     changes** (saved against the new revision, an explicit choice) or **Dismiss**. No silent last-write-wins.
   - `422`, a refused transition (`409` without a revision), `404` and other client errors → the field keeps
     its text and shows the server's message verbatim; it is not re-sent until it is edited again. An error
     from a pause in typing is held back until the field is left or flushed (no error spam while typing an
     intermediate value); errors from menu choices show at once.
   - Network failure or `5xx`/`408`/`429` → outcome unknown: the exact request (same body, same
     `base_revision`, **same idempotency key**) is kept and re-sent on the next edit, flush, **Retry** or the
     `online` event, so a request that did reach the server is replayed, not applied twice. With the browser
     offline nothing is sent and the header says *Offline — not saved* (mutations stay online-only, R-22).
7. **Leaving with unsaved edits asks first.** Close, switching task and delete flush first and proceed only if
   everything is confirmed; otherwise the panel stays with "Some changes are not saved yet: …" and **Keep
   editing** / **Discard and close|switch|delete**. Discarding is the only way an edit is thrown away.
8. **Sessions outlive the panel while unsaved.** A module-level registry keeps a session with unsaved edits
   after its panel unmounts (navigation, a page-owned panel going away); reopening the task shows the unsaved
   values and the state; the `online`/`pagehide` handlers flush every live session. A clean session is dropped
   on release (deferred a microtask so a StrictMode remount keeps it). Delete forgets the session after the
   flush (undo restores the server's version, which already has the edits).
9. **Indicator** in the panel header, always visible: *Saved*, *Saving…*, *Not saved yet* (held text), *Not
   saved* (rejected), *Offline — not saved*, *Couldn't save* (+ Retry), *Conflict*. It is `aria-live="polite"`,
   not `role="status"` (pages own that role and specs use it unscoped).
10. **Layout.** ≥ 1280 px the panel docks (400 px) beside the page, which gets a right margin
    (`:root[data-task-panel="docked"]`), so the list stays visible and usable; the panel is non-modal and Esc
    closes from anywhere. Below 1280 px it is a modal overlay with a scrim (click closes) and a focus trap;
    ≤ 720 px a full-screen sheet. Focus returns to the row that opened it. The "…" menu (*Task options*) has
    *Copy link* (`/tasks?task=<id>`, opened once by the Tasks page) and *Delete task* (with undo).

**Consequences.** More requests than before (one per group change, bounded by the debounce); acceptable for a
single-user self-hosted instance. `tasksApi.update` gained optional `idempotencyKey`/`keepalive`. No backend
change was needed. Limitations: unsaved task edits survive closing and navigation within the tab but not a
reload while offline or a crash (no local draft store for tasks; notes get theirs in UX-05); a save that fails
after its panel unmounted is shown only when the task is reopened; the time-zone list comes from
`Intl.supportedValuesOf` (a zone it lacks can still be typed and is validated by the server); mutations remain
online-only (R-22).

## ADR-0054 — Note autosave: a framework-free save engine with injected stores, a local draft, and the Notes workspace (UX-05)

**Status:** Accepted (2026-11-03, implements the owner's decision ADR-0051 §4 for notes; UI-only, no backend,
schema or dependency change). **Source:** `UX_AUDIT.md` §4.3, ROADMAP "UX-05 plan". **Owner note (2026-11-03):**
Atlas is expected to become a native desktop app (Obsidian style) that syncs with the owner's own server, so
the save logic must not be tied to the browser.

**Context.** The Notes page had a Save button, a "Discard unsaved changes?" prompt, and one `PUT` per click.
ADR-0051 §4 removes the button: the text must save by itself, and AGENTS.md §8 still applies (no silent
overwrite of a newer revision, no loss of typed text, files stay ordinary Markdown). Unlike task properties
(ADR-0053) a note is one large text field, the file on disk is authoritative and may be edited by other
programs, and the browser must be able to lose its tab at any time, so a local copy of unsaved text is part of
the feature.

**Decisions.**
1. **The engine is portable.** `apps/web/src/lib/noteAutosave.ts` contains no React, no DOM, no `window`, no
   `localStorage`. Everything it needs is injected: `NoteStore` (`update`, `read`, optional `reconcile`,
   `saveConflictCopy`; the web app wraps `notesApi`, a desktop client would wrap its sync layer),
   `DraftStore` (synchronous `read/write/clear`; the web app uses `localStorage` in `lib/noteDrafts.ts`, a
   desktop client would use a file or SQLite, an in-memory one ships for tests), `isOnline`, `now`, and the
   global `setTimeout`. Errors are recognised structurally (an object with a numeric `status`), not by
   importing `ApiError`. The React binding (`hooks/useNoteAutosave.ts`) and the page are the only web-specific
   parts. A native client reuses the engine and its unit tests unchanged. IndexedDB was not chosen for drafts
   because the draft must be written synchronously on every keystroke and read synchronously on open (a page
   being unloaded cannot await); an async store can sit behind the same interface with an in-memory mirror.
2. **One session per open note** (`NoteAutosave`), kept in a registry (`NoteSessions`) while it holds unsaved
   text, so switching notes or leaving the page never drops text; a clean session is dropped on release.
3. **Timing.** Debounce 1 s after the last change; flush on switching note, creating, opening the daily note,
   rename, move, sign-out, Ctrl/⌘ S, `pagehide` and `visibilitychange → hidden` (`fetch keepalive` for bodies
   under 60 KB; a larger note relies on its draft). Delete does not flush (the note is going away).
4. **One request in flight per note; coalescing; revision chaining.** A single send loop builds each body from
   the newest text at send time against the revision the previous answer returned. Text typed back to the
   server's text sends nothing.
5. **Local draft.** Written synchronously on every change as `{content, baseRevision, savedAt, attempted?}`
   (`attempted` = the text of a request that may have been applied without its answer arriving). It is cleared
   only when the server has confirmed exactly the text in the editor. On open: equal to the server → dropped;
   typed on the revision the server still holds, or on the state our own possibly-applied request created →
   put back and saved (the revision check guards it); typed on an older revision → shown in conflict with the
   usual choices and **never applied silently**. The restored text is only sent after the host has attached its
   listeners (`resume()`), so the first answer cannot arrive unseen.
6. **`409` never overwrites.** The session stops sending, keeps the text in the editor and the draft on disk,
   and shows the existing choices *Keep my version as a copy* (server writes a conflict copy next to the note,
   then the server's version is shown) and *Reload server version* (local text dropped). Before it reads the
   server's version the store may `reconcile()` (the on-demand scan, `POST /api/notes/reconcile`, ADR-0010):
   an edit made by another program is only visible to the revision check once indexed, and without it "reload"
   would keep conflicting.
7. **Unknown outcomes.** A network failure, timeout, `429` or `5xx` keeps the exact request (same body, same
   `base_revision`) and sends it again on the next edit, flush, *Retry* or the `online` event. The note `PUT`
   has no idempotency key and the backend is unchanged, so if the retry answers `409` (the first try was
   applied) the note is re-read: **equal to the text that was sent → saved at the server's revision**;
   different → genuine conflict. If the re-read itself fails nothing is overwritten and it is tried again
   later. Any other `4xx` keeps the text and shows the server's message verbatim; it is not re-sent until the
   text changes.
8. **Offline.** Nothing is sent; the header says *Offline — saved on this device*; the draft holds the text
   across a reload or a closed tab and it is sent when the page is opened or the `online` event fires.
   Structural operations (create, rename, move, delete) stay online-only (R-22).
9. **Indicator.** `[data-save-state]` in the note header: *Saved*, *Saving…*, *Not saved yet*, *Offline —
   saved on this device*, *Couldn't save — kept on this device* (+ Retry), *Not saved*, *Conflict*;
   `aria-live="polite"`, not `role="status"`. The revision is only in the tooltip of the path.
10. **Workspace.** Tree (header icons: New note, New folder, New from template, Today's note, Collapse all;
    row "…" menu through the shared `Menu`: Rename (inline name box), Move to…, New from template, Delete;
    folders: New note/folder here, Rename, Delete; no path text box and no `window.prompt`; delete still uses
    `window.confirm`), editor header (breadcrumb with the file path, save state, Preview toggle, details toggle,
    "…" with Task from selection, Rename, Delete), full-height editor with a centred 72ch column and a
    token-based CodeMirror theme, details panel (Links, Backlinks, linked tasks and projects, tags) toggled with
    Ctrl/⌘ Alt B and remembered per browser (default open from 1440 px; an overlay below that; on phones closed
    and not remembered). The shell's sidebar docks on Notes only from 1280 px (a drawer below; `.compact` in
    `Layout.tsx`). Phones show the tree or the note. `[[links]]` render as links in the preview; unknown targets
    show as plain text. New notes are created in the folder that is open in the tree.
11. **Editor safety.** Replacing the text from outside (switching notes, reload server version) is not added to
    the undo history and the editor is keyed per note, so Ctrl+Z can never step back into another note's text
    or empty the note.

**Consequences.** More `PUT`s than before (at most one per second of typing, one at a time); each rewrites the
file atomically. The engine is covered by 27 unit tests with a fake revisioned server (`noteAutosave.test.ts`)
and by real-stack specs (`ux05-notes.spec.ts`) that check the file bytes on disk. Known limitations: drafts live
in `localStorage` (about 5 MB per origin; a very large unsaved note may not be stored, and the draft is not
removed at sign-out when it could not be saved, RISKS R-23); delete asks with a native `confirm`; the tree shows
note titles (first heading), not file names; a renamed or moved note keeps the revision the server assigns, so
an open second tab conflicts once and recovers through the normal choices; no collaborative merge (conflicts are
resolved as copy-or-reload, never merged).

## ADR-0055 — Product direction: local-first clients (desktop, Android) syncing to the self-hosted server

**Status.** ACCEPTED by the owner 2026-11-03, including the conflict policy (§4). Nothing is implemented; each
item (Tauri, Android) is verified by a spike before it is relied on.

**Owner requirements.** Self-hosted; desktop and mobile clients that are *local first* (work on local data, sync
automatically to the server for cross-platform availability); desktop is a native app, Obsidian style. Platforms:
Linux, Windows (work laptop, so no admin-only install assumptions) and Android; macOS/iOS are not required.
Priorities: cross-platform, fast, secure.

**Against today's design.** The server is authoritative (Markdown files on the server, PostgreSQL for tasks and
projects) and UI mutations are online-only (R-22). Local-first makes each client hold a full local copy; the
server becomes the sync hub and the durable backup, still owning accounts, auth and provider integrations
(calendar tokens never leave the server).

### 1. Shell: Tauri 2 (recommended, accepted)
- Reuses the existing React web UI unchanged; ships on Linux, Windows and **Android** from one codebase and
  tool chain (Tauri 2 targets desktop and mobile), which Electron does not.
- Small installers and memory (uses the system webview), Rust core, deny-by-default capability/permission model
  for the web layer: the best security and size trade-off for a notes app.
- Costs: the system webview differs per OS (WebKitGTK on Linux, WebView2 on Windows, Android System WebView), so
  CSS/JS must be tested on all three; Rust is needed for native code; Tauri's Android support is younger than its
  desktop support. Electron (bundled Chromium: identical rendering everywhere, larger and heavier, no Android)
  remains the fallback if WebKitGTK problems prove unmanageable.
- Gate: a spike (Linux + Windows build, SQLite plugin, file-system access, notifications, auto-update, the web UI
  rendering) must pass before milestone 9 is planned on it. Licence and maintenance are checked per AGENTS.md §14
  at that point.

### 2. Desktop notes: a real folder of `.md` files (accepted)
The desktop client's notes are ordinary Markdown files in a user-chosen folder, editable by other tools
(AGENTS.md §8). A local index (in the local database) holds paths, content hashes, revisions and sync state; the
file watcher is a hint, not a guarantee, so a scan reconciles on start and on focus. The server keeps notes as
files too, so both sides stay portable.

### 3. Local store and sync (accepted: local database with sync)
- SQLite on each client for tasks, projects, the note index, the sync queue and per-entity revisions.
- Every change is a revision-checked, idempotent operation (already true of the API: `base_revision`,
  idempotency keys), queued locally and pushed when connected; clients pull incremental changes (a server-side
  change feed with a cursor; the cursor only advances after the changes are applied, AGENTS.md §10 spirit).
- Deletes are tombstones; ids are client-generated UUIDs so a retry never duplicates.
- Order is decided by **server-assigned revisions**, never by device clocks (clocks drift).
- The existing engines (ADR-0053 task saves, ADR-0054 note saves) are already framework-free and take injected
  stores, so a local store plugs in under them instead of rewriting them.

### 4. Conflict policy (RECOMMENDED, needs the owner's OK)
"Latest change wins" everywhere is rejected: it silently loses data (AGENTS.md §10) and device clocks are
unreliable. Recommended instead, by kind of data, so the owner is asked as rarely as possible:
1. **Different fields of one task changed on two devices: merge automatically** (title on one, due date on the
   other: both kept).
2. **Same simple field changed on both (status, priority, due, project, tags): the later change, in server
   order, wins automatically.** The overwritten value is kept in the task's history and the other device shows
   "changed on another device" with one-click undo. Nothing is lost, nobody is prompted.
3. **Same text field changed on both (task title/description): keep both and ask** (a conflict marker with the
   two versions), because merging prose by rule can corrupt it.
4. **Edit versus delete: the edit wins** (the task comes back, with a notice). Losing a deletion is
   recoverable; losing an edit is not.
5. **Notes: three-way text merge** against the common base. Non-overlapping edits merge automatically and silently
   (typical: edited on the laptop and on the phone in different paragraphs); overlapping edits never overwrite:
   the other version is saved as a conflict copy and the note shows a resolve action (today's behaviour, ADR-0054).
   A note is never merged into an invalid state: if a merge is uncertain, it is a conflict.
6. **Calendar-owned events stay with the provider**; Atlas never resolves those locally (AGENTS.md §10).
Every automatic resolution is logged (what, when, which device, no content in logs) so it can be inspected and
undone.

### 5. Mobile: Tauri 2 for Android (recommended, to be spike-proven), PWA as the fallback
Same web UI and the same sync client as desktop, with native notifications and a real SQLite. If Tauri Android
fails the spike (background sync limits, notifications, store distribution), the fallback is the installable web
app (PWA) with an IndexedDB/SQLite-wasm store, which still gives offline use but weaker background sync and
reminders. iOS is out of scope. Decide after the spike; this supersedes open decision A-09 only once the spike has
passed.

### 6. Consequences and sequencing
- This is milestone 8 (cross-device and offline sync) and milestone 9 (native apps), and a hard prerequisite is a
  server **change feed + tombstones** API and a per-entity revision on every table; plan these as the first
  vertical slice, before any native shell work.
- Order of risk: (1) sync protocol design and a server change feed, tested against concurrent-edit and offline
  cases; (2) Tauri spike on Linux/Windows/Android; (3) desktop client with the local DB and notes folder;
  (4) Android; (5) conflict UI.
- Until then: keep client logic out of React, keep every write revision-checked and idempotent, add no new
  online-only assumptions beyond R-22. UX-06/UX-07 are unaffected. Security: local database and note folder are
  not encrypted by Atlas (the OS disk encryption protects them); the server session/token for sync is stored in
  the OS keystore, never in plain files (to be designed in `SECURITY.md` with the sync protocol).

## ADR-0056 — Live preview: a third editor mode made of CodeMirror decorations only; Live is the default (UX-06)

**Status:** Accepted (2026-11-03, implements ADR-0051 §5 and `UX_AUDIT.md` D-2; UI-only, no backend or schema
change). The gate in ADR-0051 §5 ("Live becomes the default once its round-trip tests pass") was met before
the default was changed; evidence in `ACCEPTANCE.md` UX-06.

**Context.** The note editor was Source only (CodeMirror 6 showing the Markdown as typed) with an optional
rendered split (**Preview**). Obsidian-style live preview hides the syntax on lines the cursor is not on. The
risk is data integrity (AGENTS.md §8): a view that edits the document, or an editor that normalises it, would
change files that must stay ordinary Markdown.

**Decisions.**
1. **Decorations only.** `apps/web/src/lib/livePreview.ts` is a CodeMirror extension that *only decorates*:
   line classes, mark classes, empty `Decoration.replace` (hides a mark) and three small replace widgets
   (bullet, rule, checkbox). It never builds HTML from note text (widgets are made with DOM calls from
   constants; the one note-derived widget value, the checkbox's accessible name, is set with `setAttribute`),
   never inserts, and never writes the document. The only two ways it produces a transaction are explicit
   user actions: ticking a task checkbox (replaces the one character between `[` and `]`) and
   **Ctrl/⌘ Enter** on a task line. Both are ordinary, undoable transactions that reach
   `session.change(text)` through the editor's existing update listener (ADR-0054); the save engine is
   untouched.
2. **Three views, two switches.** The note header has a **Source | Live** group (`role="group"`
   *Editor mode*, buttons with `aria-pressed`, names `Source` and `Live`) and the existing **Preview** toggle
   (rendered split) is unchanged. Live and Preview combine. The mode is remembered per browser
   (`atlas-notes-mode`, `lib/notesPrefs.ts`); with nothing stored the default is **Live** (set after the
   round-trip tests passed; before that the default constant was `source`).
3. **Reconfigured, not recreated.** Live sits in a CodeMirror `Compartment` inside the one editor per note.
   Switching mode reconfigures that compartment, so the document, the selection, the focus and the undo
   history are exactly as they were.
4. **What is hidden, and when.** On lines that hold a cursor or part of a selection, and only while the editor
   has focus, nothing is hidden (marks are dimmed). Every other line hides: `#` heading marks, `*`/`_`/`~~`/
   backtick marks, `[`/`](url)` of a link (label underlined), `[[` `]]` and the target of an aliased wiki link,
   `>` quote marks, `-`/`*`/`+` bullets (shown as a bullet), `[ ]`/`[x]` (shown as a checkbox), `---` rules
   (shown as a line) and backslash escapes. Headings are scaled with the type tokens, code fences/tables/front
   matter are mono blocks, `#tags` are chips. Inside code, HTML, URLs and front matter nothing is interpreted.
   The cursor is always on a line whose marks are visible, so no character is ever unreachable by keyboard:
   arrow keys move into a line and reveal its syntax. Tables, images and HTML are shown as text (images are not loaded: no
   request is made for a URL a note contains).
5. **Untrusted content (AGENTS.md §8, SECURITY T3/T6).** No `<a>`, `<img src>`, `<script>`, `<iframe>`, `style`
   or event-handler attribute is ever created; links are styled spans and no URL is copied into an attribute
   (a note-derived `title` is a fixed string). A link opens only on **Ctrl/⌘ click** (or Ctrl/⌘ Enter in it)
   and only if the URL parses with scheme `http`, `https` or `mailto` (`safeExternalUrl`; `javascript:`,
   `data:`, `vbscript:`, `file:`, `blob:`, relative and unparsable are refused), in a new tab with
   `noopener,noreferrer`. A `[[wiki link]]` to an existing note opens on a plain click when its line is
   rendered, and on Ctrl/⌘ click otherwise; an unresolved one does nothing.
6. **Line endings are the note's own.** The editor now sets `EditorState.lineSeparator` to `\r\n` when the text
   has any CRLF, else `\n`, and serialises with `state.lineBreak`. Before, CodeMirror's default separators
   turned CRLF, a lone `\r` or U+2028 into `\n` on the first keystroke, silently changing the file. A text with
   a different line ending arriving from outside (reload of the server version) rebuilds the editor state
   (not undoable, like any outside replacement).
7. **Markdown dialect.** `markdown({ base: markdownLanguage })` (GFM: strikethrough, tables, task lists) instead
   of plain CommonMark, so the syntax tree knows them. It changes highlighting/tree only; the list-continuation
   key bindings (`markdownKeymap`) were already on and are unchanged.
8. **Dependencies.** No new code. `@codemirror/language` (`syntaxTree`) was already installed as a dependency of
   `@codemirror/lang-markdown`; it is now declared in `package.json` because it is imported directly (same
   version, lockfile gains the explicit root entry). No Lucide shape is added.
9. **Keyboard and screen readers.** The editor remains one `role="textbox"` named *Note content* in both modes.
   Checkbox widgets are `tabindex="-1"` (a long list would otherwise trap Tab) and carry the item text as
   their name; **Ctrl/⌘ Enter** ticks the task or opens the link at the cursor, so nothing is mouse-only.

**Consequences / limitations.** Hiding is per line, not per element (Obsidian reveals only the element under the
cursor). Nested lists show no hanging indent for wrapped lines; ordered-list numbers, tables and images stay as
text; hidden marks make a line's width differ between rendered and source (the line reflows when the cursor
enters it). Dragging a selection
that starts on a rendered wiki link opens the note instead (the press is taken as a click). The server reads
files with Python universal newlines, so a CRLF note arrives as LF and saves back as LF (R-24); the editor-side
CRLF fidelity is proven at unit level only. Rollback: set `DEFAULT_EDITOR_MODE` back to `"source"`, or remove
the extension from the compartment; nothing is stored differently.

## ADR-0057 — Tasks, Projects and Board: filter bar, project header with tabs, board keys (UX-07)

**Status:** Accepted (2026-11-03, within the owner's UX direction ADR-0051 and `UX_AUDIT.md` §4.3; UI-only: no
backend, schema or new npm package; every write is the existing revision-checked, idempotent call, so it keeps
the local-first direction of ADR-0055).

**Context.** The Tasks page was a stacked form (seven controls plus a saved-filter section), a bulk bar that
scrolled away, and no board. Projects had a visible Archive button per row and a native `<progress>`; a project
page was one long scroll with a List/Board toggle; board cards repeated the full row meta and the board had no
keyboard move; dates showed as `2026-10-13` on the project page and `Wed 4 Nov` elsewhere.

**Decisions.**
1. **One filter bar** (`components/FilterBar.tsx`): search field, chips Status / Priority / Project / Due / Sort,
   a List | Board segmented control, "Reset filters" (only when something is set) and a "…" menu. Chips are
   `MenuButton`s (`components/MenuButton.tsx`) opening the shared `Menu` (ADR-0052) with radio entries, so focus,
   keys and dismissal are not re-implemented; a chip shows `Label: value` when it is not at its default. The Due
   chip opens a `Popover` (`components/Popover.tsx`, a non-modal anchored `dialog` with the same placement,
   top-layer and Esc/outside rules as the menu) holding presets (Any date, Overdue, Today, Next 7 days) and the
   two date fields. The filter stays in the URL exactly as in ADR-0045; the only addition is `view=board`
   (`TaskFilter.view`, default `list`, written only when `board`); it does not trigger a reload (the query key
   ignores it). Pure rules (`dueRangeFor`, `duePresetOf`, `dueLabel`, `chipValues`, `isFiltered`) are in
   `lib/taskFilters.ts` with unit tests.
2. **Saved views live in the bar's "…" menu** (*Save this view…*, *Saved views*, *Remove a saved view*), not
   in the sidebar: the sidebar is built only from `NAV_SECTIONS` (ADR-0051/UX-02) and saved views are
   per-browser `localStorage` data (`hooks/useSavedFilters.ts`, same key and format as MU-03), so putting them in
   the shell would couple it to a page's storage. Revisit if saved views ever become server data.
3. **Bulk selection** is unchanged (square box, `x`, *Select all*, one revision-checked request per task,
   failures reported per task, delete with undo) but the bar (`components/BulkBar.tsx`) is `position: sticky`
   above the status bar (and the phone bottom nav) so it stays in reach; the project picker is a menu button
   named *Move selected to project*. *Clear selection* is new.
4. **Board on the Tasks page** renders the *filtered* tasks through the existing `Board` (moves use
   `actions.setStatus`, which refreshes); it is a view of the same query, so it respects the status filter
   (default Open hides Completed cards, and a card moved to Completed leaves the board until the filter allows it).
5. **Board cards are compact** (`TaskMeta compact`): title, project dot and name (omitted on a project's own
   board), due, and an icon-only priority flag whose name is screen-reader text ("High priority"); subtask counts
   and tags stay in the row and the panel. **Archived is a column behind a toggle** (`archivedToggle`, "Show
   archived (n)", per visit, not remembered); a hidden column is also excluded from key moves.
6. **`[` and `]` move the focused card** to the nearest column in that direction the state machine allows
   (`adjacentStatus` in `lib/taskStatus.ts`, a client copy of the server table as before; the server still
   validates). Ignored while typing and with Ctrl/⌘/Alt. After the move the card is re-created in its new column,
   so the board re-focuses it there once the new status arrives (expires after 5 s so a failed move never steals
   focus later) and announces "Moved X to Y" / "X cannot move left from Inbox" in a polite live region that is
   deliberately not `role="status"` (pages and specs own that role). Drag-and-drop and the card menu's *Move
   to…* are unchanged. Listed in the shortcut help.
7. **Projects**: one row per project (name, status pill, tokenised progress bar, "n open", target date, "…").
   The bar is a `role="progressbar"` span painted with tokens (`ProjectProgressBar`); `<progress>` remains only in
   subtask counts. Archive/Restore and *Open project* are in the row menu; archived projects are behind *Show
   archived (n)*. "Open" is `progress.total - progress.completed` as the server derives it (ADR-0023), not
   recomputed from tasks.
8. **Project page**: header (name, status pill, "…" menu *Project options* with *Edit project* / *Archive
   project* / *Restore project*, progress, dates), then WAI-ARIA tabs (`components/Tabs.tsx`, automatic
   activation, ← → Home End) **Tasks | Board | Notes**, kept in the URL as `?tab=` so a reload and a link keep
   the tab. Tasks: capture, open tasks, then `FoldGroup`s *Completed (n)* and *Archived (n)* (collapsed). Board:
   `Board` with the archive toggle. Notes: linked notes and the *Link a note* select.
9. **One date format** (`formatDay` in `lib/tasks.ts`): weekday, month, day in the viewer's locale
   (the same options `formatDue` uses), plus the year only when it is not the current year; used for project
   start/target dates and the Due chip's custom range. No ISO date is shown to the user (checked by a spec on
   Projects and the project page). Timestamps with a time (Sync, Settings) are a different thing and unchanged.
10. **No new icons** (existing `search`, `chevron-*`, `ellipsis`, `refresh-cw`, `inbox`, `file-text`,
    `folder-kanban`), no dependency.

**Consequences / limitations.** The Tasks page still sorts client-side over the first 500 matches
(ADR-0045). *Show archived* and the fold groups reset on reload. Saved views are not shared between browsers.
Board mode on the Tasks page cannot show a card after it leaves the filter (by design). On a phone the board's
columns scroll horizontally inside the board (the page does not). Names that changed and were updated in
specs: the status/priority/project/due/sort `select`s and *Saved filter* controls (now chips, "Filter options"
menu and popover), the project page's *Board* button (now a tab), *Edit/Archive project* (now in *Project
options*), *Restore <name>* on the Projects page (row menu), and *Link a note* (Notes tab). Rollback: UI-only; the
URL format is a superset of ADR-0045's.


## ADR-0058 — Settings sections, skeletons and one empty state (UX-08)

**Status:** Accepted (2026-11-03, within the owner's UX direction ADR-0051 and `UX_AUDIT.md` §3.4, §4.3, §6;
UI-only: no backend, schema or new npm package, no new network call or stored data, so it keeps the local-first
direction of ADR-0055).

**Context.** Settings was one long page (account, theme, notifications, export, backups, instance) while Sync,
Calendar and Notifications were three more pages in the sidebar's *More* section, with Notifications duplicating
a block of Settings. Every list page showed a bare "Loading…" line and the empty lists were a dashed box of
developer-style prose, each styled by hand. The sign-in and first-run pages had no `main` landmark.

**Decisions.**
1. **Settings is a two-column page: a section list and one section at a time**, addressed as `/settings/<section>`
   (`Account`, `Appearance`, `Notifications and reminders`, `Calendar`, `Sync`, `Data and backups`, `About`;
   one table, `lib/settingsSections.ts`). A path segment (not `?section=`) because it reads as a page, needs no
   parsing in the router and keeps `/settings` valid. `/settings` shows Account on a wide screen and only the
   list on a phone; an unknown segment redirects to `/settings`. The section list is real links (`aria-current`),
   so Back, reload and links work; the phone drill-in is a CSS switch on `data-view="index|section"` with an
   "All settings" link, so no viewport logic lives in React.
2. **The pages that became sections redirect**: `/sync`, `/notifications`, `/calendar` →
   `/settings/<section>` (`SETTINGS_REDIRECTS`, used by the router and by `normalise` in `lib/navigation.ts`).
   `NAV_SECTIONS`' *More* section now holds only Search and Settings; every `/settings/*` path is the one
   Settings entry (one active sidebar and rail item). The status bar links straight to the sections. The command
   palette is built from `PALETTE_PAGES` = the nav items plus `SETTINGS_PALETTE`, so "Go to Sync", "Go to
   Calendar", "Go to Notifications" (and Account, Appearance, Data and backups, About Atlas) still work.
3. **Content and behaviour are reused, not rewritten.** `SyncSettings` and `CalendarSettings` are the former page
   bodies (same hooks and `SyncStatusPanel` / `SyncStatus`), `NotificationSettings` is unchanged, and the Account,
   export, backup and instance code moved into `components/settings/` with the same messages, ids and labels.
   Rows are "label and description left, control right" (`SettingsRow`); no section has more than one primary
   button (none uses one). Instance data (`GET /api/instance`) is loaded only by the two sections that show it
   (`useInstanceInfo`), so the Sync, Calendar and Notifications sections make no extra request.
4. **One `Skeleton`** (`components/Skeleton.tsx`) replaces the "Loading…" lines on Inbox, Today, Upcoming, Week,
   Tasks, Projects, Board, the project page, the Notes tree, and inside the Sync, Calendar, backup and instance
   sections: bars in `--bg-hover`/`--bg-selected` with a slow shimmer that stops under `prefers-reduced-motion`
   (the global rule and an explicit one). Rows reserve the height of a real task row (36 px) so the heading and
   capture box above do not move. It is the page's `role="status"` with screen-reader text ("Loading inbox…"),
   exactly as the line it replaces was, so unscoped `getByRole("status")` in specs and unit tests keep working;
   the bars are `aria-hidden`.
5. **One `EmptyState`** (`components/EmptyState.tsx`): icon (existing `Icon` shapes only), one sentence and at
   most one action as an ordinary secondary button; not a `role="status"`. Used on Inbox ("Inbox zero"), Today
   (one state instead of three empty groups; the groups return as soon as anything is due or scheduled),
   Upcoming, Week, Projects, Tasks, Notes (tree and editor pane), and in the Sync and Calendar sections. **Tasks
   distinguishes** "no results" (a filter is set: "No tasks match these filters.", no action because the bar's
   *Reset filters* is the action) from "none yet" ("No open tasks. Capture one in the Inbox." with *Go to
   Inbox*). The dashed box and its developer wording are gone.
6. **Sign-in and first-run** were already a centred token-styled card; the only defect was the missing `main`
   landmark (axe `landmark-one-main`, `region`), fixed by making `.auth-page` a `<main>`; their errors are now
   `role="alert"`.
7. **Not done (scope).** The compact-density toggle listed in `UX_AUDIT.md` UX-08 (no page has a density token
   to switch), account recovery (AUTH-01), a Today date picker, new settings. No new icon, so
   `docs/DEPENDENCIES.md` is unchanged.

**Consequences / limitations.** A visitor on a phone at `/settings` sees only the list (the Account form is
in the DOM but `display: none`). Section content mounts only for the open section, so leaving Sync or Calendar for
another section drops its in-memory state (the data comes from the offline queue and the API, not from the
component). Names that changed and were updated in specs: the Sync, Calendar and Notifications pages no longer
have an `h1` of their own (the h1 is *Settings*, the section is an `h2`); J7 now opens each section from the list;
ux02 and mu08 use the new URLs. Rollback: UI-only; the old URLs are redirects, so reverting restores them.

## ADR-0059 — Local-first sync protocol: decisions that need the owner (SYNC)

**Status:** ACCEPTED by the owner 2026-11-03 (all recommendations D1–D12 as written). Nothing here is implemented yet. The full
design, the gap analysis against M7 and the message shapes are in `SYNC_PROTOCOL.md` (the single source for
those; this record keeps only the choices). Implements the sequencing of ADR-0055 §6 ("protocol and change feed
first, before any native shell work").

**Context.** ADR-0055 accepted local-first clients and the §4 conflict policy. Reading the code (not the roadmap)
shows that M7 delivered a sound per-user cursor, tombstones and a browser-only queue, but several things ADR-0055
assumes are not true: the API has no client-generated ids, no field-level merge, no note history/three-way merge,
no device credentials, no versioning; the feed misses server-side note reconciliation; the retention purge removes
the ability to bootstrap from `since=0`; and a restored server is invisible to clients (`SYNC_PROTOCOL.md` §2).

**Conflicts with accepted ADRs (listed so approval is explicit).**
- **ADR-0033** (retention): purges every `change_log` row older than 30 days. D2 changes the purge to tombstones
  only, defines `since=0` as a snapshot, and lengthens the default window. Supersedes part of ADR-0033 if accepted.
- **ADR-0055 §3**: "ids are client-generated UUIDs … already true of the API" is not true today (D3 adds it).
- **ADR-0055 §4 rule 4** (edit wins over delete) is the opposite of today's `404`; D6 changes server behaviour in
  sync mode only.
- **ADR-0055 §4 last line** ("logged … no content in logs") versus rule 2 ("the overwritten value is kept in the
  task's history"): D7 resolves it as: values of *simple* fields live in a database table (not application logs);
  text and note content are never copied into the log.
- **ADR-0034/0035/0036** (browser IndexedDB queue, keep-local conflict, metadata-only cache): the algorithms stay
  as the web fallback; on desktop/Android the queue and server-state move to SQLite behind the same store
  interface (SYNC-08). Their "feed carries no payload" premise changes (D2).
- **ADR-0019** (`GET /api/tasks/changes`) becomes a second, overlapping feed; D2 freezes it and deprecates it
  once `include=data` ships (AGENTS.md: no duplicate sources of truth).
- **ADR-0054 §7** (note `PUT` has no idempotency key): D1 adds one in sync mode; non-sync behaviour unchanged.

**Decisions requested.** Each shows options, then the recommendation (R).

**D1 — Shape of the write API.** (a) Extend the existing endpoints with an opt-in `Atlas-Sync: 1` mode
(required idempotency key and base revision, field-level merge, structured conflicts); (b) a new
`POST /api/sync/push` batch endpoint carrying a list of operations. R: **(a)**. It reuses validation, services and
tests, leaves the web app untouched, and N sequential requests are acceptable at personal scale; a batch can be
added later if SYNC-02 measures a problem. Cost of (a): more requests after a long offline period.

**D2 — Feed and retention.** (a) Keep ADR-0033 as is and add a separate bootstrap endpoint; (b) keep all
`upsert` rows, purge only tombstones older than N days, `since=0` = snapshot without tombstones, add
`include=data`, `types=`, `resync_reason`; N = 30 / **90** / 180 / never. R: **(b) with N = 90**. The log is one row
per entity, so retaining upserts costs nothing noticeable and removes a whole endpoint. A holiday of six weeks
no longer forces a resync; one beyond 90 days resyncs non-destructively (`SYNC_PROTOCOL.md` §7.3). Trade-off:
the log grows with the number of entities (bounded).

**D3 — Client-generated ids and note identity.** (a) Client temp ids mapped by the server; (b) optional client
`id` (UUID v4/v7) on create, idempotent by id, plus replacing `uq_notes_user_id_path` with a partial unique index
on live paths so a tombstoned path can be reused by a different note. R: **(b)**. Needs a migration and care in
`NotesService.create` (today a create at a tombstoned path revives the old id) and `reconcile`.

**D4 — How task/project merge knows what changed.** (a) `field_revisions jsonb` per row: field → revision at
which it last changed; (b) a full per-revision snapshot/history table; (c) an operation log. R: **(a)**: the
smallest thing that answers "did field f change after base revision r?", backfilled to the current revision.
Limits: it cannot reconstruct an old value (the resolution log stores the overwritten *simple* value, D7);
`tags` is treated as one simple field (no per-tag merge).

**D5 — Where note merge happens, and history.** (a) Server merges, keeps `.atlas/history` revision files (last 20
and 90 days); (b) client merges using its locally kept base; server stays a revision check. R: **(a)**: one
implementation (AGENTS.md §7.4), recoverable pre-merge versions, history is also useful for undo/backups. Cost:
disk, a merge dependency or implementation to be chosen and licence-checked in SYNC-04 (AGENTS.md §14; none chosen
yet), and backups must include history. An uncertain merge is always a conflict copy.

**D6 — Edit versus delete.** R: as ADR-0055 §4 rule 4: in sync mode a stale `DELETE` is refused (`edit_wins`) and a
`PATCH`/`PUT` of a tombstoned entity restores it, both logged. Alternative (rejected): delete wins, because a lost
edit is unrecoverable.

**D7 — Resolution log.** Table `sync_resolutions`, announced through the feed, 90-day retention, `loser` holds
simple-field values only; one-click undo (`SYNC_PROTOCOL.md` §9). Alternative: log field names without values (no
undo for fields). R: with values, as ADR-0055 §4 requires undo.

**D8 — Device credentials (with AUTH-01).** (a) Reuse the browser session cookie from the native client; (b)
per-device bearer token: random 256-bit, only its hash stored, shown once, 24 h rotation grace, 90-day idle
expiry, listed and revocable in Settings, OS keystore storage, HTTPS only, never given to the webview. R: **(b)**.
Sub-decisions: created by e-mail+password exchange now, pairing code later; password *change* revokes browser
sessions only, but the AUTH-01 recovery reset and `atlas-admin reset-password` revoke **all** device tokens.
Sequencing: SYNC-06 builds the device table and revoke function; AUTH-01 calls it (the owner's order is Sync,
then Auth, so the two meet there).

**D9 — Versioning.** Protocol major in `Atlas-Sync`, supported range and entity schema numbers in
`GET /api/instance`, `426` outside the range, `types=` negotiation with backfill on new types, client refuses a
newer local database. R: as written in `SYNC_PROTOCOL.md` §10.2. Support window: current and previous protocol major.

**D10 — v1 scope limits.** R: out of v1: attachments/non-`.md` files (left untouched, never deleted), empty
folders, calendar events on devices (calendar stays online-only), per-tag merge, multi-user sharing. Reminders:
`reminder_policy` and preferences sync; each device schedules its own local notifications from synced task data.
**Open for the owner: Android notes storage**: Tauri's fs plugin documents app-folder access and external-storage
permissions only (checked 2026-11-03); a user-chosen shared folder on Android (Storage Access Framework) is
**unverified**. R: Android keeps notes in app-private storage (a full local copy that syncs), not a shared folder,
unless the spike proves SAF access; desktop is a real folder as accepted. The web app stays online-first.

**D11 — Clocks.** No ordering decision uses a device clock. Server-set times (`completed_at`, conflict-copy
names, history) use the server clock; clients use their clock for display and local reminder firing only.
Accepted as a rule; the simulation tests it with large skews.

**D12 — Server restored from backup.** `since > head` ⇒ `resync_required(cursor_ahead)`; the client never
re-uploads automatically: it shows what the server lost and re-creates on confirmation (client ids make that
idempotent). Operator runbook step to follow (OPERATIONS.md). Alternative: the server refuses sync from
"ahead" clients until the operator acknowledges. R: client-side confirmation, plus an `epoch` check for a
different server.

**Consequences.** If accepted: server changes land first as SYNC-01…SYNC-06 (fixes, harness, protocol,
notes merge, resolution log, devices) with the simulation harness as the main evidence; the Tauri spike
(SYNC-07) runs before any native client task; no existing client behaviour changes until a client sends
`Atlas-Sync`. Costs: several migrations (`field_revisions`, `sync_resolutions`, `devices`, partial path index,
`revision` on reminder policies/preferences), history storage, a merge dependency, and a permanent
compatibility burden (two protocol majors). Rollback: all schema changes are additive; sync mode is opt-in.

**Implementation (SYNC-03, 2026-11-03, local).** D1-D4, D6 (tasks/projects), D9, D11 and D12 are implemented on the server with the
tests in `ACCEPTANCE.md` SYNC-03; D3 for tasks, projects and notes (client ids, partial live-path index). D5, D6 for notes,
D7, D8, D10 (client side) remain with SYNC-04/05/06/09. Four refinements discovered while implementing, none of which changes a
decision: (a) a snapshot walk sends `snapshot=true` after its first page, otherwise a floor above its position makes a
multi-page bootstrap restart forever (simulation seed 29); (b) D12 is made concrete as an `epoch` in `instance_meta`
that `atlas-admin record-restore` rotates, plus an `Atlas-Epoch` request header answered `409 epoch_mismatch` (without it a
restored server whose cursor has regrown past a client's looks normal); (c) note-write idempotency records store the summary, not
the 5 MiB body; (d) `DELETE` carries `base_revision` as a query parameter. The idempotency-key TTL equals the tombstone window
(`CHANGE_RETENTION_DAYS`), the setting keeps its name.

**Not decided here (spike / later):** the Tauri verdict and Electron fallback (SYNC-07, criteria in `ROADMAP.md`),
the merge library, the batch endpoint, pairing flow, Android background-sync mechanism.

## ADR-0060 — Note history, three-way merge and conflict responses (SYNC-04)

**Status:** ACCEPTED as the implementation of ADR-0059 D3, D5, D6 and D10 for notes (2026-11-03, local, not committed, CI not run).
Nothing below changes an owner decision; it records the choices the implementation had to make where the protocol text left room.
Contract: `SYNC_PROTOCOL.md` 6.3, 11; storage rules: `MARKDOWN_STORAGE.md` 4a; evidence: `ACCEPTANCE.md` SYNC-04.

**1. History is a table of metadata plus content-addressed files.** `note_revisions` (migration `e7a3c5b1d9f2`, reversible, metadata
only) holds one row per retained revision; the text is `.atlas/history/<note_id>/<sha256>.md`. Deviation from the sketch in
`SYNC_PROTOCOL.md` (`<revision>.md`): content addressing makes a move or delete (a revision bump without a text change) free
instead of copying up to 5 MiB, makes a file its own integrity check (a damaged file is never used as a base), and makes pruning a
set difference. Every write path records its revision in the same transaction (create, write, merge, move, folder rename, delete,
revive, reconcile), **in every mode**, so a sync client can be merged against a revision the web app produced. The text of the
*new* revision is stored at write time (not the superseded text at the next bump), because an external edit overwrites the old bytes
before Atlas can copy them. A note that predates the migration is recorded lazily by the first write that finds its current
revision unrecorded and the file's hash equal to the index hash; older revisions are unavailable (a stale client conflicts).
Retention: newest 20 always, older ones for 90 days, never more than 200 revisions or 64 MiB of distinct text per note (autosave
clients create a revision per save, so "everything within 90 days" alone would be unbounded); deleted notes' history goes 90 days
after the delete. Pruned on every record and by the existing hourly purge job. *Cost:* up to about twice the note bytes for a
rarely edited note, bounded per note; *privacy:* overwritten and deleted text survives up to 90 days inside the backed-up notes
root (SECURITY.md 12, R-44).

**2. The merge is in-repo, on `difflib`, and conservative.** Evaluated (AGENTS.md 14, checked 2026-11-03 against the package
metadata): `merge3` 1.0.0 (Breezy; `GPL-2.0-or-later`, copyleft: unacceptable for the intended distribution), `diff-match-patch`
20241021 (Apache-2.0, last release 2024-10; character based and its patching is fuzzy by design, the opposite of "never a guess"),
`three-merge` 0.1.1 (MIT, last release 2020-07, a wrapper over diff-match-patch), `git merge-file` (an external binary the API
image does not contain). No dependency is added (`DEPENDENCIES.md`). `merge3(base, theirs, ours)` is clean only when every region
between the lines both sides kept is changed by one side, or identically by both; touching edits conflict. Exact bytes: lines keep
their own terminator, the final newline is merged separately, nothing is re-terminated. Front matter: the result's block must be
byte-identical to one side's (the protocol sketch also allowed "parses as YAML"; that needs a YAML parser the project does not
have, and the stricter rule can only produce more conflict copies, never a wrong merge). Inputs beyond 200 000 lines or 4 000 000
diff cells are not merged. Properties tested with seeded random cases: identities, symmetry, idempotence, exact union of disjoint
edits, "right or refused" under duplicate lines, no line lost or resurrected.

**3. The server saves the conflict copy and answers `409 conflict`.** The sketch had the client create the copy after a `409`. A
server-side copy cannot be lost when the client dies between the `409` and its next request, needs no second request, and makes
the retry story exact: the copy is a stored side effect, so the answer is recorded under the idempotency key (the one `409` that
is) and a retry replays it. The incoming text is the one saved (the note keeps the server's text: "overlapping changes never
overwrite"); `reason` says why (`overlap`, `base_unavailable`, `front_matter`, `too_large`). The web app keeps its own flow
(`POST /api/notes/{id}/conflict`, ADR-0054).

**4. Edit versus delete, rename versus delete.** As ADR-0059 D6: a stale delete is `409 edit_wins`; any newer revision counts as
"edited" (a rename too: simpler, conservative, recoverable). An edit of a deleted note revives it, merged into its last text; an
overlap revives with the last text plus a conflict copy. A **rename of a deleted note is `409 note_deleted`**: a rename carries no
content worth saving, and resurrecting a note because of a rename would undo a deliberate delete for nothing (ADR-0059 is silent;
reversible later). A move on a stale base is allowed and, when another device moved the note meanwhile, logged `path_later_wins`.

**5. Replay returns content from history.** The idempotency record keeps the summary (a body can be 5 MiB, keys live 90 days);
the replay adds `content` from the history entry of the revision the first answer reported, verified against its hash, and omits it
when that revision was pruned. No second copy of the text is stored anywhere.

**6. Portable paths in sync mode only**, so the web app and existing notes are unchanged: `422 invalid_path` for Windows-reserved
names, forbidden characters, trailing dot/space, over-long names/paths; case and Unicode-normalisation collisions count as taken.

**7. Two small hardening changes found on the way** (all modes): a JSON string with a lone surrogate was a `500` (the validation
error echoed it and could not be encoded) and is now a normal `422`; note text containing NUL is a `422` (PostgreSQL cannot index it).

**Consequences.** One migration, one table, one directory; a permanent storage cost and a 90-day memory of deleted text; more
conflict copies than a smarter merge would give (touching edits, two front-matter edits); no new dependency. Rollback: downgrade the
migration (files stay, inert); sync mode is opt-in. **Not decided here:** the merge UX (SYNC-11), the resolution log (SYNC-05),
whether the web app opts into sync mode.

## ADR-0061 — Resolution log, `resolution` feed entity and strict undo (SYNC-05)

**Status:** ACCEPTED as the implementation of ADR-0059 D7 (2026-11-03, local, not committed, CI not run). Nothing below changes an
owner decision except the one narrowing in point 2, which is listed so approval is explicit. Contract: `SYNC_PROTOCOL.md` section 9;
data: `DATA_MODEL.md` 2.9; evidence: `ACCEPTANCE.md` SYNC-05; risk R-41 (closed).

**1. One table, written by the API layer inside the request's transaction.** `sync_resolutions` (migration `f4a8b2c6d1e3`). The
write sites (task/project `PATCH`, note create/`PUT`/move, and the conflict response of a revive) build the same
`sync.resolution` objects as before, then call one function that inserts the rows and announces them on the feed, *after* the entity
was written and *before* the idempotency answer is stored and the request committed. So write, log rows, feed rows and stored answer
commit or roll back together, and a replay (which returns the stored answer first) cannot log again. The services stay unaware of
the log (AGENTS.md 7.4: one place). A unique `(user_id, op_key, ordinal)` index is the tripwire for "a retry logged twice": a
defect that ran a write twice would fail loudly and roll the request back. Rejected alternative: logging inside the services - it
would put the idempotency key into five service signatures for no gain.

**2. A refused stale `DELETE` is not logged (narrowing of D6's "both logged").** The `409 edit_wins` writes nothing and overwrites
nothing; the caller is told in the response, and every other device still has the entity it had. Logging it would need an entry
without its write, a commit during an error response and a dedupe key, and it would make "no log entry without its write" untrue.
The revive (`PATCH`/`PUT` of a deleted entity) is a real write and is logged. Reversible later by one call at the refusal sites.

**3. What is stored.** `loser` is the overwritten value of a simple field, wrapped as `{"value": ...}` so that a stored `null`
(the field was empty) differs from "nothing stored"; at most 4 096 bytes, else the entry has no value and cannot be undone. Text
fields and note content are never stored: `note_merged` points at the history revision it merged into, `path_collision` at
"rename". `detail` holds paths only (2 048 characters). `device_id` exists, is always `NULL`, has no foreign key until SYNC-06, and
`ResolutionLog` already takes it as an argument.

**4. Feed entity without tombstones.** `resolution` is announced as an ordinary upsert row; its state number is 1 or 2 (undone), so a
client applies it by revision. It is visible to sync-mode callers without `types=` and to anyone who names it; a legacy caller (the
web app) is not shown a type it does not know. Retention deletes the log row and its feed row together instead of leaving a
`delete` tombstone: a notice is not state, the tombstone would itself have to be purged, and the cursor floor must stay exact for
real deletions. Client rule: drop a notice older than `sync.tombstone_retention_days` or missing from a fresh snapshot. Retention
reuses `CHANGE_RETENTION_DAYS` (no new setting): the log should live as long as a device may be away.

**5. Undo is the same write path, in a strict form.** `plan_merge(strict=True)` turns *every* concurrent change of the field into a
`changed_since` conflict (the ordinary rule 3 would apply the older value over the newer one and log another resolution - an undo
that "wins" is exactly the silent overwrite the log exists to prevent). Base = the resolution's `kept_revision`, so "unchanged
since" is decided by `field_revisions`. A deleted entity is not revived (`entity_deleted`). A value that is no longer valid is a
conflict, not an error. A note move is undone through `rename_sync` after checking in the note history that the path at
`kept_revision` is still the current path (a pruned revision is a conflict, never a guess). An undo is idempotent by key, final
(its own entry is not undoable) and writes an `undo` entry whose `loser` is the value it replaced; the original is marked undone
and both are announced, in the undo's transaction. If the field already holds the value nothing is written (`applied: false`) but
the entry is still marked undone. Lock order: resolution row, entity row, change cursor.

**6. Found on the way (fixed, all modes of the same endpoint):** a retried refused note `DELETE` (same key) replayed status `0`:
the `409 edit_wins` committed the key without storing the answer (SYNC-04 code). The answer is now stored and replayed
(`test_a_retried_refused_delete_replays_the_refusal`). Also found by the new conformance traces: the model and the real API
disagreed on `kept_revision` of `edit_wins_over_delete` and `path_collision` (response `null`, now the produced revision, both
sides) and on `detail` of `path_later_wins`.

**Consequences.** One table, one feed type, three endpoints, no setting, no dependency. Every sync-mode write that makes a decision
now writes one to three extra rows (and takes one to three extra feed cursors). Overwritten simple values are kept up to 90 days
in the database and its backups (SECURITY.md T18). Rollback: downgrade `f4a8b2c6d1e3` drops the table and the feed rows of the
type (the log is lost, nothing else); sync mode is opt-in. **Not decided here:** the notice and undo UI (SYNC-11), which device made
a write (SYNC-06), whether text-field conflicts need a persisted resolve action (they are returned in the response and the note
conflict copy is the artefact).

## ADR-0062 — Readability tokens, one row anatomy and section cards (UX-09)

**Status:** Accepted (owner feedback 2026-11-03 asked for clearer separation and allows colour where it helps; refines
ADR-0051 §1 "colour only for meaning"; every choice is UI-only and reversible). **Source:**
[`UX_AUDIT.md`](UX_AUDIT.md) "Readability and mobile audit (2026-11)" §B-§D. (Numbered 0062: 0061 is SYNC-05.)

**Context.** On a phone a task row was one undifferentiated block (title 14 px, 12 px meta wrapping to 2-3 lines, 52-80 px),
overdue and High shared one colour, sections were flat grey labels, and the only open target was the title text.

**Decisions.**
1. **Tokens** (`styles.css`, light and dark, both dark copies identical, all in `styles.test.ts`): `--bg-page`, `--bg-card`,
   `--bg-section`, `--row-sep`, `--due-overdue(-soft)`, `--due-today(-soft)`, `--priority-urgent/-high` (hex) and
   `--priority-medium/-low` (aliases of `--text-2/-3`: only urgent and high carry colour), `--project-1..8`. Values are the audit's;
   text pairs are tested at 4.5:1 on every surface they appear on (7:1 for body text), dots at 3:1, the card outline against the page
   at >= 1.25 (the fill difference alone is < 1.2, so a card always has its `--border-strong` outline).
2. **Project colour is derived, not stored:** `projectHue(id) = FNV-1a-32(id) % 8 + 1` (`lib/projectColor.ts`). Stable across
   devices, no schema/API/sync change. The dot is `aria-hidden` and the name always accompanies it; a user-chosen colour would add
   a project field and a sync surface and is a separate decision.
3. **Due chip** (`lib/dueChip.ts`): the state still comes from the server's `due_state` (never re-derived). Overdue = alert icon +
   word "Overdue" + `--due-overdue` on its soft fill; due today = sun icon + "Today"; later = calendar icon, muted. Completed
   tasks are never overdue. Inside a day group (`day` prop: Upcoming and Week group keys, Today's own day) a due on that day shows
   the time only, a date-only due says nothing (or just "Today"); everywhere else (Inbox, Tasks, project tab, an overdue row of
   another day) the date stays. The old sr-only "Overdue, due" text is replaced by visible text.
4. **Row anatomy** (`TaskMeta`, `TaskRow`): meta is two groups, *when* (due chip, priority, subtask count) and *what* (parent or
   project dot + name, at most two tags and "+n"). Phone (<= 720 px): title 16/22, line 2, line 3, and the title keeps one line
   when both meta lines exist, so a row is never more than three text lines (`data-meta-lines` drives the clamp). Line 2 is 14 px,
   line 3 is 12 px: the CSS scale has no 13 px, and the scale was not widened. Medium and low priority show the flag only on a
   phone (the word is visually hidden, still in the DOM). Desktop: one 36 px line; *what* first, then fixed columns for due
   (188 px), priority (72 px) and subtasks (44 px) so dates line up. Board cards keep the flat compact meta.
5. **Targets.** Under `(pointer: coarse), (max-width: 720px)` the completion checkbox is a 44x44 input drawing a 22 px circle
   (ring = urgent/high colour), the "..." is 44x44, rows are >= 56 px. The whole `.task-body` opens the task through an `onClick` on
   the body `div`; the title `button` (name `Open <title>`) stays the keyboard and screen-reader path and its click bubbles, so a
   task opens exactly once. The Tasks page's square select box is unchanged (22 px; its redesign is UX-11).
6. **Sections.** `ViewSection` renders `section > h2.section-head` (the h2 is the sticky band and the section's first child, so
   "heading then its parent" queries keep working); the count is `aria-hidden`, so the heading name is the title ("Overdue").
   Overdue and Due today add an icon and a coloured bar (words say it too). Phone: sections and `.list-card` are cards
   (`--bg-card`, outline, `--r-lg`) on `--bg-page` (applied with `.main-column:has(.tinted-page)` to Today, Inbox, Upcoming, Week,
   Tasks only), hairlines inset 56 px, headers sticky at `top: 48px` (below the mobile header); desktop: flat, header band only, sticky
   at 0. Upcoming's headers are relative ("Tomorrow · Wed, Nov 4"). Today gets a "N overdue · N due today" line.
7. **Today's daily note** is previewed as plain text with Markdown markers dropped (`plainPreview`), **not** through
   `MarkdownPreview` as the plan said: j6 and the Today test require note text (`<b>..</b>`) to stay inert text, and `MarkdownPreview`
   would render allowed inline HTML. Events stays one muted sentence in a muted card.
8. **Icons:** none added. `triangle-alert` (already vendored) stands in for the planned `alert-circle`; `sun` and `calendar-days`
   exist. `DEPENDENCIES.md` unchanged.
9. **Week** keeps its UX-08 layout (seven columns, UX-10 replaces it): its rows use the stacked meta in narrow columns on desktop and
   the phone anatomy on a phone; its day sections are cards with sticky headers on a phone. Not changed: Board, Notes, Projects,
   palette, menus, inputs (UX-10/11).

**Consequences.** CSS and markup only; no backend, schema, dependency or API change. Selectors kept: `.task-row`,
`.task-priority` (text is still exactly the word on desktop), `.task-due` (+ `is-overdue`), `.project-tag` (text is the project name),
all accessible names, regions "Daily note" / "Events". Changed: `.task-meta` now contains `.task-meta-when` / `.task-meta-context`;
the project dot is an element (`.project-dot`) not `::before`; the Overdue chip text is "Overdue · date". Limitations: line 2 is
clipped at its end on a 360 px phone when a long due, "Urgent" and a subtask count all appear; Week still hides Sunday on desktop
until UX-10; the project hues were checked for contrast, not simulated for colour-vision deficiency (never the only cue);
sticky-header behaviour under a real touch scroll and screen-reader order are unverified (R-49).


## ADR-0063 — Week agenda, phone capture sheet, bottom-sheet menus and touch rules (UX-10)

**Status:** Accepted (owner feedback 2026-11-03; follows ADR-0062; UI-only and reversible). **Source:**
[`UX_AUDIT.md`](UX_AUDIT.md) "Readability and mobile audit (2026-11)" findings 1, 4, 7 and §D.4. (Numbered 0063: 0061 is SYNC-05, 0062 is UX-09.)

**Context.** Week's seven fixed columns hid Saturday and Sunday and clipped text at 768 and 1440 px; a phone had no capture control
that stays in reach; the row menu was a small popover over the row text; text fields were 14 px (iOS zooms on focus); the bottom
nav ignored the home indicator.

**Decisions.**
1. **Week is an agenda of day cards**, not columns: `.week-days` is `grid-template-columns: repeat(auto-fit, minmax(min(100%, 260px), 1fr))`
   inside `.week-agenda`, which is the CSS size container (`container: week / inline-size`); only when that container is >= 1,600 px
   does it become seven columns. The container is a wrapper, not the page: `container-type` implies layout containment, which would
   make the page the containing block of the fixed capture button. One column at 360/390, two at 768, two to four at 1440. A day is a
   `ViewSection` (so it inherits the sticky band, count and today tone) with `week-day`; today's card says "Today · <day>", has the
   due-today colour, icon and outline; an empty day is one muted line (date left, "Nothing scheduled." right) in a slim card. Rows in
   narrow desktop cards keep the stacked meta of ADR-0062. No sideways scroll anywhere on the page, and no inner scroll container.
2. **Week navigation** is the existing `.segmented` control (also used for List | Board) with the same names "Previous week",
   "This week", "Next week". "This week" is the current state while disabled (selected fill, full-contrast text). On a phone it is a
   three-segment grid across the width and the arrows are icon-only (their names stay, as visually hidden text). Segments are 44 px
   under `(pointer: coarse), (hover: none), (max-width: 720px)`.
3. **Projects summary** (`ProjectSummary`) is smaller wrapping chips on a wide window and one "Projects · n" toggle row on a phone
   that expands on tap. The plan said "one scrollable line"; that contradicts the no-inner-scroll acceptance, so it is a toggle.
4. **Phone capture** (`components/CaptureSheet.tsx`, `CaptureFab`): at <= 720 px a 56 px round button "Capture a task" sits above the
   bottom nav, the status bar and the home indicator (`--bottom-clear`), on Today, Inbox, Upcoming, Week, Tasks and the project
   page (Tasks and Board tabs). It opens a modal bottom sheet (`role="dialog"`, `aria-modal`) around the **same** `QuickCapture`
   (label "Task title", validation, API call): every page passes its own `onCapture`, so nothing is duplicated. Capture from
   Upcoming, Week and Tasks creates an Inbox task (said in the confirmation: "Added "x" to Inbox."); Today's creates a task due
   today; a project's creates a `next` task in that project. Opening focuses the field and makes the page section `inert`; Esc,
   the scrim and Close close it and focus returns to the button; Tab is trapped. It stays open after an add (field cleared and
   focused, `role="status"` says where it went) so several tasks can be captured in a row. A second submit while one is in flight
   is ignored (`QuickCapture` guard), a failed add keeps the title for a retry. The inline field stays on desktop and tablet, on
   phone Inbox and phone project pages; phone Today drops it (the sheet replaces it). No `c` keyboard shortcut was added: desktop
   keeps its inline field and a new global shortcut is outside the plan. Hidden while rows are selected on Tasks (the bulk bar needs the space).
5. **Keyboard.** `index.html` sets `viewport-fit=cover, interactive-widget=resizes-content`. Chromium on Android then resizes the layout
   viewport; iOS Safari does not, so `useKeyboardInset` (`lib/keyboardInset.ts`, pure) lifts the sheet by
   `innerHeight - visualViewport.height - offsetTop` through `--kb`. The two cannot double count (with resizes-content the
   inset is 0). Verified only with an emulated `visualViewport` (R-50).
6. **Menus as sheets.** `Menu` and `Popover` use `useMediaQuery("(max-width: 720px), (hover: none)")`: a bottom sheet with a scrim (a
   `popover=manual` element promoted first, so the menu stacks above it), 48 px items, 16 px text, safe-area spacer, slide-up
   animation, a trailing "Cancel" menu item at the top level, and Tab cycling inside instead of closing (ADR-0052 §4 had Tab close
   a popover; a modal sheet keeps focus). Roles (`menu`, `menuitem`, `menuitemradio`, `dialog`), names, arrow keys, type-ahead, Esc
   and focus return are unchanged; a press on the scrim closes and returns focus to the opener (deferred past the press, which
   would otherwise blur it). The page behind is **not** made inert (menus portal into the opener's landmark, which may be a dialog):
   pointer and keyboard are blocked, a screen-reader swipe could still reach it (R-50). jsdom has no `matchMedia`, so unit tests keep the popover.
7. **Touch rules.** Text inputs, selects and textareas are 16 px under `(pointer: coarse), (hover: none), (max-width: 720px)`. Under
   the same query filter chips, the filter menu button, "Select all" and the segments are 44 px; the rail's links and buttons are
   44 px on touch devices. The bottom nav keeps 56 px of targets and adds `env(safe-area-inset-bottom)` below them; the mobile header
   adds the top inset; the main column the side insets. `padding` is limited to scale tokens by the lint, so insets are applied with
   `height`, `border-top` and `::after` spacers, not padding.
8. **No new colour token, no gestures, no backend.** The button uses `--accent`/`--accent-contrast`, the scrim `--scrim`. Icon: one Lucide
   shape added, `plus` (`DEPENDENCIES.md`).
9. **Not done (decided):** the Inbox "Today" button per row (plan item 5, "owner may decline"): the 44 px "..." sheet already gives
   Today in two taps; revisit with the owner. Tasks select boxes (22 px) and the 16 px "Select all" box remain for UX-11.

**Consequences.** CSS and markup only; `Week` changes class names: `.week-days` stays (now an auto-fit grid, wrapped in `.week-agenda`),
`.week-day` is now a `ViewSection` (`section.view-section.week-day[.is-today][.is-empty]` > `h2.section-head`), `.week-day-count`
is gone (the count is `aria-hidden` `.section-count`), the three navigation buttons keep their names. Selectors kept: `Task title`,
"Previous week" / "This week" / "Next week", row selectors of ADR-0062. Changed behaviour: on a phone the menus are sheets (Tab
no longer closes them), phone Today has no inline capture field, Today's empty text no longer says "above".
Limitations are recorded in R-50 (real keyboard, notch, screen readers, `:has()` and container queries in older browsers).


## ADR-0064 — Remaining phone pages, and the standalone Board is removed (UX-11)

**Status:** Accepted (owner feedback 2026-11-03 and an owner scope change during the task: remove the Kanban board as a standalone
feature, keep it inside projects; UI-only and reversible; supersedes the standalone-Board parts of ADR-0057 §1, §4 and §5 and the
`/board` route of ADR-0022). **Source:** [`UX_AUDIT.md`](UX_AUDIT.md) "Readability and mobile audit (2026-11)" §C.1 findings 8-10.

**Context.** After UX-09/UX-10 the phone pages Tasks, Board, Notes, Projects and the palette were still desktop layouts: two
checkboxes per Tasks row and five wrapping dashed chips, five side-scrolling Board columns (2,400 px tall), a crowded Notes toolbar whose
breadcrumb read "/…", three loose lines per project, ~28 px palette rows, a 20 px status-bar link, Medium/Low shown as a bare flag.

**Decisions.**
1. **The standalone Board is removed; the project Board stays.** `/board` redirects to `/projects` (old links and bookmarks do not
   404); "Board" leaves `NAV_SECTIONS` (sidebar, rail, bottom nav) and so the palette's "Go to Board"; the Tasks page loses its
   `List | Board` switch and board view, and the `view` URL parameter (UX-07) is **ignored** (an old link or saved view with `view=board`
   shows the list and the parameter is dropped at the next change; `TaskFilter.view`/`TaskViewMode` are deleted). The page
   `pages/Board.tsx`, its test, the Skeleton `board` kind and the Tasks board branch are deleted as dead code. `components/Board.tsx`,
   `useBoard` and the state machine stay: the project page's Board tab (Tasks | Board | Notes) is now the only board, with drag,
   the card menu "Move to…", `]`/`[`, the move announcement and the Archived toggle unchanged. **Known consequence:** a task with no
   project appears on no board (it is on Inbox, Today, Upcoming, Week and Tasks). REQ-006 ("Kanban boards") stays delivered inside
   projects (`ACCEPTANCE.md`).
2. **Tasks (touch and phone: `SHEET_QUERY`).** The square select box exists only in a **Select mode** entered from the filter "…" menu
   ("Select tasks"); in that mode it replaces the round completion box (one leading control per row; a 44x44 target drawing a 22 px
   square), "Select all" is a 44 px row with the count and a "Done" button, leaving the mode clears the selection. Desktop is unchanged
   (boxes on hover/focus). The five filter chips become **one "Filters" button** (44 px, solid border, tinted with a count when any filter
   differs from the default) that opens the same choices as a sheet (Status, Priority, Project, Sort as submenus; "Due date…" opens the
   existing Due dialog; "Reset filters" at the end). **Why not one scrollable chip line:** the UX-10/UX-11 acceptance is "no inner
   horizontal scroll", five chips with chevrons are ~430 px wide, and hiding the rest of a scroll strip is poor discoverability; the
   sheet needs no new component (`Menu`, `Popover`, `choiceEntries`) and wraps or scrolls nothing. No exception is needed.
3. **Project Board on a phone (<= 720 px).** One full-width column at a time, chosen from a WAI-ARIA tab strip (`Tabs`, with a count per
   tab, ← → Home End) of equal-width grid cells with the count above the label (never wraps, never scrolls; "In progress" fits at 360 px
   with five tabs). Only the active column is rendered (`role="tabpanel"`, its heading is screen-reader text). `]`/`[` move the focused
   card, the tab **follows** the card so focus and the "Moved X to Y" announcement keep working; a move chosen in the card menu stays
   on the column (triage in a row) and is announced once the server confirms it. The Archived toggle adds/removes a fifth tab. On touch the
   help paragraph is behind a "?" button ("About the board") and no longer mentions keys; desktop prints the paragraph as before.
   A board card's title is its own 44 px target on touch (list rows open from the whole body, ADR-0062).
4. **Notes (phone).** Toolbar rows: the "show notes list" button, the note's **name** (file name without `.md`) with its folder under it
   (the old breadcrumb squeezed folder segments to "/…"), the save state, "…"; and one full-width **Source | Live | Preview** segmented
   control, exclusive on a phone (Preview replaces the editor there, as before). "Links and details" moves into the "…" menu (first item;
   the Ctrl+Alt+B shortcut is unchanged). The tree/note drill-in is unchanged. Choosing Source/Live on a phone also turns the preview
   preference off (the preference is shared with desktop). A checkbox or link inside the note's own text (editor, preview) is content,
   like an inline link, and is not held to 44 px (R-51). Tree rows, tree buttons and their "…" are 44 px on phone/touch.
5. **Projects (phone)**: a card per project (`--bg-card`, outline, on the tinted page): the project dot (colour from `projectHue`,
   ADR-0062), the name, a 44 px "…", the progress bar, then one line "done · % · open" with the target date at the right; the whole card
   opens the project (stretched name link, "…" stays separate). Desktop keeps one row.
6. **Palette (touch and phone)**: a full-height sheet (`100dvh`, lifted by `--kb`), a visible **Close** button (no Esc on a phone),
   44 px rows, no key hints (the footer and the "Ctrl B"/"?" hints are not rendered).
7. **Settings, Login, Setup** only get the shared touch rules: every label around a checkbox or radio is a 44 px target on
   phone/touch (`label:has(> input)`); no other change was needed (measured).
8. **Leftovers from UX-10.** Medium and Low priority show their word on a phone (the least noisy of the options: the word is no wider
   than "Urgent", which already fits, and only one priority appears per row; a tooltip does not exist on touch and an abbreviation would
   be a second vocabulary). The status bar link is 44 px high on a phone when the bar shows itself (offline, queued, conflicts;
   `--statusbar: 44px` below 720 px; it is still visually hidden when everything is synced). The phone Inbox and the phone project Tasks
   tab show the capture button only (no inline field), as Today.
9. **No new token, icon, package, gesture or backend change.** `prefers-reduced-motion` is unaffected (no animation was added). The
   "?" button is a text glyph, not an icon.

**Consequences.** Selectors changed: `/board` (route, nav link, palette entry "Go to Board") and the Tasks `List | Board` group "View"
are gone; the Board's heading/region per column exists on desktop only (on a phone the column is a `tabpanel`, columns are tabs named
"Inbox, 3 tasks"); the phone Tasks page has no `Select <title>` / "Select all" until "Select tasks" is chosen from "Filter options",
and "Filters" replaces the chips (`Status`, `Priority`, `Project`, `Due`, `Sort` buttons, desktop unchanged). Kept: every other
ADR-0062/0063 selector. Limitations are in R-51.

## ADR-0065 — Device credentials: per-device bearer tokens, a default-deny scope and one revoke function (SYNC-06)

**Status:** ACCEPTED as the implementation of ADR-0059 D8 (2026-11-03, local, not committed, CI not run). Where this ADR narrows or
decides something D8 left open, it says so; the one owner-visible decision is point 5 (what a password *change* does to devices).
Contract: `SYNC_PROTOCOL.md` section 10.1; data: `DATA_MODEL.md` `Device`; threats: `SECURITY.md` T13/T17/T22-T24; evidence:
`ACCEPTANCE.md` SYNC-06; risks R-52, R-53.

**1. A device signs itself in with the account password; there is no pairing flow.** `POST /api/devices` takes e-mail, password, a name
and a platform and answers the bearer token **once**. A pairing code shown in a signed-in browser is what a phone without a keyboard
would want; the Tauri client has a keyboard, the owner's order is Sync then Auth, and a second credential-exchange flow doubles the
attack surface. It can be added later without a schema change. The endpoint shares the **login** rate-limit pool (one budget of
password guesses, not two), answers an unknown account, a wrong password and an inactive account with the same `401`, equalises
timing with the dummy hash, and its validation errors never echo the body (the `422` redaction covers `/api/devices`).

**2. Token and table.** 256 random bits (`secrets.token_urlsafe(32)`) behind the prefix `atd_` (a secret scanner can find a leaked
one; a session value is never mistaken for it). Only the SHA-256 is stored (`devices.token_hash`, unique): the token has 256 bits of
entropy, so a fast hash is enough (a password hash would add latency to every request for nothing); the comparison after the indexed
lookup is `hmac.compare_digest`. Anything that is not exactly `atd_` + 43 URL-safe characters is refused without a lookup. The token
appears in no log, URL, error body or OpenAPI example. Columns: `id`, `user_id`, `name`, `platform`, `created_at`, `last_seen_at`,
`revoked_at`, `token_hash`, `prev_token_hash`, `prev_valid_until`. No IP address, user agent or app version is stored (privacy; the
protocol's `app_version`/`protocol` columns of the sketch were dropped as unused). A revoked row is kept (so its token is answered
`token_revoked`, not "unknown", and resolutions still name it) until the hourly purge deletes devices revoked before the
`CHANGE_RETENTION_DAYS` window; a resolution then keeps its text and loses only the device (`ON DELETE SET NULL`).

**3. Two authentication paths that cannot be mixed.** `Authorization: Bearer <token>` is looked at **first**. If a bearer header is
present the request is authenticated by it alone: a bad, revoked or unknown token is a `401` even when the browser also sent a valid
session cookie, and the cookie is never consulted. Only the `Bearer` scheme counts (another scheme, such as a reverse proxy's Basic
auth, is ignored and the cookie path is unchanged). The CSRF middleware skips the check **only** for requests that present a bearer
header, because those requests ignore cookies, so there is no ambient credential for a cross-site request to ride; every other unsafe
request is checked as before. `POST /api/devices` is exempt from CSRF like login (it needs no session, it needs the password).

**4. Default deny.** `CurrentUser` (the dependency every existing endpoint already used) now means "browser session": a device token
on such an endpoint is `403 forbidden_scope`. A new dependency `SyncUser` (session **or** device) is applied to exactly: tasks,
projects, notes and folders, the change feed (`/api/changes`, `/api/tasks/changes`), search, `/api/sync/resolutions`,
`GET /api/instance`, `GET /api/auth/me`, and the device endpoints a device needs for itself (`GET /api/devices`,
`GET /api/devices/current`, `POST /api/devices/current/rotate`, `DELETE /api/devices/current`). Everything else is closed to devices:
change password, edit profile, rename or revoke devices, revoke all, export, calendar credentials and sync, the push-notification
registry. A new endpoint is therefore closed to devices until someone opens it on purpose, and `test_the_set_of_endpoints_open_to_devices_is_exactly_this`
walks every router and fails when the set changes. A device may read the device list (read-only; it marks itself `current`) and
sign **itself** out; it cannot touch another device. `GET /api/instance` is open because a client needs the `sync` block to negotiate
(it holds no secret, path or key). The notification registry is closed for now (SYNC-10 will decide how an Android client registers
push); the export is closed because "everything the account has" is an account-level act, not sync.

**5. Password change and devices (the open question of D8): a change keeps devices unless asked; a reset always revokes them.**
D8 (accepted) says a password *change* revokes browser sessions only and the recovery reset revokes all. Kept, with one addition:
`POST /api/auth/password` takes `revoke_devices` (default `false`) and Settings shows "Also sign out my devices". Trade-off: with the
default a person who changes their password because it leaked leaves a stolen *device token* working (an attacker who also knew the
password could simply sign a new device in, so ticking the box matters exactly then); with the opposite default every routine
change would silently break the desktop and phone apps and send the user to four sign-in screens, which trains people to avoid
changing passwords. The explicit box states the consequence at the moment of choice and the Settings text says it twice. The reset
paths (`atlas-admin reset-password` now, AUTH-01's recovery flow later) call the same `revoke_all_devices(session, user_id)` as the
Settings button and the checkbox; the function is the only place that sets `revoked_at` in bulk.

**6. Rotation: a previous-token grace window, no refresh tokens.** `POST /api/devices/current/rotate` (bearer) issues a new token and
moves the current hash to `prev_token_hash`, valid for 24 hours (`prev_valid_until`). The first request made with the **new** token
deletes the previous hash (the client has proved it holds the new one), so the window is as short as the client allows and only
stays open while a response was lost. A client that lost the rotation response retries with the old token (accepted for rotation too)
and gets a fresh token; the token issued in between falls out of the chain. Rejected: a refresh-token pair (two secrets, two stores
in the keystore, a refresh endpoint with its own rate limit) for the same property. **Limit (R-52):** rotation shortens the life of a
leaked *old* token; it does not detect theft of the current one (no reuse detection), which is what revocation and the visible
`last_seen_at` are for. Clients rotate when they choose (SYNC-09 will rotate on a schedule); the server never forces it.

**7. Idle expiry = the change-retention window, no new setting.** A device unseen for `CHANGE_RETENTION_DAYS` (default 90, minimum
30) gets `401 token_expired`; past that window it could not resume incrementally anyway (`resync_required`). `last_seen_at` (or
`created_at` before the first request) is the reference. A device that was never revoked is not purged: it stays in Settings so the
owner decides. Up to 25 unrevoked devices per account (a constant; `409` at sign-in beyond it, revoking one makes room).

**8. Clock independence (D11).** Every expiry, grace window and `last_seen_at` is decided by the server (`now()` in the database or
the API host's UTC clock). No request field, header or device timestamp is read; a forged `Date` header changes nothing (tested).

**9. `last_seen_at` is cheap.** Written at most once per five minutes per device: an in-process memo avoids even the query, and the
`UPDATE ... WHERE last_seen_at IS NULL OR last_seen_at < now() - 5 min` makes a second API process harmless. It runs in its **own
short transaction** (a request that fails or rolls back still records the sighting, and a revoked device never gets one), is best
effort (a failure is a warning with the device id, never an error), and is the only write on the read path. The same call deletes a
spent previous token (point 6).

**10. Per-device rate limits, after authentication.** 600 requests and 120 writes per minute per device id (in-process sliding window
like the login limiter; `429` `rate_limited` with `Retry-After`), keyed by device, not address, so devices behind one proxy address
do not share a budget (R-SEC-1). **Not built:** the per-device feed-page limit (60/min) and snapshot-start limit (10/hour) of
`SYNC_PROTOCOL.md` 8.3; the 600/min request budget bounds the feed for now (R-53), and SYNC-08 will show what a real client needs
before tighter numbers are chosen.

**11. `device_id` in the resolution log.** The authentication dependency stores the device id on the request's database session
(`session.info["device_id"]`); `ResolutionLog` reads it, so every write site, the conflict response of a revive and the undo endpoint
record it without a signature change (explicit argument still wins). `sync_resolutions.device_id` gets its foreign key
(`ON DELETE SET NULL`); a browser session writes `NULL`. A client compares the id of an entry with its own device id (from
`GET /api/devices/current`) to show "changed on another device" only for others (SYNC-11).

**12. Errors.** Sync-shaped bodies `{error, detail}` with `WWW-Authenticate: Bearer` on `401`: `unauthenticated` (unknown or
malformed token, inactive account), `token_revoked`, `token_expired`; `403 forbidden_scope`; `429 rate_limited`. A client stops and
asks the user to sign in on any `401` (never retries blindly) and keeps its local data; the simulation's client does this and the
`stop_on_revoked` invariant checks that it sends nothing afterwards.

**Consequences.** One table, one migration (`b7c4d9e2a1f5`, reversible), one module (`atlas/auth/devices.py`), one router, no
dependency, no setting, no change for the browser except a checkbox and a Settings section. `CurrentUser` keeps its name and its
meaning for the browser, so no existing endpoint's behaviour changed. Rollback: downgrade drops the table (devices must sign in
again) and clears `sync_resolutions.device_id`. **Not decided here:** HTTPS-only enforcement for native clients (client side,
SYNC-09; the server is behind the operator's TLS), the keystore mechanism per platform (SYNC-07), a pairing flow, per-endpoint
token scopes finer than "sync", reuse detection on rotation (R-52).

## ADR-0066 — `packages/sync-core`: a tick-driven client core over injected ports (SYNC-08)

**Status:** ACCEPTED as the implementation of ADR-0055/0059/0060/0061/0065 on the client (2026-11-04, local, not committed, CI not
run). Contract: `SYNC_PROTOCOL.md`; evidence: `ACCEPTANCE.md` SYNC-08; risks R-40 (now implemented), R-54, R-55.

1. **One package, no dependencies, ports for everything.** `packages/sync-core` imports nothing from React, the DOM or a runtime. The
   host supplies `Transport`, `LocalStore`, `Clock`, `Random`, `IdGenerator`, `Logger`. The monotonic clock times backoff and request
   deadlines; the wall clock is display only, so no decision depends on a device clock (D11). Tests run in plain node.
2. **Tick-driven.** `tick()` starts at most one request and returns; the host decides when to call it (timer, focus, network
   change). One request in flight per client, strict FIFO, hence one per entity (concurrency across entities is a later optimisation,
   not needed by any measured case). The same engine runs on virtual time in the simulation and on real timers in a host.
3. **Durable vs volatile** as in the Python model clients: queue (idempotency key from enqueue, base frozen at the first send), mirror,
   drafts, notices, cursor, epoch and halt are in the `LocalStore`; the request in flight, a half-done pull and timers are not. A
   page and its cursor commit in **one** transaction; a halt is stored before it is believed.
4. **Acknowledgements are historical** (R-40): they fill a gap, never overwrite newer or tombstoned state, and the entity is read
   again at the next pull; a delete acknowledgement is re-read too; a tombstone is remembered for an id never held.
5. **Chained bases.** An operation queued behind an unacknowledged one of the same entity takes its base from the predecessor's
   answer when that answer is exactly `base + 1` (nobody else wrote in between); otherwise it keeps the revision the user saw (the
   server may then report a conflict with the user's own earlier edit: noise, never loss).
6. **Notes keep a pinned working copy** (`NoteDraft`): text, the revision/hash it derives from, and the text of the save in flight.
   Text typed while a save is in flight is rebased with the client's `merge3` onto the answer; if that is not clean, the text is kept as a
   `Problem` (`mineLatestText`) and the server's text is shown. A rejected save keeps its text and the server's conflict copy pointer.
7. **Restore is never automatic** (D12): `epoch_mismatch` and `cursor_ahead` stop the engine in `restore_confirmation`; after
   `confirmRestore()` it walks a snapshot, adopts the server's state also where its revisions are lower, and re-creates what the
   server lost with the same ids (7.4). `below_floor` is a non-destructive shadow resync (7.3). 426 and 401 are halts, stored.
8. **The web app stays on the M7 code** (R-54). Its engine speaks the legacy (non-sync-mode) protocol with an operation-keeps-
   `conflict`-status contract used by `useConflictResolution`/`SyncStatusPanel`; no production code enqueues into it (ROADMAP). Moving
   it to sync mode changes user-visible conflict behaviour (field merge instead of a 409 per revision), which is a product decision
   (SYNC-11), not a refactor. `adapters/` give it the pieces it needs (`KeyValueLocalStore`, `legacyQueueSnapshot`).
9. **Test infrastructure choices.** Tests run through `apps/web`'s vitest (projects `web`, `sync-core`, `sync-core-real`), lint and
   tsc, so `./scripts/verify.sh` picks them up unchanged. The real-API conformance is opt-in (it needs the virtualenv, PostgreSQL and a
   container), with a wrapper `sim/real/serve.py` that only lifts the per-device rate limits for the run. Planted client defects live
   in the engine behind `options.plantedBugs` (default off), as in the Python model clients.

## ADR-0067 — Account recovery by a one-time recovery code (AUTH-01)

**Status:** ACCEPTED. The owner approved the design on 2026-11-04 (a one-time code shown once at setup and regenerable in Settings,
stored only as a hash; "Forgot password?" on the sign-in page; a reset revokes every session and every device in the transaction of
the password change; rate limited; the code is never logged or echoed). Implemented locally the same day, not committed, CI not run.
Evidence `ACCEPTANCE.md` AUTH-01; threats `SECURITY.md` T25-T30; risks R-56, R-57.

**Context.** A self-hosted Atlas has no e-mail service, so "send me a reset link" is not available. Until now the only recovery was
`atlas-admin reset-password` on the server (ADR-0050 follow-up, 2026-11-03), which needs shell access. ADR-0059 D8 and ADR-0065 said
AUTH-01 would consume the one bulk-revoke function `atlas.auth.devices.revoke_all_devices`.

**Decision.**

1. **Format and entropy.** 30 characters of Crockford base32 (alphabet `0-9 A-Z` without `I L O U`), **150 random bits** from
   `secrets.choice`, displayed as six groups of five (`XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX`). Entry is tolerant: case, dashes,
   underscores, spaces and non-breaking spaces are ignored and `O`, `I`, `L` are read as `0`, `1`, `1`; anything else (wrong length,
   `U`, non-ASCII, over 128 raw characters) is simply "not a code". Normalisation happens before hashing, so every spelling of a code
   hashes the same.
2. **Hash storage: salted HMAC-SHA-256, not Argon2.** The code is 150 random bits, so there is nothing for a slow hash to protect: a
   database leak cannot be brute-forced (2^150 candidates), exactly as for the 256-bit session and device tokens (SHA-256, ADR-0065).
   Argon2 would only add ~50 ms of CPU per request to an *unauthenticated* endpoint, which is a denial-of-service lever and would make
   equal timing for unknown accounts more expensive. Each code gets its own 16-byte random salt used as the HMAC key, so equal codes
   never look equal. **No server-wide pepper:** a pepper derived from `SECRET_KEY` would silently invalidate every code when the key
   is rotated; with 150 bits it buys nothing. Comparison is `hmac.compare_digest`. No new dependency (`secrets`, `hmac`, `hashlib`).
3. **Table `recovery_codes`** (migration `c9e4a7b2d6f1`, reversible, tested on a clean database and on a representative existing
   installation): `user_id` (primary key, `ON DELETE CASCADE`, so at most one code per user), `code_salt`, `code_hash`, `created_at`,
   `last_used_at`, `failed_attempts` (check `>= 0`). **Existing accounts have no row**: no code until the owner opens Settings → Account
   → Recovery code → "Create recovery code" and confirms the current password. The upgrade changes no existing row; downgrade drops the
   table (codes cease to exist; the CLI fallback remains).
4. **Reset endpoint** `POST /api/auth/recovery/reset {email, recovery_code, new_password}` -> `200 {recovery_code, created_at}`.
   In **one transaction, under a row lock on the code**: set the new password hash, revoke every browser session, call
   `revoke_all_devices` (the shared function of ADR-0065), replace the code (new salt and hash, `created_at`, `last_used_at = now`,
   `failed_attempts = 0`) and commit. If any step fails, nothing changes and the code is not consumed (tested by making the device
   revocation raise). The row lock makes two simultaneous requests with one code succeed exactly once (tested with `asyncio.gather`);
   a replay of a used code is a refusal. The new code is in the response (shown once); **the browser is not signed in** (no cookie is
   set or read): the owner signs in with the new password. `atlas-admin reset-password` uses the same `apply_password_reset` function.
5. **Enumeration resistance.** Unknown e-mail, an account with no code, an inactive account, a wrong code and a malformed code all
   return the same `400 {"detail": "The email or recovery code is not correct"}` with the same headers. They also run the **same
   statements in the same order** (select the user, `SELECT ... FOR UPDATE` on the code row of the user's id or of a random id,
   compare in constant time against the stored hash or a dummy, `UPDATE ... SET failed_attempts + 1` on that id, commit), so the work,
   not only the answer, is equal; a test records the SQL of each case and requires it to be identical. A refusal does no Argon2
   work. The password hash is computed only on success. Validation of the new password (`422`) does not depend on the account.
6. **Rate limiting, a bounded delay and never a lock.** Two in-process sliding windows (as the login limiter, so a restart resets
   them and a multi-process deployment would need a shared store, as already noted in `SECURITY.md`): per address, the **shared
   login pool** (`AUTH_RATE_LIMIT_PER_MINUTE`, default 10 a minute; reset attempts and sign-in attempts share it); per account,
   **5 attempts per 15 minutes**, keyed by a SHA-256 of the lower-cased e-mail, so an unknown address is throttled exactly like a
   real one and the limiter holds no address. A throttled call is `429` with `Retry-After`, answered **before any code is looked at**
   (even the right code waits: the limit is not an oracle). Attempts refused by the limiter are not recorded in the window, so an
   attacker hammering during the window cannot extend it: the owner's delay ends at most 15 minutes after the last *counted* attempt
   (tested with a controlled clock). The limiter drops idle buckets above 4096 keys so attacker-chosen addresses cannot grow it
   without bound. Residual: a determined attacker can keep the owner's *recovery* throttled (not sign-in, not the CLI) by spending 5
   attempts every 15 minutes; with 150-bit codes the cap exists for noise and CPU, not for guessing resistance, and the CLI fallback
   (point 11) is the answer (R-57). `failed_attempts` is a **diagnostic counter shown to the owner** in Settings ("3 wrong tries
   since"); it never changes an answer.
7. **Audit trail without secrets.** Structured log events on logger `atlas.auth.audit`: `recovery_code_issued`,
   `recovery_code_regenerated`, `recovery_code_issued_by_operator`, `recovery_reset_succeeded` (user id, address hash, counts of sessions
   and devices revoked), `recovery_reset_refused` (user id only when the account has a code, address hash), `recovery_reset_throttled`
   (scope `address` or `account`). Never the code, a password, a hash, or the submitted e-mail (a mistyped password lands in an
   e-mail field often enough). A test captures every log record of a full flow and searches for the codes, both passwords and the
   e-mail. The persistent trace for the owner is `last_used_at`, `created_at` and `failed_attempts` in Settings.
8. **What a used code does.** It is spent and **replaced in the same response**: the new code is shown once, the old one is dead. The
   screen requires the explicit "I have saved my recovery code" tick before it will leave ("Back to sign in").
9. **Regeneration in Settings** `POST /api/auth/recovery/regenerate {current_password}`: browser session only (`CurrentUser`; a
   device gets `403 forbidden_scope`), CSRF as every authenticated write, the current password required (`400` when wrong), rate limited
   with the password-change limiter per account. The old code stops working at once; sessions and devices are untouched. A stolen
   session alone cannot mint a way to take the account over. `GET /api/auth/recovery` returns `enabled`, `configured`, `created_at`,
   `last_used_at`, `failed_attempts`, never the code or the hash.
10. **First-run setup** returns the code in the `201` response (`SetupResult`, `recovery_code`), and the web app **holds the whole app
    back** until the owner ticks "I have saved it" and continues; the code is in memory only (not in storage, URL or console). Copy
    and "Download as file" (`atlas-recovery-code.txt`, a client-side Blob) are offered. The app cannot show it again: if the tab is
    closed before the acknowledgement, the account has a code nobody saw; the owner regenerates it in Settings (R-56). The server
    does not track acknowledgement (a flag would need an unauthenticated acknowledge step after a reset, for no real gain).
11. **Lost code and forgotten password.** `atlas-admin reset-password` on the server remains the fallback and is documented as such
    (`OPERATOR_GUIDE.md`, `OPERATIONS.md`). New: `atlas-admin recovery-code --email E` issues or replaces an account's code and
    prints it once to the operator's terminal (the only place the code is printed by the server side; the old one stops working). It
    is the way to give an account created before AUTH-01 a code without its password. An operator reset does not change the code.
12. **`RECOVERY_ENABLED`** (default `true`, forwarded in `deploy/docker-compose.yml`, `.env.example`). When `false`: setup issues no
    code (`recovery_code: null`), `POST /api/auth/recovery/reset` and `.../regenerate` answer `404`, `GET /api/auth/recovery` says
    `enabled: false`, the sign-in page's "Forgot password?" explains that recovery is off and names the operator command, and the
    owner recovers with the CLI only. Existing rows stay (turning it back on re-enables them). `GET /api/setup/status` carries
    `recovery_enabled` so the page can word its help.
13. **Cookies, CSRF, Origin.** The reset is unauthenticated, so it is **CSRF-exempt exactly like login, setup and device sign-in**
    (`_CSRF_EXEMPT_PATHS`): it is authorised by a secret in the body, it neither reads nor sets a cookie (a browser holding a session
    that posts to it has that session revoked like all the others), so there is no ambient credential for a cross-site page to ride,
    and a forged request without the code does nothing. Login has no `Origin` check either; none is added (a cross-site
    request that cannot supply the code gains nothing, and one that can has already won). Regenerate is an ordinary authenticated
    write and keeps CSRF. The `422` redaction handler already covers `/api/auth/`, so a validation error never echoes the code, the
    e-mail or a password (tested).
14. **Cross-user isolation.** Every query is keyed by the account found by e-mail or by the session's user; one account's code never
    opens another (tested both ways with a second account), regeneration for one leaves the other's code valid, and a reset signs
    out only its own account.
15. **Backups.** The dump holds the salt and the hash (what a restore needs to keep the code working) and never the code; the export
    (`GET /api/export`) holds neither. Tested with the real `pg_dump` path and by scanning every table of the database for the
    plaintext. After restoring an older backup, a code regenerated since is lost (the old one works again): regenerate after a
    restore if in doubt (`OPERATIONS.md`).

**Rejected alternatives.** E-mail or SMS reset (no service; would add an external dependency and a secret store). Security questions
(guessable, not secret). A permanent lock after N failures (turns the endpoint into a lock-out lever against the owner). Argon2 for
the code (point 2). Signing the browser in after a reset (the owner just proved possession of one factor on an unauthenticated
channel; signing in with the new password is one more step and keeps "reset" and "sign-in" separate, so no new session path exists).
Several codes per account, or backup-code lists (more state, more to lose; one code plus the CLI is enough for a single-owner server).

**Consequences.** One table, one migration, one module (`atlas/auth/recovery.py`), three endpoints, one setting, one CLI command, two
web screens and a Settings row. No dependency. A leaked code is a full account takeover until the owner regenerates it (shown once;
stored by the owner like a password; T25). Rollback: downgrade drops the table; set `RECOVERY_ENABLED=false` to turn the feature off
without a migration. **Not decided here:** e-mail or push confirmation of a reset (no channel exists), a shared (multi-process)
limiter store.

---

## ADR-0068 — Reminder notifications on devices: local scheduling as the baseline, an opt-in self-hosted UnifiedPush hint as an option (M8-04)

**Status:** ACCEPTED (2026-11-04). The owner approved the hybrid direction and **every recommendation below (Q1 to Q9)** on 2026-11-04; the answers are recorded under "Owner answers". M8-04a, M8-04b and M8-04e (server and device-core work) were implemented from it on 2026-11-04/09; the native tasks (M8-04c/d/g) stay blocked on SYNC-09/SYNC-10 and hardware.
**Related:** ADR-0007 (mobile delivery and push strategy: **its FCM/APNs/Expo choice is superseded for Atlas by this ADR once accepted**, FCM stays a rejected-by-default option, see D8), ADR-0039 (Web Push, unchanged), ADR-0055 (local-first clients), ADR-0059/0065/0066 (sync, device credentials, sync-core). Design and protocol: `SYNC_PROTOCOL.md` section 14.

**Context.** REQ-011 is `PARTIAL`: the server scheduler and the browser Web Push exist and are tested (M8-01/02/03/05), but nothing reaches the native clients. The Tauri spike showed that the desktop plugin cannot schedule notifications and that the webview has no Web Push or service worker (S5, X2, R-59); Android scheduling and Doze were not run. ADR-0007's FCM plan would add a Google account and Firebase project, and make a Google service the path for the owner's reminders. The owner's priorities are privacy and minimal operations (AGENTS.md 1, 11, 15).

**Decision (all PROPOSED except D1).**
- **D1 (owner, 2026-11-04). Hybrid.** (C) Each device schedules reminder notifications **locally** from synced reminder data. (B) An **opt-in, self-hosted UnifiedPush gateway** (ntfy) sends a **content-free "sync now" hint** to the Android app. The browser Web Push of M8-02 stays for the web app. iOS stays out of scope.
- **D2. Reminder sync timing: one server-derived `reminder` feed entity** carrying the **already computed UTC fire instant** (`remind_at`), `state` (`armed|cancelled`, never `sent`), `snoozed_until`, `acknowledged_at`, `revision`. `reminder_policy` and the default-timing preference stay **off the feed**; devices never do wall-clock arithmetic (no second copy of `remind_at_for`, AGENTS.md 7.4). Reason, costs (L1: nothing is armed for a task the server has not seen; an offline due-date edit cancels the local alarm until the next sync) and the rejected alternative (policies in the feed plus a TypeScript port): `SYNC_PROTOCOL.md` 14.2.
- **D3. Device Scheduler** in a new framework-free package `packages/reminder-core` with injected `Clock`, `NotificationPort`, `SchedulerStore`, `ReminderSource`; `reconcile`/`tick` are idempotent; ids and the **fired-set** make one notification per `reminder_id + effective_at` per device; the fired key is written **before** showing (a crash loses rather than duplicates; a missed list and catch-up recover). Tested with a fake clock and the SYNC-02/08 harness (`TESTING.md` section 12).
- **D4. Desktop (Windows, Linux)** = a **resident** app: tray icon, close to tray, optional start at login, single instance, a live long-poll (`GET /api/sync/wait`) while running, a 30 s tick that fires due reminders. Recorded platform limit: **no notification can fire while the desktop app is not running** (R-59 becomes an accepted limitation, not a defect). Desktop toasts have no action buttons; snooze/complete use the tray menu and a "Due now" panel.
- **D5. Android** = OS alarms through `tauri-plugin-notification` 2.8.0 (AlarmManager) with our manifest declaring `USE_EXACT_ALARM` and `SCHEDULE_EXACT_ALARM`, `POST_NOTIFICATIONS` requested at runtime, channel `atlas-reminders-v1`, re-arm after boot (the plugin does), after update and after time/zone/exact-alarm changes (our receivers); a bounded horizon (14 days, at most 64 alarms). Honest limits: Doze/vendor battery managers can delay or kill (R-63); without the exact-alarm permission reminders may be late by up to an hour.
- **D6. Hint channel (B)**: constant payload `{"v":1,"k":"sync"}`, nothing else ever leaves the server toward a gateway; `HintGateway` interface with a ntfy adapter; per-device destination in `device_hints` (cascade-deleted with the device); gateway **origin is operator configuration**, registered endpoints must match it exactly (SSRF control); coalesced durable job, lossy by design, bounded retries and a circuit breaker; feature **off by default**; topic treated as a secret and rotated.
- **D7. Cross-device behaviour.** Default: every device with notifications enabled fires; the **outcome** (dismiss, snooze, completion) is synced and clears the others at their next sync (`POST /api/reminders/{id}/actions`, idempotent by `action_id`, later server order wins). No best-effort "first device wins" suppression.
- **D8. Rejected by default: FCM/Firebase (and any Google account).** Trade-off recorded: FCM high-priority messages are the most reliable wake-up path under aggressive vendor battery management and Doze; UnifiedPush through ntfy depends on the distributor app surviving the same managers, so the optional hint is **less reliable than FCM on some vendors' phones**. Accepted because the local alarms (not the hint) deliver reminders, FCM would put a Google account, a Firebase project and a third-party dependency on the owner's critical path, and the hint carries no content anyway. Revisit only on measured failure (M8-04g) and with an explicit owner approval and a new ADR; `DEPENDENCIES.md` keeps FCM as "considered, not adopted".
- **D9. Privacy.** No task text, titles, counts, cursors or ids in any push provider message. Per-device `contentMode` (`full|generic`) chosen at scheduling time. No telemetry. Public `ntfy.sh` is allowed only as an explicit operator choice and documented as leaking change timing to a third party.
- **D10. Scope and gates.** M8-04 is split into M8-04a to M8-04g (`ROADMAP.md`). M8-06 is folded into SYNC-10 (Tauri Android per ADR-0055; Expo is not used), M8-07 (iOS) is out of scope, M8-08 becomes the desktop verification of the Tauri clients on Linux and Windows. The M8 exit-criteria wording "Core tasks work on Android + iOS" and "Desktop verified on Linux/Windows/macOS" must be **amended by the owner** accordingly (it is a gate waiver otherwise, which AGENTS.md 5 forbids doing silently).

- **D11 (owner-approved 2026-11-09, found by the M8-04a simulation; R-68). Snooze and dismiss count from the tap, not from the sync, through an optional `acted_at`.** `POST /api/reminders/{id}/actions` takes an optional `acted_at` (ISO-8601 **with an offset**; a value without one is `422`, the zone would be a guess): when the owner acted, by the *device* clock. The server computes `base = clamp(acted_at, now - 24 h, now + 5 min)` (`now` = server clock; no `acted_at` means `base = now`) and then exactly as before: `snooze` -> `snoozed_until = base + duration` (`tomorrow_morning` is anchored on `base`'s local date); `dismiss` -> `acknowledged_at = max(base, effective_at, remind_at)` (the `remind_at` term: a dismissal clears the snooze, so `remind_at` becomes effective again, and a snooze from an old `acted_at` can end before it; found by the soak, seeds 176 and 367). An out-of-range value is **clamped, never rejected**. Consequences, all deliberate: (1) a snooze made at 10:00 for 1 h and synced at 14:00 ends at 11:00, in the past, so the other devices show it at once (their catch-up window is 24 h and the clamp keeps `snoozed_until >= now - 24 h + 10 min`, so it is never silently "missed"); (2) `acted_at` is **never used to order** actions (arrival order decides, ADR-0059 D11) and is **not stored**: it only moves the instant a duration is added to, so a wrong device clock can shift one snooze (24 h earlier at worst, 5 min later at worst) and nothing else; (3) the clamp constants are code constants (`ACTED_AT_MAX_AGE`, `ACTED_AT_MAX_FUTURE` in `atlas/reminders/actions.py`), not settings: they bound the damage of a wrong clock and have no operational reason to change; (4) the idempotency fingerprint includes it, so a retry must be byte-identical; (5) the client (sync-core) sends `acted_at` **only when the action waited at least 60 s** between the tap and its first send and freezes that decision with the rest of the request: a prompt send uses the server clock, which is better than a device clock that may be off (`SYNC_PROTOCOL.md` 14.5). No migration. Rejected: trusting `acted_at` unclamped (a stale or hostile clock could snooze for years or ring in the past), using it for ordering (D11 of ADR-0059), and storing it.

**Owner answers (2026-11-04, all recommendations approved):**
- **Q1 accepted:** the server computes the UTC fire instant (`reminder` feed entity); the cost is accepted: an offline-created or offline-re-dated task has no reminder until the next sync (an offline due-date edit withdraws the local alarm until then).
- **Q2 accepted:** close-to-tray on; autostart asked at first run, default off.
- **Q3 accepted:** every device with reminders enabled fires; per-device toggle; dismissal/snooze/completion syncs.
- **Q4 accepted:** no quiet hours by default; an optional per-device setting.
- **Q5 accepted:** title shown, notes hidden on lock screens (`full` + channel `Private`), a setting to hide entirely (`generic`).
- **Q6 accepted:** a **home time zone** user preference (default: the browser zone at first sign-in) used when a task has no zone. Implemented in M8-04a (`users.home_time_zone`, `GET/PUT /api/notifications/time-zone`).
- **Q7 accepted, with one addition:** snooze presets 10 min, 1 h, 3 h and **tomorrow morning** (09:00 next local day, computed by the server in the task or home zone; the design had proposed durations only).
- **Q8 accepted:** the ntfy ACL/token/HTTPS hardening is REQUIRED in the operator guide (not enforced by Atlas).
- **Q9 accepted:** M8 gate wording amended: iOS and macOS are out; desktop = Linux + Windows; plus Android (see `ROADMAP.md` M8 gate, `PRODUCT_SPEC.md` REQ-012).

**Questions as asked** (kept for the record):
- **Q1.** Accept D2's costs (an offline-created or offline-re-dated task has no reminder until the next sync) or pay for a TypeScript port of `remind_at_for` with shared test vectors? *Recommend accept.*
- **Q2.** Tray and autostart defaults on desktop: close-to-tray **on** and start-at-login **off** (asked at first run)? On stock GNOME the tray may be invisible. *Recommend: close-to-tray on, autostart off with a first-run prompt.*
- **Q3.** Should a reminder also fire on the desktop when the phone already showed it? *Recommend yes (all enabled devices fire; a dismiss/snooze/done on one clears the others at their next sync); per-device switch available.*
- **Q4.** Default quiet hours? *Recommend none by default; the Scheduler supports a per-device window.*
- **Q5.** Lock-screen content default: `full` text with Android channel visibility `Private` (the OS decides on a locked screen), or `generic` text everywhere? *Recommend `full` + `Private`, `generic` one switch away.*
- **Q6.** Add a **home time zone** preference used when a task has no zone (today such a reminder fires at the chosen time in UTC)? *Recommend yes, in M8-04a as its own sub-step.*
- **Q7.** Snooze presets: 10 min, 1 h, 3 h only (no "tomorrow at 9")? *Recommend yes for v1.*
- **Q8.** Operator hardening for ntfy (`deny-all` plus anonymous write-only `up*`, subscriber credentials in the phone's ntfy app): required in the guide, or only recommended? *Recommend required in the guide, not enforced by Atlas.*
- **Q9.** Amend the M8 gate wording (D10).

**Consequences.**
- *Good:* reminders on Android work with the app closed and the phone offline (when the OS lets alarms run); no new external service is required; nothing but a constant hint can reach a third party; the server stays the only place that does date arithmetic; the hint is optional and degradable.
- *Costs/limits:* a new feed entity (+ migration, + sync-core `types_synced` backfill, + a new queued operation type for actions); a new package; a long-poll endpoint and two new device-scope endpoints (the exact-set test changes on purpose); a Kotlin plugin for Android receivers and exact-alarm handling (SYNC-10); the desktop app must be running; vendor battery managers can still defeat Android alarms; a hint needs a headless sync on Android that does not yet exist (G12).
- *Implementation notes (2026-11-09):* the `reminder` entity also carries a derived `effective_at` and an informational `server_delivered_at`; `dismiss` stores `acknowledged_at = max(now, effective_at)` so a dismissal before the instant covers it; a changed `remind_at` clears a snooze; the hint job coalesces per (user, 30 s bucket, writing device); the gateway origin is pinned (no private-range blocking needed; `http` only with an explicit opt-in or loopback outside production); the registered endpoint is encrypted at rest. Found by the simulation: a snooze that syncs after a long offline period is applied from the *server* clock, so other devices ring later than the owner intended (R-68); resolved by D11 (an optional, clamped `acted_at`, 2026-11-09).
- *Implementation notes (2026-11-09):* the `reminder` entity also carries a derived `effective_at` and an informational `server_delivered_at`; `dismiss` stores `acknowledged_at = max(now, effective_at)` so a dismissal before the instant covers it; a changed `remind_at` clears a snooze; the hint job coalesces per (user, 30 s bucket, writing device); the gateway origin is pinned (no private-range blocking: a LAN/tailnet gateway is the operator's explicit choice; `http` only with `SYNC_HINT_ALLOW_INSECURE_HTTP` or loopback outside production); the registered endpoint is encrypted at rest. Found by the simulation: a snooze that syncs after a long offline period is applied from the *server* clock, so other devices ring later than the owner intended (R-68); an optional, clamped `acted_at` resolves it (D11, 2026-11-09).
- *Risks:* R-59 (updated), R-63 to R-67. Threats: `SECURITY.md` T31 to T36.
- *Rollback:* every part is additive. Hints are off by default (`SYNC_HINT_ENABLED=false`); the `reminder` entity is ignored by clients that do not ask for `types=reminder`; the actions endpoint can be removed without data loss (columns are nullable); the Web Push path is untouched.
- *Not decided here:* policies as feed entities, calendar-event reminders on devices (M5/M6), a Play Store distribution (exact-alarm policy), iOS.

## ADR-0069 — Desktop client: a platform port, a per-row SQLite store, a confined notes folder and a thin Tauri shell (SYNC-09, phase 1 = Linux)

**Status:** ACCEPTED for phase 1 (owner instruction of 2026-11-10 to implement SYNC-09 phase 1 on Linux with this boundary; the Windows no-admin result is still outstanding, R-36). It adds to ADR-0055 (local-first, Tauri 2) and does not change it: the rule "a Windows failure moves both desktop platforms to Electron" stands, and this ADR is what keeps that move cheap.
**Related:** ADR-0055, ADR-0059, ADR-0060, ADR-0061, ADR-0065, ADR-0066, ADR-0068; `SYNC_PROTOCOL.md` sections 11, 13, 14; `SECURITY.md` section 15; R-36, R-58, R-60, R-69 to R-73.

**Context.** The spike (SYNC-07) proved Tauri 2 works on Linux and listed what SYNC-09 must do differently (13.2). The owner's Windows test may still fail, which would discard every Rust line and every Tauri API call. The spike also showed that most of what a desktop client does (sync policy, merging notes with files, scheduling reminders, session states) is not platform code at all.

**Decision.**
- **D1. One platform port, framework-neutral core.** `packages/desktop-core` holds everything that is not host glue: `ports.ts` (the PLATFORM PORT: `RowDb`, `HttpPort`, `SessionPort`, `NotesFolderPort`, `NotifierPort`, `TrayPort`, `AutostartPort`, `LifecyclePort`, `TimerPort`, `CryptoPort`), the SQLite `LocalStore`, the notes-folder engine, the live connection, the runtime and the per-device settings. It imports only `@atlas/sync-core` and `@atlas/reminder-core` (by relative path, like the existing simulations) and no host: a test (`framework-free.test.ts`) and an ESLint rule fail on `window`, `document`, `fetch`, timers, `__TAURI__`, `electron`, `node:`. `apps/desktop/src/tauriPlatform.ts` is the only TypeScript file that knows Tauri command names; `apps/desktop/src-tauri` is the only Rust that knows Tauri; `apps/desktop/native` is Rust with no Tauri at all (SQLite, folder, watcher, keystore, API client), tested alone. **If the Windows test fails:** `native` is replaced by Node modules (`better-sqlite3`, `chokidar`, `keytar`-class keystore, `fetch`), `src-tauri` and `tauriPlatform.ts` by an Electron main/preload pair implementing the same ports; `desktop-core`, its tests, the simulation, the web bridge and the e2e orchestrator survive unchanged.
- **D2. The runtime runs in the webview, the window hides to the tray.** The sync engine, scheduler and folder engine are TypeScript, so they live in the page; close-to-tray (ADR-0068 Q2, default on) only hides the window, never destroys the webview, so the runtime keeps running (the e2e run proves a change arrives and is written to the folder while the window is hidden). The cost is WebKit's timer throttling of hidden pages (R-71); the engine tick is 1 s, the scheduler tick 30 s, the live poll is a request in flight, none is sensitive to a 1 s granularity.
- **D3. Per-row store, one commit per transaction.** `SqliteLocalStore` buffers a `LocalStore` transaction's writes in an overlay (reads see committed rows plus the overlay) and sends them in ONE `RowDb.commit`, which the host applies in one immediate SQLite transaction. So "apply a page and advance the cursor" is atomic exactly as far as SQLite is, a failed `fn` writes nothing, cost is proportional to the rows a transaction changes (the spike's whole-state store was quadratic), and one IPC call per transaction. Tables are fixed (`entities, queue, meta, resolutions, problems, drafts, notes_index, settings, scheduler`) and checked in Rust, never named by the webview. Migrations are forward-only in `PRAGMA user_version`; a database newer than the build is refused (no downgrade, same rule as the key-value store). `tauri-plugin-sql` stays rejected (S2).
- **D4. `synchronous=FULL` in WAL mode.** The spike measured 0.71 ms (FULL) against 0.16 ms (NORMAL) for a 50-row page plus cursor. Data integrity is priority 1 (AGENTS.md section 1) and the difference is invisible, so FULL: an acknowledged commit survives a power cut, not only a process kill. `NORMAL` exists only in the crash tests. Recorded limit: the 100 kill -9 runs prove process death, not power loss; what SQLite promises for a power cut depends on the filesystem honouring `fsync`.
- **D5. The token never leaves Rust.** `session_sign_in` posts e-mail and password to `POST /api/devices` from Rust and stores the token in the OS keystore (Secret Service on Linux, Credential Manager on Windows, via `keyring`); there is no command that returns it and no file fallback (no keystore means no sign-in, said in words). `api_request` takes a METHOD, a `/api/...` PATH (never a URL), allow-listed headers (`Authorization`, `Cookie`, `Host` are dropped) and a string body; the host prepends the configured origin, attaches the bearer, follows no redirect, caps the answer at 32 MiB, and reports 401/426 to the runtime. HTTPS is required except loopback (checked in TypeScript for feedback and again in Rust). TLS trusts the platform store (`rustls-tls-native-roots`), which is what a private CA needs (R-60).
- **D6. The notes folder is one root granted by a native dialog, deny-by-default.** The webview cannot pass a path to grant a root (`folder_choose` opens the OS dialog inside Rust); every file command takes a relative `/`-separated path resolved inside that root (no absolute path, `..`, empty or dot segment, dot-directory, backslash, NUL, symlinked file or directory leaving the root). The Tauri `fs` plugin is NOT installed, so the webview has no generic file access at all. Writes are atomic and compare-and-swap on the SHA-256 of the bytes (checked again right before the rename); deletes never happen (files move to `.atlas-trash/`); the directory fsync is POSIX-only (the SYNC-07 W1 rule). The folder is not a second source of truth: the engine owns note text and revisions, `NotesFolderSync` translates (SYNC_PROTOCOL 11).
- **D7. External edits keep their base.** The folder index stores, per note, the file's SHA-256 and the server revision and text the file derives from. An external edit made while a newer revision arrived is sent with THAT base (`SyncEngine.editNote(id, text, base)`, a new optional argument that changes nothing for existing callers), so the server three-way merges or saves a conflict copy instead of overwriting; the conflict copy arrives as an ordinary note and becomes a file. Before the first pull the folder engine only scans (creating notes before the engine knows the server's would collide).
- **D8. The existing web UI is loaded, unchanged in behaviour.** The shell serves the built `apps/web` from the bundle (origin `tauri://localhost`, CSP `default-src 'none'`, no inline script, no remote origin, no service worker) and `apps/web` gains a feature-detected bridge (`window.atlasDesktop`): `apiFetch` goes through the host when it exists, a browser is untouched. A device token is deliberately refused on account-level endpoints (SECURITY T22), so the shell hides Account, Notifications (Web Push), Calendar, Devices and Data and adds "Desktop app"; the browser remains the place for them. Moving the UI onto the local database is SYNC-11/12, not phase 1.
- **D9. Packaging and updates.** AppImage and `.deb` from `apps/desktop/scripts/build-linux.sh`; the bundler tools that the spike let the bundler fetch unchecked (a `continuous` release) are pinned by SHA-256 in `packaging/bundler-tools.tsv` and installed by `fetch-bundler-tools.sh` or the build stops. Automatic updates exist only as the `updater` Cargo feature plus a config overlay, compiled into no default build; the test uses a throwaway key and a local server and nothing is published. Rollback is the previous AppImage kept in `out/previous/`.
- **D10. Test hooks are a feature, not a flag.** The `e2e` Cargo feature (reports, a command file, an injected driver, a notes root from the environment instead of the dialog) and its capability file are compiled only into the test binary; a default build contains none of them and answers `not available`.

**Alternatives rejected.** The sync engine in Rust (a second implementation of merge/rebase/backoff; the TypeScript core is already simulated against the real server). `tauri-plugin-fs` with a runtime scope (a generic read/write surface in the webview for no benefit). `tauri-plugin-store`/`stronghold` for the token (a file; the keystore is the point). A whole-state key-value store (quadratic, R-60). Loading the remote server's web UI in the shell (no offline start, remote origin with IPC access). Electron now (the Windows evidence is missing; D1 keeps the door open).

**Consequences.** More files than a straight shell, but each side is small and testable alone. The bridge adds a small, feature-detected branch to `apps/web`. A hidden webview is part of the product (R-71). The device token's narrow scope shapes the shell's Settings. The desktop never writes outside one folder, one database file and one config file.

## ADR-0070 — Conflict, notice and restore UI on shared components; the desktop shell on one sync engine; the browser path planned (SYNC-11)

**Status:** ACCEPTED for SYNC-11a/b/c (owner instruction of 2026-11-10); the browser local store (D9) is PROPOSED and is only planned (SYNC-11d), nothing of it is built. It adds to ADR-0055, ADR-0059 (D7, D12), ADR-0061, ADR-0066 and ADR-0069 and changes none of them.
**Related:** `SYNC_PROTOCOL.md` sections 7.4, 9; R-22, R-48, R-54, R-69, R-73, R-74, R-75; `ROADMAP.md` SYNC-11.

**Context.** SYNC-05 logs what the server decided when two devices changed the same thing, SYNC-08 keeps what a client could not apply as data (`Problem`), and a stopped sync is a state (`Halt`). None of it had a screen. The browser app works and must not regress; reading the code on 2026-11-10 showed that (a) the browser's offline queue is not fed by any production code (only tests enqueue into it), (b) the browser's writes are not sync mode, so it never produces resolution entries or `Problem`s itself and sees other devices' entries only through `GET /api/sync/resolutions`, (c) the desktop shell's UI reads and writes over REST through the host while a second engine (sync-core) runs beside it for the notes folder and reminders (R-73).

**Decision.**
- **D1. Presentational components over two sources.** Components render `ResolutionRecord`, `Problem` and `Halt` shaped data and decide nothing; wording and decisions are pure functions in `apps/web/src/lib/syncUi/` (tested without React). A `ResolutionsSource` answers `ownDeviceId`, `deviceNames`, `page`, `undo`: the REST source (a browser; endpoints `GET /api/sync/resolutions`, `POST .../undo`) and the engine source (the shell: the engine's local store through the bridge). Both return the same `UndoOutcome`.
- **D2. The browser keeps its engine.** The browser's M7 autosave sessions and REST reads and writes are unchanged. SYNC-11a/b add routes, components and a Settings block; nothing changes how a browser reads or writes data. R-54 stays open until D9.
- **D3. "Changed on another device".** An entry is a notice if another device wrote it (`device_id` differs from this device; a browser has no device of its own, so only entries written by a device count), it is not an undo record and not already undone. A banner in the shell counts new ones since the person last looked (a per-browser mark, never required) and links to the Changes page (paged, newest first). Wording never contains text: the log holds only simple fields, paths and revisions, and a title is looked up from the entity itself. Undo uses one `Idempotency-Key` per tap until the answer is definite. Refusals are outcomes, not errors (R-48): "changed again since" (nothing overwritten, the entry stays), entity deleted, value not valid any more, path taken, already undone, not undoable (with the follow-up the server names: delete again / open the note / rename), expired (404), offline (queued in the engine source, told to the person).
- **D4. Text conflicts keep both versions until the write is acknowledged.** The resolver shows mine and theirs and offers keep mine, keep theirs, edit merged. The chosen text is saved as an ordinary revision-checked write against the latest revision (the task panel's existing "Load latest version" flow, now with the resolver on the set-aside text fields; the engine's `Problem` via `updateEntity`), so a newer change conflicts again instead of being overwritten. Keep theirs saves nothing.
- **D5. Note conflicts.** A conflict copy (`<name> (conflict YYYY-MM-DD HHMMSS[ n]).md`, MARKDOWN_STORAGE) is paired with its original on the Notes page; the resolver shows an inline line diff and the person keeps mine (the copy's text becomes the note), keeps theirs, or merges in one text. The original is written with its revision first; the copy is deleted (to the trash) only after that write is acknowledged; a `409` rereads the original and deletes nothing. The merge editor is a plain textarea (the CodeMirror editor is lazy-loaded and heavy for a rare dialog); existing history endpoints are not needed because both texts are present.
- **D6. Restore confirmation has two choices and neither is automatic.** "Re-upload my local data" is `confirmRestore()` (re-creates what the server lost, same ids). "Discard local changes and re-download" is the new `SyncEngine.discardLocalAndRedownload()`: it adopts the epoch, drops every unsent operation, note working copy and kept problem (an entity that never reached the server is forgotten) and walks a snapshot in which the server wins even where its revision is lower; entities the server lost are dropped, not re-created. It asks twice in the UI. In the desktop shell files in the notes folder are never deleted by it: a file the server does not have is added again by the next scan (said on the screen). This is a sync-core behaviour change, so the model simulation gained a scenario (planted defects unchanged).
- **D7. The shell has one sync engine.** The bridge gets a `sync` namespace (resolutions, problems, dismiss, undo, confirm/discard restore, resolve text, resume after update); the page never gets the engine, the store or a token. In the shell the status bar and Settings > Sync read the engine, and the browser's offline queue, reconciler and cursor are never started (a test fails if they are). What this does NOT do: the UI's task, project and note reads and writes are still online REST through the host; the local database is not the UI's source of truth. Moving the data hooks (lists, filters, recurrence, search, planning) onto the local store would re-implement server logic in the client (AGENTS.md 7.4) and is not attempted; it is SYNC-12 or later, if at all.
- **D8. Device names.** A device token cannot list devices (T22), so the shell names only its own device and says "another device" for the rest (R-74). The server scope is not widened for wording.
- **D9. The browser local store (PROPOSED, SYNC-11d, not built).** An `IndexedDbLocalStore` for sync-core, behind a Settings opt-in "Offline mode (beta)", default off. Design constraints recorded now so the task starts from them: per-row object stores mirroring the desktop table list and one commit per `LocalStore.transaction` through an overlay (an IndexedDB transaction auto-commits when idle and cannot await foreign promises); `durability: "strict"`; ask for persistent storage and tell the person when the browser refuses (Safari clears script-writable storage after 7 days without use: unsent changes would be lost, so the mode warns and the engine treats a missing database as a new device only after showing what was unsent); one engine per browser (Web Locks leader, `BroadcastChannel` for other tabs); a cookie-session transport variant (credentials, CSRF header, `Atlas-Sync: 1`; 401 goes to the sign-in page); turning the mode off drains the queue when online or asks the person to discard, never silently drops; acceptance = the store contract and the simulation over a fake IndexedDB, crash tests, a two-tab Playwright test, an axe sweep. It needs the UI's write paths (autosave sessions for tasks and notes) routed through the engine, which is the real size of the task. Why not now: the browser works, the change touches every write path, and the evidence needed (strict durability, eviction behaviour per browser) has not been gathered.

**Alternatives rejected.** Moving the shell's UI onto the local store now (D7). Showing resolutions only in the browser (the shell would have no notices). A server change to add device names to resolution entries (touches the feed shape and the sync-core record for wording only). Auto-choosing "re-upload" or "discard" (D12 says never automatic). A third-party diff library (about 60 lines suffice for display; the server merge stays the only automatic merge). Putting the conflict resolver in a modal that blocks the page (a conflict is not an emergency; the notice is a banner).

**Consequences.** New routes (`/changes`), a banner in the shell, a Settings block and a halt screen, all feature-detected where they depend on the shell. The sync-core package gains one method. The bridge gains eight verbs (SECURITY.md 15 lists what the page can now ask of the engine: the same data it can already read through the REST API, plus the two restore choices). Offline editing in the shell UI is still not provided (R-73 stays open, narrower).


## ADR-0071 — Calendar Stage A: read-only OAuth providers, a snapshot-aware sync core and local recurrence expansion (M5-03/04/05/07)

**Status:** ACCEPTED (2026-11-10, owner brief). **Related:** ADR-0006, ADR-0008, ADR-0027, ADR-0029, ADR-0030, ADR-0031; `CALENDAR_SYNC.md` sections 11-12; `SECURITY.md` section 16; R-01, R-13, R-76 to R-80.

- **D1. Read-only, minimal scopes.** Google `calendar.readonly`; Microsoft `Calendars.Read` + `offline_access`. Write scopes are Stage B and are not requested. A grant missing the required scope, or without a refresh token, is refused and nothing is stored.
- **D2. Authorisation code + PKCE (S256) with a confidential client.** `state` = 256 random bits, stored only as a SHA-256 hash, single use (conditional `UPDATE`), TTL 10 min, bound to the browser session (hash of the session token); the redirect URI is derived from `PUBLIC_BASE_URL`, validated (https, or http on loopback) and stored with the state so the exchange sends the stored value.
- **D3. Tokens.** Encrypted by the existing store (ADR-0027); refreshed server-side by `TokenManager`, persisted by the caller (adapters have no DB); Microsoft's rotated refresh token is stored; `invalid_grant` sets `needs_reauth_at`, scans skip the account and the UI asks to reconnect. Tokens never reach the browser, a URL or a log; errors carry no URL, header or body.
- **D4. Google: `singleEvents=false` + local expansion.** Keeps the `syncToken` valid for unbounded series and the projection small; exceptions are separate events, cancelled occurrences are stored as cancelled overrides. `showDeleted=true` always. `410` restarts as a full listing flagged `is_snapshot`.
- **D5. Microsoft: Graph expands recurrences.** The only event delta is `calendarView/delta` over a window (default -90/+365 days), so occurrences arrive expanded and the cursor is `window_end|deltaLink`; a window nearing its end or a `410` restarts as a snapshot. Events outside the window are not synced.
- **D6. Snapshot semantics in the sync core.** `EventPage.is_snapshot` (set only by an adapter that read a complete listing) makes the sync tombstone live projections the listing did not contain, inside the same transaction as the cursor. This is how ICS (no deletion markers) and full resyncs detect deletions, without ever treating a short or failed read as "everything is gone".
- **D7. Identity.** Projection ids are `sha256(calendar_id)[:12]:raw_id` (a shared Google event can exist in two calendars); an ICS override is `UID#recurrence-instant`. The API exposes the row UUID (plus `occurrence` for an expanded instance), never provider ids.
- **D8. Disconnect and hiding.** Disconnect revokes at Google (Microsoft v2.0 has no revocation endpoint), then deletes credential, calendars, cursors **and projected events** (a cache of provider-owned data; reconnecting re-syncs). Hiding a calendar keeps projection and cursor and stops syncing and display.
- **D9. One credential per provider per user; any number of ICS feeds (max 20).** The credential table is keyed by user + provider (ADR-0027); multi-account Google/Microsoft is a later, separate change.
- **D10. Jobs.** The existing `calendar.reconcile` chain syncs selected calendars (and feeds at `ICS_POLL_SECONDS`); a one-off `calendar.sync_user` job runs after connect, selection or adding a feed. Webhooks are not used (need a public endpoint; Atlas is private, SEC-01); M5-09 stays `BACKLOG`.
- **D11. Fake provider for tests.** `tests/fakes/calendar_provider.py` mimics the documented shapes and enforces redirect URI, single-use codes, PKCE, secret, token expiry; `CALENDAR_FAKE_PROVIDER_URL` routes the app to it and is refused in production.

**Alternatives rejected.** Google/Microsoft SDKs (heavy, hide failure modes; AGENTS.md section 7.5). `singleEvents=true` for Google. Webhooks now. Keeping projected events after disconnect. Last-write-wins anywhere (nothing is written to providers).

**Consequences.** Live compatibility with Google/Microsoft is **unverified**; the runbook (`CALENDAR_SYNC.md` 12.7) produces the evidence. Microsoft's window and Google's full history are documented limits.

## ADR-0072 — ICS feed adapter (Proton and any ICS URL): secret URL, SSRF guard, `icalendar` + `dateutil` (M5-11)

**Status:** ACCEPTED (2026-11-10). **Related:** ADR-0071, ADR-0015; `SECURITY.md` T24; DEPENDENCIES.md; R-77, R-78.

- **D1. Why ICS.** Proton Calendar has no public API and Proton Bridge does not cover calendars; "Share via link" yields a secret read-only ICS URL (no authentication beyond the secret). The same adapter serves any ICS URL.
- **D2. The URL is a secret.** Sealed with the credential cipher (AES-GCM, bound to user and row), masked (`https://host/........`) in every response, absent from logs, errors, `repr`, diagnostics and validation errors (the `/api/calendar/feeds` prefix is redacted like credentials).
- **D3. SSRF guard** (`netguard.py`, `feed.py`): https only (`ICS_ALLOW_HTTP` for development), no userinfo, resolve then require every address to be globally routable (private, loopback, link-local incl. metadata, CGNAT, ULA, multicast, IPv4-mapped and NAT64 unwrapped), connect to the **validated address** (DNS-rebinding safe; `Host` and SNI keep the name), manual redirects (max 3, each re-validated), decoded-size cap (10 MiB), timeouts, content-type and `BEGIN:VCALENDAR` checks, conditional GET (ETag/Last-Modified), per-user rate limit on test/add.
- **D4. Parsing.** `icalendar` (BSD-2-Clause) for the grammar, `zoneinfo` + a Windows-name table for zones, `python-dateutil` for RRULE (no custom recurrence engine). All-day events are local dates, floating times use `X-WR-TIMEZONE` or UTC, EXDATE/RDATE are stored as UTC instants, rules finer than hourly are dropped, a malformed event is skipped and counted, a non-calendar body is a safe error. Deletions come from diffing (D6 of ADR-0071).
- **D5. Honest limits.** Read-only; Proton refreshes feeds slowly; an embedded custom `VTIMEZONE` is not honoured for recurrence; `RANGE=THISANDFUTURE` is treated as a single override; revoking a link means regenerating it at the source.

## ADR-0073 — Selectable accent colours, per device, over the neutral default (UX-12)

**Status:** ACCEPTED (2026-11-10, owner request: "I would just like to have some more accent colors."). **Related:** ADR-0051 (neutral default), ADR-0062 (semantic colour tokens), ADR-0057-0064 (tokens, touch rules), `UX_AUDIT.md` 3.1a.

- **D1. The default does not change.** Neutral (ink in Light, near-white in Dark, ADR-0051) stays the default and is the absence of a choice: no `data-accent`, no stored value. A new viewer, a cleared browser and an invalid stored value all get Neutral.
- **D2. Nine more accents** (Blue, Indigo, Violet, Pink, Red, Orange, Amber, Green, Teal), each defined as the five existing accent tokens only (`--accent`, `--accent-hover`, `--accent-contrast` = text on the solid, `--accent-text` = text/links/focus ring on surfaces, `--accent-soft` = tint). No token was renamed. The focus ring is `--accent-text` (it already was), so it is tested at 3:1 (it is 4.5:1 as text) rather than becoming a sixth token. Each accent has a Light block, a System-dark block and an explicit-Dark block (identical values; the dark ones are one attribute more specific, so they win over the Light block in either dark path). A change to a dark value is made in both dark blocks, as for every dark token; `styles.test.ts` checks they are identical.
- **D3. An accent block may define only the five accent tokens.** Overdue, due-today, priority, success, warning, danger, project dots and calendar colours never follow the accent and keep their own contrast guarantees (a test asserts the block's key set and a Playwright test that the computed semantic values are unchanged across all ten accents). Consequence accepted: an Amber, Orange or Red accent resembles the warning/overdue colours; they are told apart by their use (a solid button or link versus a chip with an icon and a word), not by hue alone.
- **D4. Contrast is the gate, not the palette.** Values were chosen by searching lightness at a fixed hue until the ratios held; no ratio was lowered. For every accent x theme (Light, Dark) `styles.test.ts` checks: `--accent-text` 4.5:1 on all ten surfaces and on `--accent-soft`; `--accent` and `--accent-hover` 3:1 on all ten surfaces; `--accent-contrast` 4.5:1 on `--accent` and `--accent-hover`; `--text` 7:1, `--text-2` and `--text-3` 4.5:1 and danger/warning/success 4.5:1 on `--accent-soft`; the tint stays calm (< 1.4:1 against the page).
- **D5. What follows the accent.** Primary buttons, links, focus rings, checked boxes and radios, progress, the tab underline, the selected outline of a few controls, **selected navigation** (sidebar and rail item, bottom-nav item, segmented controls, Notes mode buttons, preset pills: they now use the tint and `--accent-text` instead of the grey `--bg-selected`; with Neutral the values are the same as before), the settings navigation, the notes editor's selection colour, live-preview links and tags. Today/this-week highlights use the semantic `--due-today`, not the accent, on purpose. The desktop shell's own welcome page keeps its own colours (it is not the web UI).
- **D6. Storage and timing.** Key `atlas-accent` in `localStorage`, per device, wrapped in try/catch. `public/theme-init.js` (a same-origin classic script, CSP-safe) sets `data-accent` before first paint, also on the login and setup screens; a test checks it knows exactly the palette of `src/lib/accent.ts` and ignores anything else. The store reacts without a reload, also to a change made in another tab (`storage` event). It is independent of the Theme setting: System, Light and Dark keep working.
- **D7. Picker.** Settings -> Appearance: a radio group of ten named swatches (native radios, so arrow keys and Tab work), 44 px targets, Neutral labelled "(default)", the selected one marked by a check mark, a heavier outline and bold text, applied at once (the page is the live preview). The dots use `--swatch-*` tokens (one mid-tone per accent, 3:1 on the card and panel in both themes); there are no colour literals outside the token blocks (tested).
- **D8. Not done, by design.** The preference is not synced across devices (a later option: a per-user setting in the sync feed, which needs a server change and a conflict rule); no per-project or user-defined colours; no accent in the desktop shell's chrome; no backend change.
- **D9. Coloured headings (owner addition, 2026-11-10).** A second per-device preference, "Colour headings with the accent" (key `atlas-accent-headings`; only an explicit `off` is stored, so it is **on by default**), puts `data-accent-text="on"` on `<html>` **only when the accent is not Neutral** (Neutral text stays neutral; the switch is then a no-op and says so). `theme-init.js` sets it before first paint. When on, these take `--accent-text`: every `h1` (page titles), Settings section titles and group headings, calendar card headings, the calendar period title, sidebar section labels (Planning, Workspace, More), Markdown headings h1-h6 in the preview and in live preview (heading lines and their `#` marks; code inside a heading and body text, links-as-links and inline formatting stay independent). Not touched: body text, row titles, meta text, form labels, the grey section bands and the semantic headers (Overdue, Due today, day headers). **No new token:** `--accent-text` is already tested at **4.5:1** (large-text 3:1 is not used as a bar) on page, card, section band, sidebar, raised panel and the editor background, and on the tint, for every accent in Light and both dark blocks; a test pins the heading rule to that single declaration, to `data-accent-text="on"` and to a list that excludes the semantic and body selectors. The picker shows a heading sample.

## ADR-0074 — Releases: tag-driven CI, versioned server images and a host updater driven from Settings (REL-01)

**Status:** ACCEPTED (2026-11-10, owner request: "setup the CI/CD ... also create the desktop clients as releases. I should be able to update the server from the frontend without losing anything"). **Related:** ADR-0055 (desktop), ADR-0069, SEC-01 (private until audited), `OPERATIONS.md` 2.7 (restore).

- **D1. A release is a tag.** `git tag vX.Y.Z` on a commit that is on `main` starts `.github/workflows/release.yml`: the full CI workflow runs first (`workflow_call`), then the server images, the Linux desktop clients and a GitHub Release. The tag is the only version source: it is passed into the API image (`ATLAS_VERSION`) and into the desktop build (`--config version`), so no file is edited to release. "Run workflow" builds everything without publishing (a dry run).
- **D2. Server images instead of a source build.** `ghcr.io/<owner>/atlas-api` and `atlas-web`, tagged `X.Y.Z`, built in CI and smoke-tested through `deploy/docker-compose.release.yml` (the same compose files the server uses) *before* they are pushed. The server builds nothing (it has little disk), and an update is a pull plus a restart. amd64 only. The images are private (GHCR, same visibility as the private repository), so the server needs a read token (D6).
- **D3. The web app cannot update itself, and must not have Docker.** Mounting the Docker socket into the API would make a web-app flaw a root-on-the-host flaw. Instead the API and a **host updater** exchange two files in a shared directory (`<install>/update`): the API reads `status.json` and writes `request.json`; a systemd path unit starts `deploy/updater/atlas_updater.py`, running as the Docker user. The API holds no registry or GitHub credential and makes no outbound call for this.
- **D4. The host re-decides every request.** The API accepts only the version the host itself reported as the newest (`status.json`), a browser session is required (a device token is refused), and nothing is accepted while an update runs. The updater then asks GitHub for the newest release itself and refuses a request for any other version, refuses a downgrade or the same version (migrations only go forward), refuses to start below 1.5 GB free, and extracts only `deploy/`, `apps/web/nginx*.conf` from the release's deploy bundle (path-confined, regular files only).
- **D5. No data loss, by order of operations.** (1) Download the bundle and **pull the new images while the old version keeps running**; a failure here changes nothing. (2) Stop `web`, `api`, `worker` (the database keeps running) so nothing can be written any more. (3) Take a backup with the *old* version's `atlas-backup run` and verify it; no verified backup, no update. (4) Swap the compose files (old ones kept in `update/previous-deploy`), write the new `version.env`, start. (5) Wait until the API reports `ready` **and** the new version. Failure at 4 or 5: stop, **restore the backup only if the database revision changed** (the new version migrated it), restore the previous files and version, start the previous version, run `atlas-admin record-restore` when the database was restored (sync clients are then asked before adopting anything, ADR-0059), and report `rolled_back` in Settings. The restore loads the dump into a fresh database first and swaps names only after it loaded cleanly, so a failed restore never replaces the live database. Notes, volumes and `.env` (with `TOKEN_ENCRYPTION_KEY`) are never modified or removed. The notes volume is not rolled back (an old version reads what a new one wrote; the backup archive is there for a manual restore).
- **D6. Trust root, stated plainly.** The updater runs what the owner's GitHub account published: images pulled by tag and a deploy bundle from the release, authenticated by one personal access token (`repo` + `read:packages`) in an owner-only file on the host (`~/.config/atlas-updater/env`, never in the repository, `.env` or the shared directory). There is no signature check yet (cosign or a pinned digest list is a SEC-01 item); anyone who can publish a release or push an image can change what the server runs. The token must be rotated if the server is lost.
- **D7. What is not done.** The desktop clients do not update themselves (the Tauri updater stays off, `DEPLOYMENT.md` 12; the owner installs the new AppImage or `.deb`); Windows is built only when the repository variable `ATLAS_BUILD_WINDOWS=true` and is unverified; no Android build; no auto-apply (an update is always one click by the owner, a daily check only fills `status.json`); no multi-arch images; a server still built from source switches to release images on its first `atlas_updater.py apply`.

