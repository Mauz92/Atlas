"""Note↔project association schema (M4-05) against ``DATA_MODEL.md`` §2.2/§2.3.

These checks need no database: they inspect the ORM metadata and render the Alembic migrations to
SQL in offline mode. The DB-backed equivalents (migration/model agreement via
``test_migrations_match_models`` and the ``ON DELETE CASCADE`` behaviour) live in
``tests/integration/test_note_projects_schema.py``.
"""

from __future__ import annotations

from io import StringIO
from pathlib import Path

from alembic import command
from alembic.config import Config
from sqlalchemy import Table

from atlas.db import Base
from atlas.models import NoteProject

API_ROOT = Path(__file__).resolve().parents[2]

NOTE_PROJECT_COLUMNS = {"note_id", "project_id", "created_at"}


def _table(model: type) -> Table:
    return Base.metadata.tables[model.__tablename__]  # type: ignore[attr-defined]


def _foreign_keys(table: Table, column: str) -> set[tuple[str, str | None]]:
    return {(fk.target_fullname, fk.ondelete) for fk in table.columns[column].foreign_keys}


def _offline_sql(direction: str) -> str:
    config = Config(str(API_ROOT / "alembic.ini"))
    config.set_main_option("script_location", str(API_ROOT / "alembic"))
    buffer = StringIO()
    config.output_buffer = buffer
    config.stdout = buffer
    if direction == "upgrade":
        command.upgrade(config, "head", sql=True)
    else:
        command.downgrade(config, "head:base", sql=True)
    return buffer.getvalue()


def test_note_projects_table_has_the_documented_columns() -> None:
    assert set(_table(NoteProject).columns.keys()) == NOTE_PROJECT_COLUMNS


def test_the_association_columns_are_not_nullable() -> None:
    table = _table(NoteProject)
    for name in ("note_id", "project_id", "created_at"):
        assert table.columns[name].nullable is False, name
    assert table.columns["created_at"].server_default is not None


def test_the_pair_is_unique_via_the_composite_primary_key() -> None:
    """Uniqueness per ``(note_id, project_id)`` is the composite primary key (as ``task_links``)."""
    assert [column.name for column in _table(NoteProject).primary_key.columns] == [
        "note_id",
        "project_id",
    ]


def test_both_foreign_keys_cascade() -> None:
    table = _table(NoteProject)
    assert _foreign_keys(table, "note_id") == {("notes.id", "CASCADE")}
    assert _foreign_keys(table, "project_id") == {("projects.id", "CASCADE")}


def test_the_project_id_direction_is_indexed() -> None:
    """Listing a project's notes filters by ``project_id``, which the PK does not index."""
    assert {index.name for index in _table(NoteProject).indexes} == {"ix_note_projects_project_id"}


def test_the_association_references_the_note_id_not_its_path() -> None:
    """Rename survival is structural: there is no path column to go stale."""
    assert "path" not in _table(NoteProject).columns


def test_migration_renders_the_association() -> None:
    sql = _offline_sql("upgrade")
    assert "CREATE TABLE note_projects" in sql
    for column in NOTE_PROJECT_COLUMNS:
        assert column in sql, column
    for name in (
        "pk_note_projects",
        "fk_note_projects_note_id_notes",
        "fk_note_projects_project_id_projects",
        "ix_note_projects_project_id",
        "ON DELETE CASCADE",
    ):
        assert name in sql, name


def test_migration_is_reversible() -> None:
    sql = _offline_sql("downgrade")
    assert "DROP TABLE note_projects" in sql
    assert "ix_note_projects_project_id" in sql
