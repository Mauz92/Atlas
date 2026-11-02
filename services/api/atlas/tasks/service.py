"""Task CRUD and recurrence.

Tasks are PostgreSQL-owned (``DATA_MODEL.md`` §2.3). Every mutation bumps the task's
``revision``; an update may carry the ``base_revision`` it was based on and is rejected if the
task has moved on. Deletion is a soft delete (tombstone) so future clients can observe it.

Recurring tasks (M3-05) use an RFC 5545 RRULE plus a ``recurrence_series`` row. The task that
first carries the rule is the **series head** and is also its first occurrence; every occurrence
points back at the head through ``recurrence_parent_id``. Completing an occurrence advances the
series by exactly one step (see :func:`atlas.tasks.recurrence.next_occurrence`): it completes
only that occurrence and creates the next one, never completing or deleting the series or any
other occurrence. The series row and the head are preserved for the life of the series.

Subtasks (M3-06) are validated here too: a task may point at any other task of the same user as
its parent, provided that would not create a cycle, the parent exists and is not deleted, and the
subtask shares the parent's project (ADR-0016). Completion rolls up only as a derived count — it
never completes the parent.

Listing (M3-08) accepts a validated :class:`~atlas.tasks.filters.TaskFilters` in addition to
``parent_id`` and the views: every filter is applied in SQL with bound parameters, so a search
term is never interpolated into the statement. An unfiltered listing keeps the historical
``(created_at, id)`` order; a filtered one is ordered most-urgent-first then by earliest due date,
so results are deterministic either way.

The change feed (M3-09, :meth:`TasksService.changes`) is the incremental pull: it returns the
user's tasks changed after a revision cursor — live rows **and** soft-deleted tombstones — ordered
by ``revision`` ascending, with the new high-water mark and a ``has_more`` flag for paging. Because
``revision`` is per-task (not a global sequence) a page never splits a run of equal revisions, so
paging the whole change set is gap- and duplicate-free (see :mod:`atlas.tasks.changes`).
"""

from __future__ import annotations

import uuid
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, date, datetime
from typing import Any

from sqlalchemy import ColumnExpressionArgument, case, delete, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.sql import Select
from sqlalchemy.sql.elements import ColumnElement

from ..changes import (
    ChangeEntityType,
    ChangeOperation,
    ChangeRecorder,
    entity_id_for,
)
from ..models import Project, RecurrenceSeries, Tag, Task, TaskStatus, TaskTag
from .changes import plan_change_page
from .filters import DEFAULT_LIMIT, LIKE_ESCAPE, TaskFilters, search_pattern
from .priority import PRIORITY_ORDER
from .recurrence import (
    InvalidRecurrenceRuleError,
    RecurrenceSpec,
    build_spec,
    next_occurrence,
)
from .state import COMPLETED, transition_fields, validate_transition
from .subtasks import (
    ParentRef,
    SubtaskError,
    SubtaskRollup,
    ensure_parent_is_usable,
    rollup_from_statuses,
    subtask_project_id,
    validate_parent,
)
from .timezones import InvalidTimeZoneError, NonexistentWallTimeError, to_utc
from .views import TaskView, due_state_for, matches_view

# Columns a client may set. Identity, owner and sync fields are managed by the service.
_WRITABLE = frozenset(
    {
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
    }
)


#: Limits on a task's tags (client-supplied labels; enforced here as well as in the API schema).
MAX_TAGS = 20
MAX_TAG_LENGTH = 64

#: Alias so annotations inside ``TasksService`` are not confused with its ``list`` method.
TagNames = list[str]


def normalize_tags(names: Iterable[str]) -> list[str]:
    """Trim, strip a leading ``#``, drop blanks and de-duplicate case-insensitively."""
    seen: set[str] = set()
    result: list[str] = []
    for raw in names:
        name = raw.strip().lstrip("#").strip()
        if not name:
            continue
        if len(name) > MAX_TAG_LENGTH:
            raise TaskValidationError(f"tag is longer than {MAX_TAG_LENGTH} characters")
        key = name.casefold()
        if key in seen:
            continue
        seen.add(key)
        result.append(name)
    if len(result) > MAX_TAGS:
        raise TaskValidationError(f"a task can have at most {MAX_TAGS} tags")
    return result


