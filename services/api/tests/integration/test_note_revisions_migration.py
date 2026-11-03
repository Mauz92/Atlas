"""The ``note_revisions`` migration against a real PostgreSQL (SYNC-04).

Synchronous (Alembic's env.py starts its own event loop); leaves the schema at ``head``.
"""

from __future__ import annotations

import os
import uuid

import pytest
from sqlalchemy import create_engine, text

from atlas.migrations import downgrade, upgrade

PREVIOUS = "d5e8a2f1c4b9"


@pytest.fixture
def db():
    upgrade("head")
    engine = create_engine(os.environ["DATABASE_URL"])
    yield engine
    upgrade("head")
    with engine.begin() as conn:
        conn.execute(text("TRUNCATE users CASCADE"))
    engine.dispose()


def _table_exists(conn) -> bool:
    return bool(
        conn.execute(text("SELECT to_regclass('public.note_revisions') IS NOT NULL")).scalar()
    )


def test_upgrade_adds_the_table_and_leaves_existing_notes_untouched(db) -> None:
    downgrade(PREVIOUS)
    user, note = uuid.uuid4(), uuid.uuid4()
    with db.begin() as conn:
        conn.execute(text("TRUNCATE users CASCADE"))
        conn.execute(
            text(
                "INSERT INTO users (id, email, display_name, password_hash)"
                " VALUES (:u, 'm@x', 'M', 'x')"
            ),
            {"u": user},
        )
        conn.execute(
            text(
                "INSERT INTO notes (id, user_id, path, title, content_hash, revision)"
                " VALUES (:n, :u, 'a.md', 'a', 'h', 7)"
            ),
            {"n": note, "u": user},
        )
        assert not _table_exists(conn)
    upgrade("head")
    with db.begin() as conn:
        assert _table_exists(conn)
        assert conn.execute(text("SELECT count(*) FROM note_revisions")).scalar() == 0
        assert (
            conn.execute(text("SELECT revision FROM notes WHERE id = :n"), {"n": note}).scalar()
            == 7
        )
        # a row refers to its note and user; deleting the note cascades
        conn.execute(
            text(
                "INSERT INTO note_revisions"
                " (note_id, revision, user_id, content_hash, path, reason)"
                " VALUES (:n, 7, :u, 'h', 'a.md', 'legacy')"
            ),
            {"n": note, "u": user},
        )
        conn.execute(text("DELETE FROM notes WHERE id = :n"), {"n": note})
        assert conn.execute(text("SELECT count(*) FROM note_revisions")).scalar() == 0


def test_downgrade_and_upgrade_round_trip(db) -> None:
    downgrade(PREVIOUS)
    with db.connect() as conn:
        assert not _table_exists(conn)
    upgrade("head")
    upgrade("head")  # idempotent at head
    with db.connect() as conn:
        assert _table_exists(conn)
