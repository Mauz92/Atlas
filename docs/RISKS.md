# Atlas — Risk Register

**Status:** Draft for approval (Milestone 0)
**Last updated:** 2026-11-03

Severity ∈ {High, Medium, Low}. Status ∈ {Open, Mitigating, Accepted, Closed}.
Every open risk has an owner-milestone and a mitigation. Risks are reviewed at each milestone gate.

---

## High severity

### R-01 — Microsoft tenant restrictions block calendar access
- **Severity/Likelihood:** High / Medium
- **Impact:** REQ-008 unmet for work accounts; OAuth app registration blocked by tenant policy.
- **Mitigation:** Validate OAuth + calendar access with a **real test account in M5 before
  building the adapter UI**. Provide documented app-registration steps for single-tenant and
  multi-tenant scenarios. Fall back to personal-account-only support if a tenant forbids
  delegated scopes, and document the limitation.
- **Owner milestone:** M5. **Status:** Open.

### R-02 — Calendar synchronisation conflicts or duplicates
- **Severity/Likelihood:** High / Medium
- **Impact:** Data loss or duplicate events across Google/Microsoft.
- **Mitigation:** Provider-specific adapters; explicit ownership; store provider version/etag;
  advance cursors only after commit; idempotent upserts keyed by provider event ID; conflict
  preservation instead of last-write-wins. Integration tests per `TESTING.md` §3.
- **Owner milestone:** M5–M6. **Status:** Open.

### R-03 — Markdown data loss
- **Severity/Likelihood:** High / Low
- **Impact:** Loss of user notes (irreplaceable).
- **Mitigation:** Atomic writes (temp + rename); revision/content-hash checks; conflict copies
  instead of overwrite; soft-delete to a recoverable location; automated file backups. No
  silent last-write-wins.
- **Owner milestone:** M2. **Status:** Open.

### R-04 — Mobile push limitations / platform cost
- **Severity/Likelihood:** High / Medium
- **Impact:** Reminders unreliable, or Apple membership cost surprises the user.
- **Mitigation:** Validate on physical devices in M8; document iOS Apple Developer requirement
  up front (ADR-0007); handle invalid tokens, receipts and retries; never promise instant
  delivery. Present alternatives (PWA/desktop, email fallback) if push is unavailable.
- **Owner milestone:** M8. **Status:** Open.

### R-05 — Background-job library maintenance (Procrastinate)
- **Severity/Likelihood:** High / Medium
- **Impact:** Chosen queue becomes unmaintained; sync/reminders at risk.
- **Mitigation:** Hide the queue behind the `jobs` module interface; keep schema generic;
  documented fallback to APScheduler + SQLAlchemy job store or a `SKIP LOCKED` queue
  (ADR-0005). Re-evaluate at M1.
- **Owner milestone:** M1. **Status:** Mitigating.

### R-06 — Excessive architecture complexity / scope creep
- **Severity/Likelihood:** High / Medium
- **Impact:** Project stalls; maintenance burden exceeds benefit.
- **Mitigation:** Modular monolith, few services; milestone gates; excluded-feature list in
  PRODUCT_SPEC §4.2; scope changes require a documented decision.
- **Owner milestone:** Continuous. **Status:** Mitigating.

### R-07 — Offline/concurrent edit conflicts
- **Severity/Likelihood:** High / Medium
- **Impact:** Divergent device state or lost edits.
- **Mitigation:** Revision-aware mutations; durable client-side pending queue; idempotency keys;
  tombstones; conflict states surfaced in UI. Tested in M7.
- **Owner milestone:** M7. **Status:** Open.

### R-08 — Backup restoration failure
- **Severity/Likelihood:** High / Low
- **Impact:** Unrecoverable loss despite backups existing.
- **Mitigation:** Back up **both** PostgreSQL and the Markdown directory; automated integrity
  check; a **tested** restore procedure executed in M9 (demonstrated, not documented only).
- **Owner milestone:** M9. **Status:** Open.

### R-09 — Workplace data-policy violation
- **Severity/Likelihood:** High / Low
- **Impact:** Corporate policy breach by storing work calendar/task data on a personal server.
- **Mitigation:** Document data flows and dependencies; require explicit user acknowledgement
  before connecting a work account; never bypass tenant security policy (ADR-0006).
- **Owner milestone:** M5. **Status:** Open.

### R-10 — AI-generated regressions
- **Severity/Likelihood:** High / Medium
- **Impact:** Subtle bugs merged because generated code "looks right".
- **Mitigation:** Small changes; automated unit/integration/E2E tests; no milestone passes
  without evidence; adversarial review of diffs.
- **Owner milestone:** Continuous. **Status:** Mitigating.

---

## Medium severity

### R-11 — External provider API changes
- **Severity/Likelihood:** Medium / Medium
- **Impact:** Adapter breakage after provider updates.
- **Mitigation:** Isolate provider code behind adapters; pin client library versions; contract
  tests against sandbox/test accounts; keep adapters small.
- **Owner milestone:** M5+. **Status:** Open.

### R-12 — Licensing incompatibility
- **Severity/Likelihood:** Medium / Low
- **Impact:** A dependency's licence forbids the intended commercial/personal use.
- **Mitigation:** Maintain a dependency inventory; check licence before adding; record in
  DECISIONS; avoid copyleft libraries that would restrict distribution. Audit in M9.
- **Owner milestone:** M1 (inventory), M9 (audit). **Status:** Open.

