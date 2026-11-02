# Atlas — Testing Strategy

**Status:** Draft for approval (Milestone 0)
**Last updated:** 2026-10-27

A passing build is not proof of a correct application. This document defines what must be
tested, with what tooling, and how results are reported.

---

## 1. Tooling

| Layer | Tool |
|---|---|
| Backend unit/integration | Pytest |
| Database | Real PostgreSQL (containerised) — not SQLite |
| Frontend unit/component | Vitest + Testing Library |
| End-to-end | Playwright |
| Migrations | Alembic against a clean DB (up and down) |
| Static analysis | Ruff / mypy (backend), ESLint / tsc (frontend) |
| Dependency scanning | Automated advisories in CI |

**Running the backend suite locally.** Integration tests need a real PostgreSQL (not SQLite).
Point `DATABASE_URL` (or `TEST_DATABASE_URL`) at a disposable database; the suite migrates it,
runs, and truncates between tests:

```
DATABASE_URL=postgresql+psycopg://user@127.0.0.1:5432/atlas python -m pytest -q
```

CI uses a `postgres:17-alpine` service container. Any PostgreSQL 14+ instance works.

### 1a. Running the frontend end-to-end suite locally (Playwright — M7-06)

Browser end-to-end tests live in `apps/web/e2e/` and run under **Playwright** (Chromium only). They
drive the **real** UI in a real browser with the HTTP API mocked through Playwright's network
interception, so they need **no live backend** and **no real account** (§8: deterministic and
isolated; §11 of `AGENTS.md`: no real personal/work data).

One-time setup (downloads a pinned Chromium build):

```
cd apps/web
npx playwright install chromium
```

Run the suite — this is a **separate command** and is **not** part of `scripts/verify.sh` (which is a
protected file). `playwright.config.ts` starts a `webServer` that builds the app and serves the
production bundle with `vite preview`, so the suite always exercises the bundled client:

```
cd apps/web
npm run e2e            # → playwright test  (Chromium; e.g. "4 passed")
```

The M7-06 suite (`e2e/sync-failure-modes.spec.ts`) covers three failure modes and drives the real
`/sync` route: **network loss** (a queued edit is kept offline and flushes on reconnect), **restart**
(a queued edit survives a page reload and still syncs) and **stale client / conflict** (a stale-revision
`409` is surfaced and both *Keep mine* / *Take server* actions behave as documented). `e2e/helpers.ts`
holds the API mocks and the durable-queue seeding used to represent an offline edit; the queue itself is
the app's own IndexedDB store. Vitest is configured to ignore `e2e/**` so `npm run test` and the E2E
suite never collide.

### 1b. Real-stack journey harness (Playwright — MU-00)

The mocked suite above cannot prove the product works for its owner. The **real-stack harness** runs
Playwright against the **real FastAPI app** (started from source with `services/api/.venv`) and a
**real PostgreSQL database**, through the real Vite-served UI. Specs live in `apps/web/e2e-real/`; the
config is `apps/web/playwright.real.config.ts` (the mocked specs and `playwright.config.ts` are
unchanged).

Prerequisites: PostgreSQL reachable at `127.0.0.1:5432` as `atlas`/`atlas` (e.g. the Compose `db`
service), `services/api/.venv` with the API installed, and Chromium (`npx playwright install chromium`).

```
cd apps/web
npm run test:e2e:real      # → playwright test -c playwright.real.config.ts
```

Per run, `e2e-real/global-setup.ts`:

1. creates a uniquely named database `atlas_e2e_<random>` (`e2e-real/db_admin.py`, which refuses any
   name not matching `atlas_e2e_*`, so `atlas` / `atlas_test` can never be touched) and migrates it
   with `atlas-migrate`;
2. creates a temporary notes/backup/export directory;
3. starts the API (`uvicorn atlas.main:app`) on a free port and the Vite dev server on another free
   port, with `ATLAS_API_PROXY_TARGET` pointing the proxy at that API (default `localhost:8000`
   unchanged);
4. on teardown (also on a failed start) stops both processes, drops the database and removes the
   temporary directory.

