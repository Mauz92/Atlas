# Atlas — Local-first Sync Protocol

**Status:** design ACCEPTED (ADR-0059, 2026-11-03). **Server protocol v1 is implemented by SYNC-03, SYNC-04, SYNC-05 and SYNC-06 (2026-11-03, local,
not committed, CI not run)** except the parts marked **[PLANNED]** below, which belong to SYNC-08 (clients)
and later tasks. The table "Implementation status" says, section by section, what is behaviour today
and what is still a target; everything else in this file is the contract.
**Scope:** how a local-first client (Tauri desktop, Tauri Android; ADR-0055) and the existing web app keep
tasks, projects, notes and their links converged with the self-hosted server. Calendar-provider sync is
`CALENDAR_SYNC.md`; note file rules are `MARKDOWN_STORAGE.md`; entity fields are `DATA_MODEL.md`.

Legend: **[EXISTS]** verified by reading code/tests on 2026-11-03; **[GAP]** needed by ADR-0055 and missing or
wrong at the time of the analysis (§2 is a historical baseline); **[NEW]** specified; **[DONE]** implemented and tested by
SYNC-03; **[PLANNED]** specified, owned by a later task; **[UNVERIFIED]** not checked.

### Implementation status (SYNC-03 to SYNC-06, 2026-11-03)

| Section | Status | Notes |
|---|---|---|
| §4 feed: `include=data`, `types=`, snapshot at `since=0`, `head`/`floor`, `resync_reason` | **[DONE]** | plus the `snapshot=true` continuation parameter (§4.3a, found by the simulation) |
| §5 retention (upserts kept, tombstones 90 days, floor) and idempotency-key TTL | **[DONE]** | `CHANGE_RETENTION_DAYS` default 90, minimum 30; keys expire with the tombstones |
| §6.1 sync mode: header, required key/base, unknown fields `422`, client ids, `sync` block, `Idempotency-Replayed` | **[DONE]** for tasks, projects, notes | notes: replay returns the summary plus the content from history, see §6.3 |
| §6.2 task/project field merge, edit-wins on `DELETE`, revive on `PATCH` | **[DONE]** | resolutions are returned in the response and (SYNC-05) logged in the same transaction; each carries its log `id` |
| §6.3 note create (client id, collision rename), idempotent note writes | **[DONE]** SYNC-03 | |
| §6.3 note history, `base_hash`, three-way merge, conflict copies, stale-delete `edit_wins`, revive on `PUT`, move rules, portable paths, replay with content, `GET .../history` | **[DONE]** SYNC-04 | ADR-0060; `resolution` objects are logged by SYNC-05 (R-41 closed); `ETag`/`If-None-Match` on `GET /api/notes/{id}` is **not** implemented (not needed by any client yet) |
| §6.4 links, §6.5 ordering | unchanged | |
| §7 resync and restore: server side (`below_floor`, `cursor_ahead`, snapshot, `epoch`, `atlas-admin record-restore`) | **[DONE]** | client behaviour (7.3 shadow walk, 7.4 confirmation, 7.5 storm control) is modelled by the simulation client, **[PLANNED]** in `sync-core` (SYNC-08); per-device rate limits need device ids (SYNC-06) |
| §8 errors | **[DONE]** | `401 unauthenticated`/`token_revoked`/`token_expired`, `403 forbidden_scope`, `429 rate_limited` per device (SYNC-06) |
| §9 resolution log, `resolution` feed entity, list, undo | **[DONE]** SYNC-05 | ADR-0061; table `sync_resolutions`; refused deletes are not logged (nothing was written); `device_id` is filled from SYNC-06 on (`NULL` for a browser session) |
| §10.1 devices | **[DONE]** SYNC-06 | ADR-0065; table `devices`; per-device rate limits are 600 requests and 120 writes a minute; the feed-page (60/min) and snapshot-start (10/hour) limits of §8.3 are **not built** (R-53) |
| §10.2 versioning: `Atlas-Sync`, `426`, `GET /api/instance` `sync` block, `Atlas-Epoch` | **[DONE]** | |
| §11 desktop folder rules | client obligations, **[PLANNED]** SYNC-09 | portable-path check is in `sync-core` (`portable.ts`); the folder watcher/scanner is SYNC-09 |

### Client implementation status (`packages/sync-core`, SYNC-08, 2026-11-04)

| Section | Client | Notes |
|---|---|---|
| §4 pull: pages, `include=data`, `types=`, atomic page+cursor, `snapshot=true` continuation | **[DONE]** | page and cursor commit in one transaction (`engine.ts` `commitPage`) |
| §6.1 sync mode: header, idempotency key from enqueue, frozen base, byte-identical retries, client ids | **[DONE]** | |
| §6.2 task/project: coalescing, chained bases, `409 conflict` and `sync.conflicts` kept as `Problem` data (both versions) | **[DONE]** | field-level overlay in `view.ts`; unsent patches advance their base when no touched field changed |
| §6.3 notes: pinned working copy, `base_hash`, merged/conflict-copy answers, rebase of text typed in flight, portable-path check | **[DONE]** | history reads (`GET .../history`) are not used by the core (the simulation reads them) |
| §7.3 `below_floor` shadow resync | **[DONE]** | entities with pending edits are kept (rule 4) |
| §7.4 `cursor_ahead` / `epoch_mismatch` | **[DONE]** as a state + `confirmRestore()` | never automatic; re-creates lost entities with their ids |
| §7.5 storm control | **[DONE]** | `resyncMinIntervalMs` (default 10 min) |
| §8.1 status mapping: 426, 401/403, 429 + `Retry-After`, 5xx/network, 409 family | **[DONE]** | 426/401/restore are stored halts |
| §8.2 backoff | **[DONE]** | base 2 s, factor 2, cap 5 min, full jitter |
| §9 notices and undo | **[DONE]** | notices stored from the `resolution` feed entity; `undoResolution()`; UI is SYNC-11 |
| §10.2 versioning: `Atlas-Sync`, epoch learned from `GET /api/instance`, `Atlas-Epoch` header | **[DONE]** | `types_synced` backfill for a new entity type is **[PLANNED]** |
| §10.1 device token handling, HTTPS-only | token via `Credentials` port; HTTPS-only in `createFetchTransport` | keystore and sign-in screen: SYNC-09 |

---

## 1. Principles (restating accepted rules this protocol must satisfy)

1. The server orders everything. Order is the per-user cursor `seq` and per-entity `revision`; device clocks
   are never used to decide a winner (ADR-0055 §3). Clocks appear only in display and local reminder times.
2. Every client write is idempotent (client-chosen operation key) and revision-checked.
3. A cursor advances only after the page it points past has been applied durably, in the same local
   transaction as the apply (AGENTS.md §10).
4. Nothing is lost silently: an automatic resolution is logged and undoable; an uncertain merge is a conflict
   that preserves both sides (AGENTS.md §8, §10; ADR-0055 §4).
5. Extend existing endpoints; add a new endpoint only where an existing one cannot carry the semantics.
6. Old clients fail safe: they stop syncing and say why; they never write with unknown semantics.

---

## 2. Baseline and gap analysis (what M7 actually is)

Verified by reading `services/api/atlas/{changes,tasks,notes,projects,idempotency.py,api}` and
`apps/web/src/lib/{syncEngine,offlineQueue,reconciliation,localCache}.ts`. The roadmap's "M7 DONE" is true for
its *buildable* scope; it is not a local-first sync layer.

### 2.1 Summary

| Area | Today [EXISTS] | Needed for ADR-0055 | Severity |
|---|---|---|---|
| Feed integrity for notes | **[FIXED by SYNC-01, 2026-11-03]** (was:  (external edit/add/remove, `POST /api/notes/reconcile`, the `notes.reconcile` job) bumps `revision` and tombstones but **never calls `ChangeRecorder`**; `reindex_note` neither. Edits, new files and removals made on the server filesystem never appear in `/api/changes`.) `NotesReconciler` now records `note` upsert/delete through `ChangeRecorder` in the reconcile transaction, only for rows it changed. **Also fixed by SYNC-03 pre-work (2026-11-03):** a removed file is now tombstoned by the same `NotesService.tombstone_index` as `DELETE /api/notes/{id}`, so its `note_projects` rows are dropped and each removal is announced as a `note_project_link` delete in the same transaction (task-note links stay, as for an API delete). | Every revision bump is recorded | Done |
| Check-then-write race on `base_revision` | **[FIXED by SYNC-03 pre-work, 2026-11-03]** (was R-37: `update` compared `base_revision` against an unlocked read, two concurrent PATCHes with one base both returned 200 with the same revision). Task/project `PATCH` and note `PUT` (and their delete/restore/rename) now take `SELECT ... FOR UPDATE` before the check; loser gets `409` with `current_revision`. Lock order: entity rows (bulk task locks in id order), then the user's change cursor. Residual: task moved into a project that is being deleted (RISKS R-37). | Revision identifies state | Done |
| Server restored from backup | **[FIXED by SYNC-01]** (was: `since > change_seq` returned an empty page with `next_since = since`; the client stayed "up to date"). Now `resync_required=true`, `resync_reason="cursor_ahead"`, `next_since = head`. The client-side handling (§7.4) is still unbuilt; the web engine treats it as any resync. | `resync_required(reason=cursor_ahead)` | Server done; client NEW |
| Client-generated ids | `TaskCreateRequest`, project and note create have **no `id` field**; the server assigns UUIDs; notes are identified on create by *path*. ADR-0055 §3 says this "is already true of the API"; it is not. Idempotency keys cover retries of a create, but an offline client cannot reference an entity it created offline (subtask of a new task, link to a new note) without a temp-id mapping. | Optional client `id` on create, idempotent by id | **High** |
| Field-level merge | `PATCH /tasks/{id}` with `base_revision` rejects *any* mismatch (409); with `base_revision` omitted it overwrites blindly (`TasksService.update`). No per-field change tracking, no base snapshot. | Rules 1–3 of ADR-0055 §4 | **High** |
| Edit vs delete | Updating a soft-deleted task/project/note is `404` (`get` filters `deleted_at`), so the edit is rejected and a delete is never rejected for being stale (`DELETE` takes no revision). ADR-0055 §4 rule 4 says the edit wins. | Opposite behaviour | **High** |
| Note three-way merge | `NotesService.update` compares an integer revision and the file hash, stores only the current content. No history, so no common base exists on the server. `409` → client keeps text / conflict copy (ADR-0054). | Base content for `base_revision`, merge, history | **High** |
| Note content in the sync path | Feed carries `entity_id` + `operation` + `cursor` only; no payload, no revision, no hash. Content via `GET /api/notes/{id}` one by one. | Metadata+hash inline; content on demand | Medium |
| Feed payload | Feed items carry no entity data, so a bootstrap is N+1 GETs (and the M7 client only stores "change metadata", ADR-0035). | `include=data` | Medium |
| Retention / bootstrap | The purge deletes **all** `change_log` rows older than 30 days, upserts included (`ChangePurgeService`, `DELETE … WHERE changed_at < cutoff`), and raises `change_purge_floor` to the highest seq removed. Afterwards `since=0 < floor` ⇒ `resync_required`: **a brand-new device can no longer bootstrap from the feed**, and the client's `fullResync` hook is an optional callback that no production code supplies (`grep fullResync apps/web/src`: only the engine and tests). The task-only `GET /api/tasks/changes` still works from 0, which is a second, overlapping feed. | Snapshot from `since=0`; resync only for real gaps | **High** |
| Entities not in the feed | `reminder_policies` and the per-task reminder override, user preferences, display name, task tags (carried inside the task, fine), calendar projections, folders. `task_note_link` is recorded; `note_project_link` is recorded. | Policies and preferences yes; calendar read-only later; empty folders no | Medium |
| Per-entity revision | `tasks.revision`, `projects.revision`, `notes.revision` (int, +1 per change; notes also +1 on external reconcile, rename, delete, revive). Links have **no** revision and no tombstone row (`note_projects` rows are deleted; the only record of the removal is the `change_log` delete row). | Links: presence set diffed on resync | Low |
| Tombstones | Tasks/projects/notes: soft delete in own table, kept forever. Links: only in `change_log`. | OK; see retention | — |
| Ordering | `users.change_seq` increment takes a row lock held until commit, so seq order = commit order, gap-free. Verified by reading `ChangeRecorder` and ADR-0032; **concurrency under real contention was not exercised by a test** — **now proven by SYNC-01** (`tests/integration/test_change_concurrency.py`: blocking observed in `pg_stat_activity`, rollback leaves no gap, seeded stress with a paging reader; a negative control shows an out-of-band allocator does let a reader skip). The lock also serialises all of a user's mutations, including note writes done while the transaction is open. | Keep | Done |
| Pagination | `limit` 1–500, `has_more`, `next_since`; one row per entity so no duplicates in a page. Sound. | Keep | — |
| Idempotency | `Idempotency-Key` on task/project POST/PATCH/DELETE/restore and `POST /notes/{id}/tasks`; per-user, request-fingerprint checked. **No key on note create/update/move/delete.** Keys are never purged (no job found) — grows unbounded but cannot expire under an offline client. | Keys on every write; TTL ≥ tombstone retention | Medium |
| Client | Browser only. Queue (`offlineQueue.ts`) knows `task` and `project` only; **no production code enqueues**; the UI autosave engines (ADR-0053/0054) are online-only (R-22). `useReconciliation` is mounted only in Settings → Sync. The "cache" holds change metadata, not entities. | Shared sync core with a real local store | **High (by design: ADR-0055 is future work)** |
| Attachments / binary files | `NotesStorage.list_notes` walks only `*.md`; other files in the notes root are ignored (never indexed, never deleted). MARKDOWN_STORAGE §2 allows relative-path attachments, but the server neither stores nor serves them via the API. | Decide (ADR-0059 D10) | Medium |
| Rename / move | `POST /notes/{id}/move` keeps the id, bumps revision, takes **no base revision**; folder rename = N note moves, each recorded. An *external* rename is reconcile's "tombstone old path + new id at new path". Empty folders are not entities and not recorded. `uq_notes_user_id_path` includes tombstones, and `create` revives a tombstone at the same path (same id). | Move as a "simple field"; partial unique index on live paths | Medium |
| Auth for non-browser clients | (baseline, closed by SYNC-06) Cookie session + double-submit CSRF only (`get_current_user`, `CsrfMiddleware`). No bearer/device credential. `notification_devices` is push registry only. In-process, IP-keyed rate limiter (R-SEC-1). | Device credentials | **High** |
| Versioning | None. No protocol/schema negotiation; `GET /api/instance` has app version + migration revision only. | Negotiation | **High** (blocker for shipping a desktop binary) |
| Resolution log | None. | Required by ADR-0055 §4 | Medium |
| Tests | Feed paging/retention/tombstones covered; no multi-client, no fault injection, no concurrency, no restore. M7-06 e2e uses a mocked API. | `TESTING.md` §10 | **High** |

