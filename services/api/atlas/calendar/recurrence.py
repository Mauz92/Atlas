"""Local recurrence expansion on ``python-dateutil`` (M5-07/M5-11, ADR-0071 D4).

Atlas writes **no recurrence engine** (AGENTS.md §7.5): RFC 5545 rules are evaluated by
``dateutil.rrule`` (the same library the task recurrence already uses, ADR-0015). What lives here is
only the glue that makes it correct for calendars:

- A series is expanded in the event's **wall-clock time in its own IANA zone** (naive local
  datetimes, then attached to the zone), so a 09:00 Europe/Berlin series stays 09:00 local across a
  DST change while its UTC instant moves. A local time that does not exist (spring-forward gap) or
  occurs twice (fall-back) resolves with ``zoneinfo``'s ``fold=0`` rule - deterministic and tested.
- All-day series are expanded as local dates, so they never shift with the viewer's zone.
- ``UNTIL`` is normalised to the same local wall-clock (a ``Z`` instant is converted, a date means
  the end of that day); ``EXDATE``/``RDATE`` are stored as UTC instants and matched on the local
  wall-clock; overrides (``RECURRENCE-ID``) and cancelled occurrences are matched on the
  occurrence's
  original start instant (:func:`occurrence_key`).
- Work is bounded: rules finer than hourly are refused at ingest, one query visits at most
  :data:`MAX_ITERATIONS` candidate occurrences and returns at most :data:`MAX_OCCURRENCES`.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import UTC, date, datetime, time, timedelta
from zoneinfo import ZoneInfo

from dateutil import rrule as du_rrule

MAX_OCCURRENCES = 2000
MAX_ITERATIONS = 200_000
_FORBIDDEN_FREQ = {"SECONDLY", "MINUTELY"}
_UNTIL = re.compile(r"(^|;)UNTIL=([^;]+)", re.IGNORECASE)


def occurrence_key(instant: datetime) -> str:
    """The canonical identity of an occurrence: its original start as a UTC instant."""
    return instant.astimezone(UTC).strftime("%Y%m%dT%H%M%SZ")


def format_instants(prefix: str, instants: list[datetime]) -> str:
    return f"{prefix}:" + ",".join(occurrence_key(i) for i in instants)


def _parse_instant(text: str) -> datetime | None:
    text = text.strip()
    try:
        if len(text) == 8:
            return datetime.strptime(text, "%Y%m%d").replace(tzinfo=UTC)
        return datetime.strptime(text.rstrip("Z"), "%Y%m%dT%H%M%S").replace(tzinfo=UTC)
    except ValueError:
        return None


@dataclass(frozen=True, slots=True)
class ParsedRules:
    rrules: tuple[str, ...]
    exdates: tuple[datetime, ...]
    rdates: tuple[datetime, ...]

    @property
    def is_recurring(self) -> bool:
        return bool(self.rrules or self.rdates)


def parse_rules(text: str | None) -> ParsedRules:
    """Split stored rule lines (``RRULE:``, ``EXDATE:``, ``RDATE:``) - tolerant of parameters."""
    rrules: list[str] = []
    exdates: list[datetime] = []
    rdates: list[datetime] = []
    for raw in (text or "").splitlines():
        line = raw.strip()
        if not line or ":" not in line:
            continue
        head, _, value = line.partition(":")
        name = head.split(";", 1)[0].upper()
        if name == "RRULE":
            rrules.append(value.strip())
        elif name in {"EXDATE", "RDATE"}:
            target = exdates if name == "EXDATE" else rdates
            for part in value.split(","):
                parsed = _parse_instant(part)
                if parsed is not None:
                    target.append(parsed)
    return ParsedRules(tuple(rrules), tuple(sorted(set(exdates))), tuple(sorted(set(rdates))))


def _naive_local(instant: datetime, zone: ZoneInfo) -> datetime:
    return instant.astimezone(zone).replace(tzinfo=None)


def _normalise_until(rule: str, zone: ZoneInfo) -> str:
    """Rewrite ``UNTIL`` as a naive local wall-clock (dateutil needs it to match a naive
    DTSTART)."""
    match = _UNTIL.search(rule)
    if not match:
        return rule
    raw = match.group(2).strip()
    parsed = _parse_instant(raw)
    if parsed is None:
        return _UNTIL.sub("", rule).strip(";")
    if len(raw) == 8:  # a date: through the end of that local day
        local = datetime.combine(parsed.date(), time(23, 59, 59))
    elif raw.upper().endswith("Z"):
        local = _naive_local(parsed, zone)
    else:  # already floating/local wall-clock
        local = parsed.replace(tzinfo=None)
    return _UNTIL.sub(
        lambda m: f"{m.group(1)}UNTIL={local.strftime('%Y%m%dT%H%M%S')}", rule, count=1
    )


def rule_is_supported(rule: str) -> bool:
    """Whether ``rule`` parses and is coarse enough to expand safely."""
    freq = re.search(r"(^|;)FREQ=([A-Z]+)", rule.upper())
    if not freq or freq.group(2) in _FORBIDDEN_FREQ:
        return False
    # UNTIL is normalised against the event's zone at expansion time; here only the grammar matters.
    probe = _UNTIL.sub("", rule).strip(";")
    try:
        du_rrule.rrulestr(probe, dtstart=datetime(2000, 1, 1))
    except (ValueError, TypeError, KeyError):
        return False
    return True


def _localise(naive: datetime, zone: ZoneInfo) -> datetime:
    return naive.replace(tzinfo=zone, fold=0).astimezone(UTC)


def expand_series(
    *,
    start: datetime,
    end: datetime,
    zone_name: str,
    is_all_day: bool,
    rules_text: str | None,
    window_start: datetime,
    window_end: datetime,
    limit: int = MAX_OCCURRENCES,
) -> list[tuple[datetime, datetime]]:
    """Occurrences of a series overlapping ``[window_start, window_end)``, as UTC instants.

    ``start``/``end`` are the master's first occurrence (UTC instants); the result is sorted and
    includes the first occurrence itself when it falls in the window. Never raises on a bad rule:
    an unusable rule yields just the master occurrence.
    """
    zone = ZoneInfo(zone_name)
    parsed = parse_rules(rules_text)
    duration = end - start
    first_local = _naive_local(start, zone)
    if is_all_day:
        first_local = datetime.combine(first_local.date(), time.min)
        days = max(1, round(duration / timedelta(days=1)))

    rset = du_rrule.rruleset()
    usable = False
    for rule in parsed.rrules:
        if not rule_is_supported(rule):
            continue
        try:
            rset.rrule(du_rrule.rrulestr(_normalise_until(rule, zone), dtstart=first_local))
            usable = True
        except (ValueError, TypeError, KeyError):
            continue
    if not usable:
        rset.rdate(first_local)  # no valid RRULE: the master itself still occurs
    else:
        rset.rdate(first_local)  # RFC 5545: DTSTART is always the first instance
    for rdate in parsed.rdates:
        rset.rdate(_naive_local(rdate, zone))
    for exdate in parsed.exdates:
        rset.exdate(_naive_local(exdate, zone))

    results: list[tuple[datetime, datetime]] = []
    lower = window_start - duration
    for steps, naive in enumerate(rset):
        if steps >= MAX_ITERATIONS:
            break
        occurrence_start = _localise(naive, zone)
        if occurrence_start >= window_end:
            break
        if occurrence_start < lower:
            continue
        if is_all_day:
            occurrence_end = _localise(naive + timedelta(days=days), zone)
        else:
            occurrence_end = occurrence_start + duration
        if occurrence_end > window_start or occurrence_start >= window_start:
            results.append((occurrence_start, occurrence_end))
            if len(results) >= limit:
                break
    return results


def local_dates(start: datetime, end: datetime, zone_name: str) -> tuple[date, date]:
    """``(first day, exclusive end day)`` of an all-day event in its own zone."""
    zone = ZoneInfo(zone_name)
    first = start.astimezone(zone).date()
    last = end.astimezone(zone).date()
    return first, max(last, first + timedelta(days=1))
