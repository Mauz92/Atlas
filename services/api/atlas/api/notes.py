"""Notes API: revision-aware CRUD, folders, search, links and reconciliation."""

from __future__ import annotations

import uuid
from dataclasses import asdict
from datetime import UTC, datetime
from typing import Annotated, Any, NoReturn

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request, Response, status
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from ..config import get_settings
from ..idempotency import IdempotencyConflictError, IdempotencyStore, fingerprint
from ..models import NoteIndex
from ..notes import (
    NoteConflictError,
    NoteIdExistsError,
    NoteNotFoundError,
    NotePathConflictError,
    NotesReconciler,
    NotesService,
    NotesStorage,
    NoteTooLargeError,
    TemplateError,
    UnsafePathError,
)
from ..projects import (
    ZERO_PROGRESS,
    NoteProjectLinks,
    ProjectNotFoundError,
    ProjectsService,
)
from ..reminders import ReminderService
from ..sync.protocol import SyncError
from ..tasks import TasksService, TaskValidationError
from ..tasks.note_links import TaskNoteLinks
from .deps import CurrentUser, DbSession
from .projects import project_out
from .schemas import (
    DailyNoteRequest,
    FolderCreateRequest,
    FolderRenameRequest,
    NoteConflictCopyRequest,
    NoteCreateRequest,
    NoteDetailOut,
    NoteFromTemplateRequest,
    NoteLinkOut,
    NoteListOut,
    NoteMoveRequest,
    NoteProjectOut,
    NoteSummaryOut,
    NoteTaskOut,
    NoteUpdateRequest,
    ProjectListOut,
    ReconcileOut,
    SyncResolutionOut,
    SyncResult,
    TaskCreateRequest,
    TaskOut,
)
from .sync_gate import SyncMode, epoch_check
from .syncio import REPLAYED_HEADER, reject_unknown_fields, require_base, require_key
from .tasks import task_out

router = APIRouter(prefix="/api/notes", tags=["notes"], dependencies=[Depends(epoch_check)])
folders_router = APIRouter(prefix="/api/folders", tags=["notes"])


def get_storage() -> NotesStorage:
    return NotesStorage(get_settings().notes_root)


StorageDep = Annotated[NotesStorage, Depends(get_storage)]


def _translate(exc: Exception, sync: bool = False) -> NoReturn:
    """Map domain errors onto HTTP responses; re-raise anything unexpected."""
    if isinstance(exc, NoteIdExistsError):
        raise SyncError(
            409, "id_exists", "that id is already in use by a different record"
        ) from exc
    if isinstance(exc, NoteConflictError):
        if sync:
            raise SyncError(
                409,
                "stale",
                "note changed since it was read",
                current_revision=exc.current_revision,
                current_hash=exc.current_hash,
            ) from exc
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "message": "note changed since it was read",
                "current_revision": exc.current_revision,
            },
        ) from exc
    if isinstance(exc, (NoteNotFoundError, FileNotFoundError, ProjectNotFoundError)):
        if sync:
            raise SyncError(404, "not_found", "Not found") from exc
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found") from exc
    if isinstance(exc, (NotePathConflictError, FileExistsError)):
        if sync:
            raise SyncError(409, "path_exists", "A note or folder already exists there") from exc
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT, detail="A note or folder already exists there"
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
    if isinstance(exc, TaskValidationError):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    if isinstance(exc, (UnsafePathError, TemplateError)):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    if isinstance(exc, NoteTooLargeError):
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, detail=str(exc)
        ) from exc
    if isinstance(exc, OSError):
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc
    raise exc


async def _begin_sync_write(
    sync: bool,
    request: Request,
    model: type[BaseModel] | None,
    store: IdempotencyStore,
    key: str | None,
    operation: str,
    request_payload: dict[str, Any],
) -> JSONResponse | None:
    """Sync-mode preamble shared by the note writes: key required, unknown fields refused, the
    key reserved. Returns the stored response of a replay (a summary: note bodies are not stored,
    they can be 5 MiB), else ``None``. Outside sync mode notes keep their historical behaviour:
    no key support at all."""
    if not sync:
        return None
    require_key(sync, key)
    if model is not None:
        await reject_unknown_fields(request, model)
    assert key is not None
    try:
        stored = await store.reserve(key, operation, fingerprint(request_payload))
    except Exception as exc:
        _translate(exc, sync)
    if stored is None:
        return None
    return JSONResponse(
        status_code=stored.status_code, content=stored.body, headers=REPLAYED_HEADER
    )


def _stored_summary(note: NoteIndex, result: SyncResult) -> dict[str, Any]:
    """What a note write stores for replay: the summary and the sync block, never the content."""
    return {**_summary(note).model_dump(mode="json"), "sync": result.model_dump(mode="json")}


