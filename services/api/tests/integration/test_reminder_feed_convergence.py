"""A seeded random walk over tasks, preferences and actions against the real server (M8-04a).

The oracle is deliberately simple and independent of the feed code: it tracks, per task, what the
owner did (status, due date, zone, deletion, the default timing, the home zone, server delivery,
snooze/dismiss) and derives what a device must be told. After every step a *mirror* built only from
``GET /api/changes?types=reminder&include=data`` (applied by revision, like a device) must equal the
oracle, cursors must only grow, a revision must never go back, and a no-op scan must not move the
cursor. The seed is in every failure message; ``ATLAS_REMINDER_SEEDS`` / ``ATLAS_REMINDER_STEPS``
raise the volume (the soak uses 200 x 60).
"""

from __future__ import annotations

import os
import random
import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime, time, timedelta
from typing import Any

import pytest
from httpx import AsyncClient
from sqlalchemy import select

from atlas.db import session_scope
from atlas.models import Reminder
from atlas.reminders import (
    RecordingNotifier,
    ReminderRule,
    deliver_reminder,
    remind_at_for,
    reset_notifier,
    scan_reminders,
    set_notifier,
)
from atlas.tasks.state import TRANSITIONS
from tests.conftest import create_user_via_setup, csrf_headers

pytestmark = pytest.mark.usefixtures("_db")

SEEDS = int(os.environ.get("ATLAS_REMINDER_SEEDS", "6"))
STEPS = int(os.environ.get("ATLAS_REMINDER_STEPS", "30"))
SYNC = {"Atlas-Sync": "1"}
ZONES = [None, "Europe/Amsterdam", "America/New_York", "Asia/Tokyo", "Pacific/Auckland"]
HOME = [None, "Europe/Amsterdam", "America/Los_Angeles", "Asia/Kolkata"]
BASE = datetime(2026, 3, 20, 12, 0, tzinfo=UTC)  # DST changes fall inside the walk
OPEN = ("inbox", "next", "in_progress")


@dataclass
class T:
    status: str = "inbox"
    due: datetime | None = None
    zone: str | None = None
    deleted: bool = False
    # reminder bookkeeping the oracle derives
    exists: bool = False
    remind_at: datetime | None = None
    sent: bool = False
    state: str = "armed"
    snoozed: bool = False
    acked: bool = False


@dataclass
class World:
    timing: tuple[int, time] | None = None
    home: str | None = None
    tasks: dict[str, T] = field(default_factory=dict)

    def deliverable(self, t: T) -> bool:
        return self.timing is not None and t.due is not None and not t.deleted and t.status in OPEN

    def refresh(self, t: T) -> None:
        """What the scheduler must have done to this task's reminder after any change."""
        if not self.deliverable(t):
            if t.exists:
                t.state = "cancelled"
            return
        assert self.timing is not None and t.due is not None
        target = remind_at_for(
            t.due, ReminderRule(*self.timing), tz_name=t.zone if t.zone else self.home
        )
        if not t.exists:
            t.exists, t.remind_at, t.state = True, target, "armed"
            return
        t.state = "armed"
        if t.sent:
            return  # frozen once the server delivered
        if t.remind_at != target:
            t.remind_at = target
            t.snoozed = False  # a moved schedule supersedes the snooze

    def refresh_all(self, *, only_zoneless: bool = False) -> None:
        for t in self.tasks.values():
            if only_zoneless and t.zone is not None:
                continue
            if not t.deleted or t.exists:
                self.refresh(t)


class Mirror:
    """A device: applies feed items by revision, never goes back."""

    def __init__(self) -> None:
        self.cursor = 0
        self.items: dict[str, dict[str, Any]] = {}

    async def sync(self, c: AsyncClient, seed: int) -> int:
        moved = 0
        while True:
            r = await c.get(
                "/api/changes",
                params={
                    "since": self.cursor,
                    "types": "reminder",
                    "include": "data",
                    "limit": 200,
                },
                headers=SYNC,
            )
            body = r.json()
            assert r.status_code == 200, (seed, r.text)
            assert body["next_since"] >= self.cursor, seed
            for item in body["changes"]:
                assert item["cursor"] > self.cursor, (seed, "cursor went back")
                data = item["data"]
                known = self.items.get(item["entity_id"])
                assert known is None or data["revision"] >= known["revision"], (
                    seed,
                    "revision back",
                )
                self.items[item["entity_id"]] = data
                moved += 1
            self.cursor = body["next_since"]
            if not body["has_more"]:
                return moved


