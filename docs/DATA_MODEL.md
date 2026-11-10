# Atlas — Data Model

**Status:** Draft for approval (Milestone 0)
**Last updated:** 2026-10-26

Describes persistent entities, their ownership, and the fields that support
synchronisation and conflict handling. This is a design specification; concrete
SQLAlchemy models and Alembic migrations are produced per milestone.

---

## 1. Conventions

- **Primary keys:** UUID v4 (or v7 where sortable ordering helps), generated server-side.
- **Timestamps:** `created_at`, `updated_at` stored as `timestamptz` (UTC). User-facing times
  carry an explicit IANA time zone where the distinction matters (due dates, schedules).
- **Revision:** every mutable entity has an integer `revision` that increments on each
  applied change. Clients send the revision their edit was based on.
- **Idempotency:** mutations accept a client-generated `idempotency_key`; the same key applied
  twice yields the original result and does not re-apply.
- **Deletion:** soft delete via `deleted_at` (tombstone) for entities that sync to offline
  clients. Tombstones are retained long enough to cover the maximum offline window.
- **Ownership:** each entity's source of truth is declared below (aligned with
  `ARCHITECTURE.md` §5).
- **Parameterised access only.** All queries use bound parameters.

## 2. Entity Catalogue

### 2.1 Identity and access

**User** — owner: PostgreSQL
`id`, `email`, `display_name`, `password_hash` (or external IdP subject), `created_at`,
`updated_at`, `is_active`, `change_seq` (the monotonic per-user change-feed cursor, M7-01),
`change_purge_floor` (the highest change-feed cursor the retention purge has removed, M7-02).

**Session** — owner: PostgreSQL
`id`, `user_id`, `token_hash`, `created_at`, `expires_at`, `revoked_at`,
`user_agent`, `ip_hash`.

**Device** (table `devices`) — owner: PostgreSQL (SYNC-06, ADR-0059 D8, ADR-0065; migration `b7c4d9e2a1f5`)
`id`, `user_id` (`users.id ON DELETE CASCADE`), `name` (1-80 characters), `platform` (`windows|linux|macos|android|ios|web|other`; a
check constraint), `created_at`, `last_seen_at` (server time of the last authenticated request, at most every five minutes; `NULL`
until the first), `revoked_at`, `token_hash` (SHA-256 hex of the bearer token, **unique**), `prev_token_hash` +
`prev_valid_until` (the token before the last rotation and the end of its 24 h grace; cleared when the new token is first used).
> One row per signed-in sync client. The token (256 random bits, prefix `atd_`) is shown once and never stored; a backup holds
> hashes only, so a restored database does not hand out working credentials. A revoked row stays so its token is answered
> `token_revoked`; the hourly `changes.purge` job deletes devices revoked before the `change_retention_days` window. An idle,
> never-revoked device is kept (the owner decides). `sync_resolutions.device_id` references this table (`ON DELETE SET NULL`).
> Indexes: unique `token_hash`; partial `prev_token_hash`; `(user_id, created_at)`. At most 25 unrevoked rows per user.

**RecoveryCode** (table `recovery_codes`) — owner: PostgreSQL (AUTH-01, ADR-0067; migration `c9e4a7b2d6f1`)
`user_id` (primary key, `users.id ON DELETE CASCADE`: at most one code per user), `code_salt` (hex of 16 random bytes, the HMAC key),
`code_hash` (hex HMAC-SHA-256 of the normalised 30-character code), `created_at`, `last_used_at` (the last password reset with it,
`NULL` = never), `failed_attempts` (wrong tries since it was last issued or used; diagnostic, check `>= 0`).
> The code itself (150 random bits) is never stored or logged; it exists in clear only in the response that issues it. A backup holds
> salt and hash, so a restore keeps the code working and hands out no credential. Existing accounts have no row until the owner
> creates one in Settings. Replaced (not added to) by every use, regeneration and `atlas-admin recovery-code`.

**ProviderCredential** (table `provider_credentials`) — owner: PostgreSQL (encrypted)
`id`, `user_id`, `provider` (`google`|`microsoft`), `key_id` (encryption key version),
`ciphertext` (AEAD seal of the token bundle: access/refresh token + token type), `scopes`
(`text[]`), `access_expires_at`, `refresh_expires_at`, `created_at`, `updated_at`.
Unique per `(user_id, provider)`.

