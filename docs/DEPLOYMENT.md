# Atlas — Deployment

**Status:** Draft for approval (Milestone 0); upgrade/rollback runbook §6–§7 **executed** (M9-06, 2026-10-27)
**Last updated:** 2026-10-27

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

### 3.1 Web Push (VAPID keys)

Web Push desktop notifications (M8-02) require an **application-server key pair** (VAPID, RFC 8292).
Web Push is enabled only when **all three** values are set; when any is missing the feature is
disabled cleanly and reminders fall back to the server log (no crash). Generate a pair **once**, with
the `py-vapid` library that ships with the API's `pywebpush` dependency:

```bash
# Run inside the API image/venv, e.g.:
#   docker compose -f deploy/docker-compose.yml exec api python - <<'PY' … PY
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

Set the three values (also in `.env.example`):

| Variable | Purpose |
|---|---|
| `VAPID_PUBLIC_KEY` | Handed to the browser so it can form a subscription; safe to expose. |
| `VAPID_PRIVATE_KEY` | **Secret** — signs each push; never commit, bundle or log it. |
| `VAPID_SUBJECT` | A `mailto:` or `https:` contact the push service may use for the sender (RFC 8292). |

Provide them to the running containers: the shipped `deploy/docker-compose.yml` forwards the `VAPID_*` entries to the `api` and `worker` services, so set them in `.env` and recreate the containers. When Web Push is disabled the worker logs
`web push disabled` with the missing setting **names** (never values); a destination the push service
reports as gone (`404`/`410`) is disabled and never retried. The real browser-delivery end has not
been verified on a live install (`ROADMAP.md` M8-02), and mobile push is a later milestone.

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

Atlas is upgraded by deploying the new version and letting its **versioned Alembic migrations**
bring the database forward to `head`. `alembic upgrade head` (exposed as the `atlas-migrate` entry
point) is idempotent: it applies only the revisions a database has not yet seen, so it is safe to
run on an already-current database. **Always take a backup first** (§6.2) — a migration that cannot
be reversed is only recoverable from that backup.

> This runbook was **executed** end to end on 2026-10-27 (M9-06): a database at an earlier revision
> with representative data was upgraded to `head` and the result verified (schema matches the
> models; data preserved; the app reports healthy). Exact commands and real output are in
> `ACCEPTANCE.md` (M9-06).

### 6.1 Preconditions

- Shell access to the host running the stack; the working tree/checkout of the **new version** is in
  place (the API image ships the new migration set — migrations live in `services/api/alembic/versions/`).
- A reachable PostgreSQL server and a `psql` client — either local, or run inside the database
  container with `docker exec` (as in `OPERATIONS.md` §2).
- The `atlas-backup` command (`.venv/bin/atlas-backup` on the host, or `python -m atlas.backups`
  inside the `api`/`worker` image) and enough free space under `BACKUP_DIR` for a backup set.
- The database reachable as `DATABASE_URL` (host runs) or via the Compose service network
  (in-stack runs).

### 6.2 Back up first (mandatory)

**Do not upgrade without a verified pre-upgrade backup of both durable stores** (database +
Markdown root; `OPERATIONS.md` §1). Nothing proceeds if this step fails.

```bash
# Produce one backup set now and verify it before touching the schema.
#   host:      DATABASE_URL, NOTES_ROOT, BACKUP_DIR from your .env
#   in-stack:  run it inside the api/worker container, which already has the env + volumes
atlas-backup run
SET="$(ls -d "${BACKUP_DIR:-./data/backups}"/atlas-backup-*/ | tail -1)"
atlas-backup verify "$SET"        # must exit 0 with every part "ok"
```

In the Compose stack the equivalent is:

```bash
docker compose -f deploy/docker-compose.yml exec worker atlas-backup run
docker compose -f deploy/docker-compose.yml exec worker atlas-backup verify "$(ls -d /data/atlas/backups/atlas-backup-*/ | tail -1)"
```

Keep this set until the upgrade is confirmed good; it is the rollback path for an irreversible
migration (§7.3).

### 6.3 Apply the migrations

Two equivalent ways; both run `alembic upgrade head`:

```bash
# (a) host venv — explicit:
cd services/api
DATABASE_URL=postgresql+psycopg://atlas:atlas@127.0.0.1:5432/atlas .venv/bin/alembic upgrade head
#     … or the packaged entry point, which does the same:
DATABASE_URL=…atlas .venv/bin/atlas-migrate