def _summary(note: NoteIndex) -> NoteSummaryOut:
    return NoteSummaryOut(
        id=note.id,
        path=note.path,
        title=note.title,
        revision=note.revision,
        content_hash=note.content_hash,
        size_bytes=note.size_bytes,
    )


async def _detail(service: NotesService, note: NoteIndex) -> NoteDetailOut:
    file = service.storage.read(note.path)
    links = await service.outgoing_links(note.id)
    backlinks = await service.backlinks(note.id)
    related = TaskNoteLinks(service.session, service.user_id)
    return NoteDetailOut(
        **_summary(note).model_dump(),
        content=file.content,
        tags=await service.note_tags(note.id),
        links=[
            NoteLinkOut(target_path=target, target_note_id=resolved) for target, resolved in links
        ],
        backlinks=[NoteSummaryOut(**asdict(item)) for item in backlinks],
        unresolved_links=[target for target, resolved in links if resolved is None],
        tasks=[NoteTaskOut.model_validate(task) for task in await related.tasks_for_note(note.id)],
        projects=[
            NoteProjectOut.model_validate(project)
            for project in await related.projects_for_note(note.id)
        ],
    )


@router.get("", response_model=NoteListOut)
async def list_notes(
    user: CurrentUser,
    session: DbSession,
    storage: StorageDep,
    folder: Annotated[str | None, Query(max_length=1024)] = None,
) -> NoteListOut:
    service = NotesService(session, user.id, storage)
    try:
        notes = await service.list_notes(folder)
        folders = await service.list_folders()
    except Exception as exc:
        _translate(exc)
    return NoteListOut(
        notes=[NoteSummaryOut(**asdict(note)) for note in notes],
        folders=folders,
    )


@router.get("/search", response_model=list[NoteSummaryOut])
async def search_notes(
    user: CurrentUser,
    session: DbSession,
    storage: StorageDep,
    q: Annotated[str, Query(min_length=1, max_length=256)],
    limit: Annotated[int, Query(ge=1, le=100)] = 25,
) -> list[NoteSummaryOut]:
    service = NotesService(session, user.id, storage)
    results = await service.search(q, limit=limit)
    return [NoteSummaryOut(**asdict(note)) for note in results]


@router.post("/reconcile", response_model=ReconcileOut)
async def reconcile(user: CurrentUser, session: DbSession, storage: StorageDep) -> ReconcileOut:
    summary = await NotesReconciler(session, user.id, storage).run()
    await session.commit()
    return ReconcileOut(
        added=summary.added,
        updated=summary.updated,
        removed=summary.removed,
        unchanged=summary.unchanged,
    )


@router.post("", response_model=NoteDetailOut, status_code=status.HTTP_201_CREATED)
async def create_note(
    payload: NoteCreateRequest,
    request: Request,
    response: Response,
    user: CurrentUser,
    session: DbSession,
    storage: StorageDep,
    sync: SyncMode,
    idempotency_key: Annotated[str | None, Header(alias="Idempotency-Key", max_length=200)] = None,
) -> Any:
    """Create a note.

    An optional client-generated `id` makes the create idempotent by id. **Sync mode**
    (`Atlas-Sync: 1`) requires an `Idempotency-Key`; a path already taken by a live note becomes
    `name (2).md` and the response reports `sync.resolution` `path_collision` with the final path
    (a replay of a note write returns the note summary and `sync` block, not the content).
    """
    store = IdempotencyStore(session, user.id)
    body = payload.model_dump(mode="json")
    replay = await _begin_sync_write(
        sync, request, NoteCreateRequest, store, idempotency_key, "note.create", body
    )
    if replay is not None:
        return replay
    service = NotesService(session, user.id, storage)
    replayed = False
    try:
        note = (
            await service.claim_id(payload.id, payload.path, payload.content)
            if payload.id
            else None
        )
        replayed = note is not None
        requested: str | None = None
        if note is None:
            created = await service.create_with_info(
                payload.path, payload.content, client_id=payload.id, on_collision_rename=sync
            )
            note, requested = created.note, created.requested_path
        detail = await _detail(service, note)
    except Exception as exc:
        _translate(exc, sync)
    if sync:
        result = SyncResult(revision=note.revision)
        if requested is not None:
            result.resolution.append(
                SyncResolutionOut(
                    rule="path_collision", detail=f"{requested} was taken; created {note.path}"
                )
            )
        detail.sync = result
        assert idempotency_key is not None
        await store.remember(idempotency_key, status_code=201, body=_stored_summary(note, result))
    await session.commit()
    if replayed:
        response.headers.update(REPLAYED_HEADER)
    return detail


