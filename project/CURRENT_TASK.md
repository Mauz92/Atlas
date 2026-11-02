# Current Task

- Task ID: MU-02
- Status: READY
- Depends on: MU-01 (`DONE`, 2026-11-02), M4-01…M4-07 (`DONE`)
- Milestone: MU — Usable Core (docs/ROADMAP.md, ADR-0043)

## Goal
Projects UI (full definition: `docs/ROADMAP.md`, MU-02 row): replace the Projects placeholder with a list,
create/edit/archive/restore, and a project page with description, derived progress (ADR-0023), task list,
board and linked notes; assign/move tasks to a project from the task detail (extend `TaskDetail` — there is
a project field to add; the Inbox "File to…" control already files to existing projects); the sidebar shows
active projects. Journey J3 must pass.

## Verification gate
Journeys run with the real-stack harness: `cd apps/web && npm run test:e2e:real` (see `docs/TESTING.md`
§1b). Add `j3-*.spec.ts` under `apps/web/e2e-real/`; start with `ensureOwner(page)` and use unique titles
(journeys share one database per run). `apiCall` in `e2e-real/helpers.ts` can be dropped from J3 once
projects can be created in the UI.

## Notes
- MU-01 delivered the shared task detail (`components/TaskDetail.tsx`, opened through
  `hooks/useTaskEditor.tsx`), tags (`tags: string[]`) and `POST /api/tasks/{id}/restore` (ADR-0044).
- Known limitations carried forward: UI task mutations are online-only (not via the offline queue,
  R-22); a due time of exactly 23:59 reads as "end of day"; `.local` email addresses are still rejected.
- Do not start MU-03 until MU-02 is `DONE`. Do not start blocked M5/M6/M8 work.
