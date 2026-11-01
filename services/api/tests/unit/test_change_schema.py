"""Change feed schema (M7-01) against ``DATA_MODEL.md`` §2.5.

No database is needed: these checks inspect the ORM metadata and render the Alembic migrations to
SQL in offline mode. The DB-backed equivalents (migration/model agreement via
``test_migrations_match_models`` and the counter's monotonic behaviour) live in
``tests/integration/test_change_log_schema.py``.
"""

from __future__ import annotations

from io import StringIO
from pathlib import Path

from alembic import command
from alembic.config import Config
from sqlalchemy import BigInteger, Table, UniqueConstraint

from atlas.db import Base
from atlas.models import ChangeLog, User

API_ROOT = Path(__file__).resolve().parents[2]

CHANGE_LOG_COLUMNS = {"user_id", "entity_type", "entity_id", "operation", "seq", "changed_at"}


def _table(model: type) -> Table:
    return Base.metadata.tables[model.__tablename__]  # type: ignore[attr-defined]


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


def test_change_log_table_has_the_documented_columns() -> None:
    assert set(_table(ChangeLog).columns.keys()) == CHANGE_LOG_COLUMNS


def test_the_change_log_columns_are_not_nullable() -> None:
    table = _table(ChangeLog)
    for name in CHANGE_LOG_COLUMNS:
        assert table.columns[name].nullable is False, name
    assert table.columns["changed_at"].server_default is not None


def test_the_entity_is_unique_per_user_via_the_composite_primary_key() -> None:
    assert [column.name for column in _table(ChangeLog).primary_key.columns] == [
        "user_id",
        "entity_type",
        "entity_id",
    ]


def test_the_cursor_is_unique_per_user() -> None:
    unique = {
        constraint.name: [column.name for column in constraint.columns]
        for constraint in _table(ChangeLog).constraints
        if isinstance(constraint, UniqueConstraint)
    }
    assert unique == {"uq_change_log_user_id_seq": ["user_id", "seq"]}


def test_the_user_foreign_key_cascades() -> None:
    table = _table(ChangeLog)
    assert {(fk.target_fullname, fk.ondelete) for fk in table.columns["user_id"].foreign_keys} == {
        ("users.id", "CASCADE")
    }


def test_the_seq_is_a_64_bit_integer() -> None:
    assert isinstance(_table(ChangeLog).columns["seq"].type, BigInteger)


def test_the_user_row_carries_the_monotonic_counter() -> None:
    column = _table(User).columns["change_seq"]
    assert isinstance(column.type, BigInteger)
    assert column.nullable is False
    assert column.server_default is not None


def test_migration_renders_the_change_log_and_the_counter() -> None:
    sql = _offline_sql("upgrade")
    assert "CREATE TABLE change_log" in sql
    for column in CHANGE_LOG_COLUMNS:
        assert column in sql, column
    for name in (
        "pk_change_log",
        "fk_change_log_user_id_users",
        "uq_change_log_user_id_seq",
        "ON DELETE CASCADE",
        "change_seq",
    ):
        assert name in sql, name


def test_migration_is_reversible() -> None:
    sql = _offline_sql("downgrade")
    assert "DROP TABLE change_log" in sql
    assert "DROP COLUMN change_seq" in sql