def _dt(value: str | None) -> datetime | None:
    return datetime.fromisoformat(value) if value else None


async def _step(c: AsyncClient, rng: random.Random, w: World, seed: int) -> str:
    ids = list(w.tasks)
    live = [i for i in ids if not w.tasks[i].deleted]
    choice = rng.choices(
        [
            "create",
            "redate",
            "zone",
            "close",
            "reopen",
            "delete",
            "restore",
            "timing",
            "cleartiming",
            "home",
            "snooze",
            "dismiss",
            "deliver",
            "scan",
            "undue",
        ],
        weights=[10, 8, 5, 5, 4, 4, 3, 4, 1, 3, 6, 5, 3, 4, 2],
    )[0]
    h = csrf_headers(c)

    async def patch(tid: str, **fields: Any) -> None:
        cur = (await c.get(f"/api/tasks/{tid}")).json()
        r = await c.patch(
            f"/api/tasks/{tid}", json={"base_revision": cur["revision"], **fields}, headers=h
        )
        assert r.status_code == 200, (seed, choice, r.text)

    if choice == "create":
        due = BASE + timedelta(hours=rng.randrange(0, 24 * 60))
        zone = rng.choice(ZONES)
        body: dict[str, Any] = {"title": f"task {len(ids)}", "due_at": due.isoformat()}
        if zone:
            body["time_zone"] = zone
        r = await c.post("/api/tasks", json=body, headers=h)
        assert r.status_code == 201, r.text
        t = T(due=due, zone=zone)
        w.tasks[r.json()["id"]] = t
        w.refresh(t)
    elif choice == "redate" and live:
        tid = rng.choice(live)
        t = w.tasks[tid]
        t.due = BASE + timedelta(hours=rng.randrange(0, 24 * 60))
        await patch(tid, due_at=t.due.isoformat())
        w.refresh(t)
    elif choice == "undue" and live:
        tid = rng.choice(live)
        t = w.tasks[tid]
        t.due = None
        await patch(tid, due_at=None)
        w.refresh(t)
    elif choice == "zone" and live:
        tid = rng.choice(live)
        t = w.tasks[tid]
        t.zone = rng.choice([z for z in ZONES if z])
        await patch(tid, time_zone=t.zone)
        w.refresh(t)
    elif choice == "close" and live:
        tid = rng.choice(live)
        t = w.tasks[tid]
        options = sorted(TRANSITIONS[t.status] & {"completed", "archived"})
        if options:
            t.status = rng.choice(options)
            await patch(tid, status=t.status)
            w.refresh(t)
    elif choice == "reopen" and live:
        tid = rng.choice(live)
        t = w.tasks[tid]
        options = sorted(TRANSITIONS[t.status] & set(OPEN))
        if options:
            t.status = rng.choice(options)
            await patch(tid, status=t.status)
            w.refresh(t)
    elif choice == "delete" and live:
        tid = rng.choice(live)
        t = w.tasks[tid]
        assert (await c.delete(f"/api/tasks/{tid}", headers=h)).status_code == 204
        t.deleted = True
        w.refresh(t)
    elif choice == "restore":
        gone = [i for i in ids if w.tasks[i].deleted]
        if gone:
            tid = rng.choice(gone)
            t = w.tasks[tid]
            r = await c.post(f"/api/tasks/{tid}/restore", headers=h)
            assert r.status_code == 200, (seed, r.text)
            t.deleted = False
            w.refresh(t)
    elif choice == "timing":
        w.timing = (rng.choice([0, 0, 1, 2]), rng.choice([time(9, 0), time(8, 30), time(23, 0)]))
        r = await c.put(
            "/api/notifications/reminders",
            json={
                "default": {"days_before": w.timing[0], "at_time": w.timing[1].strftime("%H:%M")}
            },
            headers=h,
        )
        assert r.status_code == 200, r.text
        w.refresh_all()
    elif choice == "cleartiming":
        w.timing = None
        assert (
            await c.put("/api/notifications/reminders", json={"default": None}, headers=h)
        ).status_code == 200
        w.refresh_all()
    elif choice == "home":
        w.home = rng.choice(HOME)
        r = await c.put("/api/notifications/time-zone", json={"time_zone": w.home}, headers=h)
        assert r.status_code == 200, r.text
        # only tasks with a due date and no zone of their own are recomputed (deleted ones too in
        # the service, but a deleted task has no pending reminder to move)
        for t in w.tasks.values():
            if t.zone is None and t.due is not None and not t.deleted:
                w.refresh(t)
    elif choice in ("snooze", "dismiss"):
        have = [i for i, t in w.tasks.items() if t.exists]
        if have:
            tid = rng.choice(have)
            t = w.tasks[tid]
            async with session_scope() as session:
                rid = await session.scalar(
                    select(Reminder.id).where(Reminder.entity_id == uuid.UUID(tid))
                )
            body = {"action_id": str(uuid.uuid4()), "kind": choice}
            if choice == "snooze":
                body["snooze_for_seconds"] = rng.choice([600, 3600, 10800])
            r = await c.post(
                f"/api/reminders/{rid}/actions",
                json=body,
                headers={**h, "Idempotency-Key": body["action_id"]},
            )
            assert r.status_code == 200, (seed, r.text)
            if t.state == "armed":
                if choice == "snooze":
                    t.snoozed, t.acked = True, False
                elif t.snoozed or not t.acked:
                    t.snoozed, t.acked = False, True
                # (a dismiss of an already dismissed occurrence changes nothing)
    elif choice == "deliver":
        have = [i for i, t in w.tasks.items() if t.exists and t.state == "armed" and not t.sent]
        if have:
            tid = rng.choice(have)
            async with session_scope() as session:
                rem = await session.scalar(
                    select(Reminder).where(Reminder.entity_id == uuid.UUID(tid))
                )
                assert rem is not None
                out = await deliver_reminder(
                    session, rem.id, now=rem.remind_at + timedelta(minutes=1)
                )
            if out.delivered:
                w.tasks[tid].sent = True
    elif choice == "scan":
        async with session_scope() as session:
            await scan_reminders(session)
    return choice


