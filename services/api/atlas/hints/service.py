"""Registration, the coalesced emitter and the sender job of the sync hint (M8-04e).

Flow (SYNC_PROTOCOL.md 14.8): a commit that appended to the change feed enqueues **one** durable
``sync.hint`` job per (user, 30 s bucket, writer) in the same transaction; the job sends the
constant payload to every registered destination of the user except the device that wrote; failures
are retried a bounded number of times and then dropped (a hint is lossy by design: the next change,
the client's periodic sync and its foreground sync cover it); five consecutive failures open a
circuit breaker for five minutes. Nothing here can fail the request that caused the change.
"""

from __future__ import annotations

import logging
import time
import uuid
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING

from sqlalchemy import delete, exists, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from ..config import Settings, get_settings
from ..models import Device, DeviceHint, Job
from ..models.job import JobStatus
from .base import SYNC_HINT_TASK, HintGateway, HintOutcome, HintResult
from .ntfy import NtfyGateway
from .origin import (
    GatewayOrigin,
    InvalidGatewayConfigError,
    parse_gateway_origin,
    validate_endpoint,
)

if TYPE_CHECKING:
    from ..calendar.crypto import TokenCipher

logger = logging.getLogger("atlas.hints")

MAX_ATTEMPTS = 3
#: a hint is not sent the instant a change commits: a burst of edits collapses into one
SEND_DELAY = timedelta(seconds=5)
_SESSION_FLAG = "hint_enqueued_for"


class HintsDisabledError(RuntimeError):
    """The feature is off (or its gateway is not configured)."""


class HintRetryError(RuntimeError):
    """Some destination failed transiently; the durable job retries with backoff."""


# --- configuration ------------------------------------------------------------------------------


def configured_origin(settings: Settings | None = None) -> GatewayOrigin | None:
    """The operator's gateway origin when hints are enabled and the URL is usable, else ``None``."""
    s = settings or get_settings()
    if not s.sync_hint_enabled or not s.sync_hint_gateway_url.strip():
        return None
    try:
        return parse_gateway_origin(
            s.sync_hint_gateway_url,
            production=s.atlas_env == "production",
            allow_insecure_http=s.sync_hint_allow_insecure_http,
        )
    except InvalidGatewayConfigError:
        logger.warning("hints.gateway_config_invalid")  # the URL itself is not logged
        return None


_gateway_override: HintGateway | None = None


def set_gateway(gateway: HintGateway | None) -> None:
    """Install a gateway (tests); ``None`` restores the settings-built ntfy adapter."""
    global _gateway_override
    _gateway_override = gateway


def get_gateway(settings: Settings | None = None) -> HintGateway | None:
    if _gateway_override is not None:
        return _gateway_override
    s = settings or get_settings()
    origin = configured_origin(s)
    if origin is None:
        return None
    return NtfyGateway(origin, token=s.sync_hint_gateway_token, timeout=s.sync_hint_timeout_seconds)


# --- circuit breaker ----------------------------------------------------------------------------


@dataclass
class CircuitBreaker:
    """Five consecutive failures stop sending for five minutes (process-local, like the worker)."""

    threshold: int = 5
    cooldown: float = 300.0
    clock: Callable[[], float] = time.monotonic
    failures: int = 0
    opened_at: float | None = field(default=None)

    def allow(self) -> bool:
        if self.opened_at is None:
            return True
        if self.clock() - self.opened_at >= self.cooldown:
            self.opened_at, self.failures = None, self.threshold - 1  # half-open: one probe
            return True
        return False

    def record(self, *, ok: bool) -> None:
        if ok:
            self.failures, self.opened_at = 0, None
            return
        self.failures += 1
        if self.failures >= self.threshold:
            self.opened_at = self.clock()


breaker = CircuitBreaker()


# --- registration -------------------------------------------------------------------------------


def get_token_cipher() -> (
    TokenCipher
):  # imported lazily: the calendar package imports the job queue
    from ..calendar.crypto import get_token_cipher as _get

    return _get()


def _aad(device_id: uuid.UUID) -> bytes:
    return f"device-hint:{device_id}".encode()


async def register(
    session: AsyncSession, device_id: uuid.UUID, endpoint: str, *, kind: str = "unifiedpush"
) -> DeviceHint:
    """Store (replace) the device's destination. Raises :class:`HintsDisabledError` when off and
    :class:`~atlas.hints.origin.InvalidHintEndpointError` for an endpoint off the gateway."""
    origin = configured_origin()
    if origin is None:
        raise HintsDisabledError("sync hints are not enabled on this server")
    clean = validate_endpoint(endpoint, origin)
    cipher = get_token_cipher()
    sealed = cipher.encrypt(clean.encode(), aad=_aad(device_id))
    now = datetime.now(UTC)
    existing = await session.get(DeviceHint, device_id)
    if existing is None:
        existing = DeviceHint(
            device_id=device_id,
            kind=kind,
            endpoint_encrypted=sealed,
            key_id=cipher.active_key_id,
            endpoint_tail=clean[-4:],
        )
        session.add(existing)
    else:
        existing.kind = kind
        existing.endpoint_encrypted = sealed
        existing.key_id = cipher.active_key_id
        existing.endpoint_tail = clean[-4:]
        existing.updated_at = now
        existing.invalid_at = None
        existing.failures = 0
        existing.last_error_class = None
    await session.flush()
    return existing


