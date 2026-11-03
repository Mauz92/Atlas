"""The instance epoch (SYNC-03b, D9/D12): which history of this database a client is talking to."""

from __future__ import annotations

import uuid

from sqlalchemy import select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from ..models import InstanceMeta

EPOCH_KEY = "epoch"


async def get_epoch(session: AsyncSession) -> str:
    """The current epoch. A missing row (a database restored from before the migration, or one
    emptied by hand) is created on first read, so the answer is never absent."""
    value = await session.scalar(select(InstanceMeta.value).where(InstanceMeta.key == EPOCH_KEY))
    if value is not None:
        return str(value)
    await session.execute(
        pg_insert(InstanceMeta)
        .values(key=EPOCH_KEY, value=str(uuid.uuid4()))
        .on_conflict_do_nothing(index_elements=["key"])
    )
    created = await session.scalar(select(InstanceMeta.value).where(InstanceMeta.key == EPOCH_KEY))
    return str(created)


async def rotate_epoch(session: AsyncSession) -> str:
    """Replace the epoch with a new one and return it (the operator's "a restore happened")."""
    await get_epoch(session)
    new = str(uuid.uuid4())
    await session.execute(
        update(InstanceMeta).where(InstanceMeta.key == EPOCH_KEY).values(value=new)
    )
    return new
