"""Compose must forward every setting the application reads (P0-1 smoke finding).

The api and worker share one ``x-atlas-env`` block. A new ``Settings`` field that is neither
forwarded nor listed in ``NOT_FORWARDED`` (with the reason) fails here, so an operator's ``.env``
value cannot be silently ignored inside the containers.
"""

from __future__ import annotations

from pathlib import Path

import yaml

from atlas.config import Settings

COMPOSE = Path(__file__).resolve().parents[4] / "deploy" / "docker-compose.yml"

NOT_FORWARDED = {
    "backup_stale_seconds": "internal lock timeout",
    "calendar_sync_stale_seconds": "internal lock timeout",
    "change_purge_stale_seconds": "internal lock timeout",
    "reminder_scan_stale_seconds": "internal lock timeout",
    "session_cookie_name": "internal constant; the web client reads the default",
    "csrf_cookie_name": "internal constant; the web client reads the default",
    "backup_pg_dump_binary": "the image ships pg_dump on PATH",
    "backup_pg_dump_container": "docker exec is not available inside the container",
}


def test_every_setting_is_forwarded_to_api_and_worker() -> None:
    compose = yaml.safe_load(COMPOSE.read_text())
    shared = set(compose["x-atlas-env"])
    for service in ("api", "worker"):
        env = compose["services"][service]["environment"]
        assert set(env) == shared, f"{service} must use the shared x-atlas-env block"
    missing = {
        name.upper()
        for name in Settings.model_fields
        if name not in NOT_FORWARDED and name.upper() not in shared
    }
    assert not missing, f"not forwarded by deploy/docker-compose.yml: {sorted(missing)}"


def test_database_url_cannot_disagree_with_the_database_password() -> None:
    compose = yaml.safe_load(COMPOSE.read_text())
    url = compose["x-atlas-env"]["DATABASE_URL"]
    assert "${POSTGRES_PASSWORD" in url and "${DATABASE_URL" not in url


def test_web_publishes_on_loopback_by_default() -> None:
    compose = yaml.safe_load(COMPOSE.read_text())
    assert compose["services"]["web"]["ports"] == ["${WEB_BIND:-127.0.0.1}:${WEB_PORT:-8080}:80"]
