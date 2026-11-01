"""Provider-credential schema against a real PostgreSQL (M5-01).

Covers the migration/model agreement and the integrity rules the table must enforce: database
defaults, the one-per-``(user, provider)`` unique constraint and the account-deletion cascade.
"""

from __future__ import annotations

import uuid

import pytest
from alembic.autogenerate import compare_metadata
from alembic.migration import MigrationContext
from sqlalchemy import delete, select, text
from sqlalchemy.exc import IntegrityError

from atlas.db import Base, get_engine, session_scope
from atlas.models import ProviderCredential, User

pytestmark = pytest.mark.usefixtures("_db")


async def _create_user(session) -> User:
    user = User(
        email=f"{uuid.uuid4()}@example.com",
        display_name="Owner",
        password_hash="not-used-by-schema-tests",
    )
    session.add(user)
    await session.flush()
    return user


async def test_migrations_match_models() -> None:
    engine = get_engine()

    def _diff(sync_connection):
        context = MigrationContext.configure(sync_connection, opts={"compare_type": True})
        return compare_metadata(context, Base.metadata)

    async with engine.connect() as connection:
        diffs = await connection.run_sync(_diff)

    assert diffs == []


async def test_database_applies_credential_defaults() -> None:
    async with session_scope() as session:
        user = await _create_user(session)
        credential_id = uuid.uuid4()
        await session.execute(
            text(
                "INSERT INTO provider_credentials (id, user_id, provider, key_id, ciphertext) "
                "VALUES (:id, :user_id, 'google', 'v1', :ciphertext)"
            ),
            {"id": credential_id, "user_id": user.id, "ciphertext": b"raw-ciphertext"},
        )

    async with session_scope() as session:
        row = (
            await session.execute(
                select(ProviderCredential).where(ProviderCredential.id == credential_id)
            )
        ).scalar_one()
        assert row.provider == "google"
        assert row.key_id == "v1"
        assert row.scopes == []
        assert row.access_expires_at is None
        assert row.refresh_expires_at is None
        assert row.created_at is not None
        assert row.updated_at is not None


async def test_a_user_and_provider_pair_is_unique() -> None:
    async with session_scope() as session:
        user = await _create_user(session)
        user_id = user.id
        session.add(
            ProviderCredential(user_id=user_id, provider="google", key_id="v1", ciphertext=b"a")
        )
        await session.flush()

    with pytest.raises(IntegrityError):
        async with session_scope() as session:
            session.add(
                ProviderCredential(user_id=user_id, provider="google", key_id="v1", ciphertext=b"b")
            )
            await session.flush()


async def test_two_users_may_each_store_the_same_provider() -> None:
    async with session_scope() as session:
        first = await _create_user(session)
        second = await _create_user(session)
        session.add_all(
            [
                ProviderCredential(
                    user_id=first.id, provider="google", key_id="v1", ciphertext=b"a"
                ),
                ProviderCredential(
                    user_id=second.id, provider="google", key_id="v1", ciphertext=b"b"
                ),
            ]
        )
        await session.flush()


async def test_a_credential_requires_an_existing_user() -> None:
    with pytest.raises(IntegrityError):
        async with session_scope() as session:
            session.add(
                ProviderCredential(
                    user_id=uuid.uuid4(), provider="google", key_id="v1", ciphertext=b"a"
                )
            )
            await session.flush()


async def test_deleting_a_user_cascades_to_credentials() -> None:
    async with session_scope() as session:
        user = await _create_user(session)
        user_id = user.id
        session.add(
            ProviderCredential(user_id=user_id, provider="microsoft", key_id="v1", ciphertext=b"a")
        )
        await session.flush()

    async with session_scope() as session:
        await session.execute(delete(User).where(User.id == user_id))

    async with session_scope() as session:
        remaining = (
            (
                await session.execute(
                    select(ProviderCredential).where(ProviderCredential.user_id == user_id)
                )
            )
            .scalars()
            .all()
        )
        assert remaining == []
