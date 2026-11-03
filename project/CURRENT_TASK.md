- **UX-11 (remaining phone pages; standalone Board removed) is `DONE` locally (2026-11-03, not committed, CI not run). The UX series UX-01...UX-11 is complete.**
  ADR-0064, evidence `docs/ACCEPTANCE.md` UX-11 (verify.sh PASS: pytest 4172, vitest 896; real-stack 69 passed incl. 8 new in
  `e2e-real/ux11-phone-pages.spec.ts`; mocked e2e 7 passed), R-51. Next work is outside the UX series (SYNC-06 and later, see below / `ROADMAP.md`).
  NOT RUN: real phone (keyboard, notch, iOS zoom), TalkBack/VoiceOver, Safari/Firefox.

## UX-11 conventions to keep
- **No standalone Board**: `/board` redirects to `/projects`; the project page's Board tab (`components/Board.tsx` + `hooks/useBoard.ts`) is the only board; the
  Tasks page has no board view and ignores `view=` (`TaskFilter.view` deleted). Tasks with no project are on no board (R-51).
- Touch/phone split: `PHONE_QUERY` (<= 720 px) for layout swaps (Board one column + `Tabs` with counts, Notes phone toolbar `.notes-header.is-phone`), `SHEET_QUERY`
  (phone or no hover) for sheets, Select mode, the "Filters" sheet button (`FilterBar` `is-compact`) and the palette sheet. 44 px rules are keyed on
  `(pointer: coarse), (max-width: 720px)` (Chromium emulation did not report coarse).
- Select mode (Tasks, touch): `RowSelection.exclusive` hides the round completion box; entered from "Filter options" > "Select tasks"; Done clears.
- Notes phone: `choosePhoneView` makes Source/Live/Preview exclusive; "Links and details" is the first "Note options" item (helpers `openNoteDetails` handles both).
- Specs: `e2e-real/ux11-phone-pages.spec.ts` (sweep helper `measure`: checkbox = its label, skips inline links, note-content controls, list-row title buttons).

## UX-10 summary (previous step)
- **UX-10 (Week agenda, phone capture sheet, menu sheets, 16 px fields, safe areas) is `DONE` locally (2026-11-03, not committed, CI not run).**
  ADR-0063, evidence `docs/ACCEPTANCE.md` UX-10 (verify.sh PASS: pytest 4172, vitest 898; real-stack 61 passed incl. 5 new in
  `e2e-real/ux10-phone.spec.ts`; mocked e2e 7 passed), R-50. **Next UX step: UX-11** (`READY`: Tasks select mode and filter strip, Board column
  view, Notes toolbar, Projects cards, palette sheet). Not built from the UX-10 plan: the Inbox per-row "Today" button (owner may decline).
  NOT RUN: real phone (keyboard, notch, iOS zoom), TalkBack/VoiceOver.

## UX-10 conventions to keep
- Phone breakpoints in `lib/phone.ts`: `PHONE_QUERY` (<= 720 px: FAB, no inline Today capture) and `SHEET_QUERY` (<= 720 px or `(hover: none)`: menus
  and popovers are sheets); `promoteToTopLayer` for the native Popover API. jsdom has no `matchMedia`, so unit tests get desktop unless they stub it.
- Capture: `components/CaptureSheet.tsx` exports `CaptureFab` (page passes its own `onCapture`, `destination` for the confirmation). Render it as the
  last child of the page `section.page` (the sheet makes `.page` `inert` while open). Never duplicate capture logic; `QuickCapture` guards double submit.
- Sheets: `.sheet` / `.sheet-scrim` / `.menu.is-sheet` in `styles.css`; safe-area insets come from `--safe-*` and `--bottom-clear` (padding only takes scale
  tokens, so insets use `height`, `border-top` and `::after` spacers). Keyboard: `--kb` from `useKeyboardInset`.
- Week: `.week-agenda` (container `week`) > `.week-days` (auto-fit grid) > `ViewSection.week-day[.is-today][.is-empty]`; navigation is the shared `.segmented`.
  Do not put `container-type` on the page (it would trap fixed children).
- Touch: `(pointer: coarse), (hover: none), (max-width: 720px)` gives 16 px fields, 44 px segments, chips, filter menu.
- Specs: `e2e-real/ux10-phone.spec.ts` (shares one seed; the layout test excludes `.sr-only` boxes and phone ellipsised meta from the inner-scroll scan).

## UX-09 summary (previous step)
- **UX-09 (readability tokens, task row anatomy, section cards) is `DONE` locally (2026-11-03, not committed, CI not run).** ADR-0062,
  evidence `docs/ACCEPTANCE.md` UX-09 (verify.sh PASS: pytest 4172, vitest 877; real-stack 56 passed; mocked e2e 7 passed), R-49.
  **Next UX step: UX-10** (`READY`: Week agenda layout, phone FAB + capture sheet, bottom-sheet menu, 16 px inputs).

## UX-09 conventions to keep
- Rows: `TaskMeta` renders `.task-meta` > `.task-meta-when` (due chip `.task-due.due-overdue|due-today|due-later`, `.task-priority`,
  `.task-subtasks`) and `.task-meta-context` (`.task-parent`, `.task-project.project-tag` with `.project-dot.project-cN`, up to 2
  `.task-tag` + `.task-tag-more`); board cards use the flat `.task-meta.is-compact`. Due chip logic is `lib/dueChip.ts` (state from
  the server's `due_state`; `day` prop = the day group, drops the date). `data-meta-lines` (0-2) drives the phone title clamp (three
  lines max). The whole `.task-body` opens the task (onClick on the div; the `Open <title>` button bubbles; do not add a second handler).
