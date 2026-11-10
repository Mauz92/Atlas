# Atlas — Testing Strategy

**Status:** Draft for approval (Milestone 0)
**Last updated:** 2026-10-27

A passing build is not proof of a correct application. This document defines what must be
tested, with what tooling, and how results are reported.

---

## 1. Tooling

| Layer | Tool |
|---|---|
| Backend unit/integration | Pytest |
| Database | Real PostgreSQL (containerised) — not SQLite |
| Frontend unit/component | Vitest + Testing Library |
| End-to-end | Playwright |
| Migrations | Alembic against a clean DB (up and down) |
| Static analysis | Ruff / mypy (backend), ESLint / tsc (frontend), design-scale check (CSS) |
| Dependency scanning | Automated advisories in CI |

**Running the backend suite locally.** Integration tests need a real PostgreSQL (not SQLite).
Point `DATABASE_URL` (or `TEST_DATABASE_URL`) at a disposable database; the suite migrates it,
runs, and truncates between tests:

```
DATABASE_URL=postgresql+psycopg://user@127.0.0.1:5432/atlas python -m pytest -q
```

CI uses a `postgres:17-alpine` service container. Any PostgreSQL 14+ instance works.

### 1a. Running the frontend end-to-end suite locally (Playwright — M7-06)

Browser end-to-end tests live in `apps/web/e2e/` and run under **Playwright** (Chromium only). They
drive the **real** UI in a real browser with the HTTP API mocked through Playwright's network
interception, so they need **no live backend** and **no real account** (§8: deterministic and
isolated; §11 of `AGENTS.md`: no real personal/work data).

One-time setup (downloads a pinned Chromium build):

```
cd apps/web
npx playwright install chromium
```

Run the suite — this is a **separate command** and is **not** part of `scripts/verify.sh` (which is a
protected file). `playwright.config.ts` starts a `webServer` that builds the app and serves the
production bundle with `vite preview`, so the suite always exercises the bundled client:

```
cd apps/web
npm run e2e            # → playwright test  (Chromium; e.g. "4 passed")
```

The M7-06 suite (`e2e/sync-failure-modes.spec.ts`) covers three failure modes and drives the real
`/sync` route (it redirects to `/settings/sync` since UX-08): **network loss** (a queued edit is kept offline and flushes on reconnect), **restart**
(a queued edit survives a page reload and still syncs) and **stale client / conflict** (a stale-revision
`409` is surfaced and both *Keep mine* / *Take server* actions behave as documented). `e2e/helpers.ts`
holds the API mocks and the durable-queue seeding used to represent an offline edit; the queue itself is
the app's own IndexedDB store. Vitest is configured to ignore `e2e/**` so `npm run test` and the E2E
suite never collide.

### 1b. Real-stack journey harness (Playwright — MU-00)

The mocked suite above cannot prove the product works for its owner. The **real-stack harness** runs
Playwright against the **real FastAPI app** (started from source with `services/api/.venv`) and a
**real PostgreSQL database**, through the real Vite-served UI. Specs live in `apps/web/e2e-real/`; the
config is `apps/web/playwright.real.config.ts` (the mocked specs and `playwright.config.ts` are
unchanged).

Prerequisites: PostgreSQL reachable at `127.0.0.1:5432` as `atlas`/`atlas` (e.g. the Compose `db`
service), `services/api/.venv` with the API installed, and Chromium (`npx playwright install chromium`).

```
cd apps/web
npm run test:e2e:real      # → playwright test -c playwright.real.config.ts
```

Per run, `e2e-real/global-setup.ts`:

1. creates a uniquely named database `atlas_e2e_<random>` (`e2e-real/db_admin.py`, which refuses any
   name not matching `atlas_e2e_*`, so `atlas` / `atlas_test` can never be touched) and migrates it
   with `atlas-migrate`;
2. creates a temporary notes/backup/export directory;
3. starts the API (`uvicorn atlas.main:app`) on a free port and the Vite dev server on another free
   port, with `ATLAS_API_PROXY_TARGET` pointing the proxy at that API (default `localhost:8000`
   unchanged);
4. on teardown (also on a failed start) stops both processes, drops the database and removes the
   temporary directory.

Configuration (optional): `ATLAS_E2E_ADMIN_DATABASE_URL` (default
`postgresql://atlas:atlas@127.0.0.1:5432/postgres`) and `ATLAS_E2E_API_BIN_DIR` (default
`services/api/.venv/bin`). `e2e-real/helpers.ts` creates the owner through the real setup form
(`createOwner`, `signIn`, `signOut`); use `example.com` addresses — `.test` is rejected by the server
(`.local` is accepted since MU-08). Journeys run serially against one database and one owner; every run starts from
an empty database, so repeated runs do not interfere. CI runs the same command in the `e2e-real` job
of `.github/workflows/ci.yml` (PostgreSQL service; first green run 2026-11-04: 76 passed in 28 min on a 2 vCPU runner, `ACCEPTANCE.md` P0-4). Like the mocked suite it is **not** part of the
protected `scripts/verify.sh`.

Current journeys: `capture-journey.spec.ts` (setup → login → capture "Buy milk" → Inbox → reload);
`j1-capture-and-plan.spec.ts` (J1: capture on Today, plan via the task detail, Upcoming, reload, stale
second-tab conflict, all fields, verbatim validation errors, delete + undo, narrow-screen full page);
`j2-triage-inbox.spec.ts` (J2: five inbox items scheduled / filed / deleted with undo, keyboard driven);
`j3-run-a-project.spec.ts` (J3: create a project in the UI, add/file/complete/move tasks, link a note, edit, archive, restore);
`mu04-recurrence-subtasks-reminders.spec.ts` (MU-04: repeat picker with server preview/validation, completing a repeating task and its next occurrence, series end, subtasks with progress, per-task reminder override);
`j6-daily-note-and-today.spec.ts` (J6: Today as home, daily note created once as a plain file, template substitution; reads the notes directory via `ATLAS_E2E_NOTES_DIR`),
`j5-find-anything.spec.ts` (J5: Ctrl+K palette — grouped results for notes/tasks/projects, Enter opens each, go-to/theme commands, create task/note/project from the same box, verbatim server error, Search page).
`j7-stay-in-control.spec.ts` (J7: Settings — display name, password change with the other device signed out, theme, reminder timing, export download, backup status from a manifest written to the run's backup folder, instance info, shortcut help; restores the shared owner's name, password and reminder default);
`auth01-recovery.spec.ts` (AUTH-01: first-run setup shows the recovery code once behind an explicit acknowledgement, with copy/download, nothing in storage or the URL; Settings regenerate behind the password; the Forgot password journey: wrong code and unknown email refused alike, sloppy entry accepted, the old password stops working, another browser session and a device token are signed out, the used code is dead, the replacement works; Sign in, Forgot password and the Settings recovery row axe clean at 1440/768/390/360 in both themes with the 44 px rule and 16 px fields; it sorts first, so it performs the run's setup, and `createOwner` in `helpers.ts` passes the recovery-code screen for every other journey; it leaves the owner's password as the other specs expect);
`mu08-a11y-and-layout.spec.ts` (MU-08: axe-core over every main page in light and dark, the task panel, palette and shortcut help; no horizontal scroll at 375 px and 800 px — violations are fixed, never suppressed; uses `@axe-core/playwright`, `DEPENDENCIES.md`).
Journeys share one owner: start each with `ensureOwner(page)` (creates the owner or signs in) and use
unique titles, since earlier journeys' tasks stay in the database. A journey that changes shared owner state (name, password, reminder default) must put it back before it ends. `apiCall` (helpers) performs set-up
that has no UI yet (for example creating a project).

## 2. Unit Tests

Cover, at minimum:

- Task state transitions.
- Recurrence calculation (RRULE) and occurrence generation.
- Time-zone conversion and DST transitions.
- Reminder scheduling.
- Permission/authorisation checks.
- Markdown path validation (traversal, symlink policy).
- Revision conflict detection.
- Sync-token/delta handling and cursor advancement.
- Retry, backoff and idempotency logic.

Deployment files have unit tests too: `tests/unit/test_compose_env.py` (every `Settings` field is forwarded by
`deploy/docker-compose.yml` or exempted with a reason; `DATABASE_URL` is built from `POSTGRES_*`; web binds loopback) and
`tests/unit/test_nginx_config.py`. The Compose stack itself is not part of `verify.sh`; the manual smoke procedure (isolated
`-p atlas-smoke` project, override file that moves published ports, throwaway secrets) and its results are in `ACCEPTANCE.md`
P0-1/P0-2/P0-3.

## 3. Integration Tests (real PostgreSQL)

- API ↔ database transactions.
- Database migrations (clean install; representative upgrade).
- Background job persistence across worker restart.
- Task/project relationships.
- Markdown storage operations (atomic write, rename, delete, reconcile).
- Authentication and authorisation.
- Calendar adapter behaviour (mocked provider for determinism).
- Retry processing.
- Backup and restore procedures.

> Mocking providers proves adapter *logic*, not provider *compatibility*. Real-account tests are
> required for calendar milestones (see §5).

## 4. Frontend Tests

- Component behaviour for key flows (capture, edit note, board move).
- Offline queue replay.
- Sync status and conflict surfacing.
- Design system (UX-01): `npm run lint` also runs `apps/web/scripts/check-css-scale.mjs`, which fails when a
  `font-size`, `gap` or `padding` in `src/styles.css` is not a scale token (`var(--fs-*)`, `var(--s-*)`, `0`,
  `inherit`; audit §3.2). It reports `file:line: property: value`. `src/styles.test.ts` reads the colour
  tokens of both themes from the stylesheet and asserts the WCAG ratios (text 4.5:1, body text 7:1, control
  outlines and the primary button 3:1) and that the System-dark and explicit-Dark blocks are identical, so
  a token change that breaks contrast fails `npm test`. `src/lib/theme.test.ts` covers System/Light/Dark
  and the pre-paint script `public/theme-init.js`; `e2e-real/ux01-theme.spec.ts` checks the login screen
  follows the OS theme and that a stored choice is on `<html>` before the app script has loaded.
