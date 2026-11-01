"""Automated DB + Markdown backups (M9-01) against a real PostgreSQL and a temp notes dir.

Proves the acceptance criteria end to end: one backup set captures **both** stores with a manifest
and checksums; the integrity check passes on a good set and fails on a tampered or partial one; a
failed run is detectable and never published; retention prunes only within the destination; and the
durable job and the ``atlas-backup`` CLI both work. Needs a database (``_db``) and a usable
``pg_dump`` (a local client, or ``docker exec`` into the project's PostgreSQL container).
"""

from __future__ import annotations

import itertools
import json
import os
import shutil
import subprocess
import tarfile
from datetime import UTC, datetime, timedelta
from functools import lru_cache
from pathlib import Path
from types import SimpleNamespace

import pytest
from httpx import AsyncClient
from sqlalchemy import select

from atlas.backups import (
    BackupConfig,
    BackupService,
    cli,
    list_backup_sets,
    list_incomplete_sets,
    verify_backup_set,
)
from atlas.config import get_settings
from atlas.db import session_scope
from atlas.jobs import BACKUP_TASK, ensure_backup_job, queue, worker
from atlas.models import Job
from tests.conftest import create_user_via_setup, csrf_headers

pytestmark = pytest.mark.usefixtures("_db")


@pytest.fixture(autouse=True)
def _fresh_settings():
    """Keep the cached settings (and the env a test sets) from leaking between tests."""
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


@lru_cache(maxsize=1)
def _dump_backend_kwargs() -> dict[str, str]:
    """Pick a working ``pg_dump`` backend: a local client, else a running PostgreSQL container."""
    if shutil.which("pg_dump"):
        return {"pg_dump_binary": "pg_dump", "pg_dump_container": ""}
    candidates: list[str] = []
    configured = os.environ.get("BACKUP_PG_DUMP_CONTAINER")
    if configured:
        candidates.append(configured)
    try:
        listing = subprocess.run(
            ["docker", "ps", "--format", "{{.Names}}"],
            capture_output=True,
            text=True,
            check=True,
        ).stdout
        candidates += [line.strip() for line in listing.splitlines() if line.strip()]
    except (OSError, subprocess.SubprocessError):  # pragma: no cover - docker absent
        pass
    for name in candidates:
        probe = subprocess.run(
            ["docker", "exec", name, "pg_dump", "--version"],
            capture_output=True,
            text=True,
            check=False,
        )
        if probe.returncode == 0:
            return {"pg_dump_binary": "pg_dump", "pg_dump_container": name}
    pytest.skip("no usable pg_dump (no local client and no PostgreSQL container)")


@pytest.fixture
def backup_env(tmp_path: Path) -> SimpleNamespace:
    notes = tmp_path / "notes"
    notes.mkdir()
    destination = tmp_path / "backups"

    def make(**overrides: object) -> BackupConfig:
        kwargs: dict[str, object] = {
            "destination": destination,
            "notes_root": notes,
            "database_url": os.environ["DATABASE_URL"],
            "retain": 3,
            **_dump_backend_kwargs(),
        }
        kwargs.update(overrides)
        return BackupConfig(**kwargs)  # type: ignore[arg-type]

    return SimpleNamespace(notes=notes, destination=destination, make=make, root=tmp_path)


def _digests(set_dir: Path) -> dict[str, str | None]:
    return {part.name: part.actual_sha256 for part in verify_backup_set(set_dir).parts}


async def _auth(client: AsyncClient) -> dict[str, str]:
    await create_user_via_setup(client)
    return csrf_headers(client)


async def _create_task(client: AsyncClient, headers: dict[str, str], title: str) -> dict:
    response = await client.post("/api/tasks", json={"title": title}, headers=headers)
    assert response.status_code == 201, response.text
    return response.json()


# --- both stores are captured -------------------------------------------------


