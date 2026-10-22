"""Time-zone handling for task due dates (M3-04).

A task's ``due_at``/``start_at`` are stored as UTC instants (``timestamptz``); the optional IANA
``time_zone`` gives the wall-clock interpretation used for display and for "today"/"overdue"
decisions. Conversions go through :mod:`zoneinfo`, so daylight-saving transitions are handled
explicitly rather than by fixed offsets.

Wall-clock input is interpreted in the task's zone. A time that daylight saving skipped (the
spring-forward gap) does not exist and is rejected; an ambiguous time (the fall-back overlap)
resolves deterministically to the first occurrence unless ``fold`` says otherwise.
"""

from __future__ import annotations

from datetime import UTC, date, datetime, tzinfo
from enum import StrEnum
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError


class InvalidTimeZoneError(ValueError):
    """The supplied value is not a known IANA time zone."""

    def __init__(self, name: str) -> None:
        super().__init__(f"unknown IANA time zone: {name!r}")
        self.name = name


class NonexistentWallTimeError(ValueError):
    """A local wall-clock time that daylight saving skipped."""

    def __init__(self, value: datetime) -> None:
        super().__init__(f"{value} does not exist in this time zone (DST gap)")
        self.value = value


class DueState(StrEnum):
    NONE = "none"
    OVERDUE = "overdue"
    TODAY = "today"
    UPCOMING = "upcoming"


def get_zone(name: str) -> ZoneInfo:
    """Return the :class:`ZoneInfo` for ``name`` or raise :class:`InvalidTimeZoneError`."""
    try:
        return ZoneInfo(name)
    except (ZoneInfoNotFoundError, ValueError) as exc:
        raise InvalidTimeZoneError(name) from exc


def is_valid_time_zone(name: str) -> bool:
    try:
        get_zone(name)
    except InvalidTimeZoneError:
        return False
    return True


def _exists(wall: datetime, zone: tzinfo, fold: int) -> bool:
    """True if a wall-clock time is a real instant in ``zone`` (round-trips through UTC)."""
    aware = wall.replace(tzinfo=zone, fold=fold)
    back = aware.astimezone(UTC).astimezone(zone)
    return back.replace(tzinfo=None) == wall


def is_ambiguous(wall: datetime, zone: ZoneInfo) -> bool:
    """True if a naive wall-clock time occurs twice (the fall-back overlap)."""
    offsets = {wall.replace(tzinfo=zone, fold=fold).utcoffset() for fold in (0, 1)}
    return len(offsets) == 2 and all(_exists(wall, zone, fold) for fold in (0, 1))


def to_utc(value: datetime, tz_name: str | None = None, *, fold: int = 0) -> datetime:
    """Return the UTC instant for ``value``.

    An aware ``value`` is converted directly. A naive ``value`` is interpreted as wall-clock time
    in ``tz_name`` (or UTC when ``tz_name`` is ``None``); a nonexistent (DST-gap) time raises
    :class:`NonexistentWallTimeError`.
    """
    if value.tzinfo is not None:
        return value.astimezone(UTC)
    zone = get_zone(tz_name) if tz_name is not None else UTC
    if not _exists(value, zone, fold):
        raise NonexistentWallTimeError(value)
    return value.replace(tzinfo=zone, fold=fold).astimezone(UTC)


def to_local(value: datetime, tz_name: str | None = None) -> datetime:
    """Return ``value`` as an aware datetime in ``tz_name`` (UTC when unset)."""
    zone = get_zone(tz_name) if tz_name is not None else UTC
    return value.astimezone(zone)


def local_date(value: datetime, tz_name: str | None = None) -> date:
    """The calendar date ``value`` falls on in ``tz_name`` (UTC when unset)."""
    return to_local(value, tz_name).date()


def due_state(due_at: datetime | None, *, now: datetime, tz_name: str | None = None) -> DueState:
    """Classify a due instant relative to ``now`` in the task's time zone.

    Overdue is a pure instant comparison; "today" compares calendar dates in ``tz_name``, so it
    is correct across daylight-saving changes and time-zone boundaries.
    """
    if due_at is None:
        return DueState.NONE
    if due_at < now:
        return DueState.OVERDUE
    if local_date(due_at, tz_name) == local_date(now, tz_name):
        return DueState.TODAY
    return DueState.UPCOMING
