"""Push destination registry API (M8-03).

A client registers the destinations it wants reminders delivered to and can withdraw them:

- ``POST /api/notifications/devices`` — register (or refresh) one destination. **Idempotent**: the
  same ``(channel, endpoint)`` upserts the existing row rather than duplicating it.
- ``GET /api/notifications/devices`` — list the caller's destinations (non-secret metadata only).
- ``DELETE /api/notifications/devices`` — unregister one destination by ``channel`` + ``endpoint``.
  **Idempotent**: removing a destination that is not there is a no-op (``204``).

Every endpoint requires an authenticated session (``CurrentUser``); unsafe methods need CSRF,
applied by the shared middleware. All access is **strictly user-scoped**: one user can neither list,
unregister nor otherwise affect another user's destinations. The endpoint URL and the Web Push keys
(``p256dh``/``auth``) are **write-only** — they are never returned and never logged
(``AGENTS.md`` §11). Invalidation (disabling a destination a delivery reported dead) is driven by
the delivery path (M8-01/M8-03), not this router.
"""

from __future__ import annotations

from typing import Annotated, NoReturn

from fastapi import APIRouter, HTTPException, Query, Response, status

from ..config import get_settings
from ..models import NotificationDevice, PushChannel
from ..notifications import (
    MAX_ENDPOINT_LENGTH,
    InvalidDeviceError,
    NotificationRegistryService,
    build_vapid_config,
)
from ..reminders import ReminderPreferencesService
from ..reminders import ReminderTiming as DomainTiming
from .deps import CurrentUser, DbSession
from .schemas import (
    DeviceListOut,
    DeviceOut,
    DeviceRegisterRequest,
    HomeTimeZone,
    ReminderPreferencesOut,
    ReminderPreferencesRequest,
    ReminderTiming,
    WebPushConfigOut,
)

router = APIRouter(prefix="/api/notifications", tags=["notifications"])


def _timing_out(timing: DomainTiming | None) -> ReminderTiming | None:
    """Serialise a domain timing, or ``None`` when there is none."""
    return None if timing is None else ReminderTiming.from_domain(timing)


def _translate(exc: Exception) -> NoReturn:
    """Map a registry validation error onto a ``422``; re-raise anything unexpected."""
    if isinstance(exc, InvalidDeviceError):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail=str(exc)
        ) from exc
    raise exc


def device_out(device: NotificationDevice) -> DeviceOut:
    """Serialise a destination. Never includes the endpoint or the Web Push keys."""
    return DeviceOut.model_validate(device)


@router.get("/config", response_model=WebPushConfigOut)
async def web_push_config(user: CurrentUser) -> WebPushConfigOut:
    """Whether Web Push is available and the VAPID public key the browser subscribes with (M8-02).

    Server-side configuration only — it reads the VAPID settings and never the database. The
    **public** key is returned when configured (it is a client-side key); the private key is never
    returned (``AGENTS.md`` §11). When a key is missing, ``enabled`` is false and the client shows
    the feature as unavailable instead of offering a subscription the server could not deliver.
    """
    config = build_vapid_config(get_settings())
    return WebPushConfigOut(
        enabled=config is not None,
        vapid_public_key=config.public_key if config is not None else None,
    )


@router.get("/devices", response_model=DeviceListOut)
async def list_devices(user: CurrentUser, session: DbSession) -> DeviceListOut:
    """List the caller's registered destinations, oldest first (including disabled ones).

    ``disabled_at`` is non-null for a destination the delivery path invalidated, so a client can
    show it as no longer deliverable without it being retried.
    """
    devices = await NotificationRegistryService(session, user.id).list_devices()
    return DeviceListOut(devices=[device_out(device) for device in devices])


