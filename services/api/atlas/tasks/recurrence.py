"""RRULE-based task recurrence (M3-05).

Recurrence follows RFC 5545 (``docs/DATA_MODEL.md`` §4). A task series is defined by an RRULE
string plus an anchor instant (``dtstart``) and an optional IANA zone; the ``recurrence_series``
row (``rule``, ``dtstart``, ``time_zone``, ``end_date``, ``count``) mirrors that definition so
the bounds are queryable.

Occurrences are computed on the **wall clock** of the series' zone: a task repeating daily at
09:30 stays at 09:30 local across a daylight-saving change (the RFC 5545 behaviour). Every
occurrence is then converted to a UTC instant for storage and comparison (ADR-0014).

``python-dateutil`` provides the RFC 5545 engine (``dateutil.rrule``); no custom recurrence
engine is written (AGENTS.md §7.5). The RRULE text is authoritative for the recurrence pattern
and its own ``COUNT``/``UNTIL`` bounds; an explicit ``count``/``end_date`` supplied alongside it
acts as an additional *outer* cap, so whichever bound is reached first ends the series.

Completion semantics (``DATA_MODEL.md`` §2.3): completing one occurrence completes only that
occurrence and yields the next one; it never completes or deletes the series or its other
occurrences. This module computes the next instant; the persistence side lives in
:mod:`atlas.tasks.service`.
"""

from __future__ import annotations

from collections.abc import Iterator
from dataclasses import dataclass
from datetime import UTC, date, datetime
from itertools import islice

from dateutil.rrule import rrulestr

from .timezones import NonexistentWallTimeError, get_zone

# A rule's syntax is validated against an aware dtstart because our series anchors are always
# aware (a task stores UTC instants); this also matches dateutil's UNTIL-must-be-UTC rule.
_PROBE_DTSTART = datetime(2000, 1, 1, tzinfo=UTC)
_UNTIL_DATETIME_FORMAT = "%Y%m%dT%H%M%S"
_UNTIL_DATE_FORMAT = "%Y%m%d"


class InvalidRecurrenceRuleError(ValueError):
    """The supplied text is not a usable RFC 5545 RRULE."""

    def __init__(self, rule: str, reason: str = "") -> None:
        self.rule = rule
        self.reason = reason
        message = f"invalid recurrence rule: {rule!r}"
        if reason:
            message = f"{message} ({reason})"
        super().__init__(message)


def _normalized_rule(rule: str) -> str:
    """Strip surrounding whitespace and any leading ``RRULE:`` prefix(es)."""
    text = rule.strip()
    while text.upper().startswith("RRULE:"):
        text = text[len("RRULE:") :].strip()
    return text


def _rule_parts(rule: str) -> list[str]:
    return [part.strip() for part in _normalized_rule(rule).split(";") if part.strip()]


def _as_int(key: str, value: str, rule: str) -> int:
    try:
        return int(value)
    except ValueError as exc:
        raise InvalidRecurrenceRuleError(rule, f"invalid {key}") from exc


def validate_rule(rule: str) -> str:
    """Return the normalised RRULE text or raise :class:`InvalidRecurrenceRuleError`.

    The RRULE must be a bare recurrence rule (an optional ``RRULE:`` prefix is accepted); a
    ``DTSTART`` belongs to the task, not the rule, and is rejected. ``COUNT`` and ``INTERVAL``
    must be positive integers.
    """
    text = _normalized_rule(rule)
    if not text:
        raise InvalidRecurrenceRuleError(rule, "empty")
    if "DTSTART" in text.upper():
        raise InvalidRecurrenceRuleError(rule, "DTSTART belongs to the task, not the rule")
    for part in _rule_parts(text):
        key, _, value = part.partition("=")
        key = key.strip().upper()
        if key in {"COUNT", "INTERVAL"} and _as_int(key, value, rule) < 1:
            raise InvalidRecurrenceRuleError(rule, f"{key} must be a positive integer")
    try:
        rrulestr(text, dtstart=_PROBE_DTSTART)
    except (ValueError, TypeError) as exc:
        raise InvalidRecurrenceRuleError(rule, str(exc)) from exc
    return text


def localize_dtstart(dtstart: datetime, tz_name: str | None) -> datetime:
    """Return ``dtstart`` as an aware datetime in the series zone.

    An aware ``dtstart`` is converted to ``tz_name`` (UTC when unset). A naive one is interpreted
    as wall-clock time in ``tz_name``; a time that daylight saving skipped does not exist and is
    rejected (:class:`NonexistentWallTimeError`), matching ADR-0014.
    """
    zone = get_zone(tz_name) if tz_name is not None else UTC
    if dtstart.tzinfo is not None:
        return dtstart.astimezone(zone)
    local = dtstart.replace(tzinfo=zone)
    if local.astimezone(UTC).astimezone(zone).replace(tzinfo=None) != dtstart:
        raise NonexistentWallTimeError(dtstart)
    return local


