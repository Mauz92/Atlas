"""Health and readiness endpoints (unauthenticated, contain no user data)."""

from __future__ import annotations

from fastapi import APIRouter
from sqlalchemy import text

from .. import __version__
from .deps import DbSession

router = APIRouter(tags=["health"])


@router.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok", "version": __version__}


@router.get("/health/ready")
async def ready(session: DbSession) -> dict[str, str]:
    try:
        await session.execute(text("SELECT 1"))
    except Exception:  # readiness must never raise
        return {"status": "degraded", "database": "unavailable"}
    return {"status": "ready", "database": "ok"}
