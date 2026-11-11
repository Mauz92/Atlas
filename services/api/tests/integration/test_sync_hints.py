"""Long poll, hint registration, the coalesced emitter and the sender job (M8-04e).

Real PostgreSQL and a real in-process HTTP gateway (a thread on loopback that records requests and
can fail, delay, redirect or answer 410).
"""

from __future__ import annotations

import asyncio
import json
import logging
import threading
import time
import uuid
from contextlib import nullcontext
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select, text

from atlas.config import get_settings
from atlas.db import session_scope
from atlas.hints import HINT_PAYLOAD
from atlas.hints import service as hints
from atlas.models import DeviceHint, Job
from tests.conftest import create_user_via_setup, csrf_headers

pytestmark = pytest.mark.usefixtures("_db")
EMAIL, PASSWORD = "owner@example.com", "correct horse battery"
SYNC = {"Atlas-Sync": "1"}
TOPIC_A, TOPIC_B = "/upAAAAAAAAAAAA1", "/upBBBBBBBBBBBB2"


class Gateway:
    """A loopback ntfy stand-in. ``mode`` per path: ok, 410, 500, redirect, slow."""

    def __init__(self) -> None:
        self.requests: list[dict[str, Any]] = []
        self.mode: dict[str, str] = {}
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:
                body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
                outer.requests.append(
                    {"path": self.path, "body": body, "headers": dict(self.headers)}
                )
                mode = outer.mode.get(self.path, "ok")
                if mode == "slow":
                    time.sleep(1.5)
                if mode == "redirect":
                    self.send_response(302)
                    self.send_header("Location", "http://127.0.0.1:9/x")
                else:
                    self.send_response({"410": 410, "500": 500}.get(mode, 200))
                self.end_headers()

            def log_message(self, *args: Any) -> None:
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()


@pytest.fixture
def gateway(monkeypatch: pytest.MonkeyPatch):
    gw = Gateway()
    monkeypatch.setenv("SYNC_HINT_ENABLED", "true")
    monkeypatch.setenv("SYNC_HINT_GATEWAY_URL", gw.url)
    monkeypatch.setenv("SYNC_HINT_GATEWAY_TOKEN", "tk_secret_token")
    monkeypatch.setenv("SYNC_HINT_TIMEOUT_SECONDS", "1")
    monkeypatch.setenv("SYNC_WAIT_POLL_SECONDS", "0.05")
    get_settings.cache_clear()
    hints.breaker.failures, hints.breaker.opened_at = 0, None
    yield gw
    gw.close()
    monkeypatch.undo()
    get_settings.cache_clear()


@pytest.fixture
async def c(notes_client: AsyncClient) -> AsyncClient:
    await create_user_via_setup(notes_client, email=EMAIL, password=PASSWORD)
    return notes_client


async def device(app: FastAPI, name: str = "Phone") -> tuple[AsyncClient, str, str]:
    client = AsyncClient(transport=ASGITransport(app=app), base_url="http://test")
    r = await client.post(
        "/api/devices",
        json={"email": EMAIL, "password": PASSWORD, "name": name, "platform": "android"},
    )
    assert r.status_code == 201, r.text
    client.headers["Authorization"] = f"Bearer {r.json()['token']}"
    return client, r.json()["token"], r.json()["device"]["id"]


def dsync(extra: dict[str, str] | None = None) -> dict[str, str]:
    return {**SYNC, "Idempotency-Key": str(uuid.uuid4()), **(extra or {})}


async def register(dev: AsyncClient, gw: Gateway, topic: str = TOPIC_A) -> Any:
    return await dev.put("/api/devices/current/hint", json={"endpoint": gw.url + topic})


async def make_change(client: AsyncClient, **kw: Any) -> None:
    r = await client.post(
        "/api/tasks", json={"title": "Secret title"}, headers=kw.get("headers", {})
    )
    assert r.status_code == 201, r.text


async def jobs() -> list[Job]:
    async with session_scope() as s:
        return list(await s.scalars(select(Job).where(Job.task_name == "sync.hint")))


# --- long poll --------------------


