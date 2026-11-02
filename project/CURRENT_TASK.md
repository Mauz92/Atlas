# Current Task

- Task ID: MU-05
- Status: READY
- Depends on: MU-01 (`DONE`), MU-02 (`DONE`), M2-06 (`DONE`); MU-04 (`DONE`, 2026-11-02)
- Milestone: MU — Usable Core (docs/ROADMAP.md, ADR-0043)

## Goal
Command palette, quick switcher and unified search (full definition: `docs/ROADMAP.md`, MU-05 row):
global shortcut opens a palette that fuzzy-finds notes, tasks and projects, with actions (new note/task/
project, go to view, toggle theme); backend adds one `GET /api/search` over notes (existing FTS), tasks and
projects, user-scoped, bounded and indexed (resolves R-20); replace the Search placeholder. Journey J5.

## Verification gate
Backend integration tests plus component tests plus a real-stack Playwright journey
(`cd apps/web && npm run test:e2e:real`, see `docs/TESTING.md` §1b). Start specs with `ensureOwner(page)`,
use unique titles (journeys share one database per run). Keep tests lean: parametrize, one spec with
shared setup.

## Notes
- Reuse: `useTaskEditor` / `TaskDetail` to open a found task; `tasksApi`, `projectsApi`; the notes FTS
  from M2-06; `e2e-real/helpers.ts` (`apiCall`, `dateIn`, `ensureOwner`).
- Known limitations carried forward: UI mutations are online-only (R-22); a due time of exactly 23:59
  reads as "end of day"; `.local` email addresses are still rejected; no project delete in the UI; linked
  notes do not deep-link (MU-06); Tasks page sorts client-side over the first 500 matches (ADR-0045); an
  occurrence of a repeating series shows its rule read-only (no edit/stop of a series in the UI, ADR-0046).
- Task detail buttons: the form's save is "Save"; the reminder section uses "Set reminder" (keep names
  distinct so `getByRole("button", { name: "Save" })` stays unambiguous in specs).
- Do not start MU-06 until MU-05 is `DONE`. Do not start blocked M5/M6/M8 work.
