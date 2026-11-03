"""Task schema (M3-01) and idempotency table (M3-02) against ``DATA_MODEL.md``.

These checks need no database: they inspect the ORM metadata and render the Alembic
migrations to SQL in offline mode.
"""

from __future__ import annotations

from io import StringIO
from pathlib import Path

from alembic import command
from alembic.config import Config
from sqlalchemy import Table

from atlas.db import Base
from atlas.models import (
    RecurrenceSeries,
    Task,
    TaskLink,
    TaskPriority,
    TaskStatus,
    TaskTag,
)

API_ROOT = Path(__file__).resolve().parents[2]

TASK_COLUMNS = {
    "id",
    "user_id",
    "title",
    "description",
    "status",
    "priority",
    "project_id",
    "parent_task_id",
    "start_at",
    "due_at",
    "time_zone",
    "duration_minutes",
    "completed_at",
    "recurrence_rule",
    "recurrence_parent_id",
    "reminder_policy_id",
    "external_provider",
    "external_id",
    "revision",
    "field_revisions",
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


def test_tasks_table_has_the_documented_columns() -> None:
    assert set(_table(Task).columns.keys()) == TASK_COLUMNS


def test_required_task_columns_are_not_nullable() -> None:
    table = _table(Task)
    for name in ("id", "user_id", "title", "status", "priority", "revision", "created_at"):
        assert table.columns[name].nullable is False, name


def test_task_status_and_priority_defaults() -> None:
    table = _table(Task)
    assert table.columns["status"].server_default.arg == "inbox"
    assert table.columns["priority"].server_default.arg == "none"
    assert table.columns["revision"].server_default.arg == "1"


def test_task_status_and_priority_enumerations() -> None:
    assert [status.value for status in TaskStatus] == [
        "inbox",
        "next",
        "in_progress",
        "completed",
        "archived",
    ]
    assert [priority.value for priority in TaskPriority] == [
        "none",
        "low",
        "medium",
        "high",
        "urgent",
    ]


def test_task_foreign_keys_and_indexes() -> None:
    table = _table(Task)
    assert _foreign_keys(table, "user_id") == {("users.id", "CASCADE")}
    assert _foreign_keys(table, "parent_task_id") == {("tasks.id", "SET NULL")}
    assert _foreign_keys(table, "recurrence_parent_id") == {("tasks.id", "SET NULL")}
    assert {index.name for index in table.indexes} == {
        "ix_tasks_due_at",
        "ix_tasks_parent_task_id",
        "ix_tasks_priority",
        "ix_tasks_search_fts",
        "ix_tasks_status",
        "ix_tasks_user_id",
    }


def test_auxiliary_tables_reference_stable_ids() -> None:
    links = _table(TaskLink)
    assert set(links.columns.keys()) == {"task_id", "note_id", "created_at"}
    assert _foreign_keys(links, "task_id") == {("tasks.id", "CASCADE")}
    assert _foreign_keys(links, "note_id") == {("notes.id", "CASCADE")}
    assert {index.name for index in links.indexes} == {"ix_task_links_note_id"}  # MU-06

    tags = _table(TaskTag)
    assert set(tags.columns.keys()) == {"task_id", "tag_id"}
    assert _foreign_keys(tags, "task_id") == {("tasks.id", "CASCADE")}
    assert _foreign_keys(tags, "tag_id") == {("tags.id", "CASCADE")}

    series = _table(RecurrenceSeries)
    assert _foreign_keys(series, "recurrence_parent_id") == {("tasks.id", "SET NULL")}


def test_migration_renders_the_task_schema() -> None:
    sql = _offline_sql("upgrade")
    assert "CREATE TABLE tasks" in sql
    for column in TASK_COLUMNS:
        assert column in sql, column
    for name in (
        "pk_tasks",
        "fk_tasks_user_id_users",
        "fk_tasks_parent_task_id_tasks",
        "ix_tasks_status",
        "ix_tasks_user_id",
        "CREATE TABLE recurrence_series",
        "CREATE TABLE task_links",
        "CREATE TABLE task_tags",
    ):
        assert name in sql, name


def test_migration_is_reversible() -> None:
    sql = _offline_sql("downgrade")
    assert "DROP TABLE tasks" in sql
    assert "DROP TABLE recurrence_series" in sql
    assert "DROP TABLE task_links" in sql
    assert "DROP TABLE task_tags" in sql


def test_migration_adds_the_idempotency_table() -> None:
    upgrade_sql = _offline_sql("upgrade")
    assert "CREATE TABLE idempotency_keys" in upgrade_sql
    assert "uq_idempotency_keys_user_id" in upgrade_sql
    assert "fk_idempotency_keys_user_id_users" in upgrade_sql

    downgrade_sql = _offline_sql("downgrade")
    assert "DROP TABLE idempotency_keys" in downgrade_sql