async def test_wait_returns_at_once_when_behind_and_is_content_free(c) -> None:
    await make_change(c, headers=csrf_headers(c))
    r = await c.get("/api/sync/wait", params={"since": 0}, headers=SYNC)
    assert r.status_code == 200
    body = r.json()
    assert set(body) == {"head", "changed"} and body["changed"] is True and body["head"] >= 1
    assert "Secret" not in r.text


async def test_wait_times_out_with_changed_false(c, monkeypatch) -> None:
    monkeypatch.setenv("SYNC_WAIT_MAX_SECONDS", "1")
    monkeypatch.setenv("SYNC_WAIT_POLL_SECONDS", "0.05")
    get_settings.cache_clear()
    try:
        head = (
            await c.get("/api/sync/wait", params={"since": 0, "timeout": 1}, headers=SYNC)
        ).json()["head"]
        start = time.monotonic()
        r = await c.get("/api/sync/wait", params={"since": head, "timeout": 30}, headers=SYNC)
        assert 0.9 <= time.monotonic() - start < 3
        assert r.json() == {"head": head, "changed": False}
    finally:
        get_settings.cache_clear()


async def test_wait_wakes_when_a_change_commits(c, monkeypatch) -> None:
    monkeypatch.setenv("SYNC_WAIT_POLL_SECONDS", "0.05")
    get_settings.cache_clear()
    try:
        head = (
            await c.get("/api/sync/wait", params={"since": 0, "timeout": 1}, headers=SYNC)
        ).json()["head"]
        waiting = asyncio.create_task(
            c.get("/api/sync/wait", params={"since": head, "timeout": 20}, headers=SYNC)
        )
        await asyncio.sleep(0.3)
        assert not waiting.done()
        await make_change(c, headers=csrf_headers(c))
        r = await asyncio.wait_for(waiting, 5)
        assert r.json()["changed"] is True and r.json()["head"] > head
    finally:
        get_settings.cache_clear()


async def test_wait_validates_auth_versioning_and_parameters(app: FastAPI, c) -> None:
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as anon:
        assert (await anon.get("/api/sync/wait", params={"since": 0})).status_code == 401
    assert (
        await c.get("/api/sync/wait", params={"since": 0}, headers={"Atlas-Sync": "9"})
    ).status_code == 426
    bad = await c.get(
        "/api/sync/wait", params={"since": 0}, headers={**SYNC, "Atlas-Epoch": "nope"}
    )
    assert bad.status_code == 409 and bad.json()["error"] == "epoch_mismatch"
    assert (await c.get("/api/sync/wait", params={"since": -1})).status_code == 422
    assert (await c.get("/api/sync/wait", params={"since": 0, "timeout": 0})).status_code == 422
    assert (await c.get("/api/sync/wait")).status_code == 422


async def test_a_client_ahead_of_the_server_is_told_to_pull(c) -> None:
    r = await c.get("/api/sync/wait", params={"since": 999}, headers=SYNC)
    assert r.json()["changed"] is True


async def test_a_device_can_wait_and_a_revoked_one_is_refused(app: FastAPI, c) -> None:
    dev, _token, device_id = await device(app)
    async with nullcontext():
        head = (
            await dev.get("/api/sync/wait", params={"since": 0, "timeout": 1}, headers=SYNC)
        ).json()["head"]
        r = await dev.get("/api/sync/wait", params={"since": head, "timeout": 1}, headers=SYNC)
        assert r.status_code == 200
        await c.delete(f"/api/devices/{device_id}", headers=csrf_headers(c))
        r = await dev.get("/api/sync/wait", params={"since": head, "timeout": 1}, headers=SYNC)
        assert r.status_code == 401 and r.json()["error"] == "token_revoked"