> Refresh/access tokens are encrypted at rest as a **single authenticated ciphertext**
> (AES-256-GCM) with a key held outside the database (`TOKEN_ENCRYPTION_KEY`); the row records the
> `key_id` used so keys can be rotated. `scopes` and expiry are not secret and are stored in clear.
> A credential is hard-deleted when an account is disconnected (no tombstone). Implemented in M5-01
> (`DECISIONS.md` ADR-0027).

### 2.2 Notes (metadata only — content lives on disk)

**NoteIndex** — owner: PostgreSQL (metadata); content owner: filesystem
`id`, `user_id`, `path` (relative to notes root, unique per user **among live notes**: partial unique index
`uq_notes_user_id_path_live`, `WHERE deleted_at IS NULL`, SYNC-03c/ADR-0059 D3; a tombstone keeps its row and id but no longer reserves
the path), `title`,
`content_hash` (e.g. SHA-256 of file bytes), `revision`, `size_bytes`,
`created_at`, `updated_at`, `deleted_at`.

> Authoritative content is the `.md` file. `content_hash`/`revision` detect stale writes and
> external edits. See `MARKDOWN_STORAGE.md`.

**NoteRevision** (`note_revisions`, SYNC-04, migration `e7a3c5b1d9f2`) — owner: PostgreSQL (metadata); text owner: the history files
`note_id` + `revision` (primary key; FK to `notes` `ON DELETE CASCADE`), `user_id` (FK, denormalised so a read is scoped without a join),
`content_hash` (SHA-256 of the revision's UTF-8 text), `size_bytes`, `path` (the note's path at that revision), `reason`
(`create` | `write` | `merge` | `move` | `delete` | `revive` | `external` | `legacy`), `created_at`.
One row per retained revision of every note, written in the same transaction as the revision bump (create, write, merge, move,
folder rename, delete, revive, external edit found by reconcile); the text is
`<notes-root>/.atlas/history/<note_id>/<content_hash>.md`, shared by revisions with the same text. Retention and pruning:
`SYNC_PROTOCOL.md` 6.3, `MARKDOWN_STORAGE.md` 4a. A row whose file is missing, damaged or pruned is *unavailable*: it is listed
but never used as a merge base. Rolling the migration back drops the table and leaves the files (inert).

**NoteLink** — owner: PostgreSQL (derived index)
`id`, `source_note_id`, `target_path`, `target_note_id` (nullable, unresolved if null),
`link_text`, `created_at`.

**Tag** — owner: PostgreSQL (derived index)
`id`, `user_id`, `name`.
**NoteTag** — `note_id`, `tag_id` (join).

### 2.3 Tasks and projects

**Task** — owner: PostgreSQL

| Field | Notes |
|---|---|
| `id` | UUID, immutable |
| `user_id` | owner |
| `title`, `description` | |
| `status` | `inbox` \| `next` \| `in_progress` \| `completed` \| `archived` |
| `priority` | enumerated (e.g. none/low/medium/high/urgent) |
| `project_id` | nullable — tasks need not belong to a project |
| `parent_task_id` | nullable — subtasks |
| `start_at`, `due_at` | nullable `timestamptz` |
| `time_zone` | nullable IANA tz for due/schedule semantics |
| `duration_minutes` | nullable estimate |
| `completed_at` | nullable |
| `recurrence_rule` | nullable RFC 5545 RRULE (text) |
| `recurrence_parent_id` | nullable — links occurrences to their series |
| `reminder_policy_id` | nullable |
| `external_provider`, `external_id` | nullable task-provider mapping (future) |
| `revision`, `created_at`, `updated_at`, `deleted_at` | sync fields |
| `field_revisions` | `jsonb NOT NULL`: field name -> the `revision` at which it last changed (SYNC-03a, ADR-0059 D4). Keys: every writable column plus `tags` (one simple field). Maintained by the service on every write (create = all fields at 1; a write stamps only fields whose value changed, including server effects such as `completed_at`/`project_id`/`parent_task_id`); backfilled by the migration to the row's current `revision`. Used by the sync-mode merge; it cannot reconstruct an old value |

