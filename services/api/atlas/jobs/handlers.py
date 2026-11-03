"""Built-in job handlers. Importing this module registers them with the worker."""

from __future__ import annotations

import asyncio
import logging
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..changes import ChangePurgeService
from ..changes.retention import retention_cutoff
from ..config import get_settings
from ..idempotency import purge_expired
from ..models import Job, JobStatus, User
from ..notes import NotesReconciler, NotesStorage
from ..reminders.constants import REMINDER_DELIVER_TASK, REMINDERS_SCAN_TASK
from . import queue
from .worker import handler

logger = logging.getLogger("atlas.jobs")

RECONCILE_TASK = "notes.reconcile"
#: The durable periodic calendar reconciliation scan (M5-10). A scan re-syncs each due calendar
#: from its stored cursor, recovering any change a lost/never-received provider notification missed.
CALENDAR_RECONCILE_TASK = "calendar.reconcile"
#: The durable periodic change-feed purge (M7-02). It removes ``change_log`` rows older than the
#: retention window and advances each user's purge floor, bounding the feed's tombstone history
#: without ever deleting a user's entity rows.
CHANGE_PURGE_TASK = "changes.purge"
#: The durable periodic backup (M9-01). Each run captures both durable stores — a PostgreSQL dump
#: and an archive of the Markdown notes root — into one checksummed, self-verified backup set.
BACKUP_TASK = "backups.run"


@handler(RECONCILE_TASK)
async def reconcile_notes(session: AsyncSession, _payload: dict[str, Any]) -> None:
    """Scan the notes root and bring the index back in line with the filesystem."""
    storage = NotesStorage(get_settings().notes_root)
    users = (await session.scalars(select(User).where(User.is_active.is_(True)))).all()
    for user in users:
        summary = await NotesReconciler(session, user.id, storage).run()
        if summary.added or summary.updated or summary.removed:
            logger.info(
                "notes reconciled",
                extra={
                    "user_id": str(user.id),
                    "added": summary.added,
                    "updated": summary.updated,
                    "removed": summary.removed,
                },
            )
    await schedule_next_reconcile(session)


@handler(CALENDAR_RECONCILE_TASK)
async def reconcile_calendars(session: AsyncSession, _payload: dict[str, Any]) -> None:
    """Scan every connected calendar and re-sync the ones due, from their stored cursors.

    The periodic fallback for lost change notifications (M5-10; AGENTS.md §10): a scan is safe to
    run at any time, is idempotent, and never replaces the cursor — the M5-06 pass still advances it
    only after the changes commit. Imported lazily so ``atlas.calendar`` (which imports the job
    queue for its backoff helper) does not create an import cycle with this module.
    """
    from ..calendar.reconcile import CalendarReconciliationService

    summary = await CalendarReconciliationService(session).scan()
    if summary.synced or summary.failed or summary.unavailable:
        logger.info(
            "calendars reconciled",
            extra={
                "accounts": summary.accounts,
                "considered": summary.considered,
                "synced": summary.synced,
                "failed": summary.failed,
                "skipped": summary.skipped,
                "unavailable": summary.unavailable,
            },
        )
    await schedule_next_calendar_reconcile(session)


async def schedule_next_reconcile(
    session: AsyncSession, *, delay_seconds: int | None = None
) -> None:
    interval = delay_seconds or get_settings().notes_reconcile_seconds
    when = datetime.now(UTC) + timedelta(seconds=interval)
    await queue.enqueue(
        session,
        RECONCILE_TASK,
        {},
        run_at=when,
        idempotency_key=f"{RECONCILE_TASK}:{int(when.timestamp())}",
    )


async def schedule_next_calendar_reconcile(
    session: AsyncSession, *, delay_seconds: int | None = None
) -> None:
    """Queue the next calendar reconciliation scan ``delay_seconds`` from now."""
    interval = delay_seconds or get_settings().calendar_reconcile_seconds
    when = datetime.now(UTC) + timedelta(seconds=interval)
    await queue.enqueue(
        session,
        CALENDAR_RECONCILE_TASK,
        {},
        run_at=when,
        idempotency_key=f"{CALENDAR_RECONCILE_TASK}:{int(when.timestamp())}",
    )


