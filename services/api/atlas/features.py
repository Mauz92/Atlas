"""Optional bundled features and their per-user switches (TTRPG-01).

A feature is off until its owner enables it. This module knows only the feature *names* and the
switch; it holds no knowledge of what a feature does. Disabling never deletes the feature's data.
"""

from __future__ import annotations

import uuid

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from .models import UserFeature

#: Every optional feature that can be switched. Anything else is rejected with 404.
TTRPG = "ttrpg"
KNOWN_FEATURES: tuple[str, ...] = (TTRPG,)


async def feature_states(session: AsyncSession, user_id: uuid.UUID) -> dict[str, bool]:
    """Every known feature mapped to whether it is enabled for the user (missing row = off)."""
    rows = (
        await session.execute(select(UserFeature).where(UserFeature.user_id == user_id))
    ).scalars()
    stored = {row.feature: row.enabled for row in rows}
    return {name: stored.get(name, False) for name in KNOWN_FEATURES}


async def is_enabled(session: AsyncSession, user_id: uuid.UUID, feature: str) -> bool:
    row = await session.get(UserFeature, (user_id, feature))
    return bool(row and row.enabled)


async def set_enabled(
    session: AsyncSession, user_id: uuid.UUID, feature: str, enabled: bool
) -> None:
    """Idempotent upsert of one switch (safe under concurrent retries)."""
    statement = insert(UserFeature).values(user_id=user_id, feature=feature, enabled=enabled)
    await session.execute(
        statement.on_conflict_do_update(
            index_elements=[UserFeature.user_id, UserFeature.feature],
            set_={"enabled": enabled, "updated_at": statement.excluded.updated_at},
        )
    )
    await session.commit()
