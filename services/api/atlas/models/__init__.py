"""ORM models. Importing this package registers all tables on ``Base.metadata``."""

from .base import TimestampMixin
from .calendar import ExternalEvent, SyncCursor
from .change import ChangeLog
from .credential import CredentialProvider, ProviderCredential
from .idempotency import IdempotencyKey
from .job import Job, JobStatus
from .note import NoteIndex, NoteLink, NoteTag, Tag
from .notification import NotificationDevice, PushChannel
from .project import NoteProject, Project, ProjectStatus
from .reminder import (
    Reminder,
    ReminderDelivery,
    ReminderEntityType,
    ReminderPolicy,
    ReminderStatus,
)
from .session import AuthSession
from .task import RecurrenceSeries, Task, TaskLink, TaskPriority, TaskStatus, TaskTag
from .user import User

__all__ = [
    "AuthSession",
    "ChangeLog",
    "CredentialProvider",
    "ExternalEvent",
    "IdempotencyKey",
    "Job",
    "JobStatus",
    "NoteIndex",
    "NoteLink",
    "NoteProject",
    "NoteTag",
    "NotificationDevice",
    "Project",
    "ProjectStatus",
    "ProviderCredential",
    "PushChannel",
    "RecurrenceSeries",
    "Reminder",
    "ReminderDelivery",
    "ReminderEntityType",
    "ReminderPolicy",
    "ReminderStatus",
    "SyncCursor",
    "Tag",
    "Task",
    "TaskLink",
    "TaskPriority",
    "TaskStatus",
    "TaskTag",
    "TimestampMixin",
    "User",
]
