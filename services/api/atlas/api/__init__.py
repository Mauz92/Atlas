"""API routers."""

from .auth import router as auth_router
from .calendar import router as calendar_router
from .changes import router as changes_router
from .export import router as export_router
from .health import router as health_router
from .instance import router as instance_router
from .notes import folders_router
from .notes import router as notes_router
from .notifications import router as notifications_router
from .projects import router as projects_router
from .resolutions import router as resolutions_router
from .search import router as search_router
from .tasks import router as tasks_router

__all__ = [
    "auth_router",
    "calendar_router",
    "changes_router",
    "export_router",
    "folders_router",
    "health_router",
    "instance_router",
    "notes_router",
    "notifications_router",
    "projects_router",
    "resolutions_router",
    "search_router",
    "tasks_router",
]
