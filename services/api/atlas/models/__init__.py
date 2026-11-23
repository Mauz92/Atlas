"""ORM models. Importing this package registers all tables on ``Base.metadata``."""

from .base import TimestampMixin
from .calendar import CalendarSource, ExternalEvent, OAuthState, SyncCursor
from .change import ChangeLog
from .credential import CredentialProvider, ProviderCredential
from .device import Device
from .feature import UserFeature
from .hint import DeviceHint
from .idempotency import IdempotencyKey
from .instance import InstanceMeta
from .job import Job, JobStatus
from .note import NoteIndex, NoteLink, NoteRevision, NoteTag, Tag
from .notification import NotificationDevice, PushChannel
from .project import NoteProject, Project, ProjectStatus
from .recovery import RecoveryCode
from .reminder import (
    Reminder,
    ReminderDelivery,
    ReminderEntityType,
    ReminderPolicy,
    ReminderStatus,
)
from .resolution import SyncResolution
from .session import AuthSession
from .task import RecurrenceSeries, Task, TaskLink, TaskPriority, TaskStatus, TaskTag
from .ttrpg import (
    TtrpgCampaign,
    TtrpgCombatAction,
    TtrpgCombatant,
    TtrpgCombatRun,
    TtrpgCreature,
    TtrpgEncounter,
    TtrpgEncounterSlot,
    TtrpgPartyMember,
    TtrpgPartyState,
    TtrpgSession,
)
from .user import User

__all__ = [
    "AuthSession",
    "CalendarSource",
    "ChangeLog",
    "CredentialProvider",
    "Device",
    "DeviceHint",
    "ExternalEvent",
    "IdempotencyKey",
    "InstanceMeta",
    "Job",
    "JobStatus",
    "NoteIndex",
    "NoteLink",
    "NoteProject",
    "NoteRevision",
    "NoteTag",
    "NotificationDevice",
    "OAuthState",
    "Project",
    "ProjectStatus",
    "ProviderCredential",
    "PushChannel",
    "RecoveryCode",
    "RecurrenceSeries",
    "Reminder",
    "ReminderDelivery",
    "ReminderEntityType",
    "ReminderPolicy",
    "ReminderStatus",
    "SyncCursor",
    "SyncResolution",
    "Tag",
    "Task",
    "TaskLink",
    "TaskPriority",
    "TaskStatus",
    "TaskTag",
    "TimestampMixin",
    "TtrpgCampaign",
    "TtrpgCombatAction",
    "TtrpgCombatRun",
    "TtrpgCombatant",
    "TtrpgCreature",
    "TtrpgEncounter",
    "TtrpgEncounterSlot",
    "TtrpgPartyMember",
    "TtrpgPartyState",
    "TtrpgSession",
    "User",
    "UserFeature",
]
