"""The reminder-feed migration against a real PostgreSQL (M8-04a).

Synchronous (Alembic's env.py starts its own event loop); leaves the schema at ``head``. Covers the
upgrade on an empty database, on an installation with representative reminders (pending, sent,
cancelled, task completed/deleted, two users), the feed backfill (one entry per reminder at fresh
cursors above the user's counter, nothing for other users), the downgrade and a second round trip.
"""

from __future__ import annotations

import os
import uuid

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.exc import IntegrityError

from atlas.migrations import downgrade, upgrade

PREVIOUS = "c9e4a7b2d6f1"


@pytest.fixture
def db():
    upgrade("head")
    engine = create_engine(os.environ["DATABASE_URL"])
    yield engine
    upgrade("head")
    with engine.begin() as conn:
        conn.execute(text("TRUNCATE users CASCADE"))
    engine.dispose()


def _columns(conn, table: str) -> set[str]:
    rows = conn.execute(
        text("SELECT column_name FROM information_schema.columns WHERE table_name = :t"),
        {"t": table},
    )
    return {r[0] for r in rows}


def _seed(conn) -> dict[str, uuid.UUID]:
    ids = {name: uuid.uuid4() for name in ("u1", "u2")}
    conn.execute(text("TRUNCATE users CASCADE"))
    for key, seq in (("u1", 7), ("u2", 0)):
        conn.execute(
            text(
                "INSERT INTO users (id, email, display_name, password_hash, change_seq)"
                " VALUES (:u, :e, 'M', 'x', :s)"
            ),
            {"u": ids[key], "e": f"{key}@x", "s": seq},
        )
    # (name, user, task status, deleted, reminder status, remind_at offset hours)
    rows = [
        ("pending", "u1", "inbox", False, "scheduled", 1),
        ("sent", "u1", "next", False, "sent", 2),
        ("cancelled", "u1", "inbox", False, "cancelled", 3),
        ("done", "u1", "completed", False, "scheduled", 4),
        ("deleted", "u1", "inbox", True, "scheduled", 5),
        ("failed", "u2", "in_progress", False, "failed", 1),
    ]
    for name, user, status, deleted, rstatus, hours in rows:
        task, reminder = uuid.uuid4(), uuid.uuid4()
        ids[name] = reminder
        conn.execute(
            text(
                "INSERT INTO tasks (id, user_id, title, status, revision, deleted_at)"
                " VALUES (:t, :u, 'T', :s, 1, CASE WHEN :d THEN now() END)"
            ),
            {"t": task, "u": ids[user], "s": status, "d": deleted},
        )
        conn.execute(
            text(
                "INSERT INTO reminders (id, user_id, entity_type, entity_id, remind_at, status)"
                " VALUES (:r, :u, 'task', :t, now() + make_interval(hours => :h), :s)"
            ),
            {"r": reminder, "u": ids[user], "t": task, "h": hours, "s": rstatus},
        )
    return ids


def test_the_migration_adds_columns_and_backfills_the_feed(db) -> None:
    downgrade(PREVIOUS)
    with db.begin() as conn:
        assert "snoozed_until" not in _columns(conn, "reminders")
        assert "home_time_zone" not in _columns(conn, "users")
        ids = _seed(conn)
    upgrade("head")
    with db.begin() as conn:
        assert {"state", "revision", "snoozed_until", "acknowledged_at"} <= _columns(
            conn, "reminders"
        )
        assert "home_time_zone" in _columns(conn, "users")
        state = dict(conn.execute(text("SELECT id, state FROM reminders")).all())
        assert state[ids["pending"]] == "armed"
        assert state[ids["sent"]] == "armed"  # the server's `sent` is not a device state
        assert state[ids["cancelled"]] == "cancelled"
        assert state[ids["done"]] == "cancelled"
        assert state[ids["deleted"]] == "cancelled"
        assert state[ids["failed"]] == "armed"
        assert set(conn.execute(text("SELECT revision FROM reminders")).scalars()) == {1}
        # one feed entry per reminder, upserts, at cursors above the user's old counter, in
        # remind_at order, with the counter moved to the last one
        feed = conn.execute(
            text(
                "SELECT user_id, entity_id, operation, seq FROM change_log"
                " WHERE entity_type = 'reminder' ORDER BY user_id, seq"
            )
        ).all()
        assert len(feed) == 6
        assert {op for _u, _e, op, _s in feed} == {"upsert"}
        mine = [(e, s) for u, e, _o, s in feed if u == ids["u1"]]
        assert [e for e, _s in mine] == [
            str(ids[n]) for n in ("pending", "sent", "cancelled", "done", "deleted")
        ]
        assert [s for _e, s in mine] == [8, 9, 10, 11, 12]
        assert (
            conn.execute(
                text("SELECT change_seq FROM users WHERE id = :u"), {"u": ids["u1"]}
            ).scalar_one()
            == 12
        )
        assert (
            conn.execute(
                text("SELECT change_seq FROM users WHERE id = :u"), {"u": ids["u2"]}
            ).scalar_one()
            == 1
        )
    # existing server state is untouched
    with db.begin() as conn:
        assert (
            conn.execute(
                text("SELECT status FROM reminders WHERE id = :r"), {"r": ids["sent"]}
            ).scalar_one()
            == "sent"
        )


def test_the_downgrade_removes_the_feed_rows_and_columns_and_a_second_round_trip_works(db) -> None:
    downgrade(PREVIOUS)
    with db.begin() as conn:
        ids = _seed(conn)
    upgrade("head")
    downgrade(PREVIOUS)
    with db.begin() as conn:
        assert "state" not in _columns(conn, "reminders")
        assert "home_time_zone" not in _columns(conn, "users")
        assert (
            conn.execute(
                text("SELECT count(*) FROM change_log WHERE entity_type = 'reminder'")
            ).scalar_one()
            == 0
        )
        assert conn.execute(text("SELECT count(*) FROM reminders")).scalar_one() == 6
        assert (
            conn.execute(
                text("SELECT change_seq FROM users WHERE id = :u"), {"u": ids["u1"]}
            ).scalar_one()
            == 12
        )  # a cursor once handed out stays used
    upgrade("head")
    with db.begin() as conn:
        # the second backfill continues above the counter; nothing collides
        assert (
            conn.execute(
                text("SELECT max(seq) FROM change_log WHERE user_id = :u"), {"u": ids["u1"]}
            ).scalar_one()
            == 17
        )


def test_a_clean_database_upgrades_and_enforces_the_constraints(db) -> None:
    downgrade("base")
    upgrade("head")
    user = uuid.uuid4()
    with db.begin() as conn:
        conn.execute(
            text(
                "INSERT INTO users (id, email, display_name, password_hash)"
                " VALUES (:u, 'b@x', 'B', 'x')"
            ),
            {"u": user},
        )
    for bad in ("state = 'sent'", "revision = 0"):
        with pytest.raises(IntegrityError), db.begin() as conn:
            conn.execute(
                text(
                    "INSERT INTO reminders (id, user_id, entity_type, entity_id, remind_at)"
                    " VALUES (:r, :u, 'task', :t, now())"
                ),
                {"r": uuid.uuid4(), "u": user, "t": uuid.uuid4()},
            )
            conn.execute(text(f"UPDATE reminders SET {bad}"))
