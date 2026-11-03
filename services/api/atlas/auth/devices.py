"""Device credentials: tokens, lookup, rotation and revocation (SYNC-06, ADR-0059 D8, ADR-0065).

A device token is 256 random bits behind a recognisable prefix (``atd_``, so a secret scanner can
find a leaked one and a session cookie value is never mistaken for it). Only its SHA-256 is stored.
The token is returned once, by the endpoint that creates or rotates it, and appears in no log, no
error message and no URL. All lookups are by hash; the comparison that follows is constant time
even though the hash lookup already makes a timing attack on the token itself impractical.

``revoke_all_devices`` is the single function every "sign everything out" path calls: a password
reset (``atlas-admin reset-password`` today, the recovery flow of AUTH-01 later), the optional
"also sign out my devices" of a password change, and the Settings button.

Time: every expiry here is decided by the **server** clock (``now()`` in the database). A device
clock is never read (ADR-0059 D11).
"""

from __future__ import annotations

import hashlib
import hmac
import logging
import re
import secrets
import time
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from sqlalchemy import and_, delete, func, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.requests import Request

from ..config import get_settings
from ..db import get_session_factory
from ..models import Device
from .ratelimit import RateLimiter

logger = logging.getLogger("atlas.auth.devices")

TOKEN_PREFIX = "atd_"
_TOKEN_BYTES = 32
#: the token as issued: prefix + 43 URL-safe base64 characters; anything else is not looked up
_TOKEN_SHAPE = re.compile(r"^atd_[A-Za-z0-9_-]{43}$")

#: how long the previous token keeps working after a rotation (the response may have been lost)
ROTATION_GRACE = timedelta(hours=24)
#: ``last_seen_at`` is written at most this often per device (one cheap UPDATE per interval)
TOUCH_INTERVAL_SECONDS = 300
#: a user keeps at most this many unrevoked devices (a bound on the table and on the blast radius)
MAX_ACTIVE_DEVICES = 25

#: per-device request budgets after authentication (``SYNC_PROTOCOL.md`` 8.3), not per IP
device_request_limiter = RateLimiter(limit=600, per_seconds=60)
device_write_limiter = RateLimiter(limit=120, per_seconds=60)

_last_touch: dict[uuid.UUID, float] = {}
#: devices whose spent previous token is being cleared right now (one writer at a time)
_clearing: set[uuid.UUID] = set()


def bearer_token(request: Request) -> str | None:
    """The bearer token of the request, or ``None`` when it does not use one.

    Only the ``Bearer`` scheme counts: another scheme (a reverse proxy's Basic auth, say) is not
    ours and is ignored, so the cookie path keeps working behind such a proxy. A request that
    presents a bearer token is authenticated by it **alone**: its cookies are never consulted, so
    an ambient browser credential can neither rescue a bad token nor widen a good one (and the CSRF
    check, which exists for ambient cookies, is skipped only for such requests, see
    ``middleware.py``).
    """
    scheme, _, value = (request.headers.get("authorization") or "").partition(" ")
    if scheme.lower() != "bearer":
        return None
    return value.strip()


def generate_device_token() -> str:
    return TOKEN_PREFIX + secrets.token_urlsafe(_TOKEN_BYTES)


def hash_device_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def looks_like_device_token(token: str) -> bool:
    return bool(_TOKEN_SHAPE.fullmatch(token))


class DeviceAuthError(Exception):
    """A device token was refused; ``code`` is the protocol error code (SYNC_PROTOCOL.md 8.1)."""

    def __init__(self, code: str, detail: str) -> None:
        super().__init__(detail)
        self.code = code
        self.detail = detail


@dataclass(frozen=True, slots=True)
class DeviceMatch:
    device: Device
    #: the token matched the pre-rotation hash (inside its grace window)
    via_previous: bool


def idle_expiry() -> timedelta:
    """A device unseen for this long must sign in again (the change-retention window: past it the
    device could not resume incrementally anyway, ``SYNC_PROTOCOL.md`` section 5)."""
    return timedelta(days=get_settings().change_retention_days)


async def find_device(session: AsyncSession, token: str) -> DeviceMatch:
    """Resolve a bearer token to its device or raise :class:`DeviceAuthError`.

    ``unauthenticated`` for anything that is not a token Atlas issued, ``token_revoked`` for a
    revoked device (the caller learns it must sign in again), ``token_expired`` for an idle one.
    Only the holder of a real token can tell the last two apart.
    """
    if not looks_like_device_token(token):
        raise DeviceAuthError("unauthenticated", "Not authenticated")
    digest = hash_device_token(token)
    device = (
        await session.execute(
            select(Device).where(
                or_(
                    Device.token_hash == digest,
                    and_(Device.prev_token_hash == digest, Device.prev_valid_until > func.now()),
                )
            )
        )
    ).scalar_one_or_none()
    if device is None:
        raise DeviceAuthError("unauthenticated", "Not authenticated")
    # The query matched the current or the grace-window hash; say which, in constant time.
    via_previous = not hmac.compare_digest(device.token_hash, digest)
    if device.revoked_at is not None:
        raise DeviceAuthError("token_revoked", "This device was signed out; sign in again")
    seen = device.last_seen_at or device.created_at
    if datetime.now(UTC) - seen > idle_expiry():
        raise DeviceAuthError("token_expired", "This device was idle too long; sign in again")
    return DeviceMatch(device=device, via_previous=via_previous)


