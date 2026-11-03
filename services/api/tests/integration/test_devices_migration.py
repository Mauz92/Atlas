"""The ``devices`` migration against a real PostgreSQL (SYNC-06).

Synchronous (Alembic's env.py starts its own event loop); leaves the schema at ``head``. Covers the
upgrade from the previous revision with representative data (including existing resolutions whose
``device_id`` is NULL), the constraints, the foreign key of ``sync_resolutions.device_id`` and the
downgrade (devices go, everything else stays).
"""

from __future__ import annotations

import os
import uuid

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.exc import DataError, IntegrityError

from atlas.migrations import downgrade, upgrade

PREVIOUS = "f4a8b2c6d1e3"


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
    return bool(conn.execute(text("SELECT to_regclass('public.devices') IS NOT NULL")).scalar())


def _populate(conn) -> dict[str, uuid.UUID]:
    """An installation at the previous revision: a user with a session, a task and a resolution."""
    ids = {name: uuid.uuid4() for name in ("user", "task", "resolution")}
    conn.execute(text("TRUNCATE users CASCADE"))
    conn.execute(
        text(
            "INSERT INTO users (id, email, display_name, password_hash, change_seq)"
            " VALUES (:u, 'm@x', 'M', 'x', 3)"
        ),
        {"u": ids["user"]},
    )
    conn.execute(
        text("INSERT INTO tasks (id, user_id, title, revision) VALUES (:t, :u, 'T', 4)"),
        {"t": ids["task"], "u": ids["user"]},
    )
    conn.execute(
        text(
            "INSERT INTO sessions (id, user_id, token_hash, expires_at)"
            " VALUES (:i, :u, :h, now() + interval '1 day')"
        ),
        {"i": uuid.uuid4(), "u": ids["user"], "h": "s" * 64},
    )
    conn.execute(
        text(
            "INSERT INTO sync_resolutions (id, user_id, entity_type, entity_id, rule, device_id)"
            " VALUES (:r, :u, 'task', :t, 'simple_later_wins', NULL)"
        ),
        {"r": ids["resolution"], "u": ids["user"], "t": ids["task"]},
    )
    return ids


def _device(conn, ids, **over) -> uuid.UUID:
    row = {
        "id": uuid.uuid4(),
        "u": ids["user"],
        "name": "Laptop",
        "platform": "linux",
        "hash": uuid.uuid4().hex + uuid.uuid4().hex,
        **over,
    }
    conn.execute(
        text(
            "INSERT INTO devices (id, user_id, name, platform, token_hash)"
            " VALUES (:id, :u, :name, :platform, :hash)"
        ),
        row,
    )
    return row["id"]  # type: ignore[no-any-return]


def test_upgrade_adds_an_empty_table_and_leaves_existing_rows_untouched(db) -> None:
    downgrade(PREVIOUS)
    with db.begin() as conn:
        ids = _populate(conn)
        assert not _exists(conn)
    upgrade("head")
    with db.begin() as conn:
        assert _exists(conn)
        assert conn.execute(text("SELECT count(*) FROM devices")).scalar() == 0
        assert conn.execute(text("SELECT revision FROM tasks")).scalar() == 4
        assert conn.execute(text("SELECT count(*) FROM sessions")).scalar() == 1
        assert conn.execute(text("SELECT device_id FROM sync_resolutions")).scalar() is None
        device = _device(conn, ids)
        row = conn.execute(
            text("SELECT last_seen_at, revoked_at, prev_token_hash, created_at FROM devices")
        ).one()
        assert row.last_seen_at is None and row.revoked_at is None
        assert row.prev_token_hash is None and row.created_at is not None
        # a resolution may now name the device; deleting the user cascades to both
        conn.execute(
            text("UPDATE sync_resolutions SET device_id = :d"),
            {"d": device},
        )
        conn.execute(text("DELETE FROM users WHERE id = :u"), {"u": ids["user"]})
        assert conn.execute(text("SELECT count(*) FROM devices")).scalar() == 0
        assert conn.execute(text("SELECT count(*) FROM sync_resolutions")).scalar() == 0


def test_the_constraints_hold(db) -> None:
    with db.begin() as conn:
        ids = _populate(conn)
        first = _device(conn, ids, hash="a" * 64)
    for bad in (
        {"hash": "a" * 64},  # a token hash is unique
        {"platform": "toaster"},
        {"name": ""},
        {"name": "x" * 81},
    ):
        with pytest.raises((IntegrityError, DataError)), db.begin() as conn:
            _device(conn, ids, **bad)
    with pytest.raises(IntegrityError), db.begin() as conn:
        _device(conn, {"user": uuid.uuid4()})  # no such user
    with db.begin() as conn:
        # purging a device keeps the resolution it wrote, with the device cleared
        conn.execute(
            text("UPDATE sync_resolutions SET device_id = :d"),
            {"d": first},
        )
        conn.execute(text("DELETE FROM devices WHERE id = :d"), {"d": first})
        assert conn.execute(text("SELECT count(*) FROM sync_resolutions")).scalar() == 1
        assert conn.execute(text("SELECT device_id FROM sync_resolutions")).scalar() is None
    with pytest.raises(IntegrityError), db.begin() as conn:
        conn.execute(
            text("UPDATE sync_resolutions SET device_id = :d"), {"d": uuid.uuid4()}
        )  # an unknown device


def test_downgrade_drops_devices_and_keeps_the_rest(db) -> None:
    with db.begin() as conn:
        ids = _populate(conn)
        device = _device(conn, ids)
        conn.execute(text("UPDATE sync_resolutions SET device_id = :d"), {"d": device})
    downgrade(PREVIOUS)
    with db.connect() as conn:
        assert not _exists(conn)
        assert conn.execute(text("SELECT count(*) FROM tasks")).scalar() == 1
        assert conn.execute(text("SELECT count(*) FROM sessions")).scalar() == 1
        # the log row survives; which device wrote it is forgotten (the id would dangle)
        assert conn.execute(text("SELECT count(*) FROM sync_resolutions")).scalar() == 1
        assert conn.execute(text("SELECT device_id FROM sync_resolutions")).scalar() is None
    upgrade("head")
    upgrade("head")  # idempotent at head
    with db.begin() as conn:
        assert _exists(conn)
        assert conn.execute(text("SELECT count(*) FROM devices")).scalar() == 0
        device = _device(conn, {"user": conn.execute(text("SELECT id FROM users")).scalar()})
        conn.execute(
            text("UPDATE sync_resolutions SET device_id = :d"), {"d": device}
        )  # FK is back
