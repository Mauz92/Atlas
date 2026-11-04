"""The ``recovery_codes`` migration against a real PostgreSQL (AUTH-01, ADR-0067).

Synchronous (Alembic's env.py starts its own event loop); leaves the schema at ``head``. Covers the
upgrade from the previous revision on a representative installation (accounts with sessions,
devices and data, none with a code), the constraints and the cascade, and the downgrade.
"""

from __future__ import annotations

import os
import uuid

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.exc import IntegrityError

from atlas.migrations import downgrade, upgrade

PREVIOUS = "b7c4d9e2a1f5"


@pytest.fixture
def db():
    upgrade("head")
    engine = create_engine(os.environ["DATABASE_URL"])
    yield engine
    upgrade("head")
    with engine.begin() as conn:
        conn.execute(text("TRUNCATE users CASCADE"))
    engine.dispose()


def _exists(conn) -> bool:
    return bool(
        conn.execute(text("SELECT to_regclass('public.recovery_codes') IS NOT NULL")).scalar()
    )


def _populate(conn) -> uuid.UUID:
    """An installation at the previous revision: an account with a session, a device and a task."""
    user = uuid.uuid4()
    conn.execute(text("TRUNCATE users CASCADE"))
    conn.execute(
        text(
            "INSERT INTO users (id, email, display_name, password_hash, change_seq)"
            " VALUES (:u, 'm@x', 'M', 'pw-hash', 3)"
        ),
        {"u": user},
    )
    conn.execute(
        text("INSERT INTO tasks (id, user_id, title, revision) VALUES (:t, :u, 'T', 4)"),
        {"t": uuid.uuid4(), "u": user},
    )
    conn.execute(
        text(
            "INSERT INTO sessions (id, user_id, token_hash, expires_at)"
            " VALUES (:i, :u, :h, now() + interval '1 day')"
        ),
        {"i": uuid.uuid4(), "u": user, "h": "s" * 64},
    )
    conn.execute(
        text(
            "INSERT INTO devices (id, user_id, name, platform, token_hash)"
            " VALUES (:i, :u, 'Laptop', 'linux', :h)"
        ),
        {"i": uuid.uuid4(), "u": user, "h": "d" * 64},
    )
    return user


def _code(conn, user: uuid.UUID, **over) -> None:
    row = {"u": user, "salt": "a" * 32, "hash": "b" * 64, "n": 0, **over}
    conn.execute(
        text(
            "INSERT INTO recovery_codes (user_id, code_salt, code_hash, failed_attempts)"
            " VALUES (:u, :salt, :hash, :n)"
        ),
        row,
    )


def test_upgrade_adds_an_empty_table_and_leaves_existing_accounts_without_a_code(db) -> None:
    downgrade(PREVIOUS)
    with db.begin() as conn:
        user = _populate(conn)
        assert not _exists(conn)
    upgrade("head")
    with db.begin() as conn:
        assert _exists(conn)
        assert conn.execute(text("SELECT count(*) FROM recovery_codes")).scalar() == 0
        row = conn.execute(text("SELECT password_hash, change_seq FROM users")).one()
        assert tuple(row) == ("pw-hash", 3)
        assert conn.execute(text("SELECT revision FROM tasks")).scalar() == 4
        assert conn.execute(text("SELECT count(*) FROM sessions")).scalar() == 1
        assert conn.execute(text("SELECT count(*) FROM devices")).scalar() == 1
        _code(conn, user)
        stored = conn.execute(
            text("SELECT created_at, last_used_at, failed_attempts FROM recovery_codes")
        ).one()
        assert stored.created_at is not None and stored.last_used_at is None
        assert stored.failed_attempts == 0


def test_the_constraints_hold_and_deleting_the_user_deletes_the_code(db) -> None:
    with db.begin() as conn:
        user = _populate(conn)
        _code(conn, user)
    for bad in (
        lambda c: _code(c, user),  # one code per user
        lambda c: _code(c, uuid.uuid4()),  # no such user
        lambda c: _code(c, user, n=-1),
    ):
        with pytest.raises(IntegrityError), db.begin() as conn:
            bad(conn)
    with db.begin() as conn:
        conn.execute(text("DELETE FROM users WHERE id = :u"), {"u": user})
        assert conn.execute(text("SELECT count(*) FROM recovery_codes")).scalar() == 0


def test_downgrade_drops_the_table_and_keeps_everything_else(db) -> None:
    with db.begin() as conn:
        user = _populate(conn)
        _code(conn, user)
    downgrade(PREVIOUS)
    with db.connect() as conn:
        assert not _exists(conn)
        assert conn.execute(text("SELECT count(*) FROM users")).scalar() == 1
        assert conn.execute(text("SELECT count(*) FROM tasks")).scalar() == 1
        assert conn.execute(text("SELECT count(*) FROM sessions")).scalar() == 1
        assert conn.execute(text("SELECT count(*) FROM devices")).scalar() == 1
    upgrade("head")
    upgrade("head")  # idempotent at head
    with db.begin() as conn:
        assert _exists(conn)
        assert conn.execute(text("SELECT count(*) FROM recovery_codes")).scalar() == 0
        _code(conn, user)  # usable again