async def record_use(device: Device, *, clear_previous: bool) -> None:
    """Write ``last_seen_at`` (at most every five minutes) and drop a spent previous token.

    Runs in its **own short transaction**, so a request that fails or rolls back neither loses the
    sighting nor keeps a spent token alive. Best effort: it never fails the request.
    """
    moment = time.monotonic()
    due = moment - _last_touch.get(device.id, -TOUCH_INTERVAL_SECONDS) >= TOUCH_INTERVAL_SECONDS
    clearing = clear_previous and device.id not in _clearing
    if not due and not clearing:
        return
    # Claim the work before doing it: a client that fires twenty parallel requests must cost one
    # extra connection, not twenty (each request already holds one from the pool).
    previous_touch = _last_touch.get(device.id)
    if due:
        _last_touch[device.id] = moment
    if clearing:
        _clearing.add(device.id)
    values: dict[str, object] = {}
    statement = update(Device).where(Device.id == device.id, Device.revoked_at.is_(None))
    if due:
        values["last_seen_at"] = func.now()
        if not clearing:  # another process may have written it a moment ago
            statement = statement.where(
                or_(
                    Device.last_seen_at.is_(None),
                    Device.last_seen_at < func.now() - timedelta(seconds=TOUCH_INTERVAL_SECONDS),
                )
            )
    if clearing:
        values.update(prev_token_hash=None, prev_valid_until=None)
    try:
        async with get_session_factory()() as session:
            await session.execute(statement.values(**values))
            await session.commit()
    except Exception:  # never fail a request over bookkeeping; no token is in scope here
        logger.warning("device last_seen update failed", extra={"device_id": str(device.id)})
        if due:
            if previous_touch is None:
                _last_touch.pop(device.id, None)
            else:
                _last_touch[device.id] = previous_touch
    finally:
        _clearing.discard(device.id)


def reset_touch_cache() -> None:
    _last_touch.clear()
    _clearing.clear()


def issue_token(device: Device) -> str:
    """Give ``device`` a new current token; the old one stays valid for :data:`ROTATION_GRACE`.

    Returns the new token (the only time it exists in clear). The caller commits.
    """
    token = generate_device_token()
    device.prev_token_hash = device.token_hash
    device.prev_valid_until = datetime.now(UTC) + ROTATION_GRACE
    device.token_hash = hash_device_token(token)
    return token


async def active_device_count(session: AsyncSession, user_id: uuid.UUID) -> int:
    return int(
        await session.scalar(
            select(func.count())
            .select_from(Device)
            .where(Device.user_id == user_id, Device.revoked_at.is_(None))
        )
        or 0
    )


async def revoke_device(session: AsyncSession, user_id: uuid.UUID, device_id: uuid.UUID) -> bool:
    """Revoke one of the user's devices now. ``False`` when it is not theirs (or does not exist);
    revoking an already revoked device succeeds and changes nothing. The caller commits."""
    device = (
        await session.execute(
            select(Device).where(Device.id == device_id, Device.user_id == user_id)
        )
    ).scalar_one_or_none()
    if device is None:
        return False
    if device.revoked_at is None:
        device.revoked_at = datetime.now(UTC)
        device.prev_token_hash = None
        device.prev_valid_until = None
    return True


async def revoke_all_devices(session: AsyncSession, user_id: uuid.UUID) -> int:
    """Revoke every unrevoked device of the account; returns how many. The caller commits.

    The one function behind "sign every device out": password reset (CLI today, AUTH-01's
    recovery flow later), the optional device sign-out of a password change, and Settings.
    """
    revoked = await session.execute(
        update(Device)
        .where(Device.user_id == user_id, Device.revoked_at.is_(None))
        .values(revoked_at=func.now(), prev_token_hash=None, prev_valid_until=None)
        .returning(Device.id)
    )
    return len(revoked.all())


async def purge_revoked_devices(session: AsyncSession, *, cutoff: datetime) -> int:
    """Delete devices revoked before ``cutoff`` (the change-retention window); returns how many.

    A revoked row only exists so its token can be answered ``token_revoked``; past the window the
    client has long since been told. The resolutions it wrote keep their text and lose the device
    (``ON DELETE SET NULL``). An *idle* device that was never revoked is kept: the owner sees it in
    Settings and decides. Safe to repeat.
    """
    removed = await session.execute(
        delete(Device).where(Device.revoked_at < cutoff).returning(Device.id)
    )
    return len(removed.all())
