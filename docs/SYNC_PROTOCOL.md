# Atlas — Local-first Sync Protocol

**Status:** PROPOSED design (2026-11-03). Nothing in §3 onward is implemented. Decisions that need the owner
are in `DECISIONS.md` ADR-0059 (PROPOSED); until it is accepted this file describes a target, not behaviour.
**Scope:** how a local-first client (Tauri desktop, Tauri Android; ADR-0055) and the existing web app keep
tasks, projects, notes and their links converged with the self-hosted server. Calendar-provider sync is
`CALENDAR_SYNC.md`; note file rules are `MARKDOWN_STORAGE.md`; entity fields are `DATA_MODEL.md`.

Legend: **[EXISTS]** verified by reading code/tests on 2026-11-03; **[GAP]** needed by ADR-0055 and missing or
wrong today; **[NEW]** proposed; **[UNVERIFIED]** not checked.

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
| Feed integrity for notes | `NotesReconciler` (external edit/add/remove, `POST /api/notes/reconcile`, the `notes.reconcile` job) bumps `revision` and tombstones but **never calls `ChangeRecorder`**; `reindex_note` neither. Edits, new files and removals made on the server filesystem never appear in `/api/changes`. | Every revision bump is recorded | **High (bug)** |
| Server restored from backup | `since > change_seq` returns an empty page with `next_since = since`; the client stays "up to date" while the server has lost changes it already pulled/pushed. | `resync_required(reason=cursor_ahead)` | **High** |
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
| Ordering | `users.change_seq` increment takes a row lock held until commit, so seq order = commit order, gap-free. Verified by reading `ChangeRecorder` and ADR-0032; **concurrency under real contention is not exercised by a test** (the feed tests are sequential HTTP). The lock also serialises all of a user's mutations, including note writes done while the transaction is open. | Keep; test it | Medium (test gap) |
| Pagination | `limit` 1–500, `has_more`, `next_since`; one row per entity so no duplicates in a page. Sound. | Keep | — |
| Idempotency | `Idempotency-Key` on task/project POST/PATCH/DELETE/restore and `POST /notes/{id}/tasks`; per-user, request-fingerprint checked. **No key on note create/update/move/delete.** Keys are never purged (no job found) — grows unbounded but cannot expire under an offline client. | Keys on every write; TTL ≥ tombstone retention | Medium |
| Client | Browser only. Queue (`offlineQueue.ts`) knows `task` and `project` only; **no production code enqueues**; the UI autosave engines (ADR-0053/0054) are online-only (R-22). `useReconciliation` is mounted only in Settings → Sync. The "cache" holds change metadata, not entities. | Shared sync core with a real local store | **High (by design: ADR-0055 is future work)** |
| Attachments / binary files | `NotesStorage.list_notes` walks only `*.md`; other files in the notes root are ignored (never indexed, never deleted). MARKDOWN_STORAGE §2 allows relative-path attachments, but the server neither stores nor serves them via the API. | Decide (ADR-0059 D10) | Medium |
| Rename / move | `POST /notes/{id}/move` keeps the id, bumps revision, takes **no base revision**; folder rename = N note moves, each recorded. An *external* rename is reconcile's "tombstone old path + new id at new path". Empty folders are not entities and not recorded. `uq_notes_user_id_path` includes tombstones, and `create` revives a tombstone at the same path (same id). | Move as a "simple field"; partial unique index on live paths | Medium |
| Auth for non-browser clients | Cookie session + double-submit CSRF only (`get_current_user`, `CsrfMiddleware`). No bearer/device credential. `notification_devices` is push registry only. In-process, IP-keyed rate limiter (R-SEC-1). | Device credentials | **High** |
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
| `resolution` | PostgreSQL | none | none | §9 record | [NEW] |
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
| `types=task,project,…` | Only these entity types are returned. The cursor still advances over filtered-out items. The client lists the types it understands; see §10 for why. |