@handler(CHANGE_PURGE_TASK)
async def purge_change_log(session: AsyncSession, _payload: dict[str, Any]) -> None:
    """Bound the change feed's history, then queue the next purge (M7-02).

    Removes deletion tombstones older than ``change_retention_days`` from ``change_log`` (upserts
    are kept, SYNC-03e), advances each affected user's purge floor, and deletes idempotency keys
    older than the same window - never a user's entity rows. Safe to run at any time and
    idempotent: a second pass over the same window removes nothing and leaves the floors
    unchanged. The handler
    runs in the caller's transaction, so a crash either purges the whole batch or none of it
    (restart-safe), and re-queues the next purge so the chain survives a worker restart together
    with :func:`ensure_change_purge_job`.
    """
    cutoff = retention_cutoff(datetime.now(UTC), get_settings().change_retention_days)
    summary = await ChangePurgeService(session).purge(cutoff=cutoff)
    keys = await purge_expired(session, cutoff=cutoff)
    if keys:
        logger.info("idempotency keys purged", extra={"purged": keys})
    if summary.purged:
        logger.info(
            "change log purged",
            extra={
                "purged": summary.purged,
                "users": summary.users_advanced,
                "cutoff": summary.cutoff.isoformat(),
            },
        )
    await schedule_next_change_purge(session)


async def schedule_next_change_purge(
    session: AsyncSession, *, delay_seconds: int | None = None
) -> None:
    """Queue the next change-feed purge ``delay_seconds`` from now (default: the purge interval).

    ``delay_seconds=0`` schedules immediately (unlike the reconcile helpers, which treat ``0`` as
    "use the configured interval"), so the chain can be started promptly at worker startup.
    """
    interval = (
        get_settings().change_purge_interval_seconds if delay_seconds is None else delay_seconds
    )
    when = datetime.now(UTC) + timedelta(seconds=interval)
    await queue.enqueue(
        session,
        CHANGE_PURGE_TASK,
        {},
        run_at=when,
        idempotency_key=f"{CHANGE_PURGE_TASK}:{int(when.timestamp())}",
    )


@handler(BACKUP_TASK)
async def run_backup_job(session: AsyncSession, _payload: dict[str, Any]) -> None:
    """Produce one backup set covering both durable stores, then queue the next run (M9-01).

    The dump, the notes archive and the checksums are blocking I/O, so they run in a worker thread
    rather than the event loop. The service assembles the set in staging and publishes it only once
    it has verified itself, so a partial run never appears as a good backup; a failure raises, which
    the durable queue retries with backoff and records in ``last_error``. Imported lazily so the
    backup module's dependencies are not pulled in unless a backup actually runs.
    """
    from ..backups import BackupService

    success = await asyncio.to_thread(lambda: BackupService.from_settings().run())
    logger.info(
        "backup completed",
        extra={
            "backup_id": success.backup_id,
            "directory": str(success.directory),
            "notes_files": success.notes_files,
            "database_bytes": success.database_bytes,
            "notes_bytes": success.notes_bytes,
        },
    )
    await schedule_next_backup(session)


async def schedule_next_backup(session: AsyncSession, *, delay_seconds: int | None = None) -> None:
    """Queue the next backup ``delay_seconds`` from now (default: the backup interval).

    ``delay_seconds=0`` schedules immediately, so the chain can be started promptly at worker
    startup.
    """
    interval = get_settings().backup_interval_seconds if delay_seconds is None else delay_seconds
    when = datetime.now(UTC) + timedelta(seconds=interval)
    await queue.enqueue(
        session,
        BACKUP_TASK,
        {},
        run_at=when,
        idempotency_key=f"{BACKUP_TASK}:{int(when.timestamp())}",
    )