- Sections: `components/ViewSection.tsx` (`section > h2.section-head` first child, `aria-hidden` count, `tone` overdue|today); `.list-card`
  for a list with no header; add `tinted-page` to a page to get the phone page tint. Project hue: `lib/projectColor.ts` (FNV-1a % 8; never change).
- Tokens: `--bg-page/-card/-section`, `--row-sep`, `--due-*`, `--priority-*`, `--project-1..8` in all three colour blocks and in
  `styles.test.ts`. Font sizes only from the scale (phone line 2 is 14 px, line 3 12 px).
- Touch: `@media (pointer: coarse), (max-width: 720px)` gives the 44 px checkbox (an input drawing a 22 px circle) and "...", rows >= 56 px.
- Specs: `e2e-real/ux09-readability.spec.ts`; selectors unchanged (`.task-row`, `.task-priority`, `.task-due`, `.project-tag`, names).
- Not done (UX-10/11): Week agenda, FAB, bottom-sheet menu, 16 px inputs, Tasks select mode, Board, Notes, Projects cards, palette.

---

# Current Task

- **SYNC-05 (resolution log, `resolution` feed entity, list and undo) is `DONE` locally (2026-11-03, not committed, CI not run).**
  Delivered in seven verified sub-steps 05a-05g (`docs/ROADMAP.md` SYNC-05, evidence `docs/ACCEPTANCE.md` SYNC-05, decisions ADR-0061,
  contract `docs/SYNC_PROTOCOL.md` section 9, data `docs/DATA_MODEL.md` `SyncResolution`). New migration `f4a8b2c6d1e3` (reversible;
  **not applied to the owner's `atlas` database**: the owner's next `atlas-migrate`/stack start applies it after `a1f0c3d2b4e6`..`e7a3c5b1d9f2`
  if those are pending; tested on `atlas_test` and a scratch database only). New code: `atlas/models/resolution.py`,
  `atlas/sync/resolution_rules.py` (pure) and `resolution_log.py` (store/announce/page/purge), `atlas/api/resolutions.py` (list, get,
  undo), `log_resolutions` in `atlas/api/syncio.py` called at every sync write site (tasks, projects, notes) in the write's transaction,
  `plan_merge(strict=True)` + `update_sync(strict=True)` (undo), `ChangeEntityType.RESOLUTION`. Retention reuses `CHANGE_RETENTION_DAYS`
  (no new setting). `device_id` is `NULL` until SYNC-06 (the column and `ResolutionLog(device_id=...)` are the interface).
- **Interfaces SYNC-06/08/11 must honour:** a resolution is a feed entity with state 1 (2 once undone); clients apply it by state,
  keep it as a notice and drop it when older than `sync.tombstone_retention_days` or absent from a fresh snapshot (no `delete` row);
  `undoable`/`undo_blocked`/`follow_up` say what the UI may offer; an undo needs an `Idempotency-Key`, answers `applied: false` when the
  value is already there, and `409 conflict`/`changed_since` (with the current value) when the field changed since: the UI must say so
  and offer "set it by hand" (R-48); a refused stale `DELETE` (`409 edit_wins`) is **not** logged (ADR-0061); the sim client rule "a 2xx
  is historical" applies to an undo answer too (the entity is re-read at the next pull). SYNC-06 fills `device_id` and can then
  compare it with the client's own device to show "changed on another device" only for others.
- **What the work found (read `RISKS.md` R-47, R-48 and the ADR-0061 point 6):** a retried refused note `DELETE` replayed status `0`
  (SYNC-04 code, fixed, regression test); the conformance traces caught two model/real disagreements; a flaky SYNC-04 conformance
  assertion (`three-way merge, conflict copies and replay` step 9: two conflict copies listed in clock-stamp order across a second
  boundary) is now order-insensitive. The simulation needed an "undo wave" after the first quiescence, because a faulty run learns its
  notices too late to undo them (`TESTING.md` 10.0c).
- **Next (smallest logical step): SYNC-06** (device credentials: table, bearer auth, rotation, revoke; AUTH-01 calls the revoke
  function; fills `device_id`). SYNC-07 (Tauri spike, Linux first) is independent. Then SYNC-08 (`packages/sync-core`). Not built:
  `reminder_policy`/`preferences` feed entities (owner decision on reminder sync timing), `ETag`/`If-None-Match` on note reads.
- **Owner to do (unchanged from P0):** rebuild and recreate the stack when ready (`docker compose -f deploy/docker-compose.yml up -d
  --build`, back up first), `tailscale serve` per `DEPLOYMENT.md` 8.1, one restore drill on real data, copy backups off the machine,
  then P0-4 (`e2e-real` on CI) and P0-6 (dogfood).
- A concurrent session edited `docs/UX_AUDIT.md` and added UX-09..UX-11 to `docs/ROADMAP.md` while SYNC-05 was in progress; those
  changes are not part of SYNC-05 and are in the same uncommitted tree.
