# Current Task

- Task ID: MU-07
- Status: READY
- Depends on: MU-06 (`DONE`, 2026-11-02)
- Milestone: MU — Usable Core (docs/ROADMAP.md, ADR-0043)

## Goal
Daily note, templates and Today as home (full definition: `docs/ROADMAP.md`, MU-07 row): "Today's note"
creates/opens `daily/YYYY-MM-DD.md` on demand (a normal Markdown file); template notes from a `templates/`
folder when creating a note; Today shows overdue, due today, scheduled work, the daily note and an events
slot that stays empty until M5. Journey J6.

## Verification gate
Backend + component tests plus a real-stack Playwright journey (`cd apps/web && npm run test:e2e:real`, see
`docs/TESTING.md` §1b). Start specs with `ensureOwner(page)`, use unique titles (journeys share one
database per run). Keep tests lean: parametrize, one spec with shared setup.

## Notes
- Reuse: `notesApi` (create/get, `/notes?open=<id>` deep link), `NotesService` (path validation, atomic
  create), `useTaskEditor`, `e2e-real/helpers.ts` (`apiCall` now also does PUT/DELETE and 204, `dateIn`,
  `ensureOwner`). Creating a note that exists must open it, not overwrite it (AGENTS.md §8).
- Delivered by MU-06 (ADR-0048): `POST /api/notes/{id}/tasks`, `GET /api/tasks/{id}/notes`, note detail
  `tasks`/`projects`, `[[` completion, `TaskNotes` in the task detail. Known limitations: tasks link to
  notes only at creation; wiki-link text is path based and not rewritten on rename.
- Known limitations carried forward: UI mutations are online-only (R-22); a due time of exactly 23:59
  reads as "end of day"; `.local` email addresses are still rejected; no project delete in the UI; Tasks
  page sorts client-side over the first 500 matches (ADR-0045); an occurrence of a repeating series shows
  its rule read-only (ADR-0046); search matches word prefixes only, and the task-list `q` filter and
  `tasks.project_id` stay unindexed (R-20, ADR-0047); the palette's page-behind remount after a task save
  resets that page's transient state.
- Task detail buttons: the form's save is "Save"; the reminder section uses "Set reminder"; linked notes use
  "Open note <path>" / "Unlink note <path>". The top bar has a "Search · Ctrl K" button; scope
  `getByRole("combobox")` to the palette dialog in specs.
- Do not start MU-08 until MU-07 is `DONE`. Do not start blocked M5/M6/M8 work.