- App shell (UX-02): `src/lib/navigation.test.ts` (the one `NAV_SECTIONS` config: ≤ 6 rail destinations, every
  page once, active-item rules, per-browser preferences incl. throwing storage), `src/components/Layout.test.tsx`
  (exactly one current item per navigation for every route, sections, Ctrl/⌘ B, phone drawer focus and `inert`),
  `src/components/StatusBar.test.tsx` (every status-bar state with `useOfflineQueue`/`useSyncStatus` mocked) and
  `src/App.routes.test.tsx` (every old URL resolves, `/day` → `/`). `e2e-real/ux02-shell.spec.ts` drives the
  shell by keyboard on the real stack (skip link, rail, sections, Ctrl+B across a reload, phone drawer with Esc
  and focus return), checks the old URLs, the offline status bar and runs axe on the collapsed and drawer states.
  e2e specs find navigation through the rail (`rail(page)` in `e2e-real/helpers.ts`) or the bottom nav on phones,
  and open the palette with `searchButton(page)`.
- Task rows and menus (UX-03): `src/components/Menu.test.tsx` (the shared menu, parametrized: focus on open,
  ↑ ↓ Home End and type-ahead, Esc/Tab close and return focus, Esc does not reach document listeners, outside
  press, submenus and Back, `initialPath`, the date dialog), `src/components/TaskRow.test.tsx` (meta line,
  checkbox per status, two persistent controls, list keys `x`/`t`/`m`/`p`/`j`/`k`, every menu entry → its
  action, allowed statuses only, subtask has no project choice), `src/components/TaskList.test.tsx` (read-only
  rows, parent named from the list or the API, focus moves to the next row when one leaves),
  `src/lib/taskForm.test.ts` (`scheduleDate`/`scheduleFields`). `e2e-real/ux03-rows-and-menus.spec.ts` measures
  rows (≤ 40 px on Today, Inbox, Upcoming, Tasks and a project page at 1440 px), counts the Inbox row's visible
  controls (2), the phone Inbox height (9 items, < 1000 px) and drives every row action by keyboard alone; it
  first moves earlier specs' Inbox leftovers to *Next* (the database is shared per run). The axe sweep
  (`mu08-a11y-and-layout.spec.ts`) also checks the open row menu and its date dialog. Unit tests open menus with
  `choose(trigger, ...items)` / `menuItem(name)` from `src/test/menu.ts`.