- Commands: `./scripts/verify.sh`; sim soaks in `docs/TESTING.md` 10.0/10.0a/10.0b/10.0c (`ATLAS_SIM_SEEDS`, `ATLAS_SIM_REAL_SEEDS`,
  `ATLAS_SIM_STEPS`, `ATLAS_SIM_SEED`); `cd apps/web && npm run test:e2e:real`.

---

## Earlier state (personal alpha P0-1..P0-3)

- **Personal alpha steps P0-1, P0-2, P0-3 done locally (2026-11-03, not committed, CI not run).** Results and the install guide:
  `docs/ACCEPTANCE.md` P0-1/P0-2/P0-3, `docs/DEPLOYMENT.md` sections 8 and 11, `docs/OPERATIONS.md` 1.4 and 2.7, `RISKS.md` R-46.
  Code/config changed: `deploy/docker-compose.yml` (one shared env block with every setting, `DATABASE_URL` from `POSTGRES_*`,
  `atlas-exports` volume, web on `127.0.0.1` via `WEB_BIND`), `services/api/Dockerfile` (exports dir), `apps/web/nginx.conf`
  (keeps `X-Forwarded-Proto`), `atlas/main.py` (422 no longer echoes huge input; `/health*` exempt from `ALLOWED_HOSTS`),
  `.env.example`, tests `test_compose_env.py`, `test_nginx_config.py`, `test_security.py`, `test_note_sync_merge.py`.
  `./scripts/verify.sh` PASS. The owner's `atlas` database, containers and dev stack were not touched; the three smoke projects
  and the `atlas-smoke-*` images were removed.
- **Owner to do:** rebuild and recreate the stack when ready (`docker compose -f deploy/docker-compose.yml up -d --build` applies
  migrations `a1f0c3d2b4e6`..`f4a8b2c6d1e3`, back up first), run `tailscale serve` per `DEPLOYMENT.md` 8.1, do one restore drill on
  real data (`OPERATIONS.md` 2.7), copy backup sets off the machine, then P0-4 (`e2e-real` on CI) and P0-6 (dogfood).
- (At that time the next engineering step was SYNC-05; it is done, see above.)

---

## Earlier state (SYNC-04 finished)

- Task ID: none in progress. **SYNC-01 … SYNC-04 are `DONE` locally (2026-11-03, not committed, CI not run).**
  **SYNC-04 (note history, three-way merge, move/delete/revive, portable paths) delivered in seven verified sub-steps**
  (`docs/ROADMAP.md` SYNC-04, evidence `docs/ACCEPTANCE.md` SYNC-04, decisions ADR-0060): 04a history (`note_revisions` + content-addressed
  files in `.atlas/history`, recorded by every revision bump, retention 20 / 90 days / 200 / 64 MiB, hourly prune, history endpoints),
  04b `atlas/notes/merge.py` (in-repo diff3, property-tested; library evaluation in `DEPENDENCIES.md`), 04c sync `PUT` with `base_hash`,
  merge, server-saved conflict copies answered `409 conflict`, replay with content, 04d edit-wins/revive/move rules, 04e portable paths
  (`atlas/notes/portable.py`), 04f note simulation (model + real + conformance + 10 planted defects), 04g docs/openapi/e2e. One new migration
  (`e7a3c5b1d9f2`, reversible); **it was not applied to the owner's `atlas` database** (tested only on `atlas_test`): the owner's next
  `atlas-migrate`/stack start applies it, and the SYNC-03 migrations before it if not yet applied. The `web` image still needs a rebuild
  for the 11m nginx limit.
- **What the work found (read `RISKS.md` R-40, R-44, R-45):** a replayed *delete* acknowledgement can tombstone an entity another device
  revived (sim seed 109 at 700 steps; client rule for SYNC-08, model client fixed for every kind); a lone surrogate in a JSON string was a
  `500` (fixed for all requests); history keeps overwritten and deleted text up to 90 days (documented privacy trade-off, R-44).
- **Next (smallest logical step): SYNC-05 (resolution log, feed entity, undo)** - its row shape is the response-only `sync.resolution`
  (rules now include `note_merged`, `path_later_wins`, `path_collision`, `edit_wins_over_delete`; note content is never copied into the log).
  Then SYNC-06 (devices; meets AUTH-01 at the revoke function). SYNC-07 (Tauri spike, Linux first) is independent. Not built:
  `reminder_policy`/`preferences` feed entities (owner decision on reminder sync timing), `ETag`/`If-None-Match` on note reads.
- Interfaces SYNC-05/06/08 must honour: a note `PUT` in sync mode needs `base_hash`; the client keeps the text it based an edit on only as
  `(revision, hash)` - the server holds the base; `409 conflict` carries `conflict_copy` (the loser is already saved, do not create another);
  a `2xx` replay may carry `content` (from history) or not (pruned: read the note); `Atlas-Epoch` check and `field_revisions` rules
  as in the SYNC-03 notes below; any new note write path must call `NoteHistory.record` in the same transaction as the revision bump
  (`NotesService`, reconciler) or a stale client cannot be merged against that revision.
- Commands: `./scripts/verify.sh`; sim soaks in `docs/TESTING.md` 10.0/10.0a/10.0b (`ATLAS_SIM_SEEDS`, `ATLAS_SIM_REAL_SEEDS`,
  `ATLAS_SIM_STEPS`, `ATLAS_SIM_SEED`); `cd apps/web && npm run test:e2e:real`.

