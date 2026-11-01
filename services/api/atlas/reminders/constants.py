"""Reminder job task names (M8-01).

Kept in a leaf module (no imports) so both the job handlers and the reminder service can name the
durable tasks without an import cycle.
"""

from __future__ import annotations

#: The durable delivery job: fires one reminder exactly once at its ``remind_at`` instant.
REMINDER_DELIVER_TASK = "reminder.deliver"
#: The recurring scheduler scan: materialises reminders from entities and re-queues missed
#: deliveries.
REMINDERS_SCAN_TASK = "reminders.scan"

__all__ = ["REMINDERS_SCAN_TASK", "REMINDER_DELIVER_TASK"]