async def test_a_backup_captures_both_stores_with_a_verifiable_manifest(
    client: AsyncClient, backup_env: SimpleNamespace
) -> None:
    headers = await _auth(client)
    await _create_task(client, headers, title="Backup me 42")
    (backup_env.notes / "note.md").write_text("# Note\nmarker-42\n", encoding="utf-8")

    result = BackupService(backup_env.make()).run()

    verification = verify_backup_set(result.directory)
    assert verification.ok, verification.errors
    assert {part.name for part in verification.parts} == {"database", "notes"}
    assert all(part.ok for part in verification.parts)
    assert result.directory.name.startswith("atlas-backup-")

    # The PostgreSQL part really contains the committed row.
    dump = (result.directory / "database.sql").read_bytes()
    assert b"Backup me 42" in dump
    assert b"CREATE TABLE" in dump

    # The notes part really contains the file on disk.
    with tarfile.open(result.directory / "notes.tar.gz", "r:gz") as archive:
        names = archive.getnames()
    assert "note.md" in names
    assert result.notes_files == 1


async def test_the_manifest_records_provenance_and_a_timestamp(
    client: AsyncClient, backup_env: SimpleNamespace
) -> None:
    headers = await _auth(client)
    await _create_task(client, headers, title="Provenance")
    result = BackupService(backup_env.make()).run()

    manifest = json.loads((result.directory / "manifest.json").read_text(encoding="utf-8"))
    assert manifest["format"] == "atlas-backup"
    assert datetime.fromisoformat(manifest["created_at"]) == result.created_at
    assert manifest["parts"]["database"]["store"] == "postgresql"
    assert manifest["parts"]["notes"]["store"] == "markdown"
    assert manifest["parts"]["database"]["sha256"] == result.database_sha256


# --- the integrity check fails on tampered / partial sets ----------------------


async def test_a_tampered_set_fails_the_integrity_check(
    client: AsyncClient, backup_env: SimpleNamespace
) -> None:
    headers = await _auth(client)
    await _create_task(client, headers, title="Tamper target")
    result = BackupService(backup_env.make()).run()
    assert verify_backup_set(result.directory).ok

    dump = result.directory / "database.sql"
    dump.write_bytes(dump.read_bytes() + b"\n-- tampered\n")

    verification = verify_backup_set(result.directory)
    assert not verification.ok
    assert any("database" in error for error in verification.errors)
    # The CLI surfaces it too, with a non-zero exit code.
    assert cli.main(["verify", str(result.directory)]) == 1


async def test_a_missing_part_fails_the_integrity_check(
    client: AsyncClient, backup_env: SimpleNamespace
) -> None:
    headers = await _auth(client)
    await _create_task(client, headers, title="Partial target")
    result = BackupService(backup_env.make()).run()

    (result.directory / "notes.tar.gz").unlink()

    verification = verify_backup_set(result.directory)
    assert not verification.ok
    assert any("notes" in error for error in verification.errors)


async def test_a_failed_run_is_detectable_and_never_published(
    client: AsyncClient, backup_env: SimpleNamespace, monkeypatch: pytest.MonkeyPatch
) -> None:
    headers = await _auth(client)
    await _create_task(client, headers, title="Will not finish")
    config = backup_env.make()
    service = BackupService(config)

    def _boom(target: Path) -> int:
        msg = "simulated disk failure"
        raise RuntimeError(msg)

    monkeypatch.setattr(service, "_archive_notes", _boom)

    with pytest.raises(RuntimeError):
        service.run()

    # Nothing was published: no complete set exists ...
    assert list_backup_sets(config.destination) == []
    # ... and the leftover staging directory is reported as incomplete, so a partial run is visible.
    leftovers = list_incomplete_sets(config.destination)
    assert leftovers
    assert all(not verify_backup_set(entry).ok for entry in leftovers)


# --- idempotency, retention and confinement -----------------------------------


async def test_runs_are_repeatable_and_retention_keeps_the_newest(
    client: AsyncClient, backup_env: SimpleNamespace
) -> None:
    headers = await _auth(client)
    await _create_task(client, headers, title="Retention")
    config = backup_env.make(retain=2)
    base = datetime(2026, 10, 27, 12, 0, 0, tzinfo=UTC)
    ticks = itertools.count()
    service = BackupService(config, now=lambda: base + timedelta(seconds=next(ticks)))

    produced = [service.run().directory for _ in range(3)]

    published = list_backup_sets(config.destination)
    assert len(published) == 2  # the oldest of three was pruned
    assert produced[2] in published and produced[1] in published
    assert produced[0] not in published
    assert all(verify_backup_set(entry).ok for entry in published)

    # Repeated runs are safe: a set that survives retention is never mutated by a later run.
    newest = published[-1]
    before = _digests(newest)
    service.run()
    assert (config.destination / newest.name).is_dir()
    assert _digests(newest) == before

    # Nothing is written outside the destination.
    siblings = {path.name for path in backup_env.root.iterdir()}
    assert siblings <= {"notes", "backups"}


