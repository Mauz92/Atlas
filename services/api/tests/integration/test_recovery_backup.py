"""A backup holds the recovery code's salt and hash and never the code (AUTH-01, ADR-0067).

Uses the same real ``pg_dump`` as the backup tests (a local client or the PostgreSQL container).
"""

from __future__ import annotations

from pathlib import Path

import pytest
from httpx import AsyncClient
from sqlalchemy import select

from atlas.auth.recovery import normalize_code
from atlas.backups import BackupConfig, BackupService
from atlas.db import session_scope
from atlas.models import RecoveryCode
from tests.integration.test_backups import _dump_backend_kwargs
from tests.integration.test_recovery import setup_owner

pytestmark = pytest.mark.usefixtures("_db")


async def test_the_database_dump_contains_only_the_hash_of_the_code(
    client: AsyncClient, tmp_path: Path
) -> None:
    code = await setup_owner(client)
    plain = normalize_code(code)
    assert plain
    notes = tmp_path / "notes"
    notes.mkdir()
    import os

    config = BackupConfig(
        destination=tmp_path / "backups",
        notes_root=notes,
        database_url=os.environ["DATABASE_URL"],
        retain=1,
        **_dump_backend_kwargs(),  # type: ignore[arg-type]
    )
    result = BackupService(config).run()
    dump = (result.directory / "database.sql").read_text(encoding="utf-8")
    async with session_scope() as session:
        row = (await session.execute(select(RecoveryCode))).scalar_one()
    assert "recovery_codes" in dump
    assert row.code_hash in dump and row.code_salt in dump  # what a restore needs
    assert code not in dump and plain not in dump and plain.lower() not in dump.lower()
    manifest = (result.directory / "manifest.json").read_text(encoding="utf-8")
    assert plain not in manifest and row.code_hash not in manifest
