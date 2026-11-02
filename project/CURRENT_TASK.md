# Current Task

- Task ID: UX-01 (`READY`), then UX-02
- Last completed: MU-08 (`DONE`, 2026-11-02; committed b921945). Local verification only; CI `e2e-real` NOT RUN.
- Milestone: UX — Design system and app shell (docs/ROADMAP.md "UX" section, ADR-0051, evidence in docs/UX_AUDIT.md)

## Goal
Make the UI calm and consistent (neutral Notion-like look, Obsidian/VS Code shell). The full plans for UX-01 (tokens,
base controls, pre-paint theme) and UX-02 (rail, sectioned sidebar, status bar, mobile nav, vendored icons) are in the
roadmap. Owner decisions are in ADR-0051: neutral accent, Day removed from nav, vendored icons, autosave everywhere
(no Save/Ctrl+S; lands with UX-04/UX-05 and its own tests), Source editor default until live preview is verified.

## Open before MU can be declared complete
1. Run the `e2e-real` job on GitHub Actions (never executed there): J1-J7 in CI is an MU exit criterion.
2. Re-score the release table (REQ-005/REQ-006 are still `PARTIAL`) from user-reachable behaviour; needs the owner's review.
3. Optional: fix the pre-existing dev-only `minimatch` advisory (`npm audit --include=dev`, RISKS.md).

## Recommended next task
Ask the owner to choose: (a) close MU (items 1-2 above), then (b) resume calendar with M5-00, which needs real
Google/Microsoft accounts (AR-001) and is blocked until provided. Do not start blocked M5/M6/M8 work without it.

## Notes for the next session
- Verification: `./scripts/verify.sh`; `cd apps/web && npm run test:e2e:real` (17 specs, real API + throwaway DB,
  see `docs/TESTING.md` §1b); `npm run e2e` (7 mocked). A stray `atlas_e2e_uxaudit_caa2ecd8` database exists on the
  dev PostgreSQL; it is not from the harness and was left for the owner.
- Journeys share one owner: a spec that changes the owner's name, password or reminder default must restore it (J7 does).
- No user time-zone setting exists (ADR-0049); "today" is the browser's zone.
- Known limitations carried forward: UI mutations are online-only (R-22); a due time of exactly 23:59 reads as "end
  of day"; no project delete in the UI; Tasks page sorts client-side over the first 500 matches (ADR-0045);
  an occurrence of a repeating series shows its rule read-only (ADR-0046); search matches word prefixes only and the
  task `q` filter / `tasks.project_id` stay unindexed (R-20, ADR-0047); tasks link to notes only at creation
  (ADR-0048); a renamed daily note is not found again; password change signs out all other sessions; backup status
  depends on the API seeing `BACKUP_DIR` and does not re-verify checksums (ADR-0050).