@handler(REMINDER_DELIVER_TASK)
async def deliver_reminder_job(session: AsyncSession, payload: dict[str, Any]) -> None:
    """Deliver one reminder exactly once (M8-01).

    Idempotent: a retried or stale job (superseded by a reschedule, or a re-run after a restart)
    finds the reminder already ``sent`` or the delivery record present and does nothing. A transport
    failure raises, so the durable job retries with backoff. Imported lazily so ``atlas.reminders``
    (which imports the job queue) does not create an import cycle with this module.
    """
    from ..reminders.delivery import deliver_reminder

    reminder_id = uuid.UUID(str(payload["reminder_id"]))
    raw_remind_at = payload.get("remind_at")
    expected = datetime.fromisoformat(raw_remind_at) if raw_remind_at else None
    outcome = await deliver_reminder(session, reminder_id, expected_remind_at=expected)
    logger.info(
        "reminder processed",
        extra={
            "reminder_id": str(reminder_id),
            "delivered": outcome.delivered,
            "reason": outcome.reason,
        },
    )


@handler(REMINDERS_SCAN_TASK)
async def scan_reminders_job(session: AsyncSession, _payload: dict[str, Any]) -> None:
    """Sweep reminders, then queue the next sweep (M8-01).

    Re-materialises a reminder for every eligible task and re-queues any missed delivery, so the
    schedule self-heals after a restart or a missed fire time (AGENTS.md §4). Runs in the caller's
    transaction and is idempotent, so a crash either does the whole sweep or none of it.
    """
    from ..reminders.service import scan_reminders

    summary = await scan_reminders(session)
    if summary.scheduled or summary.cancelled or summary.dispatched:
        logger.info(
            "reminders scanned",
            extra={
                "considered": summary.considered,
                "scheduled": summary.scheduled,
                "cancelled": summary.cancelled,
                "dispatched": summary.dispatched,
            },
        )
    await schedule_next_reminder_scan(session)


async def schedule_next_reminder_scan(
    session: AsyncSession, *, delay_seconds: int | None = None
) -> None:
    """Queue the next reminder sweep ``delay_seconds`` from now (default: the sweep interval).

    ``delay_seconds=0`` schedules immediately, so the chain can be started promptly at worker
    startup.
    """
    interval = get_settings().reminder_scan_seconds if delay_seconds is None else delay_seconds
    when = datetime.now(UTC) + timedelta(seconds=interval)
    await queue.enqueue(
        session,
        REMINDERS_SCAN_TASK,
        {},
        run_at=when,
        idempotency_key=f"{REMINDERS_SCAN_TASK}:{int(when.timestamp())}",
    )


async def ensure_recurring_jobs(session: AsyncSession) -> None:
    """Start each recurring job chain if it is not already live."""
    await ensure_note_reconcile_job(session)
    await ensure_calendar_reconcile_job(session)
    await ensure_change_purge_job(session)
    await ensure_reminder_scan_job(session)
    await ensure_backup_job(session)


async def ensure_note_reconcile_job(session: AsyncSession) -> None:
    """Start the notes reconciliation chain if no reconcile job is already queued."""
    existing = await session.scalar(
        select(Job.id).where(
            Job.task_name == RECONCILE_TASK,
            Job.status.in_([JobStatus.PENDING.value, JobStatus.RUNNING.value]),
        )
    )
    if existing is None:
        await schedule_next_reconcile(session, delay_seconds=0)


async def ensure_calendar_reconcile_job(session: AsyncSession) -> None:
    """Start the calendar reconciliation chain if no *live* scan is queued or running.

    Restart safety (AGENTS.md §10, M5-10): a scan that was interrupted leaves its durable job
    ``running``; once its lock is older than ``calendar_sync_stale_seconds`` it is treated as dead —
    reaped (marked failed) — and a fresh scan is queued. The fresh scan re-syncs from the stored
    cursors, so the interrupted work is neither lost nor duplicated.
    """
    stale_before = datetime.now(UTC) - timedelta(seconds=get_settings().calendar_sync_stale_seconds)
    jobs = (
        await session.scalars(
            select(Job).where(
                Job.task_name == CALENDAR_RECONCILE_TASK,
                Job.status.in_([JobStatus.PENDING.value, JobStatus.RUNNING.value]),
            )
        )
    ).all()
    live = False
    for job in jobs:
        if job.status == JobStatus.RUNNING.value and (
            job.locked_at is None or job.locked_at < stale_before
        ):
            await queue.mark_failed(
                session, job, "stale lock: worker restarted mid-scan", retry=False
            )
            continue
        live = True
    if not live:
        await schedule_next_calendar_reconcile(session, delay_seconds=0)


