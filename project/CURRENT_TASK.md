# Current Task

- Task ID: MU-04
- Status: READY
- Depends on: MU-01 (`DONE`), M3-05, M3-06, M8-05 (`DONE`); MU-03 (`DONE`, 2026-11-02)
- Milestone: MU — Usable Core (docs/ROADMAP.md, ADR-0043)

## Goal
Recurrence, subtasks and reminders in the UI (full definition: `docs/ROADMAP.md`, MU-04 row): repeat
picker (daily/weekly/monthly/custom RRULE preview) with server validation; completing a recurring task
shows the next occurrence; subtask list with progress; per-task reminder override; delivery unchanged.

## Verification gate
Component tests plus a real-stack Playwright journey (`cd apps/web && npm run test:e2e:real`, see
`docs/TESTING.md` §1b). Start specs with `ensureOwner(page)`, use unique titles (journeys share one
database per run). Keep tests lean: parametrize, one spec with shared setup.

## Notes
- Reuse: `TaskDetail` via `hooks/useTaskEditor.tsx`, `TaskList` (now has `renderLead`), the Tasks page
  (`pages/Tasks.tsx`, `lib/taskFilters.ts`) for listing; `tasksApi` for edits. Check
  `services/api/atlas/api/tasks.py` for the recurrence/subtask/reminder endpoints before adding backend.
- Known limitations carried forward: UI mutations (tasks, projects, bulk actions) are online-only (R-22);
  a due time of exactly 23:59 reads as "end of day"; `.local` email addresses are still rejected; no
  project delete in the UI; linked notes do not deep-link (MU-06); Tasks page sorts client-side over the
  first 500 matches and bulk actions are sequential/non-atomic (ADR-0045).
- Do not start MU-05 until MU-04 is `DONE`. Do not start blocked M5/M6/M8 work.
