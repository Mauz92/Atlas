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
- **Owner milestone:** M5. **Status:** Mitigating (2026-11-10): the app registration steps, the personal-versus-work caveat (no registration in an employer tenant without IT approval) and the "admin consent required" troubleshooting row are written (`CALENDAR_SYNC.md` 12.3, 12.6); the Graph adapter exists and is fixture-tested. **Not closed:** nothing was run against a real tenant (M5-00 live runbook).

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
- **Owner milestone:** M5. **Status:** Mitigating (2026-11-10): the setup guide says to publish to Production and why (12.2), an expired refresh token flags the account "needs re-authorisation" instead of failing silently, and the runbook includes the >7-day check. **Not closed:** the real token lifetime is unverified.

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

### R-49 — Readability design relies on CSS the tests cannot see on a real phone (UX-09, ADR-0062)
- **Severity/Likelihood:** Low / Medium
- **Impact:** the three-line row rule, sticky section headers under the 48 px mobile header, the 44 px checkbox hit area
  (a transparent 44 px input drawing a 22 px circle through `::before`/`::after`), `:has()` for the page tint and the line clamp
  are verified in Chromium (emulated touch, measured by `boundingBox` and computed style), not on iOS Safari, Android Chrome,
  Firefox, with a screen reader or at 200 % zoom. A browser without `:has()` simply shows the white page behind the cards.
  Line 2 of a phone row clips at its end (no ellipsis on the flex group) when a long due, "Urgent" and a subtask count all show at
  360 px. Project hues are checked for contrast only; the dot is never the only cue (the name is shown).
- **Mitigation:** every state is conveyed by icon + word, not colour; sizes and heights are asserted in `ux09-readability.spec.ts`
  at 360/390/768/1440 in both themes; the layout is CSS-only and reversible (ADR-0062).
- **Status:** Open (accepted; verify on a real phone with VoiceOver/TalkBack before release).

### R-50 — Phone sheets, the capture button and safe areas are verified only with emulation (UX-10, ADR-0063)
- **Severity/Likelihood:** Low / Medium
- **Impact:** the keyboard-aware capture sheet (`useKeyboardInset`, `interactive-widget=resizes-content`), the safe-area spacers and
  the 44 px targets are verified in Chromium with a stand-in `visualViewport`, overridden `--safe-*` variables and touch emulation; not
  with a real iOS or Android keyboard, notch or home indicator, nor with TalkBack/VoiceOver. A modal menu sheet blocks pointer and
  keyboard but does not make the page behind it inert, so a screen-reader swipe could reach it. `programmatic focus()` on opening the
  sheet may not raise the iOS keyboard. With `resizes-content` the bottom nav and FAB ride above the Android keyboard (less room).
  `container` queries and `:has()` are required (a browser without them shows one or two columns and no page tint). Landscape notch insets are
  applied to the main column only. (The 20 px status-bar link was fixed in UX-11, ADR-0064.)
- **Mitigation:** one capture form and one menu implementation for both presentations; Esc, scrim, Close and Cancel all close; the
  sheet never covers the field in the emulation; reversible CSS/markup.
- **Status:** Open (accepted; verify on a real phone before release).

### R-51 — The remaining phone pages are verified only with emulation; a few controls are deliberately not 44 px (UX-11, ADR-0064)
- **Severity/Likelihood:** Low / Medium
- **Impact:** the Tasks Select mode and Filters sheet, the project Board tab strip, the Notes toolbar, Project cards and the palette
  sheet are measured in Chromium touch emulation (Playwright `isMobile` + `hasTouch`) at 360 and 390 px, not on a real phone: real taps,
  the on-screen keyboard over the full-height palette (the `--kb` lift reuses the UX-10 mechanism, unverified on a device),
  TalkBack/VoiceOver reading order of the tab strip, and Safari/Firefox rendering are `NOT RUN`. Chromium's emulation did not report `pointer: coarse`, so the 44 px rules are keyed on `(max-width: 720px)` as
  well. Deliberate exceptions to the 44 px rule: a task-list checkbox or link **inside a note's own text** (editor and preview content,
  like an inline link) and, on a tablet-width window without a coarse pointer, desktop sizes. Removing the standalone Board means a task
  with no project is on no board (owner decision; use Tasks, Inbox or put the task in a project). The "Select" mode and the "Filters"
  sheet add one tap to reach a filter or the select boxes on a phone. The Notes preview preference is shared between phone and desktop.
- **Mitigation:** one component and one set of rules for each presentation (`Menu`, `Tabs`, `QuickCapture` are reused); all changes
  are CSS/markup; the real-stack sweep `ux11-phone-pages.spec.ts` re-measures targets, scroll and axe.
- **Status:** Open (accepted; verify on a real phone before release).

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
- **Progress (SYNC-11, 2026-11-10):** the conflict, notice and restore screens exist (`/changes`, the banner, the text and note resolvers, the halt screens), so a decision the server or the engine made is no longer invisible. Still open: a browser edit made offline fails visibly instead of queueing (the browser has no local store until SYNC-11d), and the shell's UI is online REST (R-73).
- **Owner milestone:** MU. **Status:** Mitigating.

### R-28 — Data loss through sync (merge, resolution, delete)
- **Severity/Likelihood:** High / Medium (design stage; nothing implemented)
- **Description:** field merge, three-way note merge, "edit wins over delete" and automatic resolution can silently pick the wrong
  value or drop text; the existing server has none of this yet (`SYNC_PROTOCOL.md` §2).
- **Mitigation:** uncertain ⇒ conflict copy, never a guess; pre-merge versions kept in note history; resolution log with undo;
  simulation invariants "no acknowledged loss" and "no resurrection"; client deletes go to a trash folder; ADR-0059 D4–D7.
- **SYNC-03 (2026-11-03):** task/project field merge, edit-wins and the structured text conflict are implemented and covered by
  `test_sync_writes.py`, the model/real conformance traces and the v1 simulation (`no_silent_text_loss`, `edit_wins`,
  `unexpected_rejection`, with a planted defect for each).
- **SYNC-04 (2026-11-03):** note history, the three-way merge, server-side conflict copies, edit-wins/revive and the move rules are
  implemented (ADR-0060) and covered by property tests of the merge, 55 integration tests with exact-byte assertions, note
  conformance traces and the note simulation (`no_silent_overwrite`, `no_acknowledged_note_loss`, `conflict_copy_has_losing_text`,
  `unique_paths`, `edit_wins`, each with a planted defect). **SYNC-05 (2026-11-03):** the persisted resolution log, its feed entity and a
  strict undo are implemented (R-41 closed; invariants `resolution_logged_once`, `no_log_without_write`, `log_has_no_text`,
  `undo_once`, `undo_logged`, `undo_never_overwrites_newer`, `resolutions_converge`, each with a planted defect). **Still open:**
  real-device and real-client evidence (SYNC-08/09).