async def unregister(session: AsyncSession, device_id: uuid.UUID) -> bool:
    removed = await session.execute(
        delete(DeviceHint).where(DeviceHint.device_id == device_id).returning(DeviceHint.device_id)
    )
    return removed.first() is not None


def open_endpoint(hint: DeviceHint) -> str:
    return (
        get_token_cipher()
        .decrypt(hint.endpoint_encrypted, key_id=hint.key_id, aad=_aad(hint.device_id))
        .decode()
    )


# --- emitter ------------------------------------------------------------------------------------


async def maybe_enqueue(
    session: AsyncSession, user_id: uuid.UUID, *, source: str = "change"
) -> bool:
    """Enqueue the coalesced hint job for ``user_id`` in this transaction. ``True`` when a new job
    was queued. Cheap when hints are off (settings read) and at most one check per user per
    session; a user with no registered destination costs one ``EXISTS``."""
    settings = get_settings()
    if not settings.sync_hint_enabled:
        return False
    flagged: set[str] = session.info.setdefault(_SESSION_FLAG, set())
    writer = session.info.get("device_id")
    marker = f"{user_id}:{writer}:{source}"
    if marker in flagged:
        return False
    flagged.add(marker)
    if configured_origin(settings) is None:
        return False
    has_destination = await session.scalar(
        select(
            exists().where(
                DeviceHint.device_id == Device.id,
                Device.user_id == user_id,
                Device.revoked_at.is_(None),
                DeviceHint.invalid_at.is_(None),
            )
        )
    )
    if not has_destination:
        return False
    interval = max(1, settings.sync_hint_min_interval_seconds)
    bucket = int(time.time()) // interval
    key = f"{SYNC_HINT_TASK}:{user_id}:{bucket}:{writer or source}"
    now = datetime.now(UTC)
    result = await session.execute(
        pg_insert(Job)
        .values(
            id=uuid.uuid4(),
            queue="default",
            task_name=SYNC_HINT_TASK,
            payload={"user_id": str(user_id), "exclude_device_id": str(writer) if writer else None},
            status=JobStatus.PENDING.value,
            priority=5,
            run_at=now + SEND_DELAY,
            max_attempts=MAX_ATTEMPTS,
            idempotency_key=key,
        )
        .on_conflict_do_nothing(index_elements=["idempotency_key"])
        .returning(Job.id)
    )
    return result.first() is not None


# --- sender -------------------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class SendSummary:
    delivered: int = 0
    invalid: int = 0
    retry: int = 0
    failed: int = 0
    skipped: int = 0


def _apply(hint: DeviceHint, result: HintResult, now: datetime) -> None:
    if result.outcome is HintOutcome.DELIVERED:
        hint.last_ok_at, hint.failures, hint.last_error_class = now, 0, None
    elif result.outcome is HintOutcome.INVALID:
        hint.invalid_at, hint.last_error_class = now, result.error_class
        hint.failures += 1
    else:
        hint.failures += 1
        hint.last_error_class = result.error_class


async def send_to(
    session: AsyncSession,
    hints: list[DeviceHint],
    gateway: HintGateway,
    *,
    gate: CircuitBreaker | None = None,
) -> SendSummary:
    """Send the constant hint to each destination; record the outcome on its row."""
    gate = gate if gate is not None else breaker
    counts = {"delivered": 0, "invalid": 0, "retry": 0, "failed": 0, "skipped": 0}
    now = datetime.now(UTC)
    for hint in hints:
        if not gate.allow():
            counts["skipped"] += 1
            continue
        try:
            endpoint = open_endpoint(hint)
        except Exception:  # an unreadable secret (key lost): disable, never log it
            hint.invalid_at, hint.last_error_class = now, "unreadable"
            counts["invalid"] += 1
            continue
        result = await gateway.send(endpoint)
        _apply(hint, result, now)
        gate.record(ok=result.outcome is HintOutcome.DELIVERED)
        counts[result.outcome.value] += 1
    await session.flush()
    return SendSummary(**counts)


async def run_hint_job(session: AsyncSession, payload: dict[str, object]) -> SendSummary:
    """The ``sync.hint`` job: deliver to the user's destinations except the writing device."""
    gateway = get_gateway()
    if gateway is None or not get_settings().sync_hint_enabled:
        return SendSummary()  # turned off after the job was queued: inert
    user_id = uuid.UUID(str(payload["user_id"]))
    exclude = payload.get("exclude_device_id")
    stmt = (
        select(DeviceHint)
        .join(Device, Device.id == DeviceHint.device_id)
        .where(
            Device.user_id == user_id,
            Device.revoked_at.is_(None),
            DeviceHint.invalid_at.is_(None),
        )
        .order_by(DeviceHint.device_id)
    )
    if exclude:
        stmt = stmt.where(DeviceHint.device_id != uuid.UUID(str(exclude)))
    hints = list(await session.scalars(stmt))
    summary = await send_to(session, hints, gateway)
    # keep the table small: finished hint jobs older than a day are of no use
    await session.execute(
        delete(Job).where(
            Job.task_name == SYNC_HINT_TASK,
            Job.status == JobStatus.SUCCEEDED.value,
            Job.updated_at < datetime.now(UTC) - timedelta(days=1),
        )
    )
    logger.info(
        "hints.sent",
        extra={
            "delivered": summary.delivered,
            "invalid": summary.invalid,
            "retry": summary.retry,
            "failed": summary.failed,
            "skipped": summary.skipped,
        },
    )
    if summary.retry:
        raise HintRetryError(f"{summary.retry} destination(s) unreachable")
    return summary
