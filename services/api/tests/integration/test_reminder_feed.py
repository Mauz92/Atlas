"""The ``reminder`` feed entity, the actions endpoint and the home time zone (M8-04a).

Real PostgreSQL. Covers SYNC_PROTOCOL.md 14.1 G1/G3/G4/G6, 14.2 and 14.5: one server-derived
reminder per task carrying the already computed UTC instant; recorded in the same transaction as the
change that moves it and only when a value moved; ``sent`` never exposed; completion, archive and
delete cancel; snooze/dismiss idempotent, user-scoped and open to device credentials.
"""

from __future__ import annotations

import asyncio
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select, text

from atlas.db import session_scope
from atlas.models import ChangeLog, Reminder, ReminderDelivery, ReminderPolicy, Task, User
from atlas.reminders import (
    RecordingNotifier,
    deliver_reminder,
    reset_notifier,
    scan_reminders,
    set_notifier,
)
from atlas.reminders.service import emit_missing_changes
from tests.conftest import create_user_via_setup, csrf_headers

pytestmark = pytest.mark.usefixtures("_db")

EMAIL = "owner@example.com"
PASSWORD = "correct horse battery"
SYNC = {"Atlas-Sync": "1"}
#: 17:00 Amsterdam (CEST) on 2026-06-10; the default policy (09:00, same day) fires at 07:00 UTC
DUE = datetime(2026, 6, 10, 15, 0, tzinfo=UTC)
REMIND = datetime(2026, 6, 10, 7, 0, tzinfo=UTC)


@pytest.fixture
async def c(notes_client: AsyncClient) -> AsyncClient:
    await create_user_via_setup(notes_client, email=EMAIL, password=PASSWORD)
    return notes_client


@pytest.fixture
def notifier() -> Any:
    recording = RecordingNotifier()
    set_notifier(recording)
    yield recording
    reset_notifier()


async def second_user(app: FastAPI) -> AsyncClient:
    """A second account with its own browser session (made directly: setup is one-shot)."""
    from atlas.auth import generate_session_token, hash_password, hash_session_token
    from atlas.models import AuthSession

    token = generate_session_token()
    async with session_scope() as session:
        user = User(
            email="eve@example.com", display_name="Eve", password_hash=hash_password(PASSWORD)
        )
        session.add(user)
        await session.flush()
        session.add(
            AuthSession(
                user_id=user.id,
                token_hash=hash_session_token(token),
                expires_at=(
                    await session.execute(text("SELECT now() + interval '1 day'"))
                ).scalar_one(),
            )
        )
    client = AsyncClient(transport=ASGITransport(app=app), base_url="http://test")
    client.cookies.set("atlas_session", token)
    from atlas.auth.csrf import issue_csrf_token

    client.cookies.set("atlas_csrf", issue_csrf_token(token))
    return client


def j(headers: dict[str, str] | None = None) -> dict[str, str]:
    return {"Idempotency-Key": str(uuid.uuid4()), **SYNC, **(headers or {})}


async def owner_id() -> uuid.UUID:
    async with session_scope() as session:
        return (await session.execute(select(User).order_by(User.created_at))).scalars().first().id  # type: ignore[union-attr]


async def set_default(c: AsyncClient, days: int = 0, at: str = "09:00") -> None:
    r = await c.put(
        "/api/notifications/reminders",
        json={"default": {"days_before": days, "at_time": at}},
        headers=csrf_headers(c),
    )
    assert r.status_code == 200, r.text


async def new_task(
    c: AsyncClient, *, due: datetime | None = DUE, zone: str | None = "Europe/Amsterdam"
) -> str:
    body: dict[str, Any] = {"title": "Secret task title"}
    if due is not None:
        body["due_at"] = due.isoformat()
    if zone is not None:
        body["time_zone"] = zone
    r = await c.post("/api/tasks", json=body, headers=csrf_headers(c))
    assert r.status_code == 201, r.text
    return str(r.json()["id"])


async def pull(c: AsyncClient, since: int = 0, **params: Any) -> dict[str, Any]:
    query = {"since": since, "types": "reminder", "include": "data", **params}
    r = await c.get("/api/changes", params=query, headers=SYNC)
    assert r.status_code == 200, r.text
    return r.json()