> **Search indexes (MU-05, ADR-0047, migration `a8c4d9e2b7f1`).** `tasks` and `projects` each carry one GIN
> *expression* index for the unified search — `ix_tasks_search_fts` on `to_tsvector('simple', title ||
> ' ' || description)` and `ix_projects_search_fts` on the same over `name`/`description`. They store
> nothing new (no column, no second source of truth), are derived by PostgreSQL on every write and are
> dropped by the migration's downgrade. Notes use the existing `notes.search_vector` index.

> **Incremental pull (M3-09).** A client fetches everything that changed after a task `revision` it
> holds via `GET /api/tasks/changes?since=N`: the user's tasks with `revision > N`, ordered by
> `revision` ascending, **including soft-deleted tombstones** (`deleted_at` set) so deletions
> propagate. Because `revision` is per-task, a page never splits a run of equal revisions and the
> response carries the new high-water mark (`next_since`) and `has_more`. This feed is derived from
> the task rows themselves, not from the `ChangeLog` table below; those rows are never purged, so a
> client may always resync from `since=0`. (The cross-entity `change_log` feed below has its own
> bounded retention — ADR-0033.)

**RecurrenceSeries** — owner: PostgreSQL
`id`, `rule` (RRULE), `dtstart`, `time_zone`, `end_date`, `count`,
`recurrence_parent_id` (points at the task acting as the series head).

> Completing an occurrence completes only that occurrence and generates the next one. It never
> completes the whole series.

**TaskLink** (task ↔ note) — `task_id`, `note_id`, `created_at`.
Survives note renames by referencing the stable note id, not the path.

**Tag assignment** — `TaskTag(task_id, tag_id)`. Exposed on the task API as `tags: string[]` (replace
semantics, ADR-0044); the `Tag` row is per user and matched case-insensitively.

**Project** — owner: PostgreSQL
`id`, `user_id`, `name`, `description`, `status`, `start_date`, `target_date`,
`revision`, `field_revisions` (as for tasks; keys `name`, `description`, `status`, `start_date`, `target_date`), `created_at`,
`updated_at`, `deleted_at`.

> `status` is one of `active` | `completed` | `archived` (default `active`). `tasks.project_id` is
> a foreign key to `projects.id` with `ON DELETE SET NULL`: removing a project clears the
> association but never deletes its tasks (ADR-0020). Project deletion is a soft delete
> (`deleted_at`), so the row is retained for clients; progress remains derived, not stored.

> **Project tombstone and its tasks (M4-02, ADR-0021).** Deleting a project is always a soft delete
> and **never** deletes a task. Soft-deleting a project *un-files* its **live** tasks: their
> `project_id` is set to NULL and their `revision` is incremented in the same transaction, so an
> offline client sees an ordinary task update through `GET /api/tasks/changes` and renders the task
> as unfiled. Tasks that are themselves tombstoned are left untouched (their `project_id` is cleared
> only by the FK on a hard delete). A tombstoned project can no longer be assigned to — task
> create/update reports `400 project does not exist` — and the old project id matches nothing in the
> `project_id` list filter. Membership stays optional and single-valued: a task has at most one
> project and may have none.

**NoteProject** (note ↔ project) — `note_id`, `project_id`, `created_at`.

> The note↔project association (M4-05). The composite primary key `(note_id, project_id)` makes it
> **unique per pair**; both foreign keys are `ON DELETE CASCADE` — a link has no meaning without
> both ends, and the existing `TaskLink` sets the precedent (ADR-0024). It references the note's
> **stable `id`, never its `path`**, so it **survives a note rename** (`MARKDOWN_STORAGE.md`). The
> API's `DELETE` is a soft delete, so each side clears its link rows in the same transaction as the
> tombstone — deleting a note or a project removes the association, leaving no orphans — rather than
> relying on the key; the listings also join the live entity (`deleted_at IS NULL`) as defence in
> depth. A note may be linked to any number of projects and a project to any number of notes; the
> association is optional and strictly user-scoped.

**BoardColumn** — owner: PostgreSQL
`id`, `project_id`, `name`, `position`, `maps_to_status`.

> Progress is **derived**, not stored: `completed_tasks / total_tasks`, excluding `archived` and
> soft-deleted (tombstoned) tasks (a project with no countable tasks is `0/0`, reported as `0%`). The
> formula is the documented, canonical rule (`PRODUCT_SPEC.md` §5.3, ADR-0023) and is covered by tests.