### R-13 — Google OAuth refresh-token expiry (Testing mode)
- **Severity/Likelihood:** Medium / High
- **Impact:** Calendar sync stops after ~7 days; user must re-authenticate repeatedly.
- **Mitigation:** Publish the OAuth app to **Production** (unverified) for personal use; verify
  real refresh-token lifetime with a test account in M5; document the trade-off (unverified
  screen / 100-user cap for sensitive scopes). See ADR-0008.
- **Owner milestone:** M5. **Status:** Open.

### R-14 — Time-zone and recurrence correctness
- **Severity/Likelihood:** Medium / High
- **Impact:** Wrong due dates, missed occurrences, DST bugs.
- **Mitigation:** Store UTC + IANA zone; RRULE-based recurrence via a maintained library;
  explicit DST and occurrence tests before release.
- **Owner milestone:** M3. **Status:** Open.

### R-15 — Notification duplication or missed reminders
- **Severity/Likelihood:** Medium / Medium
- **Impact:** User loses trust in reminders.
- **Mitigation:** Durable reminder state; idempotent delivery attempts; cancel on entity change;
  record failures; test worker restart behavior.
- **Owner milestone:** M8. **Status:** Open.

### R-16 — Accidental public exposure
- **Severity/Likelihood:** Medium / Low
- **Impact:** Private notes/tasks/calendar exposed to the internet.
- **Mitigation:** Only `web`/`api` exposed via reverse proxy; DB/worker private; HTTPS required;
  documented reverse-proxy config; no unauthenticated endpoints even in single-user mode.
- **Owner milestone:** M1. **Status:** Open.

### R-17 — Dependency vulnerability
- **Severity/Likelihood:** Medium / Medium
- **Impact:** Exploitable flaw in a pinned dependency.
- **Mitigation:** Automated dependency scanning in CI; pinned, reviewed dependencies; respond
  to advisories; never suppress findings to green CI.
- **Reviewed (M9-04, 2026-10-27):** both real scans were run and are **clean** — `pip-audit` → 0
  advisories over 91 packages; `npm audit` → 0 advisories over 370 packages (all severities 0). No
  finding of any severity exists, so none was accepted or suppressed. The gate is enforced in
  `.github/workflows/ci.yml` and fails the build on an unresolved finding (see `ACCEPTANCE.md` M9-04).
  Status stays **Open** because the risk is continuous (a new advisory can appear at any time).
- **Owner milestone:** Continuous. **Status:** Open.

---

### R-23 — Note drafts and autosave volume (UX-05, ADR-0054)
- **Severity/Likelihood:** Medium / Low
- **Impact:** Unsaved note text is kept in the browser's `localStorage` until the server confirms it. On a
  shared computer that text can be read by the next user of the same browser profile; a very large unsaved note
  may exceed the storage quota and then rely on the server save alone; autosave sends up to one `PUT` per
  second of typing, each rewriting the file atomically.
- **Mitigation:** drafts exist only while text is unconfirmed and are removed on confirmation, on "Reload server
  version" and on delete; storage errors are swallowed so saving to the server still works; one request at a
  time per note. Sign-out flushes unsaved text first and deliberately keeps a draft that could not be saved
  (losing the text is worse). **Not done:** encrypting drafts, a quota warning, cross-tab coordination (two tabs
  editing one note conflict through the normal revision check), a draft store for tasks (UX-04 limitation).
- **Status:** Open (accepted for a single-user, self-hosted instance).

### R-24 — The server normalises CRLF to LF when it reads a note (found in UX-06)
- **Severity/Likelihood:** Medium / Low (needs notes written with Windows line endings)
- **Impact:** `NoteStorage.read` uses `Path.read_text`, which applies universal newlines, so the API serves a
  CRLF file with `\n`. The index hash is of the normalised text, so a CRLF note created through the API, or
  edited by a Windows editor, shows **Conflict** on the first autosave (the hash of what was written differs
  from the hash of what is read), and saving converts the file to LF. This is true in Source and Live alike
  (UX-06 only made the editor itself faithful: `lib/livePreview.ts` `lineBreakOf`/`documentText`, unit-tested).
  AGENTS.md §8 ("change a note's content format only with an explicit migration").
- **Mitigation / next step:** backend fix, out of scope for UX-06 (no backend changes): read with
  `newline=""` in `NoteStorage.read`, hash the bytes as written, add a CRLF round-trip test. Until then the
  real-stack CRLF byte test is `BLOCKED` (documented in `ACCEPTANCE.md` UX-06).
- **Status:** Fixed 2026-11-03: `NoteStorage.read` decodes the bytes as stored (writes already used `newline=""`). Regression tests: `test_note_storage.py` (line-ending round trips, a CRLF file from another editor) and `test_notes_api.py` (CRLF create, read, save without conflict, exact bytes). Notes already indexed from a CRLF file may show one revision bump when reconciled. The real-stack CRLF byte test (UX-06) can now be added.

### R-25 — Live preview is a display layer over untrusted text (UX-06, ADR-0056)
- **Severity/Likelihood:** Medium / Low
- **Impact:** a flaw in the decoration code could let note text become DOM (XSS), open an unsafe URL, load a
  remote image, or change the document by itself.
