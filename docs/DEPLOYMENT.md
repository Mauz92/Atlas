# Atlas — Deployment

**Status:** Draft for approval (Milestone 0); upgrade/rollback runbook §6–§7 **executed** (M9-06, 2026-10-27)
**Last updated:** 2026-11-03 (P0-1/P0-2: smoke-tested on the current code; §8 HTTPS; §11 personal install guide)

Target: a personal self-hosted server using Docker Compose with a small number of services.

---

## 1. Services

| Service | Role | Exposed |
|---|---|---|
| `web` | nginx: built frontend assets and the `/api` proxy | `127.0.0.1:8080` by default (`WEB_BIND`/`WEB_PORT`); HTTPS in front (§8) |
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
| `atlas-exports` | Output of the `atlas-export` CLI (`/data/atlas/exports`) |

Both the database and the notes volume are required for a complete restore. Neither alone is
sufficient.

## 3. Configuration

- All configuration via environment variables; `.env.example` lists every variable with
  placeholders. Real `.env` is git-ignored.
- Required variables (indicative): `DATABASE_URL`, `SECRET_KEY`, `SESSION_SECRET`,
  `TOKEN_ENCRYPTION_KEY`, `NOTES_ROOT`, `PUBLIC_BASE_URL`, `GOOGLE_CLIENT_ID`,
  `GOOGLE_CLIENT_SECRET`, `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`, `MICROSOFT_TENANT`.
- Optional Compose overrides: `WEB_PORT` (host port for the web UI, default `8080`) and `WEB_BIND` (address it is
  published on, default `127.0.0.1`), `POSTGRES_USER`/`POSTGRES_PASSWORD`/`POSTGRES_DB` (default `atlas`).
- `deploy/docker-compose.yml` builds the containers' `DATABASE_URL` from `POSTGRES_*`, so set `POSTGRES_PASSWORD`
  (before the first start: it initialises the database volume) and do not rely on `DATABASE_URL` in `.env` for Compose.
  Every setting the application reads is forwarded to `api` and `worker` from one `x-atlas-env` block; a unit test
  (`tests/unit/test_compose_env.py`) fails when a new setting is not.
- `ALLOWED_HOSTS` applies to every path except `/health*` (the container healthcheck and nginx call it with their own
  host name).
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

## 4. Installation

The verified, copy-pasteable personal install is §11. In outline: install Docker + Compose; copy `.env.example` to
`.env` and set real secrets; `docker compose -f deploy/docker-compose.yml up -d --build` (the `api` service runs
`atlas-migrate` on start, so an empty database migrates itself); put HTTPS in front (§8); open the site and create the
owner account. A clean installation must succeed by following §11 verbatim.

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

## 8. HTTPS: Tailscale serve or a reverse proxy

Atlas speaks plain HTTP inside the host; TLS is added in front of the `web` container. Two ways are supported for a
personal install. Both were checked against a real Compose stack on 2026-11-03 (what was and was not verifiable is
stated per way). Never expose `db` or `worker`; never serve the app over plain HTTP to another machine.

**Why HTTPS is required, not optional.** With `ATLAS_ENV=production` the session and CSRF cookies are `Secure`
(`Settings.secure_cookies`; `HttpOnly` and `SameSite=Lax` on the session cookie, host-only, no `Domain`). A browser
stores a `Secure` cookie only from an HTTPS origin or from `localhost`/`127.0.0.1`, so login over
`http://<lan-or-tailscale-ip>:8080` silently fails to stay signed in. HTTPS is also what gives the browser a secure
context (service worker, Web Push, install-as-app). The API adds `Strict-Transport-Security` on `/api` and `/health`;
the static page comes from nginx without it, so a proxy on a public name should add HSTS itself.

### 8.0 Settings that must agree with the public address

| Variable | Value | Why |
|---|---|---|
| `ATLAS_ENV` | `production` | `Secure` cookies, HSTS, no `/api/docs`, placeholder secrets rejected at start |
| `PUBLIC_BASE_URL` | `https://<the name users type>` (no trailing slash) | links and OAuth callbacks |
| `ALLOWED_HOSTS` | the host name only, e.g. `atlas.tail1234.ts.net` (comma-separated for several; no port, no scheme) | the API answers `400 Invalid host header` for any other `Host` |
| `WEB_PORT` / `WEB_BIND` | default `8080` / `127.0.0.1` | the proxy runs on the same host and reaches `http://127.0.0.1:8080`; leave `WEB_BIND` alone so plain HTTP is not published on the LAN |

Forwarded headers: the shipped nginx passes `X-Forwarded-For` and `X-Forwarded-Proto` through (an existing
`X-Forwarded-Proto: https` from the proxy is kept) and `Host` without the port. The application does **not** use them
to decide anything (cookie flags come from `ATLAS_ENV`; CSRF is a double-submit token, not an Origin check), so there is
no "trusted proxy" setting to configure. Known consequence: the login rate limiter sees the nginx container's address
for every client (`SECURITY.md` R-SEC-1), so ten failed logins per minute from anyone lock the owner out for that
minute. API redirects (only a trailing slash such as `/api/tasks/`) carry an `http://` Location; the web app never
issues such requests.

