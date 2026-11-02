# Current Task

- Task ID: MU-03
- Status: READY
- Depends on: MU-01 (`DONE`, 2026-11-02), MU-02 (`DONE`, 2026-11-02), M3-08 (`DONE`)
- Milestone: MU — Usable Core (docs/ROADMAP.md, ADR-0043)

## Goal
Tasks page (full definition: `docs/ROADMAP.md`, MU-03 row): replace the Tasks placeholder with the
existing server filters (status, priority, due range, project, text) plus sort and a client-side
saved-filters shortcut list; bulk complete / delete / move to project.

## Verification gate
Component tests plus a real-stack Playwright journey (`cd apps/web && npm run test:e2e:real`, see
`docs/TESTING.md` §1b). Start specs with `ensureOwner(page)`, use unique titles (journeys share one
database per run). Keep tests lean: parametrize, one spec with shared setup.

## Notes
- Reuse: `TaskDetail` via `hooks/useTaskEditor.tsx` (it now takes projects from `hooks/useProjects.tsx`,
  the shared project list provided by `Layout`), `TaskList`, `tasksApi.list` filters, `ProjectForm`.
- Known limitations carried forward: UI mutations (tasks and projects) are online-only (not via the
  offline queue, R-22); a due time of exactly 23:59 reads as "end of day"; `.local` email addresses are
  still rejected; no project delete in the UI (archive only); linked notes do not deep-link (MU-06).
- Do not start MU-04 until MU-03 is `DONE`. Do not start blocked M5/M6/M8 work.