async def reminders_of(c: AsyncClient) -> list[dict[str, Any]]:
    body = await pull(c)
    return [x["data"] for x in body["changes"] if x["data"] is not None]


async def only_reminder(c: AsyncClient, task_id: str) -> dict[str, Any]:
    found = [r for r in await reminders_of(c) if r["task_id"] == task_id]
    assert len(found) == 1, found
    return found[0]


async def patch_task(c: AsyncClient, task_id: str, **fields: Any) -> None:
    current = (await c.get(f"/api/tasks/{task_id}")).json()
    r = await c.patch(
        f"/api/tasks/{task_id}",
        json={"base_revision": current["revision"], **fields},
        headers=csrf_headers(c),
    )
    assert r.status_code == 200, r.text


async def head(c: AsyncClient) -> int:
    return int((await pull(c, 10**9))["head"])


# --- the entity in the feed -----------------------------------------------------------------------


async def test_a_task_with_a_due_date_and_a_policy_yields_one_reminder_upsert(c) -> None:
    await set_default(c)
    task_id = await new_task(c)
    body = await pull(c)
    assert [(x["entity_type"], x["operation"]) for x in body["changes"]] == [("reminder", "upsert")]
    data = body["changes"][0]["data"]
    assert data["task_id"] == task_id
    assert data["state"] == "armed" and data["revision"] == 1
    assert datetime.fromisoformat(data["remind_at"]) == REMIND
    assert datetime.fromisoformat(data["effective_at"]) == REMIND
    assert data["snoozed_until"] is None and data["acknowledged_at"] is None
    assert body["changes"][0]["revision"] == 1
    # the payload carries no task text, anywhere
    assert "Secret" not in str(body)


async def test_the_feed_instant_is_the_instant_the_delivery_job_uses(c) -> None:
    await set_default(c)
    task_id = await new_task(c)
    async with session_scope() as session:
        stored = await session.scalar(
            select(Reminder.remind_at).where(Reminder.entity_id == uuid.UUID(task_id))
        )
    assert datetime.fromisoformat((await only_reminder(c, task_id))["remind_at"]) == stored


async def test_no_default_and_no_policy_means_no_reminder(c) -> None:
    await new_task(c)
    assert await reminders_of(c) == []


async def test_a_task_without_a_due_date_has_no_reminder(c) -> None:
    await set_default(c)
    await new_task(c, due=None)
    assert await reminders_of(c) == []


async def test_editing_the_due_date_moves_the_reminder_in_the_same_change(c) -> None:
    await set_default(c)
    task_id = await new_task(c)
    first = await pull(c)
    later = DUE + timedelta(days=1)
    await patch_task(c, task_id, due_at=later.isoformat())
    second = await pull(c, first["next_since"])
    assert len(second["changes"]) == 1
    data = second["changes"][0]["data"]
    assert data["revision"] == 2
    assert datetime.fromisoformat(data["remind_at"]) == REMIND + timedelta(days=1)
    assert second["changes"][0]["cursor"] > first["changes"][0]["cursor"]


async def test_changing_the_zone_changes_the_instant(c) -> None:
    await set_default(c)
    task_id = await new_task(c)
    await patch_task(c, task_id, time_zone="America/New_York")
    data = await only_reminder(c, task_id)
    assert datetime.fromisoformat(data["remind_at"]) == datetime(2026, 6, 10, 13, 0, tzinfo=UTC)
    assert data["revision"] == 2


async def test_an_unrelated_task_edit_records_no_reminder_change(c) -> None:
    await set_default(c)
    task_id = await new_task(c)
    before = await head(c)
    await patch_task(c, task_id, title="Renamed")
    body = await pull(c, before)
    assert body["changes"] == []


async def test_a_scan_with_nothing_to_change_records_nothing_and_does_not_move_the_cursor(
    c,
) -> None:
    await set_default(c)
    await new_task(c)
    before = await head(c)
    for _ in range(3):
        async with session_scope() as session:
            await scan_reminders(session)
    assert await head(c) == before
    assert (await pull(c, before))["changes"] == []


