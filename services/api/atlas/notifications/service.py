"""Destination-registry service (M8-03).

:class:`NotificationRegistryService` is the only writer of
:class:`~atlas.models.NotificationDevice`. It is **strictly user-scoped**: every query filters on
the caller's ``user_id``, so another user's destination is invisible and can never be altered or
disabled (``AGENTS.md`` §9/§11).

The surface:

- :meth:`register` — upsert one destination. Because the row is keyed by
  ``(user_id, channel, endpoint)`` an ``INSERT ... ON CONFLICT DO UPDATE`` makes re-registering the
  **same** destination update it in place (never a duplicate), refresh ``last_seen_at`` and revive a
  previously invalidated row. Idempotent.
- :meth:`unregister` — remove one destination by ``(channel, endpoint)``. Idempotent: removing a
  destination that is not there is a no-op.
- :meth:`list_devices` / :meth:`active_devices` / :meth:`active_endpoints` — read the caller's rows,
  the active ones, or just their endpoint values (the delivery target list).
- :meth:`disable` / :meth:`disable_many` — the **invalidation** path: mark a destination reported
  invalid/expired by a delivery so it is **not retried** (M8-03). Idempotent.

The pure rules live in :mod:`atlas.notifications.registry`; this module only turns them into SQL.
"""

from __future__ import annotations

import uuid
from collections.abc import Iterable
from datetime import UTC, datetime

from sqlalchemy import delete, func, select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from ..models import NotificationDevice
from .registry import (
    DeviceRegistration,
    build_destination_key,
    build_registration,
    clean_reported_endpoints,
    normalise_channel,
)

_UQ = "uq_notification_devices_user_channel_endpoint"


class NotificationRegistryService:
    """Read/write access to the caller's registered push destinations."""

    def __init__(self, session: AsyncSession, user_id: uuid.UUID) -> None:
        self.session = session
        self.user_id = user_id

    async def register(
        self,
        *,
        channel: str,
        endpoint: str,
        p256dh: str | None = None,
        auth: str | None = None,
        platform: str | None = None,
        now: datetime | None = None,
    ) -> NotificationDevice:
        """Create or replace one destination, returning the stored row.

        Naturally idempotent: re-registering the same ``(channel, endpoint)`` updates the existing
        row (refreshing ``last_seen_at`` and clearing any invalidation), so it can never duplicate.
        """
        registration = build_registration(
            channel, endpoint, p256dh=p256dh, auth=auth, platform=platform
        )
        moment = now or datetime.now(UTC)
        statement = (
            pg_insert(NotificationDevice)
            .values(
                id=uuid.uuid4(),
                user_id=self.user_id,
                channel=registration.channel,
                endpoint=registration.endpoint,
                p256dh=registration.p256dh,
                auth=registration.auth,
                platform=registration.platform,
                last_seen_at=moment,
                disabled_at=None,
            )
            .on_conflict_do_update(
                constraint=_UQ,
                set_={
                    "p256dh": registration.p256dh,
                    "auth": registration.auth,
                    "platform": registration.platform,
                    "last_seen_at": moment,
                    # A re-register revives a destination that was invalidated earlier.
                    "disabled_at": None,
                    "updated_at": func.now(),
                },
            )
        )
        await self.session.execute(statement)
        return await self._require(registration)

    async def unregister(self, *, channel: str, endpoint: str) -> bool:
        """Remove one of the caller's destinations. Returns ``True`` when a row was removed.

        Idempotent: a destination that is not registered (or belongs to someone else) is a no-op.
        """
        key = build_destination_key(channel, endpoint)
        removed = await self.session.scalars(
            delete(NotificationDevice)
            .where(
                NotificationDevice.user_id == self.user_id,
                NotificationDevice.channel == key.channel,
                NotificationDevice.endpoint == key.endpoint,
            )
            .returning(NotificationDevice.id)
        )
        return removed.first() is not None

    async def list_devices(self) -> list[NotificationDevice]:
        """Every destination the caller has registered, oldest first (deterministic)."""
        rows = await self.session.scalars(
            select(NotificationDevice)
            .where(NotificationDevice.user_id == self.user_id)
            .order_by(NotificationDevice.created_at, NotificationDevice.id)
        )
        return list(rows)

    async def active_devices(self) -> list[NotificationDevice]:
        """The caller's destinations a delivery may target (never an invalidated one)."""
        rows = await self.session.scalars(
            select(NotificationDevice)
            .where(
                NotificationDevice.user_id == self.user_id,
                NotificationDevice.disabled_at.is_(None),
            )
            .order_by(NotificationDevice.created_at, NotificationDevice.id)
        )
        return list(rows)

    async def active_endpoints(self) -> list[str]:
        """The endpoint values a delivery should target, oldest first."""
        rows = await self.session.scalars(
            select(NotificationDevice.endpoint)
            .where(
                NotificationDevice.user_id == self.user_id,
                NotificationDevice.disabled_at.is_(None),
            )
            .order_by(NotificationDevice.created_at, NotificationDevice.id)
        )
        return list(rows)

    async def disable(
        self,
        endpoint: str,
        *,
        channel: str | None = None,
        now: datetime | None = None,
    ) -> bool:
        """Mark one of the caller's destinations invalid/expired so it is not retried.

        Returns ``True`` when a live row was disabled. Idempotent: disabling an already-disabled or
        unknown destination is a no-op. Never raises for an unknown endpoint — a transport may
        report an endpoint that was since unregistered.
        """
        value = (endpoint or "").strip()
        if not value:
            return False
        conditions = [
            NotificationDevice.user_id == self.user_id,
            NotificationDevice.endpoint == value,
            NotificationDevice.disabled_at.is_(None),
        ]
        if channel is not None:
            conditions.append(NotificationDevice.channel == normalise_channel(channel))
        updated = await self.session.scalars(
            update(NotificationDevice)
            .where(*conditions)
            .values(disabled_at=now or datetime.now(UTC), updated_at=func.now())
            .returning(NotificationDevice.id)
        )
        return updated.first() is not None

    async def disable_many(self, endpoints: Iterable[str], *, now: datetime | None = None) -> int:
        """Disable every endpoint a delivery reported invalid. Returns the number disabled."""
        moment = now or datetime.now(UTC)
        disabled = 0
        for endpoint in clean_reported_endpoints(endpoints):
            if await self.disable(endpoint, now=moment):
                disabled += 1
        return disabled

    async def _require(self, registration: DeviceRegistration) -> NotificationDevice:
        channel, endpoint = registration.key
        device = await self.session.scalar(
            select(NotificationDevice)
            .where(
                NotificationDevice.user_id == self.user_id,
                NotificationDevice.channel == channel,
                NotificationDevice.endpoint == endpoint,
            )
            # Force a refresh of any identity-mapped instance so a re-register is not stale.
            .execution_options(populate_existing=True)
        )
        assert device is not None  # just upserted within this transaction
        return device


__all__ = ["NotificationRegistryService"]
