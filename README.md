<p align="center">
  <img src="docs/assets/banner.png" alt="Atlas: notes, tasks, projects and calendars, on a server you own" width="100%">
</p>

<p align="center">
  <strong>A self-hosted workspace for Markdown notes, tasks, projects and calendars.</strong><br>
  Your data stays on your server, your notes stay plain <code>.md</code> files.
</p>

<p align="center">
  <img alt="status" src="https://img.shields.io/badge/status-0.1.0%20pre--release-orange">
  <img alt="backend" src="https://img.shields.io/badge/API-FastAPI%20%2B%20PostgreSQL-2563eb">
  <img alt="clients" src="https://img.shields.io/badge/clients-web%20%C2%B7%20Linux%20%C2%B7%20Android-2563eb">
  <img alt="licence" src="https://img.shields.io/badge/licence-MIT-green">
  <img alt="deploy" src="https://img.shields.io/badge/deploy-Docker%20Compose-2563eb">
</p>

> **Status: `0.1.0` pre-release, for private use.** Atlas is built for your own devices on a private network
> (for example a tailnet). It has had careful review but **no independent security audit**, so do not expose it to
> the open internet without reading [`docs/SECURITY.md`](docs/SECURITY.md) and [`docs/RELEASE.md`](docs/RELEASE.md).

## Screenshots

<table>
  <tr>
    <td width="50%"><img src="docs/assets/screenshots/today.png" alt="Today view with tasks due today"><br><sub><b>Today</b>: what is due, scheduled and overdue.</sub></td>
    <td width="50%"><img src="docs/assets/screenshots/board.png" alt="Kanban board for a project"><br><sub><b>Projects</b>: a board with progress derived from the tasks.</sub></td>
  </tr>
  <tr>
    <td><img src="docs/assets/screenshots/notes.png" alt="Markdown note in the live editor"><br><sub><b>Notes</b>: plain Markdown with a live preview.</sub></td>
    <td><img src="docs/assets/screenshots/today-dark.png" alt="Today view in dark mode"><br><sub><b>Dark mode</b>, following your system.</sub></td>
  </tr>
</table>

<sub>Screenshots use made-up demo data.</sub>

## What you get

<table>
  <tr>
    <td width="80" align="center"><img src="docs/assets/icons/notes.svg" width="40" alt=""></td>
    <td><strong>Markdown notes.</strong> Real <code>.md</code> files in a folder you control, readable and editable without Atlas. Wiki links, a live preview that sanitises untrusted content, conflict copies instead of silent overwrites.</td>
  </tr>
  <tr>
    <td align="center"><img src="docs/assets/icons/tasks.svg" width="40" alt=""></td>
    <td><strong>Tasks.</strong> Inbox, Today and Upcoming, priorities, due dates, recurrence, subtasks, and Day/Week planning. A due date and a scheduled work block are separate things.</td>
  </tr>
  <tr>
    <td align="center"><img src="docs/assets/icons/projects.svg" width="40" alt=""></td>
    <td><strong>Projects and boards.</strong> Lists and a Kanban board, with progress derived from the tasks (the calculation is documented).</td>
  </tr>
  <tr>
    <td align="center"><img src="docs/assets/icons/calendar.svg" width="40" alt=""></td>
    <td><strong>Calendars (read-only).</strong> Add secret ICS links (Proton and others) or import an <code>.ics</code> file, then see everything in one Day, Week, Month or Agenda view. Google and Microsoft API sync is deferred ([ADR-0076](docs/DECISIONS.md)).</td>
  </tr>
  <tr>
    <td align="center"><img src="docs/assets/icons/sync.svg" width="40" alt=""></td>
    <td><strong>Sync across devices.</strong> Revision-aware and offline-capable. When two devices change the same thing you see both versions and choose; nothing is lost silently, and many changes can be undone.</td>
  </tr>
  <tr>
    <td align="center"><img src="docs/assets/icons/self-hosted.svg" width="40" alt=""></td>
    <td><strong>Self-hosted and low-maintenance.</strong> One Docker Compose stack, daily verified backups, one-click export, and an in-app update with automatic rollback.</td>
  </tr>
</table>

### What works today

| Area | State |
|---|---|
| Notes, tasks, projects, planning | Available and verified |
| Cross-device sync and offline, conflict screens | Available and verified |
| Reminders (web push, Linux desktop, Android) | Available; tested on Linux and one Android phone |
| Linux desktop app (AppImage, `.deb`) | Available |
| Android app (signed APK you install yourself) | Available |
| ICS calendar links and import, unified calendar views | Available (read-only); a real Proton link is still unverified |
| Backups, restore, export, upgrade and rollback | Available (the in-app updater has not yet run on a live server) |
| Google / Microsoft calendar sync, calendar editing | Not available (deferred) |
| Windows, macOS, iOS | Not available |

The authoritative status and the full list of known limitations are in [`docs/RELEASE.md`](docs/RELEASE.md) and
[`docs/ROADMAP.md`](docs/ROADMAP.md).

## How it fits together

<p align="center">
  <img src="docs/assets/architecture.svg" alt="Architecture: clients talk to nginx and the API; the worker and API share PostgreSQL and the Markdown notes folder" width="900">