async def _check(c: AsyncClient, w: World, mirror: Mirror, seed: int, step: int, op: str) -> None:
    where = f"seed={seed} step={step} op={op}"
    await mirror.sync(c, seed)
    by_task = {d["task_id"]: d for d in mirror.items.values()}
    expected = {tid: t for tid, t in w.tasks.items() if t.exists}
    assert set(by_task) == set(expected), where
    for tid, t in expected.items():
        d = by_task[tid]
        assert d["state"] == t.state, (where, tid, "state")
        assert _dt(d["remind_at"]) == t.remind_at, (where, tid, "remind_at")
        assert (d["snoozed_until"] is not None) == (t.snoozed and t.state == "armed") or (
            t.state == "cancelled"
        ), (where, tid, "snooze")
        if t.state == "armed":
            assert (d["acknowledged_at"] is not None) == t.acked, (where, tid, "ack")
            if d["acknowledged_at"] is not None:
                assert _dt(d["acknowledged_at"]) >= _dt(d["effective_at"]), (where, tid)
        assert _dt(d["effective_at"]) == (_dt(d["snoozed_until"]) or _dt(d["remind_at"])), where
        assert "sent" not in str(d.values()), where
    # the mirror equals what the server lists (diagnostics endpoint) - the feed missed nothing
    listed = (await c.get("/api/reminders", params={"limit": 500})).json()["reminders"]
    assert {r["id"]: (r["revision"], r["state"]) for r in listed} == {
        i: (d["revision"], d["state"]) for i, d in mirror.items.items()
    }, where
    # a scan that has nothing to do moves nothing
    before = mirror.cursor
    async with session_scope() as session:
        await scan_reminders(session)
    assert await mirror.sync(c, seed) == 0 and mirror.cursor == before, (where, "scan churn")


@pytest.mark.parametrize("seed", range(SEEDS))
async def test_the_mirror_converges_on_the_oracle(notes_client: AsyncClient, seed: int) -> None:
    c = notes_client
    await create_user_via_setup(c)
    notifier = RecordingNotifier()
    set_notifier(notifier)
    try:
        rng = random.Random(seed)
        w, mirror = World(), Mirror()
        for step in range(STEPS):
            op = await _step(c, rng, w, seed)
            await _check(c, w, mirror, seed, step, op)
    finally:
        reset_notifier()
