"""Change-feed retention: the window, the purge floor and the resync signal (M7-02).

The per-user change feed (M7-01, :mod:`atlas.changes`) is the *current change state*: one row per
entity, with a soft-deleted entity kept as a ``delete`` tombstone so an offline client can observe
the deletion. A tombstone cannot be kept forever, so a **retention window** bounds the feed's
history: a durable purge job (:mod:`atlas.changes.purge`, scheduled from
:mod:`atlas.jobs.handlers`) removes ``change_log`` rows older than the window. It never removes the
user's *entity* rows: a soft-deleted task/project/note stays a tombstone in its own table
(``deleted_at``) — only the feed history is bounded.

Removing a change row is safe only if no client still relies on it, so the purge keeps a per-user
**purge floor** (``users.change_purge_floor``): every change with ``seq <= floor`` has been purged
and can no longer be delivered. When a client asks for changes with ``since < floor`` it has missed
changes it can never recover — possibly including a *delete* — so the feed must not hand it a
partial set that could resurrect an entity. It answers ``resync_required`` instead, and the client
full-resyncs.

This module holds the **pure** rules (no database): the cutoff arithmetic and the resync test, so
the boundary logic is unit-testable. The SQL lives in :mod:`atlas.changes.purge`.
"""

from __future__ import annotations

from datetime import datetime, timedelta
from enum import StrEnum

#: Default retention window, in days, of *deletion tombstones* in the feed (SYNC-03e, ADR-0059 D2;
#: it was 30 under ADR-0033, which also purged upserts). Bounds how long a client can be away and
#: still catch up incrementally before it is told to resync. Upsert rows are never purged.
DEFAULT_RETENTION_DAYS = 90
#: The smallest configurable window: a shorter one would make an ordinary holiday force a resync.
MIN_RETENTION_DAYS = 30


class InvalidRetentionError(ValueError):
    """A retention window that is not at least one day long."""


def retention_cutoff(now: datetime, retention_days: int) -> datetime:
    """The instant before which changes are purgeable: ``now`` minus the retention window.

    ``retention_days`` must be at least one; a window of zero (or less) would purge the live feed
    the moment it is written, so it is rejected rather than silently emptying the feed.
    """
    if retention_days < 1:
        raise InvalidRetentionError("change retention must be at least 1 day")
    return now - timedelta(days=retention_days)


def resync_required(since: int, purge_floor: int) -> bool:
    """Whether a client cursor predates everything the feed still retains.

    ``since < purge_floor`` means changes in ``(since, purge_floor]`` have been purged: the client
    can never learn about them, so it must full-resync rather than trust a partial feed that could
    let it resurrect a deleted entity. ``since >= purge_floor`` is safe — every change after the
    floor is still retained (the floor is the highest purged cursor, and purging removes a prefix
    of the cursor order), so the normal incremental pull is correct.
    """
    return since < purge_floor


class ResyncReason(StrEnum):
    """Why a client must resync instead of pulling incrementally (SYNC-01)."""

    #: ``since`` predates the purge floor: changes it missed were purged (M7-02).
    BELOW_FLOOR = "below_floor"
    #: ``since`` is beyond the server's head: this server has lost changes the client already saw
    #: (restored from an older backup) or is a different server (SYNC_PROTOCOL.md §4, §7.4).
    CURSOR_AHEAD = "cursor_ahead"


def resync_reason(
    since: int, purge_floor: int, head: int, *, snapshot: bool = False
) -> ResyncReason | None:
    """The reason a client at ``since`` cannot be served incrementally, or ``None`` if it can.

    ``head`` is the last cursor the server has allocated. A cursor above it can only have come from
    a server state that no longer exists, so returning "no changes" would leave the client believing
    it is up to date while the server lacks what the client already holds; it must be told.

    ``snapshot`` marks a page of a snapshot walk that began at cursor 0 (SYNC-03e): such a client
    holds nothing from before the walk, so a purge floor above its position cannot hide a deletion
    from it (a deletion during the walk is recent, hence retained). Without this a device whose
    snapshot spans several pages could never finish bootstrapping once the floor passed the cursor
    of its first page (found by the simulation, seed 29).
    """
    if since > head:
        return ResyncReason.CURSOR_AHEAD
    if since > 0 and not snapshot and resync_required(since, purge_floor):
        # ``since == 0`` is a snapshot request (nothing is held, so no deletion can be missed);
        # it is always served, which is why upsert rows are never purged (ADR-0059 D2).
        return ResyncReason.BELOW_FLOOR
    return None