async def test_a_wait_in_flight_ends_when_its_device_is_revoked(
    app: FastAPI, c, monkeypatch
) -> None:
    monkeypatch.setenv("SYNC_WAIT_POLL_SECONDS", "0.05")
    get_settings.cache_clear()
    dev, _t, device_id = await device(app)
    try:
        async with nullcontext():
            head = (await dev.get("/api/sync/wait", params={"since": 0}, headers=SYNC)).json()[
                "head"
            ]
            waiting = asyncio.create_task(
                dev.get("/api/sync/wait", params={"since": head, "timeout": 20}, headers=SYNC)
            )
            await asyncio.sleep(0.3)
            await c.delete(f"/api/devices/{device_id}", headers=csrf_headers(c))
            r = await asyncio.wait_for(waiting, 5)
            assert r.status_code == 401
    finally:
        get_settings.cache_clear()


async def test_a_fifth_wait_releases_the_oldest(c, monkeypatch) -> None:
    monkeypatch.setenv("SYNC_WAIT_POLL_SECONDS", "0.05")
    monkeypatch.setenv("SYNC_WAIT_MAX_CONNECTIONS", "2")
    get_settings.cache_clear()
    try:
        head = (
            await c.get("/api/sync/wait", params={"since": 0, "timeout": 1}, headers=SYNC)
        ).json()["head"]
        first = asyncio.create_task(
            c.get("/api/sync/wait", params={"since": head, "timeout": 20}, headers=SYNC)
        )
        await asyncio.sleep(0.2)
        second = asyncio.create_task(
            c.get("/api/sync/wait", params={"since": head, "timeout": 20}, headers=SYNC)
        )
        await asyncio.sleep(0.2)
        third = asyncio.create_task(
            c.get("/api/sync/wait", params={"since": head, "timeout": 20}, headers=SYNC)
        )
        r = await asyncio.wait_for(first, 5)
        assert r.json() == {"head": head, "changed": False}
        assert not second.done() and not third.done()
        await make_change(c, headers=csrf_headers(c))
        assert (await asyncio.wait_for(second, 5)).json()["changed"] is True
        assert (await asyncio.wait_for(third, 5)).json()["changed"] is True
    finally:
        get_settings.cache_clear()


async def test_a_device_is_rate_limited_per_device(app: FastAPI, c, monkeypatch) -> None:
    from atlas.auth.devices import device_request_limiter

    dev, _t, _id = await device(app)
    async with nullcontext():
        monkeypatch.setattr(device_request_limiter, "_limit", 5)
        codes = [
            (await dev.get("/api/sync/wait", params={"since": 0}, headers=SYNC)).status_code
            for _ in range(5)
        ]
    assert codes[:2] == [200, 200] and 429 in codes


# --- registration --------------------


async def test_hints_are_inert_and_refuse_registration_when_disabled(app: FastAPI, c) -> None:
    dev, _t, _id = await device(app)
    async with nullcontext():
        r = await dev.put(
            "/api/devices/current/hint", json={"endpoint": "https://x.example/upAAAAAAAAAAAA1"}
        )
        assert r.status_code == 409 and r.json()["error"] == "hints_disabled"
        st = (await dev.get("/api/devices/current/hint")).json()
        assert st["enabled"] is False and st["registered"] is False
    await make_change(c, headers=csrf_headers(c))
    assert await jobs() == []


async def test_register_get_replace_delete_and_the_endpoint_never_comes_back(
    app: FastAPI, c, gateway
) -> None:
    dev, _t, device_id = await device(app)
    async with nullcontext():
        r = await register(dev, gateway)
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["registered"] and body["enabled"] and body["endpoint_tail"] == TOPIC_A[-4:]
        assert gateway.url not in r.text and TOPIC_A not in r.text
        assert TOPIC_A not in (await dev.get("/api/devices/current/hint")).text
        assert (await register(dev, gateway, TOPIC_B)).json()["endpoint_tail"] == TOPIC_B[-4:]
        async with session_scope() as s:
            row = await s.get(DeviceHint, uuid.UUID(device_id))
            assert row is not None
            assert TOPIC_B.encode() not in bytes(row.endpoint_encrypted)  # encrypted at rest
            assert hints.open_endpoint(row) == gateway.url + TOPIC_B
        assert (await dev.delete("/api/devices/current/hint")).status_code == 204
        assert (await dev.delete("/api/devices/current/hint")).status_code == 204
        assert (await dev.get("/api/devices/current/hint")).json()["registered"] is False


