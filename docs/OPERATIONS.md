# Atlas — Operations

**Status:** Draft for approval (Milestone 0)
**Last updated:** 2026-10-27

Backups, recovery, monitoring and maintenance for a self-hosted Atlas deployment.

---

## 1. Backup Strategy

A complete backup covers **both** durable stores:

1. **PostgreSQL** — logical dump (e.g. `pg_dump`) of all structured data, migration state and
   job/reminder state.
2. **Markdown root** — the notes directory as a filesystem snapshot/archive.

Requirements:

- Automated on a documented schedule.
- Retention policy (to be set in M9; suggest daily + weekly + monthly tiers).
- Integrity verification (checksum; restore into a scratch database periodically).
- Artifacts stored outside the primary volumes where possible.
- Built-in export (REQ-015) provides additional, human-readable portability. Projects, their tasks
  and their linked notes export as a versioned open JSON document at `GET /api/projects/export`
  (all projects) and `GET /api/projects/{id}/export` (one project); the format and its version
  contract are documented in `DECISIONS.md` ADR-0026. Note content remains on disk (it is already
  portable Markdown); the complete notes+tasks+projects export is the M9-03 full data export (§1.3),
  which is a *portability* artifact, **not** a replacement for the backups/restore above.

> Backing up only the database or only the files is insufficient and is treated as a defect.

### 1.1 Automated backups (M9-01 — implemented)

A durable background job (`backups.run`, ADR-0041) produces **one backup set** per run that captures
both stores together. A set is a directory named `atlas-backup-<UTC-timestamp>-<id>` under the
configured destination containing:

| File | Contents |
|---|---|
| `database.sql` | Plain-SQL PostgreSQL dump (`pg_dump --format=plain --no-owner --no-privileges`) |
| `notes.tar.gz` | A gzip archive of the whole Markdown notes root (in-flight `.atlas-tmp-*` files excluded) |
| `manifest.json` | The set's record: the two parts, their store, size and **SHA-256**, plus `created_at` |

The manifest contains **no** connection string, credential or absolute path.

**How a run is made safe.** The set is assembled in a `.staging/` directory. Only after
`manifest.json` is written and the set verifies against its own checksums is the directory
atomically renamed into the destination. A run that fails (or a worker that crashes) leaves a
staging directory **without** a manifest — reported as incomplete — and never a published set, so a
partial backup can never be mistaken for a good one.

**Configuration** (environment; defaults in parentheses):

| Variable | Meaning |
|---|---|
| `BACKUP_DIR` (`./data/backups`; `/data/atlas/backups` in the compose stack) | Destination directory. Nothing is written outside it. |
| `BACKUP_RETAIN` (`7`) | Keep the newest N sets; older published sets are pruned. |
| `BACKUP_INTERVAL_SECONDS` (`86400` = daily) | How often the worker runs a backup. |
| `BACKUP_STALE_SECONDS` (`3600`) | A run's lock older than this is treated as stale and the chain restarts. |
| `BACKUP_PG_DUMP_BINARY` (`pg_dump`) | Local client used when no container is set. |
| `BACKUP_PG_DUMP_CONTAINER` (blank) | When set (e.g. `atlas-db-1`), run `pg_dump` **inside** that container with `docker exec` — for hosts without a local PostgreSQL client. |

In the Docker Compose deployment the `worker` service mounts the `atlas-backups` volume at
`/data/atlas/backups` and the image installs the PostgreSQL client, so backups run out of the box.
Point `BACKUP_DIR` at a volume that is backed up separately (and ideally off the primary volume).

**Status in the web app (MU-08).** Settings shows a read-only summary: number of published sets, the newest
set's time and part sizes, interrupted staging runs and the newest scheduled-run status. The **API** reads
`BACKUP_DIR`, so it must see the same volume the worker writes (the Compose file mounts `atlas-backups` into
both). If it cannot, Settings says it cannot report instead of claiming there are no backups. It does not
re-verify checksums; use `atlas-backup verify`.

