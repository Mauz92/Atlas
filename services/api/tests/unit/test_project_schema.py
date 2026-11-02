"""Project schema (M4-01) against ``DATA_MODEL.md`` §2.3.

These checks need no database: they inspect the ORM metadata and render the Alembic migrations to
SQL in offline mode. The DB-backed equivalents (migration/model agreement and the
``ON DELETE SET NULL`` behaviour) live in ``tests/integration/test_projects_schema.py``.
"""

from __future__ import annotations

from io import StringIO
from pathlib import Path

from alembic import command
from alembic.config import Config
from sqlalchemy import Table

from atlas.db import Base
from atlas.models import Project, ProjectStatus, Task

API_ROOT = Path(__file__).resolve().parents[2]

PROJECT_COLUMNS = {
    "id",
    "user_id",
    "name",
    "description",
    "status",
    "start_date",
    "target_date",
    "revision",
    "deleted_at",
    "created_at",
    "updated_at",
}


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


def test_projects_table_has_the_documented_columns() -> None:
    assert set(_table(Project).columns.keys()) == PROJECT_COLUMNS


def test_required_project_columns_are_not_nullable() -> None:
    table = _table(Project)
    for name in ("id", "user_id", "name", "status", "revision", "created_at", "updated_at"):
        assert table.columns[name].nullable is False, name
    for name in ("description", "start_date", "target_date", "deleted_at"):
        assert table.columns[name].nullable is True, name


def test_project_status_default_and_revision() -> None:
    table = _table(Project)
    assert table.columns["status"].server_default.arg == "active"
    assert table.columns["revision"].server_default.arg == "1"


def test_project_status_enumeration() -> None:
    assert [status.value for status in ProjectStatus] == ["active", "completed", "archived"]


def test_project_foreign_keys_and_indexes() -> None:
    table = _table(Project)
    assert _foreign_keys(table, "user_id") == {("users.id", "CASCADE")}
    assert {index.name for index in table.indexes} == {
        "ix_projects_search_fts",
        "ix_projects_status",
        "ix_projects_user_id",
    }


def test_tasks_project_id_references_projects() -> None:
    """``tasks.project_id`` is a real foreign key with the documented ON DELETE behaviour."""
    assert _foreign_keys(_table(Task), "project_id") == {("projects.id", "SET NULL")}


def test_migration_renders_the_project_schema() -> None:
    sql = _offline_sql("upgrade")
    assert "CREATE TABLE projects" in sql
    for column in PROJECT_COLUMNS:
        assert column in sql, column
    for name in (
        "pk_projects",
        "fk_projects_user_id_users",
        "ix_projects_status",
        "ix_projects_user_id",
        "fk_tasks_project_id_projects",
        "ON DELETE SET NULL",
    ):
        assert name in sql, name


def test_migration_is_reversible() -> None:
    sql = _offline_sql("downgrade")
    assert "DROP TABLE projects" in sql
    assert "fk_tasks_project_id_projects" in sql
