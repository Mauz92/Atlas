"""The automatic-resolution log: list, read and undo (SYNC-05; ``SYNC_PROTOCOL.md`` section 9).

A sync-mode write that the server decided on its own (a simple field where the later write won, a
delete that lost to an edit, a merged note, a renamed path) leaves one entry in the log, in the
same transaction. A device learns of it through the change feed (entity type ``resolution``) and
may list it here. **Undo** re-applies the overwritten value of a simple field through the ordinary
revision-checked, field-merged write path of the entity, in a strict form: if the field changed
after the resolution, nothing is written and the answer says so (``409 conflict`` /
``changed_since``) - an undo never overwrites a newer value. Everything is scoped to the caller;
another user's entry is a plain ``404``.
"""

from __future__ import annotations

import uuid
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Header, HTTPException, Query, status
from fastapi.encoders import jsonable_encoder
from fastapi.responses import JSONResponse

from ..idempotency import IdempotencyConflictError, IdempotencyStore, fingerprint
from ..models import SyncResolution
from ..notes import (
    NoteDeletedError,
    NoteNotFoundError,
    NotePathConflictError,
    NotesService,
    NotesStorage,
    UnsafePathError,
)
from ..projects import ProjectNotFoundError, ProjectsService, ProjectValidationError
from ..reminders import ReminderService
from ..sync.fields import FieldConflict, Reason
from ..sync.protocol import SyncError
from ..sync.resolution_log import NewResolution, ResolutionLog, resolution_data
from ..sync.resolution_rules import (
    PATH_LATER_WINS,
    SIMPLE_LATER_WINS,
    UNDO,
    InvalidResolutionCursorError,
    UndoChangedSinceError,
    UndoTargetDeletedError,
    parse_limit,
    undo_status,
)
from ..tasks import InvalidTaskTransitionError, TaskNotFoundError, TasksService, TaskValidationError
from .deps import DbSession, SyncUser
from .notes import get_storage
from .schemas import (
    ProjectUpdateRequest,
    ResolutionListOut,
    ResolutionOut,
    ResolutionUndoOut,
    TaskUpdateRequest,
)
from .sync_gate import epoch_check
from .syncio import REPLAYED_HEADER, conflicts_out

router = APIRouter(
    prefix="/api/sync/resolutions", tags=["sync"], dependencies=[Depends(epoch_check)]
)

IdempotencyKey = Annotated[str | None, Header(alias="Idempotency-Key", max_length=200)]
StorageDep = Annotated[NotesStorage, Depends(get_storage)]


def _out(row: SyncResolution) -> ResolutionOut:
    return ResolutionOut.model_validate(resolution_data(row))


@router.get("", response_model=ResolutionListOut)
async def list_resolutions(
    user: SyncUser,
    session: DbSession,
    limit: Annotated[int | None, Query(description="Page size, 1 to 200 (default 50).")] = None,
    cursor: Annotated[
        str | None,
        Query(max_length=200, description="`next_cursor` of the previous page (older entries)."),
    ] = None,
    entity_id: Annotated[uuid.UUID | None, Query(description="Only this entity's entries.")] = None,
    rule: Annotated[str | None, Query(max_length=32, description="Only this rule.")] = None,
) -> ResolutionListOut:
    """The caller's resolution log, newest first (90 days by default, then purged).

    Includes `undo` entries and entries already undone (`undone_at`). `undoable` says whether
    `POST .../undo` can work; `undo_blocked` and `follow_up` say why not and what to do instead.
    """
    try:
        page_size = parse_limit(limit)
        rows, next_cursor = await ResolutionLog(session, user.id).page(
            limit=page_size, cursor=cursor, entity_id=entity_id, rule=rule
        )
    except (ValueError, InvalidResolutionCursorError) as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail=str(exc)
        ) from exc
    return ResolutionListOut(resolutions=[_out(row) for row in rows], next_cursor=next_cursor)


@router.get("/{resolution_id}", response_model=ResolutionOut)
async def get_resolution(
    resolution_id: uuid.UUID, user: SyncUser, session: DbSession
) -> ResolutionOut:
    row = await ResolutionLog(session, user.id).get(resolution_id)
    if row is None:
        raise SyncError(404, "not_found", "Not found")
    return _out(row)