---

## Earlier state (SYNC-03 finished, SYNC-04 not started)

- Task ID: none in progress. **SYNC-01, SYNC-02 and SYNC-03 are `DONE` locally (2026-11-03, not committed, CI not run).**
  **SYNC-03 (protocol v1 server) delivered in seven verified sub-steps** (`docs/ROADMAP.md` SYNC-03, evidence
  `docs/ACCEPTANCE.md` SYNC-03): 03a `field_revisions` (+ backfill), 03b `Atlas-Sync`/`426`/instance `sync` block/`epoch`/
  `atlas-admin record-restore`, 03c client ids + live-path unique index + note sync-mode idempotency, 03d field merge and edit-wins,
  03e feed (`include=data`, `types=`, snapshot, `snapshot=true`, tombstone-only retention 90 d, idempotency TTL), 03f simulation
  v1 + conformance, 03g docs/openapi/e2e. Three new migrations (`a1f0c3d2b4e6`, `c3b7d9e1f2a8`, `d5e8a2f1c4b9`); **none was
  applied to the owner's `atlas` database** - the owner's next `atlas-migrate`/stack start applies them (tested only on `atlas_test`);
  the `web` image still needs a rebuild for the 11m nginx limit.
- **What the simulation found (read `RISKS.md` R-38, R-40):** a multi-page snapshot bootstrap restarted forever once the purge
  floor passed its first page (fixed: `snapshot=true`); a late create acknowledgement can resurrect an entity the cursor already
  passed as deleted (client rule for SYNC-08: re-read acknowledged entities, remember tombstones for unknown ids).
- **Next (smallest logical step): SYNC-05 (resolution log, feed entity, undo)** or **SYNC-04 (note history + three-way merge)**;
  SYNC-04 first if notes are the priority (`RISKS.md` R-42: note writes in sync mode are idempotent but not merge/delete safe).
  Both depend only on SYNC-03. SYNC-06 (devices) meets AUTH-01 at the revoke function. SYNC-07 (Tauri spike, Linux first) is
  independent. Not built from the SYNC-03 spec list: `reminder_policy`/`preferences` feed entities (need an owner decision on
  reminder sync timing).
- Interfaces SYNC-04/05/06 must honour: `sync.resolution` (response-only today) is SYNC-05's row shape; note `PUT` rejects unknown
  fields in sync mode until `base_hash` is added; `Atlas-Epoch` is checked after authentication in `api/sync_gate.py`
  (`epoch_check`, a dependency on the tasks/projects/notes/changes routers - add it to any new sync-capable router);
  `field_revisions` must be stamped by any new code path that changes a task/project field (`atlas/sync/fields.py`).
- Commands: `./scripts/verify.sh`; sim soaks in `docs/TESTING.md` 10.0/10.0a (`ATLAS_SIM_SEEDS`, `ATLAS_SIM_REAL_SEEDS`,
  `ATLAS_SIM_STEPS`, `ATLAS_SIM_SEED`); `cd apps/web && npm run test:e2e:real`.

---

## Earlier state (SYNC-03 pre-work, SYNC-01/02)

- Task ID: none in progress. **SYNC-01 and SYNC-02 are `DONE` locally (2026-11-03, not committed, CI not run).**
  SYNC-01: reconcile feeds `/api/changes`; `cursor_ahead`/`below_floor` `resync_reason`; cursor ordering proven by
  `tests/integration/test_change_concurrency.py`; nginx 1 MiB body limit verified as a real defect (R-34, fixed in SYNC-03 pre-work).
  SYNC-02: Python simulation harness `services/api/tests/sim/` (docs/TESTING.md 10.0): model server/clients, fault network,
  invariants, planted bugs, conformance, real-API runs; env `ATLAS_SIM_SEEDS`, `ATLAS_SIM_REAL_SEEDS`, `ATLAS_SIM_STEPS`,
  `ATLAS_SIM_SEED`.
- **SYNC-03 pre-work `DONE` locally (2026-11-03, not committed, CI not run):** R-37 fixed (row lock before the
  `base_revision` check on task/project PATCH and note PUT, plus delete/restore/rename; lock order entity rows then change
  cursor, bulk task locks by id), R-34 fixed in `apps/web/nginx.conf` (`11m` for `/api/`, `1m` elsewhere; web image NOT
  rebuilt, owner must rebuild), reconcile removal now shares `NotesService.tombstone_index` (project links dropped and
  announced). Evidence: `docs/ACCEPTANCE.md` "SYNC-03 pre-work". New tests: `test_revision_races.py`,
  `test_nginx_config.py`, 5 in `test_notes_reconcile.py`.
- **Also fixed before commit (owner asked for all findings):** sim seed 482 at 300 steps (root cause: the model client
  installed a replayed create acknowledgement over a tombstone it had already pulled; a missing client rule, not a server
  flaw; the rule is in `SYNC_PROTOCOL.md` section 8.1); nginx limit raised to 11m (covers escaped notes); the
  task-into-deleted-project race (lock order project, task, cursor; `FOR NO KEY UPDATE` row locks). Nothing known is open
  from this work except that the `web` image must be rebuilt and CI has not run.
