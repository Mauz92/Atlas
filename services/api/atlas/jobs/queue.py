"""Durable job queue operations (PostgreSQL, ``SKIP LOCKED``).

The schema and these functions form a stable interface; a different queue backend can be
substituted without changing callers (ADR-0005).
"""

from __future__ import annotations

import random
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..models.job import Job, JobStatus

_BACKOFF_BASE_SECONDS = 5.0
_BACKOFF_MAX_SECONDS = 900.0


def backoff_delay(attempt: int, *, base: float = _BACKOFF_BASE_SECONDS) -> float:
    """Bounded exponential backoff with jitter (attempt is 1-based)."""
    exponent = max(attempt - 1, 0)
    raw = min(base * (2.0**exponent), _BACKOFF_MAX_SECONDS)
    jitter = 0.5 + random.random() / 2
    return float(raw * jitter)


async def enqueue(
    session: AsyncSession,
    task_name: str,
    payload: dict[str, Any] | None = None,
    *,
    queue: str = "default",
    run_at: datetime | None = None,
    priority: int = 0,
    max_attempts: int = 5,
    idempotency_key: str | None = None,
) -> Job:
    job = Job(
        queue=queue,
        task_name=task_name,
        payload=payload or {},
        status=JobStatus.PENDING.value,
        priority=priority,
        run_at=run_at or datetime.now(UTC),
        max_attempts=max_attempts,
        idempotency_key=idempotency_key,
    )
    session.add(job)
    await session.flush()
    return job


async def claim_next(session: AsyncSession, queue: str, worker_id: str) -> Job | None:
    """Atomically claim one due job, or return ``None``."""
    stmt = (
        select(Job)
        .where(
            Job.queue == queue,
            Job.status == JobStatus.PENDING.value,
            Job.run_at <= func.now(),
        )
        .order_by(Job.priority.desc(), Job.run_at.asc())
        .limit(1)
        .with_for_update(skip_locked=True)
    )
    job = (await session.execute(stmt)).scalar_one_or_none()
    if job is None:
        return None
    job.status = JobStatus.RUNNING.value
    job.locked_by = worker_id
    job.locked_at = datetime.now(UTC)
    job.attempts += 1
    await session.flush()
    return job


async def mark_succeeded(session: AsyncSession, job: Job) -> None:
    job.status = JobStatus.SUCCEEDED.value
    job.locked_by = None
    job.locked_at = None
    job.last_error = None
    await session.flush()


async def mark_failed(
    session: AsyncSession,
    job: Job,
    error: str,
    *,
    now: datetime | None = None,
    retry: bool = True,
) -> bool:
    """Record a failure. Returns ``True`` if a retry was scheduled.

    ``retry=False`` marks a permanent failure immediately (e.g. a missing handler).
    """
    job.last_error = error[:2000]
    job.locked_by = None
    job.locked_at = None
    if retry and job.attempts < job.max_attempts:
        delay = backoff_delay(job.attempts)
        job.status = JobStatus.PENDING.value
        job.run_at = (now or datetime.now(UTC)) + timedelta(seconds=delay)
        await session.flush()
        return True
    job.status = JobStatus.FAILED.value
    await session.flush()
    return False
