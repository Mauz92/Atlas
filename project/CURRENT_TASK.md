# Current Task

- Task ID: MU-01
- Status: READY
- Depends on: MU-00 (`DONE`, 2026-11-01), M3-02…M3-09 (`DONE`)
- Milestone: MU — Usable Core (docs/ROADMAP.md, ADR-0043)

## Goal
Task detail and editing; capture lands where expected (full definition: `docs/ROADMAP.md`, MU-01 row):
one task detail panel (side sheet on desktop, full page on mobile) opened from any list to edit title,
description, status, priority, due date/time/time zone, start and tags, with delete + undo; Today capture
sets due = today; Inbox rows get schedule/file/delete actions; Enter opens, Esc closes; server validation
errors shown verbatim. Journeys J1 and J2 must pass.

## Verification gate
Journeys run with the real-stack harness (MU-00): `cd apps/web && npm run test:e2e:real`
(see `docs/TESTING.md` §1b). Add new specs under `apps/web/e2e-real/`, using `createOwner` / `signIn`
from `e2e-real/helpers.ts`.

## Notes
- Account setup rejects reserved email domains (e.g. `.test`) with a bare "Unprocessable Content"; the
  harness uses `example.com` until MU-08 fixes validation and error display.
- Do not start MU-02 until MU-01 is `DONE`. Do not start blocked M5/M6/M8 work.
