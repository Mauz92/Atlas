"""Task listing filters and text search (M3-08).

``GET /api/tasks`` is the single, server-authoritative task listing (ADR-0012). M3-08 adds
optional, validated filters — ``status``, ``priority``, a date range on ``start_at``/``due_at``,
``project_id`` and free-text search ``q`` — which compose with the M3-06 ``parent_task_id`` filter
and the M3-07 ``view``/``tz`` parameters.

This module holds the *pure* parsing and normalisation rules so they can be tested without a
database, following the pattern of :mod:`atlas.tasks.priority`, :mod:`atlas.tasks.views` and
:mod:`atlas.tasks.subtasks`. The SQL that applies the filters lives in
:mod:`atlas.tasks.service`; the HTTP boundary lives in :mod:`atlas.api.tasks`.

Semantics (ADR-0018):

- ``status`` accepts a repeated query parameter and/or comma-separated values; each value must be
  a known task status. Values are trimmed, blanks are ignored and duplicates collapse.
- ``priority`` is a single known priority value.
- ``due_from``/``due_to`` and ``start_from``/``start_to`` are *inclusive* UTC instant bounds. A
  value with a time component is used exactly; a date-only value means the whole UTC day
  (``…_from`` starts at ``00:00:00``, ``…_to`` ends at ``23:59:59.999999``). A value without an
  offset is read as UTC. A range whose lower bound is after its upper bound is rejected. A task
  with no ``due_at``/``start_at`` never matches a bound on that field.
- ``project_id`` is a UUID. An id with no matching tasks simply yields no tasks: the ``projects``
  table arrives with M4, so existence cannot be checked yet (documented limitation).
- ``q`` is a case-insensitive substring match over ``title``/``description``. It is length-bounded
  and translated into an escaped ``LIKE`` pattern that is always bound as a query parameter, so
  the term is never interpolated into SQL text (no injection, and ``%``/``_`` match literally).
"""

from __future__ import annotations

import uuid
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC, date, datetime, time

from ..models import TaskPriority, TaskStatus

#: Maximum number of characters accepted for the free-text ``q`` term.
MAX_SEARCH_LENGTH = 200
#: Maximum number of ``status`` values (including duplicates) accepted in one request.
MAX_STATUS_FILTERS = 20
#: Maximum length of a single ``status`` value (the longest status is ``in_progress``).
MAX_STATUS_LENGTH = 32
#: Maximum length of a date-range bound (an ISO 8601 date or instant).
MAX_INSTANT_LENGTH = 64
#: Default number of tasks returned by ``GET /api/tasks`` when ``limit`` is omitted.
DEFAULT_LIMIT = 200
#: Largest accepted ``limit``.
MAX_LIMIT = 500

#: The status values a ``status`` filter accepts (the canonical ``TaskStatus`` enum).
STATUS_VALUES: frozenset[str] = frozenset(status.value for status in TaskStatus)

#: The priority values a ``priority`` filter accepts (the canonical ``TaskPriority`` enum).
PRIORITY_VALUES: frozenset[str] = frozenset(priority.value for priority in TaskPriority)

#: ``LIKE`` metacharacters mapped to their escaped form (single pass, so ``\`` is not doubled).
_LIKE_ESCAPES = str.maketrans({"\\": "\\\\", "%": "\\%", "_": "\\_"})

#: The ``ESCAPE`` character used with the generated ``LIKE`` pattern.
LIKE_ESCAPE = "\\"


class InvalidTaskFilterError(ValueError):
    """A filter value the API cannot accept (translated to ``422`` at the boundary)."""


def parse_statuses(values: Sequence[str] | None) -> tuple[str, ...]:
    """Normalise the raw ``status`` query values into known, de-duplicated statuses.

    Accepts both repeated parameters (``?status=inbox&status=next``) and comma-separated values
    (``?status=inbox,next``). An unknown value or too many values raise
    :class:`InvalidTaskFilterError`.
    """
    if not values:
        return ()
    parsed: list[str] = []
    supplied = 0
    for raw in values:
        for part in raw.split(","):
            value = part.strip()
            if not value:
                continue
            supplied += 1
            if supplied > MAX_STATUS_FILTERS:
                raise InvalidTaskFilterError(
                    f"at most {MAX_STATUS_FILTERS} status values are allowed"
                )
            if len(value) > MAX_STATUS_LENGTH or value not in STATUS_VALUES:
                raise InvalidTaskFilterError(f"unknown status: {value!r}")
            if value not in parsed:
                parsed.append(value)
    return tuple(parsed)