- Task detail autosave (UX-04, ADR-0053): `src/lib/taskAutosave.test.ts` is the risky part — the save session
  against a fake revisioned server with fake timers (debounce, never two requests in flight, coalescing,
  revision chaining, one property group per request, flush points incl. `keepalive`, 409 → conflict with no
  further sends and set-aside values, 422 held while typing then verbatim, offline/online, unknown outcomes
  re-sent with the same idempotency key, per-field adoption of the server's answer, registry). The panel:
  `src/components/TaskDetail.test.tsx` (parametrized menu properties, repeat presets and zone queries; Esc
  flushes then closes; unsaved close asks; delete flushes first; overlay focus trap and scrim).
  `e2e-real/ux04-task-panel.spec.ts` (real stack, 1440×900): every property via the UI then reload, no Save
  button, indicator in view, list visible beside the docked panel, Esc returns focus, overlapping `PATCH`es
  counted (max 1); two-tab stale edit → conflict, server unchanged, load latest + reapply; rapid type + Esc,
  switch task and delete while pending; validation verbatim and close-with-unsaved. Specs wait for the
  panel's *Saved* indicator (`expectTaskSaved` in `e2e-real/helpers.ts`) instead of clicking Save; property
  menus via `chooseTaskProperty`, zones via `chooseTimeZone`. The axe sweep also covers the panel's menu,
  zone list and overlay.
- Note autosave and workspace (UX-05, ADR-0054): `src/lib/noteAutosave.test.ts` is the risky part — the
  framework-free engine against a fake revisioned server (fake timers, scripted network/5xx/lost-answer/4xx
  outcomes, an in-memory `DraftStore`, no DOM): one request with the latest text after a pause; never two in
  flight and the revision chains; typed-back text sends nothing; flush; `pagehide` flush with `keepalive`;
  draft written on every change and cleared only after confirmation; draft equal to / on the same revision as /
  older than the server's text (and built on our own applied request); 409 mid-typing keeps the text and sends
  nothing more (also on `online()`, flush and long waits); keep-as-copy and reload; reconcile before the
  re-read; unknown outcome re-sent, then 409 with identical server text = saved, with different text =
  conflict, re-read failing = tried again; 422 kept and not re-sent until edited; offline then online, offline
  typing restored after a "reload"; adopt only while clean; the registry keeps unsaved sessions.
  `src/lib/noteDrafts.test.ts` (localStorage store, corrupt entries, failing storage), `src/lib/noteLinks.test.ts`
  (`resolveWikiLink`), `src/components/MarkdownPreview.test.tsx` (`[[links]]`, escaping), `NoteTree.test.tsx`
  (row menus, inline names), `src/pages/Notes.test.tsx` (autosave through the page: no Save button, pause →
  one `PUT`, Ctrl+S, draft until confirmed, 409 banner + copy, flush before switching, rename without a
  prompt, inline creation, Ctrl+Alt+B, restored draft). `e2e-real/ux05-notes.spec.ts` (real stack) checks the
  exact UTF-8 bytes on disk, overlapping `PUT`s counted (max 1), reload right after typing, offline typing with
  the tab closed and reopened, an external file edit → conflict with the file never overwritten and the copy,
  a stale draft shown in conflict and never applied, the tree/menus/preview links workflow, and the layout
  at 1440/1024/720/390 px. Helpers in `e2e-real/helpers.ts`: `expectNoteSaved`, `noteSaveState`,
  `openNoteDetails`, `noteMenu`, `noteEditor`, `noteFileBytes`, `writeNoteFile`. J4, J6 and the axe sweep
  were updated for the new controls (selectors changed only where the UI legitimately changed).
- Live preview (UX-06, ADR-0056): `src/lib/livePreview.test.ts` (95 tests). The corpus (19 texts: nested lists,
  code fences with markup, indented code, tables, HTML blocks, CRLF, trailing whitespace, unicode/emoji, wiki
  links with aliases, front matter, setext/rules, links and images, unsafe links, escapes, quotes, empty and
  blank-only notes, no trailing newline) is loaded in Live mode and run through typing, replacing a selection,
  select-all, undo and redo; the document text after every step must equal the Source-mode result and the
  loaded text must come back after undoing everything; the rendered DOM must hold no `script`, `iframe`, `a`,
  `img[src]`, `style`, `svg`, event-handler attribute or `javascript:` value; moving the cursor/focus must never
  change the text. Also: `safeExternalUrl` (16 cases), line-ending helpers, front matter, each decoration,
  focus-dependent revealing, checkbox toggle (undo/redo), Ctrl/⌘ click rules, Mod-Enter.
  `src/components/NoteEditor.test.tsx` (7: mode switching keeps document, selection and undo history; checkbox →
  `onChange`; wiki-link click; links re-resolved when the notes arrive; CRLF byte-for-byte in both modes; outside
  replacement), `src/lib/notesPrefs.test.ts` (3: per-browser mode preference, default, blocked storage).
  `e2e-real/ux06-live-preview.spec.ts` (8, real stack): default Live and remembered choice, typing → exact UTF-8
  bytes and cursor kept across Source↔Live, checkbox toggle persisted and reloaded, wiki-link click opens the
  target, cursor-line revealing by mouse and keyboard, a hostile note (`<img onerror>`, `<script>`,
  `javascript:` links, tracker image: nothing runs, no request, only https opens), 409 conflict flow in Live,
  front matter/tabs/trailing spaces byte for byte. `mu08-a11y-and-layout.spec.ts` now runs axe on the note in
  Source and in Live, light and dark; J4 and the Preview checkbox selector were adjusted for Live's rendering
  (the `[[link]]` is shown rendered when the cursor is elsewhere).
- Tasks, Projects and Board (UX-07, ADR-0057): pure rules are unit-tested: `src/lib/taskFilters.test.ts` (the
  additive `view` URL parameter, due presets across month/year ends, preset detection, chip labels, `isFiltered`),
  `taskStatus.test.ts` (`adjacentStatus`: neighbours, skipping forbidden columns, edges, hidden Archived),
  `tasks.test.ts` (`formatDay`: no zone shift, year only when not current, unparseable text kept).
  `src/pages/Tasks.test.tsx` (chips with values, the Due popover, List|Board in the URL without a reload,
  saved views from the "…" menu, floating bulk bar and *Clear selection*, bulk complete/move/delete/undo),
  `Projects.test.tsx` (progress bar role, open count, target date format, archive only in the row menu, archived
  behind a toggle), `ProjectPage.test.tsx` (header, tabs and arrow keys, folded Completed/Archived groups,
  link/unlink on the Notes tab), `components/Board.test.tsx` (`[`/`]`, edges, focus after the move, announcement,
  modifiers, archive toggle, compact cards). Test helpers: `src/test/menu.ts` (`choose`). Real stack:
  `e2e-real/ux07-tasks-projects-board.spec.ts` (4): one-row filter bar at 1440 px, chips from the keyboard, URL
  state, floating bulk bar kept in view while scrolling, List|Board, `]`/`[` with focus and stored status,
  project rows, the archive menu, no ISO date text, tabs from the keyboard, folded groups, project board
  <= 1,200 px tall, and no horizontal scroll at 1440/1024/720/390 px in both themes (screenshots to
  `$ATLAS_SHOT_DIR`). Helpers in `e2e-real/helpers.ts`: `filterBar`, `chooseFilter`, `openDueFilter`.
  `tasks-page.spec.ts` and J3 were updated for the chips, the "…" menu, the tabs and the row menu;
  `mu08-a11y-and-layout.spec.ts` adds the Tasks board view, the project Board and Notes tabs, and the chip menu,
  Due popover, save-view popover, bulk bar, project row menu and project header menu states.
- Remaining phone pages and removal of the standalone Board (UX-11, ADR-0064): unit: `pages/Tasks.test.tsx` (phone: no select boxes
  until "Select tasks", one box per row, Done leaves the mode; the Filters sheet with a count and Reset), `components/Board.test.tsx`
  (phone: one column per tab, counts in tab names, arrow/End keys, `]` follows the card, Archived as a fifth tab, "?" help; desktop
  prints the help), `lib/taskFilters.test.ts` (the retired `view=board` is ignored), `App.routes.test.tsx` (`/board` lands on
  `/projects`), `navigation.test.ts`/`Layout.test.tsx` (no Board entry). jsdom has no `matchMedia`: phone tests stub it to match every
  query. Real stack: `e2e-real/ux11-phone-pages.spec.ts` (8 tests): Tasks, project board, Projects, Notes (list and open), Settings
  sections and the palette at 360/390/768/1440 in both themes (no document scroll, no inner scroll and every control >= 44 px at 360/390,
  axe), the Filters sheet and the palette (full screen, no key hints), Login/Setup, Select mode with bulk complete/move/delete+undo, the
  Filters sheet filter and reset, Medium/Low words, the project board tab strip with arrows, `]`/`[`, announcement and the menu move,
  the Notes toolbar, Project cards and one capture control, the 44 px status-bar link (offline), and the removed Board (`/board` redirect,
  `view=board` ignored, no "Go to Board"). The sweep treats a checkbox/radio inside a label as its label and skips inline text links,
  note-content controls and list-row title buttons (the row body is the target). Updated specs: ux02 (old URL `/board` -> Projects), ux03
  (phone board check on the project board), ux07 (the tasks-page board test became the project-board test; `tasks-board` shot removed),
  ux08 (skeleton check on `/tasks`), mu08 (route list), J1 (find the task on Tasks).
- Week agenda, phone capture, menu sheets and touch rules (UX-10, ADR-0063): `lib/keyboardInset.test.ts` (pure inset rule),
  `components/CaptureSheet.test.tsx` (phone-only button, modal sheet, focus, inert page, Esc/scrim/Close, Tab trap, one add through the
  page's own function, failed add then retry adds one, double submit ignored, `--kb` follows a fake `visualViewport`),
  `components/MenuSheet.test.tsx` (sheet roles, scrim, trailing Cancel, Tab cycling, focus return, popover unchanged without a phone
  query), `pages/Week.test.tsx` (segmented navigation, today card, one-line empty days), `styles.test.ts` (viewport-fit and
  resizes-content, all four safe-area variables, 16 px rule, nav/FAB/sheet inset rules). Real stack:
  `e2e-real/ux10-phone.spec.ts` (5 tests): the five pages at 360/390/768/1440 in both themes (no horizontal or inner scroll, axe, fields
  >= 16 px on touch, changed controls >= 44 px, Week: seven headings, one today card, columns by width, no clipped title, no word split
  across lines, one-line empty days); the FAB above the bottom nav on six pages in both themes, the open sheet (axe, 44 px, 16 px,
  docked to the bottom), exactly one task per add, failed-then-retried add creates one, Esc/scrim/Tab; keyboard emulation with a stand-in
  `visualViewport` (headless Chromium has no on-screen keyboard); the row menu as a sheet at 360/390/768 vs a popover at 1440 (roles,
  keys, scrim, axe, targets); safe-area emulation by overriding `--safe-bottom`/`--safe-top`. **NOT RUN (needs a device):** real
  on-screen keyboard overlap, notch/home indicator, iOS zoom-on-focus, TalkBack/VoiceOver, 200 % zoom.
- Readability tokens, row anatomy and sections (UX-09, ADR-0062): `src/styles.test.ts` (every new token in both themes and both
  dark copies: text on the page tint, card and header band, due/priority colours, eight project dots, card outline, hairline),
  `lib/projectColor.test.ts` (stable, 1..8, even spread), `lib/dueChip.test.ts` (state words, completed, day group drops the date),
  `components/TaskRow.test.tsx` (icon + word per state, <= 2 tags + "+n", dot, meta lines, whole-body click opens once),
  `components/ViewSection.test.tsx`, `Today.test.tsx` / `Upcoming.test.tsx` (summary, counts, "Tomorrow"), `dailyNote.test.ts`.
  Real stack: `e2e-real/ux09-readability.spec.ts` (3): Today, Inbox, Upcoming, Week, Tasks, Projects and a project page at 360/390/768/1440
  in light and dark: no horizontal scroll, axe (WCAG 2.0/2.1 A/AA + best practice) clean, phone rows <= 96 px and <= 3 lines with
  16 px titles and no overflow, touch checkbox and "..." >= 44x44 by `boundingBox`, desktop rows <= 40 px; the Overdue chip, urgent word,
  project dot and "+1" tag visible; a tap on the meta opens the task; the Overdue header is sticky at 48 px; Upcoming drops the date.
  Greyscale screenshot of Today is saved under `test-results/`.
- Settings, skeletons and empty states (UX-08, ADR-0058): `src/lib/settingsSections.test.ts` (the seven sections in
  order, URL segment parsing, redirects), `navigation.test.ts` (`PALETTE_PAGES` keeps Calendar/Sync/Notifications,
  every `/settings/*` path is the one Settings entry), `src/pages/Settings.test.tsx` (section in the URL, one section at a
  time, unknown section redirects, instance info only where used, server messages verbatim, at most one primary
  button per section), `components/Skeleton.test.tsx` (`role="status"` with text, hidden bars, groups, board
  columns; `EmptyState` icon, single action, not a status), `Tasks.test.tsx` / `Inbox.test.tsx` (skeleton, none yet vs
  no results), `StatusBar.test.tsx` (links to `/settings/sync`, `/settings/calendar`), `App.routes.test.tsx`
  (redirects). Real stack: `e2e-real/ux08-settings-states.spec.ts` (6): every section by link, URL and reload, the
  redirects, palette "Go to Sync / Calendar / Notifications", phone drill-in; axe and no sideways scroll in every
  section at 1440/1024/720/390 in both themes; a held list request shows the skeleton (`role="status"`), the page
  heading does not move when data arrives; the skeleton is axe clean at four widths; empty states (list
  responses are answered with an empty list because the journeys share a database) with an icon, axe and
  overflow at four widths; sign-in and first-run cards centred and axe clean. Screenshots go to `$ATLAS_SHOT_DIR`.
  Helper: `openSettingsSection` in `e2e-real/helpers.ts`. J7 opens each section from the list; ux02 and mu08 use the
  new URLs.

## 5. Calendar Adapter Tests

For each provider (Google, Microsoft):

- Pagination.
- Event create/update.
- External deletions.
- Recurring instances and exceptions.
- Time zones and DST transitions.
- OAuth expiry and revocation.
- Expired incremental-sync tokens / invalid delta links.
- Throttling and transient failures.
- Duplicate prevention.
- Conflicting updates.
- Worker restarts mid-sync.

Real-account integration tests use **dedicated test accounts** and isolated test data only.

## 6. End-to-End Scenarios

1. Create a note and retrieve it from another client.
2. Edit the same note concurrently; recover safely from the conflict.
3. Create, schedule and complete a task.
4. Create a project and move a task between board columns.
5. Connect an external calendar and display its events.
6. Change an event externally; observe the update in Atlas.
7. Edit a supported event through Atlas; verify the provider update.
8. Receive and dismiss a due reminder.
9. Restore the application from a backup.
10. Disconnect and reconnect a provider without duplicating events.

## 7. Quality Gates (per milestone)

- All relevant automated tests pass.
- No known critical security issue remains.
- Migrations work on a clean installation.
- Documentation reflects the implementation.
- The working deployment starts reproducibly.
- Limitations are documented.
- No secrets or user data committed.
- Acceptance evidence recorded in `ACCEPTANCE.md`.

Tests are never disabled or weakened to make a milestone pass.

## 8. Determinism and Isolation

- Tests are deterministic, isolated and safe to run repeatedly.
- No real personal or workplace data in tests.
- Fixtures create and tear down their own state.
- Time-dependent tests inject a clock; they do not sleep on wall-clock time.

## 9. Result Reporting Vocabulary

- `PASS` — command ran and relevant checks passed.
- `FAIL` — check ran and failed.
- `BLOCKED` — could not run (documented dependency/environment issue).
- `NOT RUN` — not attempted.

Report the actual command and a concise evidence line for release gates. Never invent results.

## 10. Sync Testing (local-first clients; ADR-0055, ADR-0059, `SYNC_PROTOCOL.md`)

Status: **layers A, B and C exist for the task/project/feed API since SYNC-02, for protocol v1 (tasks, projects, note identity)
since SYNC-03 and for note content (history, merge, conflict copies, edit-wins, moves, portable paths) since SYNC-04 (2026-11-03)**;
the resolution-log, device and client scenarios of 10.3 and layers D/E do not exist yet. Sync bugs are ordering and failure bugs, so the main
evidence is a deterministic simulation, not example-based tests.

### 10.0 What exists (SYNC-02) and how to run it

Location `services/api/tests/sim/`, run by the ordinary `pytest` call (so `./scripts/verify.sh` runs it; about 13 s).
**Language choice: Python, not TypeScript** (the first sketch in ROADMAP said TS/vitest): the real-API half needs the existing
ASGI + PostgreSQL fixtures, the model server sits next to the code it models, and no dependency is added. Cost: the model
clients are a Python model of the *intended* client protocol, not the shipped TS; SYNC-08 must run the same scenarios and
invariants against the real TS core (the trace format is plain data). Files: `engine.py` (virtual clock, event queue,
fault-injecting network), `model.py` (model server + `ServerBugs`), `client.py` (model client + `ClientBugs`), `runner.py`
(world, schedule, invariants), `real.py` (real API behind the same port), and four test modules.

| Command | Effect |
|---|---|
| `pytest services/api/tests/sim` | default: 100 model seeds (+40 purge, +40 clock-independence), 3 real-API seeds, planted bugs, conformance |
| `ATLAS_SIM_SEEDS=2000 ATLAS_SIM_STEPS=300 ... -k test_sim_model` | model soak (1000 seeds take about 10 s) |
| `ATLAS_SIM_REAL_SEEDS=30 ATLAS_SIM_STEPS=150 ... -k test_sim_real` | real-API soak (30 seeds took 82 s) |
| `ATLAS_SIM_SEEDS=2000 ATLAS_SIM_STEPS=300 ... -k test_clients_converge_under_faults` | long-run model soak (2000 seeds take about 45 s); seed 482 is a named regression (`test_regression_seed_482_...`) and seeds 0-299 at 300 steps run in the normal suite |
| `ATLAS_SIM_SEED=<n> pytest services/api/tests/sim -x` | re-run exactly one seed; every failure message prints `seed=<n>`, the invariant and the last 30 events |

Concurrency tests that need real PostgreSQL row locks (not expressible as sequential traces): `tests/integration/test_revision_races.py`
(same-`base_revision` races on tasks, projects and notes, delete-vs-patch, parent-delete vs project-delete lock order, feed
consistency of a losing request), `test_change_concurrency.py` (cursor ordering) and the conformance test
`test_two_concurrent_*_with_the_same_base_revision_cannot_both_win` in `tests/sim/test_sim_conformance.py`. Deploy-config
check: `tests/unit/test_nginx_config.py` (static parse of `apps/web/nginx.conf` always; throwaway-container probe only when
docker and a local `nginx:1.27-alpine` image exist, otherwise skipped, never pulling).

Faults: drop request, drop response after the server applied, duplicate (late second delivery), delay (reorder, because a
retry can overtake a slow earlier attempt), timeout, 5xx after apply, offline periods, client restart at any step (volatile
state lost, mid-pull included), per-client clock skew that jumps (sent as `X-Client-Time`, which must not matter), and
(model) feed purge forcing `below_floor` resyncs. Invariants implemented: convergence, no acknowledged loss (a 2xx shows what
was sent; model: applied exactly once), no duplicates, no resurrection, cursor safety (cursor never exceeds the applied page;
model also checks every feed row below the cursor is held), revisions identify one state, clock independence (same seed with
and without skew gives the identical final state), idempotence of an extra pull+push, bounded quiescence. Not yet: edit-wins,
field merge, notes, links, subtasks/project membership, token revocation, server restore as a random action, crash points
enumerated exhaustively (restarts are random). Conformance (`test_sim_conformance.py`): 8 sequential traces replayed against
the model and the real API with normalised answers compared, one check that the comparison can fail, and real concurrency
tests. Planted bugs (`test_sim_planted_bugs.py`): 11 flags in the model server and client, each must trip a named invariant
and reproduce from its seed, plus convergence-alone, clock-dependence and a scripted stale-replay case.

#### 10.0a Protocol v1 additions (SYNC-03)

Files: `model.py` (sync mode in the model server: `Atlas-Sync`, `426`, client ids, field merge, edit wins, `include=data`/`types`/
snapshot/`snapshot=true`, tombstone-only purge; `ServerBugs` gained five flags), `client_v1.py` (`SyncSimClient`: client ids,
`base_revision` fixed when the user acts, `include=data` pulls, shadow-copy snapshot resync, stop on `426`; `ClientBugs.ignore_426`),
`test_sim_v1.py`, and the `SimConfig` switches `sync`, `late_joiner` (the last client installs at 60 % of the steps with an empty
store: snapshot bootstrap) and `old_client` (an extra client speaks protocol 2). New invariants (`runner.py`): `unexpected_rejection`
(only a text `conflict` and a stale-delete `edit_wins` may be met; a `404` on a known entity would mean edit-wins is broken),
`no_silent_text_loss` and `edit_wins` (model ground truth: no text field overwritten after its base, no delete accepted on a stale
base), `stop_on_426`, plus the existing ones adapted (acknowledged loss ignores fields reported in `sync.conflicts`; resurrection
allows an acknowledged edit to revive; exactly-once applies to creates, a merged patch may be a no-op). Conformance
(`test_sim_conformance.py`) has 6 more traces (negotiation, client ids and requirements, field merge, edit-wins, project merge, feed
v1) replayed against the model and the real API; the model had to be corrected to match the real answers only in one place (the
`edit_wins` resolution list), which is the point of the suite. Integration tests (layer A): `test_sync_protocol.py`,
`test_sync_writes.py`, `test_sync_notes.py`, `test_changes_feed_v1.py`, `test_field_revisions.py` and the three migration tests.

| Command | Effect |
|---|---|
| `pytest services/api/tests/sim/test_sim_v1.py` | default: 100 model seeds, +60 late joiner, +60 purge, +40 old client, +40 clock independence, 7 planted defects, 3 real-API seeds |
| `ATLAS_SIM_SEEDS=1000 ATLAS_SIM_STEPS=300 ... -k "not real and not planted"` | model soak (1000 seeds x 300 steps, about 70 s with the legacy tests) |
| `ATLAS_SIM_REAL_SEEDS=30 ATLAS_SIM_STEPS=150 ... -k real` | real-API soak (v1 and legacy, 62 tests, about 170 s) |

What the simulation found while it was being built: **seed 29** (a multi-page snapshot bootstrap restarted forever once the floor
rose above its first page; fixed by `snapshot=true`, R-38) and **seed 681** (a replayed create acknowledgement brought back an
entity whose delete the client's cursor had already passed because the snapshot omits tombstones; a client rule, R-40, plus the
`cursor_safety` check now excuses entities queued for re-read). Not yet simulated: notes, links, subtasks/project membership as
fields, server restore as a random action, `epoch` mismatch, token revocation (SYNC-04/06/08).

#### 10.0b Notes (SYNC-04)

Files: `model_notes.py` (the model server's note rules, sharing the entity table, feed and idempotency store; imports the production
`merge3`, which is established by the property tests, so the simulation tests the protocol around it), `client_v1.py` (the model
client edits a note as a *working copy pinned to its base* `(text, revision, hash, base text)`, coalesces edits into an unsent save,
freezes the save at its first send, downloads note content in a separate "hydrate" request because the feed carries metadata only,
and re-reads after every acknowledgement including a delete), `test_sim_notes.py`, `test_sim_notes_conformance.py`. Every line a
simulated user writes is a unique marker (`m:<client>-<n>`), so what an edit added or removed is exact.
New invariants (`runner.py`): `no_silent_overwrite` (model ground truth: a merged/revived/fast-forward write drops no line of the
server's text that the client had not removed from its base), `no_acknowledged_note_loss` (every line an acknowledged save added is
in some note - live, a conflict copy, or the last text of a deleted note read through the history endpoint - unless an acknowledged
save removed it; also per response), `conflict_copy_has_losing_text` (the copy named in a `409` has the hash of the sent text and,
read through `GET .../history/1`, exactly that text), `unique_paths`/`portable_paths` (no two live notes differ only by case or
normalisation; every live path passes the portable check), `edit_wins` for note deletes, and the adapted `no_duplicates` (creates +
reported conflict copies = notes on the server), `unexpected_rejection` (only `conflict`, `edit_wins`, `path_exists`,
`note_deleted` for the matching action) and `revision_identifies_state`.

| Command | Effect |
|---|---|
| `pytest services/api/tests/sim/test_sim_notes.py` | default: 100 + 100 model seeds, +40 late joiner/purge, +40 clock independence, outcome coverage check, 10 planted defects, 3 real-API seeds |
| `ATLAS_SIM_SEEDS=1000 ATLAS_SIM_STEPS=300 ... -k "not planted and not real_api"` | note model soak |
| `ATLAS_SIM_REAL_SEEDS=20 ... -k real_api` | real-API note soak (per-test notes folder; 20 seeds take about 35 s) |
| `pytest services/api/tests/sim/test_sim_notes_conformance.py` | 6 traces (create/replay, merge/conflict/replay, CRLF and final newline, edit-wins/revive, reused path, move/collisions/portable) replayed on model and real API; 6 model defects must make the comparison fail |

Layer A (integration, real PostgreSQL + real files): `tests/integration/test_note_sync_merge.py` (55 tests: exact bytes on disk after
a merge, a conflict copy, a revive, CRLF, Unicode, front matter; replay with content; concurrency of saves from one base; cross-user
isolation; every portable-path rule), `test_note_history.py` (retention, pruning job, shared files, damaged files, backups),
`test_note_revisions_migration.py`; unit: `tests/unit/test_note_merge.py` (examples and seeded properties, 1500+ cases).

What the note simulation found: **seed 109 at 700 steps** (a replayed delete acknowledgement tombstoned an entity another device
had revived; a client rule for tasks and projects too, fixed in the model client, R-40). Not yet simulated: history pruning mid-run
(the model keeps 200 revisions; pruned bases are covered by integration tests), unindexed external edits, folder renames, server
restore with notes.

#### 10.0c Resolution log and undo (SYNC-05)

Files: `model_resolutions.py` (the model server's log, feed entity, list and strict undo; the log lives on `ModelServer` so
`snapshot()`/`restore_from()` carry it like a table; `ServerBugs` gained ten `res_*`/`undo_*`/`restore_*` flags), `client_v1.py` (clients
pull `resolution` when `SimConfig.resolutions` is on, keep a mirror of the notices, and tap undo on the one that just appeared; undos go
in front of unsent operations), `runner.py` (`_undo_wave`: after the first quiescence the clients, who now hold every notice, tap
undo and edit a little for `undo_rounds` steps with faults back on, then quiesce again - without it a faulty run learns its notices
too late to undo them; `_check_resolutions`, `check_log_matches_state`), `test_sim_resolutions.py` (6 conformance traces),
`test_sim_resolutions_model.py` (model runs, coverage, 10 planted defects, restore scenario), `test_sim_resolutions_real.py`.
New invariants: `resolution_logged_once` (every resolution a client was answered with is in the log with the same rule, field and
revision; no two entries describe one write; model: generated resolutions = rows), `no_log_without_write` (every entry was reported
to a client by an acknowledged write), `log_has_no_text` (no entry contains what a simulated user types, and only the undoable
rules and `undo` keep a value), `undo_once` / `undo_logged` (at most one undo entry per resolution, flag and entries agree, every
acknowledged undo has its entry), `undo_idempotent` (an undo entry nobody was answered with: a retried undo was evaluated again),
`undo_never_overwrites_newer` (the value an undo replaced equals the value the winning write stored; model: the field had not changed
after the resolution), `resolutions_converge` (every client holds exactly the log through the feed), and the existing
`no_resurrection` (an undo never revives), `cursor_safety` (extended to the `resolution` rows) and `unexpected_rejection` (only
`conflict`, `entity_deleted`, `already_undone`, `not_undoable`, `path_exists` may answer an undo).

| Command | Effect |
|---|---|
| `pytest services/api/tests/sim/test_sim_resolutions_model.py` | default: 100 + 40 + 40 model seeds x 250 steps (4 clients, notes included), outcome coverage check, 10 planted defects, restore scenario |
| `pytest services/api/tests/sim/test_sim_resolutions.py` | 6 traces (log + feed + list + undo and every refusal; project field; notes: merge, collision, move, path undo, `path_exists`; a revive that ends in a conflict) on model and real API |
| `ATLAS_SIM_REAL_SEEDS=20 ATLAS_SIM_STEPS=150 ... -k resolution` | real-API runs (late joiner, notes, undo wave) |
| `ATLAS_SIM_SEEDS=1000 ATLAS_SIM_STEPS=300 ... -k "not real and not planted and not conformance"` | model soak of every simulation module |

Layer A: `tests/integration/test_sync_resolutions.py` (what is logged and what never is, replay, rollback after a failed request,
the database tripwire, feed visibility and `include=data`, every undo outcome and refusal, notes, scope across users, paging,
retention and the purge job, application logs, backup dump, concurrent undos, the epoch gate), `test_sync_resolutions_migration.py`
(clean schema, populated previous schema, constraints, downgrade), unit `test_resolution_rules.py`.
Coverage of a default run (60 seeds, 4 clients, tasks+projects+notes): about 860 `simple_later_wins`, 420 `edit_wins_over_delete`, 800
`path_collision`, 60 `note_merged`, 45 `path_later_wins`, 680 undo entries (570 applied, 110 no-ops), refusals `already_undone`,
`not_undoable`, `conflict` (about 590) and `path_exists`.

#### 10.0d Device credentials (SYNC-06)

Layer A (real PostgreSQL, `usefixtures("_db")`): `tests/integration/test_devices.py` - sign-in (token shape and entropy, hash-only
storage, no cookie/CSRF, one `401` for every failure, the shared login rate limit, validation never echoing the password, inactive
account, the 25-device bound), the data endpoints with a bearer token, **the exact set of endpoints open to devices** (walks every
router; default deny), every account-level endpoint refused with `403 forbidden_scope`, list/rename/revoke/revoke-all (user scope,
CSRF on the browser path, idempotent), rotation (grace window, lost response, the new token ends the old one's window, revocation
ends the window), idle expiry (91 days refused, 89 allowed, never-used device expires from creation), `last_seen_at` (server clock,
a forged `Date` header, no rewrite inside five minutes, written even when the request fails, never for a revoked device),
per-device rate limits (`Retry-After`, other devices unaffected), password change with and without `revoke_devices`, the operator
reset and `list-devices`/`revoke-device`, `device_id` in the resolution list, feed (`include=data`) and undo, the purge of old revoked
devices. `tests/integration/test_device_security.py` - token theft and revocation, a thief's reach, cross-user isolation, the
cookie/CSRF interaction (cookie requests still need CSRF with or without an `Authorization` header; a bad bearer is never rescued by a
cookie; a cookie cannot ride a device token onto account endpoints; a session token is not a device token and the reverse; a device
request sets no cookie), token hygiene (no token in any log record, error body or header of a full flow; hashes only in the
database), malformed `Authorization` headers, deactivated and deleted accounts. `test_devices_migration.py` (clean schema, populated
previous schema with resolutions, constraints, the `device_id` foreign key, downgrade and re-upgrade). Unit: `RateLimiter.retry_after`.

Layer C (real API): `tests/sim/test_sim_devices.py` - every simulated client signs in as its own device and sends its bearer token
through the same hostile schedule as the resolution simulation. New invariants: `resolution_device` (each log entry names the device
of the client whose request produced it, undo entries the undoing client's, none anonymous), `revoked_never_served` (after the owner
revokes a device mid-run the server never answers it 2xx again), `stop_on_revoked` (its client stops at the first `token_revoked` and
sends nothing after; planted defect `ClientBugs.ignore_revoked` is caught as `stop_on_revoked` or `bounded_work`). `no_duplicates` allows
for creates a revoked device had applied but never saw acknowledged. The model server has no devices (nothing to model: identity is
not part of its state), so the model soak is unchanged.

Layer D: `apps/web/e2e-real/sync06-devices.spec.ts` (the bearer journey: sign in with the password, sync, refused on account endpoints,
rename and sign out from Settings, immediate `token_revoked`; the Devices section at 1440/390/360 px in both themes with axe on the
list, rename, confirm and sign-out-all states, 44 px targets and no clipping); `ux08` and `ux11` sweeps include the new section.
Unit (vitest): `DevicesSection.test.tsx`, the password-change flag in `Settings.test.tsx`.

#### 10.0e The TypeScript client core (SYNC-08)

Location `packages/sync-core/` (`src/*.test.ts` unit tests, `sim/` simulation). The simulation runs the **real** `sync-core` (not a
model of it) in N clients over `MemoryStore`, with a seeded virtual-time schedule, against (a) a TS model server (`sim/model/`, a port of
`tests/sim/model*.py`: sync mode, field merge, edit-wins, feed/snapshot/floor, notes with history, `merge3`, conflict copies, resolution
log and undo, epoch, device revocation) and (b) the real API (`sim/real/`, opt-in). Faults: drop request, drop response after apply,
duplicate, delay/reorder, 5xx after apply, offline periods, client restart losing volatile state, a transaction lost before commit
(`MemoryStore.crashBeforeCommit`), jumping clock skew (sent as `X-Client-Time`, which must not matter), feed purge, late joiner,
unsupported protocol client, revoked device, server restore. Invariants (`sim/invariants.ts`): convergence, no acknowledged loss, no
duplicates, no resurrection except edit-wins, cursor safety, revision identifies state, byte-identical retries/key stability, exactly-once
(model), no silent text/note loss (every typed line is somewhere or was removed by an edit), conflict copy holds the losing text, unique and
portable paths, resolution logged once / no log without write / log has no text / undo once / undo never overwrites newer / notices
converge, stop on 426, stop on revoked and never served, log lines carry no content, idempotence, bounded work, clock independence.

| Command | Effect |
|---|---|
| `cd apps/web && npm run test` | everything above at default size (12 seeds per scenario, 120 steps) plus 34 planted-defect tests |
| `ATLAS_SYNC_SEEDS=150 ATLAS_SYNC_STEPS=250 npx vitest run --project sync-core model.sim` | model soak |
| `ATLAS_SYNC_SEEDS=1000 ATLAS_SYNC_STEPS=300 npx vitest run --project sync-core model.sim --testTimeout 1800000` | full soak (about 29 min; raise the timeout, vitest's default 60 s fails the long tests without any invariant failing; `PASS` 10/10 on 2026-11-09 after the seed-983 fix) |
| `ATLAS_SYNC_SEED=<n> ...` | one seed (every test then runs that seed; the count assertions of the first test may fail in this mode, which is not a defect; seed 983 has a fixed regression test) |
| `ATLAS_SYNC_REAL=1 ATLAS_SYNC_REAL_SEEDS=8 ATLAS_SYNC_STEPS=150 npx vitest run --project sync-core-real` | real API on a throwaway `atlas_e2e_*` database: conformance scenario (model vs real outcomes equal), seeds, revocation |

Planted defects (`sim/planted.sim.test.ts`): 24 in the model server, 8 in the client core (`options.plantedBugs`), each must trip the named
invariant, and a failure reproduces from its seed. **Not caught** at 250 seeds x 300 steps x 4 clients: server `notesConflictNotStored`,
server `undoRevivesDeleted`, client `applyStaleRevisions` (RISKS R-55). Not exercised: see R-55.

### 10.1 Layers

| Layer | What | Where | Runs |
|---|---|---|---|
| A. Server protocol | Multi-session HTTP tests: sync-mode writes, field merge, edit-vs-delete, note merge, idempotency replay, cursor ahead, snapshot, retention; **real concurrency** (asyncio, N transactions of one user) on real PostgreSQL | `services/api/tests/integration` | every CI run |
| B. Simulation on a model server | N clients, one in-memory server model, seeded random schedule, fault transport, virtual time | `services/api/tests/sim` (pytest, SYNC-02) | verify: 100+ seeds; soak: env var |
| C. Simulation on the real API | Same scenarios and invariant checker, real FastAPI + PostgreSQL; the model/real **conformance** suite replays identical traces and diffs responses | same harness, real server fixture | CI: ≥ 20 seeds; nightly: more |
| D. Real-stack e2e | Browser (Playwright, existing `e2e-real`) and the desktop shell (WebDriver/`tauri-driver`, **UNVERIFIED** availability) doing two-device journeys | `apps/web/e2e-real`, desktop e2e | CI where possible |
| E. Real devices | §10.5 | manual, recorded in `ACCEPTANCE.md` | per release |

### 10.2 Simulation model

- **Determinism.** One seeded PRNG; virtual clock and scheduler injected into every client (no `Date.now`, no real
  timers); a run is `(seed, scenario, N, steps)`; a failure prints the seed and writes the trace; the trace shrinks by
  deleting steps while the failure persists.
- **Clients.** The real `sync-core` (SYNC-08) over an in-memory `LocalStore`; before it exists, today's queue/engine with task
  and project only (SYNC-02). Each client has its own clock offset (±0 s … ±1 day, jumping), its own offline periods and can be
  restarted (state reloaded from its store) at **every await point** (crash-point enumeration: the run is repeated with a
  crash injected at step k for each k of a short scenario).
- **Actions** (chosen by the scheduler): create/edit one or several fields/delete/restore/move tasks and projects; create,
  edit (append, replace a paragraph, large), rename, delete notes (including identical paths from two clients);
  go offline/online; pull; push; restart; change clock; run reconcile; server restart; **restore server from an older
  backup**; advance time past tombstone retention (retention purge job run).
- **Faults** on the transport: lose request; lose **response after the server applied** (the dangerous one); duplicate
  request; delay/reorder across clients; 429 with Retry-After; 5xx; truncated page; slow link; token revoked mid-run.
- **Invariants** checked after quiescence (all clients online, faults off, pull to head, push to empty):
  1. *Convergence*: every client's materialised entities equal the server's (notes byte-equal).
  2. *No acknowledged loss*: each field write the client saw acknowledged is either in the final value or in the resolution
     log (simple field), in a conflict state or conflict copy (text/overlap) — computed from a shadow log of intents.
  3. *No duplicates*: exactly one entity per client-generated id; a retry never creates a second.
  4. *No resurrection*: a deleted entity stays deleted unless a later edit explicitly won (rule 4, logged).
  5. *Cursor safety*: a client cursor never exceeds the last cursor whose page was fully applied; cursors and revisions are
     monotonic per client; no applied page is skipped after a crash.
  6. *Order independence of clocks*: the same trace with different clock offsets gives the identical final state.
  7. *Bounded work*: pushes needed to quiesce ≤ a function of pending ops (no resync storm: ≤ 1 resync per injected cause).
  8. *Idempotence*: running pull+push again changes nothing.
- **Properties** (also as plain property tests on the server): `merge(base, a, b)` equals `merge(base, b, a)` on non-overlapping
  edits and never produces invalid UTF-8; field merge is commutative for disjoint fields; applying a feed page twice equals once.
- **Planted-bug tests** (mutation check of the harness itself): advance the cursor before apply; drop the idempotency key on
  retry; ignore tombstones; use client time for ordering; merge on a missing base — each must make a named scenario fail.

### 10.3 Required scenarios (each must exist before the matching feature is `DONE`)

Concurrent different-field edits; same simple field; same text field; edit vs delete (both orders); delete vs delete; recurring
task completed on two devices; offline create of a task and its subtask, parent-first replay; note edited in different
paragraphs on two devices; overlapping note edits (conflict copy, no merge); note rename vs edit; two notes created at the
same path; note deleted on one device, edited on another; tombstone older than retention (resync, non-destructive, pending
edits kept); device offline across the retention floor; **server restored from backup (cursor ahead)**; token revoked while
offline; client crash between apply and cursor; response lost after apply; protocol-version mismatch (old client does not
write); new entity type added (backfill).

### 10.4 Scale and limits

One user, 10 000 tasks, 5 000 notes (largest 5 MiB): bootstrap time, memory, pages, and incremental pull latency are measured
and recorded (not asserted against invented thresholds until the first measurement exists).

### 10.5 What needs real devices (cannot be simulated)

Android Doze/standby and vendor battery managers (background sync, notification delay), Storage Access Framework and app
permission flows, WebView version spread, Windows file locking/antivirus/OneDrive-synced note folders, case-insensitive and
Unicode-normalising filesystems, the real OS keystores, installers and auto-update signing, sleep/wake clock jumps, captive
portals and flaky mobile networks. Each is a checklist item in SYNC-12 and in the Tauri spike (`ROADMAP.md` SYNC-07).

Results use the §9 vocabulary. A simulation seed that was not run is `NOT RUN`, not `PASS`.

### 10.6 Tauri spike (SYNC-07): not part of `verify.sh`

`spikes/tauri/` (README there) is isolated: it is outside `apps/web` (ESLint, `tsc`, `vitest` only read `apps/web` and `packages/sync-core`), outside `services/api`, not run by
`./scripts/verify.sh` or CI. It needs a display, Rust (rustup), a throwaway database `atlas_spike_<random>` that its own `scripts/stack.mjs` creates and drops (never `atlas`
or `atlas_test`), and writes only under `$SPIKE_OUT` and `spikes/tauri/target`. Its results are evidence for the spike decision, not regression tests; the commands to rerun them
(S1 scenario in WebKitGTK and Chromium, S2 kill-9, S3 watcher/scan/scope, S4 keystore, S6 signed update, S8 sizes, X2 round trip with `packages/sync-core`) are in its README.
Never run it against real data, the owner's `atlas` database or a published update server. Real input (IME, key events), the J1-J7 journeys in the shell and anything on Windows or
Android are `NOT RUN` (`SYNC_PROTOCOL.md` section 13).

**Windows runner (manual, `.github/workflows/windows-spike.yml`):** `gh workflow run windows-spike.yml --repo Mauz92/atlas`, then `gh run watch` and `gh run download <id> --repo Mauz92/atlas`. Jobs: `windows` (windows-latest: Rust MSVC
build, per-user NSIS installers 0.1.0/0.2.0 signed with a key generated on the runner, `scripts/windows/headless.ps1`, `install.ps1`, `smoke.ps1`, `updater.ps1`) and `supply-chain` (ubuntu: `cargo audit`, `cargo license --filter-platform x86_64-pc-windows-msvc`).
It never runs on push or pull request (Windows minutes are billed at a multiple on private repositories; about 11 min warm, 20 min cold). Artifacts: `TEST-ONLY-atlas-spike-windows-installers` (14 days), `atlas-spike-windows-results`, `atlas-spike-windows-supply-chain` (30 days).
Not covered by it and `NOT RUN`: standard-user/UAC behaviour, SmartScreen, AppLocker/AV, OneDrive/Dropbox, IME, the real Atlas UI in WebView2, toast display (`SYNC_PROTOCOL.md` 13.3a).


## 11. Account recovery tests (AUTH-01, ADR-0067)

Run with the rest: `./scripts/verify.sh`; the real-stack journey is `auth01-recovery.spec.ts` (section 1b).

| File | What it proves |
|---|---|
| `tests/unit/test_recovery_code.py` | format and entropy (>= 128 bits, Crockford, six groups of five, all symbols used, no repeats), tolerant entry (case, dashes, spaces, look-alikes) and refusal of everything else, salted HMAC, account key holds no address, the limiter is a bounded delay that refused attempts cannot extend, pruning |
| `tests/integration/test_recovery.py` (23) | setup reveal and hash-only storage; reset: password, **every** session and device revoked, code rotated, no cookie; replay; two simultaneous resets succeed once; one transaction (a failing device revocation changes nothing); ordinary password change and operator reset leave the code alone; `atlas-admin recovery-code`; enumeration (same body, headers and SQL for unknown/no code/inactive/wrong); throttle per account (also unknown addresses) and per address, `Retry-After`, window slides; regenerate needs the session, CSRF and the password and kills the old code; accounts without a code can create one; a device gets `403`; cross-user isolation both ways; `RECOVERY_ENABLED=false`; no cookie or CSRF ride; `422` never echoes; no secret in any log record and the audit events exact; no plaintext in any table or the export |
| `tests/integration/test_recovery_migration.py` (3) | `c9e4a7b2d6f1` on a clean database and on the previous revision with a populated schema (user, session, device, task); existing accounts have no code; constraints; cascade; downgrade keeps everything else; down/up/up |
| `tests/integration/test_recovery_backup.py` | the real `pg_dump` holds salt and hash and never the code; the manifest neither |
| vitest `RecoveryCodeReveal`, `ForgotPassword`, `RecoverySection`, `AuthProvider.recovery` | acknowledgement gate, copy/download, nothing in storage, generic errors and 429 wording, confirmation check, recovery-off wording, the app held back at setup, regenerate flow and wrong password |

Mutation checks done once by hand on `atlas/auth/recovery.py` (each must fail a named test): no device revocation, no row lock, no failure
counter for unknown accounts (breaks equal work), no code rotation, no session revocation: all five were caught. NOT covered: wall-clock
timing equality (the equal-statements test is a deterministic proxy), a second API process, Safari/Firefox, a password manager's autofill.

## 12. Device-local reminder and sync-hint tests (M8-04; server tests and the Scheduler core suite EXIST since 2026-11-09, native/hardware parts are PLANNED; `SYNC_PROTOCOL.md` section 14, ADR-0068 ACCEPTED)

**Implemented (2026-11-09):** `services/api/tests/unit/test_reminder_actions.py`, `tests/integration/test_reminder_feed.py` (feed triggers, `sent`, actions, home zone, concurrency), `test_reminder_feed_convergence.py` (seeded random walk against an independent oracle, `ATLAS_REMINDER_SEEDS/STEPS`), `test_reminder_feed_migration.py` (empty, populated, downgrade, second round trip), `tests/unit/test_hints.py` (SSRF table, adapter, breaker, registry), `tests/integration/test_sync_hints.py` (long poll, registration, emitter, sender, fake loopback gateway), `tests/unit/test_nginx_config.py` (read timeout). `packages/reminder-core/src/scheduler.test.ts` (41 scenarios), `framework-free.test.ts`, `sim/scenario.sim.test.ts` (`ATLAS_REMINDER_SEEDS/STEPS/SEED`; soak `npm run test:soak` in the package) and `sim/planted.sim.test.ts` (seven planted defects, each caught by a named invariant). Invariants: `at_most_once`, `no_stale_show`, `no_orphan_alarm`, `bounded_alarms`, `nothing_lost`. A Python planted-defect check of the feed (a cancellation not announced; a moved schedule keeping its snooze) was run by hand and both were caught by the convergence test. **Not extended:** the SYNC-02 model server (`tests/sim/model*.py`) and the sync-core conformance with the `reminder` type (that belongs to M8-04b-ii).

### 12.1 Layers

| Layer | What | Where | Runs in `verify.sh`/CI |
|---|---|---|---|
| Server unit/integration | `reminder` entity triggers, idempotent scan, actions endpoint, wait endpoint, hint emitter, origin validation, fake gateway | `services/api/tests` (real PostgreSQL) | yes (M8-04a, M8-04e) |
| Scheduler unit + property | `packages/reminder-core` on a fake clock and fake ports | vitest | yes (M8-04b) |
| Multi-device simulation | the SYNC-02/08 harness with a reminder-aware client: N devices, fault network, a fake OS scheduler, a fake notification sink | `packages/sync-core/sim` pattern | yes (M8-04b) |
| Native adapters | Rust tick/jump logic, Kotlin receivers | cargo test / Android unit tests | with SYNC-09/10 |
| Real devices | everything the simulation cannot show (12.4) | manual + ADB | never (`NOT RUN` until done, M8-04g) |

### 12.2 Fake-clock Scheduler scenarios (each must exist before M8-04b is `DONE`; oracle in 12.3)

1. **DST.** Server-computed instants for a task due 09:30 local on the day of the spring-forward (the "09:00" policy lands in the gap on some zones: instant just after the gap) and the fall-back overlap (first occurrence); Europe/Stockholm, America/New_York, Australia/Lord_Howe (30-minute shift), a zone with no DST. The Scheduler arms exactly the entity's `remind_at`; changing the *device* zone before and after the transition changes nothing.
2. **Zone and clock changes on the device:** zone change (no reschedule, no duplicate, no loss); wall clock forward 3 h across a due reminder (catch-up shows it once); clock back 1 h after it fired (does not fire again: fired-set); NTP-like 90 s step; skew warning at >2 min and no adjustment.
3. **Restart, reboot, update.** Kill between "write fired key" and "show" (lost, listed under Missed, never duplicated); reboot clears OS alarms (`FakeOsScheduler` reboot) and `onBoot` re-arms; an app update that clears alarms is re-armed on first start; the plugin-restore double schedule (OS list vs Scheduler map) is reconciled to one; past-due-at-boot catch-up and grouping above three.
4. **Dedup.** Same `reminder` delivered by two pulls; a page replayed after a crash; a reschedule (new `remind_at`) fires once more, a frozen-after-`sent` reminder does not; device A and B both fire by default; `notifyOnThisDevice=false` fires on one only; A dismisses -> B (after its sync) clears the shown notification and cancels the pending alarm; A and B snooze simultaneously -> server order decides, both converge, each fires at most once per `key`.
5. **Snooze round trip.** Offline snooze arms a local alarm; the action is queued; response lost then replayed (same `action_id`, `Idempotency-Replayed`); server `snoozed_until` differs from the optimistic one -> device re-arms; a snooze on a `cancelled` reminder; a snooze after a dismiss re-arms; dismiss after snooze.
6. **Edits that change the schedule.** Complete/archive/delete offline cancels at once; offline re-date cancels until the next `reminder` revision; recurring task completed offline: the next occurrence appears only after sync (asserted, not hidden); a task completed on another device while this one is off: after boot the restored alarm fires stale once (documented, asserted as accepted L1/C4 behaviour) and the next sync clears it.
7. **Limits.** More than `maxScheduled` armed reminders (nearest first, refill after each reconcile); horizon edges; burst grouping (6 due within a minute -> 5 + 1 grouped or 1 grouped, per the option); quiet hours defer to one summary; `contentMode=generic` never passes a title to the port (spy asserts the strings handed to `schedule`/`show` and the stored schedule map contain no title).
8. **Permissions.** Denied: no schedule calls, status `blocked`, nothing fired; granted later: catch-up; exact alarm unavailable: schedules as inexact, status `late-possible`; permission revoked: alarms cancelled by the OS (fake) and re-armed when granted.
9. **Desktop tick.** Hidden-window jitter of up to 60 s still fires once; resume after a 2 h sleep; two ticks racing (single-flight).

### 12.2a The sync-core half (M8-04b-ii, implemented 2026-11-09)

**Unit** (`packages/sync-core/src/reminders.test.ts`, 22 tests): `types=` negotiation and `types_synced`; apply by revision, tombstone, snapshot tombstoning, never re-created; the backfill (walk `since=0&types=reminder`, continuation with `snapshot=true`, nothing visible or recorded between pages, main pull resumes from the old cursor with the new type, a crash before the last page repeats the walk, downgrade then upgrade, version-1 store read and version-2 written); the queued action (action id as `Idempotency-Key`, lost answer retried byte-identically, answer applied, duplicate submit queues once, malformed snooze refused, `acted_at` only after a minute and frozen, 404 silent, 409 `revision_ahead` kept as a problem and no `GET /api/reminders/{id}`, 401 halts); `dirty`/`open` (pending due-date edit, completion, deletion, dirty outliving the acknowledgement until a pull that started after it completes, across a page boundary, across a restart). Server: `test_reminder_actions.py` and `test_reminder_feed.py` (clamp edges, past/future/ancient `acted_at`, no ordering by it, replay vs changed body, naive value `422`, dismissal of a snooze that ended before `remind_at`).

**Simulation** (`packages/sync-core/sim/`): `reminders.sim.test.ts` runs the real engines and real `reminder-core` Schedulers (3 to 4 devices, one desktop engine, fake OS with reboot/permission) on the model server with `reminders: true` (`ModelServer` derives `reminder`, serves actions, enforces the real task transitions and the `acted_at` clamp); scenarios: base, offline-heavy (late snoozes), mid-run upgrade (backfill under faults), late joiner with purge, revoked device, determinism. Invariants in `reminderInvariants.ts` (list in its header). `planted.reminders.sim.test.ts`: 18 checks (7 model-server defects, 4 sync-core defects, 6 scheduler defects, plus seed-reproduction and an honest run), each must trip the named invariant. Conformance: `sim/reminderScenario.ts` run on the model and on the real API must give identical outcomes (`ATLAS_SYNC_REAL=1 ... --project sync-core-real`); the real-API world run uses the real clock, so alarms rarely fire during it. Commands: README of the package. The Python model/real simulations (`services/api/tests/sim`) were **not** extended.

### 12.3 Property test and planted defects

Random sequences of {pull page, local edit, complete, snooze, dismiss, clock step, zone change, reboot, update, crash, permission toggle} over 2-3 devices with a fault network. Oracle: for each `key` that was ever `armed` and not later cancelled/acknowledged, a device with notifications on shows **at most once**, and **exactly once** if it was running and permitted within the horizon at `effective_at` or later (catch-up); never for a task completed/deleted before the device synced that fact **and** was online; never from a title when `generic`. Planted defects that must be caught by a named test: write the fired key after showing; key without `effective_at`; trust `server_delivered_at`; ignore `acknowledged_at`; use `Date.now()`; keep an alarm after a local completion; skip `types_synced` backfill.

### 12.4 Needs real devices (cannot be simulated; M8-04g checklist, each `NOT RUN` until performed)

Android (two versions, one aggressive vendor): fires with the app swiped away and offline; in forced Doze (`dumpsys deviceidle force-idle`) with exact vs inexact permission and the measured delay; after reboot (and the ~15 s catch-up of past-due alarms); after an app update (are alarms cleared? receiver re-arms); `POST_NOTIFICATIONS` denied twice; exact-alarm revoked while running; battery-optimisation restricted; "force stop"; vendor kill list; action buttons without opening the UI; lock-screen content with `Private`; channel importance changed by the user; Do Not Disturb; hint arrival through the ntfy distributor with the screen off; a hint from a stranger on an open topic (throttle). Desktop: Windows (installed app, standard user; toast shown or suppressed by Focus Assist), Linux KDE (and GNOME with/without tray extension), WebView2/WebKitGTK timer throttling with a hidden window for 30 minutes, sleep/resume, autostart after reboot (AppImage path), tray quit semantics, notification permission ACL, a server restart and a network drop with the app resident. Cross-device: phone and desktop both on, the same reminder, dismiss on one.

### 12.5 Server tests (summary; details in ROADMAP M8-04a/e)

Feed triggers and no-churn scan; actions idempotency/later-wins/cross-user; exact-set-of-device-endpoints test extended on purpose; wait endpoint (immediate, timeout, revoked token mid-wait, per-user cap, 426/epoch); coalescing key; byte-identical hint payload; SSRF table; fake-gateway failures (timeout, 5xx, 429 + `Retry-After`, redirect, 410) with bounded retries and the circuit breaker; log-capture test (no endpoint, token or title in logs/errors); device revoke removes the hint row; compose-env test for the new settings.

Result vocabulary as section 9. Nothing in this section has been run.

## 13. Desktop client tests (SYNC-09 phase 1, Linux; ADR-0069; none of the Rust/Tauri parts is in `verify.sh` or CI)

### 13.1 Layers and how to run them

| Layer | Where | Command | In `verify.sh`? |
|---|---|---|---|
| Framework-neutral core on fake adapters: store contract and parity with `MemoryStore`, notes-folder engine against the model server (10 scenarios), runtime (sign-in/out, 401, 426, live poll and backoff, reminders at their time, settings, wake, tray, account change, keystore error), URL rule, "the core names no host" guard | `packages/desktop-core/src/**/*.test.ts` (vitest project `desktop-core`) | `cd apps/web && npx vitest run --project desktop-core` | **yes** (part of `npm run test`) |
| Tauri adapter against a fake `__TAURI__` (one command per port method, no token command, bridge `fetch`, 401 handling) | `apps/desktop/src/tauriPlatform.test.ts` (same vitest project) | same | **yes** |
| Web bridge: `apiFetch` through the host without CSRF/cookie, the Desktop settings section only in the shell, browser-only sections hidden, update button only when configured | `apps/web/src/components/settings/DesktopSection.test.tsx` | `npx vitest run --project web DesktopSection` | **yes** |
| Multi-client simulation with the desktop store (model server, dropped/duplicated requests, restarts, clock jumps, store crashes that lose a whole commit, late joiner, reminder devices, planted non-atomic store must fail) | `packages/desktop-core/sim/desktop.sim.test.ts` | `ATLAS_DESKTOP_SEEDS=120 ATLAS_DESKTOP_STEPS=200 npx vitest run --project desktop-core desktop.sim` (soak); `ATLAS_DESKTOP_SEED=<n>` repeats one seed | **yes** (default 10 seeds x 120 steps) |
| Rust: SQLite store (order, atomicity, newer database refused, bad table), **kill -9 durability** (`ATLAS_KILL_RUNS`, default 60), confined folder (traversal, symlinks, hidden, sibling prefix, compare-and-swap, same-size edit, missing root, trash), watcher (drops `Access` and temp names, coalesces), API client (token attached, webview credentials dropped, no redirect, sign-in outcomes), URL/path rules | `apps/desktop/native` | `cd apps/desktop && cargo test -p atlas-desktop-native` (+ `cargo clippy --workspace --all-targets -- -D warnings`, `cargo audit`) | no |
| **End-to-end run of the real app** against a throwaway API (see 13.2) | `apps/desktop/e2e/run.mjs` | `scripts/build-linux.sh e2e && node e2e/run.mjs` (or pass a binary) | no |
| Updater (valid / tampered / wrong key) with a throwaway key | `apps/desktop/e2e/updater-test.mjs` | `node e2e/updater-test.mjs` | no |

### 13.2 The end-to-end run

`e2e/run.mjs` creates database `atlas_desktop_<hex>` (name enforced by `e2e/db_admin.py`; never `atlas`/`atlas_test`) on the existing Postgres server, starts the real API from `services/api/.venv` on a free loopback port with `CORS_ORIGINS` empty, puts a loopback TCP **proxy** in front of it (the "network cable": switching it off makes the app offline), starts the app (a build with the `e2e` feature, temp data/notes/config directories, a throwaway keystore entry name `atlas-e2e-<hex>`) and drives the **real pages**: an injected script types into the sign-in form and clicks its buttons; a second simulated device (the real sync-core engine bundled by esbuild, directly against the API) does the other side. Steps: stack up; seed from another device; sign-in page; sign-in through the form; keystore entry present and the token string in no file; initial sync into the folder; UI probe (the web UI through the bridge: `/api/auth/me`, tasks, notes, projects, instance all `200`; no token command; no service worker; foreign origin blocked by CSP); Settings > Desktop app rendered; external create -> server -> second device; remote edit -> file via the live connection; offline conflict (same line edited on both sides) -> conflict-copy file and nothing lost; offline edit then reconnect; rename and delete; **reminder** created on the other device -> D-Bus `Notify` seen by `dbus-monitor` exactly once; **tray**: close window -> hidden, a remote change still reaches the file, tray "open" -> visible; autostart off by default, on writes one hidden-start entry (in a temp `XDG_CONFIG_HOME`), off removes it; footprint; **server-side revoke** -> sign-in page with the message, keystore entry gone. At the end the app is stopped, the keystore entry, database, temp directories and processes are removed; a stray-database check is part of the report (`docker exec atlas-db-1 psql -U atlas -d atlas -Atc "select datname from pg_database"`).
The window opens briefly on the current display; the run does not use input devices.

### 13.3 What this does NOT test (`NOT RUN`)

Windows (everything: R-36), other Linux distributions, GNOME and its tray situation, GNOME Keyring and a locked wallet at start, real key input, IME/CJK composition and caret keys in the editor (no input tool on the machine), the post-edit frame on a controlled GPU, a real suspend/resume, a 30-minute hidden-window reminder lateness run (M8-04g), OneDrive/Dropbox/network folders, tens of thousands of notes, the owner's private-CA certificate, any real server, tailnet or the owner's data, power-loss durability (only process kill is tested), `.deb` installation (no dpkg on Arch: the package contents and metadata were inspected, not installed).

## 14. Conflict, notice and restore UI tests (SYNC-11; ADR-0070)

### 14.1 Layers and how to run them

| Layer | Where | Command | In `verify.sh`? |
|---|---|---|---|
| Pure wording and decisions: every resolution rule and every undo refusal of `SYNC_PROTOCOL.md` 9, field value formatting, "other device" rule, unseen notices, line diff, conflict-copy pairing, halt wording, instant-updates wording, problem wording, the engine source's mapping | `apps/web/src/lib/syncUi/*.test.ts` | `cd apps/web && npx vitest run --project web src/lib/syncUi` | **yes** (part of `npm run test`) |
| Components over fake sources: Changes page (undo with one key per tap, a retry reuses the key, refusal shown as a plain message with Undo still enabled, follow-up links, paging, empty and error states), banner (counts, dismiss survives a reload, hidden on `/changes`, a failing source shows nothing), text resolver, note resolver and `NoteConflicts` (order: original written with its revision, then the copy deleted; a `409` deletes nothing; a failed delete keeps the copy), halt screens, instant-updates block, shell Settings > Sync, shell halt wiring | `apps/web/src/components`, `apps/web/src/pages`, `apps/web/src/hooks` (`*.test.tsx`) | `npx vitest run --project web` | **yes** |
| Task panel: set-aside text fields shown with the resolver; Keep mine is a normal save against the latest revision (`TaskDetail.test.tsx`, `taskAutosave.test.ts` `resolveStashField`) | same | same | **yes** |
| "R-69/R-73: the shell does not start the browser's offline queue or reconciler" | `apps/web/src/pages/Settings.shell.test.tsx` | same | **yes** |
| sync-core: `discardLocalAndRedownload()` in the model simulation (3 clients, restore with rotated epoch at step 60, every waiting client discards: nothing unsent, no failed or conflicting item, convergence to the restored server, nothing re-created; the scenario must throw something away; refuses when nothing waits) | `packages/sync-core/sim/model.sim.test.ts` ("the person discards local changes") | `npx vitest run --project sync-core model.sim` (soaks: 10.0e) | **yes** |
| desktop-core runtime verbs on the fake platform and the model server: resolutions listed newest first, undo through the queue (applied; refused with `409` after a later change; offline -> `queued`, not a hang), `uiResolveText` (reads the newer revision first, queues an ordinary edit, dismisses), restore halt visible in the snapshot, re-upload, discard, the verbs refuse while signed out | `packages/desktop-core/src/runtime.test.ts`, `apps/desktop/src/tauriPlatform.test.ts` | `npx vitest run --project desktop-core` | **yes** |
| Real stack (real API, real browser, two device clients with bearer tokens in sync mode): banner -> Changes page -> Undo applied (value read back through the API); a second conflict plus a later edit -> "changed again since", value untouched; a merged note -> no Undo, reason and follow-up link; a task title conflict -> both versions -> Edit merged -> saved, read back by the other device; two note conflict copies -> merge in the editor and Keep mine, the copies are gone; Settings instant-updates block and a test notification (the Notification API is replaced in the page: headless Chromium cannot be granted the permission); axe, no horizontal overflow and screenshots at 360/390/768/1440 px in both themes for every new screen | `apps/web/e2e-real/sync11-conflicts.spec.ts` | `cd apps/web && npm run test:e2e:real` (a single file: `npx playwright test -c playwright.real.config.ts sync11`; `SYNC11_SHOTS=<dir>` writes screenshots) | no (CI `e2e-real` job) |
| Shell screens in a real browser with a fake `window.atlasDesktop` (restore: both choices and the second confirmation, nothing automatic; update required; signed out; Settings > Sync with a kept text conflict; the Changes page over the engine source with an offline-queued undo; Settings > Desktop app status) with axe, overflow and screenshots as above | `apps/web/e2e/sync11-shell.spec.ts` | `cd apps/web && npm run e2e` | no |
| The real desktop app: a conflict between two other devices -> banner and Changes page -> Undo through the engine, read back by another device; Settings > Sync and Desktop app status; the operator restores the server (`python -m atlas.auth.cli record-restore` against the throwaway database) -> the restore screen -> Re-upload resumes; a second restore -> Discard asks twice, the unsent change is dropped, a local file survives | `apps/desktop/e2e/run.mjs` (new steps "notices", "settings (SYNC-11b/c)", two "restore" steps; driver commands `goto`, `page_text`, `click`) | `scripts/build-linux.sh e2e && node e2e/run.mjs target/debug/atlas-desktop` | no |

### 14.2 What this does NOT test (`NOT RUN`)

A browser local store (SYNC-11d is only planned); offline editing in the shell's task screens (not built); real push delivery to a browser (needs a push service; the test notification is local); the restore screen on a phone-sized real device (the shell runs on desktops; the screens were checked at 360 and 390 px in a browser); Windows; a screen reader (axe only); the sync-core soaks beyond what 10.0e lists were run once for the changed engine (see `ACCEPTANCE.md` SYNC-11).