class TaskNotFoundError(LookupError):
    pass


class TaskValidationError(ValueError):
    pass


class TaskRevisionConflictError(RuntimeError):
    """The task changed since the client last read it."""

    def __init__(self, current_revision: int) -> None:
        super().__init__("task has changed since it was read")
        self.current_revision = current_revision


#: SQL rank of a task's priority (``0`` = ``none`` … ``4`` = ``urgent``), derived from the
#: canonical ``PRIORITY_ORDER`` so the sort rule has one source of truth. Unknown values (which the
#: model does not allow) rank below ``none`` rather than breaking the order.
_PRIORITY_RANK = case(
    {value: rank for rank, value in enumerate(PRIORITY_ORDER)},
    value=Task.priority,
    else_=-1,
)


def _filter_conditions(filters: TaskFilters) -> list[ColumnElement[bool]]:
    """Translate validated filters into SQL conditions (every value is bound, never inlined)."""
    conditions: list[ColumnElement[bool]] = []
    if filters.statuses:
        conditions.append(Task.status.in_(filters.statuses))
    if filters.priority is not None:
        conditions.append(Task.priority == filters.priority)
    if filters.due_from is not None:
        conditions.append(Task.due_at >= filters.due_from)
    if filters.due_to is not None:
        conditions.append(Task.due_at <= filters.due_to)
    if filters.start_from is not None:
        conditions.append(Task.start_at >= filters.start_from)
    if filters.start_to is not None:
        conditions.append(Task.start_at <= filters.start_to)
    if filters.project_id is not None:
        conditions.append(Task.project_id == filters.project_id)
    if filters.search is not None:
        # A bound `LIKE` pattern with the metacharacters escaped: the term cannot alter the SQL.
        pattern = search_pattern(filters.search)
        conditions.append(
            or_(
                Task.title.ilike(pattern, escape=LIKE_ESCAPE),
                func.coalesce(Task.description, "").ilike(pattern, escape=LIKE_ESCAPE),
            )
        )
    return conditions


def _apply_filters(statement: Select[Any], filters: TaskFilters) -> Select[Any]:
    """Narrow ``statement`` by the filters (a no-op when none is set)."""
    conditions = _filter_conditions(filters)
    return statement.where(*conditions) if conditions else statement


def _filtered_order() -> tuple[ColumnExpressionArgument[Any], ...]:
    """Deterministic order for a filtered listing: most urgent, then earliest due, then capture."""
    return (
        _PRIORITY_RANK.desc(),
        Task.due_at.asc().nulls_last(),
        Task.created_at,
        Task.id,
    )


def _default_order() -> tuple[ColumnExpressionArgument[Any], ...]:
    """The historical, unfiltered listing order (capture order)."""
    return (Task.created_at, Task.id)


def _normalize_instants(fields: dict[str, Any], tz_name: str | None) -> None:
    """Store start/due instants as UTC, interpreting naive wall-clock input in ``tz_name``."""
    for name in ("start_at", "due_at"):
        value = fields.get(name)
        if value is None:
            continue
        try:
            fields[name] = to_utc(value, tz_name)
        except (NonexistentWallTimeError, InvalidTimeZoneError) as exc:
            raise TaskValidationError(str(exc)) from exc


def _inherit_project(fields: dict[str, Any], parent: ParentRef, *, provided: bool) -> None:
    """Set the subtask's project to the parent's, translating a conflict into a validation error."""
    try:
        fields["project_id"] = subtask_project_id(
            fields.get("project_id"), parent.project_id, provided=provided
        )
    except SubtaskError as exc:
        raise TaskValidationError(str(exc)) from exc


@dataclass(frozen=True, slots=True)
class TaskChangeSet:
    """One page of the incremental change feed (M3-09).

    ``tasks`` are the changed tasks — live rows and soft-deleted tombstones — ordered by
    ``revision`` ascending. ``next_since`` is the caller's new high-water mark (feed it back as
    ``since`` to continue); ``has_more`` says whether any change remains beyond it.
    """

    tasks: Sequence[Task]
    next_since: int
    has_more: bool


