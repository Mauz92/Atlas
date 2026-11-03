"""Per-user change feed endpoint (M7-01).

``GET /api/changes?since=<cursor>&limit=<n>`` is the cross-entity incremental pull: a client that
already holds a cursor asks for everything that changed after it — tasks, projects, notes
*metadata* and the note↔project links, including soft-delete tombstones — ordered by a monotonic
per-user cursor. Paging on the returned ``next_since`` until ``has_more`` is false yields the whole
change set exactly once.

The endpoint is read-only and strictly user-scoped. ``since``/``limit`` are bounded at the boundary:
an out-of-range value is ``422`` with no side effects (the request never reaches the database). The
decision record is ``DECISIONS.md`` ADR-0032; the pure cursor/ordering rules are in
:mod:`atlas.changes.feed`.
"""

from __future__ import annotations

from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status

from ..changes import (
    DEFAULT_CHANGE_LIMIT,
    MAX_CHANGE_LIMIT,
    ChangesService,
    InvalidChangeCursorError,
    parse_limit,
    parse_since,
    parse_types,
)
from ..sync.protocol import MAX_DATA_LIMIT
from .deps import DbSession, SyncUser
from .schemas import (
    ChangeOut,
    ChangesOut,
    NoteSyncData,
    ProjectSyncData,
    ResolutionOut,
    TaskSyncData,
)
from .sync_gate import epoch_check, is_sync

router = APIRouter(prefix="/api", tags=["sync"], dependencies=[Depends(epoch_check)])


@router.get("/changes", response_model=ChangesOut)
async def list_changes(
    request: Request,
    user: SyncUser,
    session: DbSession,
    since: Annotated[
        int | None,
        Query(
            description=(
                "Only return changes after this cursor. Defaults to 0 (the whole change set, "
                "including tombstones). Use the previous response's `next_since` to page. A cursor "
                "older than the retention floor returns `resync_required=true` instead of a "
                "partial set."
            ),
        ),
    ] = None,
    limit: Annotated[
        int | None,
        Query(
            description=(
                f"Maximum number of changes per page (default {DEFAULT_CHANGE_LIMIT}, "
                f"max {MAX_CHANGE_LIMIT})."
            ),
        ),
    ] = None,
    include: Annotated[
        Literal["data"] | None,
        Query(
            description=(
                "`data`: add each entity's `revision` and stored state to its item (max "
                f"{MAX_DATA_LIMIT} items per page). Notes carry metadata only."
            ),
        ),
    ] = None,
    types: Annotated[
        str | None,
        Query(
            max_length=200,
            description=(
                "Comma-separated entity types to return (`task`, `project`, `note`, "
                "`note_project_link`, `task_note_link`, `resolution`). The cursor still advances "
                "over the rest. Without `types`, `resolution` entries are returned only in sync "
                "mode (`Atlas-Sync`)."
            ),
        ),
    ] = None,
    snapshot: Annotated[
        bool,
        Query(
            description=(
                "Send `true` on every page of a snapshot walk after the first (the one at "
                "`since=0`): a purge floor above the walk's position then cannot interrupt it."
            ),
        ),
    ] = False,
) -> ChangesOut:
    """Incremental change feed for the calling user (M7-01).

    Returns the caller's changes with ``cursor`` strictly greater than ``since``, ordered by cursor
    ascending. Each change reports its ``entity_type``, ``entity_id``, ``operation`` (``upsert`` or
    ``delete``) and the ``cursor`` it was recorded at. Because each entity is stored once at its
    latest change, an entity bumped twice between two pulls appears **once**, at its latest cursor;
    a soft delete appears once as a ``delete`` tombstone so a client removes its local copy.

    The response carries the new high-water mark ``next_since`` and ``has_more``: send back
    ``since=next_since`` until ``has_more`` is false and the whole change set has been seen exactly
    once. ``since`` (0…2^63-1) and ``limit`` (1…500) are validated at the boundary — an invalid
    value returns ``422`` and changes nothing; the endpoint is read-only and strictly user-scoped.

    If ``since`` predates the retention floor (``users.change_purge_floor``) the changes it misses
    have been purged and can never be delivered, so instead of a partial set that could resurrect a
    deleted entity the response sets ``resync_required`` to ``True`` with an empty ``changes`` list
    and ``next_since`` at the current high-water mark (M7-02). The client must full-resync, then
    resume from ``next_since``. A ``since`` *above* the current head means the server lost changes
    the client holds (restored from an older backup): the response is ``resync_required`` with
    ``resync_reason="cursor_ahead"`` (SYNC-01), never an empty page that looks up to date.
    """
    try:
        cursor = parse_since(since)
        page_size = parse_limit(limit, maximum=MAX_DATA_LIMIT if include else MAX_CHANGE_LIMIT)
        wanted_types = parse_types(types)
    except InvalidChangeCursorError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail=str(exc)
        ) from exc
    page = await ChangesService(session, user.id).changes(
        since=cursor,
        limit=page_size,
        types=wanted_types,
        include_data=include == "data",
        snapshot=snapshot,
        include_resolutions=is_sync(request),
    )
    return ChangesOut(
        changes=[
            ChangeOut(
                entity_type=change.entity_type,
                entity_id=change.entity_id,
                operation=change.operation,
                cursor=change.cursor,
                changed_at=change.changed_at,
                revision=change.revision,
                data=_data_out(change.entity_type, change.data),
            )
            for change in page.changes
        ],
        since=cursor,
        next_since=page.next_since,
        has_more=page.has_more,
        resync_required=page.resync_required,
        resync_reason=page.resync_reason,
        head=page.head,
        floor=page.floor,
    )


def _data_out(entity_type: str, data: dict[str, Any] | None) -> Any:
    if data is None:
        return None
    if entity_type == "task":
        return TaskSyncData.model_validate(data)
    if entity_type == "project":
        return ProjectSyncData.model_validate(data)
    if entity_type == "resolution":
        return ResolutionOut.model_validate(data)
    return NoteSyncData.model_validate(data)
