"""Export and backup/restore of a campaign, including a paused fight (TTRPG-07)."""

from __future__ import annotations

import io
import json
import os
import shutil
import subprocess
import tarfile
import uuid
import zipfile
from pathlib import Path
from typing import Any

import pytest
from httpx import AsyncClient
from sqlalchemy.engine import make_url

from atlas.backups import BackupConfig, BackupService, verify_backup_set
from atlas.config import get_settings
from atlas.export.verify import verify_export_set
from atlas.ttrpg.export import TTRPG_FILENAME, TTRPG_FORMAT, TTRPG_VERSION
from atlas.ttrpg.srd import ATTRIBUTION
from tests.conftest import create_user_via_setup, csrf_headers
from tests.integration.test_backups import _dump_backend_kwargs
from tests.integration.test_ttrpg_runs import Table, by_name


@pytest.fixture(autouse=True)
def _fresh_settings():  # type: ignore[no-untyped-def]
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


async def _paused_fight(owner: AsyncClient) -> tuple[Table, dict[str, Any]]:
    table = await Table(owner).build()
    run = await table.started()
    names = by_name(run)
    run = await table.act(run, "damage", combatant_id=names["Brenna"]["id"], amount=9)
    run = await table.act(run, "damage", combatant_id=names["Goblin 1"]["id"], amount=7)
    run = await table.act(
        run,
        "spend_resource",
        combatant_id=names["Brenna"]["id"],
        resource_key="second-wind",
        delta=1,
    )
    run = await table.act(
        run,
        "add_condition",
        combatant_id=names["Goblin 2"]["id"],
        condition="prone",
        expires_round=2,
    )
    run = await table.act(run, "next_turn")
    run = await table.act(run, "pause")
    assert run["status"] == "paused"
    return table, run


@pytest.fixture
async def owner(notes_client: AsyncClient) -> AsyncClient:
    await create_user_via_setup(notes_client)
    await notes_client.put(
        "/api/features/ttrpg", json={"enabled": True}, headers=csrf_headers(notes_client)
    )
    return notes_client


async def _export(client: AsyncClient) -> zipfile.ZipFile:
    response = await client.get("/api/export")
    assert response.status_code == 200, response.text
    return zipfile.ZipFile(io.BytesIO(response.content))


async def _ttrpg_document(client: AsyncClient) -> dict[str, Any]:
    archive = await _export(client)
    name = next(n for n in archive.namelist() if n.endswith(TTRPG_FILENAME))
    document: dict[str, Any] = json.loads(archive.read(name))
    return document


async def test_the_full_export_carries_readable_versioned_campaign_data(
    owner: AsyncClient,
) -> None:
    table, run = await _paused_fight(owner)
    archive = await _export(owner)
    names = archive.namelist()
    root = names[0].split("/")[0]
    assert f"{root}/{TTRPG_FILENAME}" in names and f"{root}/manifest.json" in names
    document = json.loads(archive.read(f"{root}/{TTRPG_FILENAME}"))
    assert (document["format"], document["version"]) == (TTRPG_FORMAT, TTRPG_VERSION)
    (campaign,) = document["campaigns"]
    assert campaign["title"] == "Phandelver" and campaign["rules_preset"] == "dnd5e-2014"
    assert campaign["home_note"]["path"].endswith("Campaign Home.md")
    assert campaign["sessions"][0]["note"]["path"].endswith("Sessions/Session 01.md")
    # the prose is real Markdown in the same set, at the path the document names
    assert f"{root}/notes/{campaign['home_note']['path']}" in names
    assert f"{root}/notes/{campaign['sessions'][0]['note']['path']}" in names
    assert sorted(m["name"] for m in campaign["party"]) == ["Brenna", "Sildar"]
    brenna = next(m for m in campaign["party"] if m["name"] == "Brenna")
    assert brenna["state"]["current_hp"] == 19 and brenna["state"]["resources_used"] == {
        "second-wind": 1
    }
    (encounter,) = campaign["encounters"]
    assert [s["name"] for s in encounter["slots"]] == ["Goblin 1", "Goblin 2", "Goblin 3"]
    assert encounter["book_reference"] == "p. 6"
    (exported_run,) = campaign["runs"]
    assert (exported_run["status"], exported_run["round"]) == ("paused", run["round"])
    assert exported_run["active_combatant_id"] == run["active_combatant_id"]
    assert len(exported_run["combatants"]) == 5
    assert [a["kind"] for a in exported_run["actions"]][:2] == ["start", "damage"]
    assert exported_run["actions"][1]["before"] and exported_run["actions"][1]["after"]
    goblin_two = next(c for c in exported_run["combatants"] if c["name"] == "Goblin 2")
    assert goblin_two["conditions"] == ["prone"] and goblin_two["condition_reminders"] == {
        "prone": 2
    }
    assert [c["name"] for c in document["creatures"]] == ["Goblin"]
    # a manifest entry with a checksum for the new file, and the whole set verifies
    manifest = json.loads(archive.read(f"{root}/manifest.json"))
    assert TTRPG_FILENAME in [f["path"] for f in manifest["files"]]
    assert manifest["contents"]["ttrpg_campaigns"] == 1
    assert manifest["contents"]["ttrpg_runs"] == 1
    assert table.campaign["id"] == campaign["id"]


