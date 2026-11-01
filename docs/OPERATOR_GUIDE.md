# Atlas — Operator Guide

**Status:** Delivered-feature operator handbook
**Last updated:** 2026-10-27
**Audience:** the person *running* an Atlas instance (installing, configuring, securing, backing up,
restoring, upgrading, monitoring, troubleshooting).

This guide is a **task-oriented navigator**. The authoritative content stays in the canonical
documents and this guide links to them rather than forking them:

| Topic | Canonical document |
|---|---|
| Install, services, upgrades and rollback | [`DEPLOYMENT.md`](DEPLOYMENT.md) |
| Backups, restore, monitoring, maintenance, recovery | [`OPERATIONS.md`](OPERATIONS.md) |
| Threat model and security controls | [`SECURITY.md`](SECURITY.md) |
| Environment template (the full variable list) | [`.env.example`](../.env.example) |
| End-user behaviour | [`USER_GUIDE.md`](USER_GUIDE.md) |
| Test strategy and how to run the suite | [`TESTING.md`](TESTING.md) |

> **Read this before you promise a feature.** Atlas is delivered milestone by milestone. Several
> user-facing areas are **not yet available** (calendar accounts, mobile apps, real push delivery).
> See [§10 What is not delivered yet](#10-what-is-not-delivered-yet) and [`ROADMAP.md`](ROADMAP.md).

---

## 1. What you are deploying

Atlas runs as a small Docker Compose stack (one modular monolith plus supporting services):

| Service | Role | Exposed |
|---|---|---|
| `web` | Serves the built frontend | via your reverse proxy (`WEB_PORT`, default `8080`) |
| `api` | FastAPI application (runs migrations on start) | via your reverse proxy (HTTPS); also published on `8000` |
| `worker` | Background jobs: sync, reminders, reconciliation, change-feed purge, backups | **no** port |
| `db` | PostgreSQL | **loopback only** (`127.0.0.1:5432`) |

Three named volumes hold all durable state: `atlas-db` (PostgreSQL), `atlas-notes` (your Markdown
root at `/data/atlas/notes`), `atlas-backups` (backup sets at `/data/atlas/backups`). **Both** the
database and the notes volume are required for a complete restore
([`DEPLOYMENT.md`](DEPLOYMENT.md) §2, [`OPERATIONS.md`](OPERATIONS.md) §1).

---

## 2. Prerequisites

- Docker Engine + Compose v2.
- A host reachable over HTTPS, with a reverse proxy you control (TLS terminates at the proxy).
- Enough disk for PostgreSQL, your notes and backup sets (keep backups off the primary volume).
- To run the test suite locally: Python 3.12+ (the repo is developed against the toolchain pinned in
  `services/api/pyproject.toml`) and Node 22+ — see [`TESTING.md`](TESTING.md).

---

## 3. Install

The step-by-step install is [`DEPLOYMENT.md`](DEPLOYMENT.md) §4; in short:

```bash
git clone <your-atlas-checkout>
cd Atlas
cp .env.example .env          # then fill in real secrets (see §4)
docker compose -f deploy/docker-compose.yml up -d --build
docker compose -f deploy/docker-compose.yml ps          # all services Up / healthy
curl -fsS http://localhost:8000/health/ready            # {"status":"ready","database":"ok"}
```

Then open the app through your proxy and complete **first-run setup**: the first account you create
is the owner (see [`USER_GUIDE.md`](USER_GUIDE.md) §2). The `api` service runs `atlas-migrate` (=
`alembic upgrade head`) on start, so a clean install migrates itself.

> A clean install start was verified in [`DEPLOYMENT.md`](DEPLOYMENT.md) §4 / [`ACCEPTANCE.md`](ACCEPTANCE.md)
> (M1 gate); the upgrade path is executed and recorded in [`ACCEPTANCE.md`](ACCEPTANCE.md) (M9-06).

---

## 4. Configuration

All configuration is environment-driven. `.env.example` is the **canonical, complete** list; the
reference below says what the key variables do. Real secrets live only in `.env` (git-ignored) or
your secret manager — never in the repository.

### 4.1 Core

| Variable | Purpose |
|---|---|
| `ATLAS_ENV` | `development` or `production`. Production enables secure cookies and HSTS and disables interactive API docs. |
| `PUBLIC_BASE_URL` | Public HTTPS base URL (OAuth callbacks, links). |
| `ALLOWED_HOSTS` | Optional comma-separated Host allow-list (recommended in production). |

### 4.2 Secrets and keys

| Variable | Purpose |
|---|---|
| `SECRET_KEY` | App signing secret. Generate with `openssl rand -hex 32`. |
| `SESSION_SECRET` | Session signing secret. Generate with `openssl rand -hex 32`. |
| `TOKEN_ENCRYPTION_KEY` | Encrypts stored OAuth credentials at rest. **Back this up separately.** Generate with `openssl rand -base64 32`. Required in production. |
| `TOKEN_ENCRYPTION_KEY_ID` | Identifier recorded with each credential (default `v1`), so keys can be rotated. |
| `TOKEN_ENCRYPTION_PREVIOUS_KEYS` | Optional JSON map of retired keys (`{"v1":"<key>"}`) that may still decrypt older rows during a rotation. |

In production, placeholder values (`change-me`, the dev default, empty) are **rejected at startup**
(`services/api/atlas/config.py::Settings.validate_for_runtime`) — a container that refuses to start
with a placeholder secret is working as designed.

**Token-encryption key rotation.** Bump `TOKEN_ENCRYPTION_KEY_ID` (e.g. to `v2`), set the new
`TOKEN_ENCRYPTION_KEY`, and move the previous key into `TOKEN_ENCRYPTION_PREVIOUS_KEYS` until every
credential row has been re-encrypted. There is no automatic re-encryption job yet — a row is re-sealed
on its next write ([`SECURITY.md`](SECURITY.md) R-SEC-3).

### 4.3 Database, notes and sync

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | PostgreSQL DSN (e.g. `postgresql+psycopg://atlas:…@db:5432/atlas`). |
| `NOTES_ROOT` | Absolute path to the Markdown notes root (in the container: `/data/atlas/notes`). |
| `NOTES_RECONCILE_SECONDS` | How often the worker re-scans the notes root (default `300`). |
| `CHANGE_RETENTION_DAYS` | How far back the per-user change feed keeps deletion history (default `30`); a device older than this is told to full-resync. **It never purges your task/project/note rows.** |
| `CHANGE_PURGE_INTERVAL_SECONDS` | How often the purge job runs (default `3600`). |
| `BACKUP_DIR` / `BACKUP_RETAIN` | Where backup sets go and how many to keep (defaults `/data/atlas/backups`, `7`). |
| `BACKUP_INTERVAL_SECONDS` | How often the worker produces a backup (default `86400` = daily). |
| `BACKUP_PG_DUMP_BINARY` / `BACKUP_PG_DUMP_CONTAINER` | `pg_dump` location: a local client, or a container name to run it inside with `docker exec`. |
| `EXPORT_DIR` | Destination for the operator `atlas-export` CLI (default `./data/exports`). Not used by `GET /api/export`. |

### 4.4 Notifications — Web Push (VAPID keys)

Web Push is **off unless all three VAPID values are set**; when any is missing the feature is
disabled cleanly and reminders fall back to the server log (no crash). The full procedure lives in
[`DEPLOYMENT.md`](DEPLOYMENT.md) §3.1 "Web Push (VAPID keys)"; the short version:

```bash
# Generate a key pair once (py-vapid ships with the API's pywebpush dependency).
# Run inside the API image/venv: docker compose ... exec api python - <<'PY' ... PY
python - <<'PY'
import base64
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat
from py_vapid import Vapid

v = Vapid(); v.generate_keys()
priv = base64.urlsafe_b64encode(
    v.private_key.private_numbers().private_value.to_bytes(32, "big")).decode().rstrip("=")
pub = base64.urlsafe_b64encode(
    v.public_key.public_bytes(Encoding.X962, PublicFormat.UncompressedPoint)).decode().rstrip("=")
print("VAPID_PRIVATE_KEY=" + priv)   # secret -> VAPID_PRIVATE_KEY
print("VAPID_PUBLIC_KEY=" + pub)     # public -> VAPID_PUBLIC_KEY
PY
```

Set:

| Variable | Purpose |
|---|---|
| `VAPID_PUBLIC_KEY` | Handed to the browser (safe to expose); a user's consent page reads it. |
| `VAPID_PRIVATE_KEY` | **Secret** — signs each push; never commit, bundle or log it. |
| `VAPID_SUBJECT` | A `mailto:` or `https:` contact for the push service (RFC 8292). |

The signing key never leaves the server; a destination the push service reports as gone (`404`/`410`)
is disabled and never retried.

### 4.5 Calendar providers (not yet user-facing)

`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`, `MICROSOFT_CLIENT_ID`,
`MICROSOFT_CLIENT_SECRET`, `MICROSOFT_TENANT`, `MICROSOFT_REDIRECT_URI` are read for the calendar
integration. **The account-connection UI is not delivered**, so setting these does not yet enable a
user-visible feature ([§10](#10-what-is-not-delivered-yet)).

### 4.6 Passing settings into the containers

The shipped `deploy/docker-compose.yml` forwards every setting the API and worker read, with the
defaults from `.env.example`: core secrets, `DATABASE_URL`, `NOTES_ROOT`, `BACKUP_*`, `EXPORT_DIR`,
`CHANGE_*`, `ALLOWED_HOSTS`, `VAPID_*`, `TOKEN_ENCRYPTION_KEY_ID` and the scheduler intervals. It does
**not** forward `GOOGLE_*`/`MICROSOFT_*`/`FCM_*`/`EXPO_*`: the application does not read them yet
(calendar adapters are blocked on M5-00). When you add a new setting, add it to the relevant service's
`environment:` block, then `docker compose … up -d` to recreate the containers. Verify what a container actually
received with `docker compose -f deploy/docker-compose.yml exec api env | sort`.

---

## 5. Secure it

Follow [`SECURITY.md`](SECURITY.md) (threat model + the M9-05 review of the delivered surface). The
operator's checklist:

- Set `ATLAS_ENV=production` (secure cookies, HSTS, interactive API docs disabled).
- Terminate TLS at your reverse proxy and forward to `web`/`api`; **do not** publish `db` or `worker`
  (`OPERATIONS.md` §6, [`DEPLOYMENT.md`](DEPLOYMENT.md) §8).
- Keep the database on loopback/private network only.
- Set `ALLOWED_HOSTS` to your host name(s).
- Keep `.env` and the token-encryption key out of the repository and off the app server's public
  surface; store backups with appropriate permissions and consider encryption at rest.
- Keep dependencies current; the CI gate fails on an advisory ([`DEPENDENCIES.md`](DEPENDENCIES.md),
  [`SECURITY.md`](SECURITY.md) T8). Never suppress a finding to make a build green.

Known, accepted residual risks (read them before hardening decisions): the auth rate limiter keys on
`request.client.host` behind a proxy, there is no account lockout/MFA, the authorisation model is
single-user, and a Web Push `endpoint` is length/shape-bounded but not restricted to an `https`
push-service host. Details: [`SECURITY.md`](SECURITY.md) (R-SEC-1/2/4, R-21) and [`RISKS.md`](RISKS.md).

---

## 6. Backups

Automated backups capture **both** durable stores in one verified set: a consistent PostgreSQL dump
plus an archive of the Markdown root, with a checksummed manifest. Full detail and configuration are
in [`OPERATIONS.md`](OPERATIONS.md) §1; the essentials:

```bash
# Produce a set now (uses BACKUP_DIR / NOTES_ROOT / DATABASE_URL), then verify it:
atlas-backup run
atlas-backup verify "$(ls -d "${BACKUP_DIR:-./data/backups}"/atlas-backup-*/ | tail -1)"
atlas-backup list
```

- In the Compose stack the worker mounts `/data/atlas/backups` and the image ships a PostgreSQL client,
  so backups run out of the box on the `backup_interval_seconds` schedule.
- `atlas-backup verify` exits non-zero for a tampered or missing part, and reports `INCOMPLETE` for a
  staging directory left by an interrupted run. Run it from cron against `BACKUP_DIR` — a non-zero
  exit means the newest set cannot be trusted.
- `atlas-export` (full data export) is a **portability** artifact, **not** a backup — do not use it for
  disaster recovery ([`OPERATIONS.md`](OPERATIONS.md) §1.3).

## 7. Restore

The restore runbook is [`OPERATIONS.md`](OPERATIONS.md) §2 and was **executed** end to end as the
M9-02 drill ([`ACCEPTANCE.md`](ACCEPTANCE.md)). Never restore from an unverified set, and restore
**both** stores together into **fresh** targets:

```bash
SET="$(ls -d "$BACKUP_DIR"/atlas-backup-*/ | tail -1)"
atlas-backup verify "$SET"                                        # must be ok
psql -U atlas -d postgres -c "CREATE DATABASE atlas_restore OWNER atlas;"
psql -U atlas -d atlas_restore -v ON_ERROR_STOP=1 < "$SET/database.sql"
mkdir -p /path/to/restored-notes && tar -xzf "$SET/notes.tar.gz" -C /path/to/restored-notes
# stop api+worker, point DATABASE_URL/NOTES_ROOT at the restored stores, then start again and verify
```

Verify: `alembic_version` equals the source head; known rows return; notes are byte-identical
(`diff -r` exit 0); `/health/ready` is ok. Calendar sync resumes from the restored cursor and is
idempotent — *confirming that against a real provider needs M5-00/AR-001 and is `NOT RUN`*
([`OPERATIONS.md`](OPERATIONS.md) §2.6).

## 8. Upgrade and rollback

The ordered, copy-pasteable runbook is [`DEPLOYMENT.md`](DEPLOYMENT.md) §6 (upgrade) and §7
(rollback); both were **executed** on 2026-10-27 (M9-06). The one rule to remember: **back up first**
(a verified `atlas-backup` set), because a migration that cannot be reversed is only recoverable from
that backup.

- Upgrade: deploy the new version; the `api` service runs `alembic upgrade head` on start (or run
  `alembic upgrade head` / `atlas-migrate` yourself), then verify (`alembic current` = head, schema
  matches the models, `/health/ready` ok).
- Rollback: for a reversible migration, `alembic downgrade`; otherwise restore the pre-upgrade backup
  (§7). Roll the application image back **together** with the data.

## 9. Monitor and maintain

Available today:

- **Health**: `GET /health` (liveness) and `GET /health/ready` (database reachability). Poll both.
- **Logs**: structured (JSON) logs from `api` and `worker`; secrets, tokens and note content are
  redacted ([`SECURITY.md`](SECURITY.md) §4). Rotate and retain per your policy.
- **App status surfaces**: the **Sync** page (queue/conflicts) and **Calendar** page (per-provider sync
  state) reflect the server's state ([`USER_GUIDE.md`](USER_GUIDE.md) §7/§9).
- **Backups**: run `atlas-backup verify` on a schedule (§6).

There is **no dedicated job-queue dashboard** in this release; inspect the `jobs` table / worker logs
directly. Remediation guidance and the recovery-scenario table are in [`OPERATIONS.md`](OPERATIONS.md)
§3–§5.

## 10. Troubleshooting

| Symptom | Likely cause and fix |
|---|---|
| `api` container exits immediately at startup | A placeholder secret in `production` — set real `SECRET_KEY`/`SESSION_SECRET`/`TOKEN_ENCRYPTION_KEY` ([§4.2](#42-secrets-and-keys)). |
| `/health/ready` reports the database is not ok | `db` not healthy / wrong `DATABASE_URL`; check `docker compose … ps` and `logs db`. |
| First page shows a setup or login error | The first-run account may already exist; sign in, or check the auth rate limit. |
| Migrations fail mid-deploy | A migration aborts the whole transaction, leaving the DB at its prior revision; retake the pre-upgrade backup and follow [`DEPLOYMENT.md`](DEPLOYMENT.md) §7. |
| A whole feature "does nothing" despite config | The compose stack may not forward that variable — see [§4.6](#46-passing-settings-into-the-containers). |
| Reminders never arrive as notifications | VAPID is not configured (feature disabled by design) — set the keys ([§4.4](#44-notifications--web-push-vapid-keys)); check the worker log for `web push disabled`. |
| **Calendar** shows nothing to sync | No account is connected and account-connection is not delivered yet ([§10](#10-what-is-not-delivered-yet)). |
| A backup is untrustworthy | `atlas-backup verify` non-zero; inspect with `atlas-backup list` and use an older set ([`OPERATIONS.md`](OPERATIONS.md) §2.1). |
| Restore "succeeds" but data is missing | You may have restored only one store — a complete restore needs the **database and the notes** together ([`OPERATIONS.md`](OPERATIONS.md) §1/§2). |

For the full recovery-scenario matrix (worker crash mid-sync, expired OAuth token, lost encryption
key, corrupted note file, failed migration, missed notification), see [`OPERATIONS.md`](OPERATIONS.md)
§5.

## 11. Verify the installation / run the tests

- Full automated check from the repo root (backend lint/format/types/unit+integration, then frontend
  lint/types/tests): `./scripts/verify.sh` — needs a reachable PostgreSQL pointed at by
  `TEST_DATABASE_URL` (default `…:5432/atlas_test`). See [`TESTING.md`](TESTING.md).
- Browser end-to-end suite (Playwright, Chromium; separate from `verify.sh`):
  `cd apps/web && npx playwright install chromium && npm run e2e`.

---

## 12. What is *not* delivered yet

Do not promise or document these as working; they are tracked in [`ROADMAP.md`](ROADMAP.md) and
[`RISKS.md`](RISKS.md):

- **Calendar accounts (Google / Microsoft) and event views** — blocked on real provider accounts
  (M5-00/AR-001). Only the credential store, adapter contract, projection, sync-status surface and
  reconciliation are built; there is no account-connection UI and no day/week/month view.
- **Bidirectional calendar sync (M6)** — not started (depends on M5).
- **Mobile apps (Android/iOS) and native push (M8-06/07, M8-04)** — need real devices.
- **Real desktop push delivery** — needs VAPID keys configured *and* has not been verified end to end
  on a real install (only consent states and the pipeline are tested).
- **Desktop matrix (Linux/Windows/macOS, M8-08)** — not verified.
- **Projects / Tasks / Search / Settings pages**, in-app export button, task editing (due date,
  priority, recurrence, subtasks), task search/filters UI, per-task reminder override UI — API-only
  today.
- **A release checklist and labelled known-limitations document** — now delivered as
  [`RELEASE.md`](RELEASE.md): release label **`0.1.0-pre` — development snapshot, not
  production-ready** (M5/M6 calendar and M8 mobile/device gates are open), the pre-release checklist,
  and the consolidated known-limitations list. Per-requirement readiness (REQ-001…015) is in
  [`ACCEPTANCE.md`](ACCEPTANCE.md) §"Release Readiness (M9)".

---

## 13. Related documents

[`README.md`](../README.md) · [`USER_GUIDE.md`](USER_GUIDE.md) · [`DEPLOYMENT.md`](DEPLOYMENT.md) ·
[`OPERATIONS.md`](OPERATIONS.md) · [`SECURITY.md`](SECURITY.md) · [`RISKS.md`](RISKS.md) ·
[`DEPENDENCIES.md`](DEPENDENCIES.md) · [`TESTING.md`](TESTING.md) · [`ROADMAP.md`](ROADMAP.md) ·
[`ACCEPTANCE.md`](ACCEPTANCE.md) · [`RELEASE.md`](RELEASE.md) · [`.env.example`](../.env.example)