- **Owner milestone:** SYNC. **Status:** Mitigating.

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
  **Found again by the note simulation (seed 109, 700 steps, SYNC-04):** the same applies to a *delete* acknowledgement (a `204`
  replayed after another device revived the entity by an edit and this client already pulled that): the tombstone is the user's
  intent but the entity must be queued for a re-read, or the client keeps a deleted copy of a live entity. The model client does
  that now for every kind. **SYNC-08:** implemented in `packages/sync-core` (`entities.ts` `applyAck`/`applyDeleteAck`/
  `applyTombstone`, re-read in `commitPage`) and proven by the TS simulation: the planted defect `trustAckState` is caught
  (`cursor_safety`), the honest core passes the model soak and the real-API runs. **Status:** Mitigated in the shared client core;
  the web app's own engine does not send writes in sync mode, so it does not need it (R-54).

### R-54 - The web app still runs its M7 engine, not `sync-core`
- **Severity/Likelihood:** Low / High (a known, deliberate gap)
- **Description:** `apps/web/src/lib/syncEngine.ts` and `offlineQueue.ts` speak the legacy protocol (no `Atlas-Sync`; a stale `409` keeps
  the operation in the queue as `conflict`) and the UI (`SyncStatusPanel`, `useConflictResolution`) depends on that. No production code
  enqueues into it. Moving it to sync mode changes what a user sees on a conflict, which is the product decision of SYNC-11.
- **Mitigation:** `packages/sync-core/src/adapters` (`KeyValueLocalStore`, `createFetchTransport`, `legacyQueueSnapshot`) are the
  incremental path; nothing in the web app was changed except test/lint/typecheck wiring. **Status:** Open (SYNC-11 / SYNC-09 consume the core).
- **SYNC-11 (2026-11-10):** the browser deliberately stays on its engine (ADR-0070 D2): the new screens reach it through REST (`GET /api/sync/resolutions`, `POST .../undo`) and
  its own `409` flows. The desktop shell no longer starts the browser's queue, cursor or reconciler (R-73). The browser path onto `sync-core` (an IndexedDB `LocalStore`, opt-in "Offline mode (beta)")
  is planned as SYNC-11d (ADR-0070 D9), not built. **Status:** Open, narrower.

### R-55 - Properties of `sync-core` the simulation does not prove
- **Severity/Likelihood:** Medium / Low
- **Description:** (a) Three planted defects were not caught even at 250 seeds x 300 steps x 4 clients: server `notesConflictNotStored`
  (needs a lost answer to a conflicting save), server `undoRevivesDeleted`, client `applyStaleRevisions` (a single-request client never
  receives an older state than it holds, so the guard is defence in depth). (b) A chained operation whose predecessor was merged over foreign
  changes falls back to the user's base and may report a conflict with the user's own earlier edit (noise, no loss). (c) Several
  entities in flight at once, crash points inside a single transaction (only before commit), history pruning, `types_synced` backfill and
  a real SQLite/Android store are not exercised. (d) Restore (`confirmRestore`) is covered by a 6-seed scenario and a unit test, not by
  the random schedule. (e) Defects can hide at depths the default run does not reach: the 1000 x 300 soak found one at seed 983 (a snapshot
  walk left an entity with a pending delete live while the cursor passed its tombstone; fixed, regression in the default run, `ACCEPTANCE.md`
  SYNC-08 follow-up), so the soak is part of every sync-core change, not only of releases.
- **Mitigation:** listed in `TESTING.md` 10.0e; SYNC-09/10 re-run the harness over their stores. **Status:** Open.

### R-41 - Automatic resolutions exist only in the response until SYNC-05
- **Severity/Likelihood:** Medium / Medium
- **Description:** `sync.resolution` (rule, field, overwritten simple value) was returned to the writer and stored with its
  idempotency record (so a retry saw it), but there was no `sync_resolutions` table, feed entity or undo: other devices were not told
  "changed on another device", and the overwritten value was gone from the server once the idempotency key expired.
- **Outcome (SYNC-05, 2026-11-03, local):** closed on the server side. Every decision of a sync-mode write is a row of
  `sync_resolutions` written in the write's transaction, announced as feed entity `resolution`, listed by
  `GET /api/sync/resolutions` and undone by `POST .../undo` (strict: never overwrites a newer value). Proven by integration tests,
  model/real conformance traces and the simulation with 10 planted defects (ADR-0061, `ACCEPTANCE.md` SYNC-05). What remains is
  client work: SYNC-08 applies the entity, SYNC-11 shows the notice and the undo. **Status:** Closed (server).

### R-42 - Note writes in sync mode were only idempotent, not merge- or delete-safe
- **Severity/Likelihood:** Medium / Medium
- **Description:** SYNC-03 gave notes client ids, the live-path index, collision renaming and keys, but a stale note `DELETE` still
  won, a `PUT` of a deleted note was `404`, a stale `PUT` was a plain `409 stale`, and a replayed note write returned the summary
  without the content.
- **Mitigation / outcome:** fixed by SYNC-04 (2026-11-03): history, three-way merge, server-side conflict copies, stale `DELETE` is
  `409 edit_wins`, a `PUT` of a deleted note revives it, replay returns the content from history, move rules and portable paths.
  Residual limits are R-44 (history retention) and R-45 (conflict volume). **Status:** Closed (server side; clients are SYNC-08/09).

### R-44 - Note history keeps overwritten and deleted text, and uses disk
- **Severity/Likelihood:** Medium / High (certain by design)
- **Description:** to merge, the server keeps the text of recent revisions (`.atlas/history`): the newest 20 plus 90 days, bounded
  per note (200 revisions, 64 MiB of distinct text), the history of a deleted note for 90 days after the delete. So a note the user
  deletes or rewrites is still on the server (and in every backup) for that long, up to roughly twice the note bytes for a rarely
  edited note, and the privacy expectation "deleted means gone" does not hold for 90 days. History also grows disk use with
  edit volume (autosave makes a revision per save, hence the bounds).
- **Mitigation:** documented where an operator looks (`OPERATOR_GUIDE.md`, `.env.example`, `SECURITY.md` 12); the windows are
  settings; pruning on write and in the hourly job (tested); a pruned base degrades to a conflict copy, never a wrong merge. To
  remove a note completely the operator removes its directory under `.atlas/history` and the note from backups. No UI surfaces it
  yet (SYNC-11 / Settings could show history size). **Status:** Accepted, documented.

