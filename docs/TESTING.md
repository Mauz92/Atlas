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
of `.github/workflows/ci.yml` (PostgreSQL service). Like the mocked suite it is **not** part of the
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