### 2.4 Calendar (projections and mappings)

**CalendarAccount** — owner: PostgreSQL
`id`, `user_id`, `provider`, `account_label`, `external_account_id`,
`credential_id` (→ ProviderCredential), `created_at`, `disconnected_at`.

**CalendarSource** — owner: PostgreSQL
`id`, `account_id`, `external_calendar_id`, `name`, `is_selected`, `color`,
`is_read_only`, `created_at`, `updated_at`.

**ExternalEvent** — owner: **provider** (Google/Microsoft); PostgreSQL holds a projection
`id` (local UUID), `user_id`, `calendar_source_id`,
`external_event_id` (+ `external_recurrence_id` for series instances),
`provider`, `etag_or_change_key` (provider version), `ical_uid`,
`summary`, `description`, `location`, `start_at`, `end_at`, `is_all_day`,
`time_zone`, `recurrence_rule` (projection of provider data), `status`,
`is_owned_by_atlas` (false until Stage C creates it), `last_synced_at`,
`deleted_at`.

> The projection is never authoritative for externally owned events. Writes route through the
> provider adapter.

> **Implemented (M5-06, ADR-0029).** Table `external_events`, model `atlas.models.ExternalEvent`.
> Until `CalendarSource` exists (M5-05), the projection keys on the provider's **calendar id**
> directly rather than a `calendar_source_id` FK, and stores exactly the neutral-event fields:
> `provider`, `external_event_id`, `calendar_id`, `summary`, `start_at`/`end_at`,
> `time_zone` (IANA), `is_all_day`, `status`, `etag` (the documented version token),
> `ical_uid`, `recurrence_id`, `recurrence_rule`, `source_updated_at` (the provider's
> last-modified instant), `last_synced_at`, `deleted_at` and the timestamps. It is **unique per
> `(user_id, provider, external_event_id)`**. A provider deletion is applied as a **tombstone**
> (`deleted_at`) — never a hard delete — and re-seeing the event clears it. (`description`/
> `location`/`is_owned_by_atlas` are not stored until a later milestone needs them.)

**SyncCursor** — owner: PostgreSQL
`id`, `calendar_source_id`, `cursor_type` (`sync_token`|`delta_link`|`history_id`),
`cursor_value`, `last_success_at`.
> Advanced only after the corresponding changes are committed. Never advanced in a way that
> can skip unprocessed changes.

> **Implemented (M5-06, ADR-0029).** Table `sync_cursors`, model `atlas.models.SyncCursor`, keyed
> **unique per `(user_id, provider, calendar_id)`** (the provider calendar id, until
> `CalendarSource` exists). It stores `cursor_type`, `cursor_value` (nullable — the row may exist
> recording an error before the first successful baseline), `last_success_at`, and the diagnostic
> `last_error`/`last_error_at`. `CalendarSyncService` applies a pass's changes **and** advances the
> cursor in **one transaction**, committing once, so a failure between apply and commit leaves the
> cursor unchanged and a re-sync skips nothing (`CALENDAR_SYNC.md` §4, AGENTS.md §10); the value is
> persisted verbatim from the adapter's final page only. The error columns never carry event
> contents.

**ChangeNotificationSubscription** — owner: PostgreSQL
`id`, `calendar_source_id`, `provider`, `subscription_id`, `resource`,
`expires_at`, `client_state_hash`, `created_at`.

### 2.5 Sync, jobs and notifications

**ChangeLog** — owner: PostgreSQL
`user_id`, `entity_type`, `entity_id`, `operation` (`upsert`|`delete`), `seq`, `changed_at`.
> The durable store behind the per-user change feed `GET /api/changes` (M7-01, ADR-0032). One row per
> changed entity, keyed `(user_id, entity_type, entity_id)`: `operation` is `upsert` (created or
> updated) or `delete` (a soft-delete tombstone), and `seq` is a monotonic per-user cursor allocated
> from `users.change_seq` in the same transaction as the mutation. An entity changed twice between
> two pulls appears once, at its latest cursor.
> **Retention (M7-02, ADR-0033; scope changed by SYNC-03e, ADR-0059 D2).** A durable `changes.purge` job
> removes **`delete` rows** older than `change_retention_days` (default **90**, minimum 30; ADR-0033 said
> 30 days and purged every row) and raises `users.change_purge_floor` to the highest cursor it removed.
> `upsert` rows are never purged, so the log stays one row per existing entity. It never deletes the
> user's entity rows - a soft-deleted task/project/note stays a tombstone in its own table. A client
> whose `0 < since < floor` is answered `resync_required = true` (not a partial feed) and must resync,
> so a purged deletion can never be resurrected; `since = 0` is a snapshot and is always served (also
> `snapshot=true` continuation pages). The same job deletes `idempotency_keys` older than the same
> window. See §5.