async def test_changing_the_default_timing_reschedules_through_the_feed(c) -> None:
    await set_default(c)
    task_id = await new_task(c)
    await set_default(c, days=1, at="08:00")
    data = await only_reminder(c, task_id)
    # 08:00 Amsterdam (CEST) the day before the due day = 06:00 UTC on the 9th
    assert datetime.fromisoformat(data["remind_at"]) == datetime(2026, 6, 9, 6, 0, tzinfo=UTC)
    assert data["revision"] == 2
    await set_default(c, days=1, at="08:00")  # saving the same value again moves nothing
    assert (await only_reminder(c, task_id))["revision"] == 2


async def test_clearing_the_default_cancels(c) -> None:
    await set_default(c)
    task_id = await new_task(c)
    r = await c.put("/api/notifications/reminders", json={"default": None}, headers=csrf_headers(c))
    assert r.status_code == 200
    assert (await only_reminder(c, task_id))["state"] == "cancelled"


@pytest.mark.parametrize("status", ["completed", "archived"])
async def test_closing_a_task_cancels_its_reminder(c, status: str) -> None:
    await set_default(c)
    task_id = await new_task(c)
    await patch_task(c, task_id, status=status)
    data = await only_reminder(c, task_id)
    assert data["state"] == "cancelled" and data["revision"] == 2


async def test_deleting_cancels_and_restoring_arms_again(c) -> None:
    await set_default(c)
    task_id = await new_task(c)
    r = await c.delete(f"/api/tasks/{task_id}", headers=csrf_headers(c))
    assert r.status_code == 204
    assert (await only_reminder(c, task_id))["state"] == "cancelled"
    r = await c.post(f"/api/tasks/{task_id}/restore", headers=csrf_headers(c))
    assert r.status_code == 200, r.text
    data = await only_reminder(c, task_id)
    assert data["state"] == "armed" and data["revision"] == 3


async def test_removing_the_due_date_cancels(c) -> None:
    await set_default(c)
    task_id = await new_task(c)
    await patch_task(c, task_id, due_at=None)
    assert (await only_reminder(c, task_id))["state"] == "cancelled"


# --- sent is not a device state (G4) --------------------------------------------------------------


async def test_a_server_delivery_never_shows_as_sent_and_never_cancels_the_device(
    c, notifier
) -> None:
    await set_default(c)
    task_id = await new_task(c)
    before = await only_reminder(c, task_id)
    async with session_scope() as session:
        reminder = await session.scalar(select(Reminder))
        assert reminder is not None
        out = await deliver_reminder(session, reminder.id, now=REMIND + timedelta(minutes=5))
        assert out.delivered
        assert reminder.status == "sent"
    after = await only_reminder(c, task_id)
    assert after["state"] == "armed"  # the server's delivery is not the device's
    assert after["revision"] == before["revision"]  # nothing device-visible changed
    assert after["server_delivered_at"] is not None  # informational
    assert before["server_delivered_at"] is None
    r = await c.get("/api/reminders", params={"state": "armed"})
    assert [x["state"] for x in r.json()["reminders"]] == ["armed"]
    assert "sent" not in str(await pull(c))


async def test_a_delivered_reminder_is_frozen_but_cancels_when_the_task_closes(c, notifier) -> None:
    await set_default(c)
    task_id = await new_task(c)
    async with session_scope() as session:
        reminder = await session.scalar(select(Reminder))
        assert reminder is not None
        await deliver_reminder(session, reminder.id, now=REMIND + timedelta(minutes=5))
    await patch_task(c, task_id, due_at=(DUE + timedelta(days=3)).isoformat())
    data = await only_reminder(c, task_id)
    assert datetime.fromisoformat(data["remind_at"]) == REMIND  # frozen once the server sent it
    await patch_task(c, task_id, status="completed")
    assert (await only_reminder(c, task_id))["state"] == "cancelled"


# --- who sees it ----------------------------------------------------------------------------------