- **Mitigation:** the extension creates no HTML from note text; the only elements it builds are three constant
  widgets and an `<input type=checkbox>`; no URL reaches an attribute; links open only for `http`, `https`,
  `mailto` (`safeExternalUrl`, 16 cases) and only on Ctrl/⌘; the corpus test asserts for 19 hostile/tricky
  texts that the editor DOM holds no `script`, `iframe`, `a`, `img[src]`, `style`, event-handler attribute or
  `javascript:` value, and a real-stack spec runs a note with `<img onerror>`, `<script>`, `javascript:` links
  and a tracker image. **Not done:** fuzzing the Lezer tree against arbitrary Markdown; per-element (rather
  than per-line) revealing; IME composition inside a rendered line was not tested with a real IME.
- **Status:** Open (accepted; re-test whenever the decoration set or CodeMirror major version changes).

### R-26 — Board key moves rely on a client copy of the status table and on re-focusing a re-created card (UX-07, ADR-0057)
- **Severity/Likelihood:** Low / Low
- **Impact:** `[` / `]` use `adjacentStatus` over the client copy of the server's transition table
  (`lib/taskStatus.ts`); if the server table changes and the copy does not, the key proposes a move the server
  rejects (reported on the page, the card does not move; no data is changed). After a move the card is a new DOM
  node, so keyboard focus is restored by an effect keyed on the new status; a missed restore leaves focus on
  `body`, an annoyance for keyboard users, not data loss.
- **Mitigation:** the server re-validates every move; unit tests pin `adjacentStatus` against the same table the
  existing board tests use; a real-stack spec drives `]` / `[` and asserts focus and the stored status. The
  re-focus expires after 5 s so a failed move never steals focus later.
- **Status:** Open (accepted; revisit when the transition table gains a server endpoint).

### R-27 — Old addresses depend on redirects; a Settings section keeps no state once left (UX-08, ADR-0058)
- **Severity/Likelihood:** Low / Low
- **Impact:** `/sync`, `/notifications` and `/calendar` exist only as redirects to `/settings/<section>`
  (bookmarks, the status bar of an older cached build, external links); a typo'd or future section name redirects
  to `/settings`. Only the open Settings section is mounted, so a half-typed password or an in-flight "Sync now"
  state is dropped when the viewer opens another section (the sync data itself lives in the offline queue and the
  API). On a phone `/settings` renders the Account form but hides it with CSS, so it is present for assistive
  technology only if the CSS fails.
- **Mitigation:** the redirect table is one constant (`SETTINGS_REDIRECTS`) covered by unit and real-stack specs;
  `ux08` asserts the phone shows only the list, then only the section; password fields are cleared on success only.
- **Status:** Open (accepted; keep the redirects at least as long as AUTH-01 and the native client are pending).

## Low severity

### R-18 — PostgreSQL full-text search limits at scale
- **Severity/Likelihood:** Low / Low
- **Mitigation:** FTS is sufficient at household scale; revisit only with measured need.
- **Owner milestone:** M2. **Status:** Accepted.

### R-19 — Docker availability on the user's server
- **Severity/Likelihood:** Low / Low
- **Mitigation:** Document prerequisites and a Compose-based install; no Docker-in-Docker or
  Kubernetes dependency.
- **Owner milestone:** M1. **Status:** Accepted.

### R-20 — Task text search is an unindexed substring scan
- **Severity/Likelihood:** Low / Low
- **Description:** `GET /api/tasks?q=…` matches with an escaped `LIKE '%…%'` over `title`/
  `description` and `project_id` has no index yet, so both scan the user's rows and the listing is
  capped at `limit` (default 200).
- **Mitigation:** Fine at the intended personal scale (ADR-0018); the response is bounded, the
  term is length-bounded and parameterised, and the filters rely on the existing `user_id`/
  `status`/`priority`/`due_at` indexes. Revisit with measured need (a `tsvector` column + GIN
  index for search, an index for `project_id`) — the `project_id` index belongs to M4. M4-02 added
  the project-tasks listing on the same access path (per user, per project, bound by `limit`) and
  deliberately did **not** add the index: the statement is an index scan on `tasks.user_id` plus a
  filter, no measured need exists, and every schema change costs a migration (ADR-0021).
- **MU-05 update (2026-11-02, ADR-0047):** the **search** access path is now indexed — `GET /api/search`
  uses word-prefix full-text matching on GIN expression indexes (`ix_tasks_search_fts`,
  `ix_projects_search_fts`, migration `a8c4d9e2b7f1`) plus the existing note index, and a test proves the
  planner uses them. **Still open:** the `GET /api/tasks?q=` filter remains an escaped substring scan
  (it matches inside words, which the index does not), `tasks.project_id` is still unindexed and the Tasks
  page still sorts client-side over the first 500 matches (ADR-0045). Residual severity unchanged (Low).
- **Owner milestone:** M3. **Status:** Accepted (search path mitigated by MU-05).

### R-21 — Web Push destination endpoint is not scheme/host-constrained
- **Severity/Likelihood:** Low / Low
- **Description:** A registered push destination (`notification_devices.endpoint`) is validated for
  length and shape (`atlas/notifications/registry.py`) but not restricted to an `https` push-service
  host, and the delivery path targets that URL directly (pywebpush). Raised by the M9-05 security
  review; no exploitable impact exists in the delivered single-user deployment.
- **Impact:** In a **multi-user** deployment with an attacker able to register a destination, the
  send would fetch an attacker-chosen URL (a blind-request/SSRF-shaped surface). Today the registrant
  is the only account (single-user), so any effect is self-directed.