Response (additions in bold): `changes[] {entity_type, entity_id, operation, cursor, changed_at, **revision?**, **data?**}`,
`since`, `next_since`, `has_more`, `resync_required`, **`resync_reason?`** (`below_floor` | `cursor_ahead`),
**`head`** (current `users.change_seq`), **`floor`**.

Semantics:

1. **Total order.** Items are ordered by `cursor` (unique per user, assigned under the user-row lock, gap-free
   because a rolled-back transaction rolls the counter back). Verified by reading; to be proven by SYNC-01's
   concurrency test.
2. **State-based, not log-based.** One item per entity at its latest cursor. `data` is read at response time and
   may be newer than `cursor`; the entity then appears again later with a higher cursor and the same or newer
   `revision`. Clients apply by revision: `incoming.revision <= local_server_revision` ⇒ no-op.
3. **`since = 0` is a snapshot** [NEW, changes ADR-0033]: it returns every live entity (upserts) and **no**
   tombstones, because a client with no state has nothing to delete. This requires that `upsert` rows are never
   purged (§5). A device bootstraps by paging from `0` to `has_more=false`; no separate bootstrap endpoint.
4. **Snapshot under concurrent writes.** An entity changed during the walk moves to a higher cursor and is
   delivered again before the client reaches `head`; so "walk until `has_more=false`" is complete.
5. **Cursor ahead** [NEW]: `since > head` ⇒ `resync_required`, `resync_reason=cursor_ahead` (server restored from
   an older backup, or a different server). Client behaviour in §7.4.
6. **Apply atomically.** The client writes the page's entities and the new cursor in **one local transaction**.
   A crash re-delivers the page.
7. **No foreign keys on the client** between synced entities; a task may reference a project that arrives in a
   later page.

## 5. Retention [NEW, supersedes ADR-0033's purge scope if ADR-0059 D2 is accepted]

- `change_log` keeps **one row per entity** for as long as the entity exists, so upsert rows are bounded by the
  number of entities and are never purged.
- Only `delete` rows older than `change_tombstone_retention_days` (proposed default **90**, configurable,
  ≥ 30) are purged; `change_purge_floor` is raised to the highest purged tombstone seq.
- A client with `0 < since < floor` gets `resync_required (below_floor)`. A client with `since = 0` is always served.
- Entity tombstones in their own tables are never purged (unchanged).

## 6. Push: existing write endpoints in *sync mode* [NEW]

A client opts in per request with the header `Atlas-Sync: 1` (the protocol major, §10). Without it every
endpoint behaves exactly as today (the web app is unaffected). In sync mode:

### 6.1 Common

- `Idempotency-Key: <uuid>` is **required** on every write (add the missing support to note create / update /
  move / delete). Same key + same body ⇒ the stored response is replayed (`Idempotency-Replayed: true`). Same
  key + different body ⇒ `409 idempotency_mismatch` (a client bug; do not retry). Keys are retained for at least
  the tombstone retention (job to add; today none expires).
- `base_revision` is **required** on update / delete / move (today optional ⇒ blind overwrite).
- Creates accept an optional client `id` (UUID; version 4 or 7). Same `id` + same body ⇒ replay; same `id` +
  different body ⇒ `409 id_exists`; an `id` owned by another user ⇒ `409 id_exists` (no disclosure). Without `id`
  the server assigns one as today.
- Every write response adds `sync: {revision, resolution?: Resolution[]}`; a merged or auto-resolved write
  returns the full resulting entity so the client can replace its base.
- Errors use `{error: <code>, detail, current_revision?, conflicts?}`. Codes in §8.

### 6.2 Tasks and projects (field-level merge)

New column `field_revisions jsonb` on `tasks` and `projects`: `{field: revision at which the field last changed}`
(fields are the writable columns plus `tags`). Maintained by the service on every write; backfilled to the
current `revision` for existing rows (so an old base never merges silently across a pre-migration change).

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

