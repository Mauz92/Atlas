"""Device credentials: sign a sync client in, list, rename, rotate and revoke (SYNC-06, ADR-0065).

Two audiences, kept apart by the dependency each endpoint uses:

* the owner at a **browser** (cookie session, CSRF checked) manages every device: list, rename,
  revoke one, revoke all;
* a **device** (bearer token) may read the list (to mark itself), read and rotate its own token and
  sign itself out. Nothing else: it cannot rename or revoke another device, change the password,
  export or connect calendars (``403 forbidden_scope``).

``POST /api/devices`` is the sign-in: e-mail + password + a name, answered with the token **once**.
It shares the login rate-limit budget (one pool of password guesses, not two) and reveals nothing
about which accounts exist. The token never appears in a log, an error or a URL.
"""

from __future__ import annotations

import uuid
from typing import Annotated

from fastapi import APIRouter, HTTPException, Query, Request, Response, status
from sqlalchemy import select

from ..auth import verify_password
from ..auth.devices import (
    MAX_ACTIVE_DEVICES,
    active_device_count,
    generate_device_token,
    hash_device_token,
    issue_token,
    revoke_all_devices,
    revoke_device,
)
from ..models import Device, User
from .auth import _dummy_password_hash, _login_limiter
from .deps import CurrentUser, DbSession, SyncUser, current_device_id
from .schemas import (
    DeviceInfo,
    DeviceInfoList,
    DeviceRename,
    DeviceRevokeAllOut,
    DeviceSignedIn,
    DeviceSignIn,
)

router = APIRouter(prefix="/api/devices", tags=["devices"])


def _out(device: Device, current_id: uuid.UUID | None) -> DeviceInfo:
    return DeviceInfo(
        id=device.id,
        name=device.name,
        platform=device.platform,
        created_at=device.created_at,
        last_seen_at=device.last_seen_at,
        revoked_at=device.revoked_at,
        current=current_id is not None and device.id == current_id,
    )


async def _own(session: DbSession, user: User, device_id: uuid.UUID) -> Device:
    device = (
        await session.execute(
            select(Device).where(Device.id == device_id, Device.user_id == user.id)
        )
    ).scalar_one_or_none()
    if device is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found")
    return device


def _require_device(request: Request) -> uuid.UUID:
    device_id = current_device_id(request)
    if device_id is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="This request is not authenticated as a device",
        )
    return device_id


@router.post("", response_model=DeviceSignedIn, status_code=status.HTTP_201_CREATED)
async def register_device(
    payload: DeviceSignIn, request: Request, session: DbSession
) -> DeviceSignedIn:
    """Sign a device in: the account's e-mail and password, a name and a platform.

    Answers the bearer token **once**. Wrong credentials, an unknown account and an inactive one
    are the same `401`; the same rate limit as login applies (shared, per client address).
    """
    client = request.client.host if request.client else "unknown"
    if not _login_limiter.allow(client):
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS, detail="Too many requests"
        )
    user = (
        await session.execute(select(User).where(User.email == payload.email.lower()))
    ).scalar_one_or_none()
    if user is None:
        verify_password(_dummy_password_hash(), payload.password)  # equalise timing
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid credentials")
    if not user.is_active or not verify_password(user.password_hash, payload.password):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid credentials")
    if await active_device_count(session, user.id) >= MAX_ACTIVE_DEVICES:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"This account already has {MAX_ACTIVE_DEVICES} signed-in devices; "
            "sign one out in Settings first",
        )
    token = generate_device_token()
    device = Device(
        id=uuid.uuid4(),
        user_id=user.id,
        name=payload.name,
        platform=payload.platform,
        token_hash=hash_device_token(token),
    )
    session.add(device)
    await session.commit()
    await session.refresh(device)
    return DeviceSignedIn(device=_out(device, None), token=token)


@router.get("", response_model=DeviceInfoList)
async def list_devices(
    request: Request,
    user: SyncUser,
    session: DbSession,
    include_revoked: Annotated[
        bool, Query(description="Also list signed-out devices (newest first).")
    ] = False,
) -> DeviceInfoList:
    stmt = select(Device).where(Device.user_id == user.id)
    if not include_revoked:
        stmt = stmt.where(Device.revoked_at.is_(None))
    rows = (await session.execute(stmt.order_by(Device.created_at.desc(), Device.id))).scalars()
    current = current_device_id(request)
    return DeviceInfoList(items=[_out(device, current) for device in rows])


@router.get("/current", response_model=DeviceInfo)
async def current_device(request: Request, user: SyncUser, session: DbSession) -> DeviceInfo:
    """The device behind this request (a client checks its own state without a list)."""
    device_id = _require_device(request)
    return _out(await _own(session, user, device_id), device_id)


@router.post("/current/rotate", response_model=DeviceSignedIn)
async def rotate_current_device(
    request: Request, user: SyncUser, session: DbSession
) -> DeviceSignedIn:
    """Issue this device a new token; the old one keeps working for 24 hours.

    The grace window covers a lost response: the client retries with the old token and gets a new
    one. As soon as the new token is used, the old one is gone. The new token is shown once.
    """
    device_id = _require_device(request)
    device = await _own(session, user, device_id)
    token = issue_token(device)
    await session.commit()
    return DeviceSignedIn(device=_out(device, device_id), token=token)


@router.delete("/current", status_code=status.HTTP_204_NO_CONTENT)
async def sign_out_current_device(request: Request, user: SyncUser, session: DbSession) -> Response:
    """The device signs itself out (its token stops working at once; local data is the client's)."""
    await revoke_device(session, user.id, _require_device(request))
    await session.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/revoke-all", response_model=DeviceRevokeAllOut)
async def revoke_all(user: CurrentUser, session: DbSession) -> DeviceRevokeAllOut:
    """Sign every device of the account out now (browser sessions are not touched)."""
    count = await revoke_all_devices(session, user.id)
    await session.commit()
    return DeviceRevokeAllOut(revoked=count)


@router.patch("/{device_id}", response_model=DeviceInfo)
async def rename_device(
    device_id: uuid.UUID, payload: DeviceRename, user: CurrentUser, session: DbSession
) -> DeviceInfo:
    device = await _own(session, user, device_id)
    device.name = payload.name
    await session.commit()
    return _out(device, None)


@router.delete("/{device_id}", status_code=status.HTTP_204_NO_CONTENT)
async def revoke_one_device(
    device_id: uuid.UUID, user: CurrentUser, session: DbSession
) -> Response:
    """Sign one device out; effective for its very next request. Revoking twice is fine."""
    if not await revoke_device(session, user.id, device_id):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found")
    await session.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)
