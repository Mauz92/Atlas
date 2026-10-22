"""API routers."""

from .auth import router as auth_router
from .health import router as health_router
from .notes import folders_router
from .notes import router as notes_router
from .tasks import router as tasks_router

__all__ = ["auth_router", "folders_router", "health_router", "notes_router", "tasks_router"]
