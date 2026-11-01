"""Reminder schema (M8-01) against ``DATA_MODEL.md`` §2.6.

No database is needed: these checks inspect the ORM metadata and render the Alembic migration to
SQL in offline mode. The DB-backed equivalents (migration/model agreement via
``test_migrations_match_models`` and the actual scheduling behaviour) live in
``tests/integration/test_reminders.py``.
"""

from __future__ import annotations

from io import StringIO
from pathlib import Path

from alembic import command
from alembic.config import Config
from sqlalchemy import Table, Time, UniqueConstraint

from atlas.db import Base
from atlas.models import Reminder, ReminderDelivery, ReminderPolicy, Task

API_ROOT = Path(__file__).resolve().parents[2]

POLICY_COLUMNS = {
    "id",
    "user_id",
    "name",
    "days_before",
    "at_time",
    "is_default",
    "created_at",
    "updated_at",
}
REMINDER_COLUMNS = {
    "id",
    "user_id",
    "policy_id",
    "entity_type",
    "entity_id",
    "remind_at",
    "status",
    "attempts",
    "last_attempt_at",
    "created_at",
    "updated_at",
}
DELIVERY_COLUMNS = {
    "id",
    "reminder_id",
    "channel",
    "delivered_at",
    "detail",
    "created_at",
    "updated_at",
}


def _table(model: type) -> Table:
    return Base.metadata.tables[model.__tablename__]  # type: ignore[attr-defined]


def _uniques(table: Table) -> dict[str | None, list[str]]:
    return {
        constraint.name: [column.name for column in constraint.columns]
        for constraint in table.constraints
        if isinstance(constraint, UniqueConstraint)
    }


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


def test_the_three_tables_have_the_documented_columns() -> None:
    assert set(_table(ReminderPolicy).columns.keys()) == POLICY_COLUMNS
    assert set(_table(Reminder).columns.keys()) == REMINDER_COLUMNS
    assert set(_table(ReminderDelivery).columns.keys()) == DELIVERY_COLUMNS


def test_the_policy_is_unique_per_user_and_name() -> None:
    assert _uniques(_table(ReminderPolicy)) == {
        "uq_reminder_policies_user_id_name": ["user_id", "name"]
    }


def test_the_policy_carries_a_local_time_of_day() -> None:
    at_time = _table(ReminderPolicy).columns["at_time"]
    assert isinstance(at_time.type, Time)
    assert at_time.nullable is False
    assert _table(ReminderPolicy).columns["days_before"].nullable is False


def test_the_policy_can_be_the_single_per_user_default() -> None:
    """M8-05: ``is_default`` is not-null, and a partial unique index keeps it to one per user."""
    assert _table(ReminderPolicy).columns["is_default"].nullable is False
    index_names = {index.name for index in _table(ReminderPolicy).indexes}
    assert "uq_reminder_policies_default" in index_names
    default_index = next(
        index
        for index in _table(ReminderPolicy).indexes
        if index.name == "uq_reminder_policies_default"
    )
    assert default_index.unique is True
    assert [column.name for column in default_index.columns] == ["user_id"]


def test_one_reminder_per_entity() -> None:
    assert _uniques(_table(Reminder)) == {
        "uq_reminders_entity_type_entity_id": ["entity_type", "entity_id"]
    }
    # The scan's "which reminders are due" query is indexed.
    assert "ix_reminders_due" in {index.name for index in _table(Reminder).indexes}


def test_the_reminder_references_its_user_and_policy() -> None:
    table = _table(Reminder)
    assert _foreign_keys(table, "user_id") == {("users.id", "CASCADE")}
    assert _foreign_keys(table, "policy_id") == {("reminder_policies.id", "SET NULL")}


def test_a_reminder_has_at_most_one_delivery_record() -> None:
    assert _uniques(_table(ReminderDelivery)) == {
        "uq_reminder_deliveries_reminder_id": ["reminder_id"]
    }
    assert _foreign_keys(_table(ReminderDelivery), "reminder_id") == {("reminders.id", "CASCADE")}


def test_the_task_references_its_reminder_policy() -> None:
    assert _foreign_keys(_table(Task), "reminder_policy_id") == {
        ("reminder_policies.id", "SET NULL")
    }


def test_migration_renders_the_reminder_schema() -> None:
    sql = _offline_sql("upgrade")
    for table in (
        "CREATE TABLE reminder_policies",
        "CREATE TABLE reminders",
        "CREATE TABLE reminder_deliveries",
    ):
        assert table in sql, table
    for name in (
        "pk_reminders",
        "fk_reminders_user_id_users",
        "fk_reminders_policy_id_reminder_policies",
        "uq_reminders_entity_type_entity_id",
        "ix_reminders_due",
        "uq_reminder_deliveries_reminder_id",
        "fk_tasks_reminder_policy_id_reminder_policies",
    ):
        assert name in sql, name


def test_migration_is_reversible() -> None:
    sql = _offline_sql("downgrade")
    assert "DROP TABLE reminder_deliveries" in sql
    assert "DROP TABLE reminders" in sql
    assert "DROP TABLE reminder_policies" in sql
