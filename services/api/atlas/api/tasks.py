"""Tasks API: CRUD with idempotent mutations.

Mutations may carry an ``Idempotency-Key`` header (see :mod:`atlas.idempotency`); a retry with
the same key and payload returns the original response instead of applying the change again.
"""

from __future__ import annotations

import uuid
from typing import Annotated, Any, NoReturn

from fastapi import APIRouter, Header, HTTPException, Response, status
from fastapi.responses import JSONResponse

from ..idempotency import IdempotencyConflictError, IdempotencyStore, fingerprint
from ..models import Task
from ..tasks import (
    InvalidTaskTransitionError,
    TaskNotFoundError,
    TaskRevisionConflictError,
    TasksService,
    TaskValidationError,
)
from .deps import CurrentUser, DbSession
from .schemas import TaskCreateRequest, TaskListOut, TaskOut, TaskUpdateRequest

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


def _out(task: Task) -> TaskOut:
    return TaskOut.model_validate(task)


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
        task = await TasksService(session, user.id).create(payload.model_dump(mode="json"))
    except Exception as exc:
        _translate(exc)
    out = _out(task)
    if idempotency_key:
        await store.remember(idempotency_key, status_code=201, body=out.model_dump(mode="json"))
    await session.commit()
    return out


@router.get("", response_model=TaskListOut)
async def list_tasks(user: CurrentUser, session: DbSession) -> TaskListOut:
    tasks = await TasksService(session, user.id).list()
    return TaskListOut(tasks=[_out(task) for task in tasks])


@router.get("/{task_id}", response_model=TaskOut)
async def get_task(task_id: uuid.UUID, user: CurrentUser, session: DbSession) -> TaskOut:
    try:
        task = await TasksService(session, user.id).get(task_id)
    except Exception as exc:
        _translate(exc)
    return _out(task)


@router.patch("/{task_id}", response_model=TaskOut)
async def update_task(
    task_id: uuid.UUID,
    payload: TaskUpdateRequest,
    user: CurrentUser,
    session: DbSession,
    idempotency_key: IdempotencyKey = None,
) -> Any:
    store = IdempotencyStore(session, user.id)
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
        task = await TasksService(session, user.id).update(
            task_id, payload.model_dump(exclude_unset=True, mode="json"), payload.base_revision
        )
    except Exception as exc:
        _translate(exc)
    out = _out(task)
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
    if idempotency_key:
        await store.remember(idempotency_key, status_code=204, body={})
    await session.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)