async def test_the_legacy_feed_never_shows_reminders_but_sync_mode_does(c) -> None:
    await set_default(c)
    await new_task(c)
    legacy = await c.get("/api/changes", params={"since": 0})
    assert {x["entity_type"] for x in legacy.json()["changes"]} == {"task"}
    sync = await c.get("/api/changes", params={"since": 0}, headers=SYNC)
    assert {x["entity_type"] for x in sync.json()["changes"]} == {"task", "reminder"}
    only_tasks = await c.get("/api/changes", params={"since": 0, "types": "task"}, headers=SYNC)
    assert {x["entity_type"] for x in only_tasks.json()["changes"]} == {"task"}


async def test_the_snapshot_walk_includes_armed_reminders(c) -> None:
    await set_default(c)
    a = await new_task(c)
    b = await new_task(c, due=DUE + timedelta(days=1))
    body = await pull(c, 0)
    assert {x["data"]["task_id"] for x in body["changes"]} == {a, b}


async def test_another_users_reminders_are_not_in_my_feed(app: FastAPI, c) -> None:
    await set_default(c)
    await new_task(c)
    async with await second_user(app) as other:
        r = await other.get(
            "/api/changes",
            params={"since": 0, "types": "reminder", "include": "data"},
            headers=SYNC,
        )
        assert r.json()["changes"] == []
        listed = await other.get("/api/reminders")
        assert listed.json() == {"reminders": []}


# --- backfill and the safety net ------------------------------------------------------------------


async def test_emit_missing_changes_announces_unannounced_reminders_once(c) -> None:
    await set_default(c)
    await new_task(c)
    async with session_scope() as session:
        await session.execute(text("DELETE FROM change_log WHERE entity_type = 'reminder'"))
    async with session_scope() as session:
        assert await emit_missing_changes(session) == 1
    async with session_scope() as session:
        assert await emit_missing_changes(session) == 0
    assert len(await reminders_of(c)) == 1


# --- actions --------------------------------------------------------------------------------------


async def armed(c: AsyncClient) -> tuple[str, str]:
    await set_default(c)
    task_id = await new_task(c)
    return task_id, (await only_reminder(c, task_id))["id"]


def action(kind: str = "dismiss", **extra: Any) -> dict[str, Any]:
    return {"action_id": str(uuid.uuid4()), "kind": kind, **extra}


async def act(c: AsyncClient, rid: str, body: dict[str, Any], **headers: str) -> Any:
    return await c.post(
        f"/api/reminders/{rid}/actions",
        json=body,
        headers={**csrf_headers(c), "Idempotency-Key": body["action_id"], **headers},
    )


async def test_snooze_sets_the_synced_instant_from_the_server_clock(c) -> None:
    _task, rid = await armed(c)
    r = await act(c, rid, action("snooze", snooze_for_seconds=3600))
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["applied"] is True and out["stale"] is False
    snoozed = datetime.fromisoformat(out["reminder"]["snoozed_until"])
    assert abs((snoozed - datetime.now(UTC) - timedelta(hours=1)).total_seconds()) < 30
    assert out["reminder"]["effective_at"] == out["reminder"]["snoozed_until"]
    assert out["reminder"]["revision"] == 2
    assert out["reminder"]["acknowledged_at"] is None
    feed = (await reminders_of(c))[0]
    assert feed["revision"] == 2 and feed["snoozed_until"] == out["reminder"]["snoozed_until"]


async def test_tomorrow_morning_is_computed_in_the_task_zone(c) -> None:
    _task, rid = await armed(c)
    r = await act(c, rid, action("snooze", until="tomorrow_morning"))
    assert r.status_code == 200, r.text
    got = datetime.fromisoformat(r.json()["reminder"]["snoozed_until"])
    local = got.astimezone(__import__("zoneinfo").ZoneInfo("Europe/Amsterdam"))
    assert (local.hour, local.minute) == (9, 0)
    assert local.date() == (datetime.now(UTC).astimezone(local.tzinfo).date() + timedelta(days=1))


async def test_dismiss_acknowledges_and_clears_the_snooze(c) -> None:
    _task, rid = await armed(c)
    await act(c, rid, action("snooze", snooze_for_seconds=600))
    r = await act(c, rid, action("dismiss"))
    out = r.json()
    assert out["applied"] is True
    rem = out["reminder"]
    assert rem["snoozed_until"] is None and rem["acknowledged_at"] is not None
    assert datetime.fromisoformat(rem["acknowledged_at"]) >= datetime.fromisoformat(
        rem["effective_at"]
    )
    assert rem["revision"] == 3


