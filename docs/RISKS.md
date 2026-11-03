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
- **Owner milestone:** SYNC. **Status:** Open.

### R-29 — Clock skew and clock jumps
- **Severity/Likelihood:** Medium / High (laptops sleep, phones change zone)
- **Description:** wrong device clocks break local reminder times, "today", token expiry display; they must never decide a winner.
- **Mitigation:** server-assigned order only (ADR-0055 §3, ADR-0059 D11); simulation invariant 6 (same result under any offsets);
  server-set timestamps; reminders scheduled from due instants + zone, recomputed on clock change.
- **Owner milestone:** SYNC. **Status:** Open.

### R-30 — Resync storms and restore-rewind
- **Severity/Likelihood:** Medium / Medium
- **Description:** a bug in the floor logic, a server restored from an older backup (clients ahead of the server today get an empty
  feed and never notice), or many clients resyncing at once can loop or silently diverge.
- **Mitigation:** SYNC-01 `cursor_ahead` signal (server side done 2026-11-03; client handling and the operator command are not); resync cooldown and per-device snapshot limit; confirm-before-reupload; operator
  runbook; simulation scenario "restore from backup"; `epoch` check.
- **Owner milestone:** SYNC. **Status:** Open.

### R-31 — Retention shorter than an offline period
- **Severity/Likelihood:** Medium / Medium
- **Description:** today's purge removes every feed row after 30 days, so a returning or new device cannot catch up from the feed;
  a deletion made while a device was away can be unknowable after tombstones are purged.
- **Mitigation:** ADR-0059 D2 (keep upserts, tombstones 90 days, snapshot from 0); resync is non-destructive, pending edits kept
  (rule 4); idempotency keys outlive tombstones.
- **Owner milestone:** SYNC. **Status:** Open.

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
- **Mitigation (not applied: SYNC-02 changes no behaviour):** lock the row (`SELECT ... FOR UPDATE`) or add `AND revision = :base`
  to the update and map zero rows to 409; add the same to projects and notes; remove the `xfail` marker. Schedule at the start
  of SYNC-03.
- **Owner milestone:** SYNC-03. **Status:** Open.

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
- **Proposed fix (not applied: owner decision, deploy config):** `client_max_body_size 6m;` inside `location /api/` of
  `apps/web/nginx.conf` (5 MiB content + JSON overhead), plus a note for operators whose own reverse proxy sits in front
  (`DEPLOYMENT.md` §8). Needs a real-stack check that a 5 MiB note round-trips.
- **Mitigation:** apply the fix above (can be done before SYNC-04); explicit "too large to sync" state; 413 handling; merge time bound.
- **Owner milestone:** SYNC. **Status:** Open.

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
| 2026-11-03 | SYNC-02 | R-37 added: concurrent PATCHes with one `base_revision` both succeed (lost update). Also learned: a retried request must be byte-identical including `base_revision`, because the server fingerprints the whole body; a client that re-reads the base revision on retry gets `409` on its own key. The production `fullResync` hook is still not supplied (model client implements it by listing). |
| 2026-11-03 | SYNC-01 | R-34 verified as a real defect (shipped nginx rejects bodies above 1 MiB with `413`; fix proposed, not applied). R-32 ordering proven by a concurrency test. R-30: server side of `cursor_ahead` delivered. New finding: `NotesReconciler` tombstones a removed note but, unlike `NotesService.delete`, does not drop its `note_projects` rows or announce the link removal (pre-existing; recorded in `ROADMAP.md` SYNC-03 scope, not changed in SYNC-01). |
