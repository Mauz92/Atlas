# Current Task

- Task ID: MU-06
- Status: READY
- Depends on: MU-02 (`DONE`), MU-05 (`DONE`, 2026-11-02), M2-07 (`DONE`), M4-05 (`DONE`)
- Milestone: MU — Usable Core (docs/ROADMAP.md, ADR-0043)

## Goal
Note ↔ task ↔ project linking (full definition: `docs/ROADMAP.md`, MU-06 row): create a task from the
selected text/line in a note (explicit action; the task stores a link to the note; Markdown checkboxes are
**not** parsed as tasks — AGENTS.md §8); the note shows its tasks and project; the task detail shows linked
notes; `[[` autocomplete picks notes; backlinks list tasks and projects too. Journey J4.

## Verification gate
Backend + component tests plus a real-stack Playwright journey (`cd apps/web && npm run test:e2e:real`, see
`docs/TESTING.md` §1b). Start specs with `ensureOwner(page)`, use unique titles (journeys share one
database per run). Keep tests lean: parametrize, one spec with shared setup.

## Notes
- Reuse: `task_links` table (task ↔ note, `ON DELETE CASCADE`, ADR-0024) and `note_projects`; the deep link
  `/notes?open=<note id>` and `GET /api/search` from MU-05 (a `[[` autocomplete can call the search
  endpoint); `useTaskEditor` / `TaskDetail`; `e2e-real/helpers.ts` (`apiCall`, `dateIn`, `ensureOwner`).
- Known limitations carried forward: UI mutations are online-only (R-22); a due time of exactly 23:59
  reads as "end of day"; `.local` email addresses are still rejected; no project delete in the UI; Tasks
  page sorts client-side over the first 500 matches (ADR-0045); an occurrence of a repeating series shows
  its rule read-only (ADR-0046); search matches word prefixes only, and the task-list `q` filter and
  `tasks.project_id` stay unindexed (R-20, ADR-0047); the palette's page-behind remount after a task save
  resets that page's transient state.
- Task detail buttons: the form's save is "Save"; the reminder section uses "Set reminder" (keep names
  distinct so `getByRole("button", { name: "Save" })` stays unambiguous in specs). The top bar now has a
  "Search · Ctrl K" button; scope `getByRole("combobox")` to the palette dialog in specs.
- Do not start MU-07 until MU-06 is `DONE`. Do not start blocked M5/M6/M8 work.