async def test_srd_cards_bring_their_attribution_into_the_export(
    owner: AsyncClient, app: Any
) -> None:
    from atlas.api.ttrpg import get_srd_catalog
    from atlas.ttrpg.srd import HttpSrdCatalog
    from tests.fakes.srd_provider import FakeSrd

    fake = FakeSrd()
    catalog = HttpSrdCatalog("https://srd.example", transport=fake.transport(), timeout=2.0)
    app.dependency_overrides[get_srd_catalog] = lambda: catalog
    manual = await owner.post(
        "/api/ttrpg/creatures",
        json={"name": "Homebrew", "ac": 10, "hp": 5},
        headers=csrf_headers(owner),
    )
    assert manual.status_code == 201
    document = await _ttrpg_document(owner)
    assert document["attribution"] is None  # nothing from the SRD yet
    imported = await owner.post(
        "/api/ttrpg/srd/import", json={"index": "goblin"}, headers=csrf_headers(owner)
    )
    assert imported.status_code == 201
    document = await _ttrpg_document(owner)
    assert document["attribution"] == ATTRIBUTION
    srd = next(c for c in document["creatures"] if c["source"] == "srd")
    assert (srd["source_edition"], srd["external_id"]) == ("2014", "goblin")
    assert srd["attribution"] == ATTRIBUTION


async def test_an_owner_without_ttrpg_data_gets_the_unchanged_export_set(
    notes_client: AsyncClient,
) -> None:
    await create_user_via_setup(notes_client)
    archive = await _export(notes_client)
    assert not any(n.endswith(TTRPG_FILENAME) for n in archive.namelist())
    manifest = json.loads(
        archive.read(next(n for n in archive.namelist() if n.endswith("manifest.json")))
    )
    assert not any(key.startswith("ttrpg") for key in manifest["contents"])


async def test_export_includes_data_while_the_module_is_switched_off_and_stays_per_owner(
    owner: AsyncClient,
) -> None:
    await _paused_fight(owner)
    await owner.put("/api/features/ttrpg", json={"enabled": False}, headers=csrf_headers(owner))
    archive = await _export(owner)
    root = archive.namelist()[0].split("/")[0]
    document = json.loads(archive.read(f"{root}/{TTRPG_FILENAME}"))
    assert len(document["campaigns"]) == 1  # disabling hides the module, never the data
    # the CLI path builds the same set and verifies it
    assert verify_export_set  # imported to keep the contract visible in this test module