- **Mitigation:** Destinations are strictly user-scoped (one account cannot register or target
  another's), and only the user's own active devices are ever sent to. Revisit with a scheme/host
  allow-list (e.g. `https` push-service hosts, or a per-provider allow-list) **if multi-user is ever
  approved** (`DECISIONS.md`); recorded here so it is not silently forgotten.
- **Owner milestone:** M8. **Status:** Accepted (M9-05).

### R-22 — Backend-heavy, interface-light delivery
- **Severity/Likelihood:** High / High (realised — found by the 2026-11-01 function audit)
- **Description:** Tasks were accepted on API tests, so the product accumulated endpoints, tests and
  documentation faster than usable screens. Tasks/Projects/Search/Settings are placeholders and the
  task list can only capture and complete; the owner reports the app as not useful.
- **Impact:** Green test suite and `DONE` roadmap status misrepresent what the owner can do; time
  spent on features nobody can reach.
- **Mitigation:** ADR-0043 — done means a browser journey passes against the real API; milestone MU
  (usable core) precedes further backend/calendar work; the release table is scored on user-reachable
  behaviour; journey tests run in CI (MU-07).
- **Progress:** MU-00 (harness) and MU-01 (task detail, J1/J2) delivered 2026-11-02. Open sub-risk from
  MU-01: task edits from the UI are online-only (idempotency key + `base_revision`, conflict shown); they
  are not yet routed through the offline queue (M7-03), so an edit made while offline fails visibly
  instead of queueing. MU-08 did not change this; address with M8 offline UX.
- **Owner milestone:** MU. **Status:** Mitigating.

### R-28 — Data loss through sync (merge, resolution, delete)
- **Severity/Likelihood:** High / Medium (design stage; nothing implemented)
- **Description:** field merge, three-way note merge, "edit wins over delete" and automatic resolution can silently pick the wrong
  value or drop text; the existing server has none of this yet (`SYNC_PROTOCOL.md` §2).
- **Mitigation:** uncertain ⇒ conflict copy, never a guess; pre-merge versions kept in note history; resolution log with undo;
  simulation invariants "no acknowledged loss" and "no resurrection"; client deletes go to a trash folder; ADR-0059 D4–D7.
- **SYNC-03 (2026-11-03):** task/project field merge, edit-wins and the structured text conflict are implemented and covered by
  `test_sync_writes.py`, the model/real conformance traces and the v1 simulation (`no_silent_text_loss`, `edit_wins`,
  `unexpected_rejection`, with a planted defect for each). **Still open:** note content merge/history (SYNC-04), persisted
  resolution log and undo (SYNC-05: today `sync.resolution` exists only in the response, see R-41).
- **Owner milestone:** SYNC. **Status:** Mitigating (tasks/projects); Open (notes).

### R-29 — Clock skew and clock jumps
- **Severity/Likelihood:** Medium / High (laptops sleep, phones change zone)
- **Description:** wrong device clocks break local reminder times, "today", token expiry display; they must never decide a winner.
- **Mitigation:** server-assigned order only (ADR-0055 §3, ADR-0059 D11); simulation invariant 6 (same result under any offsets);
  server-set timestamps; reminders scheduled from due instants + zone, recomputed on clock change.
- **SYNC-03:** the server never reads `X-Client-Time` (`test_the_device_clock_never_decides`); the simulation compares runs with and
  without jumping client clocks (identical final state) and a planted "order by client time" defect fails it.
- **Owner milestone:** SYNC. **Status:** Mitigating (server verified; client reminders unbuilt).

### R-30 — Resync storms and restore-rewind
- **Severity/Likelihood:** Medium / Medium
- **Description:** a bug in the floor logic, a server restored from an older backup (clients ahead of the server today get an empty
  feed and never notice), or many clients resyncing at once can loop or silently diverge.
- **Mitigation:** SYNC-01 `cursor_ahead` signal (server side done 2026-11-03; client handling and the operator command are not); resync cooldown and per-device snapshot limit; confirm-before-reupload; operator
  runbook; simulation scenario "restore from backup"; `epoch` check.
- **SYNC-03:** `epoch` + `Atlas-Epoch` + `atlas-admin record-restore` implemented and documented (OPERATIONS.md 2.2a); a snapshot walk
  can no longer be interrupted by the floor (`snapshot=true`, found by simulation seed 29, R-38). **Residual:** the operator must
  run `record-restore` after a restore (R-39); client confirmation UX and storm control are SYNC-08; "restore from backup" is not yet
  a random action of the simulation.
- **Owner milestone:** SYNC. **Status:** Mitigating.

### R-31 — Retention shorter than an offline period
- **Severity/Likelihood:** Medium / Medium
- **Description:** today's purge removes every feed row after 30 days, so a returning or new device cannot catch up from the feed;
  a deletion made while a device was away can be unknowable after tombstones are purged.
- **Mitigation:** ADR-0059 D2 (keep upserts, tombstones 90 days, snapshot from 0); resync is non-destructive, pending edits kept
  (rule 4); idempotency keys outlive tombstones.
- **SYNC-03:** implemented (upserts never purged, tombstones 90 days, `since=0` snapshot, keys purged with the tombstones;
  `test_change_purge.py`, simulation with a tombstone purge). A device away longer than 90 days still needs the client-side
  non-destructive resync (SYNC-08). **Status:** Mitigating (server).

### R-32 — Partial apply and cursor ordering
- **Severity/Likelihood:** High / Low
- **Description:** applying a page without storing the cursor atomically (or the reverse) skips or repeats changes; the browser
  KV store keeps the cursor in a separate write from the data (`syncEngine.ts`).
- **Mitigation:** one local SQLite transaction for page + cursor (spike S2); state-based apply by revision (idempotent); no local
  foreign keys between synced entities; crash-point simulation. The user-row lock that orders cursors is now proven by a
  concurrency test (SYNC-01, 2026-11-03: `test_change_concurrency.py`); it also serialises all of a user's writes (so a slow
  transaction that has already recorded a change blocks every other write of that user until it ends).