- **Next:** the rest of SYNC-03 (protocol v1 server: `field_revisions` backfill, `Atlas-Sync` header, `426`, `include=data`,
  `types=`, snapshot, tombstone-only purge, idempotency-key TTL job, `GET /api/instance` sync block, deprecate
  `GET /api/tasks/changes`). SYNC-07 (Tauri spike) still open.

---

## Earlier state (SYNC design, then UX)

- Task ID: none in progress. **SYNC design delivered 2026-11-03 (docs only, nothing implemented, not committed):**
  `docs/SYNC_PROTOCOL.md` (gap analysis of M7 vs ADR-0055, protocol spec), ADR-0059 (PROPOSED, decisions D1-D12 for the
  owner), SYNC milestone in `docs/ROADMAP.md` (SYNC-01..12, Tauri spike plan under SYNC-07), `docs/TESTING.md` section 10
  (simulation strategy), `docs/SECURITY.md` section 12, `docs/RISKS.md` R-28..R-36.
- **Next:** SYNC-01 (`READY`: record note reconcile in the change feed; `cursor_ahead` resync signal; cursor concurrency
  test), then SYNC-02 (`READY`: simulation harness). SYNC-07 (Tauri spike, Linux first) may run alongside; Windows/Android
  need hardware. SYNC-03..06 are `BLOCKED` until the owner answers ADR-0059. AUTH-01 stays `BACKLOG` and meets SYNC-06 at the
  device-revoke function.
- Key findings to remember: reconcile never feeds `/api/changes`; the 30-day purge removes upserts so a new device cannot
  bootstrap from cursor 0 and `fullResync` is never supplied by the app; a restored server is invisible to clients (`since >
  head`); the API has no client-generated ids, no field merge, no note history, no device tokens, no versioning; `PATCH`
  without `base_revision` overwrites blindly. Unverified: Tauri behaviour on any platform, nginx body limit for 5 MiB notes.

---

## Earlier state (before the SYNC design)

