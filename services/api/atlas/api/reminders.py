"""Reminder feed entity and actions (M8-04a; SYNC_PROTOCOL.md 14.2, 14.5).

The reminders themselves are server-derived and read-only for clients: they reach devices through
``GET /api/changes?types=reminder&include=data``. This router adds the two things a client may do:

- ``GET /api/reminders?state=armed`` - the caller's reminders (diagnostics; browser or device).
- ``POST /api/reminders/{id}/actions`` - snooze or dismiss, **idempotent by `action_id`** (also the
  `Idempotency-Key`), user-scoped (another user's id is `404`), open to device credentials
  (`SyncUser`, scope `sync`). Completing a task is the ordinary task write, not an action here.
"""

from __future__ import annotations

import uuid
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, Header, Query, Request
from fastapi.responses import JSONResponse
from sqlalchemy import select

from ..idempotency import IdempotencyConflictError, IdempotencyStore, fingerprint
from ..models import Reminder, ReminderDelivery
from ..reminders.actions import (
    ReminderNotFoundError,
    ReminderRevisionAheadError,
    apply_action,
)
from ..sync.protocol import SyncError
from .deps import DbSession, SyncUser, current_device_id
from .schemas import ReminderActionOut, ReminderActionRequest, ReminderListOut, ReminderOut
from .sync_gate import epoch_check
from .syncio import REPLAYED_HEADER

router = APIRouter(prefix="/api/reminders", tags=["reminders"], dependencies=[Depends(epoch_check)])

IdempotencyKeyHeader = Annotated[str | None, Header(alias="Idempotency-Key", max_length=200)]


def _out(reminder: Reminder, delivered_at: Any) -> ReminderOut:
    return ReminderOut(
        id=reminder.id,
        revision=reminder.revision,
        task_id=reminder.entity_id,
        state=reminder.state,
        remind_at=reminder.remind_at,
        snoozed_until=reminder.snoozed_until,
        acknowledged_at=reminder.acknowledged_at,
        effective_at=reminder.snoozed_until or reminder.remind_at,
        server_delivered_at=delivered_at,
    )


@router.get("", response_model=ReminderListOut)
async def list_reminders(
    user: SyncUser,
    session: DbSession,
    state: Annotated[
        Literal["armed", "cancelled"] | None,
        Query(description="Only reminders in this device-visible state."),
    ] = None,
    limit: Annotated[int, Query(ge=1, le=500)] = 200,
) -> ReminderListOut:
    """The caller's reminders, soonest first (diagnostics for the web app; devices use the feed)."""
    stmt = (
        select(Reminder, ReminderDelivery.delivered_at)
        .outerjoin(ReminderDelivery, ReminderDelivery.reminder_id == Reminder.id)
        .where(Reminder.user_id == user.id)
        .order_by(Reminder.remind_at, Reminder.id)
        .limit(limit)
    )
    if state is not None:
        stmt = stmt.where(Reminder.state == state)
    rows = (await session.execute(stmt)).all()
    return ReminderListOut(reminders=[_out(r, d) for r, d in rows])


@router.post("/{reminder_id}/actions", response_model=ReminderActionOut)
async def reminder_action(
    reminder_id: uuid.UUID,
    payload: ReminderActionRequest,
    request: Request,
    user: SyncUser,
    session: DbSession,
    idempotency_key: IdempotencyKeyHeader = None,
) -> Any:
    """Snooze or dismiss one reminder (SYNC_PROTOCOL.md 14.5).

    Idempotent: a replay of the same `action_id` returns the stored answer with
    `Idempotency-Replayed: true` and does not bump the revision again. The later action in server
    order wins and a snooze after a dismiss re-arms. A stale `base_revision` is answered, not
    refused (`stale: true`); one ahead of the server is `409 revision_ahead`. A cancelled reminder
    answers `200` with `applied: false`. Another user's reminder is `404`.
    """
    key = idempotency_key or f"reminder.action:{payload.action_id}"
    if idempotency_key is not None and idempotency_key != str(payload.action_id):
        raise SyncError(422, "idempotency_key_mismatch", "Idempotency-Key must equal the action_id")
    store = IdempotencyStore(session, user.id)
    try:
        stored = await store.reserve(
            key,
            "reminder.action",
            fingerprint({"reminder_id": str(reminder_id), **payload.model_dump(mode="json")}),
        )
    except IdempotencyConflictError as exc:
        raise SyncError(
            409, "idempotency_mismatch", "idempotency key reused with a different request"
        ) from exc
    if stored is not None:
        return JSONResponse(
            status_code=stored.status_code, content=stored.body, headers=REPLAYED_HEADER
        )
    try:
        result = await apply_action(
            session,
            user.id,
            reminder_id,
            kind=payload.kind,
            snooze_for_seconds=payload.snooze_for_seconds,
            until=payload.until,
            base_revision=payload.base_revision,
            device_id=current_device_id(request),
        )
    except ReminderNotFoundError as exc:
        raise SyncError(404, "not_found", "Not found") from exc
    except ReminderRevisionAheadError as exc:
        raise SyncError(
            409,
            "revision_ahead",
            "base_revision is newer than the server's; resync before acting",
            current_revision=exc.current_revision,
        ) from exc
    out = ReminderActionOut(
        reminder=_out(result.reminder, result.delivered_at),
        applied=result.applied,
        stale=result.stale,
    )
    await store.remember(key, status_code=200, body=out.model_dump(mode="json"))
    await session.commit()
    return out