### R-45 - The merge is conservative: more conflict copies than a smarter merge would make
- **Severity/Likelihood:** Low / High
- **Description:** edits that touch (adjacent lines), two edits to different front-matter keys, a stale base that was pruned, a
  pre-migration base, or a note that changed line endings wholesale are conflicts, so the user sees `name (conflict ...).md` files
  in situations where a human would merge easily. Each is safe (nothing is lost) but noisy; the simulation (4 clients, 10-25 line notes,
  edit positions uniformly random, 100 seeds) produced about 3.4 conflict copies per clean merge: a pessimistic workload, since
  real edits cluster less than uniform random positions in short notes.
- **Mitigation:** none needed for safety; quality improvements (word-level merge inside a conflicting line, YAML-aware front-matter
  merge) are optional later work and need their own property tests; the resolve UI is SYNC-11. **Status:** Accepted.

### R-46 - Personal-install edges found by the Compose smoke test (P0-1/P0-2)

Fixed: placeholder-free `DATABASE_URL` mismatch, unforwarded settings, `ALLOWED_HOSTS` breaking the healthcheck, 5 MiB error
echo, exports on an unmounted path, web published on all interfaces. **Open, accepted for a personal install:** (1) the login
rate limiter keys on `request.client.host`, which behind nginx is the nginx container, so all clients share one bucket
(10 failures per minute lock out the owner); proxy headers are not trusted by the app and trusting them safely needs a
documented proxy chain (SECURITY R-SEC-1). (2) API redirects such as `/api/tasks/` carry an `http://host` `Location`
(wrong scheme and port behind HTTPS); nginx `proxy_redirect` did not rewrite the 307. The web app never requests such URLs.
(3) The static page has no HSTS (the API has); add it in the proxy on a public name. (4) `db` still publishes
`127.0.0.1:5432` (needed by host-side tests; any local user can reach it with the password). (5) A downgrade drops the
`note_revisions` table but leaves `.atlas/history` files. (6) Backup sets are unencrypted and on the same disk until copied.
**Status:** Mitigating.

### R-47 - The resolution log keeps overwritten simple values and note paths for 90 days
- **Severity/Likelihood:** Low / High (certain once sync mode is used)
- **Description:** `sync_resolutions.loser` holds the value a later write overwrote (a status, a priority, a date, a project id, a
  note path) and `detail` names note paths; they stay in the database and every backup until the retention window passes
  (`CHANGE_RETENTION_DAYS`, default 90, minimum 30). No text or note content is ever stored, but a project id or path can be
  personal. The table is not covered by the data export (it is operational state, like history and keys).
- **Mitigation:** bounded (4 096-byte value, 2 048-character detail, 90 days), user-scoped, never logged, documented in
  `SECURITY.md` T18/T20. An operator who needs a value gone lowers the window or deletes the rows. **Status:** Accepted.

### R-48 - Strict undo is often refused on busy fields
- **Severity/Likelihood:** Low / Medium
- **Description:** an undo is applied only if nothing touched the field after the resolution. The simulation (default scenario,
  undo wave after the run) saw roughly as many `changed_since` refusals as applied undos; on a field that two devices keep editing,
  most notices will be un-undoable by the time the user sees them. That is correct (the alternative is a silent overwrite) but it
  can feel like a broken button.