### 2.2 Conflict policy (ADR-0055 §4) — what the server enforces

| Rule | Enforced today? | Missing |
|---|---|---|
| 1. Different fields of a task merge | **No** (any stale `base_revision` → whole-request 409) | per-field change tracking |
| 2. Same simple field: later in server order wins, loser logged, undo | **No** | field tracking, resolution log, undo |
| 3. Same text field: keep both and ask | Partly: 409 + client keep-mine/take-server (ADR-0036); no structured per-field answer | structured conflict body |
| 4. Edit vs delete: edit wins | **No** (opposite; §2.1) | revive-on-edit, delete requires base |
| 5. Notes: three-way merge, else conflict copy | Conflict copy yes (`POST /notes/{id}/conflict`, ADR-0054); **merge no** | history, merge, `merged` result |
| 6. Calendar events stay with the provider | Yes by construction (projection is read-only) | — |
| Every automatic resolution logged | n/a (none exist) | `sync_resolutions` |

---

## 3. Entities in scope

| `entity_type` | Source | Revision | Tombstone | Payload in feed (`include=data`) | Status |
|---|---|---|---|---|---|
| `task` | PostgreSQL | `revision` | `deleted_at` | TaskOut fields + `tags` + `field_revisions` | [EXISTS] id; payload NEW |
| `project` | PostgreSQL | `revision` | `deleted_at` | ProjectOut fields (no derived progress) | same |
| `note` | file + index | `revision`, `content_hash`, `size_bytes` | `deleted_at` | metadata only: `path`, `title`, `revision`, `content_hash`, `size_bytes` | same |
| `note_project_link`, `task_note_link` | PostgreSQL | none | feed `delete` row only | ids | [EXISTS] |
| `reminder_policy` | PostgreSQL | add `revision` | hard delete → feed `delete` | fields | [NEW] |
| `preferences` (one per user: reminder default, display name, time zone when it exists) | PostgreSQL | add `revision` | none | fields | [NEW] |
| `resolution` | PostgreSQL | 1, 2 once undone (a state number, no entity revision) | none (purged with its feed row) | §9 record | **[DONE]** SYNC-05 |
| calendar `external_event` | provider | — | `deleted_at` | — | **Out of v1**: calendar views stay online-only on local-first clients (ADR-0059 D10) |
| note attachments, empty folders | — | — | — | — | **Out of v1** (D10) |

Derived data (progress, `due_state`, subtask rollups, search vectors, backlinks, `NoteLink`, note tags) is
**not synced**; each client recomputes it or asks the server when online.

---

## 4. Pull: `GET /api/changes` (extended)

Existing parameters `since`, `limit` keep their meaning. [NEW] parameters, all optional so current callers
are unaffected:

| Parameter | Meaning |
|---|---|
| `include=data` | Each item gets `revision` and `data` (current entity state as of the read; tombstones carry `deleted_at`). `limit` max 200 in this mode. |
| `types=task,project,…` | Only these entity types are returned. The cursor still advances over filtered-out items (the last page reports `head` as `next_since`). An unknown type name is `422`. The client lists the types it understands; see §10 for why. `resolution` (SYNC-05, §9) is part of the default set only in sync mode. |
| `snapshot=true` | Sent on every page of a snapshot walk after the first (§4.3a). |

Response (additions in bold): `changes[] {entity_type, entity_id, operation, cursor, changed_at, **revision?**, **data?**}`,
`since`, `next_since`, `has_more`, `resync_required`, **`resync_reason?`** (`below_floor` | `cursor_ahead`),
**`head`** (current `users.change_seq`), **`floor`** (highest purged tombstone cursor, 0 if none).
`next_since` of the last page (`has_more=false`) is `max(last cursor, head read at the start of the page)`: rows a `types=`
filter skipped are considered, and a row committed while the page was built is delivered by the next page, never skipped.

Semantics:

1. **Total order.** Items are ordered by `cursor` (unique per user, assigned under the user-row lock, gap-free
   because a rolled-back transaction rolls the counter back). Verified by reading; to be proven by SYNC-01's
   concurrency test.
2. **State-based, not log-based.** One item per entity at its latest cursor. `data` is read at response time and
   may be newer than `cursor`; the entity then appears again later with a higher cursor and the same or newer
   `revision`. Clients apply by revision: `incoming.revision <= local_server_revision` ⇒ no-op.
3. **`since = 0` is a snapshot** [DONE, changes ADR-0033]: its first page returns live entities (upserts) and **no**
   tombstones, because a client with no state has nothing to delete. This requires that `upsert` rows are never
   purged (§5). A device bootstraps by paging from `0` to `has_more=false`; no separate bootstrap endpoint. Later pages
   (`since > 0`) are ordinary: they also carry the deletions that happened during the walk (an entity delivered live
   on page 1 and deleted before page 3 reappears as a `delete`), which a client with no copy of that entity ignores.
   3a. **A snapshot walk is never "below the floor".** Page 2 of a walk is at `0 < since`, and once the floor has risen above
   that cursor a plain request would be `resync_required(below_floor)`: the walk would restart from 0 forever. Found by
   simulation seed 29 (SYNC-03e). A client therefore sends `snapshot=true` on every page after the first; the floor check is
   skipped for such a request (cursor-ahead is not). This is safe because the walk holds nothing from before it began and a
   deletion made during the walk is recent, hence retained.
4. **Snapshot under concurrent writes.** An entity changed during the walk moves to a higher cursor and is
   delivered again before the client reaches `head`; so "walk until `has_more=false`" is complete.
5. **Cursor ahead** [NEW]: `since > head` ⇒ `resync_required`, `resync_reason=cursor_ahead` (server restored from
   an older backup, or a different server). Client behaviour in §7.4.
6. **Apply atomically.** The client writes the page's entities and the new cursor in **one local transaction**.
   A crash re-delivers the page.
7. **No foreign keys on the client** between synced entities; a task may reference a project that arrives in a
   later page.

## 5. Retention [DONE, supersedes ADR-0033's purge scope (ADR-0059 D2 accepted)]

- `change_log` keeps **one row per entity** for as long as the entity exists, so upsert rows are bounded by the
  number of entities and are never purged.
- Only `delete` rows older than `change_retention_days` (default **90**, configurable, ≥ 30; the setting kept its name) are
  purged; `change_purge_floor` is raised to the highest purged tombstone seq. Idempotency keys older than the same window are
  deleted by the same job, so a retried write finds its key for as long as a tombstone is retained.
- A client with `0 < since < floor` gets `resync_required (below_floor)`. A client with `since = 0` is always served.
- Entity tombstones in their own tables are never purged (unchanged).

## 6. Push: existing write endpoints in *sync mode* [NEW]

A client opts in per request with the header `Atlas-Sync: 1` (the protocol major, §10). Without it every
endpoint behaves exactly as before (the web app is unaffected; its only visible differences are additive response fields and the
snapshot/retention changes of §4/§5). In sync mode:

### 6.1 Common

- `Idempotency-Key: <uuid>` is **required** on every write (note create / update / move / delete included, SYNC-03c). Same key + same body ⇒ the stored response is replayed (`Idempotency-Replayed: true`). Same
  key + different body ⇒ `409 idempotency_mismatch` (a client bug; do not retry). Keys are retained for at least
  the tombstone retention (job to add; today none expires).
- `base_revision` is **required** on update / delete / move (today optional ⇒ blind overwrite).
- Creates accept an optional client `id` (UUID; version 4 or 7). Same `id` + same body ⇒ replay; same `id` +
  different body ⇒ `409 id_exists`; an `id` owned by another user ⇒ `409 id_exists` (no disclosure). Without `id`
  the server assigns one as today.
- Every write response adds `sync: {revision, resolution: Resolution[], conflicts: Conflict[]}` (`null` outside sync mode); a
  merged or auto-resolved write returns the full resulting entity so the client can replace its base. `Resolution` is
  `{id, rule, field?, kept_revision?, loser?, detail?}` and, since SYNC-05, is also a row of the resolution log (section 9; `id` is the entry; `null` only in an error body such as `409 edit_wins`, where nothing was written). `Conflict` is
  `{field, reason: text_conflict|invalid_transition, server_revision, server_value}`.
- Errors use `{error: <code>, detail, current_revision?, conflicts?, entity?, resolution?}`. Codes in §8. Implemented codes:
  `idempotency_key_required`, `base_revision_required`, `unknown_fields` (`fields`), `idempotency_mismatch`, `id_exists`,
  `stale` (also: a base from the future), `conflict`, `edit_wins`, `not_found`, `path_exists`, `sync_version_unsupported`,
  `epoch_mismatch`; notes (SYNC-04): `base_hash_required`, `invalid_path` (`reason`), `note_deleted`, and `conflict` with
  `reason` and `conflict_copy` (below). Validation errors other than the above keep the framework's `422`/`400` bodies.
- `DELETE` carries its base as the query parameter `base_revision` (it has no body). `Idempotency-Replayed: true` marks a replay.
- Creates also accept `id` outside sync mode (additive; the web app does not send it). Replay by id is recognised only for an
  *untouched* entity (revision 1, live, equal fields): once edited, the original result cannot be reconstructed and the id is
  simply taken (`409 id_exists`); a deleted entity keeps its id reserved. An id owned by another user answers exactly like a
  taken one.

### 6.2 Tasks and projects (field-level merge)

Column `field_revisions jsonb` on `tasks` and `projects` [DONE]: `{field: revision at which the field last changed}`
(fields are the writable columns plus `tags`). Maintained by the service on every write; backfilled to the
current `revision` for existing rows (so an old base never merges silently across a pre-migration change). Every write path
stamps the fields whose value actually changed, including server-side effects (`completed_at` with `status`, `project_id` when a
project is deleted or a deleted task returns into a deleted project, `parent_task_id` when a parent is deleted); a task created by
recurrence starts with every field at revision 1. A field with no stamp counts as changed *now*, so a missing history can only
produce a conflict, never a silent merge. `tags` is one field, compared as a case-insensitive set.

