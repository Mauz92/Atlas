# Changelog

All notable, user-visible changes to Atlas are recorded here.
Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This project aims to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **Milestone 2 — Markdown notes.**
  - Notes are real Markdown files under the configured notes root: create, edit, rename, move and
    delete (deletions move to a recoverable trash folder, never `rm`).
  - Revision-aware API: every note carries a revision; a stale write or an external file change is
    rejected with `409` and never overwrites. Conflicting versions can be kept as `(conflict …)`
    copies.
  - Folder navigation with create/rename/delete; renaming a folder or note keeps note identity,
    wiki links and backlinks intact.
  - Full-text search over note titles and content (PostgreSQL FTS).
  - Tags, `[[wiki links]]`, backlinks and unresolved-link reporting.
  - External-file reconciliation: a worker job scans the notes root and re-indexes changes
    (default every 5 minutes), plus a manual `POST /api/notes/reconcile`.
  - Notes UI: folder tree, Markdown source editor (CodeMirror) with rendered preview, search,
    links/backlinks panel and inline conflict resolution. The editor bundle is lazy-loaded.
- **Milestone 1 — foundation and secure deployment (partial).**
  - Backend: FastAPI application with structured JSON logging (secret-redacting), `/health` and
    `/health/ready` endpoints, and security headers.
  - Authentication: first-run account setup, login/logout, Argon2id password hashing, server-side
    sessions, CSRF protection and auth rate limiting.
  - Database: SQLAlchemy models and the initial Alembic migration for users, sessions and jobs.
  - Durable PostgreSQL job queue (enqueue / claim / retry-with-backoff / complete) and a worker
    process.
  - Web client: React + TypeScript shell with navigation, light/dark theme, first-run setup and
    login, gated behind authentication; API types generated from the OpenAPI schema.
  - Deployment: Docker Compose for `web`, `api`, `worker` and `db` with persistent volumes.
  - CI: documentation/hygiene checks plus backend (ruff, mypy, pytest) and frontend
    (eslint, tsc, vitest, build) jobs.
- **Milestone 0 — project documentation.** Product specification, architecture, data model,
  decision records, risk register, roadmap/backlog, security, testing, Markdown storage, calendar
  synchronisation, deployment, operations, dependencies and acceptance record.

### Changed
- Nothing yet.

### Fixed
- **Developer/CI:** the frontend component tests now run under `NODE_ENV=test`. An inherited
  `NODE_ENV=production` previously made React 19 resolve its production build (which has no
  `act`), so every `render()` failed with `TypeError: React.act is not a function`; the vitest
  config now pins the test environment (`apps/web/vite.config.ts`). No tests were weakened.
- **Security:** structured logging now redacts sensitive top-level fields (`password`,
  `refresh_token`, `authorization`, …) — previously only nested values were redacted.
- **Security:** login rejects unknown accounts with the same cost and response as a wrong
  password, removing a user-enumeration timing side channel.
- **Security:** upgraded `vitest` and `pytest` to versions without known advisories; `npm audit`
  and `pip-audit` are now enforced in CI.
- **Security:** interactive API docs are disabled in production; API responses are sent with
  `Cache-Control: no-store`; an optional `ALLOWED_HOSTS` allow-list is available.
- `atlas-migrate` now resolves `alembic.ini` in both editable and installed layouts, so the
  containerised API applies migrations on startup.
- The background worker survives transient database errors (for example, starting before the
  schema exists) instead of exiting, and starts only after the API is healthy.
- The generated OpenAPI type file (`apps/web/src/api/schema.d.ts`) is now committed; a clean
  checkout and the web container build previously failed with `TS2307`. CI checks it stays in
  sync with the API.

### Removed
- Nothing yet.

<!--
Notes and tasks are not yet implemented; this changelog tracks user-visible behaviour.
Do not list planned features here.
-->