- **Owner milestone:** SYNC. **Status:** Open.

### R-37 — Lost update: concurrent PATCHes with the same base_revision (found by SYNC-02)
- **Severity/Likelihood:** High / Medium (two devices editing one task/project at once; autosave makes it likelier)
- **Description:** `TasksService.update` reads the row without a lock and checks `base_revision` against that read; the
  `UPDATE` has no revision predicate. Two concurrent requests with the same `base_revision` both pass, the second silently
  overwrites the first, and both responses report the same new revision for different states (8 of 8 attempts in
  `test_two_concurrent_patches_with_the_same_base_revision_cannot_both_win`, currently `xfail(strict)`). Projects use the same
  pattern (not tested). It breaks "revision identifies state", which every sync rule assumes.
- **Mitigation (applied 2026-11-03, SYNC-03):** every write that bumps a revision now loads its row with
  `SELECT ... FOR UPDATE` (`get(..., for_update=True)`, `populate_existing`) before comparing `base_revision`, and holds the
  lock to commit: `TasksService.update/delete/restore`, `ProjectsService.update/delete`, `NotesService.update/delete/rename`,
  and the reconciler's revision bumps (it re-reads the row under lock first). A concurrent writer with the same base waits,
  re-reads the bumped row and gets the existing `409` with `current_revision`. The row lock was chosen over
  `UPDATE ... WHERE revision = :base` because the update path does much more than one `UPDATE` (series, tags, subtasks,
  file write for notes), so the check must cover all of it. **Lock order** (no cycle): entity row(s) first, then the user's
  change cursor (`ChangeRecorder`, taken last in every write); bulk task locks are taken in `id` order
  (`delete` promoting children, `_unfile_tasks`); the reconciler records its feed entries after all row changes. Writers
  never take the cursor and then wait for an entity row. A losing request writes nothing and does not advance the cursor.
- **Evidence:** `tests/integration/test_revision_races.py` (7 tests, each fails before the fix, passes 3 of 3 runs after),
  `tests/sim/test_sim_conformance.py` (the former `xfail(strict)` test passes strictly, plus a project variant),
  `test_notes_reconcile.py::test_reconcile_and_concurrent_note_edits_do_not_deadlock`.