- **Mitigation:** the refusal is explicit (`409 conflict`, `changed_since`, the current value in `server_value`), the entry stays
  listed with its overwritten value so the UI can offer "set it back by hand" (an ordinary edit); SYNC-11 must word this.
  **SYNC-11a (2026-11-10):** worded as a normal outcome ("Not undone: the priority was changed again since. Atlas never overwrites a newer
  value."), shown in place on the entry with the Undo button still enabled, tested for every refusal (`undoOutcome.test.ts`) and in the real stack
  (`sync11-conflicts.spec.ts`). Not built: a "set it back by hand" shortcut that pre-fills the field (the overwritten value is shown, the person edits the task).
  **Status:** Mitigating (wording done; usage will show whether the button still feels broken on busy fields).

### R-52 - Token rotation does not detect theft of the current token
- **Severity/Likelihood:** Low / Low
- **Description:** rotation (ADR-0065 point 6) gives a new token and keeps the old one for 24 hours or until the new one is first used.
  It shortens the life of a leaked *old* token. It does not notice that two parties hold the *current* one: whoever presents it is the
  device, and a thief who rotates first locks the owner's client out only until the owner signs the device in again. There is no
  reuse detection (which would have to revoke the device on a presented, already-spent token and so would punish a client that merely
  lost a response).
- **Mitigation:** the owner sees `last_seen_at` and the device list and can revoke at once; a new sign-in needs the password; clients
  are expected to hold the token in the OS keystore only. Reuse detection can be added later without a schema change if the owner wants
  it. **Status:** Accepted.

### R-53 - Per-device feed and snapshot limits are not built; limiters are in-process
- **Severity/Likelihood:** Low / Low
- **Description:** `SYNC_PROTOCOL.md` 8.3 proposed 60 feed pages a minute and 10 snapshot starts an hour per device. SYNC-06 built a
  general 600 requests and 120 writes a minute per device and no feed-specific limit: a stolen token can read the whole account at
  that rate (T17), and nothing yet shows what a real client needs. Like the login limiter the counters live in the API process
  (single-process deployment) and reset on restart.
- **Mitigation:** the general limit, the visible `last_seen_at`, immediate revocation; SYNC-08 should measure a real client's feed
  use and then set the feed numbers (one constant each in `atlas/auth/devices.py` and the changes router). **Status:** Open.

### R-56 - The recovery code is a bearer secret with no leak detection, and may be lost before it is seen
- **Severity/Likelihood:** Medium / Low
- **Description:** whoever holds the recovery code and the e-mail can take the account over until the code is replaced (T25). Nothing
  notices a leak before use; a use signs every session and device out, which the owner sees. Separately, the web app holds the code
  only in memory: if the tab is closed or reloaded on the "Save your recovery code" screen before the acknowledgement, the account has
  a code nobody saw (the server does not track acknowledgement). The owner is not locked out: they are signed in and can regenerate
  in Settings (password required), or the operator runs `atlas-admin recovery-code`.
- **Mitigation:** shown once with copy/download and an explicit "I have saved it" step; replaced by every use; regenerable in
  Settings; `RECOVERY_ENABLED=false` for operators who prefer CLI-only; the user guide says to keep it like a password and not in the
  notes folder or a synced note. A restore from an older backup brings back the older code (`OPERATIONS.md` 2.2b). **Status:** Accepted.

### R-57 - Recovery attempts are throttled in process and the account throttle can be spent by a stranger
- **Severity/Likelihood:** Low / Low
- **Description:** the per-account limit (5 attempts per 15 minutes) and the shared per-address limit are in-process counters (reset by
  a restart, per API process, R-SEC-1). A persistent stranger who knows the owner's e-mail can spend the 5 attempts every 15 minutes and
  keep *recovery* throttled; sign-in, sessions and the CLI are unaffected. The cap is not what protects the code (150 bits); it bounds
  noise and CPU.
- **Mitigation:** a sliding window, not a lock; the CLI fallback; the audit log shows `recovery_reset_throttled`; a shared limiter
  store is the fix if Atlas is ever scaled out. **Status:** Accepted.

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
- **Mitigation (server side done by SYNC-06, ADR-0065):** hash-only storage, immediate revocation, device list with `last_seen_at`,
  idle expiry, password reset revokes all (`atlas-admin reset-password`, AUTH-01 will call the same function), a password change can
  revoke all (`revoke_devices`, off by default), scope limited to sync (T22). Still open: the OS keystore per platform and "no file
  fallback for the token" are client work (SYNC-07 spike, SYNC-09/10); a password change *without* the box leaves devices signed
  in on purpose (ADR-0065 point 5).
- **Owner milestone:** SYNC-06 (server, done) / SYNC-07, SYNC-09 (client keystore) / AUTH-01. **Status:** Open (client side).

### R-36 — Tauri 2 platform maturity (WebKitGTK, WebView2, Android) and plugin churn
- **Severity/Likelihood:** Medium / Medium
- **Description:** rendering/editing differences across system webviews; Android support younger than desktop; no official keystore
  plugin; updater is desktop-only per the docs; the sql/store/stronghold plugins have `3.0.0-alpha` lines in flight; fs access on
  Android may not allow a user-chosen shared folder (all checked 2026-11-03 against Tauri docs/releases, not by running).
- **Mitigation:** SYNC-07 spike with pass/fail criteria and Electron fallback (desktop); pin 2.x; capability-minimal config;
  PWA fallback for Android (A-09).
- **Owner milestone:** SYNC-07. **Status:** Open (Linux part run 2026-11-04, `SYNC_PROTOCOL.md` section 13).
- **Update 2026-11-04 (GitHub-hosted Windows runner, `SYNC_PROTOCOL.md` 13.3a):** the spike compiles for `x86_64-pc-windows-msvc`; a 2.9 MiB per-user NSIS installer installs under
  `%LOCALAPPDATA%` with an `HKCU` entry and an `asInvoker` manifest; the signed update works (valid applied, tampered and wrong-key refused); single instance, SQLite (100/100 `TerminateProcess` kills), Credential
  Manager and ACL refusals behave; the Windows dependency graph has no GPL/AGPL/LGPL and **no advisory warning** (the eight Linux warnings are outside it). One Windows-only code defect found and fixed (W1: a directory
  `fsync` that Windows refuses, which would have made every Atlas write report failure after it had succeeded). **Still open, unchanged in kind:** everything a hosted *administrator* runner cannot show: a standard-user,
  UAC-free install and update on the work laptop, SmartScreen on an unsigned installer, AppLocker/WDAC/antivirus, the WebView2 bootstrapper under policy, OneDrive/Dropbox watching, IME. The Electron trigger therefore remains
  possible; the owner now only needs to download and run the prebuilt installer (checklist 13.3a), not build anything.
- **Update 2026-11-04 (Linux, WebKitGTK 2.54.1):** no core-editing failure and no Electron-fallback criterion triggered; rendering and CSS/API features match Chromium (S1.1-S1.2);
  own `rusqlite` commands are transactional (100/100 kill-9); updater signature checks work (tampered and wrong-key refused); `tauri-plugin-sql` is not usable for transactions and
  cannot be linked with `rusqlite`. **Still open and now the main risk:** Windows S6/S7 (per-user install, WebView2, SmartScreen, policy on the work laptop) and everything Android
  were not run; a Windows failure moves both desktop platforms to Electron (mixed result rejected). New observations: `cargo audit` 0 vulnerabilities but 5 unmaintained/unsound
  transitive crates (`proc-macro-error`, `zbus_names`, `zvariant`, `zvariant_derive`, `glib` 0.18.5 unsound `VariantStrIter`, RUSTSEC-2024-0370, -2024-0429, -2026-0370/0371/0372; all
  in Tauri's own Linux/D-Bus stack, to be re-checked at each Tauri bump); the AppImage is 110 MiB and bundles the build machine's WebKitGTK (portability to older glibc unverified);
  `keyring` 4.2.0 exists (spike used 3.6.3).


### R-58 - WebKitGTK display/rendering behaviour on Linux (NVIDIA/Wayland) and the post-edit frame
- **Severity/Likelihood:** Medium / High on NVIDIA + Wayland, unknown elsewhere
- **Description:** WebKitGTK 2.54.1 on an RTX 3080 under KDE Wayland crashes with `Gdk Error 71` (or `Failed to create GBM buffer` under Xwayland) unless
  `WEBKIT_DISABLE_DMABUF_RENDERER=1`, which moves rendering to a slower path. In that mode the frame after an edit in a 5 103-line note was 32 ms in 2 of 5 runs and 1.1-2.3 s in 3 of 5
  (synchronous edit cost 3-6 ms in all; headless Chromium with software raster is a steady 267 ms), cause unexplained. Two web-app defects show only in WebKitGTK: native `<select>` clipped
  (D1) and no picker on date/time inputs (D2) (`SYNC_PROTOCOL.md` 13.1 S1.3).
- **Mitigation:** the shell sets the environment variable itself where needed; retest the frame on a GPU-enabled setup and in a controlled display before SYNC-09 (condition in 13.2);
  fix D1/D2 in `apps/web` as a UX task (add `appearance`/height rules for `select`; own date picker or documented ISO text entry); offer the PWA/browser as the fallback client.
- **Owner milestone:** SYNC-07 follow-up, SYNC-09. **Status:** Open.

### R-59 - Desktop reminders while the app is closed
- **Severity/Likelihood:** Medium / High
- **Description:** `tauri-plugin-notification` on desktop shows notifications immediately but has no scheduling (checked in its desktop implementation and by firing one); a reminder at 09:00
  with the shell closed needs the app resident (tray, autostart) or another delivery path. The existing browser Web Push (ADR-0039) does not exist inside the shell's webview.
- **Mitigation:** decide in SYNC-09 between a resident background process with tray/autostart (and its own scheduler fed by the synced reminders) and keeping the browser/PWA for
  push; document that the desktop client does not remind while closed until then. Android scheduling is `NOT RUN` (13.4).
- **Update 2026-11-04 (ADR-0068 PROPOSED, owner decision for the hybrid):** the chosen mitigation is the resident desktop app (tray, close-to-tray, optional autostart, own 30 s tick, `SYNC_PROTOCOL.md` 14.9); "no notification while the app is not running" becomes a documented accepted limit. Remaining uncertainty: autostart path for an AppImage, tray visibility on GNOME, hidden-window timer throttling (R-64).
- **Owner milestone:** M8-04c (needs SYNC-09). **Status:** Open (mitigation designed, not built).

### R-60 - Whole-state local store and TLS trust in the Tauri client
- **Severity/Likelihood:** Medium / High if not acted on
- **Description:** `KeyValueLocalStore` over SQLite rewrites the entire state per transaction (300 creates wrote 167 MB, 2.1 s; 20 MB state = 131 ms per write): unusable for a real vault.
  `reqwest` with `rustls-tls` trusts only bundled Mozilla roots, so a self-hosted server behind a private CA (Caddy internal CA) would be refused; Android additionally ignores user CAs by default.
  The watcher feedback loop (`Access` events), the same-size/same-mtime edit that a size+mtime scan misses, and the dotfile default of the fs scope are design inputs, not defects.
- **Mitigation:** SYNC-09 builds a per-row `LocalStore` on `rusqlite`; uses the platform trust store (`rustls-tls-native-roots` or `native-tls`) and tests with the owner's real certificate; the watcher
  rules and the hash-based periodic scan in `SYNC_PROTOCOL.md` 13.2 are acceptance criteria of the notes-folder engine.
- **Owner milestone:** SYNC-09. **Status:** Mitigating (2026-11-10: per-row store and `rustls-tls-native-roots` implemented and tested; the check with the owner's real certificate, `NOT RUN`, remains).

### R-61 - A moderate advisory in dev tooling makes the `npm audit` gate fail (minimatch, GHSA-g3hv-75wg-m249)
- **Severity/Likelihood:** Low (dev dependencies only, no untrusted glob input) / Certain (the gate is red)
- **Description:** the first CI run of the `frontend` job (2026-11-04) reached `npm audit --audit-level=moderate` with an advisory published 2026-10-30: `minimatch` `< 11.0.1` (denial of service via glob-part amplification).
  The same audit also listed Vite 6.4.4 (GHSA-8g5g-mxqh-grgj, dev-server `fs.deny` bypass; fixed by 6.4.5, applied). The `minimatch` chain is reachable only through `eslint` 9 (`minimatch` 3.x), `@typescript-eslint` (10.x) and `openapi-typescript` / `@redocly/openapi-core` (5.x): lint and API-type generation on trusted repository files, never in the shipped
  bundle (`npm audit --omit=dev`: 0 vulnerabilities). npm reports "No fix available": the fixed 11.x line is ESM-only with a different API and none of those parents accepts it, so an `overrides` pin would break `eslint`.
  Local `npm audit` on 2026-10-19..11-03 (`DEPENDENCIES.md`, release table row 5) was 0; the advisory is newer than that evidence.
- **Mitigation:** the gate was **not** weakened or suppressed. It now runs as the last step of the `frontend` job so lint, types, tests and build still report. Decision for the owner: (a) accept the dev-only
  advisory for a time-boxed period and change the gate to `--omit=dev` plus a written exception here, or (b) keep the red gate until `eslint`/`typescript-eslint`/`openapi-typescript` release versions that use minimatch 11.
  Re-check weekly (`npm audit`, Dependabot would do it automatically if enabled by the owner).
- **Owner milestone:** release readiness. **Status:** Accepted with an exception (owner decision 2026-11-09, option (a)): CI fails on production-dependency advisories (`npm audit --omit=dev`, moderate and above) and runs the full audit as a visible, non-blocking report step (`continue-on-error`). Exception expires **2026-12-09**: re-check then, or as soon as `eslint`/`typescript-eslint`/`openapi-typescript` ship versions using a fixed minimatch.

### R-62 - CI environment differences found by the first GitHub Actions runs (locale, time zone, timing)
- **Severity/Likelihood:** Medium / High until fixed
- **Description:** the first runs (UTC clock, `en-US` locale, 2 vCPU runners) exposed tests that only pass on the developer machine (Europe/Stockholm, 24-hour locale): `dueChip`/`TaskRow` expected "15:00" (CI renders "03:00 PM"),
  `taskAutosave` read a naive wall-clock string in the machine's zone; a backup test used a made-up database password against a server that checks passwords; two browser journeys had time budgets sized for a fast
  machine (`J4` accepted a completion before CodeMirror's 75 ms `interactionDelay` had passed; `mu08` axe sweep took 80-100 s against a 90 s budget); `pytest-asyncio`'s deprecation warning is an error under
  `filterwarnings = ["error"]`. All fixed in the tests or configuration, none by skipping (`ACCEPTANCE.md` P0-4). A layout assertion in `ux10-phone` (`/week` at 1440 px: `.task-meta` scrolls by more than 1 px) failed once on
  CI and passed on four other CI runs and locally; see `ACCEPTANCE.md` P0-4 for its current state.
- **Mitigation:** CI is now the second environment; keep tests independent of locale, zone and speed; the failing assertion's message names the row, class, text and widths.
- **Owner milestone:** P0-4. **Status:** Mitigated (see ACCEPTANCE for the open layout item).

### R-63 - Missed Android reminders: Doze, vendor battery managers, exact-alarm permission (M8-04d)
- **Severity/Likelihood:** High / Medium-High on aggressive vendors (Xiaomi, Huawei, Oppo, some Samsung/OnePlus settings), Low on stock Android
- **Description:** local reminders depend on `AlarmManager` alarms surviving. Without the exact-alarm permission the plugin falls back to inexact alarms, documented as possibly delivered within an hour on API 31+; revoking `SCHEDULE_EXACT_ALARM` stops the app and cancels exact alarms; shutdown cancels alarms (the plugin re-arms after boot, not after an app update); a vendor "app freezer", force-stop or aggressive optimisation can remove alarms or block receivers outside the platform contract. Doze frequency cap and the concurrent-alarm cap were not verified. `USE_EXACT_ALARM` is subject to a Google Play policy if the app is ever published there.
- **Mitigation (designed, `SYNC_PROTOCOL.md` 14.3/14.4/14.8):** declare both exact-alarm permissions in the sideloaded build; status row and test notification; missed list and catch-up on start; heartbeat to detect "the app was not alive"; optional reminder-time hint to wake a phone whose alarms were removed; user guidance; real-device matrix with one aggressive vendor (M8-04g). **No promise** that every reminder fires on every device; FCM, the only stronger option, is rejected by default (ADR-0068 D8).
- **Owner milestone:** M8-04d/g. **Status:** Open.

### R-64 - Desktop reminders depend on a resident, running app (M8-04c)
- **Severity/Likelihood:** Medium / High
- **Description:** no notification while the app is not running; a user who quits, a crash, a logout without autostart, a stock GNOME without tray icons, a hidden window whose timers are throttled, or sleep can all silence reminders. A forgotten "Quit" is silent.
- **Mitigation:** tray + close-to-tray, optional autostart (first-run prompt, Q2), Rust-driven tick, catch-up at start/resume with a "missed" list, a visible "reminders are off while Atlas is closed" notice at Quit, hidden-window lateness measured (M8-04c). Web Push in a browser remains an independent channel for the owner who also runs the web app.
- **Owner milestone:** M8-04c. **Status:** Open.

### R-65 - Clock and zone problems on devices (M8-04b)
- **Severity/Likelihood:** Medium / Low-Medium
- **Description:** fire instants are absolute but fire on the device's clock: a wrong device clock shifts every reminder; a manual clock change, NTP step, sleep or a tzdata update can change when "now" is relative to the instant. The server computes the instant with its own tzdata; a government rule change after computation is fixed only by the scan and a sync. A task with no zone is interpreted in UTC (G3).
- **Mitigation:** absolute instants only; reconcile on time/zone/resume events; skew estimate and warning, no silent adjustment; hourly reconcile; scan recompute records the change in the feed; home-zone preference proposed (Q6); fake-clock tests incl. DST (TESTING 12.2).
- **Owner milestone:** M8-04a/b. **Status:** Open.

### R-66 - Duplicate or stale notifications across devices (M8-04b)
- **Severity/Likelihood:** Medium / High (by design all enabled devices fire)
- **Description:** the owner gets the same reminder on phone, desktop and possibly a browser tab; outcomes sync only on the next sync, so a task completed elsewhere can still fire stale once (also the plugin's boot restore). Offline edits/creates leave no or a stale alarm until sync (L1).
- **Mitigation:** per-device fired-set; per-device switch; synced dismiss/snooze/complete clearing other devices; local cancellation on any local schedule-affecting edit; destinations listed so the web push can be disabled; limitation shown in the status row; Q1/Q3 are owner decisions.
- **Owner milestone:** M8-04b. **Status:** Open (accepted behaviour pending the owner).

### R-67 - The hint channel: third-party gateway, topic secrecy, SSRF, headless sync (M8-04e/d)
- **Severity/Likelihood:** Medium / Low (opt-in, off by default)
- **Description:** a self-hosted ntfy is a new service the owner must run, patch and secure; a public instance would leak change timing; the topic URL is a secret and the server posts to a device-supplied URL (SSRF primitive); a hint is lossy by design and, on Android, useful only if a headless sync exists (G12); the plain-vs-encrypted payload question for UnifiedPush is unverified.
- **Mitigation:** content-free constant payload; feature off by default; operator-pinned origin and path pattern; no redirects; rotation; ntfy ACL guidance (Q8); lossy-safe client design (periodic and foreground sync remain); fake-gateway failure tests; log-capture test; `DEPENDENCIES.md` records licences and maintenance; the ntfy licence for the Android app was **not** verified.
- **Owner milestone:** M8-04e. **Status:** Open.


### R-68 - A snooze that syncs late rings other devices later than the owner meant (M8-04a, found by simulation)
- **Severity/Likelihood:** Low-Medium / Medium before the fix; Low / Low after it
- **Description:** `snoozed_until = server now + n` (SYNC_PROTOCOL 14.5). A snooze made offline and synced hours later was applied from the *server* clock, so the other devices rang `n` minutes after the sync, not after the owner's tap; the device that snoozed already rang its optimistic alarm and suppresses the duplicate (revision +1 rule). Seen in the reminder-core simulation (`nothing_lost` oracle needed an explicit exception).
- **Mitigation (owner-approved, implemented 2026-11-09, M8-04b-ii; ADR-0068 D11):** an optional `acted_at` on the action (ISO-8601 with an offset, device clock), **clamped, never rejected**, to `[server now - 24 h, server now + 5 min]` and used only as the base of the duration (`snoozed_until = base + n`, `acknowledged_at = max(base, effective_at)`); never used to order actions, not stored, part of the idempotency fingerprint; the client sends it only when the action waited at least 60 s and freezes that at the first send. A snooze that is already over when it syncs is shown at once by the other devices (their catch-up window equals the clamp, 24 h). Tests: server unit and integration (clamp edges, past/future/ancient values, replay byte-identical vs changed, no ordering by `acted_at`, naive value `422`), sync-core unit (sent only after a minute, frozen across retries), simulation invariants `acted_at_sent`, `snooze_counts_from_the_tap`, `acted_at_clamped` with planted defects, and the model-versus-real conformance scenario (acted_at 4 h ago, 3 days ahead, 9 days ago).
- **Residual:** a device clock that is wrong shifts one snooze by up to 24 h earlier or 5 min later than the server's reading, and only for an action that was queued for a minute or more (a prompt send uses the server clock); beyond the window the value is clamped. A task re-dated or completed meanwhile is handled by the normal rules (a snooze on a cancelled reminder changes nothing). `NOT RUN` on a real device.
- **Owner milestone:** M8-04b-ii. **Status:** Resolved (residual accepted, see above).

### Status updates (2026-11-09)
R-68 resolved by the clamped `acted_at` (M8-04b-ii, ADR-0068 D11). New residuals of M8-04b-ii: the Python model/real simulations have no `reminder` (covered by the TypeScript model and the model-versus-real conformance); the real-API reminder run uses the real clock so alarms rarely fire in it; the model's `remind_at` is the due instant (the real server applies the default timing), so conformance compares relative outcomes; nothing ran on a device.
R-65/R-66 (clock, duplicates and stale notifications): server half mitigated and tested (absolute instants, `reminder` feed with no churn, `sent` never a device state, cross-device dismissal/snooze, device fired-set and fired-before-show in `packages/reminder-core`); device half still needs M8-04c/d and hardware. R-67: SSRF origin pinning, no redirects, encrypted endpoint, coalescing, breaker, log-capture test and the ntfy ACL hardening verified against ntfy 2.37.2 on loopback; headless sync (G12) and the Android distributor remain open.

---

### R-69 - Script running in the desktop webview can use the session (SYNC-09)
- **Severity/Likelihood:** Medium / Low
- **Description:** the token cannot be read by the page (no command returns it), but any script that runs in the page (XSS in rendered Markdown, a compromised dependency in the bundle) can call `api_request` and the folder commands inside the granted root, and can read the local database through `db_*`. This equals what the same script could do in the browser app.
- **Mitigation:** CSP `default-src 'none'; script-src 'self'` with no inline script and no remote origin, DOMPurify on every rendered note, no `fs`/`shell`/`opener` plugins, per-command ACL, a root that only the native dialog can grant, a header/path/method allow-list in `api_request`, narrow device scope on the server (T22), device list and instant revoke. Not done: a per-origin allow-list of API paths inside `api_request` (it would duplicate the server's authorisation).
- **Owner milestone:** SYNC-09 (accepted for phase 1). **Status:** Accepted.

### R-70 - AppImage supply chain and portability (SYNC-09e)
- **Severity/Likelihood:** Medium / Medium
- **Description:** the AppImage bundles WebKitGTK and libraries from the build machine (rolling Arch), so it may need a newer glibc than an older distribution has; the bundler downloads tools from GitHub, one from a moving `continuous` release.
- **Mitigation:** tools pinned by SHA-256 and verified before every bundle (`packaging/bundler-tools.tsv`, `fetch-bundler-tools.sh`; a mismatch stops the build); the `.deb` uses the distribution's WebKitGTK; the build is documented and keeps the previous AppImage as the rollback. Three builds on one machine gave byte-identical binaries and AppImages (the `.deb` differs by timestamps). Not done: a build on an older distribution (or in a container) to widen compatibility, and reproducibility across machines (system libraries are bundled).
- **Owner milestone:** SYNC-09e. **Status:** Mitigating.

### R-71 - Hidden webview: timer throttling and a heavier resident process (SYNC-09d)
- **Severity/Likelihood:** Medium / Medium
- **Description:** close-to-tray keeps the webview (and therefore the engine and scheduler) alive but hidden; WebKit may throttle timers of a hidden page, and the resident footprint is a WebKitWebProcess plus the app (about 300 MB PSS measured idle). Sleep/resume and clock jumps are handled by the scheduler's jump detection, not measured on a real suspend.
- **Mitigation:** engine tick 1 s, scheduler tick 30 s, live poll as one in-flight request, wake events on focus, `onClockChange` on a wall/monotonic mismatch; the e2e run shows sync and file writes continuing while the window is hidden. Not done: a 30-minute hidden-window lateness measurement and a real suspend/resume test (M8-04g).
- **Owner milestone:** M8-04c/g. **Status:** Open.

### R-72 - Notes-folder races and limits of an inotify/hash design (SYNC-09b)
- **Severity/Likelihood:** Low / Low
- **Description:** (a) between the final hash check and the rename of a server write there is a window of microseconds in which an editor's save could be overwritten (the overwritten text stays in the server history and the next scan treats the file as an edit based on the newer revision); (b) the cheap periodic scan trusts size+mtime, only the scans on start, focus and every five minutes hash everything, so a same-size same-mtime edit can wait up to five minutes; (c) cloud-synced folders (OneDrive/Dropbox placeholders) and network drives were not tested; (d) a very large folder (tens of thousands of notes) was not measured; (e) the first run in a folder that already holds notes keeps both texts when a name collides with a server note but cannot tell which is newer.
- **Mitigation:** compare-and-swap writes with the check repeated before the rename; the full hash scan on start/focus/5 minutes; every external edit carries its base so the server merges or keeps a conflict copy; deletes go to `.atlas-trash/`; a missing root is an error, never an empty list; all tested (ACCEPTANCE SYNC-09b). Not done: the cloud-folder and large-folder checks.
- **Owner milestone:** SYNC-09b/SYNC-12. **Status:** Accepted with the limits listed.

### R-73 - The existing web UI inside the shell meets a narrow device scope (SYNC-09c)
- **Severity/Likelihood:** Medium / High (expected, handled)
- **Description:** a device token is refused on account-level endpoints (`403 forbidden_scope`, T22), while parts of the web UI call them (Settings: Account, Notifications/Web Push, Calendar, Devices, Data; maybe others such as note-reminder preferences). Two engines (the UI's M7 queue over REST, and the runtime's sync-core) share one device.
- **Mitigation:** the shell hides the browser-only Settings sections; the e2e probe loads the main lists through the bridge (`/api/auth/me`, tasks, notes, projects, instance: 200). Not done: a click-through of every page for a stray `403`, and moving the UI onto the local database (SYNC-11/12), which removes the second engine.
- **SYNC-11c (2026-11-10):** the second SYNC engine is gone from the shell: the status bar and Settings > Sync read sync-core, and the browser's offline queue, reconciler and cursor are never started there (`Settings.shell.test.tsx` fails if they are). What remains of the original risk: the UI's task, project and note reads and writes are still online REST through the host, so an edit made in the shell UI while offline fails visibly (as in the browser) instead of queueing in the engine.
- **Owner milestone:** SYNC-11/12. **Status:** Open, narrower (UI data on the local store is SYNC-11d/12).

### R-74 - The shell cannot name the other device in "changed on another device"
- **Severity/Likelihood:** Low / High (expected, handled)
- **Description:** a device token may not list devices (SECURITY T22), so the desktop shell knows only its own device name; entries from other devices read "another device" (a browser, which may list devices, shows names).
- **Mitigation:** generic wording; the device list is one click away in the browser. Not done: adding the device name to the resolution entry on the server (it would change the feed shape and the sync-core record for wording only) or opening `GET /api/devices` read-only to devices.
- **Owner milestone:** SYNC-11. **Status:** Accepted.

### R-75 - "Discard local changes and re-download" and the notes folder
- **Severity/Likelihood:** Medium / Low
- **Description:** the discard choice of the restore screen drops unsent operations and adopts the restored server. In the desktop app the notes folder is files: a file that exists only locally (created or edited after the server's backup) is not deleted by Atlas, so the next scan adds it again as a new note, and a note the server lost is treated as deleted (its file goes to `.atlas-trash/`). The choice is therefore "drop Atlas's queue", not "make the folder match the server".
- **Mitigation:** the screen says so before the second confirmation; nothing is deleted from the folder; the e2e run checks a local file survives (`apps/desktop/e2e/run.mjs`). Not done: a mode that also moves such files to the trash.
- **Owner milestone:** SYNC-11/12. **Status:** Accepted.


### R-76 - Calendar adapters were verified against fixtures, not the real services
- **Severity/Likelihood:** High / Medium
- **Impact:** A documented shape that differs in practice (field names, `410` behaviour, Graph window/delta quirks, consent screens) breaks sync for the owner; passing tests would hide it.
- **Mitigation:** Fixtures follow the cited reference pages; M5-00/03/04/05/07/11 stay `IN_REVIEW`; REQ-007/008/009 say "implemented, live compatibility UNVERIFIED"; the live runbook and evidence template exist (`CALENDAR_SYNC.md` 12.7). **Status:** Open until the owner records the evidence.

### R-77 - ICS feed URL is a bearer secret and a fetch target
- **Severity/Likelihood:** High / Low
- **Impact:** A leaked URL exposes the whole calendar; a hostile URL could probe the operator's network (SSRF).
- **Mitigation:** Sealed at rest, masked everywhere, never logged; SSRF guard with pinned addresses and re-validated redirects, size/time caps, rate limit; revoke by regenerating the link (documented). **Status:** Mitigated in code and tests; a determined attacker who already controls the owner's session can still add a feed that points at a public host (accepted).

### R-78 - Proton feed delay and the absence of a Proton API
- **Severity/Likelihood:** Low / High
- **Impact:** Proton changes appear late or not at all in Atlas; no write-back; a regenerated link disconnects the feed.
- **Mitigation:** Documented; the last good events stay visible with a clear "link rejected" / "unreachable" error. **Status:** Accepted (outside Atlas's control).

### R-79 - Microsoft delta window and one account per provider
- **Severity/Likelihood:** Low / Medium
- **Impact:** Microsoft events older than the window (default 90 days) or beyond +365 days are not shown; a second Google or Microsoft account cannot be connected.
- **Mitigation:** Documented (`CALENDAR_SYNC.md` 11); window configurable; multi-account is a later change of the credential key. **Status:** Accepted for personal use.

### R-80 - OAuth callback depends on the browser reaching `PUBLIC_BASE_URL`
- **Severity/Likelihood:** Medium / Medium
- **Impact:** With the name resolving to the tailnet only, connecting from a device off the tailnet fails at the redirect; a changed port or name gives `redirect_uri_mismatch`.
- **Mitigation:** The Settings card shows the exact URI; the guide explains the `:9443` form and that the redirect is made by the browser; nothing is exposed publicly to make it work (SEC-01). **Status:** Open (operational).

### R-81 - Accent colours can resemble semantic colours
- **Severity/Likelihood:** Low / Medium
- **Impact:** With a Red, Orange or Amber accent, links and buttons look like overdue/warning colours; the preference is per device, so a new browser looks different until it is set again.
- **Mitigation:** Semantic colours keep icons and words (chips are never colour alone), are tested separately and never follow the accent; the default is Neutral; the picker says so. Syncing the preference is a later option (ADR-0073 D8). **Status:** Accepted.

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
| 2026-11-03 | SYNC-06 (device credentials) | R-35 narrowed to the client keystore (server side done); R-52 (rotation does not detect theft of the current token) and R-53 (no per-device feed/snapshot limits; in-process limiters) added. Found while building: a `git checkout` of a generated schema file cost a re-edit (process, not product); the simulation needed a slack term in `no_duplicates` for creates a revoked device had applied but never saw acknowledged. |
| 2026-11-03 | UX-11 | Remaining phone pages and removal of the standalone Board (ADR-0064): UI-only; R-51 added (emulation only; board-less tasks). |
| 2026-11-03 | UX-10 | Week agenda, phone capture sheet, menu sheets, 16 px fields and safe areas (ADR-0063): UI-only; R-50 added (emulation only: keyboard, insets, screen readers). |
| 2026-11-03 | UX-09 | Readability tokens, one row anatomy and section cards (ADR-0062): UI-only; R-49 added (CSS behaviours verified in Chromium only). |
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
| 2026-11-04 | SYNC-08 (`sync-core`) | R-40 mitigated in the shared client core; R-54 (web app stays on the M7 engine) and R-55 (what the TS simulation does not prove) added. |
| 2026-11-03 | SYNC-04 (note history and merge) | R-42 closed (server side); R-28 and R-40 updated (the note simulation found that a replayed *delete* acknowledgement needs the same re-read rule as a create, seed 109); R-44 (history keeps overwritten and deleted text; disk) and R-45 (conservative merge, conflict-copy volume) added. |
| 2026-11-03 | SYNC-03 (protocol v1) | R-38 (snapshot walk vs floor, sim seed 29) found and closed; R-39 (restore regrowth, `epoch`), R-40 (late ack vs tombstone, sim seed 681), R-41 (resolutions response-only until SYNC-05), R-42 (notes not merge/delete-safe until SYNC-04), R-43 (idempotency purge scan) added. R-28, R-29, R-30, R-31 moved to Mitigating (server side). |
| 2026-11-03 | SYNC-05 (resolution log) | R-41 closed on the server; R-47 (log keeps overwritten simple values 90 days) and R-48 (strict undo is often refused on busy fields) added; R-28 updated. Found and fixed: a retried refused note `DELETE` replayed status `0` (key committed without its answer, SYNC-04 code). The conformance traces found two model/real disagreements (`kept_revision` of revive and collision, `detail` of `path_later_wins`), fixed on both sides. |
| 2026-11-03 | P0-1/P0-2/P0-3 | R-46 added (smoke test of the Compose stack found and fixed six defects; four accepted edges). R-34 verified through the real web container (1.5/5/10 MiB `201`, 12 MiB `413`). First restore drill of a set that contains note history. |
| 2026-11-04 | P0-4 / SYNC-07 Windows | First GitHub Actions runs: R-61 (npm audit finding in dev tooling, owner decision) and R-62 (CI-only environment differences, fixed) added; R-36 updated with the hosted-Windows-runner results (build, per-user installer, signed update, headless checks, supply chain; admin/UAC/SmartScreen/AV/OneDrive/IME still the owner's). |
| 2026-11-04 | M8-04 design (ADR-0068 PROPOSED) | R-63 to R-67 added (Android missed reminders, resident desktop app, clock/zone, duplicates/stale across devices, the hint channel); R-59 updated (resident app chosen as mitigation). Design only, nothing built. |
| 2026-11-10 | SYNC-11 | R-74 and R-75 added; R-22, R-48, R-54 and R-73 updated (conflict, notice and restore screens exist; the shell no longer runs two sync engines; the browser stays on its engine, SYNC-11d planned). |
| 2026-11-10 | SYNC-09 phase 1 (Linux) | R-69 to R-73 added (script in the webview, AppImage supply chain, hidden webview, folder races/limits, device scope vs web UI); R-60 now Mitigating; R-36 unchanged (Windows still not run); R-58 unchanged (DMABUF variable is set automatically on NVIDIA); a new advisory (RUSTSEC-2026-0459, SQLite) was found by `cargo audit` and fixed by moving rusqlite 0.37 to 0.41. |
| 2026-11-10 | Calendar Stage A | R-76 to R-80 added; R-01 and R-13 moved to Mitigating (guide, adapters, re-authorisation flag), not closed: no live evidence yet. |
| 2026-11-10 | UX-12 | R-81 added (accent colours vs semantic colours; per-device preference). |