### 8.1 Way (a): `tailscale serve` (tailnet only, no public exposure)

Prerequisites: Tailscale installed and logged in on the Atlas host, MagicDNS and HTTPS certificates enabled for the
tailnet (admin console, DNS page), and the `web` container running on `127.0.0.1:8080`.

```bash
# the host's tailnet name, e.g. atlas-host.tail1234.ts.net
tailscale status --json | python3 -c 'import json,sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))'
# .env:  ATLAS_ENV=production
#        PUBLIC_BASE_URL=https://atlas-host.tail1234.ts.net
#        ALLOWED_HOSTS=atlas-host.tail1234.ts.net
docker compose -f deploy/docker-compose.yml up -d                    # recreate api/worker with the new env
tailscale serve --bg --https=443 http://127.0.0.1:8080               # tailnet HTTPS -> web container
tailscale serve status                                               # shows https://atlas-host.tail1234.ts.net -> 127.0.0.1:8080
# open https://atlas-host.tail1234.ts.net from any device on the tailnet
```

Stop serving: `tailscale serve --https=443 off` (older clients: `tailscale serve reset`). **Do not use
`tailscale funnel`**: it publishes the app on the public internet. Check `tailscale serve --help` on your version; the
flags have changed between releases. Tailscale terminates TLS with a certificate for the `*.ts.net` name and passes
the original `Host` header, which is why `ALLOWED_HOSTS` must list that name.