**SyncResolution** — owner: PostgreSQL (SYNC-05, ADR-0059 D7, ADR-0061; migration `f4a8b2c6d1e3`)
`id`, `user_id` (`users.id ON DELETE CASCADE`), `entity_type` (`task`|`project`|`note`), `entity_id`, `rule`
(`simple_later_wins`|`edit_wins_over_delete`|`note_merged`|`path_collision`|`path_later_wins`|`undo`; a check constraint),
`field` (the simple field decided; `path` for a note move), `kept_revision` (the revision the winning write produced; for
`note_merged` the revision whose text was merged into), `loser` (JSONB `{"value": ...}` or `NULL`: the overwritten value of a
simple field, at most 4 096 bytes; for `undo` the value it replaced), `detail` (paths only, at most 2 048 characters),
`device_id` (`devices.id ON DELETE SET NULL`: the device that sent the write, `NULL` for a browser session; SYNC-06), `op_key` + `ordinal` (the `Idempotency-Key` of the causing request and
the entry's position in it; **unique** per user when `op_key` is set), `undoes_id` (`sync_resolutions.id ON DELETE SET NULL`,
**unique**: one undo entry per resolution), `undone_at`, `undone_by` (`ON DELETE SET NULL`), `created_at`.
> The automatic-decision log of sync-mode writes. Rows are inserted in the same transaction as the write that caused them and
> announced as feed entity `resolution` (state 1, or 2 once undone). **Never holds text**: task/project text and note content are
> not copied; text and note decisions point to history or the conflict copy. Not an entity of its own history: no tombstone; the
> hourly `changes.purge` job deletes rows older than `change_retention_days` (default 90) together with their `change_log` rows,
> never an entity. It is a table of the one database, so every backup contains it and a restore brings it back with the entities
> it describes. A refused stale delete is not logged (nothing was written). Indexes: `(user_id, created_at, ordinal, id)` for the newest-first
> list, `(user_id, entity_id)`, `created_at` for the purge.

**InstanceMeta** — owner: PostgreSQL (SYNC-03b)
`key` (pk), `value`. One row, `epoch`: a UUID created by the migration that names this database's
history for sync clients (ADR-0059 D9/D12); rotated by `atlas-admin record-restore` after a restore.
It is not truncated by tests and is restored with the database.

**Job** — owner: PostgreSQL (durable queue)
`id`, `queue`, `task_name`, `payload` (jsonb), `status`
(`pending`|`running`|`succeeded`|`failed`), `priority`, `run_at`, `attempts`,
`max_attempts`, `locked_by`, `locked_at`, `last_error`, `idempotency_key`,
`created_at`, `updated_at`.

**ReminderPolicy** — owner: PostgreSQL (M8-01)
`id`, `user_id`, `name`, `days_before` (whole days before the due calendar day), `at_time`
(local wall-clock time of day), `created_at`, `updated_at`. Unique per `(user_id, name)`.
`tasks.reminder_policy_id → reminder_policies.id ON DELETE SET NULL`: a task with no policy has no
reminder, and deleting a preference never deletes a task.

**Reminder** — owner: PostgreSQL (M8-01)
`id`, `user_id`, `policy_id` (`reminder_policies.id ON DELETE SET NULL`), `entity_type`
(`task`|`event`), `entity_id`, `remind_at` (UTC), `status`
(`scheduled`|`sent`|`cancelled`|`failed`), `attempts`, `last_attempt_at`, `created_at`, `updated_at`.
Unique per `(entity_type, entity_id)` — one reminder per entity, so a reschedule edits the row in
place rather than piling up duplicates. `remind_at` is the fire instant: the policy's local
wall-clock is interpreted in the entity's IANA zone and stored UTC (ADR-0014, ADR-0037).

