"""The ``field_revisions`` migration against a real PostgreSQL (SYNC-03a).

Runs the real Alembic revisions on the test database: step back to the revision before the
column, write representative rows (several revisions, a tombstone, a project-filed task), upgrade,
and check the backfill; check it is idempotent and that the downgrade/upgrade round trip keeps
every other column. Synchronous on purpose: Alembic's env.py starts its own event loop. It leaves
the schema at ``head`` and the tables empty.
"""

from __future__ import annotations

import importlib.util
import os
import uuid
from pathlib import Path

import pytest
from sqlalchemy import create_engine, text

from atlas.migrations import downgrade, upgrade
from atlas.sync.fields import PROJECT_FIELDS, TASK_FIELDS

PREVIOUS = "b7d3e1a95c24"


_ENGINES: list = []


def _engine():
    """One engine per test run, disposed by the ``populated`` fixture (no leaked connections)."""
    if not _ENGINES:
        _ENGINES.append(create_engine(os.environ["DATABASE_URL"]))
    return _ENGINES[0]


def _migration_module():
    path = Path(__file__).resolve().parents[2] / "alembic/versions/a1f0c3d2b4e6_field_revisions.py"
    spec = importlib.util.spec_from_file_location("field_revisions_migration", path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture
def populated():
    """Schema at the previous revision with rows written the old way."""
    downgrade(PREVIOUS)
    user, project, task, deleted = (uuid.uuid4() for _ in range(4))
    with _engine().begin() as conn:
        conn.execute(text("TRUNCATE users CASCADE"))
        conn.execute(
            text(
                "INSERT INTO users (id, email, display_name, password_hash) "
                "VALUES (:u, 'm@example.com', 'M', 'x')"
            ),
            {"u": user},
        )
        conn.execute(
            text("INSERT INTO projects (id, user_id, name, revision) VALUES (:p, :u, 'P', 5)"),
            {"p": project, "u": user},
        )
        conn.execute(
            text(
                "INSERT INTO tasks (id, user_id, title, project_id, revision) "
                "VALUES (:t, :u, 'T', :p, 7)"
            ),
            {"t": task, "u": user, "p": project},
        )
        conn.execute(
            text(
                "INSERT INTO tasks (id, user_id, title, revision, deleted_at) "
                "VALUES (:t, :u, 'D', 3, now())"
            ),
            {"t": deleted, "u": user},
        )
    yield {"user": user, "project": project, "task": task, "deleted": deleted}
    upgrade("head")
    with _engine().begin() as conn:
        conn.execute(text("TRUNCATE users CASCADE"))
    _ENGINES.pop().dispose()


def _row(conn, table: str, key: uuid.UUID):
    return conn.execute(text(f"SELECT * FROM {table} WHERE id = :i"), {"i": key}).mappings().one()


def test_backfill_sets_every_field_to_the_current_revision(populated) -> None:
    upgrade("head")
    with _engine().connect() as conn:
        task = _row(conn, "tasks", populated["task"])
        deleted = _row(conn, "tasks", populated["deleted"])
        project = _row(conn, "projects", populated["project"])
        feed = conn.execute(text("SELECT count(*) FROM change_log")).scalar_one()
    assert task["field_revisions"] == dict.fromkeys(TASK_FIELDS, 7)
    assert deleted["field_revisions"] == dict.fromkeys(TASK_FIELDS, 3)
    assert project["field_revisions"] == dict.fromkeys(PROJECT_FIELDS, 5)
    # nothing else moved: no revision bump, the title is intact, and no feed row was written
    assert (
        task["revision"] == 7
        and task["title"] == "T"
        and task["project_id"] == populated["project"]
    )
    assert deleted["deleted_at"] is not None
    assert feed == 0


def test_backfill_is_idempotent_and_never_overwrites_real_stamps(populated) -> None:
    upgrade("head")
    module = _migration_module()
    with _engine().begin() as conn:
        conn.execute(
            text("UPDATE tasks SET field_revisions = '{\"title\": 2}'::jsonb WHERE id = :i"),
            {"i": populated["task"]},
        )
        conn.execute(
            text("UPDATE tasks SET field_revisions = '{}'::jsonb WHERE id = :i"),
            {"i": populated["deleted"]},
        )
        conn.execute(text(module._backfill("tasks", module._TASK_FIELDS)))
        conn.execute(text(module._backfill("tasks", module._TASK_FIELDS)))  # twice
    with _engine().connect() as conn:
        task = _row(conn, "tasks", populated["task"])
        deleted = _row(conn, "tasks", populated["deleted"])
    assert task["field_revisions"] == {"title": 2}, "a row with stamps is left alone"
    assert deleted["field_revisions"] == dict.fromkeys(TASK_FIELDS, 3), "an empty one is filled"


def test_the_round_trip_keeps_every_other_column(populated) -> None:
    upgrade("head")
    downgrade(PREVIOUS)
    with _engine().connect() as conn:
        columns = {
            r[0]
            for r in conn.execute(
                text(
                    "SELECT column_name FROM information_schema.columns "
                    "WHERE table_name IN ('tasks','projects')"
                )
            )
        }
        task = _row(conn, "tasks", populated["task"])
    assert "field_revisions" not in columns
    assert task["title"] == "T" and task["revision"] == 7
    upgrade("head")
    with _engine().connect() as conn:
        assert _row(conn, "tasks", populated["task"])["field_revisions"]["title"] == 7