- Task ID: none in progress. The UX milestone (UX-01…UX-08) is `DONE` locally; next is the owner's choice: close MU
  (CI run of `e2e-real` + release re-score), AUTH-01 (needs the owner's approval of the recovery design) or calendar
  (M5-00, blocked on real accounts).
- Last completed: UX-08 (`DONE`, 2026-11-03, local verification; not committed): Settings sections, skeletons,
  one `EmptyState`, `main` landmark on sign-in/first-run. Decisions: ADR-0058. Evidence: `docs/ACCEPTANCE.md` UX-08
  (verify.sh PASS, pytest 1061, vitest 816, real-stack 52 passed, mocked e2e 7 passed). Before that UX-07
  (ADR-0057), UX-06 (ADR-0056), UX-05 (ADR-0054), UX-04, UX-03, UX-02, UX-01, MU-08. CI `e2e-real` NOT RUN.

- Milestone: UX — Design system and app shell (docs/ROADMAP.md "UX" section, ADR-0051, evidence in docs/UX_AUDIT.md)

- Dev stack: `scripts/dev-stack.sh` (docs/DEPLOYMENT.md §8a). `ATLAS_DEV_BIND=tailscale` exposes only Vite on the tailnet
  IP over plain HTTP for phone/laptop use; default is localhost-only.

## Goal (next)
No UX task is open. The owner may close MU (CI run + release re-score), approve the AUTH-01 design, or resume
calendar work. (R-24, CRLF read by the server, was fixed 2026-11-03.)

## UX-08 conventions to keep
- Settings = `pages/Settings.tsx` (layout only) + `lib/settingsSections.ts` (the one table: ids, labels, palette
  labels, one-line descriptions, `SETTINGS_REDIRECTS`, `SETTINGS_PALETTE`). Routes `/settings` and
  `/settings/:section`; `/settings` shows Account (no `aria-current` in the list) and on a phone only the list
  (`data-view="index|section"` + CSS at 720 px; no JS viewport logic). Add a section there, a body in
  `components/settings/` (or reuse a component), and one `case` in `SectionBody`. Do not give a section a page
  `h1`: the h1 is *Settings*, the section title is `h2#settings-section-title`.
- Rows: `components/settings/SettingsRow.tsx` (`label`+`htmlFor`, or `labelId` for a group; `description`
  becomes the hint). Keep ids and labels e2e uses: `Display name`, `Save name`, `Current password`, `New password`
  (exact), `Confirm new password`, `Change password`, radios `System/Light/Dark`, `Download export`, regions
  `Backups` and `Instance` (h3 inside the section). Helper `openSettingsSection(page, "<section label>")`.
- Navigation: `NAV_SECTIONS` "More" = Search + Settings; every `/settings/*` is the Settings entry
  (`normalise`); the palette reads `PALETTE_PAGES`; the status bar links to `/settings/sync` and
  `/settings/calendar`. Instance info is loaded only by Data and About (`hooks/useInstanceInfo.ts`).
- `components/Skeleton.tsx` (`label`, `rows`, `groups`, `kind` task|card|line|tree|board) is the loading state: it
  is `role="status"` with sr-only "<label>…" text, so use `getByRole("status").filter({hasText})`, not
  `getByText(/^Loading/)` while loading. `components/EmptyState.tsx` (icon from `Icon`, one line, optional single
  `action`) is the empty state; never a dashed box, never `role="status"`. Tasks: a filtered empty list has no
  action (the bar has *Reset filters*), a plain one offers *Go to Inbox*. Today shows one EmptyState only when
  overdue, due today and scheduled are all empty.
- Empty states in e2e: the journeys share one database, so `ux08` answers the list request (`/api/tasks`,
  `/api/projects`, `/api/notes`) with an empty list via `page.route`. Held requests (`hold()` in the same spec)
  show a skeleton.
- Not done: compact-density toggle, AUTH-01, Today date picker.

## UX-07 conventions to keep
- Tasks page = `pages/Tasks.tsx` + `components/FilterBar.tsx` (chips are `MenuButton`s over the shared `Menu`; the
  Due range and "Save this view" are `Popover` dialogs) + `components/BulkBar.tsx` (sticky, above the status
  bar/bottom nav). The URL is the filter (ADR-0045) plus the additive `view=board`; `useTaskQuery` ignores `view`.
  Filter rules are pure (`lib/taskFilters.ts`: `dueRangeFor`, `duePresetOf`, `dueLabel`, `chipValues`,
  `isFiltered`); saved views: `hooks/useSavedFilters.ts` (localStorage `atlas.savedTaskFilters`), UI in the bar's
  "…" menu (`Filter options`: `Save this view…`, `Saved views`, `Remove a saved view`).
- Names e2e relies on: search `Search`; chips are buttons named `Status: Open` / `Priority` / `Priority: High` /
  `Project` / `Due` / `Sort: Most urgent` (use `chooseFilter`/`openDueFilter`/`filterBar` in `e2e-real/helpers.ts`;
  the filter region is `search "Task filters"`); popover `Due date` with `Due from`, `Due to` and preset buttons;
  group `View` with `List`/`Board` (`aria-pressed`); `Reset filters` (only when something is set);
  `Filter options`; popover `Save this view` with `Saved filter name` + `Save this view`; toolbar `Bulk actions`
  (`N selected`, `Complete selected`, `Move to project…` menu, `Delete selected`, `Clear selection`); `Select all`.
- Board: `components/Board.tsx` props `archivedToggle` (button `Show archived (n)` / `Hide archived`, Archived column
  hidden by default), `emptyMessage`; `[`/`]` via `adjacentStatus` (`lib/taskStatus.ts`), focus restored after the
  card is re-created (5 s expiry), polite live region (not `role="status"`). `TaskMeta compact` for cards (flag =
  icon + sr-only "High priority"). Use `Board` for any new board; columns count is `--board-cols`.
- Projects: row = name link, `n open`, progress (`role="progressbar"` `Progress N%`, text `a/b done · N%`), `Target
  <date>`, menu `Actions for <name>` (`Open project`, `Archive project` / `Restore project`); `Show archived (n)`
  toggle. Project page: header with `Project options` (`Edit project`, `Archive project`, `Restore project`), tabs
  (`role=tab` Tasks / Board / Notes, `?tab=board|notes`, `components/Tabs.tsx`), `Completed (n)` / `Archived (n)`
  fold buttons (`FoldGroup`, collapsed on load), `Link a note` select on the Notes tab.
- Dates: `formatDay(isoDay)` / `formatDue` only; never print an ISO date. Shared popup placement: `lib/placePopup.ts`.

## UX-06 conventions to keep
- Live preview is `lib/livePreview.ts`: decorations only (a ViewPlugin building line/mark/replace decorations
  from the Lezer tree, plus regex for `[[wiki]]` and `#tags` outside code/URLs/HTML/front matter). It must never
  write the document; the only transactions it creates are the checkbox toggle and Ctrl/⌘ Enter on a task line,
  both ordinary changes that reach `session.change(text)` via `NoteEditor`'s update listener. Never put note text
  into an attribute or build HTML from it (the corpus test in `livePreview.test.ts` scans the DOM for this).
- `NoteEditor` takes `mode` (`source|live`) and `onOpenNote`; Live lives in a `Compartment` (mode change keeps
  document, selection, undo). The editor state uses the note's own line ending (`lineBreakOf`) and is serialised
  with `documentText(state)`, never `doc.toString()`. `refreshLive` re-resolves `[[links]]` when notes load.
- Mode preference: `atlas-notes-mode` (`readEditorMode`/`writeEditorMode`, `DEFAULT_EDITOR_MODE = "live"`).
  Header group `Editor mode` with buttons `Source` and `Live` (`aria-pressed`); `Preview` is the unchanged
  rendered split. Specs that type into the editor now run in Live: a line without the cursor shows rendered text
  (`See: j4/seed-list`), so assert raw Markdown only while the cursor is on that line, or via the file/API.
- Rendered-line clicks: a `[[link]]` opens on a plain click (Ctrl/⌘ click on the cursor line); web links need
  Ctrl/⌘ and `http`/`https`/`mailto` (`safeExternalUrl`). Checkbox widgets are `tabindex=-1` and named after the
  item; in Live the editor holds a checkbox of its own, so select the Preview's inside `markdown-preview`.
- Helpers: `e2e-real/ux06-live-preview.spec.ts` has `chooseMode`; unit helper `mount()` in `livePreview.test.ts`
  (jsdom needs `Range.getClientRects` stubs).

## UX-05 conventions to keep
- Notes save through `lib/noteAutosave.ts` (`NoteAutosave` per note, `NoteSessions` registry). It is
  **framework-free on purpose** (no React, DOM or `window`; `NoteStore` and `DraftStore` are injected) because the
  app is expected to become a native desktop client syncing with the owner's server (ADR-0054). Keep DOM and
  `localStorage` in `hooks/useNoteAutosave.ts` and `lib/noteDrafts.ts`; do not import `api/client` into the engine.
- Do not call `notesApi.update` from a component. The page binds with `useNoteAutosave(selected, onSaved)`;
  structural actions (rename, move, delete, create, daily note) call `session.flush()` first (`settle()` in
  `Notes.tsx`); `session.adopt(version)` hands a newer server version (rename) to a clean session; `forget(id)`
  after a delete. `session.resume()` must be called after listeners are attached (the hook does).
- 409 = conflict: nothing more is sent, text kept, choices *Keep my version as a copy* / *Reload server version*;
  the store `reconcile()`s before reading the server's version (external edits are invisible to the revision
  check until indexed). An unknown outcome retried into a 409 is re-read and counts as saved if the server's
  text equals what was sent.
