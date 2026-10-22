# Atlas

**A self-hosted, cross-platform productivity workspace.**

Atlas unifies Markdown knowledge management, task planning, project/Kanban management and
Google/Microsoft calendar synchronisation in one coherent, self-hosted application.

> **Status: Milestone 1 — foundation and secure deployment (in progress).**
> The backend (FastAPI + PostgreSQL), authentication, durable job queue, a React web shell and a
> Docker Compose deployment exist and are covered by tests. Notes, tasks and calendar features are
> not implemented yet. A containerised end-to-end startup has not been verified in every
> environment — see `docs/ACCEPTANCE.md`.

---

## What Atlas aims to be

- **Markdown-native notes** — real `.md` files you can read and edit without Atlas.
- **Task management** — inbox, priorities, due dates, recurrence, subtasks.
- **Projects and boards** — lists, Kanban, derived progress, project notes.
- **Unified calendar** — Google Calendar and Microsoft Outlook aggregated in one view,
  then bidirectional editing once sync is proven reliable.
- **Cross-device sync** — revision-aware, recoverable, no silent data loss.
- **Self-hosted and low-maintenance** — one Docker Compose deployment.

Full requirements: [`docs/PRODUCT_SPEC.md`](docs/PRODUCT_SPEC.md).

## Documentation

| Document | Purpose |
|---|---|
| [`docs/PRODUCT_SPEC.md`](docs/PRODUCT_SPEC.md) | Approved requirements and boundaries |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | System boundaries, components, data ownership |
| [`docs/DATA_MODEL.md`](docs/DATA_MODEL.md) | Persistent entities and sync semantics |
| [`docs/DECISIONS.md`](docs/DECISIONS.md) | Architectural decision records |
| [`docs/RISKS.md`](docs/RISKS.md) | Risk register and mitigations |
| [`docs/ROADMAP.md`](docs/ROADMAP.md) | Milestones, backlog, acceptance criteria |
| [`docs/SECURITY.md`](docs/SECURITY.md) | Threat model and controls |
| [`docs/TESTING.md`](docs/TESTING.md) | Test strategy and quality gates |
| [`docs/MARKDOWN_STORAGE.md`](docs/MARKDOWN_STORAGE.md) | Markdown storage and integrity |
| [`docs/CALENDAR_SYNC.md`](docs/CALENDAR_SYNC.md) | Calendar integration semantics |
| [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) | Installation, upgrades, operations |
| [`docs/OPERATIONS.md`](docs/OPERATIONS.md) | Backups, recovery, monitoring |
| [`docs/ACCEPTANCE.md`](docs/ACCEPTANCE.md) | Verification evidence per gate |
| [`docs/CHANGELOG.md`](docs/CHANGELOG.md) | User-visible changes |
| [`AGENTS.md`](AGENTS.md) | Operating instructions for the coding agent |

## Proposed technology stack

React + TypeScript (web/PWA) · Python + FastAPI (API) · PostgreSQL + SQLAlchemy/Alembic ·
PostgreSQL-backed durable job queue · Docker Compose deployment · React Native + Expo (mobile,
later). Rationale and trade-offs: `docs/DECISIONS.md`.

## Repository layout

```
apps/web         React/PWA client
apps/mobile      React Native + Expo client (later milestone)
services/api     FastAPI application
services/worker  Background sync, retries, reminders
packages/*       Shared types and generated API client
tests/*          unit / integration / e2e
deploy/          Docker Compose and examples
docs/            Living project documentation
```

## Development

**Backend** (`services/api`) — requires Python 3.12+ and a PostgreSQL instance (14+):

```bash
cd services/api
python -m venv .venv && .venv/bin/pip install -e ".[dev]"
export DATABASE_URL="postgresql+psycopg://atlas:atlas@localhost:5432/atlas"
.venv/bin/atlas-migrate                 # apply migrations
.venv/bin/uvicorn atlas.main:app --reload
.venv/bin/atlas-worker                  # background worker (separate process)
.venv/bin/python -m pytest -q           # tests (needs PostgreSQL)
```

**Frontend** (`apps/web`) — requires Node 22+:

```bash
cd apps/web
npm install
npm run dev            # dev server on :5173, proxies /api to :8000
npm run gen:api        # regenerate API types from the backend OpenAPI schema
```

**Full stack** — Docker Compose (`deploy/`):

```bash
cp .env.example .env    # fill in real secrets before production
docker compose -f deploy/docker-compose.yml up --build
```

## Licence and usage

Licensing of the application and all dependencies must permit the intended personal and
professional use (REQ-003). A dependency/licence inventory is maintained from Milestone 1
(`docs/DECISIONS.md`, task M1-10). iOS push delivery carries a platform cost (Apple Developer
Program); see `docs/PRODUCT_SPEC.md` §3.1.