async def ensure_change_purge_job(session: AsyncSession) -> None:
    """Start the change-feed purge chain if no *live* purge is queued or running.

    Restart safety (AGENTS.md §10): a purge interrupted by a worker restart leaves its durable job
    ``running``; once its lock is older than ``change_purge_stale_seconds`` it is treated as dead —
    reaped (marked failed) — and a fresh purge is queued. The purge is idempotent, so re-running the
    interrupted window is neither lost work nor duplicated.
    """
    stale_before = datetime.now(UTC) - timedelta(seconds=get_settings().change_purge_stale_seconds)
    jobs = (
        await session.scalars(
            select(Job).where(
                Job.task_name == CHANGE_PURGE_TASK,
                Job.status.in_([JobStatus.PENDING.value, JobStatus.RUNNING.value]),
            )
        )
    ).all()
    live = False
    for job in jobs:
        if job.status == JobStatus.RUNNING.value and (
            job.locked_at is None or job.locked_at < stale_before
        ):
            await queue.mark_failed(
                session, job, "stale lock: worker restarted mid-purge", retry=False
            )
            continue
        live = True
    if not live:
        await schedule_next_change_purge(session, delay_seconds=0)


async def ensure_reminder_scan_job(session: AsyncSession) -> None:
    """Start the reminder sweep chain if no *live* sweep is queued or running (M8-01).

    Restart safety (AGENTS.md §4): a sweep interrupted by a worker restart leaves its durable job
    ``running``; once its lock is older than ``reminder_scan_stale_seconds`` it is treated as dead —
    reaped (marked failed) — and a fresh sweep is queued. The sweep is idempotent, so re-running the
    interrupted work is neither lost nor duplicated.
    """
    stale_before = datetime.now(UTC) - timedelta(seconds=get_settings().reminder_scan_stale_seconds)
    jobs = (
        await session.scalars(
            select(Job).where(
                Job.task_name == REMINDERS_SCAN_TASK,
                Job.status.in_([JobStatus.PENDING.value, JobStatus.RUNNING.value]),
            )
        )
    ).all()
    live = False
    for job in jobs:
        if job.status == JobStatus.RUNNING.value and (
            job.locked_at is None or job.locked_at < stale_before
        ):
            await queue.mark_failed(
                session, job, "stale lock: worker restarted mid-sweep", retry=False
            )
            continue
        live = True
    if not live:
        await schedule_next_reminder_scan(session, delay_seconds=0)


async def ensure_backup_job(session: AsyncSession) -> None:
    """Start the backup chain if no *live* backup is queued or running (M9-01).

    Restart safety (AGENTS.md §4): a backup interrupted by a worker restart leaves its durable job
    ``running``; once its lock is older than ``backup_stale_seconds`` it is treated as dead — reaped
    (marked failed) — and a fresh backup is queued. The interrupted run left no published set (it is
    only published once verified), so re-running neither loses nor duplicates data.
    """
    stale_before = datetime.now(UTC) - timedelta(seconds=get_settings().backup_stale_seconds)
    jobs = (
        await session.scalars(
            select(Job).where(
                Job.task_name == BACKUP_TASK,
                Job.status.in_([JobStatus.PENDING.value, JobStatus.RUNNING.value]),
            )
        )
    ).all()
    live = False
    for job in jobs:
        if job.status == JobStatus.RUNNING.value and (
            job.locked_at is None or job.locked_at < stale_before
        ):
            await queue.mark_failed(
                session, job, "stale lock: worker restarted mid-backup", retry=False
            )
            continue
        live = True
    if not live:
        await schedule_next_backup(session, delay_seconds=0)