### 1.2 Running and checking a backup by hand

The `atlas-backup` command (also `python -m atlas.backups`) uses the same settings as the worker:

```bash
# Produce one set now (respects BACKUP_DIR / NOTES_ROOT / DATABASE_URL and the pg_dump backend).
atlas-backup run [--destination DIR] [--retain N]

# Verify a single set, or every published set in a destination (exit 1 on any failure).
atlas-backup verify [PATH]

# List published sets and flag incomplete staging leftovers.
atlas-backup list [PATH]
```

`verify` recomputes each part's SHA-256 and compares it with the manifest; it reports `FAILED` for a
tampered or missing part and `INCOMPLETE` for a staging directory left by an interrupted run. Use it
from a scheduled check (e.g. cron) against `BACKUP_DIR`; a non-zero exit means the set is not
trustworthy.

A backup proves the set is complete and internally consistent. Proving it **restores** is the M9-02
drill (§2), which is documented below as an operator runbook and was **executed** on 2026-10-27.

### 1.3 Full data export — portability, not a backup (M9-03 — implemented)

The **full data export** answers a different question from a backup: *"give me all of my data in
open formats so I can take it out of Atlas"* (REQ-015 data portability). It is **not** a backup and
**not** a substitute for §1/§2 — a backup exists to *restore the running system*; the export exists
to *leave*. A user can:

