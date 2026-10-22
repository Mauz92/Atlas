# Current Task

- Task ID: SUP-001
- Status: DONE

## Goal
Make the frontend test suite pass: `cd apps/web && npm run test` currently fails with
`TypeError: React.act is not a function` in the component tests (React 19 / Testing Library).

## Plan
1. Reproduce: `cd apps/web && npm run test`.
2. Diagnose the React 19 `act` incompatibility in the vitest/jsdom setup.
3. Apply a minimal fix. Do NOT delete, skip or weaken tests, and keep assertion coverage.
4. Confirm all component tests pass, not just that the command exits 0.

## Acceptance
- `cd apps/web && npm run test` exits 0 with every test passing.
- No tests removed, skipped or weakened; the failing tests now pass for a real reason.

## Root cause
The test environment inherited `NODE_ENV=production` (set by the runner shell). Vitest only
defaults `NODE_ENV` to `test` when it is **unset**, so `NODE_ENV` stayed `production`. React 19
resolves its *production* build in that case, and `react.production.js` does **not** export
`act` (only `react.development.js` does). `@testing-library/react`'s `act-compat` therefore
fell back to the deprecated `react-dom/test-utils` shim and threw `React.act is not a function`
on every `render()`/`cleanup()`.

## Fix
- `apps/web/vite.config.ts`: pin `test.env = { NODE_ENV: "test" }` so the vitest run is immune
  to an inherited production `NODE_ENV`. Config-only, cross-platform, and scoped to tests
  (`npm run build` is unaffected).
- `apps/web/src/test/environment.test.tsx` (new): regression guard asserting `act` is callable
  and a component renders under `act`, so a future `NODE_ENV` regression fails with a clear
  diagnostic instead of the cryptic upstream error.

## Evidence
- Before: `cd apps/web && npm run test` → `7 failed | 3 failed files`, `TypeError: React.act is
  not a function` (react-dom-test-utils.production.js → act-compat.js).
- Diagnostic: `NODE_ENV=production` in the env; `typeof React.act === "undefined"`; React 19.3.1.
- After: `cd apps/web && npm run test` → `Test Files 4 passed (4)`, `Tests 8 passed (8)`.
- Robustness: `env -u NODE_ENV npm run test` (CI-like) → `8 passed`.
- Failure path proven: with the `env` line temporarily removed, the new guard fails
  (`React.act is not a function`); restored, it passes.
- Gates: `npm run lint` clean, `npm run typecheck` clean, `npm run build` succeeds.
- No tests were deleted, skipped (`it.skip`/`test.skip`), or weakened; assertions unchanged.

## Limitations / handoff
- `scripts/verify.sh` is a trusted/protected file and was not modified. It still runs only
  lint/typecheck for the frontend. Now that the vitest suite is green, the maintainer may wire
  `npm run test` into `verify.sh` (its own comment asks for exactly this).

## Next task
- **M3-01 — Task schema + migration** (depends on M1-04, which is `DONE`): fields per
  `DATA_MODEL.md` §2.3, with a migration test. First task of Milestone 3 (`BACKLOG`).