async def test_no_database_secret_reaches_the_manifest(
    client: AsyncClient, backup_env: SimpleNamespace
) -> None:
    headers = await _auth(client)
    await _create_task(client, headers, title="No secret")
    secret = "s3cr3t-db-password-xyz"
    config = backup_env.make(
        database_url=f"postgresql+psycopg://atlas:{secret}@127.0.0.1:5432/atlas_test"
    )
    result = BackupService(config).run()

    text = (result.directory / "manifest.json").read_text(encoding="utf-8")
    assert secret not in text
    assert "postgresql+psycopg" not in text
    assert "://" not in text
    assert "atlas_test" not in text


# --- the durable job ----------------------------------------------------------


async def test_the_backup_job_runs_on_the_durable_queue_and_reschedules(
    client: AsyncClient, backup_env: SimpleNamespace, monkeypatch: pytest.MonkeyPatch
) -> None:
    config = backup_env.make()
    monkeypatch.setenv("BACKUP_DIR", str(config.destination))
    monkeypatch.setenv("NOTES_ROOT", str(backup_env.notes))
    monkeypatch.setenv("BACKUP_RETAIN", "3")
    monkeypatch.setenv("BACKUP_PG_DUMP_CONTAINER", config.pg_dump_container)
    get_settings.cache_clear()
    (backup_env.notes / "queued.md").write_text("queued\n", encoding="utf-8")

    async with session_scope() as session:
        await ensure_backup_job(session)

    async with session_scope() as session:
        queued = (await session.scalars(select(Job).where(Job.task_name == BACKUP_TASK))).all()
        assert [job.status for job in queued] == ["pending"]

    assert await worker.run_once("worker-1") is True

    async with session_scope() as session:
        jobs = (
            await session.scalars(
                select(Job).where(Job.task_name == BACKUP_TASK).order_by(Job.created_at)
            )
        ).all()
    statuses = [job.status for job in jobs]
    assert "succeeded" in statuses
    pending = [job for job in jobs if job.status == "pending"]
    assert len(pending) == 1  # the chain re-scheduled itself
    assert pending[0].run_at > datetime.now(UTC)

    assert len(list_backup_sets(config.destination)) == 1


async def test_a_stale_running_backup_is_reaped_and_restarted() -> None:
    async with session_scope() as session:
        job = await queue.enqueue(session, BACKUP_TASK)
        job.status = "running"
        job.locked_by = "dead-worker"
        job.locked_at = datetime.now(UTC) - timedelta(hours=2)
        await session.flush()

    async with session_scope() as session:
        await ensure_backup_job(session)

    async with session_scope() as session:
        jobs = (await session.scalars(select(Job).where(Job.task_name == BACKUP_TASK))).all()
        assert sorted(job.status for job in jobs) == ["failed", "pending"]


# --- the CLI ------------------------------------------------------------------


async def test_the_cli_runs_lists_and_verifies(
    client: AsyncClient, backup_env: SimpleNamespace, monkeypatch: pytest.MonkeyPatch
) -> None:
    config = backup_env.make()
    monkeypatch.setenv("BACKUP_DIR", str(config.destination))
    monkeypatch.setenv("NOTES_ROOT", str(backup_env.notes))
    monkeypatch.setenv("BACKUP_PG_DUMP_CONTAINER", config.pg_dump_container)
    get_settings.cache_clear()
    (backup_env.notes / "cli.md").write_text("cli\n", encoding="utf-8")

    assert cli.main(["run"]) == 0
    sets = list_backup_sets(config.destination)
    assert len(sets) == 1
    assert cli.main(["verify", str(config.destination)]) == 0
    assert cli.main(["list", str(config.destination)]) == 0

    (sets[0] / "notes.tar.gz").write_bytes(b"garbage")
    assert cli.main(["verify", str(config.destination)]) == 1
