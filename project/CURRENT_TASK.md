# Current Task

- Task ID: SUP-001
- Status: READY

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

## Evidence
Pending.
