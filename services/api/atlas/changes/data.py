"""Entity payloads for ``GET /api/changes?include=data`` (SYNC-03e; SYNC_PROTOCOL.md section 4).

One query per entity type for a whole page (no N+1). The payload is the *stored* state: the
persisted columns, ``tags`` and ``field_revisions`` for tasks, and for notes the metadata only
(content is fetched on demand: a page of notes must not carry megabytes). Derived values
(``due_state``, subtask rollups, project progress, backlinks) are deliberately absent: each client
computes them or asks the server when online. Tombstones carry ``deleted_at``.

``data`` is read when the response is built, so it may be newer than the item's cursor; the entity
then appears again later with a higher cursor (state-based feed, SYNC_PROTOCOL.md section 4.2).
"""

from __future__ import annotations

import uuid
from collections.abc import Iterable
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..models import NoteIndex, Project, Reminder, ReminderDelivery, Tag, Task, TaskTag
from ..sync.fields import PROJECT_FIELDS, TASK_FIELDS
from .feed import ChangeEntityType

_COMMON = ("id", "revision", "deleted_at", "created_at", "updated_at")
_TASK_COLUMNS = (*_COMMON, "reminder_policy_id", *[f for f in TASK_FIELDS if f != "tags"])
_PROJECT_COLUMNS = (*_COMMON, *PROJECT_FIELDS)
_NOTE_COLUMNS = (*_COMMON, "path", "title", "content_hash", "size_bytes")


def _row(entity: object, columns: Iterable[str]) -> dict[str, Any]:
    return {name: getattr(entity, name) for name in columns}


def _ids(entity_ids: Iterable[str]) -> list[uuid.UUID]:
    found: list[uuid.UUID] = []
    for raw in entity_ids:
        try:
            found.append(uuid.UUID(raw))
        except ValueError:  # a pair id of a link; those carry no payload
            continue
    return found


def reminder_data(reminder: Reminder, delivered_at: object) -> dict[str, Any]:
    """The device-visible payload of a reminder (SYNC_PROTOCOL.md 14.2): the stored feed fields, the
    derived ``effective_at`` and the informational ``server_delivered_at``. Never the task text."""
    return {
        "id": reminder.id,
        "revision": reminder.revision,
        "task_id": reminder.entity_id,
        "state": reminder.state,
        "remind_at": reminder.remind_at,
        "snoozed_until": reminder.snoozed_until,
        "acknowledged_at": reminder.acknowledged_at,
        "effective_at": reminder.snoozed_until or reminder.remind_at,
        "server_delivered_at": delivered_at,
    }


async def load_entity_data(
    session: AsyncSession, user_id: uuid.UUID, wanted: dict[str, list[str]]
) -> dict[tuple[str, str], tuple[int, dict[str, Any]]]:
    """``{(entity_type, entity_id): (revision, data)}`` for the entities in ``wanted``.

    Entities that no longer exist (or are not the caller's) are simply absent from the result.
    """
    result: dict[tuple[str, str], tuple[int, dict[str, Any]]] = {}
    task_ids = _ids(wanted.get(ChangeEntityType.TASK, ()))
    if task_ids:
        tasks = list(
            await session.scalars(
                select(Task).where(Task.user_id == user_id, Task.id.in_(task_ids))
            )
        )
        tag_rows = await session.execute(
            select(TaskTag.task_id, Tag.name)
            .join(Tag, Tag.id == TaskTag.tag_id)
            .where(TaskTag.task_id.in_([t.id for t in tasks]), Tag.user_id == user_id)
        )
        tags: dict[uuid.UUID, list[str]] = {}
        for task_id, name in tag_rows:
            tags.setdefault(task_id, []).append(name)
        for task in tasks:
            data = _row(task, _TASK_COLUMNS)
            data["tags"] = sorted(tags.get(task.id, []), key=str.casefold)
            data["field_revisions"] = dict(task.field_revisions)
            result[(ChangeEntityType.TASK, str(task.id))] = (task.revision, data)
    project_ids = _ids(wanted.get(ChangeEntityType.PROJECT, ()))
    if project_ids:
        for project in await session.scalars(
            select(Project).where(Project.user_id == user_id, Project.id.in_(project_ids))
        ):
            data = _row(project, _PROJECT_COLUMNS)
            data["field_revisions"] = dict(project.field_revisions)
            result[(ChangeEntityType.PROJECT, str(project.id))] = (project.revision, data)
    note_ids = _ids(wanted.get(ChangeEntityType.NOTE, ()))
    if note_ids:
        for note in await session.scalars(
            select(NoteIndex).where(NoteIndex.user_id == user_id, NoteIndex.id.in_(note_ids))
        ):
            result[(ChangeEntityType.NOTE, str(note.id))] = (
                note.revision,
                _row(note, _NOTE_COLUMNS),
            )
    reminder_ids = _ids(wanted.get(ChangeEntityType.REMINDER, ()))
    if reminder_ids:
        rows = await session.execute(
            select(Reminder, ReminderDelivery.delivered_at)
            .outerjoin(ReminderDelivery, ReminderDelivery.reminder_id == Reminder.id)
            .where(Reminder.user_id == user_id, Reminder.id.in_(reminder_ids))
        )
        for reminder, delivered_at in rows:
            result[(ChangeEntityType.REMINDER, str(reminder.id))] = (
                reminder.revision,
                reminder_data(reminder, delivered_at),
            )
    resolution_ids = _ids(wanted.get(ChangeEntityType.RESOLUTION, ()))
    if resolution_ids:
        from ..sync.resolution_log import load_resolution_data

        for resolution_id, found in (
            await load_resolution_data(session, user_id, resolution_ids)
        ).items():
            result[(ChangeEntityType.RESOLUTION, str(resolution_id))] = found
    return result