async def test_a_dismiss_before_the_reminder_is_due_still_covers_that_occurrence(c) -> None:
    future = datetime.now(UTC) + timedelta(days=5)
    await set_default(c)
    task_id = await new_task(c, due=future)
    rem = await only_reminder(c, task_id)
    out = (await act(c, rem["id"], action("dismiss"))).json()["reminder"]
    assert datetime.fromisoformat(out["acknowledged_at"]) >= datetime.fromisoformat(
        out["effective_at"]
    )


async def test_a_snooze_after_a_dismiss_rearms(c) -> None:
    _task, rid = await armed(c)
    await act(c, rid, action("dismiss"))
    out = (await act(c, rid, action("snooze", snooze_for_seconds=600))).json()["reminder"]
    assert out["acknowledged_at"] is None and out["snoozed_until"] is not None


async def test_a_repeated_dismiss_with_a_new_id_is_a_no_op(c) -> None:
    _task, rid = await armed(c)
    first = (await act(c, rid, action("dismiss"))).json()
    second = (await act(c, rid, action("dismiss"))).json()
    assert second["applied"] is False
    assert second["reminder"]["revision"] == first["reminder"]["revision"]


async def test_replaying_an_action_returns_the_stored_answer_without_a_second_revision(c) -> None:
    _task, rid = await armed(c)
    body = action("snooze", snooze_for_seconds=600)
    first = await act(c, rid, body)
    again = await act(c, rid, body)
    assert again.status_code == 200
    assert again.headers["Idempotency-Replayed"] == "true"
    assert again.json() == first.json()
    assert (await only_reminder(c, _task))["revision"] == 2


async def test_the_same_action_id_with_different_content_is_refused(c) -> None:
    _task, rid = await armed(c)
    body = action("snooze", snooze_for_seconds=600)
    await act(c, rid, body)
    other = {**body, "snooze_for_seconds": 3600}
    r = await act(c, rid, other)
    assert r.status_code == 409 and r.json()["error"] == "idempotency_mismatch"


async def test_the_key_must_be_the_action_id(c) -> None:
    _task, rid = await armed(c)
    r = await act(c, rid, action("dismiss"), **{"Idempotency-Key": str(uuid.uuid4())})
    assert r.status_code == 422 and r.json()["error"] == "idempotency_key_mismatch"


async def test_an_action_on_a_cancelled_reminder_changes_nothing(c) -> None:
    task_id, rid = await armed(c)
    await patch_task(c, task_id, status="completed")
    before = await only_reminder(c, task_id)
    r = await act(c, rid, action("snooze", snooze_for_seconds=600))
    assert r.status_code == 200
    assert r.json()["applied"] is False
    assert r.json()["reminder"]["state"] == "cancelled"
    assert (await only_reminder(c, task_id)) == before


async def test_base_revision_behind_is_flagged_and_ahead_is_refused(c) -> None:
    task_id, rid = await armed(c)
    await act(c, rid, action("snooze", snooze_for_seconds=600))  # -> revision 2
    stale = await act(c, rid, action("dismiss", base_revision=1))
    assert stale.status_code == 200 and stale.json()["stale"] is True
    assert stale.json()["applied"] is True  # later action wins; it is intent, not an edit
    ahead = await act(c, rid, action("dismiss", base_revision=99))
    assert ahead.status_code == 409
    assert ahead.json()["error"] == "revision_ahead"
    assert ahead.json()["current_revision"] == (await only_reminder(c, task_id))["revision"]


async def test_another_users_reminder_is_not_found(app: FastAPI, c) -> None:
    _task, rid = await armed(c)
    async with await second_user(app) as eve:
        r = await act(eve, rid, action("dismiss"))
        assert r.status_code == 404 and r.json()["error"] == "not_found"
        r = await act(eve, str(uuid.uuid4()), action("dismiss"))
        assert r.status_code == 404
    assert (await only_reminder(c, _task))["acknowledged_at"] is None