- Selectors e2e relies on: header `[data-save-state]` (`saved|saving|unsaved|offline|failed|rejected|conflict`),
  path tooltip `Revision N` (text of the element is the full path), `Breadcrumb`, `Preview` (aria-pressed),
  `Links and details` (aria-pressed; region `Note details`), `Note options` (menu: `Task from selection`,
  `Rename`, `Delete`; rename box `Note name`), tree header buttons `New note`, `New folder`, `New from template`,
  `Today's note`, `Collapse all folders`; row menu button `Actions for <title>` / `Actions for folder <name>`;
  inline boxes `New note name`, `New folder name`, `Name for the new note from <template>`, `Rename <title>`;
  editor `Note content` (testid `note-editor`). Helpers: `expectNoteSaved`, `noteMenu`, `openNoteDetails`,
  `noteEditor`, `noteFileBytes`, `writeNoteFile` in `e2e-real/helpers.ts`.
- New notes go into the folder open in the tree (`activeFolder`). Details panel: column from 1440 px, overlay
  below, closed and unremembered on phones; remembered as `atlas-notes-panel`; Preview as `atlas-notes-preview`.
  The shell's sidebar docks on `/notes` only from 1280 px (`NOTES_WIDE`, `.compact` class).
- Drafts: `localStorage` key `atlas:note-draft:<note id>`; they are not removed at sign-out when unsaved (R-23).
- Editor: replacements from outside are not undoable (`Transaction.addToHistory.of(false)`), the editor is keyed
  per note; no line numbers; text column `--measure` (72ch).

## UX-04 conventions to keep
- The task panel saves through `lib/taskAutosave.ts` (`TaskAutosave` session per task, registry keeps unsaved
  sessions after unmount) bound by `hooks/useTaskAutosave.ts`; the panel is keyed by task id. Do not call
  `tasksApi.update` from the panel directly. Edit modes: `now` (menus), `debounce` (text, 600 ms + blur flush),
  `hold` (custom RRULE: only on blur/Enter).
- Leaving the panel goes through its guard (flush, else ask): close, switching task (`useTaskEditor.open` uses
  the `handle` ref), opening a subtask/parent/next occurrence/note, delete.
- Accessible names e2e relies on: dialog `Task details`; property buttons start with their label (`Status …`,
  `Priority …`, `Project …`, `Time zone …`); inputs `Title`, `Description`, `Due date`, `Due time`, `Start`
  (use `exact: true` — the clear buttons are `Clear due date` / `Clear start`), `Add a tag`, list `Tags`,
  `Remove tag <tag>`, combobox `Search time zones`; header `Task options` (menu: `Copy link`, `Delete task`),
  `Close`; indicator `[data-save-state]` (`saved|saving|unsaved|invalid|offline|failed|conflict`), not
  `role="status"`. Helpers in `e2e-real/helpers.ts`: `taskPanel`, `taskProperty`, `chooseTaskProperty`,
  `chooseTimeZone`, `expectTaskSaved`.
- Breakpoint 1280 px (`DOCKED` in `TaskDetail.tsx`, `@media (min-width: 1280px)` + `:root[data-task-panel]` in
  `styles.css`): docked and non-modal above, modal overlay with scrim below, full sheet ≤ 720 px.
- `/tasks?task=<id>` opens a task once (Copy link).

## UX-03 conventions to keep
- Every task list renders `TaskList` → `TaskRow`; actions come from `useTaskEditor(...).actions`
  (`hooks/useTaskActions.ts`: existing PATCH/DELETE with `base_revision` + idempotency key, one change per task in
  flight) and filable projects from `editor.projects`. Do not add per-page row controls.
- Menus: `components/Menu.tsx` (entries `item` / `submenu` / `date` / `separator`; hints are `aria-hidden`);
  task entries in `components/TaskMenu.tsx`. It portals into the opener's landmark (axe `region`).
