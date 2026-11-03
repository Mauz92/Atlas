"""Idempotent mutations.

A client may attach an ``Idempotency-Key`` header to a mutating request. The first request with
a key is applied and its response remembered; a retry with the same key and payload returns the
stored response without re-applying the change. Reusing a key with a different payload is
rejected with :class:`IdempotencyConflictError`.

The key is *reserved* before the work runs (``INSERT ... ON CONFLICT DO NOTHING``), so two
concurrent requests cannot both apply the change: the losing request replays the winner's
stored response.
"""

from __future__ import annotations

import hashlib
import json
import uuid
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from sqlalchemy import delete, select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from .models import IdempotencyKey


class IdempotencyConflictError(RuntimeError):
    """An idempotency key was reused with a different request."""


def fingerprint(payload: Mapping[str, Any] | None) -> str:
    """A stable SHA-256 of a request payload, independent of key order."""
    encoded = json.dumps(payload or {}, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def is_replay(
    existing_operation: str,
    existing_fingerprint: str,
    *,
    operation: str,
    request_fingerprint: str,
) -> bool:
    """Return ``True`` when a stored key can be replayed, else raise."""
    if existing_operation != operation or existing_fingerprint != request_fingerprint:
        raise IdempotencyConflictError("idempotency key reused with a different request")
    return True


@dataclass(frozen=True)
class StoredResponse:
    status_code: int
    body: Any


class IdempotencyStore:
    """Per-user idempotency records for one request's transaction."""

    def __init__(self, session: AsyncSession, user_id: uuid.UUID) -> None:
        self.session = session
        self.user_id = user_id

    async def reserve(
        self, key: str, operation: str, request_fingerprint: str
    ) -> StoredResponse | None:
        """Claim ``key`` for this request.

        Returns ``None`` when the key is newly ours (the caller should do the work and then
        call :meth:`remember`). Returns the stored response when this is a replay. Raises
        :class:`IdempotencyConflictError` when the key exists with a different request.
        """
        statement = (
            pg_insert(IdempotencyKey)
            .values(
                id=uuid.uuid4(),
                user_id=self.user_id,
                key=key,
                operation=operation,
                request_hash=request_fingerprint,
                response_status=0,
                response_body={},
            )
            .on_conflict_do_nothing(index_elements=["user_id", "key"])
            .returning(IdempotencyKey.id)
        )
        if (await self.session.execute(statement)).scalar_one_or_none() is not None:
            return None

        existing = await self.session.scalar(
            select(IdempotencyKey).where(
                IdempotencyKey.user_id == self.user_id, IdempotencyKey.key == key
            )
        )
        if existing is None:  # pragma: no cover - the row vanished between the statements
            raise IdempotencyConflictError("idempotency key is in use")
        is_replay(
            existing.operation,
            existing.request_hash,
            operation=operation,
            request_fingerprint=request_fingerprint,
        )
        return StoredResponse(status_code=existing.response_status, body=existing.response_body)

    async def remember(self, key: str, *, status_code: int, body: Any) -> None:
        """Store the response for a key reserved by this request."""
        await self.session.execute(
            update(IdempotencyKey)
            .where(IdempotencyKey.user_id == self.user_id, IdempotencyKey.key == key)
            .values(response_status=status_code, response_body=body)
        )


async def purge_expired(session: AsyncSession, *, cutoff: datetime) -> int:
    """Delete idempotency keys created before ``cutoff``; returns how many.

    Keys are kept at least as long as deletion tombstones (``change_retention_days``): an offline
    client may retry a write long after it was first sent, and a replay must still find its key.
    Safe to repeat. Only the key table is touched, never the entities the keys produced.
    """
    removed = await session.execute(
        delete(IdempotencyKey)
        .where(IdempotencyKey.created_at < cutoff)
        .returning(IdempotencyKey.id)
    )
    return len(removed.all())
