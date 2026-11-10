# Atlas — Operator Guide

> **Personal install in one place:** [`DEPLOYMENT.md`](DEPLOYMENT.md) section 11 (install, HTTPS, backups, upgrade,
> recovery, with commands verified on 2026-11-03). Where this guide differs, that section is correct.

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
docker compose -p atlas --env-file .env -f deploy/docker-compose.yml up -d --build
docker compose -p atlas --env-file .env -f deploy/docker-compose.yml ps          # all services Up / healthy
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
| `RECOVERY_ENABLED` | `true` (default): the owner gets a one-time **recovery code** at first-run setup (and can regenerate it in Settings → Account), and **Forgot password?** on the sign-in page resets the password with it. `false`: no code is issued, the reset and regenerate endpoints answer `404`, and a forgotten password can only be fixed by you on the server (`atlas-admin reset-password`). Set it to `false` if you prefer CLI-only recovery. Existing codes are kept while it is off. |
| `NOTES_RECONCILE_SECONDS` | How often the worker re-scans the notes root (default `300`). |
| `CHANGE_RETENTION_DAYS` | How far back the per-user change feed keeps deletion history (default `90`, minimum `30`); a device older than this is told to full-resync. The same window applies to saved-request keys and to the automatic-resolution log (the "changed on another device" notices and their undo; they keep the overwritten status, date or path of a simple field, never text). It is also how long a sync device may stay unseen before it must sign in again, and how long a signed-out device is remembered. **It never purges your task/project/note rows.** |
| `CHANGE_PURGE_INTERVAL_SECONDS` | How often the purge job runs (default `3600`). |
| `NOTE_HISTORY_KEEP_REVISIONS` / `NOTE_HISTORY_KEEP_DAYS` | Note history for sync clients (SYNC-04): a note keeps its newest N revisions (default `20`) and everything younger than D days (default `90`). The text lives in `<notes root>/.atlas/history` and is in every backup; it keeps the text of overwritten and **deleted** notes for that long. |
| `NOTE_HISTORY_MAX_REVISIONS` / `NOTE_HISTORY_MAX_BYTES` | Hard bounds per note on top of the above (defaults `200` revisions, `67108864` bytes of distinct text); the newest N revisions are always kept. A merge base that was pruned makes a stale save a conflict copy, never a guess. |
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

### 4.5 Calendar providers (Stage A, read-only)

`GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`, `MICROSOFT_CLIENT_ID`/`MICROSOFT_CLIENT_SECRET`/`MICROSOFT_TENANT` enable the
Connect buttons in Settings -> Calendar; leave them empty and the card shows setup help instead. The redirect URIs are
**not** settings: they are always `{PUBLIC_BASE_URL}/api/calendar/google/callback` and `.../microsoft/callback`
(owner setup: `https://galaxia-atlas.duckdns.org:9443/...`). `ICS_POLL_SECONDS` (default 900, min 300), `ICS_MAX_BYTES`,
`ICS_TIMEOUT_SECONDS` tune secret ICS feeds (ProtonMail "Share via link"); `ICS_ALLOW_HTTP` and `ICS_ALLOW_PRIVATE_HOSTS`
are development-only (the API refuses to start with the latter in production). Step by step, the live-check runbook and
the troubleshooting table: [`CALENDAR_SYNC.md`](CALENDAR_SYNC.md) section 12. Diagnose with
`docker compose -p atlas --env-file .env -f deploy/docker-compose.yml exec api atlas-admin calendar-status` (read-only, prints no secrets).
Live behaviour with real providers is **unverified** until that runbook is recorded.

### 4.6 Passing settings into the containers

The shipped `deploy/docker-compose.yml` forwards every setting the API and worker read from one shared
`x-atlas-env` block (guarded by `tests/unit/test_compose_env.py`). `DATABASE_URL` is built from `POSTGRES_USER`/
`POSTGRES_PASSWORD`/`POSTGRES_DB`, not read from `.env`. It forwards
`GOOGLE_*`/`MICROSOFT_*`/`ICS_*` too; it does **not** forward `FCM_*`/`EXPO_*` (the application does not read them). When you add a new setting, add it to the relevant service's
`environment:` block, then `docker compose … up -d` to recreate the containers. Verify what a container actually
received with `docker compose -p atlas --env-file .env -f deploy/docker-compose.yml exec api env | sort`.

---

### 4.7 Instant updates with a self-hosted ntfy (optional; the hardening below is REQUIRED)

Reminders on a phone or desktop do **not** need this: each device schedules its own notifications from synced data (ADR-0068). This section is only for the optional **content-free "sync now" hint**, so a backgrounded Android app refreshes sooner. Atlas sends the constant message `{"v":1,"k":"sync"}` and nothing else (no task, title, count, id or cursor) to **your own** ntfy server. It is off by default (`SYNC_HINT_ENABLED=false`); with it off nothing is sent and no endpoint is accepted. Pointing it at the public `ntfy.sh` is allowed but **not recommended**: that server would learn *when* you edit (never what).