@pytest.mark.parametrize(
    "endpoint",
    [
        "https://evil.example.org/upAAAAAAAAAAAA1",
        "{gw}@evil.org/upAAAAAAAAAAAA1",
        "{gw}/upAAAAAAAAAAAA1?x=1",
        "{gw}/../upAAAAAAAAAAAA1",
        "{gw}/nottopic",
        "{gwport}/upAAAAAAAAAAAA1",
        "http://169.254.169.254/upAAAAAAAAAAAA1",
    ],
)
async def test_an_endpoint_off_the_gateway_is_422_and_not_echoed(
    app: FastAPI, c, gateway, endpoint: str
) -> None:
    dev, _t, _id = await device(app)
    async with nullcontext():
        url = endpoint.format(gw=gateway.url, gwport=gateway.url + "0")
        r = await dev.put("/api/devices/current/hint", json={"endpoint": url})
        assert r.status_code == 422 and r.json()["error"] == "invalid_hint_endpoint"
        assert url not in r.text
        assert (await dev.get("/api/devices/current/hint")).json()["registered"] is False
    assert gateway.requests == []  # nothing was ever requested


async def test_registration_is_for_devices_only_and_a_browser_gets_404(c, gateway) -> None:
    r = await c.put(
        "/api/devices/current/hint",
        json={"endpoint": gateway.url + TOPIC_A},
        headers=csrf_headers(c),
    )
    assert r.status_code == 404


async def test_revoking_a_device_deletes_its_destination(app: FastAPI, c, gateway) -> None:
    dev, _t, device_id = await device(app)
    async with nullcontext():
        await register(dev, gateway)
    await c.delete(f"/api/devices/{device_id}", headers=csrf_headers(c))
    async with session_scope() as s:
        assert await s.get(DeviceHint, uuid.UUID(device_id)) is None
    dev2, _t2, _id2 = await device(app, "Other")
    async with nullcontext():
        await register(dev2, gateway)
    await c.post("/api/devices/revoke-all", headers=csrf_headers(c))
    async with session_scope() as s:
        assert (await s.scalar(text("SELECT count(*) FROM device_hints"))) == 0


async def test_deleting_the_device_row_cascades(app: FastAPI, c, gateway) -> None:
    dev, _t, device_id = await device(app)
    async with nullcontext():
        await register(dev, gateway)
    async with session_scope() as s:
        await s.execute(text("DELETE FROM devices WHERE id = :i"), {"i": device_id})
        assert (await s.scalar(text("SELECT count(*) FROM device_hints"))) == 0


async def test_the_test_endpoint_sends_one_hint_and_is_limited(app: FastAPI, c, gateway) -> None:
    dev, _t, _id = await device(app)
    async with nullcontext():
        assert (await dev.post("/api/devices/current/hint/test")).status_code == 404
        await register(dev, gateway)
        r = await dev.post("/api/devices/current/hint/test")
        assert r.status_code == 200 and r.json()["outcome"] == "delivered"
        assert gateway.requests[-1]["body"] == HINT_PAYLOAD
        assert (await dev.post("/api/devices/current/hint/test")).status_code == 429
        assert (await dev.get("/api/devices/current/hint")).json()["last_ok_at"] is not None


# --- emitter and sender --------------------


async def run_jobs() -> int:
    from atlas.jobs.worker import run_once

    n = 0
    async with session_scope() as s:
        await s.execute(text("UPDATE jobs SET run_at = now() WHERE task_name = 'sync.hint'"))
    while await run_once("test"):
        n += 1
    return n


async def test_a_burst_of_edits_makes_one_job_and_the_payload_is_constant(
    app: FastAPI, c, gateway, monkeypatch: pytest.MonkeyPatch
) -> None:
    # The coalescing window is wall-clock aligned: on a slow runner the burst could straddle a
    # boundary and make two jobs. One huge window makes "one window" deterministic.
    monkeypatch.setenv("SYNC_HINT_MIN_INTERVAL_SECONDS", "86400000")
    get_settings.cache_clear()
    dev, _t, _id = await device(app)
    async with nullcontext():
        await register(dev, gateway)
    for _ in range(12):
        await make_change(c, headers=csrf_headers(c))
    assert len(await jobs()) == 1
    await run_jobs()
    assert len(gateway.requests) == 1
    req = gateway.requests[0]
    assert req["body"] == HINT_PAYLOAD and req["path"] == TOPIC_A
    assert req["headers"]["Authorization"] == "Bearer tk_secret_token"
    assert "Secret" not in json.dumps({k: str(v) for k, v in req.items()})