- **Second race, also fixed (task moved into a project while it is deleted):** a task `PATCH`/create/restore that attaches a task
  to project X checked X unlocked, so `ProjectsService.delete(X)` (which unfiles the tasks it can see) could commit in
  between and leave a live task in a deleted project. Every path that attaches a task now **share-locks the project first**
  (`TasksService._share_projects`, `FOR SHARE`), the project delete holds it exclusively, so they serialise: the task is
  either rejected (`400 project does not exist`) or unfiled by the delete. **Lock order for these paths: project row(s) (id
  order), then task row(s) (id order), then the user's change cursor.** A task update peeks at its current and target project
  (the explicit `project_id`, or the new parent's) before locking the task; if the parent's project changed in between,
  the late lock uses `NOWAIT` and the request fails with a retryable `400` rather than risk a cycle (rare; not tested).
  The simpler order "task, then project" was rejected: it deadlocks when two tasks swap projects while both projects are deleted
  (tested). Row locks are `FOR NO KEY UPDATE`, not `FOR UPDATE`: the first version used `FOR UPDATE`, which conflicts with the
  foreign-key check of a new `task_links` row and deadlocked a note edit against "task from note" (found by test).
- **Evidence for the second race:** `test_revision_races.py` (move vs project delete, create and restore vs project delete, four-way
  swap with both projects deleted, note edit vs task-from-note; 16 rounds each; all fail with the project locks removed, 11 of 11
  pass on 10 consecutive runs).
- **Residual:** a `PATCH` without `base_revision` is still last-write-wins by design (it now serialises, so revisions stay
  unique) until field merge. Audit: the only `base_revision` checks are task `PATCH`, project `PATCH` and note `PUT`; subtask
  and parent changes go through task `PATCH`; reminders and links carry no revision. A tag or series write by two concurrent
  updates of the same task is serialised by the task row lock.
- **Owner milestone:** SYNC-03. **Status:** Fixed locally (2026-11-03; CI not run).

### R-38 - A multi-page snapshot bootstrap could never finish once the purge floor passed its first page (found and fixed in SYNC-03)
- **Severity/Likelihood:** High / High *before the fix*: any device with more than one page of data, after the first tombstone purge
- **Description:** `0 < since < floor` is `below_floor`. Page 2 of a bootstrap walk is at `since` = the cursor of page 1, which is
  below the floor once a tombstone with a higher cursor has been purged, so the client was told to resync, restarted at 0 and
  looped (found by simulation seed 29 at 300 steps; the first design said only "since = 0 is always served").
- **Fix:** pages after the first carry `snapshot=true`; the floor check is skipped for them (cursor-ahead is not). Regression tests:
  `test_a_multi_page_bootstrap_survives_a_floor_above_its_position`, `test_a_snapshot_walk_is_never_below_the_floor`, the v1
  simulation with purges. **Status:** Closed (server); the client must send the parameter (SYNC-08).

### R-39 - A restored server regrows past its clients' cursors and nobody notices
- **Severity/Likelihood:** High / Low (needs a restore and an operator who forgets one command)
- **Description:** `cursor_ahead` only fires while the server head is below the client's cursor. Once the restored server has accepted
  enough new writes the cursors overlap and a client silently skips the changes it never saw.
- **Mitigation:** `epoch` rotated by `atlas-admin record-restore`; clients send `Atlas-Epoch` and stop on `409 epoch_mismatch`;
  OPERATIONS.md 2.2a makes it a restore step. **Residual:** it depends on the operator. A stronger design (the server detects a
  restore itself, for example by recording the highest cursor outside the database) is not built. **Status:** Mitigating.

### R-40 - A late acknowledgement can re-introduce an entity the client's cursor has already passed as deleted
- **Severity/Likelihood:** Medium / Medium (found by the v1 simulation, seed 681)
- **Description:** a snapshot omits tombstones; a client whose create was applied but not yet acknowledged can pass the delete and
  then install the replayed create body as live state.
- **Mitigation:** the rule of `SYNC_PROTOCOL.md` 8.1 (a 2xx body is historical; the acknowledged entity is read again at the next
  pull) plus remembering a tombstone for ids never held. Encoded in the simulation client; `sync-core` must implement both.
  **Status:** Mitigating (client work).

### R-41 - Automatic resolutions exist only in the response until SYNC-05
- **Severity/Likelihood:** Medium / Medium
- **Description:** `sync.resolution` (rule, field, overwritten simple value) is returned to the writer and stored with its
  idempotency record (so a retry sees it), but there is no `sync_resolutions` table, feed entity or undo: other devices are not told
  "changed on another device", and the overwritten value is gone from the server once the idempotency key expires.
- **Mitigation:** SYNC-05 (next); the wire shape is already final. **Status:** Open (by plan).

### R-42 - Note writes in sync mode are only idempotent, not yet merge- or delete-safe
- **Severity/Likelihood:** Medium / Medium
- **Description:** SYNC-03 gave notes client ids, the live-path index, collision renaming and keys, but a stale note `DELETE` still
  wins, a `PUT` of a deleted note is still `404`, and a stale `PUT` is a plain `409 stale` (the ADR-0054 keep-mine flow), so a sync
  client must not rely on rule 4 or merge for notes until SYNC-04. A replayed note write returns the summary, not the content.
- **Mitigation:** SYNC-04 (history, three-way merge, revive, move/delete rules); the sync-mode requirements (`base_revision` on
  delete/move, rejected `base_hash`) keep the contract forward-compatible. **Status:** Open (by plan).

### R-43 - Idempotency table growth and the purge scan
- **Severity/Likelihood:** Low / Medium
- **Description:** every sync-mode write stores a key; with 90-day retention at personal scale (tens of thousands of rows) the hourly
  `DELETE ... WHERE created_at < cutoff` is a sequential scan of `idempotency_keys` (no index on `created_at`). Note keys store a
  summary only.
- **Mitigation:** acceptable now; add `ix_idempotency_keys_created_at` if the table exceeds ~1M rows (measure first, AGENTS.md 4).
  **Status:** Accepted.

### R-33 — Desktop notes folder edited by other programs
- **Severity/Likelihood:** High / High
- **Description:** editors save by rename or swap files, sync tools (OneDrive/Dropbox) touch the folder, watchers miss events,
  files are moved in bulk, invalid UTF-8, case-insensitive and Unicode-normalising filesystems, Windows reserved names.
- **Mitigation:** scan + hash is authoritative, watcher is a hint (MARKDOWN_STORAGE §5, ADR-0010); rename detection by hash;
  atomic self-writes ignored by the watcher; portable-path rules (`SYNC_PROTOCOL.md` §11); unsyncable files listed, never deleted.
- **Owner milestone:** SYNC (SYNC-09). **Status:** Open.

### R-34 — Large notes and request limits
- **Severity/Likelihood:** Medium / Medium
- **Description:** notes up to 5 MiB are sent as JSON; the shipped nginx config sets no `client_max_body_size` (default 1 MiB).
  **Verified 2026-11-03 (SYNC-01 d):** the shipped `apps/web/nginx.conf` in a throwaway nginx 1.27 container returns `413` for
  any request body above 1 MiB (0.99 MiB `200`, 1.01 / 2 / 6 MiB `413`), so **a note larger than about 1 MiB cannot be created or
  saved through the shipped web container today** (a user-visible defect that already exists, independent of sync); direct API
  access and a different reverse proxy are unaffected. Merge cost on large files; desktop files above the cap.
- **Fix (applied 2026-11-03, SYNC-03):** `apps/web/nginx.conf` sets `client_max_body_size 11m;` in `location /api/` and an
  explicit `1m` at server level (static files and SPA stay small). 11m = 2 x `MAX_NOTE_BYTES` + envelope: JSON writes a
  newline, tab, quote or backslash as two bytes, so a 5 MiB note of nothing but those is 10 MiB on the wire (a first version
  used 6m, which fits prose but not that worst case; raised at the owner's request). Operators whose own reverse proxy sits in
  front of the web container must allow at least 11 MiB for `/api/` (`DEPLOYMENT.md` section 8).
- **Evidence:** `services/api/tests/unit/test_nginx_config.py`: a static parse of the shipped file (directive covers
  `2 * MAX_NOTE_BYTES + 64 KiB`, nothing else raised; always runs) and a live probe in a throwaway `nginx:1.27-alpine`
  container (skipped when docker or the local image is missing; never pulls, never touches running containers): 5 MiB + 1 KiB
  and 10 MiB + 64 KiB bodies are not `413` to `/api/`, 12 MiB is `413`, 2 MiB + 1 to `/` is `413`. Against the old file 3 of
  the 4 tests fail. `test_notes_api.py::test_a_maximum_size_note_of_escaped_characters_round_trips` shows the API itself
  accepts and returns a 5 MiB all-newline note (a ~10 MiB JSON body) and refuses one byte more. The owner's running `web`
  container was **not** rebuilt, so it still enforces 1 MiB until the image is rebuilt.
- **Residual:** control characters other than tab and newline cost 6 bytes in JSON (`\u0001`); a 5 MiB note made of those
  would exceed 11 MiB. They are not text anyone writes, and the API still enforces the real limit on the decoded content.
- **Mitigation:** apply the fix above (done); explicit "too large to sync" state; 413 handling; merge time bound.
- **Owner milestone:** SYNC. **Status:** Fixed locally for the shipped config (2026-11-03; image not rebuilt, CI not run); operators with their own proxy must apply the same limit.

### R-35 — Device credential theft and revocation gaps
- **Severity/Likelihood:** Medium / Low
- **Description:** a bearer token outlives a password change; a lost laptop keeps syncing until revoked; keystore availability
  varies (Linux without Secret Service, Android).
- **Mitigation:** SECURITY §12; recovery revokes all (AUTH-01 integration); idle expiry; device list; no file fallback for the token.
- **Owner milestone:** SYNC-06 / AUTH-01. **Status:** Open.

### R-36 — Tauri 2 platform maturity (WebKitGTK, WebView2, Android) and plugin churn
- **Severity/Likelihood:** Medium / Medium
- **Description:** rendering/editing differences across system webviews; Android support younger than desktop; no official keystore
  plugin; updater is desktop-only per the docs; the sql/store/stronghold plugins have `3.0.0-alpha` lines in flight; fs access on
  Android may not allow a user-chosen shared folder (all checked 2026-11-03 against Tauri docs/releases, not by running).
- **Mitigation:** SYNC-07 spike with pass/fail criteria and Electron fallback (desktop); pin 2.x; capability-minimal config;
  PWA fallback for Android (A-09).
- **Owner milestone:** SYNC-07. **Status:** Open.

---

## Review log

| Date | Milestone | Change |
|---|---|---|
| 2026-10-20 | M0 | Initial register created; R-05 and R-13 added from M0 research. |
| 2026-10-26 | M3-08 | R-20 added (task search/project filter scan; bounded by `limit`). |
| 2026-10-26 | M4-02 | R-20 reviewed (project-tasks listing on the same path; `project_id` index still deferred, no measured need). |
| 2026-10-27 | M9-04 | R-17 reviewed: `pip-audit` (91 pkgs) and `npm audit` (370 pkgs, prod+dev) both clean — 0 advisories at every severity. No finding accepted or suppressed; CI gate confirmed by inspection + local positive controls. |
| 2026-10-27 | M9-05 | Security review (threat model vs implementation). R-21 added (push endpoint not scheme/host-constrained; accepted for the single-user model). F1 (SPA missing security headers/CSP) found and fixed in `apps/web/nginx.conf`; R-SEC-1/2/4 re-confirmed, R-SEC-3 resolved. Detail in `docs/SECURITY.md` §"Milestone 9 security review". |
| 2026-11-01 | Audit | Function audit: R-22 added (backend-heavy, interface-light); ADR-0043 re-prioritises to a usable core. |
| 2026-11-02 | MU-08 | R-22 progress: Settings, shortcut help, mobile nav and an axe accessibility gate delivered (J7 passes). Sub-risks: password change signs out all other sessions (no per-device session list); the password limiter is in-process; backup status is only as visible as `BACKUP_DIR` is to the API and does not re-verify checksums; **`npm audit --include=dev` reports a moderate `minimatch` advisory (GHSA-g3hv-75wg-m249) in the eslint/typescript-eslint toolchain — present before MU-08, dev-only, not yet fixed (the fix needs a breaking tooling upgrade), so the 2026-10-27 "0 advisories" claim no longer holds**; no user time-zone setting; MU exit needs a CI run and a release re-score. |
| 2026-11-03 | UX-08 | Settings sections, skeletons and one empty state (ADR-0058): UI-only; R-27 added (old addresses are redirects; only the open Settings section is mounted). No new network call, dependency, icon or stored data; instance info is now requested only by the two sections that show it. Sign-in and first-run gained a `main` landmark (an axe finding). |
| 2026-11-03 | UX-07 | Tasks/Projects/Board polish (ADR-0057): UI-only; R-26 added (board key moves depend on a client copy of the transition table and on re-focusing a re-created card; the server re-validates). Saved views stay per-browser `localStorage` (no cross-device sharing); the Tasks board shows only the filtered tasks. No new security surface: no new network calls, dependencies or stored data. |
| 2026-11-03 | UX-06 | Live preview (ADR-0056): R-25 added (decorations over untrusted text; mitigated by a decorations-only design, a scheme allow-list and a corpus + real-stack DOM check). R-24 added: the server normalises CRLF to LF on read, a pre-existing defect found while testing line-ending round trips (not fixed: no backend changes in UX-06). |
| 2026-11-03 | UX-05 | Notes autosave (ADR-0054): the Save button is gone, so data integrity rests on the save engine; mitigated by a framework-free engine with 27 unit tests (one request at a time, revision chaining, 409 never overwrites, unknown outcome re-read, offline, draft restore) and real-stack specs that check the file bytes, an offline reload and an external edit. New R-23 (drafts in localStorage, request volume). Limitations: delete uses a native confirm; conflicts are copy-or-reload only (no merge); a note edited by another program needs the on-demand reconcile the conflict path now triggers. |
| 2026-11-03 | UX-04 | Task detail autosave (ADR-0053): per-field saves raise request volume and make ordering a data-integrity concern; mitigated by one serialised send loop per task, revision chaining, idempotency-key reuse on unknown outcomes, conflict = no overwrite, rejected text kept, and leaving with unsaved edits asks first (unit + real-stack tests). Remaining: unsaved task edits do not survive a reload while offline or a crash (no local draft store for tasks); mutations stay online-only (R-22). |
| 2026-11-02 | MU-07 | R-22 progress: Today as home, daily note and templates delivered (J6 passes). Sub-risks: "today" is the browser's zone until a user zone setting exists (MU-08); `write_new` needs hard links on the notes filesystem (fails loudly, never overwrites); a renamed daily note is not found again; template text is untrusted and only two placeholders are substituted (no scripting). |
| 2026-11-02 | MU-06 | R-22 progress: note↔task↔project linking delivered (J4 passes). Sub-risks: links exist only for tasks created from a note (no link-existing action); wiki-link text is path-based and not rewritten on rename; an externally renamed file may get a new id and lose task links; link/unlink are online-only. |
| 2026-11-02 | MU-05 | R-20 reviewed: search path indexed (GIN expression indexes, ADR-0047); the task-list `q` filter and `project_id` remain unindexed. R-22 progress: palette and Search page delivered (J5 passes); palette creates are online-only. Limitation: search matches word prefixes, not mid-word substrings. |
| 2026-11-02 | MU-04 | R-22 progress: recurrence, subtasks and per-task reminder delivered in the task detail (journey passes). Sub-risks: an occurrence of a series cannot have its rule changed or removed from the UI (series rule edit/stop is not offered); the "next occurrence" notice finds it by title and series through the task list (≤ 500 open matches); subtask and reminder changes are online-only like other UI mutations. |
| 2026-11-02 | MU-03 | R-22 progress: Tasks page delivered (filters, sort, saved filters, bulk actions; journey passes). Sub-risks: client-side sort covers only the first 500 matches (R-20, page shows a notice); bulk actions are sequential, non-atomic and online-only. |
| 2026-11-02 | MU-02 | R-22 progress: Projects UI delivered (J3 passes in a browser); project mutations are online-only like task mutations. |
| 2026-11-02 | MU-01 | R-22 progress: task detail/editing delivered (J1, J2 pass in a browser). Sub-risk recorded: UI task mutations are online-only (not via the offline queue). |
| 2026-11-03 | SYNC design | R-28…R-36 added (sync data loss, clock skew, resync/restore, retention, partial apply, desktop folder, large notes, device credentials, Tauri maturity). Found while reading M7: reconcile does not feed the change log; purge removes the ability to bootstrap from cursor 0; a restored server is invisible to clients; ADR-0055's "client-generated ids" is not yet true. Detail `SYNC_PROTOCOL.md` §2. |
| 2026-11-03 | SYNC-03 | R-37 mitigated (row lock before the revision check on tasks, projects, notes; lock order documented; tests). R-34 fixed in the shipped nginx config with a static and a live-container test; JSON-escaping worst case recorded. Reconcile now removes a note exactly like `NotesService.delete` (project links dropped and announced). New findings, all fixed: reconcile-vs-edit lock order, task-into-deleted-project race, `FOR UPDATE` vs foreign-key deadlock, nginx 6m too small for escaped notes (now 11m). Harness: model-sim seed 482 was a missing client rule (an acknowledgement, possibly a replay, is a historical snapshot), not a server flaw; fixed in the model client, protocol rule recorded in `SYNC_PROTOCOL.md` section 8.1. |
| 2026-11-03 | SYNC-02 | R-37 added: concurrent PATCHes with one `base_revision` both succeed (lost update). Also learned: a retried request must be byte-identical including `base_revision`, because the server fingerprints the whole body; a client that re-reads the base revision on retry gets `409` on its own key. The production `fullResync` hook is still not supplied (model client implements it by listing). |
| 2026-11-03 | SYNC-01 | R-34 verified as a real defect (shipped nginx rejects bodies above 1 MiB with `413`; fix proposed, not applied). R-32 ordering proven by a concurrency test. R-30: server side of `cursor_ahead` delivered. New finding: `NotesReconciler` tombstones a removed note but, unlike `NotesService.delete`, does not drop its `note_projects` rows or announce the link removal (pre-existing; recorded in `ROADMAP.md` SYNC-03 scope, not changed in SYNC-01). |
| 2026-11-03 | SYNC-03 (protocol v1) | R-38 (snapshot walk vs floor, sim seed 29) found and closed; R-39 (restore regrowth, `epoch`), R-40 (late ack vs tombstone, sim seed 681), R-41 (resolutions response-only until SYNC-05), R-42 (notes not merge/delete-safe until SYNC-04), R-43 (idempotency purge scan) added. R-28, R-29, R-30, R-31 moved to Mitigating (server side). |
