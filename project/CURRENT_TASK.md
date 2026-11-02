# Current Task

- Task ID: UX-03 (`READY`) — Task row, menus and quick actions (one `TaskRow`, shared `Menu`/`Popover`, list keys)
- Last completed: UX-02 (`DONE`, 2026-11-02, local verification; not committed at the time of writing). New app
  shell: icon rail, sectioned sidebar from `NAV_SECTIONS`, Ctrl/⌘ B, status bar, phone header + bottom nav +
  drawer, topbar removed, `/day` → Today, 24 vendored Lucide icons. Evidence: `docs/ACCEPTANCE.md` UX-02.
- Before that: UX-01 (`DONE`, not committed), MU-08 (`DONE`, committed b921945). CI `e2e-real` NOT RUN.
- Milestone: UX — Design system and app shell (docs/ROADMAP.md "UX" section, ADR-0051, evidence in docs/UX_AUDIT.md)

## Goal
Make the UI calm and consistent (neutral Notion-like look, Obsidian/VS Code shell). UX-03's scope is in
`docs/UX_AUDIT.md` §6 and the roadmap row: one `TaskRow` (round checkbox, meta, hover/focus actions, "…" menu),
a shared menu/popover (date shortcuts, project picker, priority), applied to Today, Inbox, Upcoming, Week,
project lists and search; list keys `j`/`k`/`x`/`t`/`m`/`p`/Enter; fixes for subtasks shown without parent and
Complete on completed tasks. Acceptance: Inbox ≤ 2 persistent controls per row, J2 still ≤ 2 interactions,
rows ≤ 40 px, keyboard-only Playwright check, mobile Inbox with 9 items < 1,000 px. Owner decisions in ADR-0051.

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
UX-03 (task row, menus, quick actions). Separately the owner may still choose to close MU (items 1-2 above) or resume calendar with
M5-00, which needs real Google/Microsoft accounts (AR-001) and is blocked until provided.

## Notes for the next session
- Verification: `./scripts/verify.sh`; `cd apps/web && npm run test:e2e:real` (20 specs, real API + throwaway DB,
  see `docs/TESTING.md` §1b); `npm run e2e` (7 mocked). No `atlas_e2e_*` database is left on the dev PostgreSQL.
- Journeys share one owner: a spec that changes the owner's name, password or reminder default must restore it (J7 does).
- No user time-zone setting exists (ADR-0049); "today" is the browser's zone.
- UX-02 follow-ups: at 1024 px an open note is narrower than before (shell 288 px vs 220 px) until UX-05 collapses
  the sidebar on notes; `Day.tsx` is unrouted (kept for the Today date picker decision); Settings is not in the
  phone bottom nav (it is in the drawer); the status bar re-reads the queue on page change/focus/connectivity only.
- Known limitations carried forward: UI mutations are online-only (R-22); a due time of exactly 23:59 reads as "end
  of day"; no project delete in the UI; Tasks page sorts client-side over the first 500 matches (ADR-0045);
  an occurrence of a repeating series shows its rule read-only (ADR-0046); search matches word prefixes only and the
  task `q` filter / `tasks.project_id` stay unindexed (R-20, ADR-0047); tasks link to notes only at creation
  (ADR-0048); a renamed daily note is not found again; password change signs out all other sessions; backup status
  depends on the API seeing `BACKUP_DIR` and does not re-verify checksums (ADR-0050).