**ReminderDelivery** — owner: PostgreSQL (M8-01)
`id`, `reminder_id` (`reminders.id ON DELETE CASCADE`, **unique**), `channel`, `delivered_at`,
`detail`, `created_at`, `updated_at`. The unique `reminder_id` permits at most one delivery record per
reminder: it is written in the same transaction that marks the reminder `sent`, so a retried or
restarted delivery job finds it and does nothing — a fired reminder is never delivered twice.

**NotificationDevice** — owner: PostgreSQL
`id`, `user_id`, `platform` (`web`|`ios`|`android`|`desktop`), `push_token`
(encrypted), `created_at`, `last_seen_at`, `invalidated_at`.

## 3. Relationships (summary)

```
User 1─* Notes(metadata) 1─* NoteLink *─1 Note
User 1─* Task *─1 Project ; Task 1─* Task (subtasks) ; Task *─* Note (TaskLink)
User 1─* Note *─* Project (NoteProject, keyed on the note's stable id)
User 1─* CalendarAccount 1─* CalendarSource 1─* ExternalEvent
CalendarSource 1─1 SyncCursor ; CalendarSource 1─* ChangeNotificationSubscription
User 1─* ChangeLog ; User 1─* Job (via payload)
User 1─* ReminderPolicy ; User 1─* Reminder 1─1 ReminderDelivery ; Task *─1 ReminderPolicy
User 1─* NotificationDevice
```

## 4. Time, Recurrence and Time Zones

- All storage is UTC (`timestamptz`); display converts to the relevant IANA zone.
- Where a wall-clock interpretation matters (recurrence, all-day events), store the IANA zone
  alongside the instant.
- Recurrence follows RFC 5545 RRULE semantics (via a maintained library; see `DECISIONS.md`).
- Daylight-saving transitions are covered by explicit tests (`TESTING.md`).

## 5. Deletion Semantics

- Structured entities: soft delete (`deleted_at`) + a `delete` ChangeLog entry. Deletions propagate
  to offline clients: the per-user change feed (`GET /api/changes`, M7-01) returns `delete`
  tombstones, and the M3-09 task pull (`GET /api/tasks/changes`) returns tombstoned tasks. A
  soft-deleted entity's row is **never** hard-deleted by retention — it stays a tombstone in its own
  table (task/project/note). Only the `change_log` feed history is bounded: a durable purge removes
  entries older than the retention window (default 30 days, ADR-0033), and a client whose cursor
  predates the purge floor is told to full-resync, so a deletion can never be resurrected. A delete
  is always observable while its tombstone is within the window.
- Project tombstones never remove work: deleting a project un-files its live tasks (`project_id` →
  NULL, `revision` bumped) so clients see an ordinary update, and already-tombstoned tasks are left
  alone (ADR-0021, §2.3). The `tasks.project_id → projects.id ON DELETE SET NULL` key covers the
  hard-delete paths.
- Notes: deletion moves the file to a recoverable location (not `rm`) and records a tombstone;
  behavior detailed in `MARKDOWN_STORAGE.md`.
- Note↔project links (`note_projects`) are a pure association: deleting a note or a project (a soft
  delete) removes the link rows in the same transaction, so no dangling reference survives; the
  `note_id`/`project_id` foreign keys' `ON DELETE CASCADE` covers the hard-delete paths (ADR-0024).
  A note's *wiki* links (`NoteLink`) are unaffected and unrelated.
- Daily notes and templates (MU-07, ADR-0049) add **no table**: `daily/<YYYY-MM-DD>.md` and `templates/*.md` are
  ordinary notes in `notes` and on disk; the daily note for a day is found by its path.
- Task↔note links (`task_links`, MU-06, ADR-0048) reference the note's stable id and are created only by
  "create task from note". Unlike `note_projects`, the rows of a soft-deleted task or note are **kept** and
  hidden by the listings, so restoring either restores the link; hard deletes cascade. Index
  `ix_task_links_note_id` serves "tasks of a note". Each change is recorded as `task_note_link`.
- External events: a provider deletion removes/marks the projection; the projection is never
  re-created from stale local data.