Configuration (optional): `ATLAS_E2E_ADMIN_DATABASE_URL` (default
`postgresql://atlas:atlas@127.0.0.1:5432/postgres`) and `ATLAS_E2E_API_BIN_DIR` (default
`services/api/.venv/bin`). `e2e-real/helpers.ts` creates the owner through the real setup form
(`createOwner`, `signIn`, `signOut`); use `example.com` addresses — `.test` is rejected by the server
(known defect, MU-08). Journeys run serially against one database and one owner; every run starts from
an empty database, so repeated runs do not interfere. CI runs the same command in the `e2e-real` job
of `.github/workflows/ci.yml` (PostgreSQL service). Like the mocked suite it is **not** part of the
protected `scripts/verify.sh`.

Current journeys: `capture-journey.spec.ts` (setup → login → capture "Buy milk" → Inbox → reload);
`j1-capture-and-plan.spec.ts` (J1: capture on Today, plan via the task detail, Upcoming, reload, stale
second-tab conflict, all fields, verbatim validation errors, delete + undo, narrow-screen full page);
`j2-triage-inbox.spec.ts` (J2: five inbox items scheduled / filed / deleted with undo, keyboard driven).
Journeys share one owner: start each with `ensureOwner(page)` (creates the owner or signs in) and use
unique titles, since earlier journeys' tasks stay in the database. `apiCall` (helpers) performs set-up
that has no UI yet (for example creating a project).

## 2. Unit Tests

Cover, at minimum:

- Task state transitions.
- Recurrence calculation (RRULE) and occurrence generation.
- Time-zone conversion and DST transitions.
- Reminder scheduling.
- Permission/authorisation checks.
- Markdown path validation (traversal, symlink policy).
- Revision conflict detection.
- Sync-token/delta handling and cursor advancement.
- Retry, backoff and idempotency logic.

## 3. Integration Tests (real PostgreSQL)

- API ↔ database transactions.
- Database migrations (clean install; representative upgrade).
- Background job persistence across worker restart.
- Task/project relationships.
- Markdown storage operations (atomic write, rename, delete, reconcile).
- Authentication and authorisation.
- Calendar adapter behaviour (mocked provider for determinism).
- Retry processing.
- Backup and restore procedures.

> Mocking providers proves adapter *logic*, not provider *compatibility*. Real-account tests are
> required for calendar milestones (see §5).

## 4. Frontend Tests

- Component behaviour for key flows (capture, edit note, board move).
- Offline queue replay.
- Sync status and conflict surfacing.

## 5. Calendar Adapter Tests

For each provider (Google, Microsoft):

- Pagination.
- Event create/update.
- External deletions.
- Recurring instances and exceptions.
- Time zones and DST transitions.
- OAuth expiry and revocation.
- Expired incremental-sync tokens / invalid delta links.
- Throttling and transient failures.
- Duplicate prevention.
- Conflicting updates.
- Worker restarts mid-sync.

Real-account integration tests use **dedicated test accounts** and isolated test data only.

## 6. End-to-End Scenarios

1. Create a note and retrieve it from another client.
2. Edit the same note concurrently; recover safely from the conflict.
3. Create, schedule and complete a task.
4. Create a project and move a task between board columns.
5. Connect an external calendar and display its events.
6. Change an event externally; observe the update in Atlas.
7. Edit a supported event through Atlas; verify the provider update.
8. Receive and dismiss a due reminder.
9. Restore the application from a backup.
10. Disconnect and reconnect a provider without duplicating events.

## 7. Quality Gates (per milestone)

- All relevant automated tests pass.
- No known critical security issue remains.
- Migrations work on a clean installation.
- Documentation reflects the implementation.
- The working deployment starts reproducibly.
- Limitations are documented.
- No secrets or user data committed.
- Acceptance evidence recorded in `ACCEPTANCE.md`.

Tests are never disabled or weakened to make a milestone pass.

## 8. Determinism and Isolation

- Tests are deterministic, isolated and safe to run repeatedly.
- No real personal or workplace data in tests.
- Fixtures create and tear down their own state.
- Time-dependent tests inject a clock; they do not sleep on wall-clock time.

## 9. Result Reporting Vocabulary

- `PASS` — command ran and relevant checks passed.
- `FAIL` — check ran and failed.
- `BLOCKED` — could not run (documented dependency/environment issue).
- `NOT RUN` — not attempted.

Report the actual command and a concise evidence line for release gates. Never invent results.
