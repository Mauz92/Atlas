"""Unified search API (MU-05, ADR-0047): one read-only endpoint over notes, tasks and projects."""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Query

from ..search import MAX_QUERY_LENGTH, SearchService
from .deps import CurrentUser, DbSession
from .schemas import SearchNoteOut, SearchOut, SearchProjectOut, SearchTaskOut

router = APIRouter(prefix="/api/search", tags=["search"])

DEFAULT_LIMIT = 10
MAX_LIMIT = 50


@router.get("", response_model=SearchOut)
async def search(
    user: CurrentUser,
    session: DbSession,
    q: Annotated[str, Query(min_length=1, max_length=MAX_QUERY_LENGTH)],
    limit: Annotated[int, Query(ge=1, le=MAX_LIMIT)] = DEFAULT_LIMIT,
) -> SearchOut:
    """Notes, tasks and projects whose words start with every word of ``q``.

    ``limit`` bounds **each** group. Text without any word character returns empty groups.
    """
    results = await SearchService(session, user.id).search(q, limit=limit)
    return SearchOut(
        query=q,
        notes=[SearchNoteOut(id=h.id, path=h.path, title=h.title) for h in results.notes],
        tasks=[
            SearchTaskOut(
                id=h.id,
                title=h.title,
                status=h.status,
                priority=h.priority,
                due_at=h.due_at,
                project_id=h.project_id,
            )
            for h in results.tasks
        ],
        projects=[
            SearchProjectOut(id=h.id, name=h.name, status=h.status) for h in results.projects
        ],
    )
