"""Per-field revisions and the pure field-level merge planner (SYNC-03, ADR-0055 section 4, D4).

``field_revisions`` maps a field name to the entity ``revision`` at which that field last changed.
It answers one question: *did field ``f`` change after the client's base revision?* It cannot
reconstruct an old value (the resolution log of SYNC-05 keeps overwritten simple values).

This module is pure (no database, no clock): the services call :func:`changed_fields` and
:func:`stamp` around every write, and :func:`plan_merge` decides what a sync-mode ``PATCH`` may
apply. Nothing here reads a device clock; order is the server's revision (D11).
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any

#: Tracked task fields: the writable columns plus ``tags`` (one simple field, no per-tag merge).
TASK_FIELDS: tuple[str, ...] = (
    "title",
    "description",
    "status",
    "priority",
    "project_id",
    "parent_task_id",
    "start_at",
    "due_at",
    "time_zone",
    "duration_minutes",
    "completed_at",
    "recurrence_rule",
    "recurrence_parent_id",
    "external_provider",
    "external_id",
    "tags",
)
PROJECT_FIELDS: tuple[str, ...] = ("name", "description", "status", "start_date", "target_date")

#: Text fields: a concurrent change is never merged by rule (it would corrupt prose); it is a
#: conflict that keeps both versions (ADR-0055 section 4 rule 3).
TASK_TEXT_FIELDS = frozenset({"title", "description"})
PROJECT_TEXT_FIELDS = frozenset({"name", "description"})


def task_initial() -> dict[str, int]:
    """``field_revisions`` of a new task: every field was set at revision 1 (a create)."""
    return dict.fromkeys(TASK_FIELDS, 1)


def project_initial() -> dict[str, int]:
    """``field_revisions`` of a new project."""
    return dict.fromkeys(PROJECT_FIELDS, 1)


def snapshot(entity: object, fields: Iterable[str]) -> dict[str, Any]:
    """The current column values of ``fields`` (``tags`` is not a column; the caller adds it)."""
    return {name: getattr(entity, name) for name in fields if name != "tags"}


def changed_fields(before: Mapping[str, Any], after: Mapping[str, Any]) -> list[str]:
    """Names whose value differs between two snapshots, in a stable order."""
    return [name for name in after if name in before and before[name] != after[name]]


def stamp(
    current: Mapping[str, int] | None, changed: Iterable[str], revision: int
) -> dict[str, int]:
    """A new ``field_revisions`` mapping with ``changed`` set to ``revision`` (a fresh dict, so the
    JSONB attribute is seen as modified by the ORM)."""
    result = dict(current or {})
    for name in changed:
        result[name] = revision
    return result


class Reason(StrEnum):
    #: a text field changed on both sides: both versions are kept, the client resolves
    TEXT = "text_conflict"
    #: the later-wins result would break the status state machine
    INVALID_TRANSITION = "invalid_transition"


@dataclass(frozen=True, slots=True)
class FieldConflict:
    field: str
    reason: Reason
    server_revision: int
    #: the server's current value, so the client can show both versions (never logged)
    server_value: Any = None


@dataclass(frozen=True, slots=True)
class FieldResolution:
    """A simple field both sides changed: the incoming (later in server order) value won."""

    field: str
    rule: str  # always "simple_later_wins"
    kept_revision: int  # the revision the winning value is stored at
    overwritten_at: int  # the revision at which the overwritten value had been set
    #: the overwritten value of the simple field (what SYNC-05's one-click undo re-applies); it is
    #: returned to the client and, later, stored in ``sync_resolutions``; never written to a log
    loser: Any = None


@dataclass(slots=True)
class MergePlan:
    #: fields to write (rule 1, and rule 3 simple later-wins)
    apply: dict[str, Any] = field(default_factory=dict)
    #: rule 2: the stored value already equals the incoming one
    noop: list[str] = field(default_factory=list)
    conflicts: list[FieldConflict] = field(default_factory=list)
    resolutions: list[FieldResolution] = field(default_factory=list)


def plan_merge(
    *,
    incoming: Mapping[str, Any],
    stored: Mapping[str, Any],
    field_revisions: Mapping[str, int],
    base_revision: int,
    revision: int,
    text_fields: frozenset[str],
    equal: Any = None,
) -> MergePlan:
    """Decide, per incoming field, whether it applies, is a no-op, wins or conflicts.

    Rules (SYNC_PROTOCOL.md section 6.2): (1) nobody changed ``f`` after the base: apply; (2) the
    stored value already equals the incoming one: no-op; (3) a genuine concurrent change: a simple
    field's incoming value wins (it arrives later in server order) and is reported; a text field
    is a conflict and is not applied. ``equal`` compares two normalised values (default ``==``).

    A field with no recorded revision counts as changed *now* (``revision``): an unknown history
    must never merge silently across a change it cannot see.
    """
    compare = equal or (lambda _name, a, b: a == b)
    plan = MergePlan()
    for name, value in incoming.items():
        changed_at = field_revisions.get(name, revision)
        if changed_at <= base_revision:
            if not compare(name, stored.get(name), value):
                plan.apply[name] = value
            else:
                plan.noop.append(name)
        elif compare(name, stored.get(name), value):
            plan.noop.append(name)
        elif name in text_fields:
            plan.conflicts.append(FieldConflict(name, Reason.TEXT, changed_at, stored.get(name)))
        else:
            plan.apply[name] = value
            plan.resolutions.append(
                FieldResolution(
                    name, "simple_later_wins", revision + 1, changed_at, stored.get(name)
                )
            )
    return plan
