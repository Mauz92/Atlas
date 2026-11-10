"""Projection/cursor schema (M5-06) against ``DATA_MODEL.md`` §2.4.

No database needed: these inspect the ORM metadata and render the Alembic migrations to SQL offline.
The DB-backed equivalents (migration/model agreement via ``test_migrations_match_models`` and the
constraint behaviour) live in ``tests/integration/test_calendar_projection_schema.py``.
"""

from __future__ import annotations

from io import StringIO
from pathlib import Path

from alembic import command
from alembic.config import Config
from sqlalchemy import Table

from atlas.db import Base
from atlas.models import ExternalEvent, SyncCursor

API_ROOT = Path(__file__).resolve().parents[2]

EXTERNAL_EVENT_COLUMNS = {
    "id",
    "user_id",
    "provider",
    "external_event_id",
    "calendar_id",
    "summary",
    "start_at",
    "end_at",
    "time_zone",
    "is_all_day",
    "status",
    "etag",
    "ical_uid",
    "recurrence_id",
    "recurrence_rule",
    "source_updated_at",
    "last_synced_at",
    "deleted_at",
    "location",
    "description",
    "web_link",
    "series_id",
    "created_at",
    "updated_at",
}

SYNC_CURSOR_COLUMNS = {
    "id",
    "user_id",
    "provider",
    "calendar_id",
    "cursor_type",
    "cursor_value",
    "sync_started_at",
    "last_success_at",
    "last_error",
    "last_error_at",
    "created_at",
    "updated_at",
}


def _table(model: type) -> Table:
    return Base.metadata.tables[model.__tablename__]


def _foreign_keys(table: Table, column: str) -> set[tuple[str, str | None]]:
    return {(fk.target_fullname, fk.ondelete) for fk in table.columns[column].foreign_keys}


def _unique_constraints(table: Table) -> set[tuple[str, ...]]:
    return {
        tuple(sorted(column.name for column in constraint.columns))
        for constraint in table.constraints
        if constraint.__class__.__name__ == "UniqueConstraint"
    }


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


# --- the models ------------------------------------------------------------


def test_external_event_table_has_the_documented_columns() -> None:
    assert set(_table(ExternalEvent).columns.keys()) == EXTERNAL_EVENT_COLUMNS


def test_sync_cursor_table_has_the_documented_columns() -> None:
    assert set(_table(SyncCursor).columns.keys()) == SYNC_CURSOR_COLUMNS


def test_required_columns_are_not_nullable() -> None:
    table = _table(ExternalEvent)
    for name in (
        "id",
        "user_id",
        "provider",
        "external_event_id",
        "calendar_id",
        "start_at",
        "end_at",
        "time_zone",
        "is_all_day",
        "status",
        "source_updated_at",
        "last_synced_at",
    ):
        assert table.columns[name].nullable is False, name
    for name in ("summary", "etag", "ical_uid", "recurrence_id", "recurrence_rule", "deleted_at"):
        assert table.columns[name].nullable is True, name


def test_cursor_value_is_nullable_because_a_row_can_record_an_error_first() -> None:
    table = _table(SyncCursor)
    for name in ("id", "user_id", "provider", "calendar_id", "cursor_type"):
        assert table.columns[name].nullable is False, name
    for name in (
        "cursor_value",
        "sync_started_at",
        "last_success_at",
        "last_error",
        "last_error_at",
    ):
        assert table.columns[name].nullable is True, name


def test_a_projection_is_unique_per_user_provider_and_event() -> None:
    assert _unique_constraints(_table(ExternalEvent)) == {
        ("external_event_id", "provider", "user_id")
    }


def test_a_cursor_is_unique_per_user_provider_and_calendar() -> None:
    assert _unique_constraints(_table(SyncCursor)) == {("calendar_id", "provider", "user_id")}


def test_the_user_foreign_keys_cascade() -> None:
    assert _foreign_keys(_table(ExternalEvent), "user_id") == {("users.id", "CASCADE")}
    assert _foreign_keys(_table(SyncCursor), "user_id") == {("users.id", "CASCADE")}


# --- the migration ---------------------------------------------------------


def test_migration_renders_the_projection_schema() -> None:
    sql = _offline_sql("upgrade")
    assert "CREATE TABLE external_events" in sql
    for column in EXTERNAL_EVENT_COLUMNS:
        assert column in sql, column
    for name in (
        "pk_external_events",
        "fk_external_events_user_id_users",
        "uq_external_events_user_provider_external_event_id",
        "ON DELETE CASCADE",
    ):
        assert name in sql, name


def test_migration_renders_the_cursor_schema() -> None:
    sql = _offline_sql("upgrade")
    assert "CREATE TABLE sync_cursors" in sql
    for column in SYNC_CURSOR_COLUMNS:
        assert column in sql, column
    for name in (
        "pk_sync_cursors",
        "fk_sync_cursors_user_id_users",
        "uq_sync_cursors_user_provider_calendar",
    ):
        assert name in sql, name


def test_migration_is_reversible() -> None:
    sql = _offline_sql("downgrade")
    assert "DROP TABLE sync_cursors" in sql
    assert "DROP TABLE external_events" in sql


def test_the_running_marker_migration_adds_and_drops_the_column() -> None:
    # M5-10 added one column to ``sync_cursors`` via a versioned, reversible migration.
    upgrade = _offline_sql("upgrade")
    assert "ADD COLUMN sync_started_at" in upgrade
    downgrade = _offline_sql("downgrade")
    assert "DROP COLUMN sync_started_at" in downgrade
