"""Pure projection/merge logic for the event projection store (M5-06).

These functions hold the part of the sync that is *pure* — mapping a neutral
:class:`~atlas.calendar.types.Event` onto the ``external_events`` columns and deciding whether a
re-sync would change anything — so they can be unit-tested without a database, an adapter or a
clock. The transactional apply (upsert/tombstone + cursor advance) lives in
:mod:`atlas.calendar.sync` and depends only on these helpers.

Idempotency, precisely: re-applying the *same* provider event must not create a second projection
(the unique key ``(user_id, provider, external_event_id)`` enforces that) and, when the provider
version has not moved, need not rewrite the row at all. :func:`event_is_unchanged` is the rule that
decides "no-op": the stored row is live and carries the same provider version (``etag`` when the
provider supplies one) at the same provider-modified instant. A tombstoned row is never "unchanged"
— a re-appearance of the event must revive it.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from .types import Event, EventStatus


@dataclass(frozen=True, slots=True)
class ProjectionState:
    """The stored version of one projected event, used to decide whether a write is a no-op."""

    etag: str | None
    source_updated_at: datetime
    deleted_at: datetime | None


def projected_values(event: Event) -> dict[str, Any]:
    """The provider-derived ``external_events`` columns for ``event`` (no local identity fields).

    The mapping is a total function of the neutral event, so an event and its projection can never
    drift on field coverage. Instants pass through unchanged (already timezone-aware UTC);
    ``status`` is the neutral :class:`~atlas.calendar.types.EventStatus` value; ``summary`` and
    ``etag`` may be ``None``.
    """
    return {
        "provider": event.provider,
        "external_event_id": event.id,
        "calendar_id": event.calendar_id,
        "summary": event.summary,
        "start_at": event.start,
        "end_at": event.end,
        "time_zone": event.time_zone,
        "is_all_day": event.is_all_day,
        "status": _status_value(event.status),
        "etag": event.etag,
        "ical_uid": event.ical_uid,
        "recurrence_id": event.recurrence_id,
        "recurrence_rule": event.recurrence_rule,
        "source_updated_at": event.updated,
    }


def merge_event_row(
    event: Event, *, user_id: uuid.UUID, last_synced_at: datetime
) -> dict[str, Any]:
    """The full insert/upsert row for ``event``: identity plus the projected provider fields.

    A fresh ``id`` is minted for every row so a new projection is always insertable; on a conflict
    the ``ON CONFLICT`` clause ignores it and updates the existing row in place. ``deleted_at`` is
    ``None`` so re-seeing a previously deleted event revives its projection.
    """
    return {
        **projected_values(event),
        "id": uuid.uuid4(),
        "user_id": user_id,
        "last_synced_at": last_synced_at,
        "deleted_at": None,
    }


def event_is_unchanged(existing: ProjectionState | None, event: Event) -> bool:
    """Whether applying ``event`` over ``existing`` would be a no-op.

    ``True`` only when the row exists, is live (not tombstoned) and already records the same
    provider version: the same ``etag`` when the provider supplies one (a reliable version token,
    so a changed ``updated`` with the same ``etag`` is still a no-op), otherwise the same provider
    ``updated`` instant. A missing row, a tombstone or any version difference means a real write.
    """
    if existing is None or existing.deleted_at is not None:
        return False
    if event.etag is not None and existing.etag is not None:
        if existing.etag != event.etag:
            return False
    elif existing.source_updated_at != event.updated:
        return False
    return existing.source_updated_at == event.updated


def _status_value(status: EventStatus) -> str:
    """The persisted string for a neutral event status (tolerates a plain string for safety)."""
    value = getattr(status, "value", status)
    return str(value)
