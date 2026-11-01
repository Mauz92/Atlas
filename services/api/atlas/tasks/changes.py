"""Task change log — incremental client pull (M3-09).

``GET /api/tasks/changes`` lets a client that already holds a ``revision`` ask for only what has
changed since, so it converges without re-downloading the whole list. This module holds the *pure*
rule — the cursor/limit parsing and the page-planning arithmetic — so it can be tested without a
database, following the pattern of :mod:`atlas.tasks.filters`, :mod:`atlas.tasks.priority`,
:mod:`atlas.tasks.views` and :mod:`atlas.tasks.subtasks`. The SQL lives in
:mod:`atlas.tasks.service`; the HTTP boundary lives in :mod:`atlas.api.tasks`.

Semantics:

- A task's ``revision`` starts at ``1`` and increments on every mutation. A change pull returns the
  user's tasks — including soft-deleted *tombstones* — whose ``revision`` is strictly greater than
  the caller's cursor ``since``, ordered by ``revision`` ascending. A task bumped twice between two
  pulls therefore appears exactly once, at its latest revision.
- ``revision`` is a **per-task** counter, not a global sequence, so many tasks legitimately share
  the same revision (every freshly captured task is revision ``1``). Ordering by ``revision`` alone
  is not a total order, and a page boundary must never fall *inside* a run of equal revisions — if
  it did, advancing the cursor to that revision would skip the remainder of the run (a gap). The
  planner below therefore always hands out whole revision groups and reports a cursor that only
  covers fully delivered groups; a client can page from the returned ``next_since`` until
  ``has_more`` is false and see the whole change set exactly once, with no gaps and no duplicates.
- The page contains at most ``limit`` tasks, except that a single revision group is never split: if
  the smallest group still to deliver is larger than ``limit`` the page extends to the end of that
  group so the cursor makes progress.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass

from .filters import InvalidTaskFilterError

#: Default number of changes returned by ``GET /api/tasks/changes`` when ``limit`` is omitted.
DEFAULT_CHANGE_LIMIT = 200
#: Largest accepted ``limit``.
MAX_CHANGE_LIMIT = 500
#: Largest accepted cursor. ``revision`` is a 32-bit PostgreSQL integer, so a larger ``since``
#: cannot match any row; it is rejected at the boundary instead of reaching the database.
MAX_SINCE = 2_147_483_647


def parse_since(value: int | None) -> int:
    """Validate the change cursor ``since``.

    Omitted means ``0`` — "everything the user has, including tombstones". A negative value or one
    beyond :data:`MAX_SINCE` is rejected (``422``), so no request can push a malformed cursor into
    the database.
    """
    if value is None:
        return 0
    if value < 0 or value > MAX_SINCE:
        raise InvalidTaskFilterError(f"since must be an integer between 0 and {MAX_SINCE}")
    return value


def parse_change_limit(value: int | None) -> int:
    """Validate the page size, defaulting to :data:`DEFAULT_CHANGE_LIMIT` and bounding ``limit``."""
    if value is None:
        return DEFAULT_CHANGE_LIMIT
    if value < 1 or value > MAX_CHANGE_LIMIT:
        raise InvalidTaskFilterError(f"limit must be an integer between 1 and {MAX_CHANGE_LIMIT}")
    return value


@dataclass(frozen=True, slots=True)
class ChangePagePlan:
    """How to turn ``limit + 1`` fetched revisions into one safe change page.

    ``deliver`` is how many of the fetched (already ordered) rows to return. ``next_since`` is the
    new high-water mark the caller should send next. ``has_more`` says whether any change remains
    beyond ``next_since``. ``complete_group`` is set instead of ``deliver`` when the whole page is a
    single run of equal revisions that continues past the fetched window: the caller must fetch that
    entire revision group (all rows at that revision) and return them together.
    """

    deliver: int
    next_since: int
    has_more: bool
    complete_group: int | None = None


def plan_change_page(revisions: Sequence[int], *, since: int, limit: int) -> ChangePagePlan:
    """Plan a page from ``limit + 1`` fetched revisions (ordered ascending by revision).

    ``revisions`` must be the ``revision`` values of the first ``limit + 1`` rows with
    ``revision > since``; the extra row is what reveals that more remains. The returned plan never
    splits a run of equal revisions, so paging from ``next_since`` is gap- and duplicate-free.
    """
    count = len(revisions)
    if count <= limit:
        # Every remaining change fits in one page: nothing is left behind.
        return ChangePagePlan(
            deliver=count,
            next_since=revisions[-1] if count else since,
            has_more=False,
        )
    # ``count == limit + 1``: at least one more row exists past the page.
    boundary = revisions[limit - 1]
    if revisions[limit] != boundary:
        # The revision group ends exactly at the limit, so the page can stop here safely.
        return ChangePagePlan(deliver=limit, next_since=boundary, has_more=True)
    # The limit falls inside a run of equal revisions. Walk back to the start of that run.
    group = 0
    while group < limit and revisions[limit - 1 - group] == boundary:
        group += 1
    prefix = limit - group
    if prefix > 0:
        # Drop the split run and stop just before it; the next pull delivers it whole.
        return ChangePagePlan(deliver=prefix, next_since=revisions[prefix - 1], has_more=True)
    # The whole page is one continuing run: deliver it in full (bounded by the group size).
    return ChangePagePlan(deliver=0, next_since=boundary, has_more=True, complete_group=boundary)