**Required hardening (Atlas does not enforce it; an open ntfy would let a stranger read the timing of your edits and flood your phone with wake-ups):**
1. **Authentication on, default deny.** `auth-default-access: "deny-all"` and an `auth-file`.
2. **Least-privilege accounts.** One *subscriber* account for the phone's ntfy app (read-only on `up*`), one *publisher* account for Atlas (write-only on `up*`) with an **access token**. Nobody else gets access; signup stays off.
3. **HTTPS** in front of ntfy (your reverse proxy, a tailnet certificate or a private CA). Plain `http` is accepted by Atlas only with `SYNC_HINT_ALLOW_INSECURE_HTTP=true` (a LAN or tailnet gateway you control) or on loopback outside production.
4. **No upstream relay.** Leave `upstream-base-url` empty so ntfy never forwards to ntfy.sh or Firebase.

`server.yml` (ntfy 2.x; verified with ntfy 2.37.2 on loopback, 2026-11-09):

```yaml
base-url: "https://ntfy.example.net"
listen-http: ":80"                       # behind your TLS proxy; add `behind-proxy: true` there
auth-file: "/var/lib/ntfy/user.db"
auth-default-access: "deny-all"
cache-file: "/var/lib/ntfy/cache.db"
upstream-base-url: ""
enable-signup: false
enable-login: true
visitor-subscriber-rate-limiting: true
```

Accounts and the token (run inside the ntfy container; each `user add` prompts for a password, or set `NTFY_PASSWORD`):

```sh
ntfy user add --role=admin admin
ntfy user add phone                         # the phone's ntfy app logs in as this user
ntfy user add atlas-publisher               # the account behind Atlas's token
ntfy access phone 'up*' read-only
ntfy access atlas-publisher 'up*' write-only
ntfy token add --label atlas-server atlas-publisher     # prints tk_...: put it in SYNC_HINT_GATEWAY_TOKEN
```

Atlas `.env`:

```sh
SYNC_HINT_ENABLED=true
SYNC_HINT_GATEWAY_URL=https://ntfy.example.net      # an origin only: no path, no credentials
SYNC_HINT_GATEWAY_TOKEN=tk_...                       # a secret; never commit it
```

What was checked against a real ntfy 2.37.2 (throwaway container on loopback, removed afterwards): anonymous publish `403`; publish with the token `200`; anonymous subscribe `403`; the phone user subscribes `200` and sees the message; the phone user and the publisher cannot do each other's job (`403`); a topic outside `up*` is `403`; Atlas's adapter reports `rejected` without the token and `delivered` with it. **Not checked here:** TLS termination, the Android ntfy app and UnifiedPush distributor behaviour (`NOT RUN`, M8-04g).

How Atlas treats the gateway: a device may register only a topic URL (`<origin>/up<random>`) on exactly the origin configured here (another host, port, scheme, credentials, query or dot-segments is `422`); redirects are never followed; the topic URL is a secret, stored encrypted and shown only as its last four characters; a hint is sent at most once per 30 seconds per writer, never to the device that made the change; if the gateway is down the hints are dropped after three tries and a circuit breaker pauses sending for five minutes; none of this can delay or fail a save. Rotating a topic = the device registers a new endpoint. **Backups** contain the (encrypted) endpoints; restoring an old backup may bring back an old endpoint that simply fails (`410`) until the device registers again.

Long poll: `GET /api/sync/wait` holds a request up to `SYNC_WAIT_MAX_SECONDS` (default 25, at most 55). The shipped nginx waits 75 s for the API (`proxy_read_timeout`); if you put another proxy in front, give `/api/` a read timeout above 60 s.

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
- **Sync devices** (desktop and phone apps; SYNC-06): each signs in with the account password and holds its own key. The owner
  lists, renames and signs them out in **Settings → Devices**. On the server (the same container and database as
  `atlas-admin reset-password`):
  `docker compose -p atlas --env-file .env -f deploy/docker-compose.yml exec api atlas-admin list-devices --email you@example.com` prints id, state, platform,
  last seen and name; `... atlas-admin revoke-device --email you@example.com --device <id>` (or `--all`) signs devices out at once.
  `reset-password` also signs out **every** device. No key is ever printed or logged; the database holds only hashes. A device
  unseen for `CHANGE_RETENTION_DAYS` (default 90) must sign in again; devices signed out longer ago than that are deleted by the
  hourly purge. **After restoring a backup, sign out again any device you revoked since that backup was taken** (the restore brings
  back the state of the backup; when unsure, `revoke-device --all`).

