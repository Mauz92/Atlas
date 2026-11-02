"""One bounded, user-scoped, indexed search over notes, tasks and projects.

Matching is **word-prefix, all words** (``mil`` finds "Buy milk"; ``buy mi`` too), the behaviour a
quick switcher needs. The user's text is never sent to PostgreSQL as tsquery syntax: it is reduced
to ``\\w`` words (so no operator, quote or parenthesis can survive), each becomes ``word:*`` and
the result is bound as a parameter of ``to_tsquery``. Every statement filters on ``user_id`` and
``deleted_at IS NULL`` and carries a ``LIMIT``.

* notes: the existing ``notes.search_vector`` (title + content, ``english``) and its GIN index;
* tasks / projects: the ``simple``-configuration expression indexes from migration
  ``a8c4d9e2b7f1`` (title/name + description). The expressions come from the model constants so a
  query can never drift from its index.

Note contents are matched but never returned: a result carries the id, path and title only.
"""

from __future__ import annotations

import re
import uuid
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

from sqlalchemy import func, literal_column, select

from ..models import NoteIndex, Project, ProjectStatus, Task, TaskStatus
from ..models.project import PROJECT_SEARCH_VECTOR
from ..models.task import TASK_SEARCH_VECTOR

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession
    from sqlalchemy.sql import ColumnElement, Select

#: Longest accepted search text.
MAX_QUERY_LENGTH = 200
#: Words beyond this are ignored (bounds the tsquery size).
MAX_TERMS = 8
#: A single word is cut to this length.
MAX_TERM_LENGTH = 64

_WORD = re.compile(r"\w+", re.UNICODE)
_CLOSED_TASKS = (TaskStatus.COMPLETED.value, TaskStatus.ARCHIVED.value)
_CLOSED_PROJECTS = (ProjectStatus.COMPLETED.value, ProjectStatus.ARCHIVED.value)


def prefix_tsquery(text: str) -> str | None:
    """Turn user text into ``a:* & b:*`` for ``to_tsquery``, or ``None`` when it has no words."""
    words = [word[:MAX_TERM_LENGTH] for word in _WORD.findall(text)[:MAX_TERMS]]
    if not words:
        return None
    return " & ".join(f"{word}:*" for word in words)


@dataclass(frozen=True)
class NoteHit:
    id: uuid.UUID
    path: str
    title: str


@dataclass(frozen=True)
class TaskHit:
    id: uuid.UUID
    title: str
    status: str
    priority: str
    due_at: Any
    project_id: uuid.UUID | None


@dataclass(frozen=True)
class ProjectHit:
    id: uuid.UUID
    name: str
    status: str


@dataclass(frozen=True)
class SearchResults:
    notes: list[NoteHit]
    tasks: list[TaskHit]
    projects: list[ProjectHit]


EMPTY = SearchResults(notes=[], tasks=[], projects=[])


class SearchService:
    def __init__(self, session: AsyncSession, user_id: uuid.UUID) -> None:
        self.session = session
        self.user_id = user_id

    def note_statement(self, tsquery: str, limit: int) -> Select[Any]:
        query = func.to_tsquery("english", tsquery)
        return (
            select(NoteIndex.id, NoteIndex.path, NoteIndex.title)
            .where(
                NoteIndex.user_id == self.user_id,
                NoteIndex.deleted_at.is_(None),
                NoteIndex.search_vector.op("@@")(query),
            )
            .order_by(func.ts_rank(NoteIndex.search_vector, query).desc(), NoteIndex.path)
            .limit(limit)
        )

    def task_statement(self, tsquery: str, limit: int) -> Select[Any]:
        vector: ColumnElement[Any] = literal_column(TASK_SEARCH_VECTOR)
        query = func.to_tsquery("simple", tsquery)
        return (
            select(Task.id, Task.title, Task.status, Task.priority, Task.due_at, Task.project_id)
            .where(
                Task.user_id == self.user_id,
                Task.deleted_at.is_(None),
                vector.op("@@")(query),
            )
            .order_by(
                Task.status.in_(_CLOSED_TASKS).asc(),
                func.ts_rank(vector, query).desc(),
                Task.updated_at.desc(),
                Task.id,
            )
            .limit(limit)
        )

    def project_statement(self, tsquery: str, limit: int) -> Select[Any]:
        vector: ColumnElement[Any] = literal_column(PROJECT_SEARCH_VECTOR)
        query = func.to_tsquery("simple", tsquery)
        return (
            select(Project.id, Project.name, Project.status)
            .where(
                Project.user_id == self.user_id,
                Project.deleted_at.is_(None),
                vector.op("@@")(query),
            )
            .order_by(
                Project.status.in_(_CLOSED_PROJECTS).asc(),
                func.ts_rank(vector, query).desc(),
                Project.updated_at.desc(),
                Project.id,
            )
            .limit(limit)
        )

    async def search(self, text: str, *, limit: int) -> SearchResults:
        """Up to ``limit`` hits of each kind; text without any word matches nothing."""
        tsquery = prefix_tsquery(text)
        if tsquery is None:
            return EMPTY
        notes = (await self.session.execute(self.note_statement(tsquery, limit))).all()
        tasks = (await self.session.execute(self.task_statement(tsquery, limit))).all()
        projects = (await self.session.execute(self.project_statement(tsquery, limit))).all()
        return SearchResults(
            notes=[NoteHit(*row) for row in notes],
            tasks=[TaskHit(*row) for row in tasks],
            projects=[ProjectHit(*row) for row in projects],
        )
