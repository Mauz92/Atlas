"""Per-user change feed — pure cursor/ordering logic (M7-01).

``GET /api/changes`` is the cross-entity incremental pull: a client that already holds a cursor
asks for everything that changed after it, across tasks, projects, notes *metadata* and the
note↔project links, so it converges without re-fetching everything. This module holds the **pure**
rules — the cursor/limit validation, the entity/key vocabulary and the page planner — so they can
be tested without a database, following the pattern of :mod:`atlas.tasks.changes` and
:mod:`atlas.tasks.filters`. The SQL lives in :mod:`atlas.changes.service`; the write side lives in
:mod:`atlas.changes.record`; the HTTP boundary lives in :mod:`atlas.api.changes`.

Semantics:

- The cursor is a **monotonic per-user** integer (:class:`atlas.models.ChangeLog.seq`, allocated
  from ``users.change_seq``). Unlike the per-entity ``revision`` used by the M3-09 task pull, it is
  globally ordered *within one user* and unique per change, so ordering by it is a total order.
- The feed store keeps one row per changed entity, so an entity bumped twice between two pulls
  appears exactly once, at its latest cursor (:func:`merge_latest` makes that collapse explicit
  even though the store's primary key already guarantees it).
- A page is therefore simply the first ``limit`` changes ordered by cursor; the caller pages from
  the returned ``next_since`` until ``has_more`` is false, seeing the whole change set exactly once.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from datetime import datetime
from enum import StrEnum

from .retention import ResyncReason

#: Default number of changes returned by ``GET /api/changes`` when ``limit`` is omitted.
DEFAULT_CHANGE_LIMIT = 200
#: Largest accepted ``limit``.
MAX_CHANGE_LIMIT = 500
#: Largest accepted cursor. ``seq`` is a 64-bit integer, so this is its positive range; a larger
#: value cannot match any row and is rejected at the boundary instead of reaching the database.
MAX_CURSOR = 2**63 - 1


class InvalidChangeCursorError(ValueError):
    """The supplied ``since``/``limit`` is out of range (mapped to ``422`` at the boundary)."""


class ChangeEntityType(StrEnum):
    """The structured entity kinds that appear in the change feed.

    ``TASK_NOTE_LINK`` is the task↔note association (``task_links``, MU-06): recorded when a task is
    created from a note or a link is removed, with ``task_note_link_id`` as the entity id.
    """

    TASK = "task"
    PROJECT = "project"
    NOTE = "note"
    NOTE_PROJECT_LINK = "note_project_link"
    TASK_NOTE_LINK = "task_note_link"


class ChangeOperation(StrEnum):
    """What happened to an entity: a create/update (``upsert``) or a soft delete (``delete``)."""

    UPSERT = "upsert"
    DELETE = "delete"


def entity_id_for(entity_id: object) -> str:
    """The stored ``entity_id`` for an entity identified by a single UUID/id."""
    return str(entity_id)


def note_project_link_id(note_id: object, project_id: object) -> str:
    """The stored ``entity_id`` for a note↔project link (a pair, not a single UUID)."""
    return f"{note_id}:{project_id}"


def task_note_link_id(task_id: object, note_id: object) -> str:
    """The stored ``entity_id`` for a task↔note link (a pair, not a single UUID)."""
    return f"{task_id}:{note_id}"


@dataclass(frozen=True, slots=True)
class FeedChange:
    """One item of the change feed: what changed and where the change sits on the cursor."""

    entity_type: str
    entity_id: str
    operation: str
    cursor: int
    changed_at: datetime


@dataclass(frozen=True, slots=True)
class FeedPagePlan:
    """How to turn ``limit + 1`` fetched cursors into one safe page.

    ``deliver`` is how many of the fetched (already ordered) rows to return; ``next_since`` is the
    new high-water mark the caller should send next; ``has_more`` says whether anything remains
    beyond it.
    """

    deliver: int
    next_since: int
    has_more: bool


@dataclass(frozen=True, slots=True)
class ChangeSet:
    """One page of the change feed returned by :class:`atlas.changes.service.ChangesService`.

    ``resync_required`` is ``True`` when the requested ``since`` predates the retention floor, so
    the change set cannot be delivered incrementally and the client must full-resync (M7-02). In
    that case ``changes`` is empty and ``next_since`` is the current high-water mark the client
    resumes from after its full resync. ``resync_reason`` says why (``below_floor`` or, when the
    cursor is *ahead* of the server's head after a restore, ``cursor_ahead``; SYNC-01).
    """

    changes: Sequence[FeedChange]
    next_since: int
    has_more: bool
    resync_required: bool = False
    resync_reason: ResyncReason | None = None


def parse_since(value: int | None) -> int:
    """Validate the change cursor ``since``.

    Omitted means ``0`` — "everything the user has, including tombstones". A negative value or one
    beyond :data:`MAX_CURSOR` is rejected (``422``), so no request can push a malformed cursor into
    the database.
    """
    if value is None:
        return 0
    if value < 0 or value > MAX_CURSOR:
        raise InvalidChangeCursorError(f"since must be an integer between 0 and {MAX_CURSOR}")
    return value


def parse_limit(value: int | None) -> int:
    """Validate the page size, defaulting to :data:`DEFAULT_CHANGE_LIMIT` and bounding ``limit``."""
    if value is None:
        return DEFAULT_CHANGE_LIMIT
    if value < 1 or value > MAX_CHANGE_LIMIT:
        raise InvalidChangeCursorError(f"limit must be an integer between 1 and {MAX_CHANGE_LIMIT}")
    return value


def merge_latest(changes: Sequence[FeedChange]) -> list[FeedChange]:
    """Collapse ``changes`` to one item per ``(entity_type, entity_id)`` at its latest cursor.

    The change store already keeps a single row per entity, so this is normally the identity; it
    makes the "a twice-changed entity appears once, at its latest change" rule explicit and holds
    even if a caller ever feeds it several entries for the same entity. The result is ordered by
    cursor ascending.
    """
    latest: dict[tuple[str, str], FeedChange] = {}
    for change in changes:
        key = (change.entity_type, change.entity_id)
        current = latest.get(key)
        if current is None or change.cursor > current.cursor:
            latest[key] = change
    return sorted(latest.values(), key=lambda change: change.cursor)


def plan_change_page(cursors: Sequence[int], *, since: int, limit: int) -> FeedPagePlan:
    """Plan a page from ``limit + 1`` fetched cursors (ordered ascending, unique).

    ``cursors`` are the ``seq`` values of the first ``limit + 1`` changes with ``seq > since``; the
    extra row is what reveals that more remains. Because a cursor is unique per user there are no
    ties, so a page never splits a run and paging from ``next_since`` is gap- and duplicate-free.
    """
    count = len(cursors)
    if count <= limit:
        return FeedPagePlan(
            deliver=count,
            next_since=cursors[-1] if count else since,
            has_more=False,
        )
    return FeedPagePlan(deliver=limit, next_since=cursors[limit - 1], has_more=True)