## 5a. Reminder feed state and sync hints (M8-04a/e, 2026-11-09)

- `reminders` gained `state` (`armed|cancelled`, the device-visible state; `status` stays the server's delivery bookkeeping and is never shown to devices), `revision` (+1 on any change of state, `remind_at`, `snoozed_until`, `acknowledged_at`), `snoozed_until`, `acknowledged_at` (migration `d3a5c8e1b7f2`, reversible, with a backfill of one `reminder` `change_log` row per existing reminder). Written only through `atlas/reminders/service.py::publish`, under the user-then-reminder lock order; the feed entry is recorded in the same transaction and only when a value moved. Rows are never deleted by the feed: `cancelled` is the tombstone.
- `users.home_time_zone` (nullable IANA name): the zone for tasks without `time_zone`.
- `device_hints` (migration `e5b8f2a4c1d9`): one row per device, cascade-deleted, endpoint encrypted (AES-GCM, AAD = device id), `endpoint_tail`, delivery diagnostics, `invalid_at`. Also deleted when the device is revoked.

## 6. Ownership Rules (restated for implementers)

1. Markdown files own note content. PostgreSQL owns only metadata.
2. Providers own external events. PostgreSQL owns projections and mappings.
3. Atlas owns its tasks, projects and preferences.
4. Provider mappings and sync cursors are owned by PostgreSQL and advance only after successful
   processing.

## 7. Open Items

- **Local-first sync additions:** done - `field_revisions` on tasks and projects (SYNC-03), the partial unique index on live note
  paths (SYNC-03), tombstone-only change-log retention (SYNC-03), `note_revisions` plus the history files (SYNC-04), `sync_resolutions` (SYNC-05). Still to
  come: `revision` on reminder policies and preferences, `devices` (SYNC-06). Shapes and rules:
  [`SYNC_PROTOCOL.md`](SYNC_PROTOCOL.md); decisions: ADR-0059, ADR-0060.

- Board column model vs. task status mapping to be finalised in M4.
- `external_id` task-provider mapping deferred until external task providers are in scope.
- Retention window for change-feed tombstones — **settled in M7-02, changed in SYNC-03e**: a configurable
  window (`change_retention_days`, default 90 days, minimum 30) for tombstones only, with a per-user purge
  floor and a resync signal (ADR-0033 as amended by ADR-0059 D2). Entity tombstones remain in their own tables and are never purged.


## 12. Calendar Stage A tables (implemented 2026-11-10, migration `a6c3e9d27b14`, ADR-0071/0072)

- **`calendar_sources`** (owner: PostgreSQL; unique `(user_id, provider, external_id)`): one displayable calendar. `provider` = `google` | `microsoft` | `ics`; `external_id` = the provider's calendar id, or the row id for a feed; `name`, `color` (palette key `1`-`8`), `time_zone`, `is_read_only`, `is_primary`, `selected` (shown **and** synced). Feed rows also hold `feed_url_ciphertext`/`feed_url_key_id` (AES-GCM, AAD = user + row id) and `feed_url_display` (masked). Cascades with the user. Disconnect or feed removal deletes the rows with their projected events and cursors.
- **`oauth_states`**: `state_hash` (unique SHA-256), `session_hash`, sealed PKCE verifier, `redirect_uri`, `expires_at`, `used_at`; rows older than 24 h are deleted when a flow starts.
- **`provider_credentials.needs_reauth_at`**: set when the provider rejected the stored sign-in; cleared by a new connect.
- **`external_events`** gained `location`, `description`, `web_link`, `series_id` (the master's `external_event_id` for an exception/override; `recurrence_id` is the occurrence's original start as `YYYYMMDDTHHMMSSZ`) and the index `ix_external_events_user_range`. `external_event_id` is `sha256(calendar_id)[:12]:provider-id`; `recurrence_rule` holds `RRULE:`/`EXDATE:`/`RDATE:` lines (instants in UTC) for Google/ICS masters; Microsoft occurrences arrive expanded and have none. All-day events store local-midnight instants plus the event's `time_zone`; the API derives the dates.
- Cursor types: `sync_token` (Google), `delta_link` (Microsoft, `window_end|deltaLink`), `feed_validator` (ICS, JSON of ETag/Last-Modified/body hash).
