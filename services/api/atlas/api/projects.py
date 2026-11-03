"""Projects API: CRUD with idempotent mutations.

Mutations may carry an ``Idempotency-Key`` header (see :mod:`atlas.idempotency`); a retry with the
same key and payload returns the original response instead of applying the change again.

Deletion is a soft delete (tombstone): the project disappears from the API but the row is retained
so the removal can propagate to clients. Updates are revision-aware — a ``base_revision`` that no
longer matches the stored revision is rejected with ``409`` and changes nothing. Every endpoint is
strictly user-scoped (ADR-0020).

``GET /api/projects/{id}/tasks`` (M4-02) lists the tasks filed under one of the caller's projects,
reusing the task listing and its ordering (and, like every other endpoint here, reporting another
user's project as missing). The same set is reachable through the ``project_id`` filter on
``GET /api/tasks``; this endpoint adds the project-existence check.

``GET /api/projects/{id}/notes`` (M4-05) lists the notes linked to a project, and
``PUT``/``DELETE /api/projects/{id}/notes/{note_id}`` link/unlink them. The link references the
note's stable id, so it survives a rename; both directions are idempotent and strictly user-scoped
(ADR-0024). The note-side listing lives in :mod:`atlas.api.notes`.

``GET /api/projects/export`` and ``GET /api/projects/{id}/export`` (M4-07) export projects together
with their tasks and linked notes as one versioned, open JSON document (REQ-015). Both are
read-only, strictly user-scoped and read the whole document as a single consistent snapshot; the
document contract lives in :mod:`atlas.projects.export` (ADR-0026).
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from typing import Annotated, Any, NoReturn

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request, Response, status
from fastapi.responses import JSONResponse

from ..idempotency import IdempotencyConflictError, IdempotencyStore, fingerprint
from ..notes import NoteNotFoundError
from ..projects import (
    DEFAULT_LIMIT,
    MAX_LIMIT,
    ZERO_PROGRESS,
    NoteProjectLinks,
    ProjectEditWinsError,
    ProjectIdExistsError,
    ProjectNotFoundError,
    ProjectProgress,
    ProjectRevisionConflictError,
    ProjectsService,
    ProjectValidationError,
    build_document,
)
from ..sync.protocol import SyncError
from ..tasks import (
    DEFAULT_LIMIT as TASKS_DEFAULT_LIMIT,
)
from ..tasks import (
    MAX_LIMIT as TASKS_MAX_LIMIT,
)
from ..tasks import (
    TaskFilters,
    TasksService,
)
from .deps import DbSession, SyncUser
from .schemas import (
    NoteSummaryOut,
    ProjectCreateRequest,
    ProjectListOut,
    ProjectNotesOut,
    ProjectOut,
    ProjectProgressOut,
    ProjectsExportOut,
    ProjectUpdateRequest,
    SyncResolutionOut,
    TaskListOut,
)
from .sync_gate import SyncMode, epoch_check
from .syncio import (
    REPLAYED_HEADER,
    entity_json,
    log_resolutions,
    reject_unknown_fields,
    require_base,
    require_key,
    sync_result,
)
from .tasks import task_out

router = APIRouter(prefix="/api/projects", tags=["projects"], dependencies=[Depends(epoch_check)])

IdempotencyKey = Annotated[str | None, Header(alias="Idempotency-Key", max_length=200)]


def _translate(exc: Exception, sync: bool = False) -> NoReturn:
    """Map domain errors onto HTTP responses; re-raise anything unexpected (see tasks API)."""
    if isinstance(exc, ProjectIdExistsError):
        raise SyncError(
            409, "id_exists", "that id is already in use by a different record"
        ) from exc
    if isinstance(exc, (ProjectNotFoundError, NoteNotFoundError)):
        if sync:
            raise SyncError(404, "not_found", "Not found") from exc
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found") from exc
    if isinstance(exc, ProjectRevisionConflictError):
        if sync:
            raise SyncError(
                409,
                "stale",
                "project changed since it was read",
                current_revision=exc.current_revision,
            ) from exc
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "message": "project changed since it was read",
                "current_revision": exc.current_revision,
            },
        ) from exc
    if isinstance(exc, IdempotencyConflictError):
        if sync:
            raise SyncError(
                409, "idempotency_mismatch", "idempotency key reused with a different request"
            ) from exc
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="idempotency key reused with a different request",
        ) from exc
    if isinstance(exc, ProjectValidationError):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    raise exc


def project_out(project: Any, progress: ProjectProgress | None = None) -> ProjectOut:
    """Serialise a project, attaching its derived progress (M4-04).

    Progress is derived, not stored: ``progress`` is supplied by the caller from
    :meth:`ProjectsService.progress` (one grouped query for a whole list). When a caller omits it,
    the zero value is used — the correct result for a project with no countable tasks.
    """
    value = progress if progress is not None else ZERO_PROGRESS
    return ProjectOut(
        id=project.id,
        name=project.name,
        description=project.description,
        status=project.status,
        start_date=project.start_date,
        target_date=project.target_date,
        progress=ProjectProgressOut(
            total=value.total, completed=value.completed, percent=value.percent
        ),
        revision=project.revision,
        field_revisions=project.field_revisions,
        created_at=project.created_at,
        updated_at=project.updated_at,
    )


async def _progress_for(service: ProjectsService, project_id: uuid.UUID) -> ProjectProgress:
    """The derived progress of a single project (one grouped query)."""
    return (await service.progress([project_id])).get(project_id, ZERO_PROGRESS)


def note_summary(note: Any) -> NoteSummaryOut:
    """Serialise a linked note with the standard notes summary shape (M4-05)."""
    return NoteSummaryOut(
        id=note.id,
        path=note.path,
        title=note.title,
        revision=note.revision,
        content_hash=note.content_hash,
        size_bytes=note.size_bytes,
    )


@router.post("", response_model=ProjectOut, status_code=status.HTTP_201_CREATED)
async def create_project(
    payload: ProjectCreateRequest,
    request: Request,
    response: Response,
    user: SyncUser,
    session: DbSession,
    sync: SyncMode,
    idempotency_key: IdempotencyKey = None,
) -> Any:
    """Create a project; sync mode requires an `Idempotency-Key`; an optional client `id` makes
    the create idempotent by id (SYNC_PROTOCOL.md 6.1)."""
    if sync:
        require_key(sync, idempotency_key)
        await reject_unknown_fields(request, ProjectCreateRequest)
    store = IdempotencyStore(session, user.id)
    if idempotency_key:
        try:
            stored = await store.reserve(
                idempotency_key, "project.create", fingerprint(payload.model_dump(mode="json"))
            )
        except Exception as exc:
            _translate(exc, sync)
        if stored is not None:
            return JSONResponse(
                status_code=stored.status_code, content=stored.body, headers=REPLAYED_HEADER
            )
    data = payload.model_dump()
    client_id = data.pop("id")
    replayed = False
    try:
        service = ProjectsService(session, user.id)
        project = await service.claim_id(client_id, data) if client_id else None
        replayed = project is not None
        if project is None:
            project = await service.create(data, client_id=client_id)
    except Exception as exc:
        _translate(exc, sync)
    out = project_out(project, await _progress_for(service, project.id))
    if sync:
        out.sync = sync_result(project.revision)
    if idempotency_key:
        await store.remember(idempotency_key, status_code=201, body=out.model_dump(mode="json"))
    await session.commit()
    if replayed:
        response.headers.update(REPLAYED_HEADER)
    return out


@router.get("", response_model=ProjectListOut)
async def list_projects(
    user: SyncUser,
    session: DbSession,
    limit: Annotated[
        int | None,
        Query(
            ge=1,
            le=MAX_LIMIT,
            description=f"Maximum number of projects to return (default {DEFAULT_LIMIT}).",
        ),
    ] = None,
) -> ProjectListOut:
    """List the caller's live projects in capture order.

    Soft-deleted projects are omitted. ``limit`` bounds the number of returned rows. Each project
    carries its derived ``progress`` (M4-04), computed for the whole page in one grouped count
    rather than a query per project.
    """
    page_size = DEFAULT_LIMIT if limit is None else limit
    service = ProjectsService(session, user.id)
    projects = await service.list(limit=page_size)
    progress = await service.progress([project.id for project in projects])
    return ProjectListOut(
        projects=[
            project_out(project, progress.get(project.id, ZERO_PROGRESS)) for project in projects
        ]
    )


@router.get("/export", response_model=ProjectsExportOut)
async def export_projects(
    user: SyncUser,
    session: DbSession,
    limit: Annotated[
        int | None,
        Query(
            ge=1,
            le=MAX_LIMIT,
            description=(
                f"Maximum number of projects to export (default {DEFAULT_LIMIT}). When more "
                "projects exist, the document's `truncated` flag is true."
            ),
        ),
    ] = None,
) -> Any:
    """Export the caller's projects, their tasks and linked notes (M4-07, REQ-015).

    Returns a single, versioned, open JSON document (``format: atlas.project-export``,
    ``version: 1``; the contract is documented in ``DECISIONS.md`` ADR-0026). Every project carries
    its derived ``progress`` and every live task of the project with its documented fields (stable
    ids, ISO-8601 UTC instants), plus the notes linked to the project (M4-05). Only live rows are
    exported; soft-deleted projects, tasks and notes are excluded.

    The whole document is read as **one consistent snapshot** (a single REPEATABLE READ
    transaction), so a concurrent write cannot tear it. The number of projects is bounded by
    ``limit`` (1…500, default 200); ``truncated`` reports whether further projects were omitted.
    The endpoint is read-only and strictly user-scoped: it never returns another user's data.
    """
    page_size = DEFAULT_LIMIT if limit is None else limit
    # Read the caller's id before the service opens its snapshot transaction (which ends the
    # request's read-only transaction; see ProjectsService.begin_consistent_read).
    service = ProjectsService(session, user.id)
    entries, truncated = await service.export(limit=page_size)
    document = build_document(entries, generated_at=datetime.now(UTC), truncated=truncated)
    return JSONResponse(status_code=status.HTTP_200_OK, content=document)


@router.get("/{project_id}/export", response_model=ProjectsExportOut)
async def export_project(project_id: uuid.UUID, user: SyncUser, session: DbSession) -> Any:
    """Export a single project, its tasks and linked notes (M4-07, REQ-015).

    Returns the same versioned document as ``GET /api/projects/export`` with exactly one entry in
    ``projects`` (``truncated`` is always ``false``). An unknown project, another user's project or
    a deleted (tombstoned) project is reported as ``404 Not found``. Read as one consistent
    snapshot; read-only and strictly user-scoped.
    """
    service = ProjectsService(session, user.id)
    try:
        entries, truncated = await service.export(project_id=project_id)
    except Exception as exc:
        _translate(exc)
    document = build_document(entries, generated_at=datetime.now(UTC), truncated=truncated)
    return JSONResponse(status_code=status.HTTP_200_OK, content=document)


@router.get("/{project_id}", response_model=ProjectOut)
async def get_project(project_id: uuid.UUID, user: SyncUser, session: DbSession) -> ProjectOut:
    service = ProjectsService(session, user.id)
    try:
        project = await service.get(project_id)
    except Exception as exc:
        _translate(exc)
    return project_out(project, await _progress_for(service, project.id))


@router.get("/{project_id}/tasks", response_model=TaskListOut)
async def list_project_tasks(
    project_id: uuid.UUID,
    user: SyncUser,
    session: DbSession,
    limit: Annotated[
        int | None,
        Query(
            ge=1,
            le=TASKS_MAX_LIMIT,
            description=f"Maximum number of tasks to return (default {TASKS_DEFAULT_LIMIT}).",
        ),
    ] = None,
) -> TaskListOut:
    """List the caller's tasks filed under one project (M4-02).

    Membership is optional — a task belongs to at most one project and may belong to none — so
    this returns exactly the live tasks whose ``project_id`` is the given project, plus each task's
    derived subtask counts and ``due_state``. It is the same set (and the same most-urgent-first
    ordering) as ``GET /api/tasks?project_id={project_id}``; the difference is that this endpoint
    *checks the project exists*: an unknown project, another user's project or a deleted
    (tombstoned) project is reported as ``404 Not found`` rather than as an empty list.
    Soft-deleted tasks are omitted, as in every task listing. ``limit`` (1…500, default 200)
    bounds the result. The endpoint is read-only and strictly user-scoped.
    """
    try:
        project = await ProjectsService(session, user.id).get(project_id)
    except Exception as exc:
        _translate(exc)
    service = TasksService(session, user.id)
    tasks = await service.list(
        filters=TaskFilters(project_id=project.id),
        limit=TASKS_DEFAULT_LIMIT if limit is None else limit,
    )
    now = datetime.now(UTC)
    rollups = await service.subtask_rollups([task.id for task in tasks])
    tag_names = await service.tags_for([task.id for task in tasks])
    return TaskListOut(
        tasks=[
            task_out(task, rollups.get(task.id), now=now, tags=tag_names.get(task.id, []))
            for task in tasks
        ]
    )


@router.get("/{project_id}/notes", response_model=ProjectNotesOut)
async def list_project_notes(
    project_id: uuid.UUID, user: SyncUser, session: DbSession
) -> ProjectNotesOut:
    """List the caller's notes linked to one project (M4-05).

    The association references the note's **stable id**, not its path, so a note that has been
    renamed still appears (with its new path). Only live notes are returned, in path order. The
    project must exist and be the caller's: an unknown, another user's or deleted (tombstoned)
    project is reported as ``404 Not found`` rather than as an empty list.
    """
    links = NoteProjectLinks(session, user.id)
    try:
        notes = await links.notes(project_id)
    except Exception as exc:
        _translate(exc)
    return ProjectNotesOut(notes=[note_summary(note) for note in notes])


@router.put("/{project_id}/notes/{note_id}", status_code=status.HTTP_204_NO_CONTENT)
async def link_project_note(
    project_id: uuid.UUID, note_id: uuid.UUID, user: SyncUser, session: DbSession
) -> Response:
    """Link a note to a project (**idempotent**).

    Linking a note to a project it is already linked to is a no-op (both return ``204``). The
    project *and* the note must be the caller's and live: an unknown, another user's or deleted
    target is reported as ``404 Not found`` before anything is written, so a rejected link has no
    side effects. A note may be linked to any number of projects.
    """
    try:
        await NoteProjectLinks(session, user.id).link(project_id, note_id)
    except Exception as exc:
        _translate(exc)
    await session.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.delete("/{project_id}/notes/{note_id}", status_code=status.HTTP_204_NO_CONTENT)
async def unlink_project_note(
    project_id: uuid.UUID, note_id: uuid.UUID, user: SyncUser, session: DbSession
) -> Response:
    """Remove a note↔project link (**idempotent**).

    Deleting a link that does not exist is a no-op (both return ``204``). The project and the note
    must be the caller's and live; an unknown, another user's or deleted target is reported as
    ``404 Not found``.
    """
    try:
        await NoteProjectLinks(session, user.id).unlink(project_id, note_id)
    except Exception as exc:
        _translate(exc)
    await session.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.patch("/{project_id}", response_model=ProjectOut)
async def update_project(
    project_id: uuid.UUID,
    payload: ProjectUpdateRequest,
    request: Request,
    user: SyncUser,
    session: DbSession,
    sync: SyncMode,
    idempotency_key: IdempotencyKey = None,
) -> Any:
    """Update a project, optionally guarded by ``base_revision``.

    A stale ``base_revision`` — the project has a newer revision — returns ``409`` and changes
    nothing. Fields not present in the request are left untouched. **Sync mode**
    (`Atlas-Sync: 1`): `Idempotency-Key` and `base_revision` are required and fields merge as for
    tasks (`name` and `description` are the text fields); an edit of a deleted project revives it.
    """
    if sync:
        require_key(sync, idempotency_key)
        require_base(sync, payload.base_revision)
        await reject_unknown_fields(request, ProjectUpdateRequest)
    store = IdempotencyStore(session, user.id)
    changes = payload.model_dump(exclude_unset=True)
    request_payload = {
        "project_id": str(project_id),
        **payload.model_dump(exclude_unset=True, mode="json"),
    }
    if idempotency_key:
        try:
            stored = await store.reserve(
                idempotency_key, "project.update", fingerprint(request_payload)
            )
        except Exception as exc:
            _translate(exc, sync)
        if stored is not None:
            return JSONResponse(
                status_code=stored.status_code, content=stored.body, headers=REPLAYED_HEADER
            )
    service = ProjectsService(session, user.id)
    outcome = None
    try:
        if sync:
            assert payload.base_revision is not None
            outcome = await service.update_sync(project_id, changes, payload.base_revision)
            project = outcome.project
        else:
            project = await service.update(project_id, changes, payload.base_revision)
    except Exception as exc:
        _translate(exc, sync)
    if outcome is not None and outcome.conflicts and not outcome.applied and not outcome.revived:
        raise SyncError(
            409,
            "conflict",
            "the same text field was changed on the server; nothing was applied",
            current_revision=project.revision,
            conflicts=[
                c.model_dump(mode="json")
                for c in sync_result(0, conflicts=outcome.conflicts).conflicts
            ],
        )
    out = project_out(project, await _progress_for(service, project.id))
    if outcome is not None:
        out.sync = sync_result(
            project.revision,
            conflicts=outcome.conflicts,
            # only a field the write really changed was decided by a rule (and is logged)
            resolutions=[r for r in outcome.resolutions if r.field in outcome.applied],
            revived=outcome.revived,
        )
        await log_resolutions(
            session,
            user.id,
            "project",
            project.id,
            out.sync.resolution,
            op_key=idempotency_key,
            revision=project.revision,
        )
    if idempotency_key:
        await store.remember(idempotency_key, status_code=200, body=out.model_dump(mode="json"))
    await session.commit()
    return out


@router.delete("/{project_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_project(
    project_id: uuid.UUID,
    user: SyncUser,
    session: DbSession,
    sync: SyncMode,
    idempotency_key: IdempotencyKey = None,
    base_revision: Annotated[
        int | None,
        Query(
            ge=0,
            description=(
                "Sync mode (required): the revision the delete was based on. A project edited "
                "after it is not deleted: `409 edit_wins` carries the live project."
            ),
        ),
    ] = None,
) -> Response:
    """Soft delete (tombstone) a project."""
    if sync:
        require_key(sync, idempotency_key)
        require_base(sync, base_revision)
    store = IdempotencyStore(session, user.id)
    if idempotency_key:
        try:
            stored = await store.reserve(
                idempotency_key, "project.delete", fingerprint({"project_id": str(project_id)})
            )
        except Exception as exc:
            _translate(exc, sync)
        if stored is not None:
            return Response(status_code=stored.status_code, headers=REPLAYED_HEADER)
    service = ProjectsService(session, user.id)
    try:
        if sync and await service.is_deleted(project_id):
            pass  # already deleted: an idempotent no-op
        else:
            await service.delete(project_id, base_revision=base_revision, edit_wins=sync)
    except ProjectEditWinsError as exc:
        live = await service.get(project_id)
        raise SyncError(
            409,
            "edit_wins",
            "the project was edited after the delete was based; the edit wins and it stays",
            current_revision=exc.current_revision,
            entity=entity_json(project_out(live, await _progress_for(service, live.id))),
            resolution=[SyncResolutionOut(rule="edit_wins_over_delete").model_dump(mode="json")],
        ) from exc
    except Exception as exc:
        _translate(exc, sync)
    if idempotency_key:
        await store.remember(idempotency_key, status_code=204, body={})
    await session.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)