`PATCH` body in sync mode carries **only the fields the client changed** plus `base_revision`. For each field
`f`:

1. `field_revisions[f] <= base_revision` — nobody changed `f` since the client's base → apply.
2. else if the stored value equals the incoming value → no-op.
3. else a genuine concurrent change of `f`:
   - **simple field** (`status`, `priority`, `project_id`, `parent_task_id`, `due_at`, `start_at`, `time_zone`,
     `duration_minutes`, `recurrence_rule`, `tags`, project `status`/`target_date`/`start_date`): the incoming
     value wins (it arrives later in server order); write a `resolution` (rule `simple_later_wins`) holding the
     overwritten value; apply. If the result violates the status state machine (`validate_transition`), the field
     is **not** applied and the field is returned in `conflicts` with `reason=invalid_transition` (server value
     kept, client shows "changed on another device") — an LWW result may never produce an invalid state.
   - **text field** (`title`, `description`, project `name`/`description`): not applied; returned in
     `conflicts` as `{field, server_value, server_revision}`; the response is `409 conflict` only if **no** field
     was applied, otherwise `200` with `sync.conflicts` listing the rest. Other fields in the same PATCH are
     still applied (rule 1: different fields merge).
4. Applying any field bumps `revision` once for the request and stamps `field_revisions[f] = new revision`.

`DELETE` in sync mode: if `base_revision < revision` the task was edited after the client's base ⇒ **rule 4:
the edit wins**; the delete is refused with `409 edit_wins` and a `resolution` (`edit_wins_over_delete`) is
logged; the response carries the live entity. A delete of an already-deleted task is an idempotent `204`.

`PATCH` of a tombstoned task: the task is **restored** with the incoming fields applied (equivalent to
`POST …/restore` + patch), `resolution` `edit_wins_over_delete`, one revision bump. (Project soft-delete
un-files tasks; restoring a project does not re-file them — the client's change to `project_id` is an ordinary
field edit.)

Recurring completion on two devices: the second `status → completed` is a no-op (value equal), and
`_advance_series` already refuses to create a duplicate occurrence (`_occurrence_exists`); covered by a
simulation scenario, not assumed.

### 6.3 Notes

**SYNC-03** delivered identity, create, idempotent writes and the live-path index; **SYNC-04** delivers content: history,
`base_hash`, the three-way merge, conflict copies, edit-wins, revive, move rules, portable paths and replay with content. In sync
mode a note write needs an `Idempotency-Key`; `PUT` needs `base_revision` **and** `base_hash` (`422 base_hash_required`);
`move`/`DELETE` need `base_revision`; unknown body fields are `422`. A path taken by a live note (or differing from one only by
case or Unicode normalisation) becomes `name (2).md` on create with a `path_collision` entry in `sync.resolution`. A create with a
client `id` is always a new row (the partial unique index `uq_notes_user_id_path_live`, D3, lets it share a path with a
tombstone), while a create without one still revives a tombstone at that path under its old id (task links come back).

Identity: the note `id` (client-generated allowed) is the identity; `path` is a mutable simple field.

| Operation | Endpoint (existing) | Sync-mode behaviour |
|---|---|---|
| Create | `POST /api/notes` `{path, content, id?}` | `id`; path taken ⇒ `name (2).md` + `path_collision`; path not portable ⇒ `422 invalid_path` |
| Content update | `PUT /api/notes/{id}` `{content, base_revision, base_hash}` | merge below; response = the note with the resulting `content`, `sync.merged` |
| Move / rename | `POST /api/notes/{id}/move` `{path, base_revision}` | independent of content (a stale revision does not reject a move; a base from the future is `409 stale`); target taken (case and normalisation included) ⇒ `409 path_exists`; another device already moved it ⇒ later wins, `path_later_wins`; a deleted note ⇒ `409 note_deleted` (a rename alone does not bring a note back) |
| Delete | `DELETE /api/notes/{id}?base_revision=` | stale ⇒ `409 edit_wins` with the live note's summary (rule 4); deleting a deleted note is `204`; the file moves to `.atlas/trash` as always |
| Edit of a deleted note | `PUT` | revive (rule 4): the text is merged into the note's last text, restored at its old path (`name (2).md` + `path_collision` if taken), `edit_wins_over_delete` |
| Read | `GET /api/notes/{id}` | unchanged |
| History | `GET /api/notes/{id}/history`, `GET /api/notes/{id}/history/{revision}` | list (newest first, `available`) and read retained revisions; deleted notes included (recovery); another user's note is `404` |

**Three-way merge** (`PUT` in sync mode), under the note's row lock, so two saves from one base are strictly ordered:

1. A note deleted earlier is revived first (below). A `base_revision` above the note's is `409 stale`.
2. An edit made on the server's file system and not yet reconciled is taken as a revision now (it is what reconcile would do), so
   the merge sees it and history holds it.
3. `base_revision == revision`: `base_hash` must be the note's hash, else `conflict (base_unavailable)`. Same text ⇒ no-op, no
   revision bump; otherwise an ordinary write.
4. `base_revision < revision`: the retained text of `base_revision` is read from history and its hash **must equal `base_hash`**;
   a base that is not retained, damaged or different ⇒ `conflict (base_unavailable)`. Never merged on a guess.
   - client text equals the base (nothing changed) ⇒ `200`, no bump, `sync.merged` iff the current text differs from what the
     client holds;
   - `merge3(base, current, incoming)` (`MARKDOWN_STORAGE.md` section 4a) clean and different from the current text ⇒ written as
     the next revision (reason `merge`), `200`, `sync.merged = true` iff the result differs from the incoming text,
     `sync.resolution = [{rule: note_merged, kept_revision}]`; clean and equal to the current text ⇒ `200`, no bump;
   - not clean (overlap, front matter that would be assembled from two sides, too large) ⇒ **conflict**.
5. **Conflict** (`409`, `error: conflict`): *nothing is applied to the note*; the **incoming text is saved as a conflict copy**
   `<name> (conflict YYYY-MM-DD HHMMSS).md` beside it (a new note, announced on the feed like any create) and the body says so:
   `{error, detail, reason: overlap|base_unavailable|front_matter|too_large, current_revision, current_hash, conflicts:
   [{field: "content", reason: "text_conflict", server_revision}], conflict_copy: {id, path, revision, content_hash}}`. The copy is
   a side effect, so the answer is stored under the idempotency key: a retry replays the same `409` and the same copy, never a
   second one. The client keeps no local state for that edit except the pointer to the copy; the note shows the server's text and
   the copy is the resolve action (SYNC-11). *This replaces the earlier sketch in which the client created the copy with
   `POST /notes/{id}/conflict`; that endpoint stays for the web app (ADR-0054).*
6. **Revive** (the note is deleted): the text it returns with is `merge3(base, last text, incoming)` when the base is the last text
   or retained and the merge is clean; incoming text alone when the base *is* the last text; **overlap** ⇒ the note returns with its
   last text and the incoming text becomes a conflict copy (`409 conflict`, the note is live again: edit wins over delete). A note
   deleted before history existed has no retained last text (its text is in `.atlas/trash`): nothing live is overwritten, so the
   client's text is taken. Always `resolution: edit_wins_over_delete` (+ `note_merged`, + `path_collision`).
7. Safety checks of a clean merge: valid UTF-8 (the request is rejected earlier: `422` for a lone surrogate or NUL), at most
   `MAX_NOTE_BYTES`, and **the front-matter block of the result is byte-identical to one of the two sides'** (stricter than "parses
   as YAML": no YAML dependency, and two sides editing different front-matter keys conflict). Line endings and the final newline
   are preserved exactly (`MARKDOWN_STORAGE.md` 4a).

**Replay** (same `Idempotency-Key`, same body): the stored record is the note's summary and the `sync` block, never the text (a
body can be 5 MiB and keys live 90 days). The replay adds the note's **`content` as of the revision the first answer reported**,
read from history and verified against the recorded hash, so a client that lost the response of a merged save can still replace
its file. If that revision has been pruned the replay has no `content` (the client reads the note). A replayed conflict returns
the stored `409`. As for every 2xx, a replay is a historical snapshot (§8.1).

**History** (ADR-0059 D5, ADR-0060): every revision of every note, in every mode, is recorded in `note_revisions` (hash, size, path
at that revision, reason) in the same transaction as the bump; its text is a file
`<notes-root>/.atlas/history/<note_id>/<sha256>.md` (content addressed: a move or delete shares the file of the text it did not
change; a file that no longer hashes to its name is never used). Retention per note: the newest 20 revisions always; older ones
while younger than 90 days, bounded by 200 revisions and 64 MiB of distinct text; whole history of a note deleted for more than 90
days is removed. Pruned on write and by the hourly purge job. A note that predates history is recorded when its next write finds
its current revision unrecorded and the file's hash equals the index hash. History is inside the notes root, hence in every backup
(ADR-0041); **it keeps the text of overwritten and deleted notes for up to 90 days** (SECURITY.md).

Reconcile (external edit on the server filesystem) records a feed change and a history revision (reason `external`) for every
revision bump. The bytes *before* the edit are in history if that revision had been recorded; a file changed before its first
recording has no retained pre-edit text, so a stale client conflicts instead of merging.

### 6.4 Links

`PUT/DELETE /api/projects/{id}/notes/{note_id}` and task↔note link endpoints already record feed changes. They
are set operations; no revision. Idempotent by nature; a link whose end is tombstoned is ignored by the client.

### 6.5 Ordering and dependencies

A client replays its queue strictly FIFO, one request in flight. An operation that fails permanently does not
block later independent operations; a dependent operation then fails with `400 does not exist` (permanent) and is
shown as failed, never retried. Batch endpoints are deliberately not part of v1 (ADR-0059 D1); revisit only if
SYNC-02's harness measures a problem.

---

## 7. Resync, restore and long absence

7.1 **Normal**: pull from the stored cursor. 7.2 **New device**: pull from 0 (snapshot).

