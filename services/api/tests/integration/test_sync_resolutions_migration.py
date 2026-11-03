"""The ``sync_resolutions`` migration against a real PostgreSQL (SYNC-05).

Synchronous (Alembic's env.py starts its own event loop); leaves the schema at ``head``. Covers
the upgrade from the previous revision with representative data in place, the constraints the
table promises, and the downgrade (which must also remove the feed rows of the entity type).
"""

from __future__ import annotations

import os
import uuid

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.exc import IntegrityError

from atlas.migrations import downgrade, upgrade

PREVIOUS = "e7a3c5b1d9f2"


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
        conn.execute(text("SELECT to_regclass('public.sync_resolutions') IS NOT NULL")).scalar()
    )


def _populate(conn) -> dict[str, uuid.UUID]:
    """A representative installation at the previous revision: user, task, project, note, feed."""
    ids = {name: uuid.uuid4() for name in ("user", "task", "project", "note")}
    conn.execute(text("TRUNCATE users CASCADE"))
    conn.execute(
        text(
            "INSERT INTO users (id, email, display_name, password_hash, change_seq)"
            " VALUES (:u, 'm@x', 'M', 'x', 3)"
        ),
        {"u": ids["user"]},
    )
    conn.execute(
        text("INSERT INTO projects (id, user_id, name) VALUES (:p, :u, 'P')"),
        {"p": ids["project"], "u": ids["user"]},
    )
    conn.execute(
        text("INSERT INTO tasks (id, user_id, title, revision) VALUES (:t, :u, 'T', 4)"),
        {"t": ids["task"], "u": ids["user"]},
    )
    conn.execute(
        text(
            "INSERT INTO notes (id, user_id, path, title, content_hash, revision)"
            " VALUES (:n, :u, 'a.md', 'a', 'h', 7)"
        ),
        {"n": ids["note"], "u": ids["user"]},
    )
    for seq, (kind, key) in enumerate(
        (("task", "task"), ("project", "project"), ("note", "note")), start=1
    ):
        conn.execute(
            text(
                "INSERT INTO change_log (user_id, entity_type, entity_id, operation, seq)"
                " VALUES (:u, :k, :e, 'upsert', :s)"
            ),
            {"u": ids["user"], "k": kind, "e": str(ids[key]), "s": seq},
        )
    return ids


def _insert(conn, ids: dict[str, uuid.UUID], **over) -> uuid.UUID:
    row = {
        "id": uuid.uuid4(),
        "u": ids["user"],
        "e": ids["task"],
        "rule": "simple_later_wins",
        "type": "task",
        "key": None,
        "ordinal": 0,
        "undoes": None,
        **over,
    }
    conn.execute(
        text(
            "INSERT INTO sync_resolutions (id, user_id, entity_type, entity_id, rule, op_key,"
            " ordinal, undoes_id) VALUES (:id, :u, :type, :e, :rule, :key, :ordinal, :undoes)"
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
        assert conn.execute(text("SELECT count(*) FROM sync_resolutions")).scalar() == 0
        assert conn.execute(text("SELECT revision FROM tasks")).scalar() == 4
        assert conn.execute(text("SELECT revision FROM notes")).scalar() == 7
        assert conn.execute(text("SELECT count(*) FROM change_log")).scalar() == 3
        assert conn.execute(text("SELECT change_seq FROM users")).scalar() == 3
        # the new table works against the migrated data
        res = _insert(conn, ids)
        assert conn.execute(text("SELECT ordinal FROM sync_resolutions")).scalar() == 0
        # deleting the user cascades
        conn.execute(text("DELETE FROM users WHERE id = :u"), {"u": ids["user"]})
        assert conn.execute(text("SELECT count(*) FROM sync_resolutions")).scalar() == 0
        assert res


def test_the_constraints_hold(db) -> None:
    with db.begin() as conn:
        ids = _populate(conn)
        first = _insert(conn, ids, key="k", ordinal=0)
        _insert(conn, ids, key="k", ordinal=1)  # same key, next position: fine
        _insert(conn, ids, key=None)
        _insert(conn, ids, key=None)  # no key: no uniqueness
    for bad in (
        {"rule": "last_writer_wins"},  # not a rule
        {"type": "reminder"},  # not an entity type
        {"key": "k", "ordinal": 0},  # the same request logged twice
    ):
        with pytest.raises(IntegrityError), db.begin() as conn:
            _insert(conn, ids, **bad)
    with db.begin() as conn:
        undo = _insert(conn, ids, rule="undo", undoes=first)
    with pytest.raises(IntegrityError), db.begin() as conn:
        _insert(conn, ids, rule="undo", undoes=first)  # one undo entry per resolution
    with db.begin() as conn:
        conn.execute(text("DELETE FROM sync_resolutions WHERE id = :i"), {"i": first})
        assert (
            conn.execute(
                text("SELECT undoes_id FROM sync_resolutions WHERE id = :i"), {"i": undo}
            ).scalar()
            is None
        ), "purging the original keeps the undo entry"


def test_downgrade_drops_the_table_and_its_feed_rows_and_keeps_the_entities(db) -> None:
    with db.begin() as conn:
        ids = _populate(conn)
        _insert(conn, ids)
        conn.execute(
            text(
                "INSERT INTO change_log (user_id, entity_type, entity_id, operation, seq)"
                " VALUES (:u, 'resolution', :e, 'upsert', 4)"
            ),
            {"u": ids["user"], "e": str(uuid.uuid4())},
        )
    downgrade(PREVIOUS)
    with db.connect() as conn:
        assert not _exists(conn)
        kinds = {r[0] for r in conn.execute(text("SELECT entity_type FROM change_log"))}
        assert kinds == {"task", "project", "note"}
        assert conn.execute(text("SELECT count(*) FROM tasks")).scalar() == 1
        assert conn.execute(text("SELECT count(*) FROM notes")).scalar() == 1
    upgrade("head")
    upgrade("head")  # idempotent at head
    with db.connect() as conn:
        assert _exists(conn)
        assert conn.execute(text("SELECT count(*) FROM sync_resolutions")).scalar() == 0