@router.post("/devices", response_model=DeviceOut)
async def register_device(
    payload: DeviceRegisterRequest, user: CurrentUser, session: DbSession
) -> DeviceOut:
    """Register (create or refresh) the caller's destination.

    Naturally idempotent — the row is keyed by ``(user, channel, endpoint)`` — so no
    ``Idempotency-Key`` is needed: re-registering the same destination updates it in place,
    refreshes ``last_seen_at`` and revives a previously invalidated row. A ``web`` destination
    requires ``p256dh`` and ``auth``; a native destination must not send them (``422`` otherwise,
    with no side effects).
    """
    try:
        device = await NotificationRegistryService(session, user.id).register(
            channel=payload.channel.value,
            endpoint=payload.endpoint,
            p256dh=payload.p256dh,
            auth=payload.auth,
            platform=payload.platform,
        )
    except Exception as exc:
        _translate(exc)
    await session.commit()
    return device_out(device)


@router.delete("/devices", status_code=status.HTTP_204_NO_CONTENT)
async def unregister_device(
    user: CurrentUser,
    session: DbSession,
    channel: Annotated[PushChannel, Query(description="The destination's channel.")],
    endpoint: Annotated[
        str,
        Query(
            min_length=1,
            max_length=MAX_ENDPOINT_LENGTH,
            description="The destination identifier (Web Push endpoint or push token).",
        ),
    ],
) -> Response:
    """Unregister one of the caller's destinations by ``channel`` + ``endpoint``.

    Idempotent: unregistering a destination that is not registered (or belongs to another user) is
    a no-op and still returns ``204``. An unknown ``channel`` or an out-of-range ``endpoint`` is a
    ``422`` with no side effects.
    """
    try:
        await NotificationRegistryService(session, user.id).unregister(
            channel=channel.value, endpoint=endpoint
        )
    except Exception as exc:
        _translate(exc)
    await session.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/reminders", response_model=ReminderPreferencesOut)
async def get_reminder_preferences(user: CurrentUser, session: DbSession) -> ReminderPreferencesOut:
    """The caller's reminder timing (M8-05): the default that governs their tasks.

    Read-only and strictly user-scoped. ``default`` is ``null`` when no default is set — the client
    then shows the reminder as off and offers a timing to choose.
    """
    timing = await ReminderPreferencesService(session, user.id).get_default_timing()
    return ReminderPreferencesOut(default=_timing_out(timing))


@router.put("/reminders", response_model=ReminderPreferencesOut)
async def set_reminder_preferences(
    payload: ReminderPreferencesRequest, user: CurrentUser, session: DbSession
) -> ReminderPreferencesOut:
    """Set (or clear) the caller's default reminder timing and reschedule the affected reminders.

    Idempotent: the single per-user default is upserted. Every task that inherits the default is
    re-materialised through the M8-01 scheduler in the same transaction, so a later timing fires
    later and an earlier one fires earlier (``no new scheduling logic``). An invalid timing is
    rejected at the boundary (``422``) with no side effects. ``{ "default": null }`` turns the
    default off.
    """
    service = ReminderPreferencesService(session, user.id)
    if payload.default is None:
        await service.clear_default_timing()
    else:
        await service.set_default_timing(payload.default.to_domain())
    await session.commit()
    return ReminderPreferencesOut(default=_timing_out(await service.get_default_timing()))


@router.get("/time-zone", response_model=HomeTimeZone)
async def get_home_time_zone(user: CurrentUser, session: DbSession) -> HomeTimeZone:
    """The caller's home time zone (ADR-0068 Q6): the zone reminders use for tasks without their
    own. ``null`` means UTC (the behaviour before the preference existed)."""
    return HomeTimeZone(
        time_zone=await ReminderPreferencesService(session, user.id).get_home_time_zone()
    )


@router.put("/time-zone", response_model=HomeTimeZone)
async def set_home_time_zone(
    payload: HomeTimeZone, user: CurrentUser, session: DbSession
) -> HomeTimeZone:
    """Set (or clear, with `null`) the home time zone and recompute the reminders of the caller's
    tasks that have no zone of their own. Idempotent; an unknown zone is `422` and changes nothing.
    Browser sessions only (account-level, closed to device credentials)."""
    zone = await ReminderPreferencesService(session, user.id).set_home_time_zone(payload.time_zone)
    await session.commit()
    return HomeTimeZone(time_zone=zone)
