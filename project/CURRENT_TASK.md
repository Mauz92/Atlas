# Current Task

- Task ID: UX-02 (`READY`) — App shell: rail, sectioned sidebar, status bar, mobile bottom nav, vendored icons
- Last completed: UX-01 (`DONE`, 2026-11-02, local verification; not committed at the time of writing). Design
  tokens with the neutral accent, System/Light/Dark theme with a pre-paint script (`public/theme-init.js`), base
  controls, one `.pill`, tokenised CodeMirror theme. Evidence: `docs/ACCEPTANCE.md` UX-01.
- Before that: MU-08 (`DONE`, committed b921945). CI `e2e-real` NOT RUN.
- Milestone: UX — Design system and app shell (docs/ROADMAP.md "UX" section, ADR-0051, evidence in docs/UX_AUDIT.md)

## Goal
Make the UI calm and consistent (neutral Notion-like look, Obsidian/VS Code shell). UX-02's plan is in the
roadmap (rail with Today, Inbox, Tasks, Projects, Notes + Settings; `NAV_SECTIONS` shared with the palette;
Ctrl+B collapse; status bar from `useSyncStatus`/offline queue; mobile bottom nav and drawer; topbar removed;
old URLs keep resolving, `/day` redirects to Today; vendored Lucide icons with the ISC notice). Owner decisions
are in ADR-0051: neutral accent, Day removed from nav, vendored icons, autosave everywhere (UX-04/UX-05 with its
own tests), Source editor default until live preview is verified.

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
UX-02 (app shell). Separately the owner may still choose to close MU (items 1-2 above) or resume calendar with
M5-00, which needs real Google/Microsoft accounts (AR-001) and is blocked until provided.

## Notes for the next session
- Verification: `./scripts/verify.sh`; `cd apps/web && npm run test:e2e:real` (19 specs, real API + throwaway DB,
  see `docs/TESTING.md` §1b); `npm run e2e` (7 mocked). No `atlas_e2e_*` database is left on the dev PostgreSQL.
- Journeys share one owner: a spec that changes the owner's name, password or reminder default must restore it (J7 does).
- No user time-zone setting exists (ADR-0049); "today" is the browser's zone.
- Known limitations carried forward: UI mutations are online-only (R-22); a due time of exactly 23:59 reads as "end
  of day"; no project delete in the UI; Tasks page sorts client-side over the first 500 matches (ADR-0045);
  an occurrence of a repeating series shows its rule read-only (ADR-0046); search matches word prefixes only and the
  task `q` filter / `tasks.project_id` stay unindexed (R-20, ADR-0047); tasks link to notes only at creation
  (ADR-0048); a renamed daily note is not found again; password change signs out all other sessions; backup status
  depends on the API seeing `BACKUP_DIR` and does not re-verify checksums (ADR-0050).