</p>

Ownership is explicit so nothing has two sources of truth: **Markdown files** own note content, **PostgreSQL** owns
tasks, projects and sync state, and a calendar provider owns its own events. More in
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) and [`docs/DATA_MODEL.md`](docs/DATA_MODEL.md).

## Quick start

Requires Docker with Compose.

```bash
git clone https://github.com/Mauz92/atlas.git && cd atlas
cp .env.example .env
```

Edit `.env` and set real, random values for `SECRET_KEY`, `SESSION_SECRET`, `TOKEN_ENCRYPTION_KEY` and
`POSTGRES_PASSWORD` (for example `openssl rand -hex 32`). The production setting refuses to start with placeholders.
Then:

```bash
docker compose -p atlas --env-file .env -f deploy/docker-compose.yml up --build -d
```

Open `http://127.0.0.1:8080` and create the owner account; a one-time recovery code is shown at setup. The web
container binds to localhost by default: add HTTPS with `tailscale serve` or a reverse proxy before using it from
other devices. Full instructions, TLS, backups and updates are in
[`docs/OPERATOR_GUIDE.md`](docs/OPERATOR_GUIDE.md) and [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md); to use the app, see
[`docs/USER_GUIDE.md`](docs/USER_GUIDE.md).

## Built with

React + TypeScript (web/PWA) · Python + FastAPI · PostgreSQL with SQLAlchemy and Alembic · a PostgreSQL-backed durable
job queue · Tauri 2 (Linux desktop and Android) · Docker Compose. Rationale and trade-offs are in
[`docs/DECISIONS.md`](docs/DECISIONS.md).

## Repository layout

```
apps/web         React/PWA client
apps/desktop     Tauri 2 shell for Linux and Android (own Cargo workspace; see apps/desktop/README.md)
apps/mobile      Earlier React Native plan, superseded by the Tauri shell (ADR-0068)
services/api     FastAPI application
services/worker  Background jobs, reminders, backups, calendar polling
packages/*       Shared types and API client; framework-free sync, reminder and desktop cores
tests/*          Unit, integration and end-to-end tests
deploy/          Docker Compose files, nginx/TLS config, host updater
docs/            Living project documentation (and docs/assets for the images above)
```

## Development

**Backend** (`services/api`): Python 3.12+ (3.13 is the runtime) and PostgreSQL 14+.

```bash
cd services/api
python -m venv .venv && .venv/bin/pip install -e ".[dev]"
export DATABASE_URL="postgresql+psycopg://atlas:atlas@localhost:5432/atlas"
.venv/bin/atlas-migrate                 # apply migrations
.venv/bin/uvicorn atlas.main:app --reload
.venv/bin/atlas-worker                  # background worker (separate process)
.venv/bin/python -m pytest -q           # tests (need PostgreSQL)
```

**Frontend** (`apps/web`): Node 22+.

```bash
cd apps/web
npm install
npm run dev            # dev server on :5173, proxies /api to :8000
npm run gen:api        # regenerate API types from the backend OpenAPI schema
```

`scripts/verify.sh` runs the whole gate (lint, types, tests). Contribution rules are in
[`CONTRIBUTING.md`](CONTRIBUTING.md).

## Documentation

| | |
|---|---|
| **Use it** | [User guide](docs/USER_GUIDE.md) |
| **Run it** | [Operator guide](docs/OPERATOR_GUIDE.md) · [Deployment](docs/DEPLOYMENT.md) · [Operations and backups](docs/OPERATIONS.md) |
| **Understand it** | [Product spec](docs/PRODUCT_SPEC.md) · [Architecture](docs/ARCHITECTURE.md) · [Data model](docs/DATA_MODEL.md) · [Sync protocol](docs/SYNC_PROTOCOL.md) · [Markdown storage](docs/MARKDOWN_STORAGE.md) · [Calendar sync](docs/CALENDAR_SYNC.md) |
| **Trust it** | [Security](docs/SECURITY.md) · [Testing](docs/TESTING.md) · [Acceptance evidence](docs/ACCEPTANCE.md) · [Risks](docs/RISKS.md) |
| **Follow it** | [Roadmap](docs/ROADMAP.md) · [Decisions](docs/DECISIONS.md) · [Release status](docs/RELEASE.md) · [Changelog](docs/CHANGELOG.md) · [Dependencies](docs/DEPENDENCIES.md) |

## Security

Atlas treats note content as untrusted, encrypts stored provider tokens at rest, hashes passwords with Argon2id, and
guards outbound calendar fetches against SSRF. The threat model and controls are in [`docs/SECURITY.md`](docs/SECURITY.md).
Please report vulnerabilities privately through the repository's **Security** tab rather than a public issue.

## Licence

Atlas is released under the [MIT Licence](LICENSE): you may use, copy, modify and distribute it, including for work, as
long as the copyright notice is kept. It comes with no warranty. Third-party dependencies keep their own licences,
inventoried in [`docs/DEPENDENCIES.md`](docs/DEPENDENCIES.md) (none of them is GPL or AGPL). iOS push delivery would carry a
platform cost (Apple Developer Program); see [`docs/PRODUCT_SPEC.md`](docs/PRODUCT_SPEC.md) §3.1.
