"""Shared FastAPI dependencies."""

from __future__ import annotations

import uuid
from collections.abc import AsyncIterator
from typing import Annotated

from fastapi import Depends, HTTPException, Request, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..auth.devices import (
    DeviceAuthError,
    bearer_token,
    device_request_limiter,
    device_write_limiter,
    find_device,
    record_use,
)
from ..auth.tokens import hash_session_token
from ..config import get_settings
from ..db import get_session_factory
from ..models import AuthSession, User
from ..sync.protocol import SyncError


async def get_db() -> AsyncIterator[AsyncSession]:
    factory = get_session_factory()
    async with factory() as session:
        yield session


DbSession = Annotated[AsyncSession, Depends(get_db)]


_UNSAFE_METHODS = frozenset({"POST", "PUT", "PATCH", "DELETE"})


def _unauthenticated(code: str = "unauthenticated", detail: str = "Not authenticated") -> SyncError:
    error = SyncError(status.HTTP_401_UNAUTHORIZED, code, detail)
    error.headers = {"WWW-Authenticate": "Bearer"}
    return error


async def _session_user(request: Request, session: AsyncSession) -> User:
    settings = get_settings()
    token = request.cookies.get(settings.session_cookie_name)
    if not token:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")

    stmt = select(AuthSession).where(
        AuthSession.token_hash == hash_session_token(token),
        AuthSession.revoked_at.is_(None),
        AuthSession.expires_at > func.now(),
    )
    auth_session = (await session.execute(stmt)).scalar_one_or_none()
    if auth_session is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")

    user = await session.get(User, auth_session.user_id)
    if user is None or not user.is_active:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")
    request.state.session_token = token
    return user


async def _device_user(
    request: Request, session: AsyncSession, token: str, *, allowed: bool
) -> User:
    """Authenticate a device token (SYNC-06): revoked/expired/unknown, rate limits, scope."""
    try:
        match = await find_device(session, token)
    except DeviceAuthError as exc:
        raise _unauthenticated(exc.code, exc.detail) from exc
    device = match.device
    user = await session.get(User, device.user_id)
    if user is None or not user.is_active:
        raise _unauthenticated()
    key = str(device.id)
    limiter = device_write_limiter if request.method in _UNSAFE_METHODS else device_request_limiter
    for budget in (device_request_limiter, limiter):
        if not budget.allow(key):
            error = SyncError(
                status.HTTP_429_TOO_MANY_REQUESTS, "rate_limited", "Too many requests"
            )
            error.headers = {"Retry-After": str(budget.retry_after(key))}
            raise error
    if not allowed:
        raise SyncError(
            status.HTTP_403_FORBIDDEN,
            "forbidden_scope",
            "This is not available to a device credential; use the browser",
        )
    request.state.device_id = device.id
    # Request-scoped state for the resolution log (``ResolutionLog`` reads it): which device wrote.
    session.info["device_id"] = device.id
    await record_use(
        device, clear_previous=(not match.via_previous) and device.prev_token_hash is not None
    )
    return user


async def get_current_user(request: Request, session: DbSession) -> User:
    """The signed-in **browser** user (cookie session). The default for every endpoint.

    A device credential is refused here (``403 forbidden_scope``): account-level actions (password,
    devices of other clients, export, calendar connections, notification registry) are for the
    owner at a browser. Endpoints a sync client may call use :data:`SyncUser` instead, so a new
    endpoint is closed to devices unless someone opens it on purpose (``test_device_scope``).
    """
    token = bearer_token(request)
    if token is not None:
        return await _device_user(request, session, token, allowed=False)
    return await _session_user(request, session)


async def get_sync_user(request: Request, session: DbSession) -> User:
    """A browser session **or** a device bearer token: the sync/data endpoints."""
    token = bearer_token(request)
    if token is not None:
        return await _device_user(request, session, token, allowed=True)
    return await _session_user(request, session)


CurrentUser = Annotated[User, Depends(get_current_user)]
SyncUser = Annotated[User, Depends(get_sync_user)]


def current_device_id(request: Request) -> uuid.UUID | None:
    """The device that authenticated this request, ``None`` for a browser session."""
    value = getattr(request.state, "device_id", None)
    return value if isinstance(value, uuid.UUID) else None