async def test_payloads_are_byte_identical_for_every_kind_of_event(
    app: FastAPI, c, gateway
) -> None:
    dev, _t, _id = await device(app)
    async with nullcontext():
        await register(dev, gateway)
    await make_change(c, headers=csrf_headers(c))
    await run_jobs()
    await c.put(
        "/api/notifications/reminders",
        json={"default": {"days_before": 0, "at_time": "09:00"}},
        headers=csrf_headers(c),
    )
    r = await c.post(
        "/api/tasks",
        json={"title": "Other secret", "due_at": "2030-01-01T10:00:00+00:00"},
        headers=csrf_headers(c),
    )
    assert r.status_code == 201
    await c.post(
        "/api/notes", json={"path": "a.md", "content": "note text SECRET"}, headers=csrf_headers(c)
    )
    async with session_scope() as s:
        await s.execute(
            text(
                "UPDATE jobs SET idempotency_key = idempotency_key || 'x'"
                " WHERE task_name='sync.hint'"
            )
        )
    await run_jobs()
    assert len(gateway.requests) >= 1
    assert {bytes(q["body"]) for q in gateway.requests} == {HINT_PAYLOAD}


async def test_the_writing_device_gets_no_hint_but_the_others_do(app: FastAPI, c, gateway) -> None:
    writer, _t, wid = await device(app, "Writer")
    other, _t2, _oid = await device(app, "Other")
    async with nullcontext():
        await register(writer, gateway, TOPIC_A)
        await register(other, gateway, TOPIC_B)
        r = await writer.post("/api/tasks", json={"title": "x"}, headers=dsync())
        assert r.status_code == 201
        await run_jobs()
        assert [q["path"] for q in gateway.requests] == [TOPIC_B]
        # a browser write hints both
        gateway.requests.clear()
        await make_change(c, headers=csrf_headers(c))
        await run_jobs()
        assert sorted(q["path"] for q in gateway.requests) == [TOPIC_A, TOPIC_B]
    del wid


async def test_gone_disables_the_destination_and_unreachable_retries_then_drops(
    app: FastAPI, c, gateway
) -> None:
    dev, _t, device_id = await device(app)
    async with nullcontext():
        await register(dev, gateway)
        gateway.mode[TOPIC_A] = "410"
        await make_change(c, headers=csrf_headers(c))
        await run_jobs()
        st = (await dev.get("/api/devices/current/hint")).json()
        assert st["invalid"] is True and st["last_error_class"] == "gone"
        n = len(gateway.requests)
        await make_change(c, headers=csrf_headers(c))
        assert await jobs() and len(gateway.requests) == n  # no new job for an invalid destination
        await register(dev, gateway)  # registering again revives it
        assert (await dev.get("/api/devices/current/hint")).json()["invalid"] is False
        gateway.mode[TOPIC_A] = "500"
        async with session_scope() as s:
            await s.execute(text("DELETE FROM jobs"))
        await make_change(c, headers=csrf_headers(c))
        for _ in range(4):
            await run_jobs()
            async with session_scope() as s:
                await s.execute(text("UPDATE jobs SET run_at = now() WHERE task_name='sync.hint'"))
        async with session_scope() as s:
            statuses = list(await s.scalars(select(Job.status).where(Job.task_name == "sync.hint")))
            attempts = list(
                await s.scalars(select(Job.attempts).where(Job.task_name == "sync.hint"))
            )
        assert statuses == ["failed"] and attempts == [3]  # bounded, then dropped
        assert (await dev.get("/api/devices/current/hint")).json()["failures"] >= 3
    del device_id