Identity: the note `id` (client-generated allowed) is the identity; `path` is a mutable simple field.

| Operation | Endpoint (existing) | Sync-mode additions |
|---|---|---|
| Create | `POST /api/notes` `{path, content, id?}` | `id`; path already taken by a live note ⇒ server picks `name (2).md` and logs `path_collision` (response carries the final path; the client renames its local file) |
| Content update | `PUT /api/notes/{id}` `{content, base_revision, base_hash}` | `base_hash` required; merge below |
| Move / rename | `POST /api/notes/{id}/move` `{path, base_revision}` | independent of content (a stale revision does not reject a move); target taken ⇒ `409 path_exists`; two devices moving the same note ⇒ later wins, logged |
| Delete | `DELETE /api/notes/{id}` | `base_revision` required; stale ⇒ `409 edit_wins` (rule 4); the file is moved to `.atlas/trash` as today |
| Edit of a deleted note | `PUT` | revive: the content is restored at its old path (or `name (2).md` if taken), logged `edit_wins_over_delete` |
| Read | `GET /api/notes/{id}` | unchanged; `ETag: "<content_hash>"` and `If-None-Match` added so a client with the same hash gets `304` |
| History | `GET /api/notes/{id}/history`, `GET /api/notes/{id}/history/{revision}` | [NEW] list and read retained revisions (also serves undo and users) |

**Three-way merge** (`PUT` in sync mode, when `base_revision != revision`):

1. The server looks up the retained content for `base_revision` and checks `sha256 == base_hash`. Missing or
   mismatching ⇒ no merge is attempted: `409 conflict (reason=base_unavailable)`, the client sends the conflict
   copy path (as ADR-0054 today). Never merged on a guess.
2. `merge3(base, theirs=server_current, ours=incoming)`, line-based. A clean merge ⇒ write atomically, new
   revision, response `{merged: true, content, revision, resolution}`; the merged text is returned so the client
   replaces its file. The *pre-merge* current content is retained in history (recoverable). Any overlap ⇒ `409
   conflict (reason=overlap)` with `{server_revision, server_hash}`; client keeps its text and creates the
   conflict copy (`POST /notes/{id}/conflict`) — today's behaviour.
3. Safety checks before accepting a clean merge: result is valid UTF-8, ≤ `MAX_NOTE_BYTES`, front matter (if
   any in either side) still parses as YAML or is byte-identical to one side; otherwise treated as overlap.
   Merge algorithm/library is chosen in SYNC-04 after a licence and behaviour check (`git merge-file` as an
   external tool, a maintained diff3 library, or a documented in-repo implementation); **not yet chosen**.
4. History: last 20 revisions **and** everything newer than 90 days, stored as files under
   `<notes-root>/.atlas/history/<note_id>/<revision>.md` (UTF-8 bytes, hash in an index row), written in the same
   operation as the revision bump. Pruned by a job. History is covered by backups (extend ADR-0041 scope).

Reconcile (external edit on the server filesystem) records a feed change for every revision bump (SYNC-01) and
retains the pre-edit content in history when the previous file bytes are known (they are not if the file was
changed before the first reconcile; then there is no base and a stale client conflicts).

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
normal create path (client ids make that idempotent). Never automatic. An operator command to record that a
restore happened (and to warn connected devices) is a SYNC-01 deliverable; the exact UX is open (ADR-0059 D12).

7.5 **Storm control**: after a `resync_required` a client may not resync again within 10 minutes without user
action, and at most one resync is in flight per device; the server rate-limits snapshot pages per device (§8.3).

---

## 8. Errors, retries, limits

### 8.1 Status mapping (sync mode)

