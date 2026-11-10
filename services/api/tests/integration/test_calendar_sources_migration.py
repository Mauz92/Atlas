"""The calendar sources / OAuth state / event detail migration (M5, ADR-0071) on a real PostgreSQL.

Synchronous (Alembic's env.py starts its own event loop); leaves the schema at ``head``. Covers the
upgrade from the previous revision on an installation that already has a credential, projected
events and a cursor (nothing is lost, the new columns start empty), the constraints, and a downgrade
that keeps the previous data and removes only the new objects.
"""

from __future__ import annotations

import os
import uuid

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.exc import IntegrityError

from atlas.migrations import downgrade, upgrade

PREVIOUS = "e5b8f2a4c1d9"


@pytest.fixture
def db():
    upgrade("head")
    engine = create_engine(os.environ["DATABASE_URL"])
    yield engine
    upgrade("head")
    with engine.begin() as conn:
        conn.execute(text("TRUNCATE users CASCADE"))
    engine.dispose()


def _table(conn, name: str) -> bool:
    return bool(conn.execute(text(f"SELECT to_regclass('public.{name}') IS NOT NULL")).scalar())


def _columns(conn, table: str) -> set[str]:
    rows = conn.execute(
        text("SELECT column_name FROM information_schema.columns WHERE table_name = :t"),
        {"t": table},
    )
    return {r[0] for r in rows}


def _populate(conn) -> uuid.UUID:
    user = uuid.uuid4()
    conn.execute(text("TRUNCATE users CASCADE"))
    conn.execute(
        text(
            "INSERT INTO users (id, email, display_name, password_hash, change_seq) VALUES (:u, 'm@x', 'M', 'pw', 1)"
        ),
        {"u": user},
    )
    conn.execute(
        text(
            "INSERT INTO provider_credentials (id, user_id, provider, key_id, ciphertext, scopes)"
            " VALUES (:i, :u, 'google', 'v1', :c, ARRAY['calendar.readonly'])"
        ),
        {"i": uuid.uuid4(), "u": user, "c": b"sealed"},
    )
    conn.execute(
        text(
            "INSERT INTO external_events (id, user_id, provider, external_event_id, calendar_id, summary,"
            " start_at, end_at, time_zone, is_all_day, status, source_updated_at, last_synced_at)"
            " VALUES (:i, :u, 'google', 'e1', 'cal', 'Dentist', now(), now() + interval '1 hour',"
            " 'Europe/Berlin', false, 'confirmed', now(), now())"
        ),
        {"i": uuid.uuid4(), "u": user},
    )
    return user


def test_upgrade_on_a_representative_installation_keeps_data_and_adds_empty_columns(db) -> None:
    downgrade(PREVIOUS)
    with db.begin() as conn:
        assert not _table(conn, "calendar_sources") and not _table(conn, "oauth_states")
        user = _populate(conn)
    upgrade("head")
    with db.begin() as conn:
        assert _table(conn, "calendar_sources") and _table(conn, "oauth_states")
        assert {"location", "description", "web_link", "series_id"} <= _columns(
            conn, "external_events"
        )
        row = conn.execute(text("SELECT summary, location, series_id FROM external_events")).one()
        assert tuple(row) == ("Dentist", None, None)
        assert (
            conn.execute(text("SELECT needs_reauth_at FROM provider_credentials")).scalar() is None
        )
        conn.execute(
            text(
                "INSERT INTO calendar_sources (id, user_id, provider, external_id, name, time_zone) VALUES (:i, :u, 'ics', 'f1', 'Feed', 'UTC')"
            ),
            {"i": uuid.uuid4(), "u": user},
        )
        assert conn.execute(text("SELECT selected, is_read_only FROM calendar_sources")).one() == (
            True,
            False,
        )


def test_constraints_and_cascades(db) -> None:
    with db.begin() as conn:
        user = _populate(conn)
        args = {"u": user, "s": "a" * 64}
        conn.execute(
            text(
                "INSERT INTO oauth_states (id, user_id, provider, state_hash, session_hash, verifier_ciphertext,"
                " key_id, redirect_uri, expires_at) VALUES (:i, :u, 'google', :s, :s, :c, 'v1', 'https://x/cb', now())"
            ),
            {**args, "i": uuid.uuid4(), "c": b"x"},
        )
    with pytest.raises(IntegrityError), db.begin() as conn:  # state_hash is unique
        conn.execute(
            text(
                "INSERT INTO oauth_states (id, user_id, provider, state_hash, session_hash, verifier_ciphertext,"
                " key_id, redirect_uri, expires_at) VALUES (:i, :u, 'google', :s, :s, :c, 'v1', 'https://x/cb', now())"
            ),
            {**args, "i": uuid.uuid4(), "c": b"x"},
        )
    with db.begin() as conn:
        conn.execute(
            text(
                "INSERT INTO calendar_sources (id, user_id, provider, external_id, name, time_zone) VALUES (:i, :u, 'google', 'c1', 'C', 'UTC')"
            ),
            {"i": uuid.uuid4(), "u": user},
        )
    with (
        pytest.raises(IntegrityError),
        db.begin() as conn,
    ):  # one row per (user, provider, calendar)
        conn.execute(
            text(
                "INSERT INTO calendar_sources (id, user_id, provider, external_id, name, time_zone) VALUES (:i, :u, 'google', 'c1', 'C', 'UTC')"
            ),
            {"i": uuid.uuid4(), "u": user},
        )
    with db.begin() as conn:
        conn.execute(text("DELETE FROM users WHERE id = :u"), {"u": user})
        assert conn.execute(text("SELECT count(*) FROM calendar_sources")).scalar() == 0
        assert conn.execute(text("SELECT count(*) FROM oauth_states")).scalar() == 0


def test_downgrade_removes_only_the_new_objects_and_is_repeatable(db) -> None:
    with db.begin() as conn:
        _populate(conn)
    downgrade(PREVIOUS)
    with db.begin() as conn:
        assert not _table(conn, "calendar_sources") and not _table(conn, "oauth_states")
        assert not ({"location", "series_id"} & _columns(conn, "external_events"))
        assert "needs_reauth_at" not in _columns(conn, "provider_credentials")
        assert conn.execute(text("SELECT summary FROM external_events")).scalar() == "Dentist"
        assert conn.execute(text("SELECT count(*) FROM provider_credentials")).scalar() == 1
    upgrade("head")
    downgrade(PREVIOUS)
    upgrade("head")