async def test_a_redirect_is_a_failure_that_is_not_followed(app: FastAPI, c, gateway) -> None:
    dev, _t, _id = await device(app)
    async with nullcontext():
        await register(dev, gateway)
        gateway.mode[TOPIC_A] = "redirect"
        await make_change(c, headers=csrf_headers(c))
        await run_jobs()
        assert [q["path"] for q in gateway.requests] == [TOPIC_A]
        assert (await dev.get("/api/devices/current/hint")).json()["last_error_class"] == "redirect"


async def test_an_unreachable_gateway_never_slows_or_fails_the_request_that_changed_data(
    app: FastAPI, c, gateway
) -> None:
    dev, _t, _id = await device(app)
    async with nullcontext():
        await register(dev, gateway)
    gateway.close()
    start = time.monotonic()
    await make_change(c, headers=csrf_headers(c))
    assert time.monotonic() - start < 2  # the send is a later job, never inline
    n = await run_jobs()
    assert n >= 1  # the job ran (and will retry); nothing raised into the request


async def test_the_breaker_stops_sending_after_five_failures(app: FastAPI, c, gateway) -> None:
    dev, _t, _id = await device(app)
    async with nullcontext():
        await register(dev, gateway)
        gateway.mode[TOPIC_A] = "500"
        for _ in range(7):
            async with session_scope() as s:
                await s.execute(text("DELETE FROM jobs"))
            await make_change(c, headers=csrf_headers(c))
            await run_jobs()
        assert len(gateway.requests) == 5 and not hints.breaker.allow()


async def test_the_reminder_delivery_also_hints(app: FastAPI, c, gateway) -> None:
    from datetime import UTC, datetime, timedelta

    from atlas.jobs.handlers import deliver_reminder_job
    from atlas.models import Reminder
    from atlas.reminders import RecordingNotifier, reset_notifier, set_notifier

    set_notifier(RecordingNotifier())
    try:
        dev, _t, _id = await device(app)
        async with nullcontext():
            await register(dev, gateway)
        await c.put(
            "/api/notifications/reminders",
            json={"default": {"days_before": 0, "at_time": "09:00"}},
            headers=csrf_headers(c),
        )
        past = (datetime.now(UTC) - timedelta(days=1)).isoformat()
        await c.post(
            "/api/tasks",
            json={"title": "t", "due_at": past, "time_zone": "UTC"},
            headers=csrf_headers(c),
        )
        async with session_scope() as s:
            await s.execute(text("DELETE FROM jobs"))
            rem = await s.scalar(select(Reminder))
            assert rem is not None
            await deliver_reminder_job(
                s, {"reminder_id": str(rem.id), "remind_at": rem.remind_at.isoformat()}
            )
        keys = [j.idempotency_key for j in await jobs()]
        assert len(keys) == 1 and keys[0].endswith(":reminder")
    finally:
        reset_notifier()


async def test_no_endpoint_or_token_reaches_the_logs(app: FastAPI, c, gateway, caplog) -> None:
    caplog.set_level(logging.DEBUG)
    for name in ("atlas.hints", "atlas.http"):
        logging.getLogger(name).disabled = False
    dev, _t, _id = await device(app)
    async with nullcontext():
        await register(dev, gateway)
        gateway.mode[TOPIC_A] = "500"
        await dev.put(
            "/api/devices/current/hint", json={"endpoint": "https://evil.example/upAAAAAAAAAAAA1"}
        )
        await make_change(c, headers=csrf_headers(c))
        await run_jobs()
        await dev.post("/api/devices/current/hint/test")
    haystack = "\n".join(f"{r.getMessage()} {r.__dict__}" for r in caplog.records)
    for secret in (TOPIC_A, gateway.url, "tk_secret_token", "evil.example"):
        assert secret not in haystack


async def test_the_job_is_inert_after_the_feature_is_switched_off(
    app: FastAPI, c, gateway, monkeypatch
) -> None:
    dev, _t, _id = await device(app)
    async with nullcontext():
        await register(dev, gateway)
    await make_change(c, headers=csrf_headers(c))
    monkeypatch.setenv("SYNC_HINT_ENABLED", "false")
    get_settings.cache_clear()
    await run_jobs()
    assert gateway.requests == []