| Status / `error` | Meaning | Client action |
|---|---|---|
| 2xx | applied (or replayed) | remove op, store `sync` block |
| 200 with `sync.conflicts` | partially applied | store applied fields, surface conflicts |
| 401 `unauthenticated` / `token_revoked` | credential invalid | stop; keep queue; ask to sign in again (never retry blindly) |
| 403 `forbidden_scope` | token cannot do this | permanent for the op |
| 404 `not_found` | unknown id (tombstoned entities are not 404, §6.2) | permanent |
| 409 `stale` / `conflict` / `edit_wins` / `path_exists` / `id_exists` | structured, never overwritten | resolve per §6; do not blind-retry |
| 409 `idempotency_mismatch` | key reused with another body | permanent, report a bug |
| 413 `too_large` | body > limit | permanent; mark item "too large to sync" |
| 422 | validation | permanent; keep the user's text, show the server message |
| 426 `sync_version_unsupported` | `{min,max}` | stop syncing; "update required" (§10) |
| 429 | rate limited | honour `Retry-After`, then retry same request |
| 5xx, timeout, connection loss, aborted response | outcome unknown | retry the **same** request (same key) with backoff |

### 8.2 Backoff

Exponential, base 2 s, factor 2, cap 5 min, full jitter, reset on success; at most one push stream per device;
network-change and app-focus events trigger an immediate attempt (once). The same constants as the calendar
adapters where they already exist (`backoff` unit tests).

### 8.3 Limits (proposed, configurable)

JSON write body ≤ 256 KiB except note content ≤ `MAX_NOTE_BYTES` (5 MiB, unchanged; JSON overhead means the
proxy limit must be ≥ 6 MiB — **[UNVERIFIED]** that the shipped nginx/compose config allows it; no
`client_max_body_size` was found in `apps/web/nginx.conf` or `deploy/`, so nginx's default of 1 MiB would reject
large notes through the shipped web container: check in SYNC-04). Rate limits keyed by **device id** after
authentication (not client IP, R-SEC-1): 120 writes/min, 60 feed pages/min, 10 snapshot starts/hour; auth
endpoints keep the login limiter.

---

## 9. Automatic-resolution log [NEW]

Table `sync_resolutions(id uuid, user_id, entity_type, entity_id, field text null, rule text, kept_revision int,
loser jsonb null, device_id uuid null, op_id uuid null, created_at, undone_at null)`. Recorded in the same
transaction as the write and announced as feed entity `resolution` (so every device learns of it through its
normal pull).

- `rule` ∈ `simple_later_wins`, `edit_wins_over_delete`, `note_merged`, `path_collision`, `path_later_wins`.
- `loser` holds the overwritten **value of a simple field** (needed for one-click undo). It never holds a text
  field (`title`, `description`, `name`) or note content: for those, the other version is the current server value
  or a history file. Application logs carry ids, rule and field names only (no values, SECURITY §4).
- Undo: `POST /api/sync/resolutions/{id}/undo` re-applies `loser` as an ordinary sync-mode write based on the
  current revision (conflicts again if the field changed since); notes: the client writes a history revision with
  a normal `PUT`. Retention 90 days, then purged with its feed row.
- Devices show "changed on another device" for resolutions they did not originate (`device_id` differs).

## 10. Devices, credentials, versioning

### 10.1 Device credentials [NEW] (coordinate with AUTH-01)

- `devices(id, user_id, name, platform, app_version, protocol, created_at, last_seen_at, revoked_at,
  token_hash, prev_token_hash, prev_valid_until)`.
- `POST /api/devices` with `{email, password, name, platform}` (same limiter and no-enumeration behaviour as
  login) creates a device and returns a 256-bit random token **once**; only its SHA-256 is stored (same pattern as
  session tokens, `auth/tokens.py`). A QR/pairing-code flow from a signed-in browser is a later alternative.
- `Authorization: Bearer <token>` is accepted on the data endpoints and the sync endpoints; **not** on password
  change, device management, export or backup endpoints (scope `sync`). Bearer requests carry no ambient
  credentials, so CSRF does not apply to them; cookie requests are unchanged.
