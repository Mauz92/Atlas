"""Task CRUD.

Tasks are PostgreSQL-owned (``DATA_MODEL.md`` §2.3). Every mutation bumps the task's
``revision``; an update may carry the ``base_revision`` it was based on and is rejected if the
task has moved on. Deletion is a soft delete (tombstone) so future clients can observe it.
"""

from __future__ import annotations

import uuid
from collections.abc import Mapping
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..models import Task

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


class TaskNotFoundError(LookupError):
    pass


class TaskValidationError(ValueError):
    pass


class TaskRevisionConflictError(RuntimeError):
    """The task changed since the client last read it."""

    def __init__(self, current_revision: int) -> None:
        super().__init__("task has changed since it was read")
        self.current_revision = current_revision


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

    async def list(self) -> list[Task]:
        tasks = await self.session.scalars(
            select(Task)
            .where(Task.user_id == self.user_id, Task.deleted_at.is_(None))
            .order_by(Task.created_at, Task.id)
        )
        return list(tasks)

    async def create(self, data: Mapping[str, Any]) -> Task:
        fields = {name: value for name, value in data.items() if name in _WRITABLE}
        await self._check_parent(fields.get("parent_task_id"))
        task = Task(user_id=self.user_id)
        for name, value in fields.items():
            setattr(task, name, value)
        self.session.add(task)
        await self.session.flush()
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
        await self._check_parent(fields.get("parent_task_id"), itself=task.id)
        for name, value in fields.items():
            setattr(task, name, value)
        task.revision += 1
        await self.session.flush()
        await self.session.refresh(task)
        return task

    async def delete(self, task_id: uuid.UUID) -> None:
        task = await self.get(task_id)
        task.deleted_at = datetime.now(UTC)
        task.revision += 1
        await self.session.flush()

    async def _check_parent(self, parent_id: Any, *, itself: uuid.UUID | None = None) -> None:
        if parent_id is None:
            return
        if itself is not None and parent_id == itself:
            raise TaskValidationError("a task cannot be its own parent")
        parent = await self.session.scalar(
            select(Task.id).where(
                Task.id == parent_id,
                Task.user_id == self.user_id,
                Task.deleted_at.is_(None),
            )
        )
        if parent is None:
            raise TaskValidationError("parent task does not exist")
