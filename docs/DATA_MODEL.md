# Atlas — Data Model

**Status:** Draft for approval (Milestone 0)
**Last updated:** 2026-10-20

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
`updated_at`, `is_active`.

**Session** — owner: PostgreSQL
`id`, `user_id`, `token_hash`, `created_at`, `expires_at`, `revoked_at`,
`user_agent`, `ip_hash`.

**OAuthCredential** — owner: PostgreSQL (encrypted)
`id`, `user_id`, `provider` (`google`|`microsoft`), `encrypted_refresh_token`,
`encrypted_access_token` (optional), `access_expires_at`, `scopes`, `created_at`,
`updated_at`, `revoked_at`.

> Refresh/access tokens are encrypted at rest with a key held outside the database.

### 2.2 Notes (metadata only — content lives on disk)

**NoteIndex** — owner: PostgreSQL (metadata); content owner: filesystem
`id`, `user_id`, `path` (relative to notes root, unique per user), `title`,
`content_hash` (e.g. SHA-256 of file bytes), `revision`, `size_bytes`,
`created_at`, `updated_at`, `deleted_at`.

> Authoritative content is the `.md` file. `content_hash`/`revision` detect stale writes and
> external edits. See `MARKDOWN_STORAGE.md`.

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

**RecurrenceSeries** — owner: PostgreSQL
`id`, `rule` (RRULE), `dtstart`, `time_zone`, `end_date`, `count`,
`recurrence_parent_id` (points at the task acting as the series head).

> Completing an occurrence completes only that occurrence and generates the next one. It never
> completes the whole series.

**TaskLink** (task ↔ note) — `task_id`, `note_id`, `created_at`.
Survives note renames by referencing the stable note id, not the path.

**Tag assignment** — `TaskTag(task_id, tag_id)`.

**Project** — owner: PostgreSQL
`id`, `user_id`, `name`, `description`, `status`, `start_date`, `target_date`,
`revision`, `created_at`, `updated_at`, `deleted_at`.

**BoardColumn** — owner: PostgreSQL
`id`, `project_id`, `name`, `position`, `maps_to_status`.

> Progress is **derived**, not stored: `completed_tasks / total_tasks`, excluding archived,
> with the formula documented in `PRODUCT_SPEC.md`/implementation and covered by tests.

### 2.4 Calendar (projections and mappings)

**CalendarAccount** — owner: PostgreSQL
`id`, `user_id`, `provider`, `account_label`, `external_account_id`,
`credential_id` (→ OAuthCredential), `created_at`, `disconnected_at`.

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

**SyncCursor** — owner: PostgreSQL
`id`, `calendar_source_id`, `cursor_type` (`sync_token`|`delta_link`|`history_id`),
`cursor_value`, `last_success_at`.
> Advanced only after the corresponding changes are committed. Never advanced in a way that
> can skip unprocessed changes.

**ChangeNotificationSubscription** — owner: PostgreSQL
`id`, `calendar_source_id`, `provider`, `subscription_id`, `resource`,
`expires_at`, `client_state_hash`, `created_at`.

### 2.5 Sync, jobs and notifications

**ChangeLog** — owner: PostgreSQL
`id`, `user_id`, `entity_type`, `entity_id`, `operation` (`create`|`update`|`delete`),
`revision`, `changed_at`.
> Backs incremental client pulls: "all changes after revision N". Deletes appear as tombstone
> events.

**Job** — owner: PostgreSQL (durable queue)
`id`, `queue`, `task_name`, `payload` (jsonb), `status`
(`pending`|`running`|`succeeded`|`failed`), `priority`, `run_at`, `attempts`,
`max_attempts`, `locked_by`, `locked_at`, `last_error`, `idempotency_key`,
`created_at`, `updated_at`.

**Reminder** — owner: PostgreSQL
`id`, `user_id`, `entity_type` (`task`|`event`), `entity_id`, `remind_at`,
`status` (`scheduled`|`sent`|`cancelled`|`failed`), `attempts`, `last_attempt_at`.

**NotificationDevice** — owner: PostgreSQL
`id`, `user_id`, `platform` (`web`|`ios`|`android`|`desktop`), `push_token`
(encrypted), `created_at`, `last_seen_at`, `invalidated_at`.

## 3. Relationships (summary)

```
User 1─* Notes(metadata) 1─* NoteLink *─1 Note
User 1─* Task *─1 Project ; Task 1─* Task (subtasks) ; Task *─* Note (TaskLink)
User 1─* CalendarAccount 1─* CalendarSource 1─* ExternalEvent
CalendarSource 1─1 SyncCursor ; CalendarSource 1─* ChangeNotificationSubscription
User 1─* ChangeLog ; User 1─* Job (via payload) ; User 1─* Reminder 1─* delivery attempts
User 1─* NotificationDevice
```

## 4. Time, Recurrence and Time Zones

- All storage is UTC (`timestamptz`); display converts to the relevant IANA zone.
- Where a wall-clock interpretation matters (recurrence, all-day events), store the IANA zone
  alongside the instant.
- Recurrence follows RFC 5545 RRULE semantics (via a maintained library; see `DECISIONS.md`).
- Daylight-saving transitions are covered by explicit tests (`TESTING.md`).

## 5. Deletion Semantics

- Structured entities: soft delete (`deleted_at`) + a `delete` ChangeLog entry.
- Notes: deletion moves the file to a recoverable location (not `rm`) and records a tombstone;
  behavior detailed in `MARKDOWN_STORAGE.md`.
- External events: a provider deletion removes/marks the projection; the projection is never
  re-created from stale local data.

## 6. Ownership Rules (restated for implementers)

1. Markdown files own note content. PostgreSQL owns only metadata.
2. Providers own external events. PostgreSQL owns projections and mappings.
3. Atlas owns its tasks, projects and preferences.
4. Provider mappings and sync cursors are owned by PostgreSQL and advance only after successful
   processing.

## 7. Open Items

- Board column model vs. task status mapping to be finalised in M4.
- `external_id` task-provider mapping deferred until external task providers are in scope.
- Retention window for tombstones to be set once the maximum offline window is known (M7).
