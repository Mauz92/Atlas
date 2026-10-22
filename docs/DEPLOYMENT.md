# Atlas — Deployment

**Status:** Draft for approval (Milestone 0)
**Last updated:** 2026-10-20

Target: a personal self-hosted server using Docker Compose with a small number of services.

---

## 1. Services

| Service | Role | Exposed |
|---|---|---|
| `web` | Serves built frontend assets | via reverse proxy |
| `api` | FastAPI application | via reverse proxy (HTTPS) |
| `worker` | Background sync, retries, reminders | no |
| `db` | PostgreSQL | private network only |

An optional reverse proxy is expected to be provided by existing infrastructure.

## 2. Volumes

| Volume | Contents |
|---|---|
| `atlas-db` | PostgreSQL data directory |
| `atlas-notes` | Markdown notes root (`/data/atlas/notes`) |
| `atlas-backups` | Backup artifacts |

Both the database and the notes volume are required for a complete restore. Neither alone is
sufficient.

## 3. Configuration

- All configuration via environment variables; `.env.example` lists every variable with
  placeholders. Real `.env` is git-ignored.
- Required variables (indicative): `DATABASE_URL`, `SECRET_KEY`, `SESSION_SECRET`,
  `TOKEN_ENCRYPTION_KEY`, `NOTES_ROOT`, `PUBLIC_BASE_URL`, `GOOGLE_CLIENT_ID`,
  `GOOGLE_CLIENT_SECRET`, `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`, `MICROSOFT_TENANT`.
- Optional Compose overrides: `WEB_PORT` (host port for the web UI, default `8080`),
  `POSTGRES_USER`/`POSTGRES_PASSWORD`/`POSTGRES_DB` (default `atlas`).
- Secrets are provided by the operator, never committed.

## 4. Installation (outline — finalised in M1)

1. Install Docker + Compose.
2. Clone the repository; copy `.env.example` to `.env`; fill required values; generate secrets.
3. Run database migrations.
4. `docker compose up -d`; verify health checks.
5. Configure the reverse proxy for HTTPS and OAuth callback URLs.
6. Create the first user / complete initial setup.

A clean installation must succeed by following these instructions verbatim.

## 5. Health Checks

- `api`: HTTP health endpoint returning service + DB reachability.
- `db`: `pg_isready`.
- `worker`: reports liveness (job loop running).

## 6. Upgrades

- Pull the new version; take a backup first; run migrations; restart services.
- Migrations are versioned (Alembic) and must run on a clean DB and upgrade from the previous
  supported version. Destructive migrations require an identified rollback/backup strategy.
- Never apply an irreversible migration without a recovery plan.

## 7. Rollback

- Application rollback: redeploy the previous image tag.
- Database rollback: restore from the pre-upgrade backup when a migration is not reversible.
- Documented per release in `CHANGELOG.md`/`OPERATIONS.md` when relevant.

## 8. Reverse Proxy and TLS

- Terminate TLS at the proxy; forward to `api`/`web` on the internal network.
- Documented example configuration, including OAuth redirect URIs and any push webhook paths.
- Do not expose `db` or `worker`. Do not expose the app over plain HTTP for remote access.

## 9. Logging

- Structured (JSON) logs from `api` and `worker`.
- No secrets, tokens or note content in logs.
- Log retention and rotation documented in `OPERATIONS.md`.

## 10. Non-Goals

- No Kubernetes, no Docker-in-Docker, no external message broker.
- No dependency on a developer workstation.
