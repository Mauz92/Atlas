# Current Task

- Task ID: UX-04 (`READY`) — Task detail as a property panel with per-field autosave (ADR-0051 §4; UX_AUDIT §4.3)
- Last completed: UX-03 (`DONE`, 2026-11-02, local verification; not committed). One `TaskRow` + shared `Menu`,
  list keys, compact board cards with "Move to…", subtask parent context, completed tasks reopen from a checked
  checkbox. Decisions: ADR-0052. Evidence: `docs/ACCEPTANCE.md` UX-03.
- Before that: UX-02 (`DONE`, committed 00e00c5), UX-01 (`DONE`, d39c522), MU-08 (`DONE`, b921945).
  CI `e2e-real` NOT RUN.
- Milestone: UX — Design system and app shell (docs/ROADMAP.md "UX" section, ADR-0051, evidence in docs/UX_AUDIT.md)
- Also `READY`: UX-07 (Tasks, Projects and Board polish; depends on UX-03).

## Goal
UX-04 per `docs/UX_AUDIT.md` §4.3 "Task detail" and §6: inline title, property rows with popovers (reuse
`components/Menu.tsx` and `TaskMenu` entries where they fit), searchable time-zone select, auto-growing
description; docked at ≥ 1280 px, overlay with scrim below, full-screen sheet on phones; focus trap and return.
Owner decision (ADR-0051 §4): **autosave per field, no Save button**, every save with `base_revision`, a 409 never
overwrites (keep the local value, show the conflict UI), saves serialised per task and idempotent. Acceptance:
J1 incl. the stale-edit conflict, Esc closes and focus returns to the row, state indicator visible without
scrolling at 900 px height, list visible when docked.

## UX-03 conventions to keep
- Every task list renders `TaskList` → `TaskRow`; actions come from `useTaskEditor(...).actions`
  (`hooks/useTaskActions.ts`: existing PATCH/DELETE with `base_revision` + idempotency key, one change per task in
  flight) and filable projects from `editor.projects`. Do not add per-page row controls.
- Menus: `components/Menu.tsx` (entries `item` / `submenu` / `date` / `separator`; hints are `aria-hidden`);
  task entries in `components/TaskMenu.tsx`. It portals into the opener's landmark (axe `region`).
- Accessible names e2e specs rely on: `Complete <title>` (checkbox), `Open <title>`, `Actions for <title>` (the
  "…" trigger; avoid labels starting with "More", ux02 uses `name: "More"`), `Schedule <title> for today`,
  `Pick a date for <title>` (button and date dialog; field `Due date`, button `Set date`), `Move <title> to a
  project`, `Select <title>` (Tasks page). Menus are named `Actions for <title>`, `Priority`, `Move to project`,
  `Status`, `Move to…`. Helpers: `src/test/menu.ts` (`choose`, `menuItem`).
- List keys live in `TaskRow` (row-level) and `Layout` (`j`/`k` from outside a row); documented in
  `lib/shortcuts.ts`. `isTypingTarget` no longer treats checkbox/radio/button inputs as typing.
- The optimistic checkbox tick means e2e specs must poll the API after clicking it.

## UX-02 conventions to keep
- Navigation comes only from `NAV_SECTIONS` in `apps/web/src/lib/navigation.ts` (sidebar, rail via `rail: true`,
  phone bottom nav, palette "Go to …"). Add a page there, with its rail `group`; do not hard-code links in the shell.
- Shell landmarks: rail `nav "Destinations"`, `aside "Sidebar"` → `nav "Main navigation"`, `main#main-content`,
  `footer "Status bar"` (not `role="status"`: pages own that role and e2e specs use it unscoped), phone
  `nav "Bottom navigation"`. e2e: use `rail(page)` / `searchButton(page)` from `e2e-real/helpers.ts`.
- Breakpoints 1024 px (sidebar docked vs drawer) and 720 px (rail vs header + bottom nav) are in both
  `Layout.tsx` (`WIDE`/`NARROW`) and `styles.css`; change both. Overlays stay above the status bar (z 30).
- Icons: `<Icon name=… />` from `components/Icon.tsx`; add a Lucide shape only when used and list it in
  `docs/DEPENDENCIES.md` (ISC notice there).

## UX-01 conventions to keep
- Only scale tokens in `font-size`/`gap`/`padding` (`npm run lint` runs `apps/web/scripts/check-css-scale.mjs`).
- Colours only via tokens; change a dark value in **both** dark blocks (`styles.test.ts` fails otherwise and
  checks contrast). Buttons: default secondary, `.primary` once per view, `.ghost`, `.danger`. Pills: `.pill`
  plus `pill-danger|warning|success|quiet`; old badge class names remain only as test hooks.
- e2e selectors for notes use `getByTitle("Revision N")` plus the path; the toolbar text is `Saved` /
  `Unsaved changes`.

## Open before MU can be declared complete
1. Run the `e2e-real` job on GitHub Actions (never executed there): J1-J7 in CI is an MU exit criterion.
2. Re-score the release table (REQ-005/REQ-006 are still `PARTIAL`) from user-reachable behaviour; needs the owner's review.
3. Optional: fix the pre-existing dev-only `minimatch` advisory (`npm audit --include=dev`, RISKS.md).

## Recommended next task
UX-04 (task detail property panel with autosave). Alternatively UX-07 (Tasks/Projects/Board polish). Separately the
owner may still choose to close MU (items 1-2 above) or resume calendar with M5-00, which needs real
Google/Microsoft accounts (AR-001) and is blocked until provided.

## Notes for the next session
- Verification: `./scripts/verify.sh`; `cd apps/web && npm run test:e2e:real` (22 tests, real API + throwaway DB,
  see `docs/TESTING.md` §1b); `npm run e2e` (7 mocked). No `atlas_e2e_*` database is left on the dev PostgreSQL.
- Journeys share one owner: a spec that changes the owner's name, password or reminder default must restore it (J7 does).
- No user time-zone setting exists (ADR-0049); "today" is the browser's zone.
- UX-02 follow-ups: at 1024 px an open note is narrower than before (shell 288 px vs 220 px) until UX-05 collapses
  the sidebar on notes; `Day.tsx` is unrouted (kept for the Today date picker decision); Settings is not in the
  phone bottom nav (it is in the drawer); the status bar re-reads the queue on page change/focus/connectivity only.
- UX-03 limitations: reopening lands in *In progress*; a renamed parent keeps its old title in rows until
  re-listed/reloaded; search rows are read-only; quick actions hidden under `(hover: none)`; lists span the full
  main width (no max width).
- Known limitations carried forward: UI mutations are online-only (R-22); a due time of exactly 23:59 reads as "end
  of day"; no project delete in the UI; Tasks page sorts client-side over the first 500 matches (ADR-0045);
  an occurrence of a repeating series shows its rule read-only (ADR-0046); search matches word prefixes only and the
  task `q` filter / `tasks.project_id` stay unindexed (R-20, ADR-0047); tasks link to notes only at creation
  (ADR-0048); a renamed daily note is not found again; password change signs out all other sessions; backup status
  depends on the API seeing `BACKUP_DIR` and does not re-verify checksums (ADR-0050).