- **Download everything** from the running app: `GET /api/export` returns the authenticated user's
  entire workspace — their notes, tasks and projects — as a single `application/zip` download. It is
  strictly their own data (another account's data can never appear).
- **Produce a set on the server** with the operator `atlas-export` command (like `atlas-backup`):

```bash
# Produce one export set for an account (respects NOTES_ROOT / DATABASE_URL / EXPORT_DIR).
atlas-export run --user owner@example.com [--user-id UUID] [--destination DIR]

# Verify a set, or every set in a destination (exit 1 on any failure).
atlas-export verify [PATH]

# List published sets and flag incomplete staging leftovers.
atlas-export list [PATH]
```

Each export is a **set** — the directory `atlas-export-<UTC-timestamp>-<id>` — containing:

| File | Contents |
|---|---|
| `notes/` | Your notes as the **real `.md` files** at their workspace paths (byte-identical; open them with any editor) |
| `data.json` | Your **tasks and projects** as the versioned open `atlas.project-export` document (ADR-0026), plus the tasks that belong to no project |
| `notes.json` | The notes **metadata index**: per-note tags, wiki links and note↔project associations (no note content) |
| `manifest.json` | The set's record: format + version, `export_id`, timestamp and, for **every** file, its size and SHA-256 |

`atlas-export verify` re-derives each file's SHA-256 from the bytes on disk and compares it with the
manifest; it reports `FAILED` for a tampered or missing file and `INCOMPLETE` for a staging directory
left by an interrupted run. A set is complete only when its manifest is present and every checksum
matches. The format + version contract is `DECISIONS.md` **ADR-0042**.

The export reads one **consistent snapshot** (a single REPEATABLE READ transaction) so the
projects/tasks/notes graph cannot tear. It captures all live data and nothing else — soft-deleted
(tombstoned) rows are omitted, as an export is your *current* data. Nothing is written outside the
destination. Set `EXPORT_DIR` (default `./data/exports`) for the CLI's destination.

> **Do not use the export for disaster recovery.** To restore a running Atlas, use a backup set
> (§1) and the restore procedure (§2) — those capture the database *and* the notes together and are
> what a fresh install expects. The export is for portability, inspection and migration to other
> tools.


## 2. Restore Procedure

**Status: executed.** This procedure was run end to end as the M9-02 restore drill (2026-10-27): a
set produced by `atlas-backup run` was restored into a **scratch** PostgreSQL database and a
**scratch** notes directory, and the restored data was verified to match the source (notes
byte-identical; the known rows present; the schema applied cleanly). The exact commands and their real
output are recorded in `ACCEPTANCE.md` (M9-02). The two stores are always restored **together** — a
backup set is only complete with both (§1).

### 2.0 Preconditions

- A published, self-verifying backup set (§1). **Nothing is restored from an unverified set.**
- The `atlas-backup` command (`.venv/bin/atlas-backup`, or `python -m atlas.backups` in the image).
- A reachable PostgreSQL server plus a `psql` client — either local, or run inside the database
  container with `docker exec` (the same pattern the backup uses when `BACKUP_PG_DUMP_CONTAINER` is set).
- A **fresh, empty target database** and a **fresh notes directory**. Never restore over the running
  `atlas` database or the live notes root.
- For a production restore: a maintenance window, and the pre-restore backup retained for rollback.

### 2.1 Verify the set before restoring

```bash
SET="$(ls -d "$BACKUP_DIR"/atlas-backup-*/ | tail -1)"   # newest published set
atlas-backup verify "$SET"                                # exit 0 and every part "ok"
```

Expected: `ok $SET` with `database: ok` and `notes: ok` (exit 0). If the check fails, or a part is
missing, **stop** and use an older set — a failed set must never be restored. (`INCOMPLETE` names a
leftover staging directory from an interrupted run and is not a restorable set.)

### 2.2 Restore the database into a fresh database

Create an empty target database, then apply the plain-SQL dump. The dump is plain SQL, so `psql` is
the only tool needed (`pg_restore` is not required).

```bash
# 1. create a fresh, empty target database (example name; choose your own)
psql -U atlas -d postgres -c "CREATE DATABASE atlas_restore OWNER atlas;"

# 2. apply the dump — local client:
psql -U atlas -d atlas_restore -v ON_ERROR_STOP=1 < "$SET/database.sql"

#    ... or, as executed in the drill on a host without a local client, run it inside the DB container:
docker exec -i atlas-db-1 psql -U atlas -d atlas_restore -v ON_ERROR_STOP=1 < "$SET/database.sql"
```

`-v ON_ERROR_STOP=1` makes `psql` fail on the first error instead of continuing. Expected: exit 0 and
no `ERROR`/`FATAL` lines; the dump recreates the schema and loads the rows.

### 2.2a Tell sync clients about the restore (required once sync clients exist)

A restored database is older than what a sync client may already hold. The server cannot tell: if it has since accepted new
writes its change cursor may exceed the client's again and the client would silently skip changes. After the restored instance
is up, run once:

```bash
docker compose exec api atlas-admin record-restore      # or: atlas-admin record-restore
```

It rotates the instance `epoch` (stored in `instance_meta`, so it is part of every backup and restore). A sync client that
sends the old `Atlas-Epoch` gets `409 epoch_mismatch` and applies nothing until its user decides what to do (SYNC_PROTOCOL.md 7.4:
re-create what the server lost, with the user's confirmation). Browser sessions are not affected. Skipping this step on a server
that has sync clients risks silent divergence; it is harmless otherwise (idempotent, no data is touched).

### 2.3 Restore the notes

```bash
mkdir -p /path/to/restored-notes
tar -xzf "$SET/notes.tar.gz" -C /path/to/restored-notes
```

The archive preserves the notes-root layout (`.md` files and their folders) and excludes in-flight
`.atlas-tmp-*` files. Expected: exit 0; the tree matches the archived notes root.

### 2.4 Point Atlas at the restored data and start

```bash
# stop writers first so nothing changes under the restore
docker compose -f deploy/docker-compose.yml stop api worker

# Then map Atlas to the restored stores and start again. For a same-host replacement, move the
# restored notes into place and set DATABASE_URL to the restored database:
#   DATABASE_URL -> the restored database
#   NOTES_ROOT   -> the restored notes directory
docker compose -f deploy/docker-compose.yml up -d
curl -fsS http://localhost:8000/health   # -> ok
```

Stop `api` and `worker` before swapping the stores so no write lands mid-restore; start them again
only once the data is in place.

### 2.5 Verify the restore

```bash
# schema + migration state: the same head revision as the source
psql -U atlas -d atlas_restore -c "SELECT version_num FROM alembic_version;"

# known data is present (substitute a row you know)
psql -U atlas -d atlas_restore -c "SELECT id, title FROM tasks LIMIT 5;"

# notes are byte-identical to the source
diff -r /path/to/source-notes /path/to/restored-notes   # exit 0 => identical
```

A restore is verified when: `alembic_version` equals the source's head revision; the expected
rows/queries return; notes are byte-identical (`diff -r` exit 0); and the API health check passes and
the app loads the restored data. The M9-02 drill performed each of these against scratch targets.

### 2.6 Rollback

Restoring never overwrites the pre-restore state until §2.4 swaps the stores, so:

- Before §2.4, roll back by discarding the scratch database/directory — the live system is untouched.
- After §2.4, point `DATABASE_URL`/`NOTES_ROOT` back at the originals (or restore the pre-restore
  backup with this same procedure) and restart `api`/`worker`. Keep the pre-restore backup (§1) until
  the restored system is confirmed good.

**Rolling back an upgrade.** To undo a failing or unwanted schema change, follow the upgrade/rollback
runbook in `DEPLOYMENT.md` §6–§7: take a pre-upgrade backup (§1), then either `alembic downgrade`
when the migration is reversible, or restore that backup with this §2 procedure. Both paths were
executed on 2026-10-27 (M9-06; evidence in `ACCEPTANCE.md`).

**Calendar sync after a restore.** Sync state (the per-provider cursors) lives in the database
(`sync_cursors`) and is restored with it, so the next sync resumes from the stored cursor and is
idempotent (`ADR-0029`/`ADR-0031`) — no event is duplicated. *Confirming this against a real provider
needs the M5-00 real accounts (AR-001) and is `NOT RUN` here, recorded not waived.*

## 3. Monitoring

- Health endpoints polled (api, db, worker).
- Sync status surfaced in the UI: last success, connection state, pending changes, failures,
  conflicts. Users should not need to read logs to know sync stopped.
- Job queue: visible counts of pending/running/failed jobs.
- Disk space alerts for the notes and backup volumes.

## 4. Maintenance

- Log rotation and retention.
- Dependency updates reviewed against advisories (never suppressed).
- Periodic reconciliation of Markdown metadata vs. filesystem.
- Periodic verification that refresh tokens are still valid; surface re-auth needs in the UI.
- Database vacuum/statistics handled by PostgreSQL defaults; revisit if evidence requires.

## 5. Recovery Scenarios

| Scenario | Response |
|---|---|
| Worker crashed mid-sync | Jobs are durable; restart resumes; cursors unadvanced until commit |
| Expired/revoked OAuth token | UI prompts re-auth; no data loss; sync resumes after reconnect |
| Missed provider notification | Periodic reconciliation detects changes |
| Corrupted note file | Restore from conflict copy or backup; file is authoritative and recoverable |
| Failed migration | Roll back image + restore pre-upgrade backup (`DEPLOYMENT.md` §7) |
| Lost encryption key | OAuth credentials must be re-authorised (notes/tasks unaffected) |
| Forgotten password | On the server: `atlas-admin list-users`, then `atlas-admin reset-password --email <email>` (hidden prompt, 12+ characters, or the password on stdin when piped; never an argument). Every session of the account is signed out. Source tree: `cd services/api && .venv/bin/python -m atlas.auth.cli …` with the usual `DATABASE_URL`; Docker: `docker compose exec api atlas-admin …` |

## 6. Operational Non-Negotiables

- No destructive command against user data without a verified backup.
- Never expose the database or worker publicly to simplify testing.
- Never disable a security control to make an operation easier.
