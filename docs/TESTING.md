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

Status: **planned** (SYNC-02 builds it; nothing below exists yet). Sync bugs are ordering and failure bugs, so the main
evidence is a deterministic simulation, not example-based tests.

### 10.1 Layers

| Layer | What | Where | Runs |
|---|---|---|---|
| A. Server protocol | Multi-session HTTP tests: sync-mode writes, field merge, edit-vs-delete, note merge, idempotency replay, cursor ahead, snapshot, retention; **real concurrency** (asyncio, N transactions of one user) on real PostgreSQL | `services/api/tests/integration` | every CI run |
| B. Simulation on a model server | N clients, one in-memory server model, seeded random schedule, fault transport, virtual time | `packages/sync-sim` (vitest) | CI: ≥ 200 seeds; nightly: ≥ 5 000 |
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