@router.post("/daily", response_model=NoteDetailOut)
async def open_daily_note(
    payload: DailyNoteRequest,
    response: Response,
    user: CurrentUser,
    session: DbSession,
    storage: StorageDep,
) -> NoteDetailOut:
    """Open ``daily/<date>.md``, creating it if missing (MU-07, ADR-0049).

    ``date`` is the caller's calendar day. Idempotent: ``201`` when this call created the file,
    ``200`` with the untouched note when it already existed (also under concurrent calls).
    """
    service = NotesService(session, user.id, storage)
    try:
        note, created = await service.open_daily(payload.date)
        detail = await _detail(service, note)
    except Exception as exc:
        _translate(exc)
    await session.commit()
    response.status_code = status.HTTP_201_CREATED if created else status.HTTP_200_OK
    return detail


@router.post("/from-template", response_model=NoteDetailOut, status_code=status.HTTP_201_CREATED)
async def create_note_from_template(
    payload: NoteFromTemplateRequest, user: CurrentUser, session: DbSession, storage: StorageDep
) -> NoteDetailOut:
    """Create a note from a note in ``templates/``, substituting ``{{date}}`` and ``{{title}}``."""
    service = NotesService(session, user.id, storage)
    try:
        note = await service.create_from_template(payload.path, payload.template_id, payload.date)
        detail = await _detail(service, note)
    except Exception as exc:
        _translate(exc)
    await session.commit()
    return detail


@router.get("/{note_id}", response_model=NoteDetailOut)
async def get_note(
    note_id: uuid.UUID, user: CurrentUser, session: DbSession, storage: StorageDep
) -> NoteDetailOut:
    service = NotesService(session, user.id, storage)
    try:
        return await _detail(service, await service.get(note_id))
    except Exception as exc:
        _translate(exc)


@router.get("/{note_id}/projects", response_model=ProjectListOut)
async def list_note_projects(
    note_id: uuid.UUID, user: CurrentUser, session: DbSession
) -> ProjectListOut:
    """List the caller's projects linked to one note (M4-05).

    The association references the note's stable id, so it is unaffected by a rename. Each project
    carries its derived ``progress`` (M4-04). The note must exist and be the caller's: an unknown,
    another user's or deleted note is reported as ``404 Not found``. A note may be linked to any
    number of projects.
    """
    links = NoteProjectLinks(session, user.id)
    try:
        projects = await links.projects(note_id)
    except Exception as exc:
        _translate(exc)
    progress = await ProjectsService(session, user.id).progress(
        [project.id for project in projects]
    )
    return ProjectListOut(
        projects=[
            project_out(project, progress.get(project.id, ZERO_PROGRESS)) for project in projects
        ]
    )


@router.post("/{note_id}/tasks", response_model=TaskOut, status_code=status.HTTP_201_CREATED)
async def create_task_from_note(
    note_id: uuid.UUID,
    payload: TaskCreateRequest,
    user: CurrentUser,
    session: DbSession,
    idempotency_key: Annotated[str | None, Header(alias="Idempotency-Key", max_length=200)] = None,
) -> TaskOut:
    """Create a task from a note and link the two (MU-06): an explicit action, never inferred.

    Takes the same body as ``POST /api/tasks``. The note is validated first (unknown, another
    user's or deleted → ``404``), then the task and its link are written in one transaction. A
    retry with the same ``Idempotency-Key`` returns the original response and creates nothing new.
    The note file is not touched.
    """
    store = IdempotencyStore(session, user.id)
    body = {"note_id": str(note_id), **payload.model_dump(mode="json")}
    if idempotency_key:
        try:
            stored = await store.reserve(
                idempotency_key, "task.create_from_note", fingerprint(body)
            )
        except Exception as exc:
            _translate(exc)
        if stored is not None:
            return JSONResponse(status_code=stored.status_code, content=stored.body)  # type: ignore[return-value]
    try:
        task = await TaskNoteLinks(session, user.id).create_task(note_id, payload.model_dump())
    except Exception as exc:
        _translate(exc)
    await ReminderService(session, user.id).sync_for_task(task.id)
    tasks = TasksService(session, user.id)
    out = task_out(
        task,
        await tasks.subtask_rollup(task.id),
        now=datetime.now(UTC),
        tags=(await tasks.tags_for([task.id])).get(task.id, []),
    )
    if idempotency_key:
        await store.remember(idempotency_key, status_code=201, body=out.model_dump(mode="json"))
    await session.commit()
    return out