> **Verification status.** `tailscale serve` was **not run** (the task rules forbade changing Tailscale configuration
> on the owner's machine); the commands above are from Tailscale's documented CLI and are `NOT RUN` here. The app side
> (cookies, CSRF, headers, 5 MiB notes through a TLS-terminating proxy) was verified with Caddy in 8.2, which presents the
> same shape to the stack: HTTPS in front, HTTP to `127.0.0.1:8080`.

### 8.2 Way (b): a reverse proxy with automatic TLS (Caddy)

For a name you own that points at the host (public DNS or split-horizon). Caddy obtains and renews a Let's Encrypt
certificate by itself (ports 80 and 443 must reach the host for the ACME challenge). `Caddyfile`:

```
atlas.example.com {
	encode zstd gzip
	header Strict-Transport-Security "max-age=31536000"
	reverse_proxy 127.0.0.1:8080
}
```

```bash
# .env: ATLAS_ENV=production  PUBLIC_BASE_URL=https://atlas.example.com  ALLOWED_HOSTS=atlas.example.com
docker compose -f deploy/docker-compose.yml up -d
caddy run --config Caddyfile            # or the caddy:2-alpine image / the distribution package + systemd
```

Caddy needs no body-size setting (unlimited by default); with another proxy allow at least 11 MiB for `/api/`
(nginx `client_max_body_size 11m;`, Traefik `maxRequestBodyBytes`). Caddy sets `X-Forwarded-For`/`-Proto`/`-Host` itself.
A Caddy container on the Compose network can use `reverse_proxy web:80` instead of `127.0.0.1:8080`.

**What was verified (2026-11-03, isolated Compose project, Caddy 2.11 `caddy:2-alpine`, `local_certs` = Caddy's own
CA instead of ACME because the test name is `localhost`; the ACME path itself is `NOT RUN`).**

| Check | Result |
|---|---|
| TLS chain and hostname verified against Caddy's CA (`https://localhost:18443`) | PASS |
| `/health/ready` through proxy -> nginx -> api; `Strict-Transport-Security` on `/health` | PASS |
| Login cookies | `atlas_session`: `HttpOnly; Secure; SameSite=Lax; Path=/`; `atlas_csrf`: `Secure; SameSite=Lax; Path=/` (readable by the page by design) |
| Write with the CSRF header 201; wrong header 403; no header 403 | PASS |
| 5 MiB note through the TLS proxy | 201 (`409` on the repeat, same path) |
| Chromium (Playwright, CA not trusted so certificate errors ignored): sign in, reload stays signed in, `isSecureContext` true, service worker available | PASS |
| Same stack at `http://127.0.0.1:18080` in production mode | login works only because `127.0.0.1` is a secure context for cookies; not a remote option |
| `Host: evil.example` | refused (Caddy: empty 200 for an unknown site; the API itself: 400) |
| Trailing-slash redirect `Location` | `http://localhost/api/tasks` (wrong scheme and port): known limitation above; an nginx `proxy_redirect` attempt did not rewrite the 307 and was dropped |

### 8.3 Request body size

Notes may be up to 5 MiB and are sent as JSON, where a newline, tab, quote or backslash costs two bytes, so the largest
legitimate body is about 10 MiB. The shipped `apps/web/nginx.conf` allows `client_max_body_size 11m;` for `/api/` and
1 MiB everywhere else (RISKS R-34; checked by `services/api/tests/unit/test_nginx_config.py`). **Rebuild the `web` image
to pick this up** (`docker compose -f deploy/docker-compose.yml build web`, then `up -d web`). Verified through the
`web` container on 2026-11-03: a 1.5 MiB note and a 5 MiB note: `201`; 5 MiB of newlines (a 10 MiB JSON body): `201`;
5 MiB + 1 character: `422` with a small body (the offending text is no longer echoed back, a defect found in this
smoke test); a 12 MiB body: nginx `413` (an HTML page, before the API sees it).

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

## 11. Personal install guide (one owner, one server)

Every command below was run on 2026-11-03 against the current code in isolated Compose projects (evidence:
`ACCEPTANCE.md` P0-1/P0-2/P0-3), except `tailscale serve`, which was not run (§8.1). Replace the example names.

**1. Install.**

```bash
git clone <your-atlas-checkout> atlas && cd atlas
cp .env.example .env
# real secrets (the api refuses to start in production with the placeholders):
sed -i "s|^SECRET_KEY=.*|SECRET_KEY=$(openssl rand -hex 32)|; s|^SESSION_SECRET=.*|SESSION_SECRET=$(openssl rand -hex 32)|; \
        s|^TOKEN_ENCRYPTION_KEY=.*|TOKEN_ENCRYPTION_KEY=$(openssl rand -base64 32)|; \
        s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=$(openssl rand -hex 16)|; s|^ATLAS_ENV=.*|ATLAS_ENV=production|" .env
# set PUBLIC_BASE_URL=https://<your name> and ALLOWED_HOSTS=<your name> in .env (§8.0)
docker compose -f deploy/docker-compose.yml up -d --build
docker compose -f deploy/docker-compose.yml ps                     # all Up; api and db (healthy)
curl -fsS http://127.0.0.1:8080/health/ready                      # {"status":"ready","database":"ok"}
```

Back up `.env` (especially `TOKEN_ENCRYPTION_KEY`) somewhere other than the server; the database and notes backups do
not contain it. The first account created in the browser (first-run setup) is the owner; further setup attempts are
refused (`409`).

**2. HTTPS.** §8.1 (`tailscale serve`, tailnet only) or §8.2 (Caddy). Until it is in place, only open the app on the
server itself (`http://127.0.0.1:8080`).

**3. Backups (on by default).** The worker writes a verified backup set (database dump + notes archive including the
note history, manifest with checksums) at start-up and then every `BACKUP_INTERVAL_SECONDS` (default 24 h), keeping the
newest `BACKUP_RETAIN` (default 7) in the `atlas-backups` volume. That volume is on the same disk as the data, so
copy sets off the machine:

```bash
docker compose -f deploy/docker-compose.yml exec worker atlas-backup list                    # sets and their state
docker compose -f deploy/docker-compose.yml exec worker atlas-backup run                     # one now
SET=$(docker compose -f deploy/docker-compose.yml exec -T worker sh -c 'ls -d /data/atlas/backups/atlas-backup-*/ | tail -1' | tr -d '\r')
docker compose -f deploy/docker-compose.yml cp "worker:${SET%/}" ./offsite/                   # then rsync/restic/rclone ./offsite
```

Restore drill (verified into a second, empty stack): `OPERATIONS.md` §2.7. Do one before you trust the data to it.

**4. Upgrade** (verified from revision `b7d3e1a95c24` with data to head, §6):

```bash
docker compose -f deploy/docker-compose.yml exec worker atlas-backup run                     # 1. back up first
git pull                                                                                      # 2. new code
docker compose -f deploy/docker-compose.yml up -d --build                                     # 3. rebuild; api migrates on start
docker compose -f deploy/docker-compose.yml exec api alembic current                          # 4. shows the new head
curl -fsS http://127.0.0.1:8080/health/ready
```

**5. Recovery.** Forgotten password (signs the account out everywhere; verified):
`docker compose -f deploy/docker-compose.yml exec api atlas-admin list-users`, then
`docker compose -f deploy/docker-compose.yml exec api atlas-admin reset-password --email you@example.com` (hidden
prompt; add `-T` and pipe the password on stdin for scripts). Lost server: reinstall (step 1 with the saved `.env`), then
`OPERATIONS.md` §2.7. A copy of your notes as plain files at any time: Settings export, or
`docker compose -f deploy/docker-compose.yml exec worker atlas-export run --user you@example.com` (sets land in the
`atlas-exports` volume; `docker compose cp` them out).

**Limits to accept** (`RELEASE.md` §3): no calendars, online only (no offline editing yet), one user, the rate limiter
shares one bucket for all clients behind the proxy, sessions last 14 days, and nothing has run on a second device.