class TasksService:
    def __init__(self, session: AsyncSession, user_id: uuid.UUID) -> None:
        self.session = session
        self.user_id = user_id

    async def get(self, task_id: uuid.UUID) -> Task:
        task = await self.session.scalar(
            select(Task).where(
                Task.id == task_id,
                Task.user_id == self.user_id,
                Task.deleted_at.is_(None),
            )
        )
        if task is None:
            raise TaskNotFoundError(str(task_id))
        return task

    async def list(
        self,
        *,
        parent_id: uuid.UUID | None = None,
        filters: TaskFilters | None = None,
        limit: int = DEFAULT_LIMIT,
    ) -> list[Task]:
        """List the user's live tasks, optionally narrowed by ``filters``.

        Filtering by ``parent_id`` requires that the parent exists and is the user's (a
        ``TaskNotFoundError`` is raised otherwise, so a mistyped id is not silently empty).

        ``filters`` (M3-08) narrow the result set in SQL; when at least one filter is set the
        order becomes most-urgent-first, then earliest due date, then capture order, so results
        are deterministic. Without filters the historical ``(created_at, id)`` order is kept.
        ``limit`` bounds the number of returned tasks.
        """
        active = filters if filters is not None else TaskFilters()
        statement = select(Task).where(Task.user_id == self.user_id, Task.deleted_at.is_(None))
        if parent_id is not None:
            parent = await self.get(parent_id)
            statement = statement.where(Task.parent_task_id == parent.id)
        statement = _apply_filters(statement, active)
        order = _default_order() if active.is_empty else _filtered_order()
        tasks = await self.session.scalars(statement.order_by(*order).limit(limit))
        return list(tasks)

    async def list_view(
        self,
        view: TaskView,
        *,
        caller_tz: str | None = None,
        now: datetime | None = None,
        filters: TaskFilters | None = None,
        limit: int = DEFAULT_LIMIT,
    ) -> Sequence[Task]:
        """The user's live tasks that belong in a primary view (Inbox / Today / Upcoming).

        Classifying a task needs "now" and, for a task without a zone of its own, the caller's
        zone, so the filter is applied in Python through the canonical
        :func:`atlas.tasks.views.matches_view` rule instead of re-deriving calendar arithmetic in
        SQL (ADR-0014). Tasks are ordered by due instant for the date-based views and by capture
        order for the Inbox. ``now`` may be supplied for a deterministic classification.

        ``filters`` (M3-08) narrow the candidate set in SQL before classification and therefore
        compose with the view; ``limit`` is applied after classification so a page is never short.
        """
        reference = now if now is not None else datetime.now(UTC)
        active = filters if filters is not None else TaskFilters()
        statement = select(Task).where(Task.user_id == self.user_id, Task.deleted_at.is_(None))
        statement = _apply_filters(statement, active)
        if view is TaskView.INBOX:
            statement = statement.order_by(Task.created_at, Task.id)
        else:
            statement = statement.order_by(Task.due_at, Task.created_at, Task.id)
        tasks = await self.session.scalars(statement)
        matched = [
            task
            for task in tasks
            if matches_view(
                view,
                status=task.status,
                state=due_state_for(
                    task.due_at,
                    now=reference,
                    task_time_zone=task.time_zone,
                    caller_time_zone=caller_tz,
                ),
            )
        ]
        return matched[:limit]

    async def changes(self, *, since: int, limit: int) -> TaskChangeSet:
        """The user's tasks changed after ``since`` — a complete, ordered, tombstone-aware page.

        Returns the tasks (live and soft-deleted) whose ``revision`` is strictly greater than
        ``since``, ordered by ``revision`` ascending, together with the caller's new high-water mark
        and whether more remains. ``since`` is exactly the previous page's ``next_since``, so paging
        covers the whole change set once: no change is skipped and none is repeated.

        A task bumped twice between two pulls appears once, at its latest revision (the feed is the
        current row state, not an append-only log). Because ``revision`` is per-task, several tasks
        can share one revision; a page never splits such a run, so ``next_since`` only ever advances
        past groups that were delivered whole (see :func:`atlas.tasks.changes.plan_change_page`).
        """
        rows = list(
            await self.session.scalars(
                select(Task)
                .where(Task.user_id == self.user_id, Task.revision > since)
                .order_by(Task.revision.asc(), Task.id.asc())
                .limit(limit + 1)
            )
        )
        plan = plan_change_page([task.revision for task in rows], since=since, limit=limit)
        if plan.complete_group is not None:
            group = list(
                await self.session.scalars(
                    select(Task)
                    .where(Task.user_id == self.user_id, Task.revision == plan.complete_group)
                    .order_by(Task.revision.asc(), Task.id.asc())
                )
            )
            return TaskChangeSet(
                tasks=group,
                next_since=plan.complete_group,
                has_more=await self._revision_after(plan.complete_group),
            )
        return TaskChangeSet(
            tasks=rows[: plan.deliver],
            next_since=plan.next_since,
            has_more=plan.has_more,
        )

    async def _revision_after(self, revision: int) -> bool:
        """Whether the user has any task with a ``revision`` greater than ``revision``."""
        found = await self.session.scalar(
            select(Task.id).where(Task.user_id == self.user_id, Task.revision > revision).limit(1)
        )
        return found is not None

    async def subtask_rollups(
        self, task_ids: Iterable[uuid.UUID]
    ) -> dict[uuid.UUID, SubtaskRollup]:
        """Derived ``(total, done)`` counts for the given tasks' direct, live subtasks.

        Tasks without subtasks are absent from the mapping (callers use an empty rollup).
        """
        ids = list(task_ids)
        if not ids:
            return {}
        rows = (
            await self.session.execute(
                select(Task.parent_task_id, Task.status).where(
                    Task.user_id == self.user_id,
                    Task.deleted_at.is_(None),
                    Task.parent_task_id.in_(ids),
                )
            )
        ).all()
        grouped: dict[uuid.UUID, list[str]] = {}
        for parent_id, status in rows:
            if parent_id is None:
                continue
            grouped.setdefault(parent_id, []).append(status)
        return {task_id: rollup_from_statuses(statuses) for task_id, statuses in grouped.items()}

    async def subtask_rollup(self, task_id: uuid.UUID) -> SubtaskRollup:
        """The rollup for a single task (``total=0, done=0`` when it has no subtasks)."""
        return (await self.subtask_rollups([task_id])).get(task_id, SubtaskRollup())

    async def tags_for(self, task_ids: Sequence[uuid.UUID]) -> dict[uuid.UUID, TagNames]:
        """The tag names of each task (sorted case-insensitively), keyed by task id."""
        if not task_ids:
            return {}
        rows = await self.session.execute(
            select(TaskTag.task_id, Tag.name)
            .join(Tag, Tag.id == TaskTag.tag_id)
            .where(TaskTag.task_id.in_(list(task_ids)), Tag.user_id == self.user_id)
        )
        result: dict[uuid.UUID, TagNames] = {}
        for task_id, name in rows:
            result.setdefault(task_id, []).append(name)
        for names in result.values():
            names.sort(key=str.casefold)
        return result

    async def _set_tags(self, task_id: uuid.UUID, names: Iterable[str]) -> None:
        """Replace the task's tag assignments with ``names`` (creating tags that do not exist)."""
        wanted = normalize_tags(names)
        existing = {
            tag.name.casefold(): tag
            for tag in await self.session.scalars(select(Tag).where(Tag.user_id == self.user_id))
        }
        tag_ids: list[uuid.UUID] = []
        for name in wanted:
            tag = existing.get(name.casefold())
            if tag is None:
                tag = Tag(user_id=self.user_id, name=name)
                self.session.add(tag)
                await self.session.flush()
            tag_ids.append(tag.id)
        await self.session.execute(delete(TaskTag).where(TaskTag.task_id == task_id))
        for tag_id in tag_ids:
            self.session.add(TaskTag(task_id=task_id, tag_id=tag_id))
        await self.session.flush()

    async def restore(self, task_id: uuid.UUID) -> Task:
        """Undo a soft delete (the undo of "delete"): the task returns with its id and history.

        Subtasks that were promoted to top level by the delete (ADR-0016) stay promoted. Restoring a
        task that is not deleted, or that is not the caller's, is a ``TaskNotFoundError``.
        """
        task = await self.session.scalar(
            select(Task).where(
                Task.id == task_id,
                Task.user_id == self.user_id,
                Task.deleted_at.is_not(None),
            )
        )
        if task is None:
            raise TaskNotFoundError(str(task_id))
        if task.project_id is not None:
            project_alive = await self.session.scalar(
                select(Project.id).where(
                    Project.id == task.project_id,
                    Project.user_id == self.user_id,
                    Project.deleted_at.is_(None),
                )
            )
            if project_alive is None:
                task.project_id = None
        task.deleted_at = None
        task.revision += 1
        await self.session.flush()
        await self._record_change(task.id, ChangeOperation.UPSERT)
        await self.session.refresh(task)
        return task

    async def _record_change(self, task_id: uuid.UUID, operation: ChangeOperation) -> None:
        """Announce a task change on the caller's personal change feed (M7-01)."""
        await ChangeRecorder(self.session, self.user_id).record(
            ChangeEntityType.TASK, entity_id_for(task_id), operation
        )

    async def create(self, data: Mapping[str, Any]) -> Task:
        fields = {name: value for name, value in data.items() if name in _WRITABLE}
        tags = data.get("tags")
        if tags is not None:
            normalize_tags(tags)  # validate before anything is written
        parent = await self._resolve_parent(fields.get("parent_task_id"))
        if parent is not None:
            _inherit_project(fields, parent, provided=fields.get("project_id") is not None)
        _normalize_instants(fields, fields.get("time_zone"))
        await self._ensure_project(fields.get("project_id"))
        task = Task(user_id=self.user_id)
        for name, value in fields.items():
            setattr(task, name, value)
        for name, value in transition_fields(None, task.status, now=datetime.now(UTC)).items():
            setattr(task, name, value)
        spec = self._head_spec(task)
        self.session.add(task)
        await self.session.flush()
        if tags:
            await self._set_tags(task.id, tags)
        await self._record_change(task.id, ChangeOperation.UPSERT)
        if spec is not None:
            await self._write_series(task, spec)
        await self.session.refresh(task)
        return task

    async def update(
        self,
        task_id: uuid.UUID,
        changes: Mapping[str, Any],
        base_revision: int | None = None,
    ) -> Task:
        task = await self.get(task_id)
        if base_revision is not None and base_revision != task.revision:
            raise TaskRevisionConflictError(task.revision)
        fields = {name: value for name, value in changes.items() if name in _WRITABLE}
        new_tags: TagNames | None = None
        if "tags" in changes:
            new_tags = normalize_tags(changes["tags"] or [])
        parent = await self._resolve_parent(
            fields.get("parent_task_id", task.parent_task_id), itself=task.id
        )
        if parent is not None:
            if "project_id" in fields:
                _inherit_project(fields, parent, provided=True)
            elif task.project_id != parent.project_id:
                fields["project_id"] = parent.project_id
        if "project_id" in fields:
            await self._ensure_project(fields["project_id"])
        previous_status = task.status
        if "status" in fields:
            validate_transition(previous_status, fields["status"])
        _normalize_instants(fields, fields.get("time_zone", task.time_zone))
        if fields.get("recurrence_rule") is not None:
            self._anchor(task, fields)  # a recurrence needs an anchor instant
        for name, value in fields.items():
            setattr(task, name, value)
        if "status" in fields:
            side_effects = transition_fields(
                previous_status, fields["status"], now=datetime.now(UTC)
            )
            for name, value in side_effects.items():
                setattr(task, name, value)
        await self._sync_series(task, fields)
        completing = (
            fields.get("status") == COMPLETED
            and previous_status != COMPLETED
            and self._is_recurring(task)
        )
        if completing:
            await self._advance_series(task)
        task.revision += 1
        await self.session.flush()
        if new_tags is not None:
            await self._set_tags(task.id, new_tags)
        await self._record_change(task.id, ChangeOperation.UPSERT)
        await self.session.refresh(task)
        return task

    async def delete(self, task_id: uuid.UUID) -> None:
        task = await self.get(task_id)
        # Promote the task's direct, live subtasks to top level before hiding the parent. This
        # mirrors the FK's ON DELETE SET NULL intent: subtasks are never deleted or orphaned under
        # a parent that is no longer visible (ADR-0016).
        children = await self.session.scalars(
            select(Task).where(
                Task.user_id == self.user_id,
                Task.parent_task_id == task.id,
                Task.deleted_at.is_(None),
            )
        )
        promoted: list[uuid.UUID] = []
        for child in children:
            child.parent_task_id = None
            child.revision += 1
            promoted.append(child.id)
        task.deleted_at = datetime.now(UTC)
        task.revision += 1
        await self.session.flush()
        # The removal itself is a tombstone; the promoted subtasks are ordinary updates, so an
        # offline client learns both (M7-01).
        recorder = ChangeRecorder(self.session, self.user_id)
        await recorder.record(ChangeEntityType.TASK, entity_id_for(task.id), ChangeOperation.DELETE)
        await recorder.record_many(
            (ChangeEntityType.TASK, entity_id_for(child_id), ChangeOperation.UPSERT)
            for child_id in promoted
        )

    async def _ensure_project(self, project_id: uuid.UUID | None) -> None:
        """A task may only reference a live project owned by the caller (ADR-0020).

        The ``tasks.project_id`` foreign key would otherwise reject an unknown id at flush time
        with a database error; validating here turns that into an ordinary ``400`` and guarantees
        a user cannot attach a task to another user's project.
        """
        if project_id is None:
            return
        found = await self.session.scalar(
            select(Project.id).where(
                Project.id == project_id,
                Project.user_id == self.user_id,
                Project.deleted_at.is_(None),
            )
        )
        if found is None:
            raise TaskValidationError("project does not exist")

    async def _resolve_parent(
        self, parent_id: uuid.UUID | None, *, itself: uuid.UUID | None = None
    ) -> ParentRef | None:
        """Validate a proposed parent id and summarise it for the rules.

        Returns ``None`` when there is no parent; otherwise the parent must exist, belong to the
        user, not be deleted, and must not be ``itself`` or one of ``itself``'s descendants.
        """
        if parent_id is None:
            return None
        try:
            row = await self.session.get(Task, parent_id)
            ensure_parent_is_usable(
                found=row is not None,
                same_user=row is not None and row.user_id == self.user_id,
                deleted=row is not None and row.deleted_at is not None,
            )
            if row is None:  # unreachable: ensure_parent_is_usable already raised
                raise SubtaskError("parent task does not exist")
            parent = ParentRef(
                id=row.id,
                project_id=row.project_id,
                ancestor_ids=await self._ancestor_ids(row),
            )
            validate_parent(task_id=itself, parent=parent)
        except SubtaskError as exc:
            raise TaskValidationError(str(exc)) from exc
        return parent

    async def _ancestor_ids(self, parent: Task) -> tuple[uuid.UUID, ...]:
        """The ids of ``parent``'s ancestors, closest first (its parent, grandparent, …)."""
        ancestors: list[uuid.UUID] = []
        seen = {parent.id}
        current_id = parent.parent_task_id
        while current_id is not None and current_id not in seen:
            seen.add(current_id)
            ancestors.append(current_id)
            row = await self.session.get(Task, current_id)
            current_id = row.parent_task_id if row is not None else None
        return tuple(ancestors)

    # --- Recurrence --------------------------------------------------------------

    @staticmethod
    def _is_recurring(task: Task) -> bool:
        return task.recurrence_rule is not None or task.recurrence_parent_id is not None

    @staticmethod
    def _anchor(task: Task, fields: Mapping[str, Any] | None = None) -> tuple[str, datetime]:
        """The field/anchor instant a series recurs on (``due_at`` preferred over ``start_at``)."""
        overrides = fields or {}
        due_at = overrides.get("due_at", task.due_at)
        if due_at is not None:
            return "due_at", due_at
        start_at = overrides.get("start_at", task.start_at)
        if start_at is not None:
            return "start_at", start_at
        raise TaskValidationError("a recurring task requires a start_at or due_at")

    def _head_spec(self, task: Task) -> RecurrenceSpec | None:
        """The spec for a *new* head task, validating its rule and anchor. ``None`` if not one."""
        if task.recurrence_rule is None or task.recurrence_parent_id is not None:
            return None
        _, anchor_value = self._anchor(task)
        return self._build_spec(task.recurrence_rule, anchor_value, task.time_zone)

    @staticmethod
    def _build_spec(
        rule: str,
        anchor: datetime,
        time_zone: str | None,
        *,
        count: int | None = None,
        end_date: date | None = None,
    ) -> RecurrenceSpec:
        try:
            return build_spec(rule, anchor, time_zone=time_zone, count=count, end_date=end_date)
        except (InvalidRecurrenceRuleError, InvalidTimeZoneError, NonexistentWallTimeError) as exc:
            raise TaskValidationError(str(exc)) from exc

    async def _series_for_head(self, head_id: uuid.UUID) -> RecurrenceSeries | None:
        series: RecurrenceSeries | None = await self.session.scalar(
            select(RecurrenceSeries).where(RecurrenceSeries.recurrence_parent_id == head_id)
        )
        return series

    async def _write_series(self, head: Task, spec: RecurrenceSpec) -> RecurrenceSeries:
        series = await self._series_for_head(head.id)
        if series is None:
            series = RecurrenceSeries(recurrence_parent_id=head.id)
            self.session.add(series)
        series.rule = spec.rule
        series.dtstart = spec.dtstart
        series.time_zone = head.time_zone
        series.count = spec.count
        series.end_date = spec.end_date
        await self.session.flush()
        return series

    async def _sync_series(self, task: Task, fields: Mapping[str, Any]) -> None:
        """Keep the series row in step with a head task's rule and anchor."""
        if task.recurrence_parent_id is not None:
            return  # occurrences do not own the series
        if task.recurrence_rule is None:
            if "recurrence_rule" in fields:
                series = await self._series_for_head(task.id)
                if series is not None:
                    await self.session.delete(series)
                    await self.session.flush()
            return
        if not {"recurrence_rule", "due_at", "start_at", "time_zone"} & fields.keys():
            return
        spec = self._head_spec(task)
        if spec is not None:
            await self._write_series(task, spec)

    async def _advance_series(self, completed: Task) -> None:
        """Complete semantics: generate exactly the next occurrence, or stop at the end."""
        head_id = completed.recurrence_parent_id or completed.id
        series = await self._series_for_head(head_id)
        if series is None and completed.recurrence_parent_id is None:
            spec = self._head_spec(completed)
            if spec is not None:
                series = await self._write_series(completed, spec)
        if series is None:
            return
        if series.dtstart is None:
            return  # a series without an anchor cannot advance
        spec = self._build_spec(
            series.rule,
            series.dtstart,
            series.time_zone,
            count=series.count,
            end_date=series.end_date,
        )
        anchor_name, anchor_value = self._anchor(completed)
        following = next_occurrence(spec, after=anchor_value)
        if following is None:
            return  # the series has no successor: it stops here
        if await self._occurrence_exists(head_id, following):
            return  # idempotent: the next occurrence is already there
        occurrence = self._build_occurrence(
            completed, series.rule, head_id, anchor_name, anchor_value, following
        )
        self.session.add(occurrence)
        await self.session.flush()
        # A generated occurrence is a new task; announce it so offline clients pull it (M7-01).
        await self._record_change(occurrence.id, ChangeOperation.UPSERT)

    async def _occurrence_exists(self, head_id: uuid.UUID, instant: datetime) -> bool:
        existing = await self.session.scalar(
            select(Task.id).where(
                Task.user_id == self.user_id,
                Task.recurrence_parent_id == head_id,
                Task.deleted_at.is_(None),
                or_(Task.due_at == instant, Task.start_at == instant),
            )
        )
        return existing is not None

    @staticmethod
    def _build_occurrence(
        completed: Task,
        rule: str,
        head_id: uuid.UUID,
        anchor_name: str,
        anchor_value: datetime,
        instant: datetime,
    ) -> Task:
        """A fresh occurrence that continues the series from ``completed``."""
        delta = instant - anchor_value
        occurrence = Task(
            user_id=completed.user_id,
            title=completed.title,
            description=completed.description,
            status=TaskStatus.INBOX.value,
            priority=completed.priority,
            project_id=completed.project_id,
            time_zone=completed.time_zone,
            duration_minutes=completed.duration_minutes,
            recurrence_rule=rule,
            recurrence_parent_id=head_id,
            completed_at=None,
        )
        setattr(occurrence, anchor_name, instant)
        other = "start_at" if anchor_name == "due_at" else "due_at"
        other_value = getattr(completed, other)
        if other_value is not None:
            setattr(occurrence, other, other_value + delta)
        return occurrence