async def test_unknown_or_malformed_actions_are_422(c) -> None:
    _task, rid = await armed(c)
    for body in (
        {"action_id": str(uuid.uuid4()), "kind": "complete"},
        {"action_id": "nope", "kind": "dismiss"},
        {"action_id": str(uuid.uuid4()), "kind": "snooze"},
        {"action_id": str(uuid.uuid4()), "kind": "snooze", "snooze_for_seconds": 7},
    ):
        r = await c.post(f"/api/reminders/{rid}/actions", json=body, headers=csrf_headers(c))
        assert r.status_code == 422, body


async def test_a_browser_action_needs_csrf_and_a_session(app: FastAPI, c) -> None:
    _task, rid = await armed(c)
    r = await c.post(f"/api/reminders/{rid}/actions", json=action())
    assert r.status_code == 403
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as anon:
        r = await anon.post(f"/api/reminders/{rid}/actions", json=action())
        assert r.status_code in (401, 403)


async def test_a_device_credential_can_act_and_read_the_feed(app: FastAPI, c) -> None:
    _task, rid = await armed(c)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as dev:
        r = await dev.post(
            "/api/devices",
            json={"email": EMAIL, "password": PASSWORD, "name": "Phone", "platform": "android"},
        )
        assert r.status_code == 201
        dev.headers["Authorization"] = f"Bearer {r.json()['token']}"
        body = action("snooze", snooze_for_seconds=600)
        r = await dev.post(
            f"/api/reminders/{rid}/actions",
            json=body,
            headers={**SYNC, "Idempotency-Key": body["action_id"]},
        )
        assert r.status_code == 200, r.text
        feed = await dev.get(
            "/api/changes",
            params={"since": 0, "types": "reminder", "include": "data"},
            headers=SYNC,
        )
        assert feed.json()["changes"][0]["data"]["revision"] == 2
    # the browser sees the device's snooze, and the account-level preference stays closed to devices
    assert (await only_reminder(c, _task))["snoozed_until"] is not None


async def test_the_time_zone_preference_is_closed_to_devices(app: FastAPI, c) -> None:
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as dev:
        r = await dev.post(
            "/api/devices",
            json={"email": EMAIL, "password": PASSWORD, "name": "P", "platform": "linux"},
        )
        dev.headers["Authorization"] = f"Bearer {r.json()['token']}"
        r = await dev.put("/api/notifications/time-zone", json={"time_zone": "Europe/Paris"})
        assert r.status_code == 403 and r.json()["error"] == "forbidden_scope"


async def test_the_audit_log_line_has_no_task_text(c) -> None:
    import logging

    _task, rid = await armed(c)
    captured: list[logging.LogRecord] = []

    class Capture(logging.Handler):
        def emit(self, record: logging.LogRecord) -> None:
            captured.append(record)

    logger = logging.getLogger("atlas.reminders")
    handler = Capture(level=logging.INFO)
    logger.addHandler(handler)
    logger.disabled = False  # Alembic's fileConfig (tests migrate in-process) disables loggers
    previous = logger.level
    logger.setLevel(logging.INFO)
    try:
        await act(c, rid, action("snooze", snooze_for_seconds=600))
    finally:
        logger.removeHandler(handler)
        logger.setLevel(previous)
    lines = [r for r in captured if r.name == "atlas.reminders"]
    assert lines and lines[0].getMessage() == "reminder.action"
    assert "Secret" not in str([r.__dict__ for r in lines])
    assert lines[0].__dict__["kind"] == "snooze"


async def test_two_concurrent_actions_serialise_and_the_cursor_stays_monotonic(
    app: FastAPI, c
) -> None:
    task_id, rid = await armed(c)
    before = await head(c)

    async def fire(kind: str, **extra: Any) -> int:
        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test", cookies=c.cookies
        ) as cc:
            r = await act(cc, rid, action(kind, **extra))
            return r.status_code

    codes = await asyncio.gather(
        fire("snooze", snooze_for_seconds=600),
        fire("dismiss"),
        fire("snooze", snooze_for_seconds=3600),
    )
    assert codes == [200, 200, 200]
    final = await only_reminder(c, task_id)
    assert final["revision"] >= 3  # every effective action took its own revision (none was lost)
    body = await pull(c, before)
    assert len(body["changes"]) == 1  # one row per entity, at its latest cursor
    async with session_scope() as session:
        seqs = list(
            await session.scalars(
                select(ChangeLog.seq).where(ChangeLog.user_id == await owner_id())
            )
        )
    assert len(seqs) == len(set(seqs))