- Accessible names e2e specs rely on: `Complete <title>` (checkbox), `Open <title>`, `Actions for <title>` (the
  "…" trigger; avoid labels starting with "More", ux02 uses `name: "More"`), `Schedule <title> for today`,
  `Pick a date for <title>` (button and date dialog; field `Due date`, button `Set date`), `Move <title> to a
  project`, `Select <title>` (Tasks page). Menus are named `Actions for <title>`, `Priority`, `Move to project`,
  `Status`, `Move to…`. Helpers: `src/test/menu.ts` (`choose`, `menuItem`).
- List keys live in `TaskRow` (row-level) and `Layout` (`j`/`k` from outside a row); documented in
  `lib/shortcuts.ts`. `isTypingTarget` no longer treats checkbox/radio/button inputs as typing.
- The optimistic checkbox tick means e2e specs must poll the API after clicking it.

## UX-02 conventions to keep
- Navigation comes only from `NAV_SECTIONS` in `apps/web/src/lib/navigation.ts` (sidebar, rail via `rail: true`,
  phone bottom nav, palette "Go to …"). Add a page there, with its rail `group`; do not hard-code links in the shell.
- Shell landmarks: rail `nav "Destinations"`, `aside "Sidebar"` → `nav "Main navigation"`, `main#main-content`,
  `footer "Status bar"` (not `role="status"`: pages own that role and e2e specs use it unscoped), phone
  `nav "Bottom navigation"`. e2e: use `rail(page)` / `searchButton(page)` from `e2e-real/helpers.ts`.
- Breakpoints 1024 px (sidebar docked vs drawer) and 720 px (rail vs header + bottom nav) are in both
  `Layout.tsx` (`WIDE`/`NARROW`) and `styles.css`; change both. Overlays stay above the status bar (z 30).
- Icons: `<Icon name=… />` from `components/Icon.tsx`; add a Lucide shape only when used and list it in
  `docs/DEPENDENCIES.md` (ISC notice there).

## UX-01 conventions to keep
- Only scale tokens in `font-size`/`gap`/`padding` (`npm run lint` runs `apps/web/scripts/check-css-scale.mjs`).
- Colours only via tokens; change a dark value in **both** dark blocks (`styles.test.ts` fails otherwise and
  checks contrast). Buttons: default secondary, `.primary` once per view, `.ghost`, `.danger`. Pills: `.pill`
  plus `pill-danger|warning|success|quiet`; old badge class names remain only as test hooks.
- (Superseded by UX-05 below: notes use the header `[data-save-state]`, there is no `Unsaved changes` text.)

## Open before MU can be declared complete
1. Run the `e2e-real` job on GitHub Actions (never executed there): J1-J7 in CI is an MU exit criterion.
2. Re-score the release table (REQ-005/REQ-006 are still `PARTIAL`) from user-reachable behaviour; needs the owner's review.
3. Optional: fix the pre-existing dev-only `minimatch` advisory (`npm audit --include=dev`, RISKS.md).

## Recommended next task
Close MU (items 1-2 above); UX-01…UX-08 are done. AUTH-01 needs an ADR and the owner's approval first. Calendar
resumes with M5-00 (blocked on real Google/Microsoft accounts, AR-001).

## Notes for the next session
- Verification: `./scripts/verify.sh` (pytest 1061, vitest 816); `cd apps/web && npm run test:e2e:real` (52 tests,
  real API + throwaway DB, see `docs/TESTING.md` §1b); `npm run e2e` (7 mocked). No `atlas_e2e_*` database is left
  on the dev PostgreSQL.
- Journeys share one owner: a spec that changes the owner's name, password or reminder default must restore it (J7 does).
- No user time-zone setting exists (ADR-0049); "today" is the browser's zone.
- UX-05 limitations: drafts are in `localStorage` (quota, shared-computer privacy, R-23); delete uses a native
  `confirm`; conflicts are copy-or-reload (no merge); the tree shows note titles (first heading) not file names;
  structural note operations are online-only (R-22); no cross-tab coordination beyond the revision check; a
  `keepalive` save is skipped for bodies over 60 KB (the draft covers it); the engine's `reconcile` re-scans all
  notes on a conflict (cheap for a personal notebook, revisit for very large ones).
- UX-02 follow-ups resolved in UX-05: the shell sidebar no longer eats the notes width (docks from 1280 px on
  Notes). `Day.tsx` is unrouted (kept for the Today date picker decision); Settings is not in the phone bottom nav.
- UX-03 limitations: reopening lands in *In progress*; a renamed parent keeps its old title in rows until
  re-listed/reloaded; search rows are read-only; quick actions hidden under `(hover: none)`; lists span the full
  main width (no max width).
- UX-04 limitations: unsaved task edits do not survive a reload while offline (no task draft store; the note
  draft store from UX-05 could be reused); a save failing after its panel unmounted shows when the task is
  reopened; the mu08 axe sweep has a 90 s timeout.
- Known limitations carried forward: UI mutations are online-only (R-22); a due time of exactly 23:59 reads as "end
  of day"; no project delete in the UI; Tasks page sorts client-side over the first 500 matches (ADR-0045);
  an occurrence of a repeating series shows its rule read-only (ADR-0046); search matches word prefixes only and the
  task `q` filter / `tasks.project_id` stay unindexed (R-20, ADR-0047); tasks link to notes only at creation
  (ADR-0048); a renamed daily note is not found again; password change signs out all other sessions; backup status
  depends on the API seeing `BACKUP_DIR` and does not re-verify checksums (ADR-0050).