# (b) inside the stack — the `api` service already runs `atlas-migrate` on start
#     (its compose command is `atlas-migrate && uvicorn …`), so simply:
docker compose -f deploy/docker-compose.yml up -d
```

Expected: `INFO [alembic.runtime.migration] Running upgrade … -> <head>` for each new revision and
exit 0. `alembic current` then reports the head revision. A migration that raises aborts the whole
transaction (PostgreSQL DDL is transactional) and leaves the database at its previous revision —
the service does not start on a half-applied schema.

### 6.4 Verify the upgrade

```bash
# 1. the migration state is head
DATABASE_URL=…atlas .venv/bin/alembic current                # -> <head> (head)
psql -U atlas -d atlas -tAc "SELECT version_num FROM alembic_version;"

# 2. the schema matches the models exactly (compare_metadata == [])
DATABASE_URL=…atlas .venv/bin/python - <<'PY'
import atlas.models  # noqa: F401  (registers the tables)
from alembic.autogenerate import compare_metadata
from alembic.migration import MigrationContext
from atlas.db import Base, create_sync_engine
with create_sync_engine().connect() as c:  # type: ignore[attr-defined]
    ctx = MigrationContext.configure(c, opts={"compare_type": True})
    diffs = compare_metadata(ctx, Base.metadata)
print("diffs:", diffs)
assert diffs == [], "schema does not match models"
PY

