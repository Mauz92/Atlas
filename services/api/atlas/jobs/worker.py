"""Background worker: registers handlers and drains the durable queue."""

from __future__ import annotations

import asyncio
import contextlib
import logging
import signal
import socket
import uuid
from collections.abc import Awaitable, Callable
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from ..db import dispose_engine, session_scope
from ..logging import configure_logging
from . import queue

Handler = Callable[[AsyncSession, dict[str, Any]], Awaitable[None]]

_HANDLERS: dict[str, Handler] = {}


def handler(task_name: str) -> Callable[[Handler], Handler]:
    def register(func: Handler) -> Handler:
        _HANDLERS[task_name] = func
        return func

    return register


def get_handler(task_name: str) -> Handler | None:
    return _HANDLERS.get(task_name)


@handler("noop")
async def _noop(_session: AsyncSession, _payload: dict[str, Any]) -> None:
    """A no-op task used by tests and as a liveness probe."""


async def run_once(worker_id: str, *, queue_name: str = "default") -> bool:
    """Process at most one job. Returns ``True`` if a job was handled."""
    async with session_scope() as session:
        job = await queue.claim_next(session, queue_name, worker_id)
        if job is None:
            return False
        handler_fn = get_handler(job.task_name)
        if handler_fn is None:
            await queue.mark_failed(
                session, job, f"no handler registered for {job.task_name!r}", retry=False
            )
            return True
        try:
            await handler_fn(session, job.payload)
        except Exception as exc:  # worker must not die on a job error
            await queue.mark_failed(session, job, f"{type(exc).__name__}: {exc}")
        else:
            await queue.mark_succeeded(session, job)
        return True


async def run_forever(
    *,
    queue_name: str = "default",
    poll_interval: float = 1.0,
    stop: asyncio.Event | None = None,
) -> None:
    worker_id = f"{socket.gethostname()}:{uuid.uuid4().hex[:8]}"
    stop = stop or asyncio.Event()
    logger = logging.getLogger("atlas.worker")

    with contextlib.suppress(Exception):  # startup must not die if the DB is not ready
        from .handlers import ensure_recurring_jobs

        async with session_scope() as session:
            await ensure_recurring_jobs(session)

    while not stop.is_set():
        try:
            handled = await run_once(worker_id, queue_name=queue_name)
        except Exception as exc:  # transient DB errors must not kill the worker
            logger.warning(
                "worker iteration failed, retrying",
                extra={"error": f"{type(exc).__name__}: {exc}"},
            )
            handled = False
        if not handled:
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(stop.wait(), timeout=poll_interval)


def main() -> None:
    configure_logging()
    stop = asyncio.Event()
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)

    def _request_stop(*_: object) -> None:
        loop.call_soon_threadsafe(stop.set)

    for sig in (signal.SIGINT, signal.SIGTERM):
        with contextlib.suppress(NotImplementedError):  # pragma: no cover - platform dependent
            loop.add_signal_handler(sig, _request_stop)

    async def _run() -> None:
        try:
            await run_forever(stop=stop)
        finally:
            await dispose_engine()

    try:
        loop.run_until_complete(_run())
    finally:
        loop.close()


if __name__ == "__main__":  # pragma: no cover
    main()