- Rotation: `POST /api/devices/rotate` returns a new token; the old one stays valid for 24 h (lost response).
  Idle tokens expire after 90 days (configurable). `GET /api/devices`, `DELETE /api/devices/{id}` (Settings →
  Devices). A revoked token gets `401 token_revoked`; the client keeps local data, stops syncing and offers
  sign-in (local data is not wiped without the user asking).
- AUTH-01 interplay: the recovery-code reset (and `atlas-admin reset-password`) must **revoke all device
  tokens** through the same revoke function; a routine password change revokes browser sessions only (D8).
- Client storage: token in the OS keystore only (Windows Credential Manager/DPAPI, Secret Service on Linux,
  Android Keystore-backed storage); never in the SQLite file, logs, or the webview's storage. The webview does
  not receive the token: Rust attaches it (so XSS in a note preview cannot read it). The mechanism per platform is
  **[UNVERIFIED]** and is a spike criterion.
- Transport: HTTPS only. `http://` is refused except `localhost`/`127.0.0.1`/`[::1]` and an explicit
  developer override (the tailnet dev stack, DEPLOYMENT §8a).

### 10.2 Versioning

- **Protocol major** `Atlas-Sync: <int>` header (§6) and `GET /api/instance` gains
  `sync: {protocol: {min, max}, entities: {<type>: <schema int>}, limits, tombstone_retention_days, epoch}`.
  The server accepts `min..max`; it raises `max` for additive changes and `min` only for breaking changes, with
  a deprecation note in `instance` one release earlier. Outside the range ⇒ `426`.
- **Client** stores `protocol` and a local `schema_version`; a local database newer than the app ⇒ the app refuses
  to open it (no downgrade). An older local database is migrated forward with a pre-migration copy kept.
- **Unknown entity types.** The client sends `types=` with exactly what it understands, and records
  `types_synced`. When an upgrade adds a type, the client backfills it with `since=0&types=<new>` before relying
  on it. This is why the cursor can safely advance over filtered items and why an old client never silently
  drops new data. Unknown **fields** are ignored by clients; servers ignore unknown request fields only in
  non-sync mode (sync mode rejects them with 422 so an old client cannot half-write).
- `epoch` (a UUID created at first run, stored in the database) lets a client detect that it is talking to a
  different server than its data came from; a mismatch is a blocking prompt, never an automatic resync.

## 11. Desktop notes folder rules (client obligations, specified here because they affect the protocol)

- Only regular `*.md` files, UTF-8 (invalid UTF-8 ⇒ "cannot sync", file untouched). Ignore dot-directories,
  `.atlas*`, editor backup/swap files; non-`.md` files are never touched, synced or deleted (D10).
- Identity is the note id kept in the local index; the file path is the user-visible name. A file watcher event
  is a hint; a scan (start, focus, every N min) compares size+mtime then SHA-256 of bytes (same function as the
  server: `content_hash`).
- Rename detection: a missing file plus a new file with the same hash in one scan ⇒ `move`; otherwise delete +
  create. Ambiguous duplicates ⇒ create.
- Portable paths: sync mode rejects (server) and the client skips (local) paths that are invalid on Windows
  (reserved names, `<>:"|?*`, trailing dot/space, > 240 chars) or that differ only by case/Unicode normalisation
  from another note.
- Client writes are atomic (temp + rename) and recorded so the watcher ignores them. A file changed locally
  while a server merge result arrives is re-checked by hash before overwrite; if it changed again it becomes a
  new local edit based on the merge result.
- Deletes go to a client trash folder. Files > 5 MiB are listed as "too large to sync".

---

## 12. Open items (not decided by this document)

Merge algorithm/library; history retention numbers; whether the batch endpoint is ever needed; pairing-code
flow; Android notes storage location (D10); calendar projection on devices; whether the web app opts into
sync mode to benefit from field merge; the restore notice UX (D12). All are tracked in ADR-0059 or the SYNC tasks.
