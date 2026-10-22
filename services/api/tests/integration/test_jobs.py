import pytest
from sqlalchemy import func, update
from sqlalchemy.exc import IntegrityError

from atlas.db import session_scope
from atlas.jobs import queue, worker
from atlas.models import Job

pytestmark = pytest.mark.usefixtures("_db")


async def test_enqueue_claim_and_complete() -> None:
    async with session_scope() as session:
        job = await queue.enqueue(session, "noop", {"a": 1})
        assert job.status == "pending"
        assert job.attempts == 0

    async with session_scope() as session:
        claimed = await queue.claim_next(session, "default", "worker-1")
        assert claimed is not None
        assert claimed.status == "running"
        assert claimed.attempts == 1
        await queue.mark_succeeded(session, claimed)

    async with session_scope() as session:
        assert await queue.claim_next(session, "default", "worker-1") is None


async def test_run_once_executes_registered_handler() -> None:
    async with session_scope() as session:
        await queue.enqueue(session, "noop")

    assert await worker.run_once("worker-1") is True
    assert await worker.run_once("worker-1") is False


async def test_unknown_handler_is_failed() -> None:
    async with session_scope() as session:
        await queue.enqueue(session, "does-not-exist")

    assert await worker.run_once("worker-1") is True
    async with session_scope() as session:
        job = (await session.execute(Job.__table__.select())).mappings().one()
        assert job["status"] == "failed"
        assert "no handler" in (job["last_error"] or "")


async def test_failure_retries_then_fails() -> None:
    async with session_scope() as session:
        job = await queue.enqueue(session, "noop", max_attempts=2)
        job_id = job.id

    async with session_scope() as session:
        claimed = await queue.claim_next(session, "default", "worker-1")
        assert claimed is not None
        assert await queue.mark_failed(session, claimed, "boom") is True
        assert claimed.status == "pending"
        assert claimed.last_error == "boom"

    async with session_scope() as session:
        await session.execute(update(Job).where(Job.id == job_id).values(run_at=func.now()))

    async with session_scope() as session:
        claimed = await queue.claim_next(session, "default", "worker-1")
        assert claimed is not None
        assert claimed.attempts == 2
        assert await queue.mark_failed(session, claimed, "boom again") is False
        assert claimed.status == "failed"


async def test_idempotency_key_is_unique() -> None:
    async with session_scope() as session:
        await queue.enqueue(session, "noop", idempotency_key="dedupe-1")

    with pytest.raises(IntegrityError):
        async with session_scope() as session:
            await queue.enqueue(session, "noop", idempotency_key="dedupe-1")


async def test_future_jobs_are_not_claimed() -> None:
    from datetime import UTC, datetime, timedelta

    async with session_scope() as session:
        await queue.enqueue(session, "noop", run_at=datetime.now(UTC) + timedelta(hours=1))

    async with session_scope() as session:
        assert await queue.claim_next(session, "default", "worker-1") is None
