# Atlas — Testing Strategy

**Status:** Draft for approval (Milestone 0)
**Last updated:** 2026-10-20

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
