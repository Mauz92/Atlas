"""Built-in job handlers. Importing this module registers them with the worker."""

from __future__ import annotations

import logging
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..config import get_settings
from ..models import Job, JobStatus, User
from ..notes import NotesReconciler, NotesStorage
from . import queue
from .worker import handler

logger = logging.getLogger("atlas.jobs")

RECONCILE_TASK = "notes.reconcile"


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


async def ensure_recurring_jobs(session: AsyncSession) -> None:
    """Start the reconciliation chain if no reconcile job is already queued."""
    existing = await session.scalar(
        select(Job.id).where(
            Job.task_name == RECONCILE_TASK,
            Job.status.in_([JobStatus.PENDING.value, JobStatus.RUNNING.value]),
        )
    )
    if existing is None:
        await schedule_next_reconcile(session, delay_seconds=0)
