# Current Task

- Task ID: MU-08
- Status: READY
- Depends on: MU-07 (`DONE`, 2026-11-02)
- Milestone: MU — Usable Core (docs/ROADMAP.md, ADR-0043)

## Goal
Settings and shell polish (full definition: `docs/ROADMAP.md`, MU-08 row): replace the Settings
placeholder (account name and password change, theme, reminder timing and notification status, export
download, backup status/last run, instance info and version); loading/empty/error states, mobile layout,
shortcut help overlay, accessibility pass. Journey J7 plus an axe check.

## Verification gate
Backend + component tests plus a real-stack Playwright journey (`cd apps/web && npm run test:e2e:real`, see
`docs/TESTING.md` §1b). Start specs with `ensureOwner(page)`, use unique titles (journeys share one
database per run). Keep tests lean: parametrize, one spec with shared setup.

## Notes
- Delivered by MU-07 (ADR-0049): `POST /api/notes/daily` (client sends the viewer's `YYYY-MM-DD`; `201` created
  / `200` existing, never rewritten), `POST /api/notes/from-template`, `NotesStorage.write_new` (hard-link
  publish, no overwrite), Today with scheduled work / daily-note card / empty events slot, palette commands
  "Open today's note" and "New note from template". J6 specs read the notes directory through
  `ATLAS_E2E_NOTES_DIR` (set by `e2e-real/global-setup.ts`).
- A user time-zone setting does not exist; "today" is the browser's zone (ADR-0049 §1). MU-08's Settings page
  is the natural place to add one if wanted; if so, send it where the client currently uses `viewerTimeZone()`.
- Reuse: `apiCall`, `dateIn`, `ensureOwner` in `e2e-real/helpers.ts`; the export/backup endpoints from M9 for the
  Settings sections; `ThemeToggle`, `ReminderPreferences`, `NotificationConsent` components already exist.
- Known limitations carried forward: UI mutations are online-only (R-22); a due time of exactly 23:59
  reads as "end of day"; `.local` email addresses are still rejected; no project delete in the UI; Tasks
  page sorts client-side over the first 500 matches (ADR-0045); an occurrence of a repeating series shows
  its rule read-only (ADR-0046); search matches word prefixes only, and the task-list `q` filter and
  `tasks.project_id` stay unindexed (R-20, ADR-0047); the palette's page-behind remount after a task save
  resets that page's transient state; tasks link to notes only at creation and wiki-link text is path
  based (ADR-0048); a renamed daily note is not found again by "Today's note".
- Task detail buttons: the form's save is "Save"; the reminder section uses "Set reminder"; linked notes use
  "Open note <path>" / "Unlink note <path>". The top bar has a "Search · Ctrl K" button; scope
  `getByRole("combobox")` to the palette dialog in specs.
- Do not start blocked M5/M6/M8 work.
