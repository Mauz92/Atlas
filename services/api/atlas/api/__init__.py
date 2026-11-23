"""API routers."""

from .auth import router as auth_router
from .calendar import router as calendar_router
from .calendar_accounts import router as calendar_accounts_router
from .changes import router as changes_router
from .devices import router as devices_router
from .export import router as export_router
from .features import router as features_router
from .health import router as health_router
from .instance import router as instance_router
from .notes import folders_router
from .notes import router as notes_router
from .notifications import router as notifications_router
from .projects import router as projects_router
from .reminders import router as reminders_router
from .resolutions import router as resolutions_router
from .search import router as search_router
from .sync_wait import router as sync_wait_router
from .system_update import router as system_update_router
from .tasks import router as tasks_router
from .ttrpg import router as ttrpg_router

__all__ = [
    "auth_router",
    "calendar_accounts_router",
    "calendar_router",
    "changes_router",
    "devices_router",
    "export_router",
    "features_router",
    "folders_router",
    "health_router",
    "instance_router",
    "notes_router",
    "notifications_router",
    "projects_router",
    "reminders_router",
    "resolutions_router",
    "search_router",
    "sync_wait_router",
    "system_update_router",
    "tasks_router",
    "ttrpg_router",
]
