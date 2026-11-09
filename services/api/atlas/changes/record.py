"""Writing the per-user change feed (M7-01).

Every structured mutation records its effect here, in the **same transaction** as the mutation, so
the change feed can never drift from the data: a change that does not commit is not announced, and a
change that commits is always announced.

Two things matter and are enforced here:

- **The cursor is monotonic per user.** :meth:`ChangeRecorder.record` allocates the next value from
  the user's counter with a single ``UPDATE users SET change_seq = change_seq + 1 … RETURNING``
  before upserting the change row. That statement takes a row lock on the user for the life of the
  transaction, so two same-user transactions cannot both be "in flight" with interleaved cursors:
  the later one blocks until the earlier commits and therefore always gets a higher cursor. A
  client that has seen cursor ``N`` can never later see a change with a cursor ``<= N`` — the
  property that makes paging skip nothing (ADR-0032).
- **One row per entity.** The change row is upserted on ``(user_id, entity_type, entity_id)``, so an
  entity changed many times between two pulls appears once, at its latest cursor and operation.
"""

from __future__ import annotations

import uuid
from collections.abc import Iterable
from datetime import UTC, datetime

from sqlalchemy import text
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from ..models import ChangeLog
from .feed import ChangeEntityType, ChangeOperation

#: Advance the caller's monotonic cursor by one and return the new value. A bare ``UPDATE`` on the
#: user row is deliberate: it takes the row lock that serialises same-user recordings, and the
#: ``RETURNING`` hands back the value without a second round trip.
_ADVANCE_CURSOR = text(
    "UPDATE users SET change_seq = change_seq + 1 WHERE id = :user_id RETURNING change_seq"
)


class ChangeRecorder:
    """Records changes for one user into ``change_log`` within the caller's transaction."""

    def __init__(self, session: AsyncSession, user_id: uuid.UUID) -> None:
        self.session = session
        self.user_id = user_id

    async def record(
        self,
        entity_type: ChangeEntityType,
        entity_id: str,
        operation: ChangeOperation,
    ) -> int:
        """Upsert the change row for one entity and return the cursor it was recorded at."""
        seq = await self._advance_cursor()
        now = datetime.now(UTC)
        entity_type_value = str(entity_type)
        operation_value = str(operation)
        await self.session.execute(
            pg_insert(ChangeLog)
            .values(
                user_id=self.user_id,
                entity_type=entity_type_value,
                entity_id=entity_id,
                operation=operation_value,
                seq=seq,
                changed_at=now,
            )
            .on_conflict_do_update(
                index_elements=["user_id", "entity_type", "entity_id"],
                set_={"operation": operation_value, "seq": seq, "changed_at": now},
            )
        )
        # A committed feed change may be announced to the owner's other devices as a content-free
        # hint (M8-04e). One coalesced job per transaction/bucket; a no-op unless enabled.
        from ..hints.service import maybe_enqueue

        await maybe_enqueue(self.session, self.user_id)
        return seq

    async def record_many(
        self,
        entries: Iterable[tuple[ChangeEntityType, str, ChangeOperation]],
    ) -> None:
        """Record several changes in order (each gets its own cursor)."""
        for entity_type, entity_id, operation in entries:
            await self.record(entity_type, entity_id, operation)

    async def _advance_cursor(self) -> int:
        result = await self.session.execute(_ADVANCE_CURSOR, {"user_id": self.user_id})
        return int(result.scalar_one())