def _until_local_date(value: str, tz_name: str | None) -> date:
    """The local calendar date an ``UNTIL`` value falls on in the series zone."""
    zone = get_zone(tz_name) if tz_name is not None else UTC
    text = value.strip().upper()
    is_utc = text.endswith("Z")
    text = text.rstrip("Z")
    if "T" not in text:
        return datetime.strptime(text, _UNTIL_DATE_FORMAT).date()
    moment = datetime.strptime(text, _UNTIL_DATETIME_FORMAT)
    moment = moment.replace(tzinfo=UTC if is_utc else zone)
    return moment.astimezone(zone).date()


def series_bounds(rule: str, tz_name: str | None = None) -> tuple[int | None, date | None]:
    """The ``(count, end_date)`` an RRULE implies, for the ``recurrence_series`` columns."""
    count: int | None = None
    end_date: date | None = None
    for part in _rule_parts(rule):
        key, _, value = part.partition("=")
        key = key.strip().upper()
        if key == "COUNT" and value:
            count = int(value)
        elif key == "UNTIL" and value:
            end_date = _until_local_date(value, tz_name)
    return count, end_date


@dataclass(frozen=True)
class RecurrenceSpec:
    """An iterable recurrence series.

    ``dtstart`` is aware and already localised to ``time_zone`` (via :func:`build_spec`), and is
    the first occurrence. ``count``/``end_date`` are the effective outer bounds (already merged
    with any ``COUNT``/``UNTIL`` in the rule).
    """

    rule: str
    dtstart: datetime
    time_zone: str | None = None
    count: int | None = None
    end_date: date | None = None


def build_spec(
    rule: str,
    dtstart: datetime,
    *,
    time_zone: str | None = None,
    count: int | None = None,
    end_date: date | None = None,
) -> RecurrenceSpec:
    """Validate ``rule`` and build a :class:`RecurrenceSpec`.

    Explicit ``count``/``end_date`` act as outer caps; when omitted they are derived from the
    rule's ``COUNT``/``UNTIL`` so the series row mirrors the rule.
    """
    text = validate_rule(rule)
    local_dtstart = localize_dtstart(dtstart, time_zone)
    rule_count, rule_end_date = series_bounds(text, time_zone)
    return RecurrenceSpec(
        rule=text,
        dtstart=local_dtstart,
        time_zone=time_zone,
        count=count if count is not None else rule_count,
        end_date=end_date if end_date is not None else rule_end_date,
    )


def iter_instants(spec: RecurrenceSpec) -> Iterator[datetime]:
    """Yield the series' occurrence instants (UTC, ascending), honouring all bounds."""
    engine = rrulestr(spec.rule, dtstart=spec.dtstart)
    for index, occurrence in enumerate(engine):
        if spec.end_date is not None and occurrence.date() > spec.end_date:
            return
        if spec.count is not None and index >= spec.count:
            return
        yield occurrence.astimezone(UTC)


def occurrences(spec: RecurrenceSpec, *, limit: int = 100) -> list[datetime]:
    """The first ``limit`` occurrence instants (UTC). Bounds the iteration of open-ended rules."""
    return list(islice(iter_instants(spec), limit))


def next_occurrence(spec: RecurrenceSpec, after: datetime | None = None) -> datetime | None:
    """The first occurrence strictly after ``after`` (UTC), or ``None`` when the series ends.

    ``after=None`` returns the first occurrence. This is the whole completion rule: completing an
    occurrence advances to exactly this instant, and ``None`` means the series has no successor.
    """
    for instant in iter_instants(spec):
        if after is None or instant > after:
            return instant
    return None


MAX_PREVIEW = 20


def preview_occurrences(
    rule: str, anchor: datetime, *, time_zone: str | None = None, limit: int = 5
) -> list[datetime]:
    """The first ``limit`` occurrence instants (UTC) a task anchored at ``anchor`` would get.

    Read-only: nothing is stored. It uses exactly the validation and iteration that creating or
    completing a recurring task uses, so a client can show what a rule means without
    reimplementing it (AGENTS.md §7.4). ``anchor`` may be naive wall-clock time in ``time_zone``.
    """
    spec = build_spec(rule, anchor, time_zone=time_zone)
    return occurrences(spec, limit=max(1, min(limit, MAX_PREVIEW)))
