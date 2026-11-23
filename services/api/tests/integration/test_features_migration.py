"""``e1f7a3c9d5b2`` (user_features): existing accounts keep optional features off (TTRPG-01)."""

from __future__ import annotations

from sqlalchemy import text

from atlas.db import session_scope
from atlas.migrations import downgrade, upgrade


async def test_existing_accounts_have_no_features_and_downgrade_keeps_users() -> None:
    downgrade("b7d4e1a8c5f3")
    try:
        async with session_scope() as session:
            await session.execute(
                text(
                    "INSERT INTO users (id, email, display_name, password_hash) "
                    "VALUES (gen_random_uuid(), 'old@example.com', 'Old', 'x')"
                )
            )
        upgrade("head")
        async with session_scope() as session:
            assert (await session.execute(text("SELECT count(*) FROM user_features"))).scalar() == 0
            assert (await session.execute(text("SELECT count(*) FROM users"))).scalar() == 1
        downgrade("b7d4e1a8c5f3")
        async with session_scope() as session:
            assert (await session.execute(text("SELECT count(*) FROM users"))).scalar() == 1
    finally:
        upgrade("head")
        async with session_scope() as session:
            await session.execute(text("DELETE FROM users WHERE email = 'old@example.com'"))