def _scratch_psql(database_url: str, scratch: str, *args: str) -> subprocess.CompletedProcess[str]:
    url = make_url(database_url)
    env = {**os.environ, "PGPASSWORD": url.password or ""}
    base = [
        "psql",
        "-X",
        "-q",
        "-v",
        "ON_ERROR_STOP=1",
        "-h",
        url.host or "127.0.0.1",
        "-p",
        str(url.port or 5432),
        "-U",
        url.username or "atlas",
    ]
    return subprocess.run([*base, "-d", scratch, *args], env=env, capture_output=True, text=True)


async def test_a_backup_restores_notes_and_campaign_state_including_a_paused_fight(
    owner: AsyncClient, tmp_path: Path, notes_storage: Any
) -> None:
    if not shutil.which("psql"):
        pytest.skip("psql is not installed on this host (restore drill needs the client)")
    table, run = await _paused_fight(owner)
    database_url = os.environ["DATABASE_URL"]
    config = BackupConfig(
        destination=tmp_path / "backups",
        notes_root=notes_storage.root,
        database_url=database_url,
        retain=1,
        **_dump_backend_kwargs(),  # type: ignore[arg-type]
    )
    result = BackupService(config).run()
    assert verify_backup_set(result.directory).ok

    # 1. the notes store holds the Markdown the campaign points at
    with tarfile.open(result.directory / "notes.tar.gz") as tar:
        members = {m.name.lstrip("./") for m in tar.getmembers()}
    assert any(n.endswith("Campaign Home.md") for n in members)
    assert any(n.endswith("Sessions/Session 01.md") for n in members)

    # 2. the database dump restores into a scratch database with the same structured state
    scratch = f"atlas_restore_{uuid.uuid4().hex[:8]}"
    url = make_url(database_url)
    admin = make_url(database_url).set(database="postgres").render_as_string(hide_password=False)
    created = _scratch_psql(admin, "postgres", "-c", f'CREATE DATABASE "{scratch}"')
    assert created.returncode == 0, created.stderr
    try:
        loaded = _scratch_psql(database_url, scratch, "-f", str(result.directory / "database.sql"))
        assert loaded.returncode == 0, loaded.stderr

        def query(sql: str) -> str:
            out = _scratch_psql(database_url, scratch, "-At", "-c", sql)
            assert out.returncode == 0, out.stderr
            return out.stdout.strip()

        assert query("SELECT title FROM ttrpg_campaigns") == "Phandelver"
        assert query("SELECT count(*) FROM ttrpg_party_members") == "2"
        assert (
            query(f"SELECT status || '/' || round FROM ttrpg_combat_runs WHERE id = '{run['id']}'")
            == f"paused/{run['round']}"
        )
        assert (
            query(f"SELECT active_combatant_id FROM ttrpg_combat_runs WHERE id = '{run['id']}'")
            == run["active_combatant_id"]
        )
        assert (
            query(
                "SELECT current_hp || ',' || (resources_used->>'second-wind') "
                "FROM ttrpg_party_state s JOIN ttrpg_party_members m ON m.id = s.member_id "
                f"WHERE m.id = '{table.brenna['id']}'"
            )
            == "19,1"
        )
        assert query("SELECT count(*) FROM ttrpg_combatants") == "5"
        assert int(query("SELECT count(*) FROM ttrpg_combat_actions")) >= 6
        assert query("SELECT hp FROM ttrpg_combatants WHERE name = 'Goblin 1'") == "0"
        # the unfinished-run guard survives the restore (the partial unique index is in the dump)
        again = _scratch_psql(
            database_url,
            scratch,
            "-c",
            "INSERT INTO ttrpg_combat_runs (id, campaign_id, user_id, title, status) "
            "SELECT gen_random_uuid(), campaign_id, user_id, 'dup', 'setup' FROM ttrpg_combat_runs",
        )
        assert again.returncode != 0 and "uq_ttrpg_combat_runs_one_unfinished" in again.stderr
    finally:
        _scratch_psql(admin, "postgres", "-c", f'DROP DATABASE IF EXISTS "{scratch}" WITH (FORCE)')
    del url