- **Account recovery** (AUTH-01, ADR-0067). The owner resets a forgotten password in the browser with the recovery code from first-run
  setup; you do nothing. If the owner has lost the code **and** the password, or `RECOVERY_ENABLED=false`, you fix it on the server:
  `docker compose -p atlas --env-file .env -f deploy/docker-compose.yml exec api atlas-admin reset-password --email you@example.com` (hidden prompt; signs out every
  browser **and device**), then, if wanted, `... atlas-admin recovery-code --email you@example.com`, which prints a **new recovery code
  once** (the old one stops working) for you to hand to the owner. Accounts created before AUTH-01 have no code until the owner makes one in
  Settings or you run `recovery-code`. The server stores only a salted hash of the code, never the code. Reset attempts are limited (per
  address 10 a minute, per account 5 per 15 minutes; in process, so a restart clears them) and logged as `recovery_reset_*` events on the
  `atlas.auth.audit` logger without any secret. After restoring a backup, see [`OPERATIONS.md`](OPERATIONS.md) 2.2b.

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
| **Calendar** shows nothing to sync | Nothing is connected yet, or the provider is "not configured" (client id/secret empty). See [`CALENDAR_SYNC.md`](CALENDAR_SYNC.md) section 12; `atlas-admin calendar-status` tells which. |
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
- **Desktop matrix (Linux/Windows, M8-08)** — not verified. macOS and iOS are out of scope (owner decision 2026-11-04). The native reminder clients (M8-04c/d) are not built yet; only the server side (reminder feed entity, actions, long poll, optional hint) and the device scheduler core exist.
- **Projects / Tasks / Search / Settings pages**, in-app export button, task editing (due date,
  priority, recurrence, subtasks), task search/filters UI, per-task reminder override UI — API-only
  today.
- **A release checklist and labelled known-limitations document** — now delivered as
  [`RELEASE.md`](RELEASE.md): release label **`0.1.0-pre` — development snapshot, not
  production-ready** (M5/M6 calendar and M8 mobile/device gates are open), the pre-release checklist,
  and the consolidated known-limitations list. Per-requirement readiness (REQ-001…015) is in
  [`ACCEPTANCE.md`](ACCEPTANCE.md) §"Release Readiness (M9)".

---

## 12a. Desktop app (SYNC-09, Linux phase 1): what the operator needs to know

The Atlas desktop app signs in to YOUR server with a **per-device credential** (`POST /api/devices`, ADR-0065) and then syncs. For the server nothing changes, but:

- **HTTPS.** The app refuses a server address that is not `https://` (plain `http://` only for `localhost`/`127.0.0.1`). Use the same HTTPS front (Caddy, `tailscale serve`, ...) as for the browser. The app trusts the **system** certificate store, so a private CA (for example Caddy's internal CA) works once it is installed in the system store of that computer (Arch: `trust anchor <ca.pem>`; Debian/Ubuntu: `/usr/local/share/ca-certificates/` + `update-ca-certificates`); a self-signed certificate that is not trusted is refused, there is no "ignore the warning".
- **No CORS setting is needed.** The desktop app's requests are sent by its Rust host, not by the web page, so `CORS_ORIGINS` must stay as it is. (A direct browser-style request from the app's origin `tauri://localhost` would need that origin listed; the app does not make one, and the end-to-end test runs with `CORS_ORIGINS` empty.) Do not add `tauri://localhost` to `CORS_ORIGINS` for this app.
- **Rate limits.** A device may make 600 requests and 120 writes a minute (SYNC-06). A running desktop app makes about 5 requests a minute when idle (a long poll of up to 25 s, `GET /api/sync/wait`, about 2.4 a minute, plus the engine's own pull every 30 s, about 2 a minute); allow the nginx `proxy_read_timeout` of 60 s or more for `/api/` (the shipped `nginx.conf` uses 75 s).
- **Managing devices.** Settings > Devices in the BROWSER lists every desktop and phone app with its last seen time; **Sign out** revokes one at once (the app notices on its next request and shows its sign-in page, its token is deleted from the computer's keystore). A password reset (the recovery code or `atlas-admin reset-password`) revokes all devices. A device token cannot change the password, export data, connect calendars or revoke other devices (SECURITY T22), which is why those Settings sections are absent in the desktop app.
- **Versions.** The app sends `Atlas-Sync: 1`; a server that has moved past it answers `426` and the app stops syncing in an "update required" state (it keeps the token and the local data). Upgrade the app first when you raise the protocol range.
- **Back-ups and restore with devices attached.** After `atlas-admin record-restore` an attached desktop app finds the new epoch, stops and asks the user to confirm before it re-creates anything (SYNC_PROTOCOL 7.4). The confirmation screen is not in the desktop UI yet (SYNC-11).

## 13. Related documents

[`README.md`](../README.md) · [`USER_GUIDE.md`](USER_GUIDE.md) · [`DEPLOYMENT.md`](DEPLOYMENT.md) ·
[`OPERATIONS.md`](OPERATIONS.md) · [`SECURITY.md`](SECURITY.md) · [`RISKS.md`](RISKS.md) ·
[`DEPENDENCIES.md`](DEPENDENCIES.md) · [`TESTING.md`](TESTING.md) · [`ROADMAP.md`](ROADMAP.md) ·
[`ACCEPTANCE.md`](ACCEPTANCE.md) · [`RELEASE.md`](RELEASE.md) · [`.env.example`](../.env.example)
