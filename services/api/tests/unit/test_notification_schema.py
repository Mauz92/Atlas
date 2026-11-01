"""Notification destination schema (M8-03) against ``DATA_MODEL.md``.

No database: these checks inspect the ORM metadata and render the Alembic migration to SQL in
offline mode. The DB-backed equivalents (migration/model agreement via ``compare_metadata`` and the
actual registry/invalidation behaviour) live in
``tests/integration/test_notification_registry.py``.
"""

from __future__ import annotations

from io import StringIO
from pathlib import Path

from alembic import command
from alembic.config import Config
from sqlalchemy import Table, UniqueConstraint

from atlas.db import Base
from atlas.models import NotificationDevice

API_ROOT = Path(__file__).resolve().parents[2]

DEVICE_COLUMNS = {
    "id",
    "user_id",
    "channel",
    "endpoint",
    "p256dh",
    "auth",
    "platform",
    "last_seen_at",
    "disabled_at",
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


def test_the_table_has_the_documented_columns() -> None:
    assert set(_table(NotificationDevice).columns.keys()) == DEVICE_COLUMNS


def test_a_destination_is_unique_per_user_channel_and_endpoint() -> None:
    assert _uniques(_table(NotificationDevice)) == {
        "uq_notification_devices_user_channel_endpoint": ["user_id", "channel", "endpoint"]
    }


def test_the_endpoint_and_web_keys_are_not_nullable_optionality_mismatch() -> None:
    table = _table(NotificationDevice)
    assert table.columns["channel"].nullable is False
    assert table.columns["endpoint"].nullable is False
    assert table.columns["user_id"].nullable is False
    # The Web Push keys and the platform hint are optional (a native token carries neither).
    assert table.columns["p256dh"].nullable is True
    assert table.columns["auth"].nullable is True
    assert table.columns["platform"].nullable is True


def test_the_destination_belongs_to_a_user_and_cascades_on_delete() -> None:
    assert _foreign_keys(_table(NotificationDevice), "user_id") == {("users.id", "CASCADE")}


def test_migration_renders_the_registry_schema() -> None:
    sql = _offline_sql("upgrade")
    assert "CREATE TABLE notification_devices" in sql
    for name in (
        "pk_notification_devices",
        "fk_notification_devices_user_id_users",
        "uq_notification_devices_user_channel_endpoint",
    ):
        assert name in sql, name


def test_migration_is_reversible() -> None:
    sql = _offline_sql("downgrade")
    assert "DROP TABLE notification_devices" in sql