def parse_priority(value: str | None) -> str | None:
    """Normalise the optional ``priority`` query value, rejecting anything unknown."""
    if value is None:
        return None
    text = value.strip()
    if not text:
        return None
    if text not in PRIORITY_VALUES:
        raise InvalidTaskFilterError(f"unknown priority: {text!r}")
    return text


def parse_instant(value: str | None, *, field: str, end_of_day: bool = False) -> datetime | None:
    """Parse an ISO 8601 date or instant into an aware UTC ``datetime``.

    A value with a time component is used exactly (offsets are converted to UTC, no offset means
    UTC). A date-only value spans the whole UTC day: the start of that day, or — when
    ``end_of_day`` is set, as for an upper bound — its last microsecond. The field name is used in
    the error message.
    """
    if value is None:
        return None
    text = value.strip()
    if not text:
        return None
    if len(text) > MAX_INSTANT_LENGTH:
        raise InvalidTaskFilterError(_bad_instant(field))
    day = _parse_date_only(text)
    if day is not None:
        moment = time.max if end_of_day else time.min
        return datetime.combine(day, moment, tzinfo=UTC)
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError as exc:
        raise InvalidTaskFilterError(_bad_instant(field)) from exc
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=UTC)
    return parsed.astimezone(UTC)


def _parse_date_only(text: str) -> date | None:
    """The ``date`` for a date-only value (``2026-10-26``), else ``None``."""
    try:
        return date.fromisoformat(text)
    except ValueError:
        return None


def _bad_instant(field: str) -> str:
    return f"{field} must be an ISO 8601 date or instant"


def validate_range(start: datetime | None, end: datetime | None, *, field: str) -> None:
    """Reject a range whose lower bound is after its upper bound."""
    if start is not None and end is not None and start > end:
        raise InvalidTaskFilterError(f"{field} range is inverted")


def normalise_search(value: str | None) -> str | None:
    """Trim the free-text term, rejecting one that is longer than :data:`MAX_SEARCH_LENGTH`.

    ``None`` and blank/whitespace-only terms mean "no search" and return ``None``.
    """
    if value is None:
        return None
    if len(value) > MAX_SEARCH_LENGTH:
        raise InvalidTaskFilterError(f"q must be at most {MAX_SEARCH_LENGTH} characters")
    text = value.strip()
    return text or None


def search_pattern(term: str) -> str:
    """Build the ``LIKE`` pattern for ``term``, escaping ``%``, ``_`` and ``\\``.

    The result contains only user text plus escapes; it is always bound as a parameter, so the
    term can never alter the statement's structure.
    """
    return f"%{term.translate(_LIKE_ESCAPES)}%"


@dataclass(frozen=True, slots=True)
class TaskFilters:
    """A validated, immutable set of task-list filters (see the module docstring)."""

    statuses: tuple[str, ...] = ()
    priority: str | None = None
    due_from: datetime | None = None
    due_to: datetime | None = None
    start_from: datetime | None = None
    start_to: datetime | None = None
    project_id: uuid.UUID | None = None
    search: str | None = None

    @property
    def is_empty(self) -> bool:
        """Whether no filter is set (the default listing, unchanged since M3-02)."""
        return not any(
            (
                self.statuses,
                self.priority,
                self.due_from,
                self.due_to,
                self.start_from,
                self.start_to,
                self.project_id,
                self.search,
            )
        )


def build_filters(
    *,
    status: Sequence[str] | None = None,
    priority: str | None = None,
    due_from: str | None = None,
    due_to: str | None = None,
    start_from: str | None = None,
    start_to: str | None = None,
    project_id: uuid.UUID | None = None,
    q: str | None = None,
) -> TaskFilters:
    """Validate raw query values into a :class:`TaskFilters`, or raise
    :class:`InvalidTaskFilterError`."""
    parsed_due_from = parse_instant(due_from, field="due_from")
    parsed_due_to = parse_instant(due_to, field="due_to", end_of_day=True)
    parsed_start_from = parse_instant(start_from, field="start_from")
    parsed_start_to = parse_instant(start_to, field="start_to", end_of_day=True)
    validate_range(parsed_due_from, parsed_due_to, field="due")
    validate_range(parsed_start_from, parsed_start_to, field="start")
    return TaskFilters(
        statuses=parse_statuses(status),
        priority=parse_priority(priority),
        due_from=parsed_due_from,
        due_to=parsed_due_to,
        start_from=parsed_start_from,
        start_to=parsed_start_to,
        project_id=project_id,
        search=normalise_search(q),
    )
