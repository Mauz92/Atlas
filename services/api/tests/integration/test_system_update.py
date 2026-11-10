"""The web app's side of updating the server (REL-01, ADR-0074).

The API reads status.json and writes request.json; the host updater (deploy/updater) does the rest.
These tests pin what the API will and will not ask the host to do.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi import FastAPI
from httpx import AsyncClient

from atlas.config import get_settings
from tests.conftest import create_user_via_setup, csrf_headers
from tests.integration.test_devices import EMAIL, PASSWORD, bearer, new_client, sign_in

pytestmark = pytest.mark.usefixtures("_db")


@pytest.fixture
async def c(notes_client: AsyncClient) -> AsyncClient:
    await create_user_via_setup(notes_client, email=EMAIL, password=PASSWORD)
    return notes_client


@pytest.fixture
def update_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    directory = tmp_path / "update"
    directory.mkdir()
    monkeypatch.setenv("UPDATE_DIR", str(directory))
    get_settings.cache_clear()
    yield directory
    get_settings.cache_clear()


def write_status(directory: Path, **fields: object) -> None:
    (directory / "status.json").write_text(json.dumps({"schema": 1, "state": "idle", **fields}))


async def test_not_configured_says_so_and_refuses_requests(c: AsyncClient) -> None:
    body = (await c.get("/api/system/update")).json()
    assert body["configured"] is False
    assert (await c.post("/api/system/update/check", headers=csrf_headers(c))).status_code == 409


async def test_status_is_read_from_the_host_file_and_sanitised(
    c: AsyncClient, update_dir: Path
) -> None:
    write_status(
        update_dir,
        latest="0.2.0",
        update_available=True,
        notes="n" * 9000,
        state="exploding",
        log=["a", 5, "b"],
    )
    body = (await c.get("/api/system/update")).json()
    assert body["configured"] is True
    assert body["latest_version"] == "0.2.0"
    assert body["update_available"] is True
    assert len(body["notes"]) == 4000
    assert body["state"] == "idle"  # an unknown state is not trusted
    assert body["log"] == ["a", "", "b"]


async def test_a_garbled_status_file_does_not_break_the_page(
    c: AsyncClient, update_dir: Path
) -> None:
    (update_dir / "status.json").write_text("{not json")
    assert (await c.get("/api/system/update")).status_code == 200


async def test_apply_writes_a_request_only_for_the_version_the_host_reported(
    c: AsyncClient, update_dir: Path
) -> None:
    write_status(update_dir, latest="0.2.0", update_available=True)
    wrong = await c.post(
        "/api/system/update/apply", json={"version": "9.9.9"}, headers=csrf_headers(c)
    )
    assert wrong.status_code == 409
    assert not (update_dir / "request.json").exists()

    ok = await c.post(
        "/api/system/update/apply", json={"version": "0.2.0"}, headers=csrf_headers(c)
    )
    assert ok.status_code == 202
    assert json.loads((update_dir / "request.json").read_text()) == {
        "action": "apply",
        "version": "0.2.0",
    }
    assert ok.json()["request_pending"] is True
    # a second request while one is waiting is refused
    again = await c.post(
        "/api/system/update/apply", json={"version": "0.2.0"}, headers=csrf_headers(c)
    )
    assert again.status_code == 409


async def test_nothing_is_accepted_while_an_update_runs(c: AsyncClient, update_dir: Path) -> None:
    write_status(update_dir, state="updating", latest="0.2.0", update_available=True)
    assert (await c.post("/api/system/update/check", headers=csrf_headers(c))).status_code == 409
    assert not (update_dir / "request.json").exists()


async def test_a_version_must_be_a_plain_release_number(c: AsyncClient, update_dir: Path) -> None:
    write_status(update_dir, latest="0.2.0", update_available=True)
    for bad in ("../../etc", "0.2.0; rm -rf /", "v0.2.0", "latest", ""):
        response = await c.post(
            "/api/system/update/apply", json={"version": bad}, headers=csrf_headers(c)
        )
        assert response.status_code == 422, bad


async def test_a_device_token_cannot_read_or_start_updates(app: FastAPI, c: AsyncClient) -> None:
    _dev, token, _ = await sign_in(app)
    client = new_client(app)
    assert (await client.get("/api/system/update", headers=bearer(token))).status_code == 403
    response = await client.post("/api/system/update/check", headers=bearer(token))
    assert response.status_code == 403


async def test_it_needs_a_signed_in_user(notes_client: AsyncClient) -> None:
    assert (await notes_client.get("/api/system/update")).status_code == 401
