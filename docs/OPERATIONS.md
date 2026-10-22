# Atlas — Operations

**Status:** Draft for approval (Milestone 0)
**Last updated:** 2026-10-20

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
- Built-in export (REQ-015) provides additional, human-readable portability.

> Backing up only the database or only the files is insufficient and is treated as a defect.

## 2. Restore Procedure

Documented and **executed** as a test (M9):

1. Stop `api` and `worker`.
2. Restore the PostgreSQL dump into a fresh database.
3. Restore the Markdown root to the configured path.
4. Start services; verify health.
5. Verify data: notes present on disk, tasks/projects present, sync state consistent.
6. Re-verify calendar sync resumes without duplicating events.

Evidence of the executed drill is recorded in `ACCEPTANCE.md` (M9).

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
| Failed migration | Roll back image + restore pre-upgrade backup |
| Lost encryption key | OAuth credentials must be re-authorised (notes/tasks unaffected) |

## 6. Operational Non-Negotiables

- No destructive command against user data without a verified backup.
- Never expose the database or worker publicly to simplify testing.
- Never disable a security control to make an operation easier.
