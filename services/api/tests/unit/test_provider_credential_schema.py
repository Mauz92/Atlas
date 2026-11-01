"""Provider-credential schema (M5-01) against ``DATA_MODEL.md`` §2.1.

No database needed: these inspect the ORM metadata and render the Alembic migrations to SQL offline.
The DB-backed equivalents (migration/model agreement via ``test_migrations_match_models`` and the
constraint behaviour) live in ``tests/integration/test_provider_credentials_schema.py``.
"""

from __future__ import annotations

from io import StringIO
from pathlib import Path

from alembic import command
from alembic.config import Config
from sqlalchemy import Table

from atlas.db import Base
from atlas.models import ProviderCredential

API_ROOT = Path(__file__).resolve().parents[2]

CREDENTIAL_COLUMNS = {
    "id",
    "user_id",
    "provider",
    "key_id",
    "ciphertext",
    "scopes",
    "access_expires_at",
    "refresh_expires_at",
    "created_at",
    "updated_at",
}


def _table() -> Table:
    return Base.metadata.tables[ProviderCredential.__tablename__]


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


def test_credentials_table_has_the_documented_columns() -> None:
    assert set(_table().columns.keys()) == CREDENTIAL_COLUMNS


def test_required_columns_are_not_nullable() -> None:
    table = _table()
    for name in ("id", "user_id", "provider", "key_id", "ciphertext", "scopes"):
        assert table.columns[name].nullable is False, name
    for name in ("access_expires_at", "refresh_expires_at"):
        assert table.columns[name].nullable is True, name


def test_ciphertext_is_binary_and_scopes_is_an_array() -> None:
    table = _table()
    assert "ciphertext" in CREDENTIAL_COLUMNS
    assert table.columns["ciphertext"].type.__class__.__name__ == "LargeBinary"
    assert table.columns["scopes"].type.__class__.__name__ == "ARRAY"
    assert str(table.columns["scopes"].server_default.arg) == "'{}'::text[]"


def test_there_is_exactly_one_credential_per_user_and_provider() -> None:
    unique = {
        tuple(sorted(column.name for column in constraint.columns))
        for constraint in _table().constraints
        if constraint.__class__.__name__ == "UniqueConstraint"
    }
    assert unique == {("provider", "user_id")}


def test_the_user_id_foreign_key_cascades() -> None:
    assert _foreign_keys(_table(), "user_id") == {("users.id", "CASCADE")}


def test_migration_renders_the_credential_schema() -> None:
    sql = _offline_sql("upgrade")
    assert "CREATE TABLE provider_credentials" in sql
    for column in CREDENTIAL_COLUMNS:
        assert column in sql, column
    for name in (
        "pk_provider_credentials",
        "fk_provider_credentials_user_id_users",
        "uq_provider_credentials_user_provider",
        "ON DELETE CASCADE",
    ):
        assert name in sql, name


def test_migration_is_reversible() -> None:
    sql = _offline_sql("downgrade")
    assert "DROP TABLE provider_credentials" in sql
