"""Tasks API: CRUD with idempotent mutations.

Mutations may carry an ``Idempotency-Key`` header (see :mod:`atlas.idempotency`); a retry with
the same key and payload returns the original response instead of applying the change again.

``GET /api/tasks/changes`` (M3-09) is the incremental pull: it returns the caller's tasks changed
after a revision cursor — including soft-deleted tombstones — so clients converge without
re-downloading the whole list (see :mod:`atlas.tasks.changes`).
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from typing import Annotated, Any, NoReturn

from fastapi import APIRouter, Header, HTTPException, Query, Response, status
from fastapi.responses import JSONResponse

from ..idempotency import IdempotencyConflictError, IdempotencyStore, fingerprint
from ..models import Task
from ..reminders import (
    ReminderPreferencesService,
    ReminderService,
    TaskReminderState,
)
from ..reminders import (
    ReminderTiming as DomainTiming,
)
from ..tasks import (
    DEFAULT_CHANGE_LIMIT,
    DEFAULT_LIMIT,
    MAX_INSTANT_LENGTH,
    MAX_LIMIT,
    MAX_SEARCH_LENGTH,
    InvalidRecurrenceRuleError,
    InvalidTaskFilterError,
    InvalidTaskTransitionError,
    InvalidTimeZoneError,
    NonexistentWallTimeError,
    SubtaskRollup,
    TaskNotFoundError,
    TaskRevisionConflictError,
    TasksService,
    TaskValidationError,
    TaskView,
    build_filters,
    due_state_for,
    is_valid_time_zone,
    parse_change_limit,
    parse_since,
    preview_occurrences,
)
from .deps import CurrentUser, DbSession
from .schemas import (
    RecurrencePreviewOut,
    RecurrencePreviewRequest,
    ReminderTiming,
    TaskChangeOut,
    TaskChangesOut,
    TaskCreateRequest,
    TaskListOut,
    TaskOut,
    TaskReminderOut,
    TaskReminderRequest,
    TaskUpdateRequest,
)

router = APIRouter(prefix="/api/tasks", tags=["tasks"])

IdempotencyKey = Annotated[str | None, Header(alias="Idempotency-Key", max_length=200)]


def _translate(exc: Exception) -> NoReturn:
    """Map domain errors onto HTTP responses; re-raise anything unexpected."""
    if isinstance(exc, TaskNotFoundError):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found") from exc
    if isinstance(exc, TaskRevisionConflictError):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "message": "task changed since it was read",
                "current_revision": exc.current_revision,
            },
        ) from exc
    if isinstance(exc, IdempotencyConflictError):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="idempotency key reused with a different request",
        ) from exc
    if isinstance(exc, InvalidTaskTransitionError):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "message": "invalid status transition",
                "current": exc.current,
                "requested": exc.requested,
                "allowed": sorted(exc.allowed),
            },
        ) from exc
    if isinstance(exc, TaskValidationError):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    raise exc


def task_out(
    task: Task,
    rollup: SubtaskRollup | None = None,
    *,
    now: datetime,
    caller_tz: str | None = None,
    tags: list[str] | None = None,
) -> TaskOut:
    """Serialise a task, attaching its derived subtask rollup and due state.

    ``due_state`` is computed from the task's own zone, or the caller's zone for a task that has
    none, so the Today/Upcoming views can group work without re-deriving date logic (ADR-0014).

    Public because the project task listing (M4-02) returns the same shape.
    """
    out = TaskOut.model_validate(task)
    if rollup is not None:
        out.subtasks_total = rollup.total
        out.subtasks_done = rollup.done
    if tags is not None:
        out.tags = tags
    out.due_state = due_state_for(
        task.due_at,
        now=now,
        task_time_zone=task.time_zone,
        caller_time_zone=caller_tz,
    )
    return out


def _change_out(
    task: Task,
    rollup: SubtaskRollup | None = None,
    *,
    now: datetime,
    tags: list[str] | None = None,
) -> TaskChangeOut:
    """Serialise one change-feed item, including its tombstone marker (``deleted_at``)."""
    out = TaskChangeOut.model_validate(task)
    if tags is not None:
        out.tags = tags
    if rollup is not None:
        out.subtasks_total = rollup.total
        out.subtasks_done = rollup.done
    out.due_state = due_state_for(task.due_at, now=now, task_time_zone=task.time_zone)
    return out


@router.post("/recurrence/preview", response_model=RecurrencePreviewOut)
async def preview_recurrence(payload: RecurrencePreviewRequest, user: CurrentUser) -> Any:
    """What an RRULE means for a task anchored at ``anchor`` (MU-04); read-only.

    Uses the same validation and RFC 5545 engine as creating or completing a recurring task, so the
    client shows the server's answer instead of reimplementing recurrence. An unusable rule, an
    unknown zone or a wall-clock time the zone skipped is a ``422`` with the server's message.
    """
    try:
        instants = preview_occurrences(
            payload.rule, payload.anchor, time_zone=payload.time_zone, limit=payload.limit
        )
    except (InvalidRecurrenceRuleError, InvalidTimeZoneError, NonexistentWallTimeError) as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail=str(exc)
        ) from exc
    return RecurrencePreviewOut(occurrences=instants)


@router.post("", response_model=TaskOut, status_code=status.HTTP_201_CREATED)
async def create_task(
    payload: TaskCreateRequest,
    user: CurrentUser,
    session: DbSession,
    idempotency_key: IdempotencyKey = None,
) -> Any:
    store = IdempotencyStore(session, user.id)
    if idempotency_key:
        try:
            stored = await store.reserve(
                idempotency_key, "task.create", fingerprint(payload.model_dump(mode="json"))
            )
        except Exception as exc:
            _translate(exc)
        if stored is not None:
            return JSONResponse(status_code=stored.status_code, content=stored.body)
    try:
        service = TasksService(session, user.id)
        task = await service.create(payload.model_dump())
    except Exception as exc:
        _translate(exc)
    # Materialise/reschedule the task's durable reminder in the same transaction (M8-01).
    await ReminderService(session, user.id).sync_for_task(task.id)
    out = task_out(
        task,
        await service.subtask_rollup(task.id),
        now=datetime.now(UTC),
        tags=(await service.tags_for([task.id])).get(task.id, []),
    )
    if idempotency_key:
        await store.remember(idempotency_key, status_code=201, body=out.model_dump(mode="json"))
    await session.commit()
    return out


@router.get("", response_model=TaskListOut)
async def list_tasks(
    user: CurrentUser,
    session: DbSession,
    parent_task_id: Annotated[uuid.UUID | None, Query()] = None,
    view: Annotated[TaskView | None, Query()] = None,
    tz: Annotated[str | None, Query(max_length=64)] = None,
    status_filter: Annotated[
        list[str] | None,
        Query(
            alias="status",
            description=(
                "Only these task statuses; repeat the parameter or use comma-separated values "
                "(inbox, next, in_progress, completed, archived)."
            ),
        ),
    ] = None,
    priority: Annotated[
        str | None,
        Query(
            max_length=32,
            description="Only this priority (none, low, medium, high, urgent).",
        ),
    ] = None,
    due_from: Annotated[
        str | None,
        Query(
            max_length=MAX_INSTANT_LENGTH,
            description="Inclusive lower bound on due_at (ISO 8601 date or instant, UTC).",
        ),
    ] = None,
    due_to: Annotated[
        str | None,
        Query(
            max_length=MAX_INSTANT_LENGTH,
            description="Inclusive upper bound on due_at (ISO 8601 date or instant, UTC).",
        ),
    ] = None,
    start_from: Annotated[
        str | None,
        Query(
            max_length=MAX_INSTANT_LENGTH,
            description="Inclusive lower bound on start_at (ISO 8601 date or instant, UTC).",
        ),
    ] = None,
    start_to: Annotated[
        str | None,
        Query(
            max_length=MAX_INSTANT_LENGTH,
            description="Inclusive upper bound on start_at (ISO 8601 date or instant, UTC).",
        ),
    ] = None,
    project_id: Annotated[
        uuid.UUID | None, Query(description="Only tasks in this project.")
    ] = None,
    q: Annotated[
        str | None,
        Query(
            min_length=1,
            max_length=MAX_SEARCH_LENGTH,
            description=(
                "Case-insensitive text search over title and description. "
                "Percent and underscore match literally."
            ),
        ),
    ] = None,
    limit: Annotated[
        int | None,
        Query(
            ge=1,
            le=MAX_LIMIT,
            description=f"Maximum number of tasks to return (default {DEFAULT_LIMIT}).",
        ),
    ] = None,
) -> TaskListOut:
    """List tasks.

    With ``parent_task_id`` only that task's direct subtasks are returned. With ``view`` one of
    the primary views is returned — ``inbox`` (captured, not yet triaged), ``today`` (overdue or
    due today) or ``upcoming`` (due on a later day). ``tz`` is the caller's IANA time zone, used
    to resolve "today" for tasks that carry no zone of their own (ADR-0014). ``view`` and
    ``parent_task_id`` are mutually exclusive.

    The optional M3-08 filters narrow the result further and compose with each other, with
    ``parent_task_id`` and with ``view`` (ADR-0018): ``status`` (repeated or comma-separated),
    ``priority``, an inclusive ``due_from``/``due_to`` range on ``due_at``, an inclusive
    ``start_from``/``start_to`` range on ``start_at``, ``project_id`` and the text search ``q``
    over title/description. An unknown status/priority, a malformed or inverted date range or an
    over-long search term is rejected with ``422``. Results are bounded by ``limit``. A listing
    without filters keeps its original capture order; a filtered listing is ordered most urgent
    first, then by earliest due date.
    """
    if tz is not None and not is_valid_time_zone(tz):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="unknown IANA time zone",
        )
    if view is not None and parent_task_id is not None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="view and parent_task_id cannot be combined",
        )
    try:
        filters = build_filters(
            status=status_filter,
            priority=priority,
            due_from=due_from,
            due_to=due_to,
            start_from=start_from,
            start_to=start_to,
            project_id=project_id,
            q=q,
        )
    except InvalidTaskFilterError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail=str(exc)
        ) from exc
    page_size = DEFAULT_LIMIT if limit is None else limit
    service = TasksService(session, user.id)
    reference = datetime.now(UTC)
    try:
        if view is None:
            tasks = await service.list(parent_id=parent_task_id, filters=filters, limit=page_size)
        else:
            tasks = list(
                await service.list_view(
                    view, caller_tz=tz, now=reference, filters=filters, limit=page_size
                )
            )
    except Exception as exc:
        _translate(exc)
    rollups = await service.subtask_rollups([task.id for task in tasks])
    tag_names = await service.tags_for([task.id for task in tasks])
    return TaskListOut(
        tasks=[
            task_out(
                task,
                rollups.get(task.id),
                now=reference,
                caller_tz=tz,
                tags=tag_names.get(task.id, []),
            )
            for task in tasks
        ]
    )


@router.get("/changes", response_model=TaskChangesOut)
async def task_changes(
    user: CurrentUser,
    session: DbSession,
    since: Annotated[
        int | None,
        Query(
            description=(
                "Only return tasks whose revision is strictly greater than this cursor. "
                "Defaults to 0 (the whole change set, including tombstones)."
            ),
        ),
    ] = None,
    limit: Annotated[
        int | None,
        Query(
            description=(
                f"Maximum number of tasks per page (default {DEFAULT_CHANGE_LIMIT}); a revision "
                "group is never split, so a page can extend to the end of that group."
            ),
        ),
    ] = None,
) -> TaskChangesOut:
    """Incremental change feed for the calling user's tasks (M3-09).

    Returns the tasks whose ``revision`` is strictly greater than ``since``, ordered by ``revision``
    ascending, **including soft-deleted tombstones** (a non-null ``deleted_at``) so a client
    observes deletions and converges without re-downloading the whole list. A task bumped twice
    between two pulls appears once, at its latest revision.

    The response carries the caller's new high-water mark ``next_since`` and ``has_more``: send back
    ``since=next_since`` until ``has_more`` is false and the whole change set has been seen exactly
    once. Because ``revision`` is per-task (several tasks can share one), a page never splits a run
    of equal revisions, so paging has no gaps and no duplicates. ``since`` (0…2147483647) and
    ``limit`` (1…500) are validated at the boundary — an invalid value returns ``422`` and changes
    nothing; the endpoint is read-only and strictly user-scoped.
    """
    try:
        cursor = parse_since(since)
        page_size = parse_change_limit(limit)
    except InvalidTaskFilterError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail=str(exc)
        ) from exc
    service = TasksService(session, user.id)
    changes = await service.changes(since=cursor, limit=page_size)
    now = datetime.now(UTC)
    rollups = await service.subtask_rollups([task.id for task in changes.tasks])
    tag_names = await service.tags_for([task.id for task in changes.tasks])
    return TaskChangesOut(
        tasks=[
            _change_out(task, rollups.get(task.id), now=now, tags=tag_names.get(task.id, []))
            for task in changes.tasks
        ],
        since=cursor,
        next_since=changes.next_since,
        has_more=changes.has_more,
    )


@router.get("/{task_id}", response_model=TaskOut)
async def get_task(task_id: uuid.UUID, user: CurrentUser, session: DbSession) -> TaskOut:
    service = TasksService(session, user.id)
    try:
        task = await service.get(task_id)
    except Exception as exc:
        _translate(exc)
    return task_out(
        task,
        await service.subtask_rollup(task.id),
        now=datetime.now(UTC),
        tags=(await service.tags_for([task.id])).get(task.id, []),
    )


@router.patch("/{task_id}", response_model=TaskOut)
async def update_task(
    task_id: uuid.UUID,
    payload: TaskUpdateRequest,
    user: CurrentUser,
    session: DbSession,
    idempotency_key: IdempotencyKey = None,
) -> Any:
    store = IdempotencyStore(session, user.id)
    changes = payload.model_dump(exclude_unset=True)
    request_payload = {
        "task_id": str(task_id),
        **payload.model_dump(exclude_unset=True, mode="json"),
    }
    if idempotency_key:
        try:
            stored = await store.reserve(
                idempotency_key, "task.update", fingerprint(request_payload)
            )
        except Exception as exc:
            _translate(exc)
        if stored is not None:
            return JSONResponse(status_code=stored.status_code, content=stored.body)
    try:
        service = TasksService(session, user.id)
        task = await service.update(task_id, changes, payload.base_revision)
    except Exception as exc:
        _translate(exc)
    # An edited due date/time-zone/policy/status reschedules (or cancels) the reminder (M8-01).
    await ReminderService(session, user.id).sync_for_task(task.id)
    out = task_out(
        task,
        await service.subtask_rollup(task.id),
        now=datetime.now(UTC),
        tags=(await service.tags_for([task.id])).get(task.id, []),
    )
    if idempotency_key:
        await store.remember(idempotency_key, status_code=200, body=out.model_dump(mode="json"))
    await session.commit()
    return out


@router.delete("/{task_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_task(
    task_id: uuid.UUID,
    user: CurrentUser,
    session: DbSession,
    idempotency_key: IdempotencyKey = None,
) -> Response:
    store = IdempotencyStore(session, user.id)
    if idempotency_key:
        try:
            stored = await store.reserve(
                idempotency_key, "task.delete", fingerprint({"task_id": str(task_id)})
            )
        except Exception as exc:
            _translate(exc)
        if stored is not None:
            return Response(status_code=stored.status_code)
    try:
        await TasksService(session, user.id).delete(task_id)
    except Exception as exc:
        _translate(exc)
    # A deleted task must not be reminded; cancel any pending reminder (M8-01).
    await ReminderService(session, user.id).cancel_for_task(task_id)
    if idempotency_key:
        await store.remember(idempotency_key, status_code=204, body={})
    await session.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/{task_id}/restore", response_model=TaskOut)
async def restore_task(
    task_id: uuid.UUID,
    user: CurrentUser,
    session: DbSession,
    idempotency_key: IdempotencyKey = None,
) -> Any:
    """Undo a delete: bring a soft-deleted task of the caller's back (the "undo" of ``DELETE``).

    The task keeps its id and history; its revision advances, so offline clients learn of the
    restoration through the change feed. A task that is not deleted (or not the caller's) is a
    ``404``. Subtasks promoted to top level by the delete stay promoted.
    """
    store = IdempotencyStore(session, user.id)
    if idempotency_key:
        try:
            stored = await store.reserve(
                idempotency_key, "task.restore", fingerprint({"task_id": str(task_id)})
            )
        except Exception as exc:
            _translate(exc)
        if stored is not None:
            return JSONResponse(status_code=stored.status_code, content=stored.body)
    try:
        service = TasksService(session, user.id)
        task = await service.restore(task_id)
    except Exception as exc:
        _translate(exc)
    await ReminderService(session, user.id).sync_for_task(task.id)
    out = task_out(
        task,
        await service.subtask_rollup(task.id),
        now=datetime.now(UTC),
        tags=(await service.tags_for([task.id])).get(task.id, []),
    )
    if idempotency_key:
        await store.remember(idempotency_key, status_code=200, body=out.model_dump(mode="json"))
    await session.commit()
    return out


def _task_reminder_out(state: TaskReminderState) -> TaskReminderOut:
    """Serialise a task's reminder timing, rendering the domain value as the API value."""
    return TaskReminderOut(
        override=None if state.override is None else ReminderTiming.from_domain(state.override),
        effective=(
            None if state.effective is None else ReminderTiming.from_domain(state.effective)
        ),
        remind_at=state.remind_at,
    )


@router.get("/{task_id}/reminder", response_model=TaskReminderOut)
async def get_task_reminder(
    task_id: uuid.UUID, user: CurrentUser, session: DbSession
) -> TaskReminderOut:
    """One of the caller's tasks' reminder timing (M8-05): override, effective timing and fire time.

    Strictly user-scoped: another user's task id is a ``404``, so a task cannot be probed across
    users. A task with no reminder has ``effective`` and ``remind_at`` null and ``override`` null.
    """
    state = await ReminderPreferencesService(session, user.id).get_task_reminder(task_id)
    if state is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found")
    return _task_reminder_out(state)


@router.put("/{task_id}/reminder", response_model=TaskReminderOut)
async def set_task_reminder(
    payload: TaskReminderRequest,
    task_id: uuid.UUID,
    user: CurrentUser,
    session: DbSession,
) -> TaskReminderOut:
    """Set (or clear) a per-entity reminder override and reschedule that task's durable reminder.

    A ``timing`` sets an override that takes precedence over the caller's default; ``null`` clears
    it, so the task falls back to the default. Idempotent. The reminder is re-materialised through
    the M8-01 scheduler in the same transaction, so a later timing fires later and an earlier one
    earlier (``no new scheduling logic``). An invalid timing is rejected at the boundary with no
    side effects, and another user's task id is a ``404``.
    """
    timing: DomainTiming | None = None if payload.timing is None else payload.timing.to_domain()
    service = ReminderPreferencesService(session, user.id)
    state = await service.set_task_override(task_id, timing)
    if state is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found")
    await session.commit()
    return _task_reminder_out(state)
