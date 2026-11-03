# Current Task

- Task ID: none in progress. **SYNC-01 and SYNC-02 are `DONE` locally (2026-11-03, not committed, CI not run).**
  SYNC-01: reconcile feeds `/api/changes`; `cursor_ahead`/`below_floor` `resync_reason`; cursor ordering proven by
  `tests/integration/test_change_concurrency.py`; nginx 1 MiB body limit verified as a real defect (R-34, not fixed).
  SYNC-02: Python simulation harness `services/api/tests/sim/` (docs/TESTING.md 10.0): model server/clients, fault network,
  invariants, planted bugs, conformance, real-API runs; env `ATLAS_SIM_SEEDS`, `ATLAS_SIM_REAL_SEEDS`, `ATLAS_SIM_STEPS`,
  `ATLAS_SIM_SEED`.
- **Next:** SYNC-03 (protocol v1 server), starting with **R-37** (concurrent PATCH lost update, `xfail(strict)` test
  `test_two_concurrent_patches_with_the_same_base_revision_cannot_both_win`) and the reconcile link-drop follow-up. Owner
  decision pending: nginx `client_max_body_size 6m;` (R-34). SYNC-07 (Tauri spike) still open.

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