@router.put("/{note_id}", response_model=NoteDetailOut)
async def update_note(
    note_id: uuid.UUID,
    payload: NoteUpdateRequest,
    request: Request,
    user: CurrentUser,
    session: DbSession,
    storage: StorageDep,
    sync: SyncMode,
    idempotency_key: Annotated[str | None, Header(alias="Idempotency-Key", max_length=200)] = None,
) -> Any:
    store = IdempotencyStore(session, user.id)
    body = {"note_id": str(note_id), **payload.model_dump(mode="json")}
    replay = await _begin_sync_write(
        sync, request, NoteUpdateRequest, store, idempotency_key, "note.update", body
    )
    if replay is not None:
        return replay
    service = NotesService(session, user.id, storage)
    try:
        note = await service.update(note_id, payload.content, payload.base_revision)
        detail = await _detail(service, note)
    except Exception as exc:
        _translate(exc, sync)
    if sync:
        detail.sync = SyncResult(revision=note.revision)
        assert idempotency_key is not None
        await store.remember(
            idempotency_key, status_code=200, body=_stored_summary(note, detail.sync)
        )
    await session.commit()
    return detail


@router.post(
    "/{note_id}/conflict", response_model=NoteSummaryOut, status_code=status.HTTP_201_CREATED
)
async def create_conflict_copy(
    note_id: uuid.UUID,
    payload: NoteConflictCopyRequest,
    user: CurrentUser,
    session: DbSession,
    storage: StorageDep,
) -> NoteSummaryOut:
    service = NotesService(session, user.id, storage)
    try:
        copy = await service.conflict_copy(note_id, payload.content)
    except Exception as exc:
        _translate(exc)
    await session.commit()
    return _summary(copy)


@router.post("/{note_id}/move", response_model=NoteDetailOut)
async def move_note(
    note_id: uuid.UUID,
    payload: NoteMoveRequest,
    request: Request,
    user: CurrentUser,
    session: DbSession,
    storage: StorageDep,
    sync: SyncMode,
    idempotency_key: Annotated[str | None, Header(alias="Idempotency-Key", max_length=200)] = None,
) -> Any:
    if sync:
        require_base(sync, payload.base_revision)
    store = IdempotencyStore(session, user.id)
    body = {"note_id": str(note_id), **payload.model_dump(mode="json")}
    replay = await _begin_sync_write(
        sync, request, NoteMoveRequest, store, idempotency_key, "note.move", body
    )
    if replay is not None:
        return replay
    service = NotesService(session, user.id, storage)
    try:
        note = await service.rename(note_id, payload.path)
        detail = await _detail(service, note)
    except Exception as exc:
        _translate(exc, sync)
    if sync:
        detail.sync = SyncResult(revision=note.revision)
        assert idempotency_key is not None
        await store.remember(
            idempotency_key, status_code=200, body=_stored_summary(note, detail.sync)
        )
    await session.commit()
    return detail


@router.delete("/{note_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_note(
    note_id: uuid.UUID,
    request: Request,
    user: CurrentUser,
    session: DbSession,
    storage: StorageDep,
    sync: SyncMode,
    idempotency_key: Annotated[str | None, Header(alias="Idempotency-Key", max_length=200)] = None,
    base_revision: Annotated[
        int | None,
        Query(ge=0, description="Sync mode (required). Edit-wins for notes arrives with SYNC-04."),
    ] = None,
) -> Response:
    if sync:
        require_base(sync, base_revision)
    store = IdempotencyStore(session, user.id)
    replay = await _begin_sync_write(
        sync, request, None, store, idempotency_key, "note.delete", {"note_id": str(note_id)}
    )
    if replay is not None:
        return Response(status_code=replay.status_code, headers=REPLAYED_HEADER)
    service = NotesService(session, user.id, storage)
    try:
        await service.delete(note_id)
    except Exception as exc:
        _translate(exc, sync)
    if sync:
        assert idempotency_key is not None
        await store.remember(idempotency_key, status_code=204, body={})
    await session.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@folders_router.post("", status_code=status.HTTP_201_CREATED)
async def create_folder(
    payload: FolderCreateRequest, user: CurrentUser, session: DbSession, storage: StorageDep
) -> dict[str, str]:
    service = NotesService(session, user.id, storage)
    try:
        await service.create_folder(payload.path)
    except Exception as exc:
        _translate(exc)
    return {"path": payload.path}


@folders_router.post("/rename")
async def rename_folder(
    payload: FolderRenameRequest, user: CurrentUser, session: DbSession, storage: StorageDep
) -> dict[str, int | str]:
    service = NotesService(session, user.id, storage)
    try:
        moved = await service.rename_folder(payload.path, payload.new_path)
    except Exception as exc:
        _translate(exc)
    await session.commit()
    return {"path": payload.new_path, "moved_notes": moved}


@folders_router.delete("", status_code=status.HTTP_204_NO_CONTENT)
async def delete_folder(
    user: CurrentUser,
    session: DbSession,
    storage: StorageDep,
    path: Annotated[str, Query(min_length=1, max_length=1024)],
) -> None:
    service = NotesService(session, user.id, storage)
    try:
        await service.delete_folder(path)
    except Exception as exc:
        _translate(exc)