7.3 **`below_floor`**: the client has pending local operations and a cursor older than the retained tombstones.
It must not discard anything: (a) keep the pending queue; (b) pull a fresh snapshot from 0 into a *shadow*
server-state; (c) when the walk completes at `head`, diff: entities in the old local server-state but absent from
the snapshot were deleted while away. For each: if it has no pending operation, delete it locally (a note file
goes to the client's trash folder, never `rm`); if it has pending edits, **rule 4** — keep it, the edit will
restore it when pushed; (d) replace server-state, set cursor to `head`. Links are diffed as sets.

7.4 **`cursor_ahead`** (server restored from an older backup): the server lost changes. The client keeps its
local state, marks all entities whose local `revision` exceeds the snapshot's (or are absent from it) as
"server lost these", shows a blocking notice, and on confirmation re-creates them with their own ids through the
normal create path (client ids make that idempotent). Never automatic. **Server side [DONE]:** a restored server whose cursor has since grown past the client's would look normal, so
the operator runs `atlas-admin record-restore` after a restore (OPERATIONS.md): it rotates the instance `epoch`. A sync-mode
request carrying `Atlas-Epoch: <old>` to an authenticated sync router (tasks, projects, notes, changes) is answered
`409 epoch_mismatch` with the new epoch and **nothing is applied**; the client must ask its user before adopting it. The
client UX is open (ADR-0059 D12).

7.5 **Storm control**: after a `resync_required` a client may not resync again within 10 minutes without user
action, and at most one resync is in flight per device; the server rate-limits snapshot pages per device (§8.3).

---

## 8. Errors, retries, limits

### 8.1 Status mapping (sync mode)

| Status / `error` | Meaning | Client action |
|---|---|---|
| 2xx | applied (or replayed) | remove op, store `sync` block. **A 2xx body is a historical snapshot, not current state**: a replay after a lost response returns the result of the *first* application, possibly many revisions and even a delete ago. The client may use it to fill a gap (id mapping, first copy) but must never let it overwrite newer or tombstoned local state, and must re-read the entity at its next pull (found by sim seed 482, SYNC-03 pre-work) |
| 200 with `sync.conflicts` | partially applied | store applied fields, surface conflicts |
| 401 `unauthenticated` / `token_revoked` / `token_expired` | credential invalid, signed out, or idle too long | stop; keep queue and local data; ask to sign in again (never retry blindly) |
| 403 `forbidden_scope` | a device token cannot do this (account-level endpoint) | permanent for the op |
| 404 `not_found` | unknown id (tombstoned entities are not 404, §6.2) | permanent |
| 409 `stale` / `conflict` / `edit_wins` / `path_exists` / `note_deleted` / `id_exists` | structured, never overwritten (`conflict` on a note: the incoming text is saved in `conflict_copy`) | resolve per §6; do not blind-retry |
| 422 `invalid_path` (`reason`: `reserved_name`, `forbidden_character`, `trailing_dot_or_space`, `too_long`, `name_too_long`), `base_hash_required` | the request cannot be honoured as sent | permanent for the op; keep the user's text, rename |
| 409 `idempotency_mismatch` | key reused with another body | permanent, report a bug |
| 413 `too_large` | body > limit | permanent; mark item "too large to sync" |
| 422 | validation | permanent; keep the user's text, show the server message |
| 426 `sync_version_unsupported` | `{min,max}` | stop syncing, keep the queue, send nothing more; "update required" (§10) |
| 409 `epoch_mismatch` | `{epoch}` | stop; ask the user (restored server or another server); nothing was applied |
| 429 (`rate_limited` for a device) | rate limited | honour `Retry-After`, then retry same request |
| 5xx, timeout, connection loss, aborted response | outcome unknown | retry the **same** request (same key) with backoff |

### 8.2 Backoff

Exponential, base 2 s, factor 2, cap 5 min, full jitter, reset on success; at most one push stream per device;
network-change and app-focus events trigger an immediate attempt (once). The same constants as the calendar
adapters where they already exist (`backoff` unit tests).

### 8.3 Limits (proposed, configurable)

JSON write body ≤ 256 KiB except note content ≤ `MAX_NOTE_BYTES` (5 MiB, unchanged; JSON overhead means the
proxy limit must be ≥ 11 MiB (2 x 5 MiB for JSON escaping + envelope; the earlier "6 MiB" fits prose only) — verified 2026-11-03 that the shipped config did not allow it (default 1 MiB, `413` above;
R-34). **Fixed in SYNC-03:** `apps/web/nginx.conf` now sets `client_max_body_size 11m;` in `location /api/` and 1 MiB
elsewhere, checked by `tests/unit/test_nginx_config.py` against the shipped file and a throwaway container; the web image
must be rebuilt to take effect. Only control characters other than tab/newline (6 bytes each) can still exceed it.) Rate limits keyed by **device id** after
authentication (not client IP, R-SEC-1): 120 writes/min, 60 feed pages/min, 10 snapshot starts/hour; auth
endpoints keep the login limiter.

---

## 9. Automatic-resolution log [DONE, SYNC-05]

Decisions: ADR-0059 D7, ADR-0061. Table `sync_resolutions` (migration `f4a8b2c6d1e3`, reversible): `id`, `user_id`, `entity_type`
(`task|project|note`), `entity_id`, `rule`, `field`, `kept_revision`, `loser` (JSONB, `{"value": ...}`, `NULL` = not stored),
`detail` (paths only, 2 048 characters at most), `device_id` (the device behind the request, `NULL` for a browser session; `devices.id ON DELETE SET NULL`, SYNC-06), `op_key` +
`ordinal` (the request's `Idempotency-Key` and the entry's position in it), `undoes_id`, `undone_at`, `undone_by`, `created_at`.
Unique `(user_id, op_key, ordinal)` makes "a retry logs nothing more" a database fact; unique `undoes_id` allows one undo entry per
resolution.

**When it is written.** In the *same transaction* as the write that caused the decision: after the entity was written, before the
idempotency record is stored and the request committed (`atlas/api/syncio.py` `log_resolutions`). A rolled-back request leaves no
row and no feed entry; a replay returns the stored answer (which carries the entry ids) before any work, so it logs nothing.
Entries exist only for sync-mode writes.

| `rule` | Written by | `field` / `loser` | Undoable |
|---|---|---|---|
| `simple_later_wins` | task/project `PATCH` where a simple field changed on both sides and the incoming value was applied | field; the overwritten value | yes |
| `path_later_wins` | note move that overrode another device's move | `path`; the path it overwrote | yes |
| `edit_wins_over_delete` | an edit/`PUT` of a deleted entity that brought it back (also when a note revive ends in a conflict copy) | none | no: `follow_up delete_again` (an ordinary delete) |
| `note_merged` | a stale note `PUT` that was merged (also inside a revive) | none; `kept_revision` = the revision whose text the edit was merged into | no: `follow_up note_history` with `href` `/api/notes/{id}/history/{kept_revision}` |
| `path_collision` | a note create or revive whose path was taken | none; `detail` names both paths | no: `follow_up rename` |
| `undo` | a successful undo | the undone field; the value the undo replaced | no (`is_undo`) |

`kept_revision` is the revision the write produced, except for `note_merged` (above). **Not logged:** a refused stale `DELETE`
(`409 edit_wins`; nothing was written or overwritten and the caller is told in the response - ADR-0061, a deliberate narrowing of
D6's "both logged"), a text conflict (returned to the client, nothing applied), a note conflict copy (the `409` carries it).
**Never stored:** task or project text, note content. `loser` is stored only for the two undoable rules and `undo`, and only when
its JSON is at most 4 096 bytes; otherwise the entry exists without it and is not undoable (`value_not_stored`). Application logs
carry ids, rule and field names only.

**Wire shape** (`ResolutionOut`; the `sync.resolution[]` objects of write responses are the same facts plus `id`):
`id, entity_type, entity_id, rule, field, kept_revision, has_loser, loser, detail, device_id, undoes_id, undone_at, undone_by,
created_at, undoable, undo_blocked, follow_up{kind, href}`. `undo_blocked` is `already_undone`, `rule_not_undoable`,
`value_not_stored` or `is_undo`. `has_loser` separates "the overwritten value was `null`" from "no value stored".

**Feed entity `resolution`.** Recorded in the writer's transaction like any entity (one `change_log` row per entry, cursor from the
user's counter), so a device learns of a decision through its normal pull. `include=data` returns `ResolutionOut` with `revision`
1, or 2 once the entry was undone (an undo re-announces the original at a new cursor, and announces its own `undo` entry), so a
client applies it by revision like any entity. Visibility: a request in sync mode (`Atlas-Sync`) without `types=` receives it; with
`types=` only if named; a legacy request without `types=` never sees it (the web app is unchanged); the cursor advances over it
like over any filtered row. `GET /api/instance` lists `resolution: 1` in `sync.entities`. There is no `delete` row for a resolution:
retention (below) removes the log row **and** its feed row, so a client drops a notice by itself when it is older than
`sync.tombstone_retention_days` (or absent from a fresh snapshot). A device shows "changed on another device" for entries it did not
originate: `device_id` differs from the client's own device id (`GET /api/devices/current`). Entries written from a browser
session have `device_id` `NULL`, which is "another device" for every native client.

**Endpoints** (all under the `epoch_check` gate, strictly user-scoped, another user's id is `404 not_found`):
- `GET /api/sync/resolutions?limit=&cursor=&entity_id=&rule=`: newest first (by `created_at`, then the entry's position in its request, so the entries of one write list last decision first), `limit` 1-200 (default 50), opaque `cursor`
  (`next_cursor` of the previous page, `null` at the end), `422` on a bad limit or cursor. Includes `undo` entries and undone entries.
- `GET /api/sync/resolutions/{id}`.
- `POST /api/sync/resolutions/{id}/undo`, `Idempotency-Key` **required** (`422 idempotency_key_required`), no body. The same key
  replays the first answer (`Idempotency-Replayed: true`); a key used for another request is `409 idempotency_mismatch`.

**Undo** re-applies the overwritten value through the entity's ordinary sync write in a *strict* form
(`plan_merge(strict=True)`, base = the resolution's `kept_revision`): the write is applied only if nothing changed the field since;
otherwise it is refused. For a note move the same test is "the path at `kept_revision` (from history) is still the current path".

| Situation | Answer | Effect |
|---|---|---|
| field unchanged since, value differs | `200 {applied: true, revision, resolution (undone), undo}` | value restored; revision +1; reminders rescheduled like any edit; original marked undone; `undo` entry logged; both announced |
| field already holds the value | `200 {applied: false, ...}` | nothing written; original still marked undone; `undo` entry logged |
| field/path changed since (even back to the same value later) | `409 conflict`, `conflicts: [{field, reason: changed_since, server_revision, server_value}]`, `resolution_id` | nothing written; the entry stays undoable |
| entity deleted | `409 entity_deleted` | an undo never revives |
| value invalid now (deleted project, illegal status step, unsafe path) | `409 conflict` with reason `invalid_value` or `invalid_transition` | nothing written |
| note target path taken | `409 path_exists` | nothing written |
| already undone (another key) | `409 already_undone` + the entry | nothing written |
| `note_merged`, `edit_wins_over_delete`, `path_collision`, `undo`, no stored value | `409 not_undoable`, `reason`, `follow_up`, `resolution` | explicit pointer: history revision / delete again / rename |
| unknown or another user's id | `404 not_found` | |

Locks: the resolution row is locked first (`FOR UPDATE`), then the entity row, then the user's change cursor; nothing else ever
locks a resolution row, so the order cannot cycle. A concurrent second undo of one resolution waits and then answers
`already_undone`.

**Retention.** `CHANGE_RETENTION_DAYS` (default 90, minimum 30) - no new setting: the hourly purge job deletes entries older than
the window together with their feed rows, never an entity. After that the entry can no longer be listed or undone. Entries ride
in every database backup (the table is in the one database, `pg_dump`) and come back with a restore together with the entities
they describe.

## 10. Devices, credentials, versioning

### 10.1 Device credentials [DONE, SYNC-06; ADR-0065]

- Table `devices(id, user_id, name, platform, created_at, last_seen_at, revoked_at, token_hash, prev_token_hash,
  prev_valid_until)` (`DATA_MODEL.md`). No address, user agent or app version is stored.
- **Sign-in.** `POST /api/devices` `{email, password, name (1-80), platform}` (`platform`: `windows|linux|macos|android|ios|web|other`)
  answers `201 {device, token}`. The token is `atd_` + 43 URL-safe characters (256 random bits), **shown once**; only its SHA-256 is
  stored. Wrong password, unknown account and inactive account are the same `401 {"detail": "Invalid credentials"}`; the endpoint shares
  the login rate limit (`429`); no cookie is set and no CSRF header is needed (it needs the password). `409` beyond 25 unrevoked
  devices (revoke one in Settings).
- **Using it.** `Authorization: Bearer <token>` on the endpoints below; a request that carries a bearer header is authenticated by it
  **alone** (cookies are ignored, so a session cookie can neither rescue a bad token nor widen a good one) and needs no CSRF header; a
  request without one is a browser request and is checked exactly as before. Only the `Bearer` scheme counts.
- **Scope `sync`.** Open to a device: tasks, projects, notes and folders, `/api/changes`, `/api/tasks/changes`, `/api/search`,
  `/api/sync/resolutions` (list, get, undo), `GET /api/instance`, `GET /api/auth/me`, `GET /api/devices`, `GET /api/devices/current`,
  `POST /api/devices/current/rotate`, `DELETE /api/devices/current`. **Closed** (`403 forbidden_scope`, checked after the token is
  validated, so a bad token is still `401`): password change, profile edit, rename or revoke devices, revoke all, export, calendar
  credentials and sync, the push-notification registry. A new endpoint is closed to devices until it is opened on purpose
  (`test_the_set_of_endpoints_open_to_devices_is_exactly_this`).
- **Errors** (`{error, detail}`; `401` carries `WWW-Authenticate: Bearer`): `unauthenticated` (unknown or malformed token, or the
  account is inactive), `token_revoked`, `token_expired` (idle for `CHANGE_RETENTION_DAYS`, default 90), `forbidden_scope`,
  `rate_limited` (`Retry-After`). On any `401` a client stops, keeps its queue and local data, and asks the user to sign in; it does
  not retry blindly and does not wipe local data unasked.
- **Rotation.** `POST /api/devices/current/rotate` answers `{device, token}` with a new token; the previous one keeps working for 24
  hours, or until the first request with the new one, whichever is first. A client that lost the response retries with the old token
  and gets another new token. Rotation does not detect theft of the current token (R-52).
- **Management (browser session).** `GET /api/devices[?include_revoked=true]` (newest first; `current` is true for the device that
  asked), `PATCH /api/devices/{id}` `{name}`, `DELETE /api/devices/{id}` (revoke, immediate, idempotent), `POST /api/devices/revoke-all`
  `{revoked: n}`. Another user's device id is `404`. A device can sign itself out (`DELETE /api/devices/current`).
- **`last_seen_at`** is the server's time of the last authenticated request, written at most every five minutes.
- **Revoke-all is one function** (`revoke_all_devices`), called by the Settings button, the optional `revoke_devices` flag of
  `POST /api/auth/password` (**default off**: a routine change signs out browsers only, ADR-0065 point 5), `atlas-admin reset-password`
  (always) and, later, AUTH-01's recovery reset (always). `atlas-admin list-devices` and `revoke-device` exist for the operator.
- **Retention.** The hourly purge deletes devices revoked before the `CHANGE_RETENTION_DAYS` window; resolutions keep their text and
  lose the device. An idle, never-revoked device stays listed.
- **Rate limits** (after authentication, keyed by device id): 600 requests and 120 writes per minute.
- Client storage: token in the OS keystore only (Windows Credential Manager/DPAPI, Secret Service on Linux, Android
  Keystore-backed storage); never in the SQLite file, logs, or the webview's storage. The webview does not receive the token:
  Rust attaches it (so XSS in a note preview cannot read it). The mechanism per platform: Linux Secret Service via the `keyring` crate is **verified** (SYNC-07, §13: store/read/delete, defined
  failure with no Secret Service, no webview access); Windows Credential Manager and Android Keystore are **[UNVERIFIED]** (§13.3, §13.4).
- Transport: HTTPS only. `http://` is refused except `localhost`/`127.0.0.1`/`[::1]` and an explicit developer override (the tailnet
  dev stack, DEPLOYMENT §8a). Enforced by the client (SYNC-09); the server sits behind the operator's TLS.

### 10.2 Versioning

- **Protocol major** `Atlas-Sync: <int>` header (§6) and `GET /api/instance` gains
  `sync: {protocol: {min, max}, entities: {<type>: <schema int>}, limits: {max_note_bytes, feed_page_max,
  feed_page_max_with_data}, tombstone_retention_days, idempotency_retention_days, epoch}` [DONE]. The `426` is raised before
  authentication (it reveals only the range); the epoch check after it.
  The server accepts `min..max`; it raises `max` for additive changes and `min` only for breaking changes, with
  a deprecation note in `instance` one release earlier. Outside the range ⇒ `426`.
- **Client** stores `protocol` and a local `schema_version`; a local database newer than the app ⇒ the app refuses
  to open it (no downgrade). An older local database is migrated forward with a pre-migration copy kept.
- **Unknown entity types.** The client sends `types=` with exactly what it understands, and records
  `types_synced`. When an upgrade adds a type, the client backfills it with `since=0&types=<new>` before relying
  on it. This is why the cursor can safely advance over filtered items and why an old client never silently
  drops new data. Unknown **fields** are ignored by clients; servers ignore unknown request fields only in
  non-sync mode (sync mode rejects them with 422 so an old client cannot half-write).
- `epoch` (a UUID in `instance_meta`, created by the migration, rotated by `atlas-admin record-restore`) lets a client detect
  that it is talking to a different server or a restored one; a mismatch is a blocking prompt, never an automatic resync. A
  database restored from a backup keeps the epoch stored in the backup until the operator rotates it.

## 11. Desktop notes folder rules (client obligations, specified here because they affect the protocol)

- Only regular `*.md` files, UTF-8 (invalid UTF-8 ⇒ "cannot sync", file untouched). Ignore dot-directories,
  `.atlas*`, editor backup/swap files; non-`.md` files are never touched, synced or deleted (D10).
- Identity is the note id kept in the local index; the file path is the user-visible name. A file watcher event
  is a hint; a scan (start, focus, every N min) compares size+mtime then SHA-256 of bytes (same function as the
  server: `content_hash`).
- Rename detection: a missing file plus a new file with the same hash in one scan ⇒ `move`; otherwise delete +
  create. Ambiguous duplicates ⇒ create.
- Portable paths [DONE on the server, SYNC-04]: sync mode rejects (`422 invalid_path`) a create or move to a path with a Windows
  reserved device name in any segment (`CON`, `PRN`, `AUX`, `NUL`, `COM0-9`/`LPT0-9` also with `¹²³`, `CONIN$`, `CONOUT$`, with or
  without an extension), a character of `<>:"|?*` or a control character, a segment ending in a dot or space, a segment longer
  than 255 UTF-8 bytes, or a path longer than 240 characters; and treats a path that differs from another live note's only by
  case or Unicode normalisation (NFC + casefold) as taken. The client skips local paths of that kind (SYNC-09). Rules live in
  `atlas/notes/portable.py` and apply **only in sync mode**; notes that already exist keep their paths (a revive restores the old
  path as it was), and a conflict copy's name is shortened to fit.
- Client writes are atomic (temp + rename) and recorded so the watcher ignores them. A file changed locally
  while a server merge result arrives is re-checked by hash before overwrite; if it changed again it becomes a
  new local edit based on the merge result.
- Deletes go to a client trash folder. Files > 5 MiB are listed as "too large to sync".

---

## 11a. Clocks (D11) [DONE]

No server decision reads a device clock: order is the arrival order of the request at the server and the entity revision. The
server never reads `X-Client-Time` (a test sends absurd values in both directions); server-set times (`completed_at`, conflict
names, history) use the server clock. The simulation gives each client a jumping offset of up to a day and compares the final state
of a run with and without skew (identical), and a planted "order by client time" bug fails it.

## 12. Open items (not decided by this document)

Whether the batch endpoint is ever needed; pairing-code
flow; Android notes storage location (D10); calendar projection on devices; whether the web app opts into
sync mode to benefit from field merge; the restore notice UX (D12). All are tracked in ADR-0059 or the SYNC tasks.

## 13. Tauri 2 spike (SYNC-07): results (Linux part, 2026-11-04; GitHub-hosted Windows runner results in 13.3a; the owner's Windows machine and Android not run)

Code and raw outputs: `spikes/tauri/` (README, scripts, `results/`); it is outside every workspace and is not run by `./scripts/verify.sh`,
`npm run lint`, `vitest` or CI. Numbering follows the plan in `ROADMAP.md` (S1-S10); the extra checks asked for on this run are X1
(single instance), X2 (API access, CORS/CSP, capabilities, a real `sync-core` round trip) and the licence check (part of S10).
**Environment:** CachyOS (Arch), kernel 7.2.9, NVIDIA RTX 3080, KDE Wayland session; **WebKitGTK 2.54.1** (system package); Tauri
2.12.5, wry 0.57.1, tao 0.37.2, tauri-cli 2.12.4, Rust 1.99.1 (rustup, user-level), Node 26.11.1; baseline Chromium 154.0.8037.97
(headless). Everything ran against a throwaway database `atlas_spike_<random>` in the existing Postgres container (created and dropped
by the spike, never `atlas` or `atlas_test`) and a throwaway API on its own port. Vocabulary as `TESTING.md`: `PASS`, `FAIL`,
`BLOCKED`, `NOT RUN`.

### 13.1 Results

| # | Check | Result | Evidence (numbers are from this machine; raw JSON in `spikes/tauri/results/`) |
|---|---|---|---|
| S1.1 | CSS and API features the existing UI uses (found by grepping `styles.css` and `src/`) | `PASS` | `:has()`, Popover API (`popover`, `showPopover`, `:popover-open`), `dvh`, `env(safe-area-inset-*)`, `color-mix()`, `@container`/`container-type`, `color-scheme`, `:focus-visible`, `clamp()`, subgrid, `light-dark()`, `inert`, `<dialog>.showModal`, `crypto.randomUUID` (origin `tauri://localhost` is a secure context), IndexedDB, `localStorage`, `visualViewport`, `ResizeObserver` all present |
| S1.2 | Same 20-step scenario (`ui/scenario.js`: sign in, Today, Inbox, Tasks, Week, Projects, Settings, task panel, priority popover, project board, notes list, note in Live/Source/Preview, note menu, palette, theme toggle, 5 000-line note) in WebKitGTK and Chromium, DOM facts compared | `PASS` | desktop 1280x800: 20/20 steps in both engines, every recorded fact identical (element rectangles to the pixel, computed fonts, element counts; the font-family string differs only in quoting). Both ran dark: WebKitGTK follows the KDE colour scheme, Chromium was set to `dark`; phone 390x800: 19/20 in both engines (the failing step, opening "Big note" from the phone list, fails identically in Chromium: a scenario limit, not a webview difference); heights differ by <= 12 px (font metrics). Pixel RMSE vs Chromium 3-5 % (anti-aliasing) up to 13.6 % on one long phone page. Side-by-side screenshots: `results/shots/` |
| S1.3 | Visual defects found by looking at the pairs | `FAIL` (2 defects, both fixable in CSS/JS inside the 2-day allowance) | **D1** native `<select>` (Repeat, Reminder "When" in the task panel) is drawn with the GTK widget; `min-height`+padding from `styles.css` clip the text (`select` has no `appearance: none`). **D2** `<input type=date/time/datetime-local>` (`TaskDetail.tsx`, `ProjectForm.tsx`) have **no picker** in WebKitGTK: plain text fields showing ISO text (`2026-11-01`, `2026-11-04, 12:30`), no clear button, unlike Chromium. The Today/Tasks quick date popovers are Atlas's own and look the same. Neither is a core-editing defect |
| S1.4 | Journeys J1-J7 (`test:e2e:real`) adapted to the shell; axe sweep | `BLOCKED` | Playwright cannot drive WebKitGTK; `WebKitWebDriver` is not installed and not in the installed `webkit2gtk-4.1` package. The scenario above is a scripted substitute, not J1-J7. axe: `NOT RUN` |
| S1.5 | CodeMirror 6 editing in a 5 103-line note: caret, selection, IME, undo, latency p95 < 50 ms | `NOT RUN` for IME, real key events and caret movement (no input-injection tool: no `xdotool`, no `WebKitWebDriver`; `wtype` not installed). Programmatic edits: `PASS` for the synchronous part, `inconclusive` for the frame | `EditorView.dispatch` of one character: **p50 3-4 ms, p95 <= 25 ms** (state + DOM update; with forced layout 3-6 ms p50) in WebKitGTK, both modes, same in Chromium (2.8-3.4 ms p50). `execCommand("insertText")` (browser input path) and `undo` work (undo p50 16 ms). **Frame after an edit is bimodal and unexplained:** WebKitGTK (DMABUF renderer disabled, see S9) 32 ms = two 60 Hz frames in 2 of 5 runs, 1.1-2.3 s in 3 of 5 runs (the plain contenteditable control in the same window is always 32 ms); headless Chromium (software raster) is a steady 267 ms. Not attributable to Tauri; needs a GPU-enabled, controlled retest (R-58). Raw: `results/perf-runs/`, `results/scenario-chromium-desktop.json` |
| S1.6 | Oldest supported webview | `NOT RUN` | only 2.54.1 (new). The minimum WebKitGTK (distro-dependent) and the AppImage's bundled WebKit are not decided; see S8 |
| S2 | SQLite, transactions | `PASS` | `rusqlite` 0.37 (bundled SQLite 3.50.2), WAL, behind our own Tauri commands. 50 000 rows in one transaction 43 ms (`synchronous=FULL`, NVMe; 40 ms NORMAL); indexed point query 0.03 ms; "apply 50-row page + store cursor" in one transaction 0.71 ms (FULL) / 0.16 ms (NORMAL). **kill -9 at 100 random points (15-135 ms after start, mid-transaction included, SIGKILL): 0 inconsistent states** (invariant: rows of batches <= cursor all present, none beyond, `integrity_check` ok; every run advanced; final cursor 10 215). Forward migration `user_version` 1 to 2 keeps data and fills the new column. IPC: `invoke` round trip p50 < 1 ms, p95 1 ms (timer resolution 1 ms); apply-page via IPC p50 1 ms. Caveat: a killed process is not a power cut, so FULL vs NORMAL is decided by SYNC-09. **`tauri-plugin-sql` 2.6.0 is not usable as the transaction vehicle:** every call is `pool.execute(query)` on a connection pool (read in `wrapper.rs`; commands are only load/execute/select/close), so `BEGIN ... COMMIT` across calls is not guaranteed; and it cannot be built with `rusqlite` 0.37 (both `links = "sqlite3"`; cargo refuses). Verified by reading source and by `cargo generate-lockfile`, not by running the plugin |
| S2b | How it backs the `sync-core` `LocalStore` | `PASS` (works), finding | `KeyValueLocalStore` over `kv_read/kv_write` (Rust SQLite) passed the round trip in X2 and a restart. It rewrites the whole state after every transaction: one write costs 1 ms at 10 KB, 7 ms at 1 MB, 39 ms at 5 MB, 131 ms at 20 MB, and **300 local task creates wrote 167 MB in 2.1 s (quadratic)**. It is not a desktop store: SYNC-09 needs a per-row `LocalStore` (the async `StoreTx` interface fits; one IPC call per transaction batch, each costing < 1 ms) |
| S3 | Notes folder, watcher, scan, scope | `PASS` with limits | `notify` 8.2.1 (inotify). **2 000 `.md` files scanned (size+mtime) in 2.8-3.0 ms, 5 000 in 7.7 ms.** Watcher latency after the command started: create 1.1 ms, in-place append 1.2 ms, vim-style temp+`mv` over 1.8 ms, rename 1.4 ms, delete 1.4 ms, new folder+file 2.0 ms; a 200-file bulk rewrite (git-checkout-like): 200/200 files seen, last event 58 ms. **Simulated with shell equivalents; VS Code, Obsidian, vim and `git checkout` were not run.** **Rescan after a watcher outage found every change** (11 modified, 6 removed incl. a rename, 4 added), but **a same-size edit that keeps mtime is invisible to a size+mtime scan** (a periodic scan needs a content hash, or the limit is accepted and documented). Own atomic write (temp file in the same directory, fsync, rename, fsync dir): 6 raw events, 2 after dropping Atlas temp names, 0 reconcile actions after the content-hash check. **Found: reading a changed file emits `Access(Open/Close)` events, a feedback loop that hung the first version of the test**; the watcher must drop `EventKind::Access`. Permission model (fs plugin 2.7.1, no static scope): before the runtime grant `read_text_file` and `read_dir` are `forbidden path`; after `allow_directory` on the chosen folder reads (also nested) and writes inside work; **refused:** `/etc/hostname`, `..` traversal (two forms), a sibling folder sharing the prefix (`notes-sibling`), a symlinked file pointing outside, a file through a symlinked directory, dotfiles (`.hidden.md`; default `require_literal_leading_dot`: `.obsidian`, `.git` are out of reach, which is wanted), write outside. Our own `notes_atomic_write` refuses `..`, absolute paths and a symlinked directory. `NOT RUN`: dialog plugin (needs a click), plugin-fs `watch` (compiled in, not exercised), Windows, OneDrive/Dropbox folders |
| S4 | Keystore | `PASS` (Secret Service, KWallet implementation); `NOT RUN` GNOME Keyring, locked wallet | `keyring` 3.6.3 (`sync-secret-service`, `crypto-rust`) against the running `ksecretd`: set 10 ms, get, exists, delete, gone. **No Secret Service** (private D-Bus, none registered): every call returns `platform_failure ... org.freedesktop.secrets was not provided by any .service files`: defined behaviour, no file fallback exists to fall into. The webview cannot read the token: there is no get command (`token_get` is refused by the ACL), `token_in_webview_storage` false, and `api_request` drops the webview's `Authorization` header and adds the bearer in Rust. The test entry (`atlas-spike-sync07`) was removed from the owner's wallet afterwards (`secret-tool clear`) |
| S5 | Notifications | `PASS` immediate; `FAIL` scheduled-with-app-closed on desktop | `tauri-plugin-notification` 2.8.0: `show()` returned ok and `dbus-monitor` saw the `org.freedesktop.Notifications.Notify` call. The desktop implementation has **no scheduling** (nothing in `desktop.rs`; scheduling exists on mobile only): a reminder with the app closed needs the app to stay resident (tray/autostart) or the server's push (R-59). Android scheduling and Doze: `NOT RUN` |
| S6 | Auto-update | `PASS` (Linux AppImage); Windows `NOT RUN` | `tauri-plugin-updater` 2.14.1, throwaway minisign key pair, local server on `127.0.0.1:18777` (plain http, only possible with `dangerousInsecureTransportProtocol`). **Valid 0.2.0: downloaded, signature verified, installed in place; restart reports 0.2.0.** **Tampered bundle (one byte flipped after signing): `The signature verification failed`, file byte-identical, still 0.1.0.** **Signed with another key: `The signature was created with a different key than the one provided`, unchanged.** `.deb` has no updater path (docs: AppImage only on Linux); the `.deb` builds (4.30 MiB, `Depends: libwebkit2gtk-4.1-0, libgtk-3-0`), install `NOT RUN` (Arch; no dpkg). Rollback: none built in; keep the previous AppImage. HTTPS update from the self-hosted server with a publicly trusted certificate: `NOT RUN` |
| S7 | Windows install without admin | `NOT RUN` | hardware (checklist 13.3) |
| S8 | Android background sync | `NOT RUN` | hardware (checklist 13.4) |
| S9 | Size and footprint | `PASS` start and size; memory `review` | AppImage **115 194 360 bytes (109.86 MiB**, it bundles WebKitGTK and its libraries from the build machine: built on rolling Arch, so glibc-portable to older distributions is not assured), `.deb` 4.30 MiB, bare release binary 10.0 MB. **Cold start to "page JS finished": 184-233 ms (5 runs).** After a scripted session and 30 s idle with the 5 103-line note open: **397 MB PSS in 3 processes** (app, WebKitWebProcess, WebKitNetworkProcess) vs **519 MB PSS in 13 processes** for headless Chromium on the same page (RSS sums 595 vs 1 310 MB double-count shared pages). Above the plan's 300 MB review line, but 30 s idle with one note, not 10 min with 5 000 indexed notes (`NOT RUN`). Startup of the AppImage itself (FUSE mount) was not timed. **Environment fact:** WebKitGTK 2.54.1 on this NVIDIA GPU under Wayland dies with `Gdk Error 71 (Protocol error)`, or with `Failed to create GBM buffer` under Xwayland, unless `WEBKIT_DISABLE_DMABUF_RENDERER=1` is set before the webview starts; the app must set it itself on affected systems, and it moves rendering to a slower path (R-58) |
| S10 | Security posture and supply chain | `PASS` with recorded warnings | **Capabilities:** every app command needs a permission (`build.rs` app manifest); the harness window has 29, the window that loads the Atlas UI from an `http` origin has three (`report`, `snapshot`, `exit_app`) and its calls to `token_exists`, `db_open`, `api_request`, `plugin:fs|read_text_file` and `ctx` were refused (`not allowed by ACL`), as were an undeclared command and an uninstalled plugin. CSP `default-src 'self'` with `connect-src` limited: `fetch('http://example.invalid')` fails. **Audit:** `cargo audit` (advisory DB of 2026-11-04): **0 vulnerabilities** in 577 crates, 8 warnings for 5 crates: `proc-macro-error` 1.0.4 unmaintained (RUSTSEC-2024-0370), `zbus_names` 3.0.0/4.3.5, `zvariant` 4.2.0/5.15.1, `zvariant_derive` unmaintained (RUSTSEC-2026-0370/0371/0372, dated 2026-10-16, transitive via the D-Bus stack), `glib` 0.18.5 unsound `VariantStrIter` (RUSTSEC-2024-0429, Tauri's gtk-rs 0.18 line; not called by us). `npm audit` 0 vulnerabilities. **Maintenance:** tauri 2.12.5 released 2026-10-21 (14 days ago); plugins 2026-10-14 to 2026-10-28; wry/tao 2026-10-23; all current; 2.x pinned, alphas (`3.0.0-alpha.*`) not used. **Licences** (`cargo license`, 577 crates): no GPL/AGPL; MIT or Apache-2.0 (often "OR") for ~98 %; MPL-2.0 x5 (`cssparser`, `cssparser-macros`, `dtoa-short`, `option-ext`, `selectors`: file-level copyleft, unmodified use); `notify` CC0-1.0; `webpki-roots` CDLA-Permissive-2.0; `r-efi` offers LGPL only as one alternative of three. Full list: `DEPENDENCIES.md` |
| X1 | Single instance | `PASS` | second launch of the AppImage exited in 0.19 s (status 0); the first received the arguments and working directory (`--second --note=hello`), no second process |
| X2 | HTTPS-only, bearer, CORS/CSP, real sync round trip | `PASS` | **Sign-in** `POST /api/devices` (ADR-0065) from Rust: token straight into the Secret Service, the webview only gets the device record. **Client rules in Rust:** `http://192.0.2.1` refused (`https only, http only for loopback`), another origin than the signed-in Atlas refused, `https://example.com` refused, a self-signed `https://127.0.0.1` refused (no downgrade). **CORS:** a direct webview `fetch` from `tauri://localhost` works only if the API lists `tauri://localhost` (and, on Windows/Android, `http://tauri.localhost`) in `CORS_ORIGINS`; an unlisted origin gets no CORS headers (preflight 400). The Rust proxy needs no CORS. **Round trip with the real `packages/sync-core` (imported read-only, bundled by esbuild):** local create 3 ms, push and first pull 837 ms, server has the task and the note, a task created by another client is pulled, a new engine over the same SQLite file sees all 32 entities after restart. 300 rapid creates hit the device write limit (`429` after 120 writes/min) and the engine went to `backoff` with `retryAt` and kept the 183 queued operations (expected behaviour). **Embedded UI** (the built `apps/web` as `frontendDist`, origin `tauri://localhost`): renders; its relative `/api` calls hit the asset protocol (SYNC-09 needs a configurable API base); service-worker registration is impossible (`script URL protocol must be HTTP or HTTPS`; irrelevant once the native store exists); **`tauri-plugin-notification` replaces `window.Notification`**: without `notification:*` permission the UI's permission check rejects (`is_permission_granted not allowed by ACL`), so grant it or guard the call. **`reqwest` with `rustls-tls` trusts only the bundled Mozilla roots**: an owner whose HTTPS uses a private CA (Caddy internal CA) would be refused: choose `rustls-tls-native-roots` or `native-tls` in SYNC-09 and test with the owner's real certificate (`NOT RUN`) |

### 13.2 Verdict and the Electron-fallback criteria, applied

**Stay with Tauri 2 for the desktop client; no Electron criterion is triggered on Linux; ADR-0055 is unchanged (no new ADR).** The
verdict is **conditional** because the criteria that matter most for the owner's work laptop are the ones that could not be run.

| Fallback criterion (desktop only) | Applied on Linux |
|---|---|
| S1 fails for core editing (not fixable in CSS/JS in 2 days) | **Not triggered.** No core-editing failure found; D1/D2 are small CSS/JS fixes. But IME, real key input, caret keys and the J1-J7 journeys were **not exercised** (S1.4, S1.5): they are a condition below, not a pass |
| S2 cannot be made transactional | **Not triggered.** Own `rusqlite` commands: atomic page+cursor, 100/100 kill-9 survivals. (The SQL plugin was rejected for this reason; this does not touch the decision to use Tauri) |
| S6/S7 make Tauri unusable on the owner's work laptop | **Undecided.** Linux S6 passes; Windows S6 and S7 (per-user install, WebView2, SmartScreen, policy) are `NOT RUN` and are the single largest open risk (R-36) |
| S10 unfixable advisory, or no releases for > 90 days | **Not triggered.** 0 vulnerabilities; 5 unmaintained/unsound transitive warnings (R-36); last release 14 days ago |

**Conditions before SYNC-09 starts:** (1) run a manual J1-J7 script and a CJK/IME composition check in the shell on Linux (needs
`xdotool` or a person; see the sudo list in `ROADMAP.md`) and re-measure the post-edit frame on a GPU-enabled WebKitGTK; (2) run the Windows
checklist 13.3, at least S7 and S6, on the work laptop; per the plan a mixed result (Tauri on Linux, Electron on Windows) is rejected,
so a Windows failure moves **both** desktop platforms to Electron, and the Linux work above is then discarded except the Rust-free
parts (store design, watcher rules); (3) Android stays the PWA/separate-shell question (A-09) until 13.4 is run.

**What SYNC-09 must do differently from the spike (all from the evidence above):** a per-row `LocalStore` over `rusqlite` commands (never the
whole-state key-value store, never `tauri-plugin-sql`); the token only in the keystore, attached in Rust, the webview holding no token
and no generic fs access; the watcher drops `Access` events, ignores Atlas temp names, compares content hashes, and a periodic scan
(with hashes for same-size edits) is the safety net; one granted root, relative paths only (`resolve()` in `spikes/tauri/headless/src/notes.rs`);
`reqwest` with the platform trust store; set `WEBKIT_DISABLE_DMABUF_RENDERER=1` where needed; grant `notification:default` or
guard `Notification`; a configurable API base instead of relative `/api`; no service worker in the shell; keep the previous AppImage
as the rollback; decide `synchronous=FULL` vs `NORMAL` (0.71 vs 0.16 ms per page here); fix D1 and D2 in `apps/web` as a separate UX task.

### 13.3 Windows checklist (owner's Windows machine, ideally the work laptop)

Goal: S1, S2, S3, S4, S5, S6, S7, S9, S10 and X1 on Windows 10/11 x64. Record Windows build, WebView2 version, and whether the account
is a standard user. Do **not** run this against real data: use the throwaway stack from the Linux machine.

**Shortcut since 13.3a: nothing needs to be built on the work laptop.** A GitHub-hosted runner already builds the per-user installers v0.1.0 and v0.2.0 and the signed update set; download
them (commands in 13.3a, "What the owner does") and start at step 6 (install as a standard user) and step 7 (X1, S9). Steps 1-2 (tools, code) and the headless parts of 4 are then only needed for S1 (the
real Atlas UI in the shell) and for the OneDrive/Dropbox watcher repeat, which need the Rust toolchain or an extra build on a machine where one is allowed.

1. **Tools.** Node 22+; Rust via `rustup-init.exe` (default MSVC toolchain needs "Visual Studio Build Tools, Desktop development with C++": installing it needs admin; if that is
   impossible on the work laptop, record it and use the personal Windows machine for S1-S6, the work laptop only for S7: install and run a *prebuilt* installer).
   WebView2: check `(Get-ItemProperty 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}').pv`.
2. **Code and stack.** Copy `spikes/tauri` and `apps/web` build output. The throwaway stack stays on the Linux machine; forward its two ports so the Windows
   client sees loopback (`ssh -L <apiPort>:127.0.0.1:<apiPort> -L <webPort>:127.0.0.1:<webPort> linux-host`; loopback http is allowed by the client rule).
   `npm install`, `npx esbuild ui/src/harness.js --bundle --format=iife --outfile=ui/harness.bundle.js`, `cargo build -p atlas-spike --release --features custom-protocol`.
3. **S1.** Set `SPIKE_ATLAS_URL=http://127.0.0.1:<webPort>/#email=...&password=...` (PowerShell `$env:`), run `target\release\atlas-spike.exe`. `snapshot` is Linux-only, so the
   scenario reports `shotError` per step and still records DOM facts; take screenshots by hand (Win+Shift+S) for tasks panel, note Live/Source, palette, a `<select>`,
   a date field. PASS: `steps` all `ok`, no new defect beyond D1/D2 (record each), CodeMirror caret/selection/IME (Japanese or Chinese IME) and undo by hand in a 5 000-line note, typing latency felt
   and `__editorPerf` p95 < 50 ms (run in the WebView2 DevTools console with F12 if enabled). FAIL: a core-editing defect not fixable in 2 days.
4. **S2/S3/S4 headless:** `cargo run -p atlas-spike-core --release -- sqlite-bench C:\tmp\s2`, `sqlite-kill C:\tmp\k 100` (SIGKILL equivalent is `TerminateProcess`), `keyring`. Look in
   Credential Manager (`cmdkey /list | findstr atlas-spike`) and delete it afterwards. `notes-watch` and `notes-scan` shell out to `sh`, `mv`, `rm`, `touch -d`, `stat`, `seq`: run them from Git Bash, or
   note which scenarios were skipped. **Repeat `notes-watch` with the folder under OneDrive and Dropbox** (placeholders/"files on demand", sync client touching mtime, AV scanning): record
   missed events and whether the rescan still finds everything. PASS = the S2/S3/S4 criteria in `ROADMAP.md`; watcher unreliable but scan correct = PASS with scan-only cadence recorded.
5. **S5.** Install first (toasts need the app identity), run `run-suite notify` equivalent (start the exe with `SPIKE_SUITE=notify`); check Focus Assist/Do Not Disturb behaviour. Scheduled with the app closed is expected `FAIL` (as on Linux).
6. **S6/S7 (the decisive ones).** Build with a per-user NSIS installer: `npx tauri build -c "{\"bundle\":{\"targets\":[\"nsis\"],\"windows\":{\"nsis\":{\"installMode\":\"currentUser\"}}}}"` with
   `createUpdaterArtifacts` and the throwaway signing key as in `scripts/build-bundles.sh`. As a **standard user** (no admin, no UAC prompt): install v0.1.0, serve `latest.json` with a
   `windows-x86_64` entry for v0.2.0 (the setup `.exe` and its `.sig`), run the updater test (valid, tampered, wrong key as in `scripts/updater-test.sh`). PASS: installs and updates without any elevation, tamper and wrong-key refused, install
   directory under `%LOCALAPPDATA%`. Record SmartScreen ("Windows protected your PC": unsigned binaries; a code-signing certificate is a cost, `DEPENDENCIES.md` platform costs), WebView2 presence on a clean user (and whether the
   NSIS bootstrapper's download is blocked by policy), AppLocker/WDAC, antivirus quarantine. FAIL (-> Electron for both desktop platforms, or portable zip + manual update): needs admin, WebView2 cannot be provided, or policy blocks the exe.
7. **X1** start the exe twice (named mutex): second exits, first receives args. **S9:** installer size, cold start, idle memory = sum of `atlas-spike.exe` and all `msedgewebview2.exe` in Task Manager > Details after 10 min, ideally with 5 000 notes in the folder.
8. **S10 for Windows:** `cargo audit` and `cargo license` on the Windows target (`--target x86_64-pc-windows-msvc`) add `windows-*` crates not covered by the Linux run.

**Cross-compiling from Linux only** (`cargo xwin build --target x86_64-pc-windows-msvc`, needs the Microsoft CRT/SDK download and its licence acceptance, and `nsis` for bundling: owner approval and `sudo`) would tell: whether
every crate and plugin compiles for Windows (keyring's Credential Manager backend, notify's `ReadDirectoryChangesW`), the binary size, and the extra supply-chain surface. It would **not** tell anything about WebView2, Credential Manager, installation, UAC,
the updater, watcher behaviour, antivirus or OneDrive, which is where the risk is; Wine does not stand in for them. Not attempted.

### 13.3a Windows runner results (GitHub-hosted `windows-latest`, 2026-11-04, workflow `.github/workflows/windows-spike.yml`)

**What this is.** A manual workflow (`gh workflow run windows-spike.yml --repo Mauz92/atlas`; never on push or pull request; no repository secrets) builds the spike on a hosted Windows runner (image `win25-vs2026`
20261030.294.1, Windows Server 2025 build 26100, WebView2 runtime 156.0.4314.50, 2 vCPU, runner user `runneradmin` = **administrator**, UTC, en-US), generates a **fresh throwaway updater key pair per run**
(the private key and its password stay on the runner and are never uploaded; the artifact holds the public key, the signed installers, the `.sig` files and prebuilt `latest.json` sets), builds
the harness and the Tauri app twice (0.1.0 and 0.2.0) as a **per-user NSIS installer** (`installMode: currentUser`), installs 0.1.0, launches it and runs headless checks, then runs the three updater cases. Scripts:
`spikes/tauri/scripts/windows/*.ps1`. First green run: [41808348307](https://github.com/Mauz92/atlas/actions/runs/41808348307) (all steps passed, one harness gap: watcher path separators); final run
[41810645362](https://github.com/Mauz92/atlas/actions/runs/41810645362) (everything below unless stated). Two earlier runs failed on my own script bugs (a quoted registry path; run 41803343231, 41805706305), fixed in the repo.

**What the hosted runner can and cannot prove.**

| It proves | It does NOT prove (stays with the owner; the checklist above remains valid for these) |
|---|---|
| the spike (all crates, plugins, `keyring` with the Credential Manager backend, `notify` with `ReadDirectoryChangesW`, bundled SQLite) **compiles and links for `x86_64-pc-windows-msvc`** with Rust 1.99.1 | **standard-user, UAC-free install** on the owner's managed laptop: the runner user is an administrator, so "no prompt" is meaningless here. What it shows: the installer lands in `%LOCALAPPDATA%\Atlas Spike`, registers only under `HKCU` (no `HKLM` entry), and its manifest requests `asInvoker` (no elevation requested) |
| a per-user NSIS installer is produced (3.0 MB), installs silently, uninstalls | **SmartScreen / "Windows protected your PC"** (binaries are unsigned; no Mark-of-the-Web on a runner-built file) |
| the signed update flow works on Windows: valid accepted, tampered and wrong-key refused | **corporate AppLocker / WDAC / antivirus / EDR** behaviour, quarantine, proxy or policy blocking the WebView2 bootstrapper download |
| headless behaviour: SQLite bench and kill test, keyring set/get/delete, scan, watcher, atomic write, ACL/capability refusals | **OneDrive / Dropbox** "files on demand", sync clients touching mtimes, folder redirection |
| the app starts, the installed WebView2 renders the harness, single instance works | **IME** (CJK composition), real key input and caret keys, typing latency p95 in the real editor (S1.5), the J1-J7 journeys in WebView2, focus/DND behaviour of toasts |
| supply chain for the Windows graph (`cargo audit`, `cargo license`) | memory over 10 minutes with 5 000 notes, cold start on a non-fresh profile, battery, sleep/resume |

**Results (final run; durations are from this runner).**

| # | Check | Result | Evidence |
|---|---|---|---|
| Build | `cargo build` + `tauri build` for MSVC | `PASS` | cold: core crate 2 min 34 s, 0.1.0 NSIS build 616 s, 0.2.0 172 s (cache of `Swatinem/rust-cache`); warm (final run): 183 s and 165 s. Bare `atlas-spike.exe` 8 028 160 bytes (8.0 MB; the Linux release binary was 10.0 MB). Installer **3 006 623 bytes (2.9 MiB)** vs the Linux AppImage 109.86 MiB: the WebView2 runtime is the OS's, not bundled |
| S7 (partial) | per-user install | `PASS` for what a runner can show; standard-user UAC `NOT RUN` | `install.json`: exit 0 in 1.7 s, `HKCU` uninstall entry yes, `HKLM` entry no, install dir `C:\Users\runneradmin\AppData\Local\Atlas Spike` (under `%LOCALAPPDATA%`), 8.1 MB installed, manifest `requestedExecutionLevel = asInvoker`, version registered 0.1.0 |
| S6 | signed update, three cases | `PASS` (all three cases behaved as required) | local `http://127.0.0.1:18777` server (`dangerousInsecureTransportProtocol`, spike only). **valid:** 0.1.0 -> installer ran passively, registry and exe `ProductVersion` read **0.2.0**; the app is ended by the installer so no `updater.json` is written (expected). **tampered** (one byte flipped after signing): `The signature verification failed`, stays 0.1.0. **signed by another key:** `The signature was created with a different key than the one provided`, stays 0.1.0. Not tested: update when the app is running as a standard user, SmartScreen on the downloaded installer, rollback |
| S2 | SQLite | `PASS` | bundled SQLite 3.50.2. 50 000 rows in one transaction 76.5 ms (`synchronous=FULL`; Linux NVMe 42.8 ms); "apply 50-row page + cursor" 0.68 ms; single autocommit row 0.33 ms; indexed point query 0.07 ms. **Kill test: 100 `TerminateProcess` kills at random points (15-135 ms), 0 inconsistent states, cursor advanced in 100/100** (34 s). Via IPC in the app: `invoke` round trip p50 1.9 ms / p95 2.2 ms (1 000 calls), page apply p50 2.5 ms / p95 2.8 ms (200 pages) |
| S3 | notes folder | `PASS` with a **defect found and fixed**, and limits | **Defect W1 (real, Windows-only):** `notes::atomic_write` ended with `File::open(dir).sync_all()`, which Windows refuses (`Access is denied. (os error 5)`) **after the rename had succeeded**, so every Atlas write would have reported failure and deleted its (already renamed) temp name. Found by the first run (`own_atomic_ok` failed, `notes-watch` panicked); fixed with `#[cfg(unix)]` (commit f584fc6); `own_atomic_ok` now `ok`. The consequence for SYNC-09: no directory fsync on Windows through `std`, durability of the rename after a power cut is whatever NTFS journals; document it. **Harness gap:** the watcher matcher compared `/` separators, fixed (25f8740). 2 000 files scanned in 3.1 ms, 5 000 in 7.2 ms, `ReadDirectoryChangesW` latency after the command (Git-Bash `sh`/`mv`/`touch`, local disk, quiet machine): create 30.5 ms, in-place append 26.9, temp+`mv` over 49.4, rename 34.7, delete 43.1, new folder+file 55.0 (about 25 ms slower than inotify; the `sh` start-up is inside these numbers); a 200-file bulk rewrite: **200/200 seen, last event 3 065 ms after the command** (the harness waits up to 3 s; treat as "events straggle, a rescan is still needed"); own atomic write produced 7 raw events, 4 after the name filter, 0 reconcile actions after the hash check. Rescan finds 4 added / 11 modified / 6 removed exactly (279 ms for the 2 000-file corpus incl. hashing); a same-size same-mtime edit is still **not** detected by size+mtime (same as Linux: hashes needed). `fsscope` suite: plugin reads before the grant refused, `..` traversal refused by Tauri ("Unsafe PathBuf"), sibling-prefix refused, symlink to outside and symlinked directory refused (symlinks were creatable on the runner), `own_scan` 4 files. **OneDrive/Dropbox: NOT RUN** (a runner has neither) |
| S4 | keystore | `PASS` on a runner; locked-profile and roaming behaviour `NOT RUN` | Credential Manager via `keyring` `windows-native`: set 13.3 ms, get equals, exists, delete, gone afterwards; the app's own `keystore` suite: set/exists/delete ok, **`token_get` is not a command** ("not allowed by ACL"); nothing remained in `cmdkey /list` |
| S5 | notifications | `PARTIAL` | the `notify` suite returned ok (the plugin call succeeded). A toast cannot be observed on a headless runner; whether it is shown, or suppressed by Focus Assist, `NOT RUN`. Scheduled-with-app-closed: unchanged (`FAIL` by design on desktop, R-59) |
| X1 | single instance | `PASS` | second launch exited in **0.03 s** (code 0); exactly one `atlas-spike.exe` remained; the first instance received the second's argv (`--second-launch marker`) and cwd |
| S9 | footprint | `PASS` start, memory `review` | **first launch after install: 7.5-10.6 s to the harness report** (WebView2 profile creation), then **1.1-2.0 s** for the next launches (Linux: 0.18-0.23 s to page JS; the Windows number includes process start, window creation and an IPC report, measured from outside, so not comparable one-to-one). Idle 30 s with the harness window: `atlas-spike.exe` 30 MB + six `msedgewebview2.exe` processes, **sum of working sets 316 MB** (working set double-counts shared pages; a runner has no GPU and the window may be unfocused; the checklist asks for 10 minutes with 5 000 notes). Installer 2.9 MiB |
| S10 | supply chain, Windows graph | `PASS` | `cargo audit` 0 vulnerabilities, 8 warnings that are all outside the Windows graph; 329 packages, no GPL/AGPL/LGPL, 5 MPL-2.0 (details `DEPENDENCIES.md`). Artifact `atlas-spike-windows-supply-chain` |
| S1 | the Atlas UI in WebView2 | `NOT RUN` | the harness page (probe) ran in WebView2 156 (`Chrome/156 Edg/156`, secure context `http://tauri.localhost`; every CSS/API feature in S1.1 reports present, including `:has()`, Popover, `dvh`, `color-mix`, `light-dark()`, subgrid, `inert`). That shows the feature probe, **not** the 20-step scenario against a running Atlas, IME or typing latency |

**Verdict effect.** Windows has now cleared its **mechanical** part: the build works, a 2.9 MiB per-user installer exists, the signed update flow is correct, and the only Windows-specific code defect found (W1) was a one-line, cheaply fixed bug.
The verdict in 13.2 stays **conditional**: the criteria that could trigger the Electron fallback (S6/S7 "unusable on the owner's work laptop": a UAC prompt, a policy block, WebView2 not installable, SmartScreen or AV
blocking an unsigned binary) are exactly the ones a hosted administrator runner cannot test. Nothing here moves the decision towards Electron; nothing here removes the condition. No ADR changes.

**What the owner does (about 20 minutes, on the work laptop, as the normal standard user; no build tools needed).**

```sh
gh run list --repo Mauz92/atlas --workflow windows-spike.yml --limit 5           # pick the latest green run id
gh run download <id> --repo Mauz92/atlas -n TEST-ONLY-atlas-spike-windows-installers -D atlas-spike-win
gh run download <id> --repo Mauz92/atlas -n atlas-spike-windows-results -D atlas-spike-win-results     # optional: the numbers above
```

In `atlas-spike-win` look for `v1\Atlas Spike_0.1.0_x64-setup.exe` (the installer, 3.0 MB), `v2\Atlas Spike_0.2.0_x64-setup.exe` (+ `.sig`), `updater-test-set\{valid,tampered,wrongkey}\latest.json` (each folder holds the
0.2.0 installer; `latest.json` points at `http://127.0.0.1:18777/`), `updater-public-key.txt`, `update-server.mjs` and the `.ps1` scripts. The artifact is **TEST-ONLY**: signed by a key that existed only on that runner, binaries
unsigned (expect SmartScreen), retention 14 days. Then (checklist steps 6-7): (1) **double-click the 0.1.0 installer as the standard user and write down every prompt** (UAC, SmartScreen, AV, "WebView2 is
required"), the install folder (expect `%LOCALAPPDATA%\Atlas Spike`) and whether Start-menu shortcut and uninstall entry appear under your user; (2) start the app twice (X1), note the cold start with a stopwatch; (3) for the updater, install 0.1.0, then
run `node update-server.mjs updater-test-set\valid 18777` (needs Node; or `python -m http.server 18777 --bind 127.0.0.1` inside that folder), set `SPIKE_SUITE=updater` and `SPIKE_OUT=C:\tmp\upd` in the same console and start the installed
`atlas-spike.exe`: PASS = it ends, the version becomes 0.2.0 (Settings > Apps, or the exe's Details tab) with no elevation prompt; repeat for `tampered` and `wrongkey` after reinstalling 0.1.0 (expect it to stay 0.1.0). (4) Optional: the OneDrive/Dropbox
watcher repeat needs `spike-headless.exe` (built by the workflow into `target\release`, not uploaded; ask for it to be added to the artifact if the work laptop may run it). A FAIL on (1) or (3) (admin needed, policy
blocks the exe or the WebView2 download, AV quarantine) is the Electron trigger in 13.2.

**Actions minutes used (private repository, so Windows minutes are billed at 2x).** Four manual Windows runs, windows-latest job time rounded up per job: 17 + 18 + 20 + 11 = **66 job minutes = about 132 billed minutes**
(two of the runs failed on script bugs; the first build is cold, later ones use the cache); the four `ubuntu-latest` supply-chain jobs used about 11 more. Each future run costs about 11-12 Windows minutes (about 24 billed) with a warm cache, about 18-20
(about 40 billed) cold, and the job is time-boxed (`timeout-minutes: 75`, 15 for each of the smoke and updater steps). The workflow is not triggered by push or pull request. The GitHub plan's included minutes are not visible to this account (the billing API needs the `user` token scope); on GitHub Free the allowance is 2 000 minutes per month.

### 13.4 Android checklist (owner's phone; two Android versions if possible; one with an aggressive vendor battery manager)

Not attempted here (SDK, NDK, JDK, device). Requirements: JDK 17+, Android SDK (platform 34/35, build-tools, platform-tools) and NDK (`NDK_HOME`, `ANDROID_HOME`, `JAVA_HOME`), Rust targets
`aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android`, `adb`. On Arch: `sudo pacman -S jdk17-openjdk android-tools` plus the Google command-line tools and
`sdkmanager --licenses` (licence acceptance is the owner's). The spike's `lib.rs` needs `#[cfg_attr(mobile, tauri::mobile_entry_point)]` and `#[cfg(desktop)]` around `single-instance`, `updater` and the Linux-only `snapshot`
before `npx tauri android init` / `npx tauri android build --apk --debug` / `npx tauri android dev`. For each row record device, Android version, System WebView version
(`adb shell dumpsys webviewupdate`).

| # | What to run | PASS | FAIL leads to |
|---|---|---|---|
| S1 | Run `ui/scenario.js` and `__editorPerf` through `chrome://inspect` (debug builds are inspectable); IME with the phone keyboard (Gboard, a CJK keyboard); keyboard-over-editor, notch, safe areas, `(hover: none)` sheets | scenario facts match Chromium phone emulation; no editing defect; typing p95 < 50 ms | PWA (A-09) for Android |
| S2 | rusqlite (bundled SQLite via NDK clang) on device; kill test: loop `adb shell am start`, random 20-300 ms, `adb shell am force-stop`, then verify with a debug command; foreground sync of 1 000 changes with the real `sync-core` | 0 inconsistent states in 100 kills; sync < 3 s | own commands failing to build/run: no Android shell |
| S3 | fs plugin only reaches the app folder by default; a user-chosen shared folder needs `MANAGE_EXTERNAL_STORAGE` or the Storage Access Framework (`ACTION_OPEN_DOCUMENT_TREE`) through a small Kotlin plugin; inotify does not work on SAF URIs, so measure scan time of 2 000 files via SAF and a scan on resume/WorkManager | folder picked, `.md` read/write/atomic replace, scan complete | notes live in the app folder + export/import (ADR-0059 D10 revisit) |
| S4 | No official keystore plugin: candidates are a small Kotlin plugin (AES-GCM key in Android Keystore, ciphertext in app-private storage; do not use deprecated `security-crypto`) or a community plugin (licence/maintenance check first); `android:allowBackup="false"` | store/read/delete, survives restart, absent from `adb backup`, removed on uninstall | no safe store: Android cannot sign in |
| S5 | `plugin-notification` scheduled local notification (AlarmManager); Android 13+ `POST_NOTIFICATIONS` runtime permission; exact alarms need `SCHEDULE_EXACT_ALARM`/`USE_EXACT_ALARM` (Play policy); screen off, unplugged 30+ min, then `adb shell dumpsys deviceidle force-idle`; app swiped away; tap opens the task (deep link) | fires with app swiped away and in Doze, delay recorded, tap navigates | reminders keep the Web Push/PWA path (A-09, FCM review ADR-0007) |
| S6 | updater is desktop-only: record "n/a"; updates by APK sideload/F-Droid/Play | recorded | none |
| S8 | WorkManager periodic job via Kotlin plugin: pull at the >= 15 min cadence with the app closed, survives reboot, honours battery optimisation and app standby buckets; force with `adb shell cmd jobscheduler run -f <package> <jobId>` and watch `dumpsys jobscheduler`; test the vendor "protected apps" case (dontkillmyapp.com) | runs within the documented cadence on both devices | sync only while open + push wake (FCM) or PWA |
| S9 | APK size (universal vs per-ABI), `adb shell dumpsys meminfo <package>` idle after 10 min, `adb shell am start -W` cold start | cold start < 2 s; record the rest | review |
| S10 | mobile capability file; `cargo audit`; the Android-only crates; **network:** cleartext `http://` is blocked by default and user-installed CAs are not trusted by apps without a `networkSecurityConfig`, so the owner's server needs a publicly trusted certificate (e.g. the tailnet certificate); the emulator reaches the host at `10.0.2.2` | as plan | record |

**Cross-compiling only** (`cargo ndk -t arm64-v8a build`, or `npx tauri android build` without a device) would tell whether the crates compile for Android (bundled SQLite and `ring` need NDK clang), the `.so`/APK size and the Gradle toolchain, and would
surface the mobile-entry-point and `cfg(desktop)` gaps above. It would **not** tell anything about WebView behaviour, Keystore, scheduling, Doze, SAF or vendor battery managers.