def _changed_since(
    resolution: SyncResolution, field: str, value: Any, revision: int | None
) -> SyncError:
    conflict = FieldConflict(field, Reason.CHANGED_SINCE, revision or 0, value)
    return SyncError(
        409,
        "conflict",
        f"{field} was changed after this resolution; the undo was not applied",
        conflicts=[c.model_dump(mode="json") for c in conflicts_out([conflict])],
        resolution_id=str(resolution.id),
    )


@router.post("/{resolution_id}/undo", response_model=ResolutionUndoOut)
async def undo_resolution(
    resolution_id: uuid.UUID,
    user: SyncUser,
    session: DbSession,
    storage: StorageDep,
    idempotency_key: IdempotencyKey = None,
) -> Any:
    """Undo an automatic resolution: restore the value the later write overwrote.

    Needs an `Idempotency-Key` (`422 idempotency_key_required`); the same key replays the first
    answer. Only `simple_later_wins` (a task or project field) and `path_later_wins` (a note move)
    can be undone; the value is written through the entity's normal sync write, based on the
    revision the resolution produced:

    - the field changed since (or the note moved again) -> `409 conflict` with a `changed_since`
      conflict and the current value; **nothing is overwritten** and the entry stays undoable;
    - the entity is deleted -> `409 entity_deleted` (an undo never brings it back);
    - the restored value is not valid any more (a deleted project, an illegal status change, a
      taken path) -> `409 conflict` (`invalid_value`, `invalid_transition`) or `409 path_exists`;
    - already undone -> `409 already_undone` (a different key); not undoable -> `409 not_undoable`
      with `reason` and `follow_up` (`note_merged`: the other version is in the note history;
      `edit_wins_over_delete`: delete again; `path_collision`: rename the note);
    - if the field already holds the restored value nothing is written (`applied: false`) and the
      entry is still marked undone.

    A successful undo writes an `undo` entry of its own to the log and announces both entries on
    the feed. Another user's entry is `404`.
    """
    if not idempotency_key:
        raise SyncError(
            422, "idempotency_key_required", "an undo requires an Idempotency-Key header"
        )
    store = IdempotencyStore(session, user.id)
    try:
        stored = await store.reserve(
            idempotency_key, "resolution.undo", fingerprint({"resolution_id": str(resolution_id)})
        )
    except IdempotencyConflictError as exc:
        raise SyncError(
            409, "idempotency_mismatch", "idempotency key reused with a different request"
        ) from exc
    if stored is not None:
        return JSONResponse(
            status_code=stored.status_code, content=stored.body, headers=REPLAYED_HEADER
        )
    log = ResolutionLog(session, user.id)
    row = await log.get(resolution_id, for_update=True)
    if row is None:
        raise SyncError(404, "not_found", "Not found")
    verdict = undo_status(
        rule=row.rule,
        entity_type=row.entity_type,
        entity_id=row.entity_id,
        kept_revision=row.kept_revision,
        field=row.field,
        has_loser=row.loser is not None,
        undone=row.undone_at is not None,
    )
    if row.undone_at is not None:
        raise SyncError(
            409,
            "already_undone",
            "this resolution was already undone",
            resolution=_out(row).model_dump(mode="json"),
        )
    if not verdict.undoable:
        raise SyncError(
            409,
            "not_undoable",
            "this resolution cannot be undone",
            reason=verdict.reason,
            follow_up=(
                {"kind": verdict.follow_up.kind, "href": verdict.follow_up.href}
                if verdict.follow_up
                else None
            ),
            resolution=_out(row).model_dump(mode="json"),
        )
    assert row.loser is not None and row.field is not None and row.kept_revision is not None
    loser = row.loser["value"]
    try:
        applied, revision, overwritten = await _apply_undo(
            session, user.id, storage, row, loser, row.field, row.kept_revision
        )
    except UndoChangedSinceError as exc:
        raise _changed_since(
            row, exc.field, jsonable_encoder(exc.server_value), exc.server_revision
        ) from exc
    except (UndoTargetDeletedError, TaskNotFoundError, ProjectNotFoundError, NoteNotFoundError,
            NoteDeletedError) as exc:  # fmt: skip
        raise SyncError(
            409, "entity_deleted", "the entity is deleted; an undo does not bring it back"
        ) from exc
    except NotePathConflictError as exc:
        raise SyncError(409, "path_exists", "A note or folder already exists there") from exc
    except InvalidTaskTransitionError as exc:
        raise _invalid_value(row, "invalid_transition", str(exc)) from exc
    except (TaskValidationError, ProjectValidationError, UnsafePathError) as exc:
        raise _invalid_value(row, "invalid_value", str(exc)) from exc
    entry = (
        await log.record(
            [
                NewResolution(
                    entity_type=row.entity_type,
                    entity_id=row.entity_id,
                    rule=UNDO,
                    field=row.field,
                    kept_revision=revision,
                    loser=jsonable_encoder(overwritten),
                    undoes_id=row.id,
                )
            ],
            op_key=idempotency_key,
        )
    )[0]
    await log.mark_undone(row, entry)
    out = ResolutionUndoOut(
        applied=applied, revision=revision, resolution=_out(row), undo=_out(entry)
    )
    await store.remember(idempotency_key, status_code=200, body=out.model_dump(mode="json"))
    await session.commit()
    return out


