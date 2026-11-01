"""Durable background job queue."""

from ..reminders.constants import REMINDER_DELIVER_TASK, REMINDERS_SCAN_TASK
from . import handlers  # noqa: F401  (import registers the built-in handlers)
from .handlers import (
    BACKUP_TASK,
    CALENDAR_RECONCILE_TASK,
    CHANGE_PURGE_TASK,
    RECONCILE_TASK,
    ensure_backup_job,
    ensure_calendar_reconcile_job,
    ensure_change_purge_job,
    ensure_note_reconcile_job,
    ensure_recurring_jobs,
    ensure_reminder_scan_job,
    schedule_next_backup,
    schedule_next_calendar_reconcile,
    schedule_next_change_purge,
    schedule_next_reminder_scan,
)
from .queue import backoff_delay, claim_next, enqueue, mark_failed, mark_succeeded
from .worker import handler, run_forever, run_once

__all__ = [
    "BACKUP_TASK",
    "CALENDAR_RECONCILE_TASK",
    "CHANGE_PURGE_TASK",
    "RECONCILE_TASK",
    "REMINDERS_SCAN_TASK",
    "REMINDER_DELIVER_TASK",
    "backoff_delay",
    "claim_next",
    "enqueue",
    "ensure_backup_job",
    "ensure_calendar_reconcile_job",
    "ensure_change_purge_job",
    "ensure_note_reconcile_job",
    "ensure_recurring_jobs",
    "ensure_reminder_scan_job",
    "handler",
    "mark_failed",
    "mark_succeeded",
    "run_forever",
    "run_once",
    "schedule_next_backup",
    "schedule_next_calendar_reconcile",
    "schedule_next_change_purge",
    "schedule_next_reminder_scan",
]