# 3. the app is healthy and sees the database
curl -fsS http://localhost:8000/health         # -> {"status":"ok",…}
curl -fsS http://localhost:8000/health/ready   # -> {"status":"ready","database":"ok"}
```

### 6.5 Restart services and finish

```bash
docker compose -f deploy/docker-compose.yml up -d      # recreates containers on the new image
docker compose -f deploy/docker-compose.yml ps         # all services Up / healthy
```

Record the new revision and the backup set id (e.g. in the release notes). If anything is wrong,
roll back (§7).

## 7. Rollback

Decide the path from the migration's own documentation (`services/api/alembic/versions/*.py`
docstring; a migration that says "both directions are reversible" can be downgraded):

- **Reversible migration** → downgrade the migrations (§7.2). This is the fast path.
- **Irreversible or unknown** → restore the pre-upgrade backup (§7.3 / `OPERATIONS.md` §2). This
  always returns to the exact pre-upgrade state because the database and notes are restored together.
- **Application only** (no schema change) → redeploy the previous image tag and restart.

### 7.2 Downgrade the migrations

```bash
cd services/api
# step back one revision, or N, or to an explicit revision id:
DATABASE_URL=…atlas .venv/bin/alembic downgrade -1     # or: -2, or 8f1c2a7d5e04
DATABASE_URL=…atlas .venv/bin/alembic current          # confirm the expected revision

# redeploy the previous image tag, then restart and check health:
docker compose -f deploy/docker-compose.yml up -d
curl -fsS http://localhost:8000/health/ready
```

If the rollback turns out to be unnecessary, move forward again with `alembic upgrade head`.

> Executed on 2026-10-27 (M9-06): `alembic downgrade -1` removed revision `f1b2c3d4e5a6`'s column
> and index, then `alembic upgrade head` restored them and `compare_metadata` was `[]` again. See
> `ACCEPTANCE.md` (M9-06).

### 7.3 Restore the pre-upgrade backup (irreversible migration / lost data)

Follow the restore procedure in `OPERATIONS.md` §2 verbatim — it is the same drill, executed as
M9-02. In short:

1. `atlas-backup verify "$SET"` the pre-upgrade set (§6.2) — restore nothing that does not verify.
2. Stop the writers: `docker compose -f deploy/docker-compose.yml stop api worker`.
3. Restore **both** stores into fresh targets (`psql … -v ON_ERROR_STOP=1 < database.sql`;
   `tar -xzf notes.tar.gz`).
4. Point `DATABASE_URL`/`NOTES_ROOT` at the restored stores, redeploy the **previous** image tag,
   and restart: `docker compose -f deploy/docker-compose.yml up -d`.
5. Verify (`alembic_version`, known rows, notes `diff -r`, `/health/ready`).

Rolling the database back to a pre-upgrade revision while the application code is newer is **not**
supported: roll the application image back together with the data.

## 8. Reverse Proxy and TLS

- Terminate TLS at the proxy; forward to `api`/`web` on the internal network.
- Documented example configuration, including OAuth redirect URIs and any push webhook paths.
- Do not expose `db` or `worker`. Do not expose the app over plain HTTP for remote access.
- Request body size: notes may be up to 5 MiB and are sent as JSON, where a newline, tab, quote or backslash costs two bytes,
  so the largest legitimate body is about 10 MiB. The shipped `apps/web/nginx.conf` allows `client_max_body_size 11m;` for
  `/api/` and 1 MiB everywhere else (RISKS R-34; checked by `services/api/tests/unit/test_nginx_config.py`, which also probes a
  throwaway nginx container when docker is available). **Rebuild the `web` image to pick this up**
  (`docker compose -f deploy/docker-compose.yml build web`, then `up -d web`); until then an older image still answers `413`
  above 1 MiB. Any reverse proxy in front of the web container or the API must also allow at least 11 MiB for `/api/`
  (nginx `client_max_body_size 11m;` in the `/api/` location, Caddy `request_body { max_size 11MB }`, Traefik `buffering`
  `maxRequestBodyBytes`). The API enforces the real per-note limit on the decoded content.

## 8a. Dev stack on the tailnet (development only)

`scripts/dev-stack.sh start|stop|restart|status` runs the local dev stack (API on `127.0.0.1:8000`,
worker, Vite on `:5173`; PostgreSQL stays in its container). Defaults are **localhost-only**. Logs and
pid files go to `data/dev/run/` (git-ignored). Data dirs default to `data/dev/{notes,backups,exports}`
and `DATABASE_URL` to the documented dev database; override by exporting the variables first.

To open the dev UI from a phone or laptop on the same private Tailscale network:

```bash
ATLAS_DEV_BIND=tailscale ./scripts/dev-stack.sh restart     # binds Vite to `tailscale ip -4`
# open http://<tailscale-ip>:5173 on the other device (this machine: 100.127.227.79)
# LAN instead (only if the firewall allows it): ATLAS_DEV_BIND=192.168.x.y ...
```

- Only Vite is bound to that address; it proxies `/api` and `/health` to the API on loopback, so the
  browser sees one origin (no CORS, `ALLOWED_HOSTS`, or CSRF setting needs changing). The API, worker
  and PostgreSQL are never reachable from the network.
- `ATLAS_ENV=development` keeps session/CSRF cookies non-`Secure`, which is what lets login work over
  plain HTTP on a non-localhost origin. Production still sets `Secure` (`Settings.secure_cookies`).
- The script refuses `0.0.0.0`, `::` and any address that is not loopback, Tailscale (100.64.0.0/10)
  or RFC 1918 private. Never use `tailscale funnel` or port-forwarding for this.
- Open it by IP. Vite 6 rejects other `Host` headers (including the MagicDNS name) with 403.
- Over plain HTTP the page is not a secure context: no service worker, Web Push or PWA install on
  the remote device. Those need HTTPS (`tailscale serve`, requires HTTPS certificates enabled on the
  tailnet) and are out of scope for the dev stack.
- Host firewall: allow only the tailnet interface, e.g. `sudo ufw allow in on tailscale0 to any port 5173 proto tcp`
  (ufw is active on the owner's machine; not applied by Atlas). Do not open 8000 or 5432.
- Revert to localhost-only: `./scripts/dev-stack.sh restart` (no `ATLAS_DEV_BIND`), and remove any ufw rule added.

## 9. Logging

- Structured (JSON) logs from `api` and `worker`.
- No secrets, tokens or note content in logs.
- Log retention and rotation documented in `OPERATIONS.md`.

## 10. Non-Goals

- No Kubernetes, no Docker-in-Docker, no external message broker.
- No dependency on a developer workstation.