def _invalid_value(resolution: SyncResolution, reason: str, detail: str) -> SyncError:
    return SyncError(
        409,
        "conflict",
        "the restored value is not valid any more; the undo was not applied",
        conflicts=[{"field": resolution.field, "reason": reason, "server_revision": None}],
        detail_message=detail[:200],
        resolution_id=str(resolution.id),
    )


async def _apply_undo(
    session: Any,
    user_id: uuid.UUID,
    storage: NotesStorage,
    row: SyncResolution,
    loser: Any,
    field: str,
    kept_revision: int,
) -> tuple[bool, int, Any]:
    """Write ``loser`` back through the entity's strict sync write.

    Returns ``(applied, revision after, value replaced)``. The base of the write is the revision
    the resolution produced, so any later change of the field is a conflict, never an overwrite.
    """
    if row.rule == SIMPLE_LATER_WINS and row.entity_type == "task":
        body = TaskUpdateRequest.model_validate({field: loser, "base_revision": kept_revision})
        changes = body.model_dump(exclude_unset=True)
        changes.pop("base_revision", None)
        tasks = TasksService(session, user_id)
        task_outcome = await tasks.update_sync(row.entity_id, changes, kept_revision, strict=True)
        _raise_if_conflict(task_outcome.conflicts)
        if task_outcome.applied:
            await ReminderService(session, user_id).sync_for_task(task_outcome.task.id)
        return (
            bool(task_outcome.applied),
            task_outcome.task.revision,
            task_outcome.previous.get(field),
        )
    if row.rule == SIMPLE_LATER_WINS and row.entity_type == "project":
        pbody = ProjectUpdateRequest.model_validate({field: loser, "base_revision": kept_revision})
        pchanges = pbody.model_dump(exclude_unset=True)
        pchanges.pop("base_revision", None)
        projects = ProjectsService(session, user_id)
        project_outcome = await projects.update_sync(
            row.entity_id, pchanges, kept_revision, strict=True
        )
        _raise_if_conflict(project_outcome.conflicts)
        return (
            bool(project_outcome.applied),
            project_outcome.project.revision,
            project_outcome.previous.get(field),
        )
    if row.rule == PATH_LATER_WINS and row.entity_type == "note":
        notes = NotesService(session, user_id, storage)
        note = await notes.get_any(row.entity_id, for_update=True)
        if note.deleted_at is not None:
            raise UndoTargetDeletedError(str(note.id))
        winner = await notes.history.entry(note.id, kept_revision)
        if winner is None or winner.path != note.path:
            # moved again since (or the revision is no longer retained: never guess)
            raise UndoChangedSinceError("path", note.path, note.revision)
        before_path, before_revision = note.path, note.revision
        write = await notes.rename_sync(note.id, str(loser), note.revision)
        return write.note.revision != before_revision, write.note.revision, before_path
    raise SyncError(409, "not_undoable", "this resolution cannot be undone")  # pragma: no cover


def _raise_if_conflict(conflicts: list[FieldConflict]) -> None:
    if conflicts:
        first = conflicts[0]
        raise UndoChangedSinceError(first.field, first.server_value, first.server_revision)
