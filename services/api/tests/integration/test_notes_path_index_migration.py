"""The live-path unique index and its downgrade against a real PostgreSQL (SYNC-03c, D3).

Synchronous (Alembic's env.py starts its own event loop); leaves the schema at ``head`` with empty
tables.
"""

from __future__ import annotations

import os
import uuid

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.exc import IntegrityError

from atlas.migrations import downgrade, upgrade

PREVIOUS = "c3b7d9e1f2a8"


@pytest.fixture
def db():
    upgrade("head")
    engine = create_engine(os.environ["DATABASE_URL"])
    user = uuid.uuid4()
    with engine.begin() as conn:
        conn.execute(text("TRUNCATE users CASCADE"))
        conn.execute(
            text(
                "INSERT INTO users (id, email, display_name, password_hash) "
                "VALUES (:u, 'n@example.com', 'N', 'x')"
            ),
            {"u": user},
        )
    yield engine, user
    upgrade("head")
    with engine.begin() as conn:
        conn.execute(text("TRUNCATE users CASCADE"))
    engine.dispose()


def _note(conn, user, path, *, deleted: bool) -> uuid.UUID:
    note_id = uuid.uuid4()
    conn.execute(
        text(
            "INSERT INTO notes (id, user_id, path, title, content_hash, deleted_at) "
            "VALUES (:i, :u, :p, 't', 'h', CASE WHEN :d THEN now() END)"
        ),
        {"i": note_id, "u": user, "p": path, "d": deleted},
    )
    return note_id


def test_only_live_notes_must_have_unique_paths(db) -> None:
    engine, user = db
    with engine.begin() as conn:
        _note(conn, user, "a.md", deleted=True)
        _note(conn, user, "a.md", deleted=True)
        _note(conn, user, "a.md", deleted=False)
    with pytest.raises(IntegrityError), engine.begin() as conn:
        _note(conn, user, "a.md", deleted=False)


def test_the_downgrade_keeps_the_live_note_and_renames_colliding_tombstones(db) -> None:
    engine, user = db
    with engine.begin() as conn:
        dead_one = _note(conn, user, "a.md", deleted=True)
        dead_two = _note(conn, user, "a.md", deleted=True)
        live = _note(conn, user, "a.md", deleted=False)
        lone = _note(conn, user, "b.md", deleted=True)
    downgrade(PREVIOUS)
    with engine.connect() as conn:
        paths = dict(conn.execute(text("SELECT id, path FROM notes")).all())
        constraint = conn.execute(
            text("SELECT 1 FROM pg_constraint WHERE conname = 'uq_notes_user_id_path'")
        ).scalar()
    assert constraint == 1
    assert paths[live] == "a.md" and paths[lone] == "b.md", "nothing else is touched"
    assert paths[dead_one] == f"a.md [deleted {dead_one}]"
    assert paths[dead_two] == f"a.md [deleted {dead_two}]"
    upgrade("head")
    with engine.connect() as conn:
        assert conn.execute(text("SELECT count(*) FROM notes")).scalar() == 4