# --- home time zone (Q6) --------------------------------------------------------------------------


async def test_the_home_time_zone_defaults_to_none_and_round_trips(c) -> None:
    assert (await c.get("/api/notifications/time-zone")).json() == {"time_zone": None}
    r = await c.put(
        "/api/notifications/time-zone",
        json={"time_zone": "Europe/Amsterdam"},
        headers=csrf_headers(c),
    )
    assert r.status_code == 200 and r.json() == {"time_zone": "Europe/Amsterdam"}
    assert (await c.get("/api/notifications/time-zone")).json() == {"time_zone": "Europe/Amsterdam"}
    r = await c.put(
        "/api/notifications/time-zone", json={"time_zone": None}, headers=csrf_headers(c)
    )
    assert r.json() == {"time_zone": None}


async def test_an_unknown_zone_is_422_and_changes_nothing(c) -> None:
    await c.put(
        "/api/notifications/time-zone", json={"time_zone": "Europe/Paris"}, headers=csrf_headers(c)
    )
    for bad in ("Mars/Olympus", "", "../../etc/passwd"):
        r = await c.put(
            "/api/notifications/time-zone", json={"time_zone": bad}, headers=csrf_headers(c)
        )
        assert r.status_code == 422, bad
    assert (await c.get("/api/notifications/time-zone")).json() == {"time_zone": "Europe/Paris"}
    assert (
        await c.put("/api/notifications/time-zone", json={"time_zone": "Europe/Paris"})
    ).status_code == 403  # csrf


async def test_a_task_without_a_zone_follows_the_home_zone(c) -> None:
    await set_default(c)
    no_zone = await new_task(c, zone=None)
    own_zone = await new_task(c, zone="Europe/Amsterdam")
    assert datetime.fromisoformat((await only_reminder(c, no_zone))["remind_at"]) == datetime(
        2026, 6, 10, 9, 0, tzinfo=UTC
    )  # no zone, no home zone: 09:00 UTC, as before
    r = await c.put(
        "/api/notifications/time-zone",
        json={"time_zone": "America/New_York"},
        headers=csrf_headers(c),
    )
    assert r.status_code == 200
    moved = await only_reminder(c, no_zone)
    # 09:00 New York (EDT, UTC-4) on the due day. The due instant 15:00 UTC is 11:00 there.
    assert datetime.fromisoformat(moved["remind_at"]) == datetime(2026, 6, 10, 13, 0, tzinfo=UTC)
    assert moved["revision"] == 2
    assert (await only_reminder(c, own_zone))[
        "revision"
    ] == 1  # a task with its own zone is untouched
    await c.put(
        "/api/notifications/time-zone",
        json={"time_zone": "America/New_York"},
        headers=csrf_headers(c),
    )
    assert (await only_reminder(c, no_zone))["revision"] == 2  # same zone again: nothing moves


async def test_a_new_task_uses_the_home_zone_when_it_has_none(c) -> None:
    await set_default(c)
    await c.put(
        "/api/notifications/time-zone", json={"time_zone": "Asia/Tokyo"}, headers=csrf_headers(c)
    )
    task_id = await new_task(c, zone=None)
    # 15:00 UTC = 00:00 on the 11th in Tokyo: the due *local* day is the 11th, 09:00 JST = 00:00 UTC
    assert datetime.fromisoformat((await only_reminder(c, task_id))["remind_at"]) == datetime(
        2026, 6, 11, 0, 0, tzinfo=UTC
    )


async def test_policies_and_tasks_are_unchanged_by_the_migration_columns(c) -> None:
    await set_default(c)
    await new_task(c)
    async with session_scope() as session:
        assert await session.scalar(select(ReminderPolicy.is_default)) is True
        task = await session.scalar(select(Task))
        assert task is not None and task.reminder_policy_id is None
        assert await session.scalar(select(ReminderDelivery.id)) is None
