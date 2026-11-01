"""Durable reminders (M8-01).

Public surface: the pure scheduling rules, the notifier abstraction and the scheduling service the
API and the job handlers use.
"""

from .constants import REMINDER_DELIVER_TASK, REMINDERS_SCAN_TASK
from .delivery import DeliveryOutcome, ReminderDeliveryError, deliver_reminder
from .notifier import (
    DeliveryResult,
    LoggingNotifier,
    Notifier,
    NotifierError,
    PushSubscription,
    RecordingNotifier,
    ReminderMessage,
    get_notifier,
    reset_notifier,
    set_notifier,
)
from .preferences import (
    DEFAULT_POLICY_NAME,
    MAX_DAYS_BEFORE,
    InvalidReminderTimingError,
    ReminderPreferencesService,
    ReminderTiming,
    TaskReminderState,
    canonical_name,
    format_at_time,
    parse_at_time,
    timing_of,
)
from .push import PushSender, configure_notifier
from .schedule import (
    DEFAULT_AT_TIME,
    DELIVERABLE_STATUSES,
    InvalidReminderRuleError,
    ReminderRule,
    is_deliverable,
    remind_at_for,
)
from .service import (
    ReminderScanSummary,
    ReminderService,
    cancel_for_task,
    delivery_job_key,
    ensure_delivery_job,
    resolve_policy,
    scan_reminders,
    sync_task,
)

__all__ = [
    "DEFAULT_AT_TIME",
    "DEFAULT_POLICY_NAME",
    "DELIVERABLE_STATUSES",
    "MAX_DAYS_BEFORE",
    "REMINDERS_SCAN_TASK",
    "REMINDER_DELIVER_TASK",
    "DeliveryOutcome",
    "DeliveryResult",
    "InvalidReminderRuleError",
    "InvalidReminderTimingError",
    "LoggingNotifier",
    "Notifier",
    "NotifierError",
    "PushSender",
    "PushSubscription",
    "RecordingNotifier",
    "ReminderDeliveryError",
    "ReminderMessage",
    "ReminderPreferencesService",
    "ReminderRule",
    "ReminderScanSummary",
    "ReminderService",
    "ReminderTiming",
    "TaskReminderState",
    "cancel_for_task",
    "canonical_name",
    "configure_notifier",
    "deliver_reminder",
    "delivery_job_key",
    "ensure_delivery_job",
    "format_at_time",
    "get_notifier",
    "is_deliverable",
    "parse_at_time",
    "remind_at_for",
    "reset_notifier",
    "resolve_policy",
    "scan_reminders",
    "set_notifier",
    "sync_task",
    "timing_of",
]
